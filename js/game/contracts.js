/**
 * FG.Contracts —— 供货合同管理器
 *
 * 玩法：玩家在「交付站」（与火车站同构的轨节点）承接对外供货合同，
 * 用自己的列车把工厂产品分批运到交付站卸货。
 *
 * 料权模型（与施工预留同一套语义：预留即移出物流）：
 *  - 合同需求的货物在运到交付站之前仍是全图自由货物，生产、施工、其他运输
 *    都可以争用 —— 即「合同货物与生产、施工统一争料」；
 *  - 列车把合同货物卸进交付站时按缺口锁付：锁付量记入合同独立台账 lock
 *    （=已交付量），实物不进站货位、不入任何物流预算池（施工 MaterialPool
 *    与按需调度都盘点不到），生产/施工不可再动用 —— 即「独立记账」；
 *  - 多卸/错卸的货物照常进入站货位（自由货物），可被机械臂拉回产线继续争料；
 *  - 分批供货：锁付量逐次累加，达量即完成合同，锁付货物被客户提走（消失），
 *    科研物资（科学包）作为奖励发放到站货位，放不下落到站格地面堆；
 *  - 逾期 / 取消：合同终止，全部锁付货物释放回站货位（放不下落地），恢复自由；
 *  - 拆除交付站：先释放其合同锁付货物（落到站格地面堆，随拆除物料一并保留）。
 *
 * 幂等（读档后避免重复扣货或领奖）：
 *  - 锁付/发奖只发生在「列车卸货」这一物理事件中，完成判定由锁付量驱动；
 *    合同完成即从 active 出列（仅留 history 记录），读档不会重放卸货，
 *    因此既不会重复扣货、也不会重复发奖；
 *  - 逾期判定基于截止时刻 dueAt（仿真秒），完成/取消都把合同移出 active；
 *  - 旧存档无 contracts 字段 → 空合同，行为不变。
 */
