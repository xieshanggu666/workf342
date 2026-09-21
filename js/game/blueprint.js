/**
 * FG.Blueprint —— 蓝图：框选捕获、旋转、成本汇总、科技/地形校验
 * FG.Construction —— 施工调度：分阶段闸门 × 计划优先级 × 前置依赖 × 全局建材统一分配
 *
 * 调度模型（每 tick 一轮）：
 *  - 先盘点全图「自由建材」（箱子→地面物料堆）构成统一预算池，所有计划共享；
 *  - 计划可设高/中/低优先级与前置依赖：高优先级一层未取料前低优先级不分配，
 *    同级按轮转游标公平起步；前置计划未完成（仍在列表中）时本计划挂起、不占料；
 *  - 每个计划按蓝图顺序找「前沿条目」：尽量从预算池预留其缺口建材（可部分预留，
 *    预留即移出物流）；前沿凑不齐时，向后找一栋「当前能一次凑齐整套成本」的条目
 *    直接建成 —— 即缺料时推进可施工部分；
 *  - 建材凑齐且施工间隔到期 → 消耗预留、落成建筑（map/sim 注册 + 配方/筛选/优先级
 *    还原），自动纳入每 tick 的按需物流调度；
 *  - 暂停计划 / 等待前置 / 取消计划：已预留建材立即返还物流（优先箱子，余下落地），
 *    已建成建筑保留；前置计划被取消视为依赖自动满足；
 *  - 预留按条目记账，计划整体序列化（含优先级/依赖/暂停态/条目预留），读档续建；
 *    旧存档的计划级 stock 迁移到前沿条目，无施工字段的旧档回退空计划。
 *
 * 分阶段产线（stages × gates）：
 *  - 计划条目按切分点（stage.cut：阶段末条目的下一个下标）划分为若干顺序阶段；
 *  - 非末尾阶段各带一个放行闸门 gate：
 *      { mode:'built' }            阶段全部建成（含跳过）即放行后续阶段；
 *      { mode:'trial', item?, n }  阶段建成后还须「试产达标」：阶段内生产建筑
 *                                  （组装机/熔炉/化工厂/炼油厂/矿机）累计完成 n 次
 *                                  生产（可选 item 限定产物；item 为空=任意产物）；
 *  - 只有「活跃阶段」可备料施工；闸门未开放的后续阶段不占料，每 tick 释放其预留；
 *  - 闸门开放后其建成建筑若被拆/被换成非目标型号 → 条目回退待建（升级条目按新造
 *    重建设价备料）、闸门自动关闭、后续阶段挂起并释放预留；重建并再次达标后自动
 *    重新放行（阶段进度随存档保存）；
 *  - 缺料联动：活跃阶段缺料时同样挂起后续阶段（其预留本就不入账，统一在每 tick 释放）；
 *  - 试产基线：阶段进入试产等待时快照其内生产建筑的完成次数（条目 base，null=未建立）：
 *    base = { total, items }，total=总完成次数（任意产物闸门用），items=按产物分项的
 *    完成次数（限定产物闸门用）。生产侧对每种产物各自累计（建筑 craftedByItem），
 *    因此切换配方后旧产物的次数不会串计到新产物（旧版只按 totalCrafted 总数统计，
 *    切配方会误把旧产物次数计入新产物而错误放行）；阶段进度随存档保存，旧档读入时迁移
 *    （数字基线懒迁移；旧版已误开放的试产闸门一律重新核验关闭，补产达标后自动再放行）。
 *
 * 原地升级（kind='upgrade'）：
 *  - 升级计划条目带 from（原建筑类型）：备料成本为新建筑造价，落成时把该格旧建筑
 *    原地替换为高级型号 —— 配方、槽位库存、流体、传送带在途物品（含预留标签）、
 *    机械臂手持/筛选/按需、供料优先级全部迁移，在途预留因消费者坐标不变而继续有效；
 *  - 计划期间原建筑被拆/变更 → 条目跳过并释放预留；该格已是目标型号 → 直接记完成；
 *  - 暂停/取消与蓝图计划一致：未用预留建材返还物流，已完成的升级保留；
 *  - 旧存档无 kind/from 字段 → 按普通建造计划处理，行为不变。
 */
FG.Blueprint = (() => {

  /** 框选捕获：把矩形区域内的建筑存为相对坐标蓝图（含配方/筛选/按需/优先级） */
  function capture(map, x0, y0, x1, y1) {
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    const entries = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const b = map.buildingAt(x, y);
        if (!b) continue;
        entries.push({
          type: b.type, dx: x - minX, dy: y - minY, dir: b.dir || 0,
          recipe: b.recipe || null,
          filter: b.filter || null,
          demandMode: !!b.demandMode,
          priority: b.priority || 'normal',
          stationName: b.stationName || null,
        });
      }
    }
    return { w: maxX - minX + 1, h: maxY - minY + 1, entries };
  }

  /** 顺时针旋转 90°：条目坐标与朝向同步旋转（require 资源约束一并保留） */
  function rotate(bp) {
    return {
      w: bp.h, h: bp.w,
      fromPreset: bp.fromPreset || null,
      entries: bp.entries.map(e => ({
        type: e.type, dx: bp.h - 1 - e.dy, dy: e.dx, dir: ((e.dir || 0) + 1) % 4,
        recipe: e.recipe || null,
        filter: e.filter || null,
        demandMode: !!e.demandMode,
        priority: e.priority || 'normal',
        stationName: e.stationName || null,
        require: e.require ? Object.assign({}, e.require) : undefined,
      })),
    };
  }

  /** 蓝图建材总成本 {item: n} */
  function costOf(bp) {
    const total = {};
    for (const e of bp.entries) {
      const c = FG.Buildings.costOf(e.type);
      for (const k of Object.keys(c)) total[k] = (total[k] || 0) + c[k];
    }
    return total;
  }

  /**
   * 放置校验（科技 + 配方 + 地形/占用 + 资源约束 + 施工计划占格）：
   * 返回 { ok, reason, cells:[{x,y,ok,reason}] }，cells 与 entries 同序（预览着色用）。
   * 一键流水线预设可在条目上带 require：
   *   require.terrain='ore'   须为矿脉格（oreType 指定矿种时还须矿种相符）
   *   require.terrain='water' 水泵：陆地格且四邻有水域
   *   require.terrain='oil'   须为油田格
   */
  function validate(game, bp, ox, oy) {
    const cells = [];
    let ok = true;
    const locked = new Set();
    const lockedRecipes = new Set();
    let blocked = 0, badOre = 0, noWater = 0, noOil = 0;
    for (const e of bp.entries) {
      const x = ox + e.dx, y = oy + e.dy;
      let cok = true, reason = '';
      if (!game.research.isBuildingUnlocked(e.type)) {
        cok = false; reason = 'tech';
        locked.add(FG.Buildings.byId(e.type).name);
      } else if (e.recipe && !game.research.isRecipeUnlocked(e.recipe)) {
        cok = false; reason = 'tech';
        lockedRecipes.add(FG.Recipes.byId(e.recipe).name);
      } else if (e.require && e.require.terrain === 'ore') {
        // 矿机：目标格必须是（指定种类的）矿脉
        const ore = game.map.inBounds(x, y) ? game.map.oreAt(x, y) : null;
        if (!ore) { cok = false; reason = 'terrain'; badOre++; }
        else if (e.require.oreType && ore !== e.require.oreType) { cok = false; reason = 'oretype'; badOre++; }
        else if (game.map.isOccupied(x, y) || (game.construction && game.construction.entryAt(x, y))) {
          cok = false; reason = 'terrain'; blocked++;
        }
      } else if (e.require && e.require.terrain === 'water') {
        // 水泵：陆地（非水面）且四邻有水域
        const landOK = game.map.inBounds(x, y) && game.map.terrainAt(x, y) !== 'water';
        if (!landOK || !game.adjacentWater(x, y)) {
          cok = false; reason = 'terrain'; noWater++;
        } else if (game.map.isOccupied(x, y) || (game.construction && game.construction.entryAt(x, y))) {
          cok = false; reason = 'terrain'; blocked++;
        }
      } else if (e.require && e.require.terrain === 'oil') {
        if (!game.map.isOil(x, y) || game.map.isOccupied(x, y)
            || (game.construction && game.construction.entryAt(x, y))) {
          cok = false; reason = 'terrain'; noOil++;
        }
      } else if (!game.canPlace(e.type, x, y)) {
        cok = false; reason = 'terrain'; blocked++;
      } else if (game.construction && game.construction.entryAt(x, y)) {
        cok = false; reason = 'planned'; blocked++;
      }
      if (!cok) ok = false;
      cells.push({ x, y, ok: cok, reason });
    }
    let msg = '';
    if (locked.size || lockedRecipes.size) {
      msg = '科技未解锁：' + Array.from(locked).concat(Array.from(lockedRecipes)).join('、');
    } else if (badOre) msg = badOre + ' 个矿机位未对准矿脉（矿机需落在对应矿脉上）';
    else if (noWater) msg = noWater + ' 个水泵位无效（需在陆地上且紧邻水域）';
    else if (noOil) msg = noOil + ' 个抽油机位未对准油田';
    else if (blocked) msg = blocked + ' 个位置被占用 / 地形不符 / 已有施工计划';
    return { ok, reason: msg, cells };
  }

  return { capture, rotate, costOf, validate };
})();

