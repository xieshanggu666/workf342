/**
 * FG.Scheduler —— 按需物流调度器（需求数量 × 在途预留 × 生产线优先级）
 *
 * 每 tick 机械臂「先统一投放、再统一取料」；调度计划在 tick 初与投放后各刷新一次：
 *  1. 扫描全图在途物品（带面 / 机械臂手上），其预留标签 tag={c,item,t0} 指向某消费者；
 *     标签指向的消费者已拆/已换配方不再需要，或超过 RESV_TTL，则剥离标签释放预留；
 *  2. 计算每个消费者（熔炉/组装机/化工厂/炼油厂/实验室）的缺口 = 目标缓冲 - 库存 - 在途预留，
 *     仲裁用未满足需求 unmet = 缺口 + 本 tick 即将到货（持货臂 timer 到点可投放）的件数；
 *  3. 统计每个抓取源格（箱子/带/建筑槽/地面堆）的「自由物品」（未被预留的数量）；
 *  4. 取货当 tick 通过 claim() 即时申请：在共享同一源格的所有需求臂间做源格级优先级仲裁，
 *     高优先级产线未补足时低优先产线让出，同级按注册顺序轮转，原子扣减自由预算后打预留标签。
 *     不做跨 tick 预批，因此无超卖、无预算泄漏。
 *
 * 不变量：任何一件在途货物要么是「自由货物」（算入某源格预算），
 *         要么是「预留货物」（计入某消费者在途，冲抵其缺口），二者不重复计数。
 * 环路：BFS 追踪带 seen + 节点数预算封顶；货物在环上绕到取料臂即被取走。
 * 读档：调度计划每 tick 重建、无持久运行状态，仅标签/优先级随存档保存。
 */
