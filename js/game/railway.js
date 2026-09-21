/**
 * FG.Railway —— 铁路货运系统：轨网、区间占用、列车调度与运输计划
 *
 * 模型：
 *  - 轨格图：轨道(rail)与火车站(station)建筑即图节点，四邻相连；机务段(trainDepot)不进图，
 *    只作为发车点（必须邻接轨格）。轨网增删建筑后标记 dirty，下一 tick 重建（站号自动补发）。
 *  - 区间占用：列车每节占 1 格，occupy 表记录「格 → 列车」。列车只在踏入下一格前申请占用，
 *    申请成功才起步；前方被占则在区间外等待 —— 天然杜绝追尾/对撞穿越。
 *  - 交叉线路争用：每 tick 列车按轮转游标 moverSeq 旋转后的顺序申请，成功跨格者把游标推到
 *    自己之后，任一方向来车都不会被饿死（与传送带合流同一套公平语义）。
 *  - 堵站：站内停靠的列车占着站格，后续列车在站外区间排队（状态「等站」）；装卸完成或
 *    最长停站时间到时离站，后车依次进站。
 *  - 断路：目标站与列车间不存在轨路时列车进入「断路」状态原地等待；轨道补齐（图重建）后
 *    下一 tick 自动重新寻路，无需人工干预。计划中的站点被拆除则自动跳过该站。
 *  - 单线对向顶住属布局错误：两车状态「堵死」（红色），需玩家拆轨/改线疏解。
 *  - 装卸：火车站货位与箱子同构（4 槽），机械臂/传送带可直接与产线转运；列车按各停靠站的
 *    计划动作（装/卸 × 物品 × 数量）在停站期间逐 tick 搬运，到量/清空/最长停站时间到即走。
 *  - 存档：列车位置、朝向、载货、运输计划（含停站序号/停靠计时/动作余量）与调度轮转游标
 *    全部序列化；占用表读档后由列车位置重建。
 */