// ============================================================
FG.Construction = class Construction {
  constructor(game) {
    this.game = game;
    this.plans = [];   // [{id,name,priority,paused,deps:[id],entries:[{...state,stock}],cursor,timer}]
    this.seq = 1;
    this.tierStart = { high: 0, normal: 0, low: 0 }; // 同级轮转起步游标（每 tick）
  }

  /** 提交施工计划：蓝图条目落到世界坐标，进入统一调度队列 */
  addPlan(bp, ox, oy, opts) {
    opts = opts || {};
    const plan = {
      id: 'P' + (this.seq++),
      name: '蓝图 ' + bp.w + '×' + bp.h + ' #' + (this.seq - 1),
      kind: 'build',
      priority: VALID_PRIORITIES[opts.priority] ? opts.priority : 'normal',
      paused: false,
      deps: [],                 // 前置计划 id：全部完工/取消前本计划挂起
      stages: [{ cut: bp.entries.length, gate: null }],  // 分阶段：默认单阶段
      entries: bp.entries.map(e => ({
        type: e.type, from: null, x: ox + e.dx, y: oy + e.dy, dir: e.dir || 0,
        recipe: e.recipe || null, filter: e.filter || null,
        demandMode: !!e.demandMode, priority: e.priority || 'normal',
        stationName: e.stationName || null,
        state: 'wait',           // wait | done | skip
        stock: {},               // 该条目已预留（移出物流）的建材
        base: null,              // 阶段试产基线：null=未建立（进入试产等待时快照）
      })),
      cursor: 0,
      timer: 0,
      waiting: false,            // 缺料等待（UI 状态）
      blocked: false,            // 等待前置依赖（UI 状态）
      stageBlocked: false,       // 等待前置阶段闸门（建成/试产）放行（UI 状态）
      stageReason: '',           // 闸门等待原因（UI 文案）
      activeStage: 0,            // 当前可施工阶段下标（每 tick reconcile 刷新）
    };
    this.plans.push(plan);
    FG.Events.emit('construction:change');
    return plan;
  }

  /**
   * 提交原地升级计划：list 为 [{from,to,x,y,dir}]（框选产线生成）。
   * 逐栋按新建筑造价备料，凑齐后原地替换并迁移配方/库存/在途物料。
   */
  addUpgradePlan(list, opts) {
    opts = opts || {};
    const plan = {
      id: 'P' + (this.seq++),
      name: '产线升级 #' + (this.seq - 1),
      kind: 'upgrade',
      priority: VALID_PRIORITIES[opts.priority] ? opts.priority : 'normal',
      paused: false,
      deps: [],
      stages: [{ cut: list.length, gate: null }],
      entries: list.map(u => ({
        type: u.to, from: u.from, x: u.x, y: u.y, dir: u.dir || 0,
        recipe: null, filter: null,            // 配方/筛选等落成时从旧建筑实时迁移
        demandMode: false, priority: 'normal',
        stationName: null,
        state: 'wait',
        stock: {},
        base: null,
      })),
      cursor: 0,
      timer: 0,
      waiting: false,
      blocked: false,
      stageBlocked: false,
      stageReason: '',
      activeStage: 0,
    };
    this.plans.push(plan);
    FG.Events.emit('construction:change');
    return plan;
  }

  /** 某格是否有待建条目（校验/悬浮提示用），暂停计划的格子同样占位 */
  entryAt(x, y) {
    for (const p of this.plans) {
      for (const e of p.entries) {
        if (e.state === 'wait' && e.x === x && e.y === y) return { plan: p, entry: e };
      }
    }
    return null;
  }

  // ================= 计划操作（面板） =================
  /** 设置计划优先级（高/中/低），立即参与下一轮统一分配 */
  setPriority(planId, priority) {
    const p = this.byId(planId);
    if (!p || !VALID_PRIORITIES[priority]) return false;
    p.priority = priority;
    FG.Events.emit('construction:change');
    return true;
  }

  setPaused(planId, paused) {
    const p = this.byId(planId);
    if (!p || p.paused === paused) return false;
    p.paused = paused;
    if (paused) this.releaseReserved(p); // 暂停即释放全部预留，建材回归物流
    FG.Events.emit('construction:change');
    return true;
  }

  togglePaused(planId) {
    const p = this.byId(planId);
    return p ? this.setPaused(planId, !p.paused) : false;
  }

  /**
   * 设置前置依赖（覆盖式）：自动剔除不存在/已完工/自身的 id，并做环检测；
   * 加入依赖会让计划立即挂起并释放预留，解除依赖后自动恢复。
   */
  setDeps(planId, depIds) {
    const p = this.byId(planId);
    if (!p) return false;
    const ids = [];
    for (const id of depIds || []) {
      const d = this.byId(id);
      if (d && d !== p && !ids.includes(id)) ids.push(id);
    }
    p.deps = ids;
    if (this.createsCycle(p)) {
      p.deps = [];
      this.game.logMsg('⚠ 无法为「' + p.name + '」设置前置：存在循环依赖', 'error');
      return false;
    }
    if (ids.length && !this.depsSatisfied(p)) this.releaseReserved(p);
    FG.Events.emit('construction:change');
    return true;
  }

  addDep(planId, depId) {
    const p = this.byId(planId);
    if (!p) return false;
    if (p.deps.includes(depId)) return true;
    const next = p.deps.concat([depId]);
    return this.setDeps(planId, next);
  }

  removeDep(planId, depId) {
    const p = this.byId(planId);
    if (!p) return false;
    p.deps = p.deps.filter(id => id !== depId);
    FG.Events.emit('construction:change');
    return true;
  }

  byId(id) { return this.plans.find(p => p.id === id) || null; }

  // ================= 分阶段：切分 / 闸门设置 =================
  /** 规整阶段切分点：严格递增、全部落在 (0, entries.length) 区间；闸门按 cut 对齐保留 */
  normalizeStages(p) {
    const n = p.entries.length;
    const gateByCut = new Map();
    for (const s of (p.stages || [])) {
      const cut = s.cut | 0;
      if (cut > 0 && cut < n && s.gate && !gateByCut.has(cut)) gateByCut.set(cut, sanitizeGate(s.gate));
    }
    const cuts = Array.from(gateByCut.keys());
    // 兼容：即使旧切分点无闸门也要保留（从旧 stages 收集全部 cut）
    for (const s of (p.stages || [])) {
      const cut = s.cut | 0;
      if (cut > 0 && cut < n && !cuts.includes(cut)) cuts.push(cut);
    }
    cuts.sort((a, b) => a - b);
    const stages = cuts.map(cut => ({ cut, gate: gateByCut.get(cut) || null }));
    stages.push({ cut: n, gate: null });   // 末尾阶段不放行闸门
    p.stages = stages;
    if (p.activeStage === undefined || p.activeStage > stages.length - 1) p.activeStage = 0;
  }

  /**
   * 在条目下标 cut 处切分阶段（cut = 新阶段第一个条目的下标）。
   * 已存在的切分点幂等返回 true。返回是否实际发生变更。
   */
  splitStage(planId, cut) {
    const p = this.byId(planId);
    if (!p) return false;
    cut = cut | 0;
    if (cut <= 0 || cut >= p.entries.length) return false;
    if (p.stages.some(s => s.cut === cut)) return true;
    p.stages.push({ cut, gate: { mode: 'built' } });
    this.normalizeStages(p);
    this.reconcileStages(p);   // 立即按新阶段挂起并释放后续预留
    FG.Events.emit('construction:change');
    return true;
  }

  /** 删除第 idx 个阶段边界（其条目并入下一阶段，闸门随之删除） */
  removeStage(planId, idx) {
    const p = this.byId(planId);
    if (!p || idx < 0 || idx >= p.stages.length - 1) return false;  // 末尾阶段不可删
    p.stages.splice(idx, 1);
    this.normalizeStages(p);
    this.reconcileStages(p);   // 闸门移除 → 后续可能立即放行
    FG.Events.emit('construction:change');
    return true;
  }

  /**
   * 设置阶段闸门：
   *   mode='built' 建成即放行；mode='trial' 试产达标（gate.item 可空，gate.n 次数）；
   *   gate=null 移除闸门（等同于建成放行）。
   */
  setStageGate(planId, idx, gate) {
    const p = this.byId(planId);
    if (!p || idx < 0 || idx >= p.stages.length - 1) return false;
    const prev = p.stages[idx].gate;
    if (gate === null) {
      p.stages[idx].gate = null;   // 移除闸门 → reconcile 视为放行
    } else {
      const g = sanitizeGate(gate);
      if (!g) return false;
      // 从「建成/无」切到「试产」：重新开始试产——关闭闸门并重置该阶段基线，
      // 历史产量不计入；仅调整试产产物/次数（同为 trial）则保留进行中的试产进度。
      if (g.mode === 'trial' && (!prev || prev.mode !== 'trial')) {
        g.opened = false;
        for (const i of this.stageEntryIdxs(p, idx)) p.entries[i].base = null;
      }
      // 从「试产」放宽为「建成」：关闭状态交由 reconcile 按建成即开放处理
      if (g.mode === 'built' && prev && prev.mode === 'trial') g.opened = false;
      p.stages[idx].gate = g;
    }
    this.reconcileStages(p);
    FG.Events.emit('construction:change');
    return true;
  }

  /** 阶段下标区间 {from,to}（entry 下标 [from,to)） */
  stageRange(p, idx) {
    const from = idx === 0 ? 0 : p.stages[idx - 1].cut;
    return { from, to: p.stages[idx].cut };
  }

  /** 条目所属阶段下标 */
  stageOfEntry(p, entryIdx) {
    for (let i = 0; i < p.stages.length; i++) if (entryIdx < p.stages[i].cut) return i;
    return p.stages.length - 1;
  }

  /** 阶段内条目下标列表 */
  stageEntryIdxs(p, idx) {
    const { from, to } = this.stageRange(p, idx);
    const out = [];
    for (let i = from; i < to; i++) out.push(i);
    return out;
  }

  /**
   * 试产进度：阶段内生产建筑（配方建筑/矿机）相对基线 base 的完成次数增量；
   * gate.item 限定产物（只统计该产物的分项完成次数，切换配方后旧产物不计入），
   * 缺省（null/''）= 任意产物（按总完成次数）。非试产闸门/基线未建立返回 0。
   * 只读：基线由 ensureTrialBaseline 在阶段建成进入等待时建立，UI 轮询不产生副作用。
   */
  trialProgress(p, idx) {
    const g = p.stages[idx] && p.stages[idx].gate;
    if (!g || g.mode !== 'trial') return 0;
    let sum = 0;
    for (const i of this.stageEntryIdxs(p, idx)) {
      const e = p.entries[i];
      if (!baseValid(e.base)) continue;   // 基线未建立（阶段尚未建成进入等待）
      const b = this.game.map.buildingAt(e.x, e.y);
      if (!b || !isProducer(e, b)) continue;
      if (g.item) {
        // 按产物分项归属：只取该产物自身的完成次数，旧配方/其他产物的次数一律不计
        const baseItems = baseItemsOf(e.base);
        if (!baseItems) continue;   // 旧档数字基线：分项归属未知，等待 ensureTrialBaseline 懒迁移
        const delta = (b.craftedByItem && b.craftedByItem[g.item] || 0) - (baseItems[g.item] || 0);
        if (delta > 0) sum += delta;
      } else {
        const delta = (b.totalCrafted || 0) - e.base.total;
        if (delta > 0) sum += delta;
      }
    }
    return sum;
  }

  /**
   * 阶段可供选择的试产产物：优先取已落成建筑的当前产物；阶段尚未建成时
   * 从蓝图条目预设配方（矿机取 require.oreType）推断，便于提交前就指定试产产物。
   */
  stageTrialItems(p, idx) {
    const out = [];
    const push = (it) => { if (it && !out.includes(it)) out.push(it); };
    for (const i of this.stageEntryIdxs(p, idx)) {
      const e = p.entries[i];
      const b = this.game.map.buildingAt(e.x, e.y);
      if (b && isProducer(e, b)) {
        for (const it of producerItems(this.game, e, b)) push(it);
      } else {
        for (const it of plannedItems(e)) push(it);
      }
    }
    return out;
  }

  /** 前置是否全部满足（前置计划已完工出列或被取消 → 视为满足） */
  depsSatisfied(p) {
    for (const id of p.deps) if (this.byId(id)) return false;
    return true;
  }

  /** 从 p 沿 deps 边是否能走回 p（环检测） */
  createsCycle(p) {
    const stack = p.deps.slice();
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (id === p.id) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const d = this.byId(id);
      if (d) stack.push(...d.deps);
    }
    return false;
  }

  // ================= 主循环：统一建材池 × 优先级分层 × 同级轮转 =================
  tick() {
    // 先对所有计划做阶段对账（不分配建材，仅状态/预留/闸门）：上一 tick 落成的建筑在
    // tick 间隙被拆/降型时，这里把 done 回退 wait、关闭闸门、挂起后续阶段并释放预留——
    // 必须早于完工清理，否则「条目恰好全 done 但闸门建筑刚被拆」的计划会被误判完工出列。
    // 暂停/等前置的计划同样对账：等待期间建筑也可能被拆，状态须保持准确。
    for (const p of this.plans) this.reconcileStages(p);

    // 再清理已无待建条目的计划（返还残余预留），避免 depsSatisfied 误判
    for (let i = this.plans.length - 1; i >= 0; i--) {
      const p = this.plans[i];
      if (!p.entries.some(e => e.state === 'wait')) {
        this.finish(p);
        this.plans.splice(i, 1);
      }
    }
    if (!this.plans.length) return;

    // 状态复位 + 暂停/挂起计划释放预留（不参与本轮分配）
    for (const p of this.plans) {
      p.waiting = false;
      p.blocked = false;
      // 暂停计划本轮不对账（见下），保留其阶段等待态仅用于 UI；可调度计划由对账刷新
      if (!p.paused && this.depsSatisfied(p)) { p.stageBlocked = false; p.stageReason = ''; }
      if (p.paused || !this.depsSatisfied(p)) {
        p.blocked = !p.paused; // 暂停优先显示「已暂停」
        this.releaseReserved(p);
      }
    }

    // 全局自由建材池：箱子 → 地面物料堆（每 tick 盘点一次，所有计划共享预算）
    const pool = new MaterialPool(this.game);
    this.tierStart = { high: 0, normal: 0, low: 0 };

    for (const tier of TIERS) {
      const list = this.plans.filter(p => p.priority === tier && !p.paused && this.depsSatisfied(p));
      if (!list.length) continue;
      // 同级从轮转游标起步，每轮回到同一计划时其 cursor 已推进
      const start = this.tierStart[tier] % list.length;
      let progressed = false;
      for (let n = 0; n < list.length; n++) {
        const p = list[(start + n) % list.length];
        // 分阶段对账：被拆条目回退、闸门开关、后续阶段预留释放、cursor 收敛
        this.reconcileStages(p);
        if (this.processPlan(p, pool)) progressed = true;
      }
      // 本轮有计划推进（预留/落成），下轮从它后面开始：同级公平
      if (progressed) this.tierStart[tier] = (start + 1) % list.length;
    }
  }

  /**
   * 分阶段对账（每 tick、每个可调度计划一次）：
   *  1. 已落成条目若该格建筑被拆/被换成非目标型号 → 回退 wait（升级条目按新造重备料），
   *     已关闭闸门因此可以重新开放（重建达标后自动放行）；
   *  2. 顺序扫描阶段：首个未完全建成/未通过闸门的阶段为「活跃阶段」；其后阶段的
   *     wait 条目预留全部释放（缺料/挂起联动，不占料），cursor 收敛到活跃阶段；
   *  3. 已开放闸门若再次失效（建筑被拆）→ 经步骤 1 回退条目后闸门自动关闭、
   *     回退活跃阶段、挂起后续施工。
   * 进入试产等待时建立试产基线（base，详见 ensureTrialBaseline）。
   */
  reconcileStages(p) {
    this.normalizeStages(p);
    const n = p.entries.length;

    // —— 1. 已完成条目建筑复验：被拆/换成非目标型号 → 回退待建（联动挂起后续阶段） ——
    let revertedStage = -1;   // 发生回退的最前阶段下标（该阶段及其后闸门都要重关）
    for (let i = 0; i < n; i++) {
      const e = p.entries[i];
      if (e.state !== 'done') continue;
      const cur = this.game.map.buildingAt(e.x, e.y);
      const stillBuilt = !!(cur && cur.type === e.type);   // 建造/升级条目：同型建筑仍在
      if (!stillBuilt) {
        e.state = 'wait';
        e.stock = {};
        e.base = null;   // 旧基线作废，重建进入试产等待时重新快照
        const sIdx = this.stageOfEntry(p, i);
        if (revertedStage < 0 || sIdx < revertedStage) revertedStage = sIdx;
        this.game.logMsg('↩ 「' + p.name + '」的前置建筑 (' + e.x + ',' + e.y + ') '
          + FG.Buildings.byId(e.type).name + ' 已被拆除/变更：回退该条目并挂起后续阶段施工', 'error');
      }
    }
    // 回退条目所在阶段及其后所有已开放闸门重新关闭——它们的放行前提（前置建成/试产）
    // 已被破坏，须重建并再次达标后才重新放行
    if (revertedStage >= 0) {
      for (let k = revertedStage; k < p.stages.length - 1; k++) {
        if (p.stages[k].gate) p.stages[k].gate.opened = false;
      }
    }

    // —— 2. 顺序找活跃阶段（首个未建成或闸门未通过的阶段） ——
    let active = p.stages.length - 1;
    let gateWaiting = null;
    let gateJustOpened = false;
    for (let k = 0; k < p.stages.length; k++) {
      const { from, to } = this.stageRange(p, k);
      let complete = true;
      for (let i = from; i < to; i++) if (p.entries[i].state === 'wait') { complete = false; break; }
      if (!complete) { active = k; break; }
      // 阶段已建成：校验放行闸门（末尾阶段无闸门）
      const gate = k < p.stages.length - 1 ? p.stages[k].gate : null;
      if (!gate) continue;
      gate.opened = !!gate.opened;
      if (gate.opened) continue;
      if (gate.mode === 'built') {
        gate.opened = true;   // 全部建成（含跳过）即放行
        gateJustOpened = true;
        this.game.logMsg('✅「' + p.name + '」阶段 ' + (k + 1) + ' 已建成，放行后续阶段施工', 'unlock');
      } else {
        this.ensureTrialBaseline(p, k);   // 进入试产等待时建立基线（先建成后改闸门也正确）
        if (this.trialProgress(p, k) >= trialNeed(gate)) {
          gate.opened = true;
          gateJustOpened = true;
          this.game.logMsg('✅「' + p.name + '」阶段 ' + (k + 1) + ' 试产达标，放行后续阶段施工', 'unlock');
        } else {
          active = k;
          gateWaiting = k;
          break;
        }
      }
    }

    // —— 3. 活跃阶段之后：全部 wait 条目不参与施工，释放其预留（每 tick 幂等） ——
    const activeTo = p.stages[active].cut;
    for (let i = activeTo; i < n; i++) {
      const e = p.entries[i];
      if (e.state === 'wait') this.releaseEntryStock(e);
    }

    // cursor 收敛到活跃阶段首个 wait（兼容被拆回退把 cursor 推前的情况）
    const activeFrom = active === 0 ? 0 : p.stages[active - 1].cut;
    let cursor = n;
    for (let i = activeFrom; i < activeTo; i++) {
      if (p.entries[i].state === 'wait') { cursor = i; break; }
    }
    p.cursor = cursor;
    // 闸门本轮刚放行进入新阶段 → 清掉上一阶段遗留的施工冷却，新阶段第一栋可立即备料；
    // 同阶段内/被拆回退保留冷却（相邻建筑落成节奏）
    if (gateJustOpened) p.timer = 0;
    p.activeStage = active;
    p.stageBlocked = gateWaiting !== null;
    if (gateWaiting !== null) {
      const g = p.stages[gateWaiting].gate;
      if (g.mode === 'trial') {
        const itemName = g.item ? FG.Items.byId(g.item).name : '任意产物';
        p.stageReason = '阶段 ' + (gateWaiting + 1) + ' 试产中：' + itemName + ' '
          + this.trialProgress(p, gateWaiting) + '/' + trialNeed(g);
      } else {
        p.stageReason = '阶段 ' + (gateWaiting + 1) + ' 建成放行';
      }
    }
  }

  /**
   * 建立试产基线：阶段内生产建筑的完成次数快照（base 未初始化时一次性写入）。
   * base = { total, items }：total=总完成次数（任意产物闸门用），
   * items=按产物分项的完成次数快照（限定产物闸门用，切换配方后旧产物次数天然不计入）。
   * 在「阶段建成、进入试产等待」时调用——因此先建成后才把闸门改成试产，
   * 基线也取设置闸门当下的产量，历史产量不会被算入试产增量。
   * 兼容旧档：条目 base 为旧版数字时懒迁移——以读档后建筑的当前分项产量为基线
   * （旧档无产物归属，历史产量一律不计入试产，杜绝旧版「切配方误放行」随档延续）。
   * 闸门重开（建筑被拆重建后再次进入等待）会把回退条目的 base 清零，重新建基线。
   */
  ensureTrialBaseline(p, idx) {
    for (const i of this.stageEntryIdxs(p, idx)) {
      const e = p.entries[i];
      const b = this.game.map.buildingAt(e.x, e.y);
      if (!b || !isProducer(e, b)) continue;
      if (e.base === undefined || e.base === null) {
        e.base = { total: b.totalCrafted || 0, items: Object.assign({}, b.craftedByItem || {}) };
      } else if (typeof e.base === 'number') {
        // 旧版数字基线：total 沿用，分项基线取当前建筑分项计数（历史无归属产量不计入）
        e.base = { total: e.base, items: Object.assign({}, b.craftedByItem || {}) };
      }
    }
  }

  /**
   * 条目当前可否落成：
   *  普通条目：目标格可放置（canPlace）；
   *  升级条目：该格仍是原型号 → 'ok'；已是目标型号（玩家手动替换过）→ 'done'（不耗料记完成）；
   *            原建筑被拆/变更 → 'skip'。
   */
  checkEntry(e) {
    if (!e.from) return this.game.canPlace(e.type, e.x, e.y) ? 'ok' : 'skip';
    const cur = this.game.map.buildingAt(e.x, e.y);
    if (cur && cur.type === e.type) return 'done';
    if (!cur || cur.type !== e.from) return 'skip';
    return 'ok';
  }

  /**
   * 推进单个计划一轮（仅限「活跃阶段」区间 [aFrom, aTo)）：
   *  1. 跳过已建成/被占位的条目，推进 cursor；
   *  2. 前沿条目尽量预留缺口建材（可部分预留），凑齐且间隔到期则建成；
   *  3. 前沿缺料时，仅在活跃阶段内向后找一栋「整套成本本轮能一次凑齐」的条目先建。
   * 返回本轮是否有推进（预留到新料或落成建筑）。
   */
  processPlan(p, pool) {
    let progressed = false;

    // 活跃阶段区间（reconcileStages 已计算 activeStage / cursor，双保险）
    const aIdx = p.activeStage || 0;
    const aFrom = aIdx === 0 ? 0 : p.stages[aIdx - 1].cut;
    const aTo = p.stages[aIdx].cut;

    // 试产等待：活跃阶段已无待建条目（闸门未开），不分配建材
    if (p.stageBlocked || p.cursor >= aTo || p.cursor < aFrom) return progressed;

    // 落成节奏：相邻建筑间隔 CONSTRUCT_BUILD_INTERVAL tick（冷却中只推进游标，不占料）
    if (p.timer > 0) p.timer--;

    // 推进 cursor 到下一待建条目；顺带复验已不可放置的条目（提交后被占 → 跳过）
    while (p.cursor < aTo) {
      const e = p.entries[p.cursor];
      if (e.state !== 'wait') { p.cursor++; continue; }
      const chk = this.checkEntry(e);
      if (chk === 'done') {   // 升级目标已就位（手动替换）：不耗料直接记完成
        e.state = 'done';
        this.releaseEntryStock(e);
        p.cursor++;
        progressed = true;
        continue;
      }
      if (chk === 'skip') {
        e.state = 'skip';
        this.releaseEntryStock(e);
        this.game.logMsg('⚠ 「' + p.name + '」跳过 (' + e.x + ',' + e.y + ') '
          + FG.Buildings.byId(e.type).name + '：'
          + (e.from ? '原建筑已被拆除或变更' : '位置被占用或地形不符'), 'error');
        p.cursor++;
        progressed = true;
        continue;
      }
      break;
    }
    if (p.cursor >= aTo) return progressed;
    // 落成冷却中：不提前抢料（避免占着建材不公平），等间隔到期下轮再分配
    if (p.timer > 0) return progressed;

    // 前沿条目：尽量预留（部分预留），凑齐即可建成
    const head = p.entries[p.cursor];
    if (this.pullEntry(head, pool, false)) progressed = true;
    let target = this.entryReady(head) ? head : null;

    // 前沿凑不齐：活跃阶段内向后找一栋「现在就能凑齐整套成本」的条目先建（不抢前沿已预留的料）
    if (!target) {
      p.waiting = true;
      for (let i = p.cursor + 1; i < aTo; i++) {
        const e = p.entries[i];
        if (e.state !== 'wait' || this.checkEntry(e) !== 'ok') continue;
        // 已成套（可能上一 tick 冷却期已预留）或本轮能成套取出，即作为先建目标；
        // all=true 两阶段原子：成套或一件不取，无回滚
        if (this.entryReady(e) || this.pullEntry(e, pool, true)) { target = e; break; }
      }
    }

    if (target && p.timer <= 0) {
      this.consumeAndBuild(p, target);
      progressed = true;
      if (target === head) p.cursor++;
    }
    return progressed;
  }

  /** 条目预留是否已凑齐整套成本 */
  entryReady(e) {
    const cost = FG.Buildings.costOf(e.type);
    for (const item of Object.keys(cost)) {
      if ((e.stock[item] || 0) < cost[item]) return false;
    }
    return true;
  }

  /**
   * 从统一建材池预留该条目缺口建材（两阶段，先验后取，无回滚路径）：
   *  all=true 必须整套都能凑齐（任一料不足则一件不取，供「可施工部分」探测）；
   *  all=false 尽量取（前沿条目可部分预留）。返回是否实际取到料。
   */
  pullEntry(e, pool, all) {
    const cost = FG.Buildings.costOf(e.type);
    const items = Object.keys(cost);
    const want = {};
    for (const item of items) {
      want[item] = cost[item] - (e.stock[item] || 0);
      if (all && want[item] > 0 && pool.available(item) < want[item]) return false;
    }
    let gotAny = false;
    for (const item of items) {
      if (want[item] <= 0) continue;
      const got = pool.take(item, want[item]); // all 模式必足量；非 all 模式取尽其有
      if (got > 0) {
        e.stock[item] = (e.stock[item] || 0) + got;
        gotAny = true;
      }
    }
    return gotAny;
  }

  /** 消耗条目预留建材，落成建筑并接入生产调度 */
  consumeAndBuild(p, e) {
    const cost = FG.Buildings.costOf(e.type);
    for (const item of Object.keys(cost)) {
      e.stock[item] -= cost[item];
      if (e.stock[item] <= 0) delete e.stock[item];
    }
    this.buildEntry(e);
    e.state = 'done';
    p.timer = FG.Config.CONSTRUCT_BUILD_INTERVAL;
    FG.Events.emit('construction:change');
  }

  /** 落成一栋建筑：注册进地图与仿真，还原产线配置（配方/筛选/按需/优先级） */
  buildEntry(e) {
    if (e.from) return this.swapEntry(e);   // 升级条目：原地替换
    const g = this.game;
    const b = FG.Map.create(e.type, e.x, e.y, e.dir);
    if (b.type === 'miner') b.oreType = g.map.oreAt(e.x, e.y);
    if (b.def.railStation) {
      b.stationId = 'S' + (g.railway.stationSeq++);
      b.stationName = e.stationName || ((b.def.contractDock ? '交付站 ' : '站点 ') + b.stationId.slice(1));
    }
    g.map.register(b);
    g.sim.register(b);   // 接入生产调度：纳入每 tick 调度/传送带/机械臂/生产更新
    if (b.type === 'rail' || b.def.railStation) g.railway.markDirty();
    if (e.recipe && b.def.recipeBuilding && g.research.isRecipeUnlocked(e.recipe)) {
      b.recipe = e.recipe;
      FG.Map.syncRecipeSlots(b);
    }
    if (b.def.inserterTier !== undefined) {
      b.filter = e.filter;
      b.demandMode = e.demandMode;
    }
    if (b.def.recipeBuilding || b.type === 'lab') b.priority = e.priority;
    g.absorbPile(b);     // 回收该格地面物料
    FG.Events.emit('building:placed', b);
    return b;
  }

  /**
   * 原地升级替换：旧建筑拆除的同时新建筑同格同向落成，
   * 配方/库存/在途物料全部迁移（在途预留标签以消费者坐标为键，替换后继续有效）。
   */
  swapEntry(e) {
    const g = this.game;
    const old = g.map.buildingAt(e.x, e.y);
    if (!old || old.type !== e.from) return null;   // 调用前 checkEntry 已校验，双保险
    const nb = FG.Map.create(e.type, e.x, e.y, old.dir);
    // —— 状态迁移（保留配方、库存与在途物料）——
    nb.recipe = old.recipe;              // 同配方组（recipeGroup），配方直接兼容
    nb.progress = old.progress;          // 生产进度不丢
    nb.slots = old.slots;                // 输入/输出槽库存整体搬迁（含换配方残留料）
    nb.fluidTanks = old.fluidTanks;      // 流体缓冲罐
    nb.items = old.items;                // 传送带在途物品（含在途预留标签）
    nb.rr = old.rr;                      // 合流轮转游标
    nb.held = old.held;                  // 机械臂手持物品（含预留标签）
    nb.phase = old.phase; nb.timer = old.timer;
    nb.filter = old.filter; nb.demandMode = old.demandMode;
    nb.priority = old.priority;
    nb.totalCrafted = old.totalCrafted;
    nb.craftedByItem = Object.assign({}, old.craftedByItem || {});   // 分项产量随升级迁移，试产基线不断档
    g.sim.unregister(old);
    g.map.unregister(old);
    g.map.register(nb);
    g.sim.register(nb);                  // 新建筑接入生产调度
    if (nb.def.recipeBuilding) FG.Map.syncRecipeSlots(nb);
    if (g.selection === old) g.selection = nb;   // 选中态跟随新建筑
    g.absorbPile(nb);                    // 回收该格地面物料（如取消返还落在旧建筑脚下的建材）
    FG.Events.emit('building:placed', nb);
    return nb;
  }

  // ================= 预留释放（暂停 / 挂起依赖 / 取消） =================
  /** 返还单个条目的预留建材到该条目坐标（优先箱子，余下落地） */
  releaseEntryStock(e) {
    if (!e || !e.stock || !Object.keys(e.stock).length) return;
    this.refundToLogistics(e.stock, e.x, e.y);
  }

  /** 释放整个计划的全部条目预留（暂停 / 等待前置 / 取消） */
  releaseReserved(p) {
    for (const e of p.entries) {
      if (e.state === 'wait') this.releaseEntryStock(e);
    }
  }

  /** 把库存建材返还物流：优先放回箱子，放不下的落到 (x,y) 地面堆 */
  refundToLogistics(stock, x, y) {
    for (const item of Object.keys(stock)) {
      let left = stock[item];
      if (left <= 0) { delete stock[item]; continue; }
      for (const b of this.game.map.buildings.values()) {
        if (left <= 0) break;
        if (b.type === 'chest') left = this.game.tryChestAdd(b, item, left);
      }
      if (left > 0) this.game.map.pileAdd(x, y, item, left);
      delete stock[item];
    }
  }

  /** 计划完工：剩余预留建材返还，移出列表 */
  finish(p) {
    this.releaseReserved(p);
    const built = p.entries.filter(e => e.state === 'done').length;
    const skipped = p.entries.filter(e => e.state === 'skip').length;
    this.game.logMsg((p.kind === 'upgrade' ? '⬆ 升级完成「' : '🏗 施工完成「') + p.name + '」：'
      + built + (p.kind === 'upgrade' ? ' 栋建筑已原地替换并接入生产调度' : ' 栋建筑建成并接入生产调度')
      + (skipped ? '，' + skipped + ' 栋被跳过' : ''), 'unlock');
    FG.Events.emit('construction:change');
  }

  /** 取消计划：已预留建材返还物流，已建成建筑保留；其下游依赖自动解除 */
  cancel(planId) {
    const i = this.plans.findIndex(p => p.id === planId);
    if (i < 0) return false;
    const p = this.plans[i];
    this.releaseReserved(p);
    const built = p.entries.filter(e => e.state === 'done').length;
    this.plans.splice(i, 1);
    this.game.logMsg('已取消' + (p.kind === 'upgrade' ? '升级计划' : '施工计划') + '「' + p.name + '」：'
      + built + (p.kind === 'upgrade' ? ' 栋已升级保留' : ' 栋已建成保留') + '，未用建材已返还物流', 'info');
    FG.Events.emit('construction:change');
    return true;
  }

  // ================= 序列化（施工进度随存档恢复） =================
  serialize() {
    return {
      seq: this.seq,
      plans: this.plans.map(p => ({
        id: p.id, name: p.name, kind: p.kind || 'build',
        priority: p.priority, paused: !!p.paused,
        deps: (p.deps || []).slice(),
        stages: (p.stages || []).map(s => ({
          cut: s.cut,
          gate: s.gate ? {
            mode: s.gate.mode,
            item: s.gate.item || null,
            n: s.gate.n || FG.Config.STAGE_TRIAL_COUNT,
            opened: !!s.gate.opened,
          } : null,
        })),
        activeStage: p.activeStage || 0,
        cursor: p.cursor, timer: p.timer, waiting: p.waiting,
        entries: p.entries.map(e => ({
          type: e.type, from: e.from || null, x: e.x, y: e.y, dir: e.dir, recipe: e.recipe,
          filter: e.filter, demandMode: e.demandMode, priority: e.priority, state: e.state,
          stationName: e.stationName || null,
          stock: Object.assign({}, e.stock),
          // 试产基线：null=未建立；{total, items:{item:n}} 结构化快照（旧版数字基线读档时懒迁移）
          base: serializeBase(e.base),
        })),
      })),
    };
  }

  deserialize(data, saveVersion) {
    this.plans = [];
    this.seq = (data && data.seq) || 1;
    // 旧版（< 1.8.0）试产统计只按 totalCrafted 总数：切配方后旧产物次数会被计入新产物，
    // 可能把试产闸门误开放并随存档保留。读旧档时对试产闸门做一次性重新核验（见下）。
    const legacyTrial = isLegacyTrialSave(saveVersion);
    for (const sp of ((data && data.plans) || [])) {
      const entries = (sp.entries || []).map(e => ({
        type: e.type, from: e.from || null, x: e.x, y: e.y, dir: e.dir || 0,
        recipe: e.recipe || null, filter: e.filter || null,
        demandMode: !!e.demandMode, priority: e.priority || 'normal',
        stationName: e.stationName || null,
        state: e.state || 'wait',
        stock: e.stock || {},
        base: parseBase(e.base),   // null=未建立；数字=旧版基线（懒迁移）；{total,items}=新基线
      }));
      const n = entries.length;
      const plan = {
        id: sp.id || ('P' + (this.seq - 1)),
        name: sp.name || '施工计划',
        kind: sp.kind === 'upgrade' ? 'upgrade' : 'build',   // 旧存档无 kind → 普通建造
        priority: VALID_PRIORITIES[sp.priority] ? sp.priority : 'normal',
        paused: !!sp.paused,
        deps: Array.isArray(sp.deps) ? sp.deps.slice() : [],
        // 旧存档无 stages 字段 → 整体单阶段（无闸门），行为与旧版一致
        stages: Array.isArray(sp.stages) && sp.stages.length
          ? sp.stages.map(s => ({ cut: s.cut | 0, gate: s.gate ? sanitizeGate(s.gate) : null }))
          : [{ cut: n, gate: null }],
        activeStage: 0,
        cursor: sp.cursor || 0,
        timer: sp.timer || 0,
        waiting: !!sp.waiting,
        blocked: false,
        stageBlocked: false,
        stageReason: '',
        entries,
      };
      // 切分点规整（末尾补全到 n，剔除越界/重复），闸门随阶段序号保留
      this.normalizeStages(plan);
      plan.activeStage = 0;
      if (legacyTrial) this.migrateLegacyTrialGates(plan);
      // 旧存档兼容：旧版预留记在计划级 p.stock，迁移到前沿待建条目，续建语义不变
      if (sp.stock && typeof sp.stock === 'object') {
        const head = entries.find(e => e.state === 'wait');
        if (head) head.stock = Object.assign({}, sp.stock);
      }
      // 依赖指向的计划不在档内（已完工/旧档缺字段）→ 视为已满足，直接剔除
      plan.deps = plan.deps.filter(id => id !== plan.id);
      this.plans.push(plan);
    }
    // 二次清理悬空依赖
    const ids = new Set(this.plans.map(p => p.id));
    for (const p of this.plans) p.deps = p.deps.filter(id => ids.has(id));
  }

  /**
   * 旧档（试产按产物分项修复之前）迁移：
   *  - 已开放的试产闸门无法区分「真达标」与「切配方误放行」→ 一律重新关闭、
   *    作废阶段内旧基线（null，首次对账时以读档后当前产量重新快照），
   *    后续阶段重新挂起；建筑继续生产达 n 次后闸门自动重新放行；
   *  - 未开放闸门保留等待态：旧版数字基线在 ensureTrialBaseline 中懒迁移为
   *    「以当前分项产量为基线」，历史无归属产量不计入（不会再被误判达标）。
   */
  migrateLegacyTrialGates(p) {
    for (let k = 0; k < p.stages.length - 1; k++) {
      const gate = p.stages[k].gate;
      if (!gate || gate.mode !== 'trial' || !gate.opened) continue;
      gate.opened = false;
      for (const i of this.stageEntryIdxs(p, k)) p.entries[i].base = null;
      p.activeStage = Math.min(p.activeStage || 0, k);
    }
  }
};

