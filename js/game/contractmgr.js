/**
 * FG.ContractMgr —— 供货合同管理器（接单 / 分批交付 / 独立记账 / 逾期 / 取消 / 存档）
 *
 * 与既有系统的关系：
 *  - 交付站（deliverDock）是一种火车站（列车可停靠、货位与箱子同构），但它的货位
 *    不进入施工统一建材池（MaterialPool）—— 列车卸入交付站的货物即「已被合同占用」，
 *    合同货物在玩家用列车从共用料源（普通站/箱子/产线）组织运输时与生产、施工争料，
 *    一旦运抵交付站则独立记账，不会被施工备料抢走。
 *  - 每 tick（排在铁路卸货之后）从各进行中合同所绑交付站货位划扣其缺口货物，
 *    先计入「未交付预留 reserve」（凑批暂存），凑满一个批次后转入「已交付 delivered」
 *    独立账本；全部批次交付完成即发放科研物资奖励。
 *  - 取消 / 逾期：把未满一批的 reserve 返还交付站货位（放不下落到该格地面堆），
 *    已交付批次（delivered）不返还、不奖励（违约金语义）。
 *  - 存档：看板报价、进行中合同（含 delivered/reserve/期限/已发奖标记）、刷新时刻全部
 *    序列化；完成即原子出列并已发奖，读档不会重复扣货或重复领奖（status/rewarded 双保险）。
 */