FG.Contracts = class Contracts {
  constructor(game) {
    this.game = game;
    this.active = [];          // 进行中的合同（见 acceptOffer 的结构）
    this.offers = new Map();   // stationKey -> { at, list:[offer] }
    this.history = [];         // 最近完成的合同（UI 用，随档保存最近若干条）
    this.seq = 1;
  }

  reset() {
    this.active = [];
    this.offers = new Map();
    this.history = [];
    this.seq = 1;
  }

  stationKey(st) { return FG.Utils.key(st.x, st.y); }

  /** 该交付站当前进行中的合同（每站至多 1 单） */
  contractAt(st) {
    if (!st || !st.def || !st.def.delivery) return null;
    const k = this.stationKey(st);
    return this.active.find(c => c.stationKey === k) || null;
  }

  // ================= 合同邀约 =================
  /**
   * 取交付站当前邀约列表：过期（每 CONTRACT_REFRESH_TICKS 由首个在途 tick 刷新）
   * 或不存在时即时重新生成。已有进行中合同的站点返回空列表（一次只做一单）。
   */
  getOffers(st) {
    if (!st || !st.def.delivery) return [];
    if (this.contractAt(st)) return [];
    const k = this.stationKey(st);
    let rec = this.offers.get(k);
    if (!rec) {
      rec = { at: this.game.tickCount, list: this.rollOffers() };
      this.offers.set(k, rec);
    }
    return rec.list;
  }

  /** 手动刷新邀约（放弃当前列表，立即重摇） */
  refreshOffers(st) {
    if (!st || !st.def.delivery) return;
    this.offers.set(this.stationKey(st), { at: this.game.tickCount, list: this.rollOffers() });
    FG.Events.emit('contracts:change');
  }

  /** 随机生成一批合同邀约：货物取自当前科技可达的固体物品（含矿料/中间品/成品） */
  rollOffers() {
    const g = this.game;
    const pool = OFFER_ITEMS.filter(id => {
      const def = FG.Items.byId(id);
      if (!def || def.fluid || id.indexOf('science') === 0) return false;
      // 已解锁对应配方的物品优先（矿料始终可采，无条件可选）
      if (RAW_ITEMS.has(id)) return true;
      const rid = ITEM_RECIPE[id];
      return !rid || g.research.isRecipeUnlocked(rid);
    });
    const list = [];
    const used = new Set();
    let guard = 0;
    while (list.length < FG.Config.CONTRACT_OFFERS && guard++ < 50) {
      const id = pool[(Math.random() * pool.length) | 0];
      if (!id || used.has(id)) continue;
      used.add(id);
      const tier = ITEM_TIER[id] || 1;
      const qty = CONTRACT_QTY[tier - 1]
        ? CONTRACT_QTY[tier - 1][0] + ((Math.random() * (CONTRACT_QTY[tier - 1][1] - CONTRACT_QTY[tier - 1][0])) | 0)
        : FG.Config.CONTRACT_MIN_QTY;
      const duration = Math.min(FG.Config.CONTRACT_MAX_DEADLINE,
        FG.Config.CONTRACT_MIN_DEADLINE + Math.round(qty * (0.8 + Math.random() * 1.6)));
      const reward = {};
      const packs = REWARD_PACKS[tier - 1] || ['science1'];
      const base = Math.max(2, Math.round(qty / 10));
      packs.forEach((p, i) => { reward[p] = base * (i === 0 ? tier : Math.max(1, tier - 1)); });
      list.push({ item: id, qty, duration, reward, tier });
    }
    return list;
  }

  /** 承接交付站邀约（index 为 getOffers 列表下标），返回是否成功 */
  acceptOffer(st, index) {
    if (!st || !st.def.delivery) return false;
    if (this.contractAt(st)) return false;
    const offers = this.getOffers(st);
    const offer = offers[index];
    if (!offer) return false;
    const c = {
      id: 'C' + (this.seq++),
      stationId: st.stationId,
      stationKey: this.stationKey(st),
      stationName: st.stationName || ('站点 ' + (st.stationId || '')),
      item: offer.item,
      qty: offer.qty,
      delivered: 0,                 // 已锁付（已交付）数量 —— 独立台账
      reward: Object.assign({}, offer.reward),
      startAt: this.game.playTime,
      dueAt: this.game.playTime + offer.duration,
      status: 'active',
    };
    this.active.push(c);
    this.offers.delete(this.stationKey(st));
    this.game.logMsg('📝 已承接供货合同「' + c.id + '」：经铁路向「' + c.stationName
      + '」分批交付 ' + FG.Items.byId(c.item).name + '×' + c.qty
      + '，期限 ' + offer.duration + ' 秒，完成发放科研物资', 'info');
    FG.Events.emit('contracts:change');
    return true;
  }

  /** 取消合同：释放全部锁付货物到站货位/地面，无奖励 */
  cancel(cid) {
    const i = this.active.findIndex(c => c.id === cid);
    if (i < 0) return false;
    const c = this.active[i];
    const st = this.game.railway.stationById(c.stationId) || this.stationByKey(c.stationKey);
    this.releaseLocked(c, st);
    this.active.splice(i, 1);
    this.game.logMsg('已取消供货合同「' + c.id + '」：' + c.delivered
      + ' 件已交付预留货物已释放回「' + (st ? st.stationName : c.stationName) + '」物流', 'info');
    FG.Events.emit('contracts:change');
    return true;
  }

  // ================= 列车卸货锁付（由铁路模块在卸入站货位后调用） =================
  /**
   * 列车向站货位卸货后回调：若该站是交付站且有进行中合同，把刚卸入站货位的
   * 合同货物按缺口锁付（从站货位移出、记入合同台账）。返回本回调处理的件数
   * （仅用于日志/测试；货物物理上从未进入过物流预算池）。
   *
   * 实现说明：列车 unloadToStation 先把货写进 station.chest，本函数随后把
   * 其中属于本合同缺口的部分搬到 lockbox —— 同一 tick 内完成，施工/调度
   * 每 tick 的盘点发生在铁路 tick 之前（见 game.tickOnce 顺序），锁付货物
   * 不会被任何预算池看到。
   */
  onTrainUnloaded(station, itemCandidates) {
    const c = this.contractAt(station);
    if (!c || !station.chest) return 0;
    let locked = 0;
    const need = c.qty - c.delivered;
    for (let i = 0; i < station.chest.length && need - locked > 0; i++) {
      const s = station.chest[i];
      if (s.count <= 0 || s.type !== c.item) continue;
      const take = Math.min(s.count, need - locked);
      s.count -= take;
      if (s.count <= 0) s.type = null;
      locked += take;
    }
    if (locked <= 0) return 0;
    c.delivered += locked;
    FG.Events.emit('contracts:change');
    if (c.delivered >= c.qty) this.complete(c, station);
    return locked;
  }

  /** 合同完成：锁付货物被客户提走（台账清零），科研物资奖励发放到站货位 */
  complete(c, station) {
    if (c.status !== 'active') return;
    c.status = 'done';
    c.finishedAt = this.game.playTime;
    const idx = this.active.indexOf(c);
    if (idx >= 0) this.active.splice(idx, 1);
    // 发放奖励：优先站货位，放不下落到站格地面堆
    const rewardTxt = [];
    for (const pack of Object.keys(c.reward)) {
      let left = c.reward[pack];
      if (station) {
        for (let i = 0; i < station.chest.length && left > 0; i++) {
          const slot = station.chest[i];
          if (slot.type === pack && slot.count < slot.cap) {
            const put = Math.min(left, slot.cap - slot.count);
            slot.count += put; left -= put;
          }
        }
        for (let i = 0; i < station.chest.length && left > 0; i++) {
          const slot = station.chest[i];
          if (slot.count === 0) {
            const put = Math.min(left, slot.cap);
            slot.type = pack; slot.count = put; left -= put;
          }
        }
        if (left > 0) this.game.map.pileAdd(station.x, station.y, pack, left);
      }
      rewardTxt.push(FG.Items.byId(pack).name + '×' + c.reward[pack]);
    }
    this.history.unshift({
      id: c.id, item: c.item, qty: c.qty, stationName: c.stationName,
      reward: Object.assign({}, c.reward), finishedAt: c.finishedAt,
    });
    if (this.history.length > 20) this.history.length = 20;
    this.game.logMsg('🎉 供货合同「' + c.id + '」完成：' + FG.Items.byId(c.item).name + '×' + c.qty
      + ' 已交付「' + (station ? station.stationName : c.stationName) + '」，发放科研物资 '
      + rewardTxt.join('、'), 'unlock');
    FG.Events.emit('contracts:complete', c);
    FG.Events.emit('contracts:change');
  }

  // ================= 逾期 / 拆除释放 =================
  tick() {
    // 邀约列表周期刷新（按 tick 节流，避免每 tick 重摇）
    if (this.game.tickCount % FG.Config.CONTRACT_REFRESH_TICKS === 0) {
      for (const [k, rec] of Array.from(this.offers)) {
        if (this.game.tickCount - rec.at >= FG.Config.CONTRACT_REFRESH_TICKS) {
          this.offers.delete(k);
        }
      }
    }
    if (!this.active.length) return;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const c = this.active[i];
      if (this.game.playTime < c.dueAt) continue;
      const st = this.game.railway.stationById(c.stationId) || this.stationByKey(c.stationKey);
      const delivered = c.delivered;
      this.releaseLocked(c, st);
      this.active.splice(i, 1);
      c.status = 'overdue';
      this.game.logMsg('⏰ 供货合同「' + c.id + '」已逾期：' + delivered
        + ' 件未交付预留货物已释放回「' + (st ? st.stationName : c.stationName) + '」物流，合同终止', 'error');
      FG.Events.emit('contracts:change');
    }
  }

  /** 合同锁付货物释放：按台账量放回站货位，放不下落到站格地面堆（恢复自由货物） */
  releaseLocked(c, station) {
    const n = c.delivered;
    if (n <= 0) { c.delivered = 0; return; }
    if (station) {
      let left = this.game.tryChestAdd(station, c.item, n);
      if (left > 0) this.game.map.pileAdd(station.x, station.y, c.item, left);
    } else {
      const [x, y] = c.stationKey.split(',').map(Number);
      this.game.map.pileAdd(x, y, c.item, n);
    }
    c.delivered = 0;
  }

  /** 交付站被拆除：释放其合同（货物已随拆除落到站格地面堆，锁付量须单独落地） */
  onStationRemoved(station) {
    if (!station || !station.def.delivery) return;
    const k = this.stationKey(station);
    for (let i = this.active.length - 1; i >= 0; i--) {
      const c = this.active[i];
      if (c.stationKey !== k) continue;
      const n = c.delivered;
      if (n > 0) this.game.map.pileAdd(station.x, station.y, c.item, n);
      this.active.splice(i, 1);
      this.game.logMsg('交付站已拆除：供货合同「' + c.id + '」终止，' + n + ' 件锁付货物落到地面堆', 'info');
    }
    this.offers.delete(k);
    FG.Events.emit('contracts:change');
  }

  stationByKey(k) {
    const [x, y] = k.split(',').map(Number);
    const b = this.game.map.buildingAt(x, y);
    return b && b.def.railStation ? b : null;
  }

  /** 剩余期限（仿真秒，向下取整；逾期为 0） */
  remainSec(c) { return Math.max(0, Math.ceil(c.dueAt - this.game.playTime)); }

  // ================= 存档 =================
  serialize() {
    return {
      seq: this.seq,
      active: this.active.map(c => ({
        id: c.id, stationId: c.stationId, stationKey: c.stationKey, stationName: c.stationName,
        item: c.item, qty: c.qty, delivered: c.delivered,
        reward: Object.assign({}, c.reward),
        startAt: c.startAt, dueAt: c.dueAt,
      })),
      offers: Array.from(this.offers.entries()).map(([k, rec]) => ({
        key: k, at: rec.at,
        list: rec.list.map(o => ({
          item: o.item, qty: o.qty, duration: o.duration, tier: o.tier,
          reward: Object.assign({}, o.reward),
        })),
      })),
      history: this.history.map(h => ({
        id: h.id, item: h.item, qty: h.qty, stationName: h.stationName,
        reward: Object.assign({}, h.reward), finishedAt: h.finishedAt,
      })),
    };
  }

  deserialize(data) {
    this.reset();
    if (!data) return;
    this.seq = data.seq || 1;
    for (const sc of (data.active || [])) {
      if (!FG.Items.byId(sc.item)) continue;
      this.active.push({
        id: sc.id || ('C' + (this.seq++)),
        stationId: sc.stationId || null,
        stationKey: sc.stationKey,
        stationName: sc.stationName || '交付站',
        item: sc.item,
        qty: sc.qty | 0,
        delivered: sc.delivered | 0,
        reward: sc.reward && typeof sc.reward === 'object' ? Object.assign({}, sc.reward) : {},
        startAt: sc.startAt || 0,
        dueAt: sc.dueAt || 0,
        status: 'active',
      });
    }
    for (const ro of (data.offers || [])) {
      if (!ro.key) continue;
      this.offers.set(ro.key, {
        at: ro.at || 0,
        list: (ro.list || []).filter(o => FG.Items.byId(o.item)).map(o => ({
          item: o.item, qty: o.qty | 0, duration: o.duration || FG.Config.CONTRACT_MIN_DEADLINE,
          tier: o.tier || 1,
          reward: o.reward && typeof o.reward === 'object' ? Object.assign({}, o.reward) : {},
        })),
      });
    }
    this.history = (data.history || []).filter(h => FG.Items.byId(h.item)).map(h => ({
      id: h.id, item: h.item, qty: h.qty | 0, stationName: h.stationName || '',
      reward: h.reward || {}, finishedAt: h.finishedAt || 0,
    }));
  }
};