const TIERS = ['high', 'normal', 'low'];
const VALID_PRIORITIES = { high: 1, normal: 1, low: 1 };

/** 闸门配置规整：built → {mode:'built'}；trial → {mode:'trial',item,n}；非法 → null */
function sanitizeGate(g) {
  if (!g || typeof g !== 'object') return null;
  if (g.mode === 'trial') {
    const n = Math.max(1, Math.min(999, parseInt(g.n, 10) || FG.Config.STAGE_TRIAL_COUNT));
    return { mode: 'trial', item: g.item || null, n, opened: !!g.opened };
  }
  return { mode: 'built', opened: !!g.opened };
}

/** 试产所需完成次数（缺省回退默认值） */
function trialNeed(gate) {
  return Math.max(1, parseInt(gate && gate.n, 10) || FG.Config.STAGE_TRIAL_COUNT);
}

/** 试产基线是否已建立（null/undefined=未建立；旧版数字与新版 {total,items} 均视为已建立） */
function baseValid(base) {
  if (base === undefined || base === null) return false;
  if (typeof base === 'number') return true;
  return base && typeof base === 'object' && typeof base.total === 'number';
}

/** 基线的按产物分项快照：旧版数字基线尚未懒迁移时返回 null（item 闸门本轮不计入） */
function baseItemsOf(base) {
  return (base && typeof base === 'object' && base.items && typeof base.items === 'object') ? base.items : null;
}