FG.Railway = class Railway {
  constructor(game) {
    this.game = game;
    this.trains = [];
    this.occupy = new Map();    // 'x,y' -> trainId
    this.nodes = new Set();     // 轨格 key（轨道 + 火车站）
    this.stationMap = new Map();// stationId -> 站建筑
    this.graphDirty = true;
    this.moverSeq = 0;          // 交叉争用同级轮转游标
    this.trainSeq = 1;
    this.stationSeq = 1;
  }

  reset() {
    this.trains = [];
    this.occupy.clear();
    this.nodes.clear();
    this.stationMap.clear();
    this.graphDirty = true;
    this.moverSeq = 0;
    this.trainSeq = 1;
    this.stationSeq = 1;
  }

  markDirty() { this.graphDirty = true; }

  // ================= 轨网 =================
  isRailTile(x, y) {
    const b = this.game.map.buildingAt(x, y);
    return !!b && (b.type === 'rail' || !!b.def.railStation);
  }

  rebuildGraph() {
    this.nodes.clear();
    this.stationMap.clear();
    for (const b of this.game.map.buildings.values()) {
      if (b.type === 'rail' || b.def.railStation) {
        this.nodes.add(FG.Utils.key(b.x, b.y));
        if (b.def.railStation) {
          if (!b.stationId) b.stationId = 'S' + (this.stationSeq++);
          if (!b.stationName) b.stationName = (b.def.contractDock ? '交付站 ' : '站点 ') + b.stationId.slice(1);
          this.stationMap.set(b.stationId, b);
        }
      }
    }
    // 图变更后缓存路径全部作废：经过已拆除轨格的列车下一 tick 重新寻路（断路自愈）
    for (const tr of this.trains) tr.path = null;
    this.graphDirty = false;
  }

  stationById(id) {
    if (this.graphDirty) this.rebuildGraph();
    return this.stationMap.get(id) || null;
  }

  stationList() {
    if (this.graphDirty) this.rebuildGraph();
    return Array.from(this.stationMap.values());
  }

  trainById(id) { return this.trains.find(t => t.id === id) || null; }
  trainAt(x, y) {
    const id = this.occupy.get(FG.Utils.key(x, y));
    return id ? this.trainById(id) : null;
  }

  /** BFS 寻路：返回从起点（不含）到目标格（含）的格坐标数组；不可达返回 null */
  findPath(sx, sy, tx, ty) {
    if (this.graphDirty) this.rebuildGraph();
    const tk = FG.Utils.key(tx, ty);
    if (!this.nodes.has(tk)) return null;
    const sk = FG.Utils.key(sx, sy);
    if (sk === tk) return [];
    const prev = new Map();
    const q = [sk];
    prev.set(sk, null);
    let found = false;
    while (q.length) {
      const cur = q.shift();
      if (cur === tk) { found = true; break; }
      const [cx, cy] = cur.split(',').map(Number);
      for (let d = 0; d < 4; d++) {
        const v = FG.Utils.dirVec(d);
        const nk = FG.Utils.key(cx + v.x, cy + v.y);
        if (!this.nodes.has(nk) || prev.has(nk)) continue;
        prev.set(nk, cur);
        q.push(nk);
      }
    }
    if (!found) return null;
    const path = [];
    let k = tk;
    while (k !== sk) {
      const [x, y] = k.split(',').map(Number);
      path.unshift({ x, y });
      k = prev.get(k);
    }
    return path;
  }

  // ================= 主循环（轮转公平 × 区间占用） =================
  tick() {
    if (this.graphDirty) this.rebuildGraph();
    const n = this.trains.length;
    if (!n) return;
    const start = this.moverSeq % n;
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % n;
      const tr = this.trains[idx];
      if (tr._dead) continue;
      if (tr.tick(this)) this.moverSeq = (idx + 1) % n; // 成功跨格者下轮排在后面
    }
    for (let i = this.trains.length - 1; i >= 0; i--) if (this.trains[i]._dead) this.trains.splice(i, 1);
  }

  // ================= 发车 / 解编 =================
  /** 在机务段相邻的空轨格上发一列新车（无运输计划，处于待命），返回新车或 null */
  spawnTrain(depot) {
    if (this.graphDirty) this.rebuildGraph();
    for (let d = 0; d < 4; d++) {
      const v = FG.Utils.dirVec(d);
      const x = depot.x + v.x, y = depot.y + v.y;
      if (!this.nodes.has(FG.Utils.key(x, y))) continue;
      if (this.occupy.has(FG.Utils.key(x, y))) continue;
      const tr = new FG.Train('T' + (this.trainSeq++), x, y, d);
      this.trains.push(tr);
      this.occupy.set(FG.Utils.key(x, y), tr.id);
      return tr;
    }
    return null;
  }

  removeTrain(tr) {
    this.occupy.delete(FG.Utils.key(tr.x, tr.y));
    tr._dead = true;
  }

  /** 某轨格/站格是否被列车占用（拆除保护） */
  occupiedBy(x, y) { return this.occupy.get(FG.Utils.key(x, y)) || null; }

  /** 限频日志（每列车每类提示冷却） */
  logOnce(tr, key, text, cls) {
    const k = tr.id + ':' + key;
    if (this._lastLog && this._lastLog[k] === this.game.tickCount) return;
    this._lastLog = this._lastLog || {};
    this._lastLog[k] = this.game.tickCount;
    this.game.logMsg(text, cls || 'info');
  }

  // ================= 存档 =================
  serialize() {
    return {
      trainSeq: this.trainSeq, stationSeq: this.stationSeq, moverSeq: this.moverSeq,
      trains: this.trains.map(t => ({
        id: t.id, x: t.x, y: t.y, dir: t.dir,
        cargo: t.cargo.map(s => ({ type: s.type, count: s.count })),
        stops: t.plan.stops.map(s => ({
          stationId: s.stationId, action: s.action, item: s.item || null, count: s.count,
        })),
        loop: t.plan.loop !== false,
        stopIdx: t.stopIdx, paused: !!t.plan.paused,
        state: t.state, dwell: t.dwell || 0, rem: t.work ? t.work.rem : null,
        cooldown: t.leaveCooldown || 0, clearing: !!t.clearing, moveTimer: t.moveTimer || 0,
      })),
    };
  }

  deserialize(data) {
    this.reset();
    if (!data) return;
    this.trainSeq = data.trainSeq || 1;
    this.stationSeq = data.stationSeq || 1;
    this.moverSeq = data.moverSeq || 0;
    this.rebuildGraph(); // 先建站号映射，供停靠状态恢复校验
    for (const st of (data.trains || [])) {
      const tr = new FG.Train(st.id, st.x, st.y, st.dir || 0);
      tr.cargo = (st.cargo || []).map(s => ({ type: s.type, count: s.count }));
      tr.plan = {
        paused: !!st.paused,
        loop: st.loop !== false,
        stops: (st.stops || []).map(s => ({
          stationId: s.stationId, action: s.action === 'load' ? 'load' : 'unload',
          item: s.item || null, count: s.count || 0,
        })),
      };
      tr.stopIdx = st.stopIdx || 0;
      const dockedStop = tr.plan.stops[tr.stopIdx];
      const dockedSt = dockedStop ? this.stationMap.get(dockedStop.stationId) : null;
      if (st.state === 'docked' && dockedSt && dockedSt.x === tr.x && dockedSt.y === tr.y) {
        tr.state = 'docked';
        tr.dwell = st.dwell || 0;
        tr.work = { rem: st.rem != null ? st.rem : (dockedStop.count || 0) };
      } else if (['idle', 'paused', 'blocked', 'waiting', 'noroute'].includes(st.state)) {
        tr.state = st.state;
      } else {
        tr.state = 'moving';
      }
      tr.leaveCooldown = st.cooldown || 0;
      tr.clearing = !!st.clearing;
      tr.moveTimer = st.moveTimer || 0;
      this.trains.push(tr);
      this.occupy.set(FG.Utils.key(tr.x, tr.y), tr.id);
    }
  }
};