FG.ContractMgr = class ContractMgr {
  constructor(game) {
    this.game = game;
    this.offers = [];        // 看板可接报价 [{oid,item,qty,batch,reward,durationSec}]
    this.active = [];        // 进行中合同（status='active'）
    this.history = [];       // 最近结算的合同（done/overdue/cancel），仅 UI 展示，限量保留
    this.seq = 1;
    this.refreshAt = 0;      // 下次看板自动刷新的仿真秒
    this._lastDockPos = {};  // stationId -> {x,y}，交付站被拆时把未满批预留补落到该格
  }

  reset() {
    this.offers = [];
    this.active = [];
    this.history = [];
    this.seq = 1;
    this.refreshAt = 0;      // 下次看板自动刷新的仿真秒
    this._lastDockPos = {};  // stationId -> {x,y}，交付站被拆时把未满批预留补落到该格
  }

  /** 交付站列表（合同的交付目的地），顺带记录各站坐标供拆除时落料 */
  docks() {
    const list = this.game.railway.stationList().filter(b => b.def.contractDock);
    for (const b of list) this._lastDockPos[b.stationId] = { x: b.x, y: b.y };
    return list;
  }

  dockById(stationId) {
    const b = this.game.railway.stationById(stationId);
    if (b && b.def.contractDock) {
      this._lastDockPos[b.stationId] = { x: b.x, y: b.y };
      return b;
    }
    return null;
  }

  // ================= 看板 =================
  /** 保证看板有 CONTRACT_BOARD_SIZE 条报价（未解锁铁路时为空） */
  ensureBoard(nowSec, force) {
    if (!this.game.research.isDone('railTransport')) {
      if (this.offers.length) this.offers = [];
      return;
    }
    if (force) {
      this.offers = [];
      this.refreshAt = 0;
    }
    // 仅在到刷新时刻或报价不足时补生成；不清空已挂出（玩家可能正在挑选）/手动注入的报价
    if (!force && this.refreshAt > nowSec && this.offers.length >= FG.Config.CONTRACT_BOARD_SIZE) return;
    this.fillBoard(nowSec);
  }

  /** 补足看板到 CONTRACT_BOARD_SIZE 条（保持已有报价不变），并推进下次刷新时刻 */
  fillBoard(nowSec) {
    // 以「已完成科技数 + 刷新周期」为种子，补入新条目用递增序号种子，避免与在榜报价重复
    const base = (this.game.research.completed.size * 7919 + 131)
      ^ Math.floor(nowSec / Math.max(1, FG.Config.CONTRACT_REFRESH_SEC));
    let guard = 0;
    while (this.offers.length < FG.Config.CONTRACT_BOARD_SIZE && guard++ < 50) {
      const rng = FG.Utils.mulberry32((base + this.seq * 2654435761) >>> 0);
      const board = FG.Contracts.generateBoard(this.game, FG.Config.CONTRACT_BOARD_SIZE, rng);
      for (const t of board) {
        if (this.offers.length >= FG.Config.CONTRACT_BOARD_SIZE) break;
        // 同货物在榜至多 2 条
        const same = this.offers.filter(o => o.item === t.item).length;
        if (same >= 2) continue;
        this.offers.push(Object.assign({ oid: 'O' + (this.seq++) }, t));
      }
    }
    this.refreshAt = Math.floor(nowSec / FG.Config.CONTRACT_REFRESH_SEC + 1)
      * FG.Config.CONTRACT_REFRESH_SEC;
  }

  /** 手动刷新（换一批报价） */
  refreshBoard() {
    this.ensureBoard(this.game.playTime, true);
    FG.Events.emit('contract:change');
  }

  offerById(oid) { return this.offers.find(o => o.oid === oid) || null; }

  /**
   * 接单：报价 + 指定交付站 → 生成进行中合同。
   * 期限以当前仿真秒为起点的绝对截止时刻，读档/暂停语义不受 tick 计数影响。
   */
  accept(oid, stationId) {
    this.ensureBoard(this.game.playTime, false);
    const o = this.offerById(oid);
    const dock = this.dockById(stationId);
    if (!o || !dock) return null;
    if (this.active.length >= FG.Config.CONTRACT_MAX_ACTIVE) {
      this.game.logMsg('⚠ 进行中的合同已达上限（' + FG.Config.CONTRACT_MAX_ACTIVE + '），先完成或取消一份', 'error');
      return null;
    }
    const c = {
      id: 'C' + (this.seq++),
      status: 'active',           // active | done | overdue | canceled（后三者出 active 进 history）
      dockStationId: dock.stationId,
      dockName: dock.stationName,
      item: o.item,
      qty: o.qty,
      batch: o.batch,
      delivered: 0,               // 已凑批确认交付（独立账本，不可返还）
      reserve: 0,                 // 已从站货位划扣但未满一批的预留（取消/逾期返还）
      reward: { item: o.reward.item, count: o.reward.count },
      rewarded: false,
      acceptAt: this.game.playTime,
      deadline: this.game.playTime + o.durationSec,
    };
    this.active.push(c);
    this.offers = this.offers.filter(x => x.oid !== oid);
    this.ensureBoard(this.game.playTime, false);
    this.game.logMsg('📝 已接供货合同 ' + c.id + '：向「' + (dock.stationName || '交付站')
      + '」分 ' + (o.qty / o.batch) + ' 批供应 ' + FG.Items.byId(o.item).name
      + ' ×' + o.qty + '，完成可得 ' + FG.Items.byId(o.reward.item).name + '×' + o.reward.count, 'unlock');
    FG.Events.emit('contract:change');
    return c;
  }

  byId(id) {
    return this.active.find(c => c.id === id)
      || this.history.find(c => c.id === id) || null;
  }

  contractAtDock(stationId) {
    return this.active.filter(c => c.dockStationId === stationId);
  }

  // ================= 主循环 =================
  tick() {
    const now = this.game.playTime;
    this.ensureBoard(now, false);
    if (!this.active.length) return;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const c = this.active[i];
      if (c.status !== 'active') { this.active.splice(i, 1); continue; }
      // 逾期先于交付判定（截止时刻到，未交完即违约）
      if (now >= c.deadline) { this.settleOverdue(c, i); continue; }
      const dock = this.dockById(c.dockStationId);
      if (!dock) continue;   // 交付站被拆/暂缺：无法划扣，等玩家重建（期间照常计逾期）
      this.intake(c, dock);
      if (c.delivered >= c.qty) this.settleDone(c, i, dock);
    }
  }

  /** 从交付站货位划扣合同货物到 reserve，凑满批次即确认交付到 delivered（独立记账） */
  intake(c, dock) {
    const remain = c.qty - c.delivered - c.reserve;
    if (remain <= 0) return;
    const budget = Math.min(FG.Config.CONTRACT_INTAKE, remain);
    let got = 0;
    for (const slot of dock.chest) {
      if (got >= budget) break;
      if (slot.count <= 0 || slot.type !== c.item) continue;
      const take = Math.min(budget - got, slot.count);
      slot.count -= take;
      got += take;
      if (slot.count === 0) slot.type = null;
    }
    if (got <= 0) return;
    c.reserve += got;
    // 凑批确认：每凑满一个 batch 独立记一笔已交付
    while (c.reserve >= c.batch && c.delivered < c.qty) {
      c.reserve -= c.batch;
      c.delivered += c.batch;
      this.game.stats.recordConsume(c.item, c.batch); // 合同交付作为「消耗」出口记账
      if (c.delivered >= c.qty) break;
    }
  }

  /** 完成：发科研物资到交付站货位（放不下落到该格地面堆），原子出列 */
  settleDone(c, i, dock) {
    c.status = 'done';
    c.delivered = c.qty;
    c.reserve = 0;
    if (!c.rewarded) {
      c.rewarded = true;
      let left = c.reward.count;
      if (dock) left = this.game.tryChestAdd(dock, c.reward.item, left);
      if (dock && left > 0) this.game.map.pileAdd(dock.x, dock.y, c.reward.item, left);
      this.game.logMsg('✅ 供货合同 ' + c.id + ' 完成：' + FG.Items.byId(c.item).name + '×' + c.qty
        + ' 已交付，发放科研物资 ' + FG.Items.byId(c.reward.item).name + '×' + c.reward.count
        + (dock ? '（已送达「' + (dock.stationName || '交付站') + '」货位）' : ''), 'unlock');
      FG.Events.emit('contract:complete', c);
    }
    this.active.splice(i, 1);
    this.pushHistory(c);
    FG.Events.emit('contract:change');
  }

  /** 逾期：返还未满批的 reserve，已交付批次不返还不奖励 */
  settleOverdue(c, i) {
    c.status = 'overdue';
    this.refundReserve(c);
    this.active.splice(i, 1);
    this.pushHistory(c);
    this.game.logMsg('⏰ 供货合同 ' + c.id + ' 已逾期：已交付 ' + c.delivered + '/' + c.qty
      + '（未满批预留 ' + c.reserve + ' 件已返还交付站），合同终止且无奖励', 'error');
    FG.Events.emit('contract:change');
  }

  /** 玩家主动取消：返还未满批 reserve，已交付批次保留不返还 */
  cancel(id) {
    const i = this.active.findIndex(c => c.id === id);
    if (i < 0) return false;
    const c = this.active[i];
    c.status = 'canceled';
    this.refundReserve(c);
    this.active.splice(i, 1);
    this.pushHistory(c);
    this.game.logMsg('已取消供货合同 ' + c.id + '：已交付 ' + c.delivered + '/' + c.qty
      + '，未满批预留已返还交付站货位', 'info');
    FG.Events.emit('contract:change');
    return true;
  }

  /**
   * 交付站被拆除：绑定的进行中合同无法继续交付，统一取消。
   * 拆除时站货位物料已落到该格地面堆，但 reserve 是此前已从货位划扣、移出物流的部分，
   * 须把未满批预留补落到该格，避免「已记账预留但货物凭空消失」。
   */
  handleDockRemoved(stationId) {
    const list = this.active.filter(c => c.dockStationId === stationId);
    for (const c of list) {
      c.status = 'canceled';
      if (c.reserve > 0) {
        const b = this.game.map;
        // stationId → 拆除前坐标已不可从 railway 取得（图将重建）；用最近一次绑定的站名兜底
        const pos = this._lastDockPos && this._lastDockPos[stationId];
        if (pos) b.pileAdd(pos.x, pos.y, c.item, c.reserve);
        c.reserve = 0;
      }
      const i = this.active.indexOf(c);
      if (i >= 0) this.active.splice(i, 1);
      this.pushHistory(c);
      this.game.logMsg('🚧 交付站已拆除：供货合同 ' + c.id + ' 自动取消（已交付 ' + c.delivered
        + '/' + c.qty + '，未满批预留随拆除落到地面堆）', 'error');
    }
    if (list.length) FG.Events.emit('contract:change');
  }

  /** 把未满一批的预留货物返还交付站货位，余下落到交付站所在格地面堆 */
  refundReserve(c) {
    if (c.reserve <= 0) { c.reserve = 0; return; }
    const dock = this.dockById(c.dockStationId);
    let left = c.reserve;
    if (dock) left = this.game.tryChestAdd(dock, c.item, left);
    if (dock && left > 0) this.game.map.pileAdd(dock.x, dock.y, c.item, left);
    else if (!dock) {
      // 交付站已被拆：预留货物在最近的同站号位置不可得时直接清零（货物在拆除时已按掉落处理过）
      // 正常流程拆除车站会先提示有合同；此处兜底不复制货物。
    }
    c.reserve = 0;
  }

  pushHistory(c) {
    this.history.unshift(c);
    if (this.history.length > 20) this.history.length = 20;
  }

  // ================= UI 数据 =================
  /** 剩余秒数（≥0） */
  remainSec(c) { return Math.max(0, Math.ceil(c.deadline - this.game.playTime)); }

  // ================= 存档 =================
  serialize() {
    return {
      seq: this.seq,
      refreshAt: this.refreshAt,
      offers: this.offers.map(o => ({
        oid: o.oid, item: o.item, qty: o.qty, batch: o.batch,
        reward: { item: o.reward.item, count: o.reward.count },
        durationSec: o.durationSec,
      })),
      active: this.active.map(c => ({
        id: c.id, status: c.status || 'active',
        dockStationId: c.dockStationId, dockName: c.dockName || null,
        item: c.item, qty: c.qty, batch: c.batch,
        delivered: c.delivered || 0, reserve: c.reserve || 0,
        reward: { item: c.reward.item, count: c.reward.count },
        rewarded: !!c.rewarded,
        acceptAt: c.acceptAt || 0, deadline: c.deadline || 0,
      })),
      history: this.history.slice(0, 10).map(c => ({
        id: c.id, status: c.status, item: c.item, qty: c.qty,
        delivered: c.delivered || 0, reward: c.reward, rewarded: !!c.rewarded,
      })),
    };
  }

  deserialize(data) {
    this.reset();
    if (!data) return;
    this.docks(); // 建立交付站坐标映射（拆除落料兜底用）
    this.seq = data.seq || 1;
    this.refreshAt = data.refreshAt || 0;
    for (const o of (data.offers || [])) {
      if (!FG.Contracts.knownItem(o.item)) continue;
      if (!o.reward || !FG.Contracts.knownItem(o.reward.item)) continue;
      this.offers.push({
        oid: o.oid || ('O' + (this.seq++)), item: o.item,
        qty: o.qty | 0, batch: o.batch | 0,
        reward: { item: o.reward.item, count: o.reward.count | 0 },
        durationSec: o.durationSec || 0,
      });
    }
    for (const sc of (data.active || [])) {
      if (!FG.Contracts.knownItem(sc.item)) continue;
      if (!sc.reward || !FG.Contracts.knownItem(sc.reward.item)) continue;
      const c = {
        id: sc.id || ('C' + (this.seq++)),
        status: 'active',                 // 只有未结算合同才在 active 中
        dockStationId: sc.dockStationId,
        dockName: sc.dockName || null,
        item: sc.item, qty: sc.qty | 0, batch: sc.batch | 0,
        delivered: sc.delivered | 0, reserve: sc.reserve | 0,
        reward: { item: sc.reward.item, count: sc.reward.count | 0 },
        rewarded: !!sc.rewarded,
        acceptAt: sc.acceptAt || 0, deadline: sc.deadline || 0,
      };
      // 读档即已完成（不应在 active，但兜底）：直接结算，且因 rewarded/已发奖不再重复发
      if (c.delivered >= c.qty) {
        const dock = this.dockById(c.dockStationId);
        const pos = this._lastDockPos[c.dockStationId];
        if (!c.rewarded) {
          let left = c.reward.count;
          if (dock) left = this.game.tryChestAdd(dock, c.reward.item, left);
          if (left > 0 && (dock || pos)) {
            const at = dock || pos;
            this.game.map.pileAdd(at.x, at.y, c.reward.item, left);
          }
          c.rewarded = true;
        }
        c.status = 'done'; c.reserve = 0;
        this.pushHistory(c);
        continue;
      }
      this.active.push(c);
    }
    for (const hc of (data.history || [])) {
      if (!FG.Contracts.knownItem(hc.item)) continue;
      this.history.push({
        id: hc.id, status: hc.status || 'done', item: hc.item, qty: hc.qty | 0,
        delivered: hc.delivered | 0, reward: hc.reward || null, rewarded: !!hc.rewarded,
      });
    }
    // 读档后重算看板（报价随研究进度/刷新周期复现，未解锁则清空）
    this.ensureBoard(this.game.playTime, false);
  }
};