/** 序列化试产基线：未建立→null；结构化快照原样（items 拷贝） */
function serializeBase(base) {
  if (base === undefined || base === null) return null;
  if (typeof base === 'number') return base;   // 理论上读档后已懒迁移，兜底保留
  return { total: base.total | 0, items: Object.assign({}, base.items || {}) };
}

/** 读档解析试产基线：数字=旧版（懒迁移）；{total,items}=新版；其余=null 未建立 */
function parseBase(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'object' && typeof raw.total === 'number') {
    const items = {};
    for (const k of Object.keys(raw.items || {})) {
      const v = raw.items[k];
      if (typeof v === 'number' && v > 0) items[k] = v;
    }
    return { total: raw.total | 0, items };
  }
  return null;
}

/**
 * 是否为「试产按产物分项修复」之前的旧存档（< 1.8.0）：
 * 旧版试产只按建筑 totalCrafted 总数统计，切配方后旧产物次数会计入新产物并可能误开闸。
 * 无版本号（更早的存档/导出档）同样按旧档处理。
 */
function isLegacyTrialSave(v) {
  if (typeof v !== 'string' || !v) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return true;
  const major = +m[1], minor = +m[2];
  return major < 1 || (major === 1 && minor < 8);
}

/**
 * 条目落成建筑是否为「可试产生产建筑」：配方建筑（熔炉/组装机/化工厂/炼油厂）或矿机；
 * 实验室与物流建筑不产出可计量产物。
 */
