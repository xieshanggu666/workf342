/**
 * FG.Pipelines —— 一键流水线预设
 *
 * 每个预设是一张「完整产线蓝图」：采集 → 运输（传送带/机械臂）→ 生产 → 入库，
 * 配方、机械臂朝向、筛选条件全部配好。选中后直接在地图上进入放置预览
 * （复用蓝图的旋转/逐格校验/施工计划/建材预留流程），左键一键提交整套工程。
 *
 * 条目结构与 FG.Blueprint 蓝图一致：
 *   { type, dx, dy, dir, recipe, filter, demandMode, priority, require }
 *   require.terrain: 'ore'（须为矿脉格，oreType 指定矿种）| 'water'（须临水域）| 'oil'（油田）
 *
 * 坐标约定：dx 向东、dy 向南；dir: 0=北 1=东 2=南 3=西。
 * 矿机必须落在矿脉上，因此含矿机的模板默认按当前朝向放置（R 可转，但需要重新对准资源）。
 */
FG.Pipelines = (() => {

  // 条目简写：E(type, dx, dy, dir, extra)
  const E = (type, dx, dy, dir, extra) => Object.assign({
    type, dx, dy, dir: dir || 0,
    recipe: null, filter: null, demandMode: false, priority: 'normal',
  }, extra || {});

  const PRESETS = [
    // ===================== 采集 → 冶炼 =====================
    // 冶炼模块通用布局（dx 向右、dy 向下；矿机须落在矿脉上）：
    //
    //              熔炉→臂→带→带→箱        y=0..2
    //                ↑
    //   矿机→臂→带→带→(转弯向北)          矿机在 y=3 矿脉上
    //
    {
      id: 'smeltIron',
      name: '铁矿冶炼线',
      icon: '⬜',
      desc: '矿机采铁矿石 → 传送带运输 → 机械臂装入石炉冶炼 → 铁板自动入箱。把矿机对准铁矿脉即可。',
      chain: '铁矿石 → 石炉 → 铁板',
      w: 7, h: 4,
      entries: [
        // 采集：矿机在矿脉上，机械臂向东把矿石送上带
        E('miner', 0, 3, 0, { require: { terrain: 'ore', oreType: 'ironOre' } }),
        E('inserter', 1, 3, 1),
        // 运输：矿带向东两格后转弯向北，到达熔炉西侧
        E('belt', 2, 3, 1),
        E('belt', 3, 3, 0),  // 转弯：物品从右侧汇入，沿北向出料
        E('belt', 3, 2, 0),
        E('belt', 3, 1, 0),
        // 熔炉：西侧机械臂向东把矿石装入
        E('inserter', 4, 1, 1),
        E('furnace', 5, 1, 0, { recipe: 'smelt:iron' }),
        // 产出：东侧机械臂取出铁板，经两节传送带送入成品箱
        E('inserter', 6, 1, 1),
        E('belt', 7, 1, 1),
        E('chest', 8, 1, 0),
      ],
    },

    {
      id: 'smeltCopper',
      name: '铜矿冶炼线',
      icon: '🟠',
      desc: '矿机采铜矿石 → 传送带运输 → 石炉冶炼 → 铜板自动入箱。把矿机对准铜矿脉。',
      chain: '铜矿石 → 石炉 → 铜板',
      w: 7, h: 4,
      entries: [
        E('miner', 0, 3, 0, { require: { terrain: 'ore', oreType: 'copperOre' } }),
        E('inserter', 1, 3, 1),
        E('belt', 2, 3, 1),
        E('belt', 3, 3, 0),  // 转弯：物品从右侧汇入，沿北向出料
        E('belt', 3, 2, 0),
        E('belt', 3, 1, 0),
        E('inserter', 4, 1, 1),
        E('furnace', 5, 1, 0, { recipe: 'smelt:copper' }),
        E('inserter', 6, 1, 1),
        E('belt', 7, 1, 1),
        E('chest', 8, 1, 0),
      ],
    },

    {
      id: 'quarryStone',
      name: '石料采集线',
      icon: '🪨',
      desc: '矿机采石 → 机械臂装传送带 → 石料入箱。石料是石炉等建筑的核心建材。',
      chain: '石料 → 传送带 → 箱子',
      w: 3, h: 1,
      entries: [
        E('miner', 0, 0, 0, { require: { terrain: 'ore', oreType: 'stone' } }),
        E('inserter', 1, 0, 1),
        E('belt', 2, 0, 1),
        E('chest', 3, 0, 0),
      ],
    },

    // ===================== 零件制造 =====================
    {
      id: 'craftGear',
      name: '齿轮生产线',
      icon: '⚙',
      desc: '铁板箱 → 机械臂按需供料 → 组装机造齿轮 → 成品入箱。紧凑无带，可直接贴在铁板产线旁。',
      chain: '铁板 → 组装机 → 齿轮',
      w: 3, h: 1,
      entries: [
        E('chest', 0, 0, 0),
        E('inserter', 1, 0, 1, { filter: 'ironPlate', demandMode: true }),
        E('assembler', 2, 0, 0, { recipe: 'craft:gear' }),
        E('inserter', 3, 0, 1),
        E('chest', 4, 0, 0),
      ],
    },

    {
      id: 'craftCircuit',
      name: '电路板生产线',
      icon: '🟩',
      desc: '铜板箱 → 组装机拉铜线并直接送入下一台组装机；铁板侧向供入，产出电路板入箱。需要科技「电子学」。',
      chain: '铜板 → 铜线 + 铁板 → 电路板',
      // 布局（5×5，竖直产线）：
      //   [铜板箱]
      //       ↓ 机械臂向南
      //   [铜线组装机]
      //       ↓ 铜线直供
      //   [铁板箱]→臂→[电路板组装机]→臂→[电路板箱]
      w: 3, h: 5,
      entries: [
        // 铜板箱 → 向南的供料臂 → 铜线组装机
        E('chest', 1, 0, 0),
        E('inserter', 1, 1, 2, { filter: 'copperPlate', demandMode: true }),
        E('assembler', 1, 2, 0, { recipe: 'craft:copperWire' }),
        // 铜线向南直供电路板组装机
        E('inserter', 1, 3, 2, { filter: 'copperWire', demandMode: true }),
        E('assembler', 1, 4, 0, { recipe: 'craft:circuit' }),
        // 铁板从西侧箱子向东供入
        E('inserter', 0, 4, 1, { filter: 'ironPlate', demandMode: true }),
        E('chest', -1, 4, 0),
        // 成品向东入箱
        E('inserter', 2, 4, 1),
        E('chest', 3, 4, 0),
      ],
    },

    // ===================== 科研 =====================
    {
      id: 'craftScience1',
      name: '自动化科学包线',
      icon: '🧪',
      desc: '齿轮 / 铁板 / 铜板 三个料箱环绕组装机，产出自动化科学包入箱。接上实验室即可开研。',
      chain: '齿轮+铁板+铜板 → 组装机 → 自动化科学包',
      // 布局（5×5）：组装机居中，齿轮(北)/铁板(西)/铜板(南) 三箱经机械臂喂入，成品向东入箱
      w: 3, h: 3,
      entries: [
        // 组装机居中
        E('assembler', 1, 1, 0, { recipe: 'craft:science1' }),
        // 北侧齿轮箱：臂向南喂入
        E('chest', 1, -1, 0),
        E('inserter', 1, 0, 2, { filter: 'gear', demandMode: true }),
        // 西侧铁板箱：臂向东喂入
        E('chest', -1, 1, 0),
        E('inserter', 0, 1, 1, { filter: 'ironPlate', demandMode: true }),
        // 南侧铜板箱：臂向北喂入
        E('chest', 1, 3, 0),
        E('inserter', 1, 2, 0, { filter: 'copperPlate', demandMode: true }),
        // 成品向东入箱
        E('inserter', 2, 1, 1),
        E('chest', 3, 1, 0),
      ],
    },

    {
      id: 'labRow',
      name: '实验室研究组',
      icon: '🔬',
      desc: '科学包料箱经传送带总线给 3 台实验室投喂（机械臂从带面取包）。开始研究后自动消耗科学包推进科技。',
      chain: '科学包 → 传送带总线 → 3 台实验室',
      // 布局（3×4）：
      //   [箱]→带→带→带
      //              ↓ ↓ ↓ （三台实验室北侧各一臂，从带取包）
      //           [实验室 ×3]
      w: 3, h: 4,
      entries: [
        E('chest', -1, 0, 0),
        E('inserter', 0, 0, 1),
        E('belt', 1, 0, 1),
        E('belt', 2, 0, 1),
        E('belt', 3, 0, 1),
        // 三台实验室，各自北侧机械臂（dir2 向南：从身后带面取包放入身前实验室）
        E('inserter', 1, 1, 2),
        E('inserter', 2, 1, 2),
        E('inserter', 3, 1, 2),
        E('lab', 1, 2, 0),
        E('lab', 2, 2, 0),
        E('lab', 3, 2, 0),
      ],
    },

    // ===================== 流体 =====================
    {
      id: 'waterSupply',
      name: '供水站',
      icon: '💧',
      desc: '水泵临水域放置，接出 3 段管道。供炼油厂/化工厂用水；管道液位自动均衡扩散。',
      chain: '水域 → 水泵 → 管道',
      w: 4, h: 1,
      entries: [
        E('pump', 0, 0, 1, { require: { terrain: 'water' } }),
        E('pipe', 1, 0, 0),
        E('pipe', 2, 0, 0),
        E('pipe', 3, 0, 0),
      ],
    },
  ];

  const list = () => PRESETS;
  const byId = (id) => PRESETS.find(p => p.id === id) || null;

  /** 归一化：把条目坐标平移到 (0,0) 起点并按包围盒重算 w/h（兼容负坐标） */
  function normalize(bp) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const e of bp.entries) {
      minX = Math.min(minX, e.dx); minY = Math.min(minY, e.dy);
      maxX = Math.max(maxX, e.dx); maxY = Math.max(maxY, e.dy);
    }
    return {
      w: maxX - minX + 1, h: maxY - minY + 1,
      fromPreset: bp.fromPreset || null,
      entries: bp.entries.map(e => {
        const ne = Object.assign({}, e, { dx: e.dx - minX, dy: e.dy - minY });
        if (e.require) ne.require = Object.assign({}, e.require);
        return ne;
      }),
    };
  }

  /** 复制一份预设蓝图（避免旋转结果污染原始定义） */
  function blueprintOf(preset) {
    return normalize({
      w: preset.w, h: preset.h,
      fromPreset: preset.id,
      entries: preset.entries.map(e => Object.assign({}, e, { require: e.require ? Object.assign({}, e.require) : undefined })),
    });
  }

  /** 该预设当前是否全部可用（建筑 + 配方科技均解锁） */
  function isAvailable(preset, game) {
    return lockedReasons(preset, game).length === 0;
  }

  /** 列出未解锁项（选择器置灰提示用） */
  function lockedReasons(preset, game) {
    const names = [];
    const seenB = new Set(), seenR = new Set();
    for (const e of preset.entries) {
      const def = FG.Buildings.byId(e.type);
      if (def.unlockedBy && !game.research.isBuildingUnlocked(e.type) && !seenB.has(e.type)) {
        seenB.add(e.type);
        names.push('建筑「' + def.name + '」');
      }
      if (e.recipe && !game.research.isRecipeUnlocked(e.recipe) && !seenR.has(e.recipe)) {
        seenR.add(e.recipe);
        names.push('配方「' + FG.Recipes.byId(e.recipe).name + '」');
      }
    }
    return names;
  }

  /**
   * 智能选位：以 (cx,cy) 为中心搜索首个整体可放置的原点。
   *  - 含矿机/水泵等资源约束的预设：直接枚举附近的矿脉/油田/水域邻格，速度快、落点准；
   *  - 普通预设：螺旋由内向外逐原点校验。
   * 找不到返回 null。maxR 为搜索半径（格）。
   */
  function findAnchor(game, bp, cx, cy, maxR) {
    maxR = maxR || 30;
    cx = Math.round(cx); cy = Math.round(cy);
    if (FG.Blueprint.validate(game, bp, cx, cy).ok) return { x: cx, y: cy };

    const anchors = resourceAnchorCandidates(game, bp, cx, cy, maxR);
    if (anchors.length) {
      // 按到搜索中心的距离排序，优先就近落点
      anchors.sort((p, q) =>
        (Math.abs(p.x - cx) + Math.abs(p.y - cy)) - (Math.abs(q.x - cx) + Math.abs(q.y - cy)));
      for (const a of anchors) {
        if (FG.Blueprint.validate(game, bp, a.x, a.y).ok) return a;
      }
    }

    // 回退：螺旋搜索
    for (let ring = 1; ring <= maxR; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const x = cx + dx, y = cy + dy;
          if (FG.Blueprint.validate(game, bp, x, y).ok) return { x, y };
        }
      }
    }
    return null;
  }

  /** 根据预设中的资源约束，枚举出可能的原点（矿脉格/油田格/水域四邻），不做整体校验 */
  function resourceAnchorCandidates(game, bp, cx, cy, maxR) {
    const reqs = bp.entries.filter(e => e.require);
    if (!reqs.length) return [];
    const out = [];
    const m = game.map;
    // 以第一个资源约束条目为锚（一条预设通常只有一个矿机/水泵）
    const e0 = reqs[0];
    if (e0.require.terrain === 'ore') {
      for (let y = Math.max(0, cy - maxR); y <= Math.min(m.h - 1, cy + maxR); y++) {
        for (let x = Math.max(0, cx - maxR); x <= Math.min(m.w - 1, cx + maxR); x++) {
          const ore = m.ores[y][x];
          if (ore && (!e0.require.oreType || ore.type === e0.require.oreType)) {
            out.push({ x: x - e0.dx, y: y - e0.dy });
          }
        }
      }
    } else if (e0.require.terrain === 'oil') {
      for (const k of m.oil) {
        const [x, y] = k.split(',').map(Number);
        if (Math.abs(x - cx) <= maxR && Math.abs(y - cy) <= maxR) out.push({ x: x - e0.dx, y: y - e0.dy });
      }
    } else if (e0.require.terrain === 'water') {
      // 水泵原点：任一片水域的四邻陆地格
      for (const k of m.water) {
        const [wx, wy] = k.split(',').map(Number);
        for (const v of FG.Utils.dirs) {
          const lx = wx + v.x, ly = wy + v.y;
          if (Math.abs(lx - cx) <= maxR && Math.abs(ly - cy) <= maxR
              && m.inBounds(lx, ly) && m.terrainAt(lx, ly) !== 'water') {
            out.push({ x: lx - e0.dx, y: ly - e0.dy });
          }
        }
      }
    }
    return out;
  }

  return { list, byId, blueprintOf, isAvailable, lockedReasons, findAnchor };
})();