/**
 * FG.Train —— 列车运行时实体（单节机车，混堆载货 TRAIN_CARGO_CAP 件）
 * 状态机：idle 待命 → moving 行驶 → docked 装卸 → moving（循环下一站）；
 *         blocked 堵死/让行等待、noroute 断路、paused 已停运。
 */
FG.Train = class Train {
  constructor(id, x, y, dir) {
    this.isTrain = true;
    this.id = id;
    this.x = x; this.y = y;       // 车头（列车）当前占据格
    this.px = x; this.py = y;     // 上一格（渲染插值）
    this.dir = dir;
    this.cargo = [];             // [{type,count}]
    this.plan = { paused: false, stops: [], loop: true };
    this.stopIdx = 0;
    this.state = 'idle';
    this.path = null;            // 待行驶格（不含当前格）
    this.moveTimer = 0;          // 跨入下一格剩余 tick
    this.dwell = 0;              // 已停站 tick
    this.work = null;            // {rem} 当前停站动作剩余件数
    this.leaveCooldown = 0;      // 离站冷却：>0 时禁止在当前站重新停靠（先驶离）
    this.clearing = false;      // 单程末站清道中（驶离后转待命）
    this._dead = false;
  }

  get stops() { return this.plan.stops; }

  // ================= 计划编辑 =================
  addStop(stationId, action, item, count) {
    this.plan.stops.push({
      stationId,
      action: action === 'load' ? 'load' : 'unload',
      item: item || null,
      count: Math.max(1, Math.min(FG.Config.TRAIN_CARGO_CAP, count || 1)),
    });
    // 待命列车新增计划：从当前位置重新启动（若正停在目标站则直接停靠）
    if (this.state === 'idle') { this.state = 'moving'; this.clearing = false; this.path = null; }
  }
  removeStop(i) {
    if (i < 0 || i >= this.plan.stops.length) return;
    const wasCurrent = i === this.stopIdx && this.state === 'docked';
    this.plan.stops.splice(i, 1);
    if (i < this.stopIdx) this.stopIdx--;
    // splice 后 stopIdx 自然指向下一站；删掉末站则回到首站
    if (this.stopIdx >= this.plan.stops.length) this.stopIdx = 0;
    if (wasCurrent) {
      this.work = null; this.dwell = 0; this.path = null;
      this.state = this.plan.stops.length ? 'moving' : 'idle';
    }
    if (!this.plan.stops.length) { this.state = 'idle'; this.path = null; }
  }
  updateStop(i, patch) {
    const s = this.plan.stops[i];
    if (!s) return;
    if (patch.action) s.action = patch.action === 'load' ? 'load' : 'unload';
    if ('item' in patch) s.item = patch.item || null;
    if (patch.count) s.count = Math.max(1, Math.min(FG.Config.TRAIN_CARGO_CAP, patch.count));
  }
  setPaused(v) {
    this.plan.paused = !!v;
    if (v) this.state = 'paused';
    else if (this.state === 'paused') this.state = this.plan.stops.length ? 'moving' : 'idle';
  }
  /** 跳过当前站（停靠中立即发车；行驶中直接指向下一站并重新寻路）；单程末站跳过则清道待命 */
  skip() {
    if (!this.plan.stops.length) return;
    this.work = null;
    this.dwell = 0;
    this.path = null;
    this.leaveCooldown = 2;
    if (this.plan.loop || this.stopIdx < this.plan.stops.length - 1) {
      this.advanceStop();
      this.state = 'moving';
    } else {
      this.clearing = true;
      this.state = 'idle';
    }
  }

  // ================= 载货 =================
  cargoTotal() { return this.cargo.reduce((n, s) => n + s.count, 0); }
  cargoCount(item) {
    if (!item) return this.cargoTotal();
    const s = this.cargo.find(x => x.type === item);
    return s ? s.count : 0;
  }
  /** 列车取出 n 件（指定类型；item=null 任意，按堆顺序），返回实际取出数 */
  pullFromTrain(item, n) {
    let left = n;
    for (const s of this.cargo) {
      if (left <= 0) break;
      if (item && s.type !== item) continue;
      const take = Math.min(left, s.count);
      s.count -= take; left -= take;
    }
    this.cargo = this.cargo.filter(s => s.count > 0);
    return n - left;
  }
  /** 向列车装入 n 件，受载货上限约束，返回实际装入数 */
  pushToTrain(item, n) {
    const room = FG.Config.TRAIN_CARGO_CAP - this.cargoTotal();
    const put = Math.min(n, room);
    if (put <= 0) return 0;
    let s = this.cargo.find(x => x.type === item);
    if (s) s.count += put; else this.cargo.push({ type: item, count: put });
    return put;
  }

  // ================= 仿真 =================
  /** 每 tick 推进；返回本 tick 是否成功跨入新格（区间争用轮转用） */
  tick(ry) {
    if (this.plan.paused) { this.state = 'paused'; return false; }
    if (this.state === 'docked') { this.tickDocked(ry); return false; }
    if (!this.plan.stops.length) { this.state = 'idle'; this.path = null; return false; }

    // 确定目标站（站点缺失则自动跳过）
    let stop = this.plan.stops[this.stopIdx];
    let station = ry.stationById(stop.stationId);
    if (!station) {
      ry.logOnce(this, 'miss' + this.stopIdx, '🚆 ' + this.id + '：计划站点已拆除，自动跳过', 'info');
      this.advanceStop();
      return false;
    }

    // 刚离站的冷却 / 单程末站清道：强制先驶离本站一格
    //（循环单站不瞬时重入；单程末站驶离后转待命，不继续占站）
    if (this.leaveCooldown || this.clearing) {
      if (this.moveTimer > 0) {
        this.moveTimer--;
        if (this.moveTimer === 0) this.commitArrival(ry);
        return false;
      }
      // 清道已驶离（clearing 在到达时被清除）但冷却尚未走完：原地待命，不再寻路
      if (this.clearing === false && this.state === 'idle') return false;
      // 冷却中但尚未起步（无 path）：先驶到本站任一相邻轨格，之后再寻路/待命
      if (!this.path || !this.path.length) {
        const out = this.neighborRail(ry, this.x, this.y);
        if (!out) { this.state = 'blocked'; return false; } // 死胡同：无法驶离（堵死，需改线）
        this.claimToward(ry, out);
        return true;
      }
    }

    // 单程计划已驶离末站（clearing 结束）→ 回待命，不再自动行驶；新增停靠站后由 addStop 唤起
    if (this.state === 'idle') return false;

    // 已停在目标站格（含读档/起点重合）→ 直接开停；
    // 刚从该站发车（leaveCooldown 内）必须先驶离，避免同一站单站计划瞬时重入
    if (this.x === station.x && this.y === station.y && !this.leaveCooldown) {
      this.beginDock(station);
      return false;
    }

    // 寻路（断路时每 tick 重试；轨网补齐即自愈）
    if (!this.path) {
      this.path = ry.findPath(this.x, this.y, station.x, station.y);
      if (!this.path) { this.state = 'noroute'; return false; }
    }

    // 正在跨格中
    if (this.moveTimer > 0) {
      this.moveTimer--;
      if (this.state !== 'moving') this.state = 'moving';
      if (this.moveTimer === 0) this.commitArrival(ry);
      return false;
    }

    // 申请下一区间
    const next = this.path[0];
    const nk = FG.Utils.key(next.x, next.y);
    const holder = ry.occupy.get(nk);
    if (holder && holder !== this.id) {
      const ht = ry.trainById(holder);
      // 前车正在车站装卸/排队进站 → 正常等站；前车停运或顶住 → 堵死
      this.state = (ht && (ht.state === 'docked')) ? 'waiting' : 'blocked';
      return false;
    }
    // 占用权移交：离开旧格、占住新格、起步
    ry.occupy.delete(FG.Utils.key(this.x, this.y));
    ry.occupy.set(nk, this.id);
    this.px = this.x; this.py = this.y;
    const d = dirFromTo(this.x, this.y, next.x, next.y);
    if (d >= 0) this.dir = d;
    this.path.shift();
    this.moveTimer = FG.Config.TRAIN_MOVE_TICKS - 1;
    this.state = 'moving';
    return true;
  }

  /** 跨格动画计时结束：车头落到新格 */
  commitArrival(ry) {
    // 由起步时记录的目标推进（path 已 shift；用占用反推）
    // occupy 已指向新格，取其坐标即可
    let nx = this.x, ny = this.y;
    for (const [k, id] of ry.occupy) {
      if (id === this.id) { const [x, y] = k.split(',').map(Number); nx = x; ny = y; break; }
    }
    this.x = nx; this.y = ny;
    const wasClearing = this.clearing;
    if (this.leaveCooldown > 0) this.leaveCooldown--; // 已驶离至少一格，解除禁停
    // 单程末站清道：驶离即结束并待命，不再寻路回站
    if (wasClearing) { this.clearing = false; this.state = 'idle'; this.path = null; return; }
    if (this.path && this.path.length) return;        // 冷却驶离途中：到达后下一 tick 正常寻路
    if (!this.path) { this.state = 'moving'; return; }
    {
      const stop = this.plan.stops[this.stopIdx];
      const station = ry.stationById(stop.stationId);
      if (station && station.x === this.x && station.y === this.y) this.beginDock(station);
      else { this.state = 'noroute'; this.path = null; }
    }
  }

  /** (x,y) 的任一相邻轨格（离站冷却时驶离用） */
  neighborRail(ry, x, y) {
    for (let d = 0; d < 4; d++) {
      const v = FG.Utils.dirVec(d);
      const nx = x + v.x, ny = y + v.y;
      const nk = FG.Utils.key(nx, ny);
      if (!ry.nodes.has(nk)) continue;
      const holder = ry.occupy.get(nk);
      if (holder && holder !== this.id) continue;
      return { x: nx, y: ny };
    }
    return null;
  }

  /** 申请向某相邻轨格起步（占用权移交），返回是否成功 */
  claimToward(ry, next) {
    const nk = FG.Utils.key(next.x, next.y);
    const holder = ry.occupy.get(nk);
    if (holder && holder !== this.id) { this.state = 'blocked'; return false; }
    ry.occupy.delete(FG.Utils.key(this.x, this.y));
    ry.occupy.set(nk, this.id);
    this.px = this.x; this.py = this.y;
    const d = dirFromTo(this.x, this.y, next.x, next.y);
    if (d >= 0) this.dir = d;
    if (this.path && this.path.length && this.path[0].x === next.x && this.path[0].y === next.y) this.path.shift();
    this.moveTimer = FG.Config.TRAIN_MOVE_TICKS - 1;
    this.state = 'moving';
    return true;
  }

  // ================= 停站装卸 =================
  beginDock(station) {
    this.state = 'docked';
    this.dwell = 0;
    this.moveTimer = 0;
    const stop = this.plan.stops[this.stopIdx];
    this.work = { rem: stop.count || 0 };
  }

  tickDocked(ry) {
    this.dwell++;
    const stop = this.plan.stops[this.stopIdx];
    const station = ry.stationById(stop.stationId);
    if (!station) { this.beginDepart(ry); return; }

    // 逐 tick 装卸（上限 TRANSFER 件）
    if (this.work.rem > 0) {
      const budget = Math.min(FG.Config.TRAIN_TRANSFER, this.work.rem);
      let moved = 0;
      if (stop.action === 'unload') {
        moved = this.unloadToStation(station, stop.item, budget);
      } else {
        moved = this.loadFromStation(station, stop.item, budget);
      }
      this.work.rem = Math.max(0, this.work.rem - moved);
    }

    const settled = this.stopSettled(station, stop);
    if (this.dwell >= FG.Config.TRAIN_DWELL_MAX) {
      if (!settled) ry.logOnce(this, 'dwellmax', '🚆 ' + this.id + '：在「' + (station.stationName || '站点')
        + '」等待超时（' + (stop.action === 'load' ? '装' : '卸') + '料未完成），强制离站防堵站', 'error');
      this.beginDepart(ry);
    } else if (settled && this.dwell >= FG.Config.TRAIN_DWELL_MIN) {
      this.beginDepart(ry);
    }
  }

  /** 停站动作是否已无可推进：
   *  计划数量已完成 → settled（等到最短停站时间即走）；
   *  卸货=车上已无对应货（站满则继续等）；装货=车满或站无货 */
  stopSettled(station, stop) {
    if (this.work.rem <= 0) return true;
    if (stop.action === 'unload') {
      if (this.cargoCount(stop.item) > 0) return false;      // 车上还有但站里塞不下 → 继续等
    } else {
      if (this.cargoTotal() < FG.Config.TRAIN_CARGO_CAP && stationCount(station, stop.item) > 0) return false;
    }
    return true;
  }

  /** 列车 → 站货位，返回实际卸下件数（站满则卸不动） */
  unloadToStation(station, item, n) {
    let moved = 0;
    for (const s of this.cargo) {
      if (moved >= n) break;
      if (item && s.type !== item) continue;
      const want = Math.min(n - moved, s.count);
      // 站里现有同品槽先填，再找空槽
      let put = 0;
      for (const slot of station.chest) {
        if (put >= want) break;
        if (slot.type === s.type && slot.count < slot.cap) {
          const q = Math.min(want - put, slot.cap - slot.count);
          slot.count += q; put += q;
        }
      }
      for (const slot of station.chest) {
        if (put >= want) break;
        if (slot.count === 0) {
          const q = Math.min(want - put, slot.cap);
          slot.type = s.type; slot.count = q; put += q;
        }
      }
      if (put > 0) { s.count -= put; moved += put; }
      if (put < want) break; // 站库满，本 tick 无能为力（等机械臂/带拉走）
    }
    this.cargo = this.cargo.filter(s => s.count > 0);
    return moved;
  }

  /** 站货位 → 列车，返回实际装件数 */
  loadFromStation(station, item, n) {
    let moved = 0;
    for (const slot of station.chest) {
      if (moved >= n) break;
      if (slot.count <= 0) continue;
      if (item && slot.type !== item) continue;
      const want = Math.min(n - moved, slot.count);
      const put = this.pushToTrain(slot.type, want);
      slot.count -= put;
      moved += put;
      if (slot.count === 0) slot.type = null;
      if (put < want) break; // 列车货满
    }
    return moved;
  }

  advanceStop() {
    if (this.plan.stops.length) this.stopIdx = (this.stopIdx + 1) % this.plan.stops.length;
  }

  beginDepart(ry) {
    this.work = null;
    this.dwell = 0;
    this.path = null;
    const oneWayEnd = !this.plan.loop && this.stopIdx >= this.plan.stops.length - 1;
    // 冷却期间：循环车继续行驶到下一站；单程末站驶离后待命（不继续占站）
    this.clearing = oneWayEnd;
    this.leaveCooldown = 2;
    if (!this.plan.stops.length) { this.state = 'idle'; return; }
    if (!oneWayEnd) {
      this.advanceStop();
      this.state = 'moving';
    } else {
      this.state = 'idle';
    }
  }
};

/** 站货位某物品数量（item=null 为总量） */
function stationCount(station, item) {
  let n = 0;
  for (const s of station.chest) {
    if (s.count > 0 && (!item || s.type === item)) n += s.count;
  }
  return n;
}

/** 相邻格方向索引（0~3），不相邻返回 -1 */
function dirFromTo(fx, fy, tx, ty) {
  for (let d = 0; d < 4; d++) {
    const v = FG.Utils.dirVec(d);
    if (fx + v.x === tx && fy + v.y === ty) return d;
  }
  return -1;
}