// ================= 合同货物分级与奖励 =================
// 需求货物按加工深度分级：原料/初级→1，中间零件→2，高级成品→3
const RAW_ITEMS = new Set(['ironOre', 'copperOre', 'coal', 'stone']);
const ITEM_TIER = {
  ironOre: 1, copperOre: 1, coal: 1, stone: 1,
  ironPlate: 1, copperPlate: 1,
  steelPlate: 2, ironBeam: 2, copperWire: 2, gear: 2, circuit: 2,
  advCircuit: 3, engine: 3, miningDrill: 3, solarPanel: 3,
  rocketPart: 3, rocketFuel: 3, satellite: 3,
};
// 各档需求量区间
const CONTRACT_QTY = [
  [60, FG.Config.CONTRACT_MAX_QTY],               // 原料/初级板材：量大
  [30, 70],                                        // 中间零件
  [FG.Config.CONTRACT_MIN_QTY, 40],                // 高级成品
];
// 各档奖励科学包
const REWARD_PACKS = [
  ['science1'],
  ['science1', 'science2'],
  ['science2', 'science3'],
];
// 邀约候选物品（固体、非科学包）
const OFFER_ITEMS = [
  'ironOre', 'copperOre', 'coal', 'stone',
  'ironPlate', 'copperPlate', 'steelPlate', 'ironBeam',
  'copperWire', 'gear', 'circuit', 'advCircuit', 'engine',
  'miningDrill', 'solarPanel', 'rocketPart', 'rocketFuel',
];
// 物品 → 生产配方（用于按已解锁科技过滤邀约）
const ITEM_RECIPE = (() => {
  const m = {};
  if (typeof FG.Recipes !== 'undefined') {
    for (const r of FG.Recipes.list()) {
      for (const res of r.results) {
        if (!m[res.item]) m[res.item] = r.id;
      }
    }
  }
  return m;
})();
