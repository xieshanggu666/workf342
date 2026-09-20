/**
 * FG.Map —— 网格地图：地形、矿脉、水域、油田、建筑注册表、地面物料堆
 */
FG.Map = class {
  constructor(w, h, terrain, ores, water, oil) {
    this.w = w;
    this.h = h;
    this.terrain = terrain;        // 2D: 'grass'|'sand'|'stone'|'water'
    this.ores = ores;              // 2D: {type, amount} | null
    this.water = water;            // Set 'x,y'
    this.oil = oil;                // Set 'x,y'
    this.buildings = new Map();    // key 'x,y' -> building
    this.piles = new Map();        // key 'x,y' -> [{type,count}] 地面物料堆
  }

  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  terrainAt(x, y) { return this.inBounds(x, y) ? this.terrain[y][x] : null; }
  isWater(x, y) { return this.water.has(FG.Utils.key(x, y)); }
  isOil(x, y) { return this.oil.has(FG.Utils.key(x, y)); }
  oreAt(x, y) { return this.inBounds(x, y) && this.ores[y][x] ? this.ores[y][x].type : null; }
  amountAt(x, y) { return this.inBounds(x, y) && this.ores[y][x] ? this.ores[y][x].amount : 0; }

  buildingAt(x, y) { return this.buildings.get(FG.Utils.key(x, y)) || null; }
  isOccupied(x, y) { return this.buildings.has(FG.Utils.key(x, y)); }
  pileAt(x, y) { return this.piles.get(FG.Utils.key(x, y)) || null; }

  register(b) { this.buildings.set(FG.Utils.key(b.x, b.y), b); }
  unregister(b) { this.buildings.delete(FG.Utils.key(b.x, b.y)); }

  // ================= 地面物料堆 =================
  /** 向地面堆加入 n 个物品，返回未能放下的数量 */
  pileAdd(x, y, type, n) {
    if (n <= 0) return 0;
    const k = FG.Utils.key(x, y);
    let pile = this.piles.get(k);
    if (!pile) { pile = []; this.piles.set(k, pile); }
    const cap = FG.Config.GROUND_PILE_CAP;
    let slot = pile.find(s => s.type === type);
    if (slot) {
      const put = Math.min(n, cap - slot.count);
      slot.count += put; n -= put;
    } else if (n > 0) {
      const put = Math.min(n, cap);
      pile.push({ type, count: put });
      n -= put;
    }
    return n;
  }

  /** 从地面堆取走 1 个指定类型（不传类型则取任意），返回物品类型或 null */
  pileTake(x, y, wanted) {
    const pile = this.piles.get(FG.Utils.key(x, y));
    if (!pile || !pile.length) return null;
    const i = wanted ? pile.findIndex(s => s.type === wanted && s.count > 0)
                     : pile.findIndex(s => s.count > 0);
    if (i < 0) return null;
    const type = pile[i].type;
    if (--pile[i].count <= 0) pile.splice(i, 1);
    if (!pile.length) this.piles.delete(FG.Utils.key(x, y));
    return type;
  }

  pileCount(x, y, wanted) {
    const pile = this.piles.get(FG.Utils.key(x, y));
    if (!pile) return 0;
    return pile.reduce((n, s) => n + (!wanted || s.type === wanted ? s.count : 0), 0);
  }

  /** 创建建筑运行时对象（含各类型默认字段） */
  static create(type, x, y, dir) {
    const def = FG.Buildings.byId(type);
    const b = {
      def, type, x, y,
      dir: dir || 0,
      status: 'idle',
      // 生产类
      recipe: null,
      progress: 0,
      slots: { inputs: {}, outputs: {} },
      fluidTanks: {},          // 流体缓存罐
      // 传送带：items=[{type,pos,from}]，from 记录进料侧（0背/2左/3右）
      items: [],
      rr: 0,                   // 合流轮转游标（多路汇入公平性）
      // 机械臂
      held: null,
      phase: 'rest',
      timer: 4,
      filter: null,            // 筛选物品类型（null=不限）
      demandMode: false,       // true=仅在下游缺料时取放
      priority: 'normal',      // 生产线供料优先级（消费者）：low|normal|high
      // 管道
      level: 0,
      fluidType: null,
      // 箱子
      chest: [],
      // 矿机
      oreType: null,
      // 实验室
      consumeCounter: 0,
      // 火车站（storage 已在下方建 chest 货位）
      stationId: null,
      stationName: null,
      // 统计
      totalCrafted: 0,
      craftedByItem: {},    // 按产物分项的累计完成次数（试产闸门按产物归属统计，切配方不串计）
    };
    if (def.storage) {
      for (let i = 0; i < FG.Config.CHEST_SLOTS; i++) b.chest.push({ type: null, count: 0, cap: FG.Config.CHEST_SLOT_CAP });
    }
    if (def.recipeBuilding) {
      const recipes = FG.Recipes.forBuilding(type);
      if (recipes.length) { b.recipe = recipes[0].id; FG.Map.syncRecipeSlots(b); }
    }
    if (def.science) {
      ['science1', 'science2', 'science3'].forEach(s => {
        b.slots.inputs[s] = { count: 0, cap: 50 };
      });
    }
    return b;
  }

  /** 根据当前配方预创建输入/输出槽位（无则补建；已有槽位物料保留） */
  static syncRecipeSlots(b) {
    const r = b.recipe ? FG.Recipes.byId(b.recipe) : null;
    if (!r) return;
    for (const ing of r.ingredients) {
      if (!FG.Items.isFluid(ing.item) && !b.slots.inputs[ing.item]) {
        b.slots.inputs[ing.item] = { count: 0, cap: FG.Config.SLOT_CAP };
      }
    }
    for (const out of r.results) {
      if (!FG.Items.isFluid(out.item) && !b.slots.outputs[out.item]) {
        b.slots.outputs[out.item] = { count: 0, cap: FG.Config.SLOT_CAP };
      }
    }
  }

  // ================= 传送带几何 =================
  // 方向：0=北 1=东 2=南 3=西；物品沿「进料边中点 → 出料边中点」运动
  // 直行带路径长 1；侧入（转弯）为折线，路径长归一化为 1
  // side 编码：0=背后直入，2=左转侧入，3=右转侧入（相对带方向的旋转量）
  /** 某进料侧所在格子的方向向量（0=背后 2=左侧 3=右侧） */
  static beltSideVec(dir, side) {
    if (side === 0) return FG.Utils.dirVec((dir + 2) % 4);
    if (side === 2) return FG.Utils.dirVec((dir + 3) % 4); // 左
    return FG.Utils.dirVec((dir + 1) % 4);                 // 右
  }

  /** 某建筑从哪个侧边进入 belt（0=背后直入 2=左侧 3=右侧），不能进入返回 -1 */
  static beltEntrySide(belt, fromX, fromY) {
    const d = belt.dir;
    for (const side of [0, 2, 3]) {
      const sv = FG.Map.beltSideVec(d, side);
      if (belt.x + sv.x === fromX && belt.y + sv.y === fromY) return side;
    }
    return -1; // 正面顶头不可汇入
  }

  /** 进料侧对应的路径折线（格子本地坐标，中心为 0.5,0.5）：2 个点 */
  static beltPath(belt, from) {
    const d = belt.dir;
    const f = FG.Utils.dirVec(d);
    const end = { x: 0.5 + f.x * 0.5, y: 0.5 + f.y * 0.5 };
    if (!from) return [{ x: 0.5 - f.x * 0.5, y: 0.5 - f.y * 0.5 }, end];
    const sv = FG.Map.beltSideVec(d, from);
    return [{ x: 0.5 + sv.x * 0.5, y: 0.5 + sv.y * 0.5 }, end];
  }

  /** 物品在路径上的本地坐标（pos 0→1） */
  static beltPoint(belt, item) {
    const pts = FG.Map.beltPath(belt, item.from || 0);
    // 折线两段各占 0.5 进度
    if (item.pos < 0.5) {
      const t = item.pos * 2;
      return { x: pts[0].x + (0.5 - pts[0].x) * t, y: pts[0].y + (0.5 - pts[0].y) * t };
    }
    const t = (item.pos - 0.5) * 2;
    return { x: 0.5 + (pts[1].x - 0.5) * t, y: 0.5 + (pts[1].y - 0.5) * t };
  }

  /** 路径上某位置到格子某侧边中点的沿带距离（用于抓取点选择，近似折线弧长） */
  static beltPointToEdgeDist(belt, item, sideDir) {
    const p = FG.Map.beltPoint(belt, item);
    const ev = FG.Utils.dirVec(sideDir);
    const ex = 0.5 + ev.x * 0.5, ey = 0.5 + ev.y * 0.5;
    return Math.hypot(p.x - ex, p.y - ey);
  }

  /** src 带是否会把物品喂入 dst 带（方向/位置允许汇入） */
  static beltFeedsInto(src, dst) {
    const v = FG.Utils.dirVec(src.dir);
    if (src.x + v.x !== dst.x || src.y + v.y !== dst.y) return false;
    return FG.Map.beltEntrySide(dst, src.x, src.y) >= 0;
  }
};