function isProducer(e, b) {
  if (!b) return false;
  if (b.def && b.def.recipeBuilding) return true;
  return b.type === 'miner';
}

/** 生产建筑当前的产物 item 列表（配方结果；矿机取所在矿脉矿种） */
function producerItems(game, e, b) {
  if (b.type === 'miner') {
    const o = (game && game.map && game.map.oreAt) ? game.map.oreAt(b.x, b.y) : null;
    return [o || b.oreType].filter(Boolean);
  }
  if (b.recipe) {
    const r = FG.Recipes.byId(b.recipe);
    if (r) return r.results.filter(x => !FG.Items.isFluid(x.item)).map(x => x.item);
  }
  // 蓝图预设了配方但建筑落成后未挂上（异常/旧档兜底）
  if (e.recipe) {
    const r = FG.Recipes.byId(e.recipe);
    if (r) return r.results.filter(x => !FG.Items.isFluid(x.item)).map(x => x.item);
  }
  return [];
}

/** 蓝图条目计划产出（未落建筑时推断）：预设配方的固体产物；矿机取资源约束的矿种 */
function plannedItems(e) {
  if (e.recipe) {
    const r = FG.Recipes.byId(e.recipe);
    if (r) return r.results.filter(x => !FG.Items.isFluid(x.item)).map(x => x.item);
  }
  if (e.type === 'miner' && e.require && e.require.oreType) return [e.require.oreType];
  return [];
}