FG.Scheduler = class Scheduler {
  constructor(sim) {
    this.sim = sim;
    this.game = sim.game;
    this.tick = 0;
    this.consumers = [];      // [{key,b,needs:Set(item), want:{item:buffer}}]
    this.consumerByKey = new Map();
    this.transit = new Map(); // ck -> Map(item -> n)，各消费者在途预留数
    this.freeCache = new Map(); // 抓取源格 key -> {item -> 自由数量}
    this.traceCache = new Map(); // 机械臂 key -> {terminal:bool, items:Set}
    this.armSeq = new Map();    // ck -> 同级轮转起始下标
  }

  reset() { this.consumers = []; this.consumerByKey = new Map(); this.transit.clear(); }

  /** 每 tick 初重建：预留校验 → 缺口 → 自由预算 → 优先级拨付 */
  rebuild(tick) {
    this.tick = tick;
    this.consumers = [];
    this.consumerByKey = new Map();
    this.transit.clear();
    this.freeCache.clear();
    this._arbCache = new Map();
    this.armSeq.clear();
    this.traceCache.clear();

    // ---- 1. 消费者盘点（注册顺序稳定，作为同级公平的次序） ----
    for (const b of this.sim.crafters) this.addConsumer(b);
    for (const b of this.sim.labs) this.addConsumer(b);

    // ---- 2. 在途预留扫描（标签失效则剥离，预留随之释放） ----
    for (const belt of this.sim.belts) {
      for (const it of belt.items) { it._seen = false; this.scanTag(it); }
    }
    for (const ins of this.sim.inserters) {
      if (ins.held) { ins.held._seen = false; this.scanTag(ins.held); }
    }

    // ---- 3. 拨付不做跨 tick 预批：需求臂在「取货当 tick」通过 claim() 即时申请 ----
  }

  /** 投放阶段后、取料阶段前的轻量刷新：库存/在途/自由预算已变，重算除路由外的计划 */
  refreshAfterDrops(tick) {
    this.tick = tick;
    this.consumers = [];
    this.consumerByKey.clear();
    for (const b of this.sim.crafters) this.addConsumer(b);
    for (const b of this.sim.labs) this.addConsumer(b);
    this.transit.clear();
    for (const belt of this.sim.belts) for (const it of belt.items) { it._seen = false; this.scanTag(it); }
    for (const ins of this.sim.inserters) if (ins.held) { ins.held._seen = false; this.scanTag(ins.held); }
    this.freeCache.clear();
    this._arbCache = new Map();
    // 路由追踪缓存（traceCache）在同一 tick 内拓扑不变，保留以省去重复 BFS
  }

  addConsumer(b) {
    const wants = this.wantsOf(b);
    if (!wants) return;
    const c = {
      key: FG.Utils.key(b.x, b.y), b,
      priority: FG.Config.PRIORITIES[b.priority] || FG.Config.PRIORITIES.normal,
      want: wants,
    };
    this.consumers.push(c);
    this.consumerByKey.set(c.key, c);
  }

  /** 消费者目标缓冲 {item: 目标库存含在途}；无配方/无研究返回 null */
  wantsOf(b) {
    const out = {};
    if (b.def.recipeBuilding) {
      if (!b.recipe) return null;
      if (!this.game.research.isRecipeUnlocked(b.recipe)) return null;
      const r = FG.Recipes.byId(b.recipe);
      for (const ing of r.ingredients) {
        if (!FG.Items.isFluid(ing.item)) out[ing.item] = ing.count * 2; // 约 2 轮份缓冲
      }
    } else if (b.type === 'lab') {
      const tech = this.game.research.current;
      if (!tech) return null;
      for (const pack of Object.keys(tech.cost)) out[pack] = 10; // 约 1 个消耗周期
    }
    return Object.keys(out).length ? out : null;
  }

  /** 校验并登记一件在途货物的预留标签 */
  scanTag(item) {
    const tag = item.tag;
    if (!tag) return;
    const c = this.consumerByKey.get(tag.c);
    if (!c || !c.want[tag.item] || this.tick - (tag.t0 || 0) > FG.Config.RESV_TTL) {
      delete item.tag; // 消费者已拆/换配方/预留超时：释放为自由货物
      return;
    }
    item._seen = true; // 已被本次 rebuild 统计，持货臂 swing 中途不重复/不漏算
    let m = this.transit.get(c.key);
    if (!m) { m = new Map(); this.transit.set(c.key, m); }
    m.set(tag.item, (m.get(tag.item) || 0) + 1);
  }

  /** 某消费者某物品当前缺口（≥0） */
  deficit(c, item) {
    const want = c.want[item] || 0;
    const slot = c.b.slots.inputs[item];
    const have = slot ? slot.count : 0;
    let enRoute = (this.transit.get(c.key) || new Map()).get(item) || 0;
    // rebuild 之后才抓货的持货臂，其货物尚未计入本 tick 在途，需即时修正，
    // 避免同一 swing 窗口内被重复拨付（在途预留联动，杜绝超量供给）
    enRoute += this.heldAfterScan(c.key, item);
    return Math.max(0, want - have - enRoute);
  }

  /**
   * 本 tick 即将送达该消费者的货物数：持货臂 timer 已到点且投放目标接受。
   * rebuild 发生在机械臂动作之前，需据此预判「在途货本 tick 就会入库」，
   * 避免同 tick 内低优先产线抢走本应继续供给高优先产线的自由料。
   */
  imminentArrivals(c, item) {
    let n = 0;
    for (const ins of this.sim.inserters) {
      const h = ins.held;
      if (!h || ins.timer > 1 || !h.tag || h.tag.c !== c.key || h.tag.item !== item) continue;
      if (this.armCanDropNow(ins, c, item)) n++;
    }
    return n;
  }

  /** 持货臂本 tick 是否能把货物投入目标（目标格为消费者本体且槽位未满） */
  armCanDropNow(ins, c, item) {
    const iv = FG.Utils.dirVec(ins.dir);
    const r = ins.def.range || 1;
    const tx = ins.x + iv.x * r, ty = ins.y + iv.y * r;
    if (tx !== c.b.x || ty !== c.b.y) return false;
    const slot = c.b.slots.inputs[item];
    return !!slot && slot.count < slot.cap;
  }

  /**
   * 仲裁用未满足需求：缺口 + 本 tick 即将到货的件数。
   * 高优先产线在「目标缓冲被填满（含即将到货）」之前，其料源不向低优先开放；
   * 一旦本 tick 到货后真实缺口重开，高优臂下一 swing 立即补料，低优仅在其真正吃饱后得料。
   */
  unmet(c, item) {
    const d = this.deficit(c, item);
    return d > 0 ? d + this.imminentArrivals(c, item) : 0;
  }

  /** rebuild 扫描之后才持货、且货物预留给该消费者的机械臂数量 */
  heldAfterScan(ck, item) {
    let n = 0;
    for (const ins of this.sim.inserters) {
      const h = ins.held;
      if (h && !h._seen && h.tag && h.tag.c === ck && h.tag.item === item) n++;
    }
    return n;
  }

  // ================= 自由物品预算（抓取源格） =================
  /** 抓取源格内各物品的「自由数量」（未被在途预留占用），惰性缓存 */
  freeAt(x, y) {
    const k = FG.Utils.key(x, y);
    if (this.freeCache.has(k)) return this.freeCache.get(k);
    const m = this.game.map;
    const free = new Map();
    const add = (type, n) => { if (type && n > 0) free.set(type, (free.get(type) || 0) + n); };
    const b = m.buildingAt(x, y);
    if (b) {
      if (b.def.beltTier !== undefined) {
        for (const it of b.items) if (!it.tag) add(it.type, 1);
      } else if (b.def.storage) {
        // 交付站货位归供货合同独立记账：已与生产/施工在共同料源处争过料，
        // 运抵交付站后不再作为按需物流的自由料源（避免被别的产线抢走）。
        if (!b.def.contractDock) {
          for (const s of b.chest) if (s.count > 0) add(s.type, s.count);
        }
      } else if (b.slots) {
        // 与 pickSource 一致：产物槽可取；输入槽仅取与当前配方无关的残留料
        const outs = b.slots.outputs;
        if (outs) for (const id of Object.keys(outs)) add(id, outs[id].count);
        const ins = b.slots.inputs;
        if (ins) {
          const r = b.recipe ? FG.Recipes.byId(b.recipe) : null;
          const needed = new Set(r ? r.ingredients.filter(i => !FG.Items.isFluid(i.item)).map(i => i.item) : []);
          for (const id of Object.keys(ins)) if (!needed.has(id)) add(id, ins[id].count);
        }
      }
    } else {
      const pile = m.pileAt(x, y);
      if (pile) for (const s of pile) add(s.type, s.count);
    }
    this.freeCache.set(k, free);
    return free;
  }

  /** 取走一件预算（返回是否成功） */
  spendFree(x, y, type) {
    const free = this.freeAt(x, y);
    const n = free.get(type) || 0;
    if (n <= 0) return false;
    free.set(type, n - 1);
    return true;
  }

  // ================= 优先级拨付（取货当 tick 即时 claim，不跨 tick 预批） =================
  /** 机械臂的抓取源格坐标 */
  armSource(ins) {
    const iv = FG.Utils.dirVec(ins.dir);
    const r = ins.def.range || 1;
    return { x: ins.x - iv.x * r, y: ins.y - iv.y * r };
  }

  /**
   * 源格级优先级仲裁：所有从同一源格取料的需求臂视为在争夺该源的自由料。
   * 返回 { globalMax, myMax }：
   *  globalMax = 该源各臂可达消费者中仍缺 item 的最高优先级
   *  myMax     = 仅本臂可达消费者中的最高优先级
   * 本臂够不到更高优先级竞争者时（myMax < globalMax）必须让出。
   */
  sourcePriorities(ins, item) {
    const src = this.armSource(ins);
    const ak = FG.Utils.key(src.x, src.y) + ':' + item;
    let globalMax = this._arbCache.get(ak);
    if (globalMax === undefined) {
      globalMax = 0;
      for (const other of this.sim.inserters) {
        if (!other.demandMode) continue;
        const os = this.armSource(other);
        if (os.x !== src.x || os.y !== src.y) continue;
        const tr = this.traceInserter(other);
        if (tr.terminal) continue;
        for (const ck of tr.items) {
          const c = this.consumerByKey.get(ck);
          if (c && this.unmet(c, item) > 0) globalMax = Math.max(globalMax, c.priority);
        }
      }
      this._arbCache.set(ak, globalMax);
    }
    let myMax = 0;
    const myTrace = this.traceInserter(ins);
    for (const ck of myTrace.items) {
      const c = this.consumerByKey.get(ck);
      if (c && this.unmet(c, item) > 0) myMax = Math.max(myMax, c.priority);
    }
    return { globalMax, myMax };
  }

  /**
   * 需求臂取货时原子申请：仲裁通过后，从本臂可达的最高优先级缺料消费者中按
   * 同级轮转选一个，扣减源格自由预算并返回消费者 key；不跨 tick 预批，无超卖/泄漏。
   */
  claim(ins, item) {
    const trace = this.traceInserter(ins);
    if (trace.terminal) return null;
    const src = this.armSource(ins);
    const free = this.freeAt(src.x, src.y);
    if ((free.get(item) || 0) <= 0) return null;

    const { globalMax, myMax } = this.sourcePriorities(ins, item);
    if (myMax < globalMax) return null; // 更高优先级产线（本臂够不到）仍缺料，让出

    // 本臂可达消费者中最高优先级的一层，同级按注册顺序轮转
    const tier = [];
    for (const ck of trace.items) {
      const c = this.consumerByKey.get(ck);
      if (c && c.priority === myMax && this.unmet(c, item) > 0) tier.push(c);
    }
    if (!tier.length) return null;
    const start = this.armSeq.get(item) || 0;
    const c = tier[start % tier.length];
    free.set(item, free.get(item) - 1);
    this.armSeq.set(item, (start + 1) % tier.length);
    return c.key;
  }

  // ================= 需求臂下游路由追踪 =================
  /**
   * 机械臂投放目的地向下游追踪：
   *  { terminal:true }  下游终端为箱子/地面堆（什么都收）
   *  { terminal:false, items:Set<消费者key> } 可达的消费者集合
   */
  traceInserter(ins) {
    const k = FG.Utils.key(ins.x, ins.y);
    if (this.traceCache.has(k)) return this.traceCache.get(k);
    const v = FG.Utils.dirVec(ins.dir);
    const r = ins.def.range || 1;
    const res = this.traceTile(ins.x + v.x * r, ins.y + v.y * r, new Set(), 0);
    this.traceCache.set(k, res);
    return res;
  }

  traceTile(x, y, seen, depth) {
    const m = this.game.map;
    if (!m.inBounds(x, y)) return { terminal: false, items: new Set() };
    const b = m.buildingAt(x, y);
    if (!b) {
      // 空格：地面堆视为终端（什么都收），否则死路
      return m.pileAt(x, y) ? { terminal: true, items: new Set() }
                            : { terminal: false, items: new Set() };
    }
    if (b.def.storage) return { terminal: true, items: new Set() };
    if (b.def.recipeBuilding || b.type === 'lab') {
      return { terminal: false, items: new Set([FG.Utils.key(b.x, b.y)]) };
    }
    if (b.def.beltTier === undefined) return { terminal: false, items: new Set() };
    return this.traceBelt(b, seen, depth);
  }

  /** 沿传送带 BFS：合流多入不必回溯，单带单出；侧入取料臂沿其投放方向继续 */
  traceBelt(belt, seen, depth) {
    if (depth >= FG.Config.BELT_TRACE_DEPTH || seen.size >= FG.Config.BELT_TRACE_NODES) {
      return { terminal: false, items: new Set() };
    }
    const bk = 'b' + FG.Utils.key(belt.x, belt.y);
    if (seen.has(bk)) return { terminal: false, items: new Set() };
    seen.add(bk);

    const items = new Set();
    let terminal = false;
    const merge = (res) => { if (res.terminal) terminal = true; else for (const id of res.items) items.add(id); };
    const m = this.game.map;

    // 从本带任意侧抓取的机械臂：追踪它们的投放去向
    for (const ins of this.sim.inserters) {
      const iv = FG.Utils.dirVec(ins.dir);
      const r = ins.def.range || 1;
      if (ins.x - iv.x * r === belt.x && ins.y - iv.y * r === belt.y) {
        const ik = 'i' + FG.Utils.key(ins.x, ins.y);
        if (seen.has(ik)) continue;
        seen.add(ik);
        merge(this.traceTile(ins.x + iv.x * r, ins.y + iv.y * r, seen, depth));
      }
    }

    // 带的正向延续
    const v = FG.Utils.dirVec(belt.dir);
    const nx = belt.x + v.x, ny = belt.y + v.y;
    const next = m.buildingAt(nx, ny);
    if (next && next.def.beltTier !== undefined && FG.Map.beltEntrySide(next, belt.x, belt.y) >= 0) {
      merge(this.traceBelt(next, seen, depth + 1));
    } else {
      merge(this.traceTile(nx, ny, seen, depth));
    }
    return { terminal, items };
  }

  // ================= 机械臂取/放查询接口 =================
  /** 需求臂当前允许抓取的物品集合（null=下游终端/无消费者，按筛选执行） */
  armWanted(ins) {
    let want = ins.filter ? new Set([ins.filter]) : null;
    if (!ins.demandMode) return want;
    const trace = this.traceInserter(ins);
    if (trace.terminal) return want; // 终端箱子/地面堆：什么都收
    if (!trace.items.size) return new Set(); // 死路：不抓
    const need = new Set();
    for (const ck of trace.items) {
      const c = this.consumerByKey.get(ck);
      if (!c) continue;
      for (const item of Object.keys(c.want)) {
        if (ins.filter && ins.filter !== item) continue;
        // 有未满足需求（含本 tick 即将到货的件），或该臂的在途预留货物正从面前经过（要继续送）
        if (this.unmet(c, item) > 0 || this.taggedInReach(ins, c.key, item)) need.add(item);
      }
    }
    return need;
  }

  /** 面前源格是否存在送往消费者 ck 的在途预留货物（抓取后沿当前臂可继续抵达） */
  taggedInReach(ins, ck, item) {
    const v = FG.Utils.dirVec(ins.dir);
    const r = ins.def.range || 1;
    const sx = ins.x - v.x * r, sy = ins.y - v.y * r;
    const b = this.game.map.buildingAt(sx, sy);
    if (b && b.def.beltTier !== undefined && r === 1) {
      for (const it of b.items) {
        if (it.tag && it.tag.c === ck && it.tag.item === item) return true;
      }
    }
    return false;
  }

  /** 自由货物类型是否在本臂可抓集合：通过源格优先级仲裁、且源格有自由料（不扣预算） */
  canTakeType(ins, item, fromTag) {
    if (!ins.demandMode) return true;
    if (fromTag) {
      const trace = this.traceInserter(ins);
      return !trace.terminal && trace.items.has(fromTag.c) && fromTag.item === item;
    }
    const trace = this.traceInserter(ins);
    if (trace.terminal) return false;
    const src = this.armSource(ins);
    if ((this.freeAt(src.x, src.y).get(item) || 0) <= 0) return false;
    const { globalMax, myMax } = this.sourcePriorities(ins, item);
    return myMax >= globalMax && myMax > 0;
  }

  /** 抓取成功后：返回货物应带的标签（无标签表示自由货物）。自由货物在此原子 claim 预算 */
  tagOnPickup(ins, item, oldTag) {
    if (!ins.demandMode) return null; // 非需求臂接手即剥离预留
    if (oldTag) return oldTag;        // 转运：延续原预留
    const target = this.claim(ins, item);
    return target ? { c: target, item, t0: this.tick } : null;
  }

  /** 需求臂放下时：目标是否接受该（可能带预留的）货物 */
  canDrop(ins, target, item, tag) {
    if (!ins.demandMode || !tag) return true; // 自由货物：目标槽能放就放
    if (target && target.def.beltTier !== undefined) return true; // 传送带：预留标签继续随货前行
    if (target && FG.Utils.key(target.x, target.y) === tag.c && tag.item === item) return true;
    return false; // 预留给别的消费者：不许放错（箱子/地面堆在抓货阶段即已排除）
  }
};