/**
 * 全局建材预算池：tick 初盘点全图自由建材（箱子→地面堆），
 * take 时同步物理取出（预留即移出物流，机械臂/调度不可再取）。
 */
class MaterialPool {
  constructor(game) {
    this.game = game;
    this.free = new Map();   // item -> 可分配总量
    this.chests = [];
    for (const b of game.map.buildings.values()) {
      if (!b.def.storage) continue;
      // 交付站货位是合同在途/待交付货物：已与生产、施工在共同料源处争过料，
      // 运抵交付站后归合同独立记账，施工备料不得再从这里抢料。
      if (b.def.contractDock) continue;
      this.chests.push(b);
      for (const s of b.chest) {
        if (s.type && s.count > 0) this.free.set(s.type, (this.free.get(s.type) || 0) + s.count);
      }
    }
    this.piles = [];
    for (const [k, pile] of game.map.piles) {
      for (const s of pile) {
        if (s.type && s.count > 0) this.free.set(s.type, (this.free.get(s.type) || 0) + s.count);
      }
      this.piles.push([k, pile]);
    }
  }

  available(item) { return this.free.get(item) || 0; }

  /** 取走至多 n 件（箱子优先，不足再取地面堆），返回实际取得数 */
  take(item, n) {
    const avail = this.available(item);
    let left = Math.min(n, avail);
    if (left <= 0) return 0;
    const got = left;
    for (const b of this.chests) {
      if (left <= 0) break;
      for (const s of b.chest) {
        if (left <= 0) break;
        if (s.type === item && s.count > 0) {
          const take = Math.min(left, s.count);
          s.count -= take;
          left -= take;
        }
      }
    }
    if (left > 0) {
      for (const [k, pile] of this.piles) {
        if (left <= 0) break;
        const s = pile.find(x => x.type === item && x.count > 0);
        if (!s) continue;
        const take = Math.min(left, s.count);
        s.count -= take;
        left -= take;
        if (s.count <= 0) pile.splice(pile.indexOf(s), 1);
      }
      for (const [k, pile] of this.piles) {
        if (!pile.length) this.game.map.piles.delete(k);
      }
    }
    this.free.set(item, avail - got);
    return got;
  }
}

