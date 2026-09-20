/**
 * FG.Game —— 游戏主类：状态、建筑放置、主循环、存档序列化、消息
 */
FG.Game = class Game {
  constructor() {
    this.state = 'menu';          // 'menu' | 'playing'
    this.map = null;
    this.sim = null;
    this.stats = new FG.Stats();
    this.research = new FG.ResearchMgr(this);
    this.railway = new FG.Railway(this);   // 铁路货运：轨网/列车/调度状态
    this.speed = 1;
    this.paused = false;
    this.tickCount = 0;
    this.playTime = 0;            // 仿真秒
    this.simAcc = 0;
    this.autosaveTimer = 0;
    this.camera = { x: 0, y: 0, zoom: 1 };
    this.selection = null;        // 选中的建筑
    this.ghost = null;            // {type, dir}
    this.showStatus = false;      // 状态高亮开关
    // 蓝图施工
    this.construction = new FG.Construction(this); // 施工计划管理器
    this.bpMode = null;           // 蓝图模式：null | 'select'(框选) | 'place'(放置预览)
    this.blueprint = null;        // 当前蓝图（剪贴板）：{w,h,entries}
    this.bpSelect = null;         // 框选拖拽矩形 {x0,y0,x1,y1}
    this.pipelineId = null;       // 当前蓝图来自哪个一键流水线预设（null=普通框选蓝图）
    this.bpAnchor = null;         // 一键流水线智能选位原点（F 重新搜索；null=跟随鼠标）
    // 原地升级
    this.upMode = null;           // 升级模式：null | 'select'(框选) | 'confirm'(预览待确认)
    this.upSelect = null;         // 升级框选拖拽矩形 {x0,y0,x1,y1}
    this.upPreview = null;        // 待确认升级预览 {entries:[{from,to,x,y,dir}], cost:{item:n}}
    this.log = [];
    this.saveInfo = { slot: null, name: '', startDate: Date.now() };
    this.mapInfo = { presetId: 'greenfield', sizeId: 'medium', seed: 1, biome: 'grass' };
  }

  // ================= 开始 / 载入 =================
  newGame(presetId, sizeId, seed, slot, name) {
    const preset = FG.Maps.getPreset(presetId);
    const gen = FG.Maps.generate(preset, seed, sizeId);
    this.startWithMap(gen, slot, name);
    this.logMsg('新游戏开始：' + preset.name, 'info');
    this.logMsg('提示：从矿脉开采矿石 → 熔炉冶炼 → 组装机加工', 'info');
  }

  startWithMap(gen, slot, name) {
    this.map = new FG.Map(gen.w, gen.h, gen.terrain, gen.ores, gen.water, gen.oil);
    // 恢复地面物料堆（拆除保留的在途/库存物料）
    for (const p of (gen.piles || [])) {
      for (const s of p.items) this.map.pileAdd(p.x, p.y, s.type, s.count);
    }
    this.sim = new FG.Sim();
    this.sim.init(this);
    this.stats = new FG.Stats();
    this.research = new FG.ResearchMgr(this);
    this.railway = new FG.Railway(this);
    this.tickCount = 0;
    this.playTime = 0;
    this.simAcc = 0;
    this.autosaveTimer = 0;
    this.selection = null;
    this.ghost = null;
    this.construction = new FG.Construction(this);
    this.bpMode = null;
    this.blueprint = null;
    this.bpSelect = null;
    this.pipelineId = null;
    this.bpAnchor = null;
    this.upMode = null;
    this.upSelect = null;
    this.upPreview = null;
    this.saveInfo = { slot: slot || null, name: name || '未命名工厂', startDate: Date.now() };
    this.mapInfo = {
      presetId: gen.presetId, sizeId: gen.sizeId || 'medium',
      seed: gen.seed || 1, biome: gen.biome,
    };
    this.log = [];
    this.state = 'playing';
    // 居中相机
    const cw = window.innerWidth, ch = window.innerHeight;
    this.camera.x = gen.w / 2 - cw / 2 / FG.Config.TILE;
    this.camera.y = gen.h / 2 - ch / 2 / FG.Config.TILE;
    this.camera.zoom = 1;
    FG.Events.emit('game:start');
  }

  // ================= 存档 =================
  serialize() {
    const cleanTag = (t) => t ? { c: t.c, item: t.item, t0: t.t0 || 0 } : undefined;
    const blds = [];
    for (const b of this.map.buildings.values()) {
      blds.push({
        type: b.type, x: b.x, y: b.y, dir: b.dir, recipe: b.recipe,
        progress: b.progress, slots: b.slots, fluidTanks: b.fluidTanks,
        items: b.items.map(it => {
          const ni = { type: it.type, pos: it.pos, from: it.from };
          if (it.tag) ni.tag = cleanTag(it.tag);
          return ni;
        }),
        held: b.held ? { type: b.held.type, tag: cleanTag(b.held.tag) } : null,
        phase: b.phase, timer: b.timer,
        level: b.level, fluidType: b.fluidType, chest: b.chest, oreType: b.oreType,
        consumeCounter: b.consumeCounter, totalCrafted: b.totalCrafted,
        craftedByItem: b.craftedByItem && Object.keys(b.craftedByItem).length
          ? Object.assign({}, b.craftedByItem) : undefined,
        rr: b.rr, filter: b.filter, demandMode: b.demandMode,
        priority: b.priority, status: b.status,
        stationId: b.stationId || null, stationName: b.stationName || null,
      });
    }
    const ores = this.map.ores.map(row => row.map(c => c ? { type: c.type, amount: c.amount } : null));
    const piles = [];
    for (const [k, pile] of this.map.piles) {
      const [x, y] = k.split(',').map(Number);
      piles.push({ x, y, items: pile.map(s => ({ type: s.type, count: s.count })) });
    }
    return {
      v: FG.Config.VERSION,
      map: {
        presetId: this.mapInfo.presetId, biome: this.mapInfo.biome,
        w: this.map.w, h: this.map.h, seed: this.mapInfo.seed, sizeId: this.mapInfo.sizeId,
        terrain: this.map.terrain, ores,
        water: Array.from(this.map.water), oil: Array.from(this.map.oil),
        piles,
      },
      buildings: blds,
      research: {
        completed: Array.from(this.research.completed),
        current: this.research.current ? this.research.current.id : null,
        points: this.research.points,
      },
      totals: this.stats.totals,
      construction: this.construction.serialize(),   // 施工计划（进度随存档恢复）
      blueprint: this.blueprint,                     // 蓝图剪贴板
      railway: this.railway.serialize(),             // 列车/运输计划/调度状态（含在途货物）
      meta: { playTime: this.playTime, name: this.saveInfo.name, startDate: this.saveInfo.startDate },
    };
  }

  deserialize(data) {
    const m = data.map;
    const gen = {
      presetId: m.presetId, biome: m.biome, w: m.w, h: m.h, seed: m.seed, sizeId: m.sizeId,
      terrain: m.terrain,
      ores: m.ores.map(row => row.map(c => c ? { type: c.type, amount: c.amount } : null)),
      water: new Set(m.water), oil: new Set(m.oil),
      piles: m.piles || [],
    };
    this.startWithMap(gen, data._slot || null, (data.meta && data.meta.name) || '存档');
    this.playTime = (data.meta && data.meta.playTime) || 0;
    this.saveInfo.startDate = (data.meta && data.meta.startDate) || Date.now();

    for (const sb of data.buildings) {
      const b = FG.Map.create(sb.type, sb.x, sb.y, sb.dir || 0);
      if (sb.recipe !== undefined) b.recipe = sb.recipe;
      b.progress = sb.progress || 0;
      b.slots = sb.slots || { inputs: {}, outputs: {} };
      b.fluidTanks = sb.fluidTanks || {};
      b.items = (sb.items || []).map(it => {
        const ni = { type: it.type, pos: it.pos, from: it.from || 0 };
        if (it.tag) ni.tag = { c: it.tag.c, item: it.tag.item, t0: it.tag.t0 || 0 }; // 在途预留
        return ni;
      });
      b.held = sb.held ? {
        type: sb.held.type,
        tag: sb.held.tag ? { c: sb.held.tag.c, item: sb.held.tag.item, t0: sb.held.tag.t0 || 0 } : null,
      } : null;
      b.phase = sb.phase || 'rest';
      b.timer = sb.timer || 4;
      b.level = sb.level || 0;
      b.fluidType = sb.fluidType || null;
      b.chest = sb.chest || [];
      b.oreType = sb.oreType || null;
      b.consumeCounter = sb.consumeCounter || 0;
      b.totalCrafted = sb.totalCrafted || 0;
      // 按产物分项的完成次数：旧档无此字段 → {}（历史产量无产物归属，试产基线迁移时不计入）
      b.craftedByItem = sb.craftedByItem && typeof sb.craftedByItem === 'object'
        ? Object.assign({}, sb.craftedByItem) : {};
      b.rr = sb.rr || 0;
      b.filter = sb.filter || null;
      b.demandMode = !!sb.demandMode;
      b.priority = FG.Config.PRIORITIES[sb.priority] ? sb.priority : 'normal'; // 旧存档默认普通
      b.status = sb.status || 'idle';
      b.stationId = sb.stationId || null;
      b.stationName = sb.stationName || null;
      // 旧存档箱子槽位补齐
      if (b.def.storage) {
        while (b.chest.length < FG.Config.CHEST_SLOTS) b.chest.push({ type: null, count: 0, cap: FG.Config.CHEST_SLOT_CAP });
      }
      // 旧存档实验室输入槽补齐
      if (b.def.science) {
        for (const s of ['science1', 'science2', 'science3']) {
          if (!b.slots.inputs[s]) b.slots.inputs[s] = { count: 0, cap: 50 };
        }
      }
      this.map.register(b);
      this.sim.register(b);
    }

    if (data.research) {
      this.research.completed = new Set(data.research.completed || []);
      this.research.points = data.research.points || {};
      if (data.research.current) this.research.current = FG.Research.byId(data.research.current);
    }
    if (data.totals) {
      this.stats.totals = data.totals;
      for (const id of Object.keys(data.totals)) this.stats.recordProduce(id, 0); // 登记 itemIds
    }
    // 施工计划与蓝图剪贴板（旧存档无此字段 → 空计划/空剪贴板）
    this.construction.deserialize(data.construction || null, data.v);
    this.blueprint = data.blueprint || null;
    // 铁路：列车在途货物与调度状态随档恢复（占用表由列车位置重建）
    this.railway.deserialize(data.railway || null);
    // 读回的一键流水线蓝图恢复来源标记（bpMode 不持久化，需重新进入放置预览）
    this.pipelineId = (this.blueprint && this.blueprint.fromPreset) || null;
    this.logMsg('存档已载入', 'info');
    FG.Events.emit('game:start');
  }

  saveTo(slot, name) {
    if (name) this.saveInfo.name = name;
    this.saveInfo.slot = slot;
    const data = this.serialize();
    data._slot = slot;
    const ok = FG.Save.saveToSlot(slot, {
      name: this.saveInfo.name, playTime: this.playTime,
      date: new Date().toLocaleString('zh-CN'),
    }, data);
    if (ok) this.logMsg('已保存到槽位 ' + slot + '：' + this.saveInfo.name, 'info');
    return ok;
  }

  loadSlot(slot) {
    const obj = FG.Save.loadSlot(slot);
    if (!obj) { this.logMsg('槽位 ' + slot + ' 无存档', 'error'); return false; }
    obj.data._slot = slot;
    this.deserialize(obj.data);
    this.saveInfo.slot = slot;
    this.saveInfo.name = (obj.meta && obj.meta.name) || '存档';
    return true;
  }

  // ================= 主循环 =================
  update(dt) {
    if (this.state !== 'playing' || this.paused) return;
    const tickLen = 1 / FG.Config.TPS;
    this.simAcc += dt * this.speed;
    let guard = 0;
    while (this.simAcc >= tickLen && guard++ < 500) {
      this.simAcc -= tickLen;
      this.tickOnce();
    }
    // 推进仿真秒
    const prev = Math.floor(this.playTime);
    this.playTime += dt * this.speed;
    if (Math.floor(this.playTime) > prev) {
      this.stats.onSecond();
      // 自动存档
      this.autosaveTimer += dt * this.speed;
      if (this.autosaveTimer >= FG.Config.AUTOSAVE_SEC) {
        this.autosaveTimer = 0;
        this.saveTo('auto', null);
      }
    }
    FG.Events.emit('sim:tick');
  }

  tickOnce() {
    this.sim.tick();
    this.construction.tick();   // 施工计划：备料 → 落成
    this.railway.tick();        // 铁路：区间占用 → 行驶 → 停站装卸
    this.tickCount++;
  }

  // ================= 建筑放置 =================
  setGhost(type) {
    if (!this.research.isBuildingUnlocked(type)) return;
    this.exitUpgradeMode();
    this.ghost = { type, dir: 0 };
    this.selection = null;
    FG.Events.emit('ghost:change');
  }
  rotateGhost() {
    if (!this.ghost) return;
    this.ghost.dir = (this.ghost.dir + 1) % 4;
    FG.Events.emit('ghost:change');
  }
  cancelGhost() {
    this.ghost = null;
    FG.Events.emit('ghost:change');
  }

  canPlace(type, x, y) {
    const def = FG.Buildings.byId(type);
    if (!this.map.inBounds(x, y)) return false;
    if (this.map.isOccupied(x, y)) return false;
    const terr = this.map.terrainAt(x, y);
    if (terr === 'water') return false;   // 建筑一律不能落在水面
    if (def.onTerrain === 'ore') return this.map.oreAt(x, y) !== null;
    if (def.onTerrain === 'water') return this.adjacentWater(x, y); // 水泵：陆地且临水域
    if (def.onTerrain === 'oil') return this.map.isOil(x, y);
    // 火车站 / 机务段：陆地非占格，且至少一侧紧邻轨道
    if (def.railStation || def.railDepot) return this.adjacentRail(x, y) !== null;
    return true;
  }

  /** 该格四邻的轨道格（火车站/机务段须接轨；返回相邻轨格或 null） */
  adjacentRail(x, y) {
    for (const v of FG.Utils.dirs) {
      const nx = x + v.x, ny = y + v.y;
      const b = this.map.buildingAt(nx, ny);
      if (b && (b.type === 'rail' || b.def.railStation)) return b;
    }
    return null;
  }

  /** 该格四邻是否有水域（水泵/供水预设校验用） */
  adjacentWater(x, y) {
    for (const v of FG.Utils.dirs) {
      const nx = x + v.x, ny = y + v.y;
      if (this.map.isWater(nx, ny)) return true;
    }
    return false;
  }

  placeGhost(x, y) {
    if (!this.ghost) return false;
    if (!this.canPlace(this.ghost.type, x, y)) return false;
    const b = FG.Map.create(this.ghost.type, x, y, this.ghost.dir);
    if (b.type === 'miner') b.oreType = this.map.oreAt(x, y);
    if (b.def.railStation) {
      b.stationId = 'S' + (this.railway.stationSeq++);
      b.stationName = '站点 ' + b.stationId.slice(1);
    }
    this.map.register(b);
    this.sim.register(b);
    // 轨网变更（轨道/车站接入）→ 下一 tick 重建路网图并重寻路
    if (b.type === 'rail' || b.def.railStation) this.railway.markDirty();
    // 若该格有拆除时遗留的地面物料，优先回收进新建筑（在途物品不丢失）
    this.absorbPile(b);
    FG.Events.emit('building:placed', b);
    return true;
  }

  /** 放置建筑时吸收同格地面堆，吸不完的继续留在地面 */
  absorbPile(b) {
    const pile = this.map.pileAt(b.x, b.y);
    if (!pile) return;
    for (let i = pile.length - 1; i >= 0; i--) {
      const s = pile[i];
      let left = s.count;
      if (b.def.beltTier !== undefined) {
        const SP = 1 / FG.Config.BELT_CAP;
        while (left > 0 && b.items.length < FG.Config.BELT_CAP) {
          b.items.unshift({ type: s.type, pos: 0, from: 0 });
          left--;
        }
        // 进料物品按间距排开，避免叠在入口
        b.items.sort((a, c) => a.pos - c.pos);
        for (let k = b.items.length - 2; k >= 0; k--) b.items[k].pos = Math.min(b.items[k].pos, b.items[k + 1].pos - SP);
      } else if (b.def.storage) {
        left = this.tryChestAdd(b, s.type, left);
      } else if (b.slots) {
        FG.Map.syncRecipeSlots(b);
        const ins = b.slots.inputs[s.type];
        if (ins) { const put = Math.min(left, ins.cap - ins.count); ins.count += put; left -= put; }
        const out = b.slots.outputs[s.type];
        if (out && left > 0) { const put = Math.min(left, out.cap - out.count); out.count += put; left -= put; }
      }
      s.count = left;
      if (s.count <= 0) pile.splice(i, 1);
    }
    if (!pile.length) this.map.piles.delete(FG.Utils.key(b.x, b.y));
  }

  tryChestAdd(chest, type, n) {
    for (const slot of chest.chest) {
      if (slot.type === type && slot.count < slot.cap) {
        const put = Math.min(n, slot.cap - slot.count);
        slot.count += put; n -= put;
      }
    }
    for (const slot of chest.chest) {
      if (n <= 0) break;
      if (slot.count === 0) {
        const put = Math.min(n, slot.cap);
        slot.type = type; slot.count = put; n -= put;
      }
    }
    return n;
  }

  removeBuilding(b) {
    // 铁路保护：列车正占用的轨道/车站格不允许拆除（避免脱轨与存档不一致）
    if (this.railway && (b.type === 'rail' || b.def.railStation)) {
      const tid = this.railway.occupiedBy(b.x, b.y);
      if (tid) {
        this.logMsg('⚠ 无法拆除：' + tid + ' 号列车正占用该格，请先让列车驶离或解编该列车', 'error');
        return false;
      }
    }
    // 物料保留：传送带上的在途物品、手中物品、槽位与箱子物料全部落到该格地面堆
    // 拆建即释放预留：落地前剥离在途预留标签，物料恢复为自由货物可被任何产线取用
    if (b.items) for (const it of b.items) this.map.pileAdd(b.x, b.y, it.type, 1);
    if (b.held) this.map.pileAdd(b.x, b.y, b.held.type, 1);
    if (b.chest) for (const s of b.chest) if (s.count > 0) this.map.pileAdd(b.x, b.y, s.type, s.count);
    if (b.slots) {
      for (const k of Object.keys(b.slots.inputs)) if (b.slots.inputs[k].count > 0) this.map.pileAdd(b.x, b.y, k, b.slots.inputs[k].count);
      for (const k of Object.keys(b.slots.outputs)) if (b.slots.outputs[k].count > 0) this.map.pileAdd(b.x, b.y, k, b.slots.outputs[k].count);
    }
    this.sim.unregister(b);
    this.map.unregister(b);
    if (b.type === 'rail' || b.def.railStation) this.railway.markDirty();
    if (this.selection === b) this.selection = null;
    FG.Events.emit('building:removed', b);
    return true;
  }

  setRecipe(b, rid) {
    b.recipe = rid || null;
    b.progress = 0;
    // 物料保留：不再需要的输入/输出槽不删除，残留物料可继续被机械臂运走；
    // 指向旧配方物品的在途预留标签由调度器在下一 tick 自动剥离（释放给其他产线）
    FG.Map.syncRecipeSlots(b);
    FG.Events.emit('recipe:change', b);
  }

  selectBuilding(b) { this.selection = b; FG.Events.emit('selection:change', b); }

  /** 解编当前选中的列车（车载货物落到其所在格地面堆，避免丢失） */
  removeTrainSelection() {
    const tr = this.selection;
    if (!tr || !tr.isTrain) return;
    for (const s of tr.cargo) this.map.pileAdd(tr.x, tr.y, s.type, s.count);
    this.railway.removeTrain(tr);
    this.selection = null;
    this.logMsg('已解编列车 ' + tr.id + '：车上 ' + tr.cargoTotal() + ' 件货物已落到地面堆', 'info');
    FG.Events.emit('selection:change');
  }

  // ================= 蓝图施工 =================
  /** 切换蓝图模式：无 → 有剪贴板则放置、否则框选；放置 → 框选；框选 → 退出 */
  toggleBlueprintMode() {
    if (this.state !== 'playing') return;
    if (!this.bpMode) {
      this.cancelGhost();
      this.exitUpgradeMode();
      this.selection = null;
      FG.Events.emit('selection:change');
      this.bpMode = this.blueprint ? 'place' : 'select';
    } else if (this.bpMode === 'place') {
      this.bpMode = 'select';   // 已有蓝图时按 B 可重新框选
    } else {
      this.bpMode = null;
    }
    this.bpSelect = null;
    FG.Events.emit('blueprint:mode', this.bpMode);
  }

  exitBlueprintMode() {
    if (!this.bpMode) return;
    this.bpMode = null;
    this.bpSelect = null;
    this.pipelineId = null;
    this.bpAnchor = null;
    FG.Events.emit('blueprint:mode', null);
  }

  /** 框选产线生成蓝图（剪贴板），成功后进入放置预览模式 */
  captureBlueprint(x0, y0, x1, y1) {
    const w = Math.abs(x1 - x0) + 1, h = Math.abs(y1 - y0) + 1;
    if (w * h > FG.Config.BP_MAX_AREA) {
      this.logMsg('框选区域过大（' + w + '×' + h + '），上限 ' + FG.Config.BP_MAX_AREA + ' 格', 'error');
      return 0;
    }
    const bp = FG.Blueprint.capture(this.map, x0, y0, x1, y1);
    if (!bp.entries.length) {
      this.logMsg('框选区域内没有建筑', 'error');
      return 0;
    }
    this.blueprint = bp;
    this.pipelineId = null;
    this.bpAnchor = null;
    this.bpMode = 'place';
    this.logMsg('📐 蓝图已生成：' + bp.entries.length + ' 栋建筑（' + bp.w + '×' + bp.h
      + '）—— 移动预览，R 旋转，左键提交施工，Esc 退出', 'info');
    FG.Events.emit('blueprint:change');
    FG.Events.emit('blueprint:mode', 'place');
    return bp.entries.length;
  }

  /** 旋转预览：蓝图顺时针转 90°（旋转后智能选位失效，回到鼠标跟随） */
  rotateBlueprint() {
    if (!this.blueprint) return;
    this.blueprint = FG.Blueprint.rotate(this.blueprint);
    this.bpAnchor = null;
    FG.Events.emit('blueprint:change');
  }

  // ================= 一键流水线 =================
  /**
   * 选择一套预设流水线：载入为蓝图并直接进入放置预览。
   * @param preset 预设 id 或预设对象
   * @param atTile 智能选位的搜索中心（缺省用鼠标所在格）
   */
  startPipeline(preset, atTile) {
    if (this.state !== 'playing') return false;
    if (typeof preset === 'string') preset = FG.Pipelines.byId(preset);
    if (!preset) return false;
    const bp = FG.Pipelines.blueprintOf(preset);
    // 以鼠标格（或屏幕中心格）为起点智能搜索可放置原点
    const c = atTile || this._lastMouseTile || {
      x: Math.floor(this.camera.x + window.innerWidth / 2 / FG.Config.TILE),
      y: Math.floor(this.camera.y + window.innerHeight / 2 / FG.Config.TILE),
    };
    const anchor = FG.Pipelines.findAnchor(this, bp, c.x, c.y, FG.Config.PIPELINE_SEARCH_RADIUS);
    this.blueprint = bp;
    this.pipelineId = preset.id;
    this.bpAnchor = anchor;   // 找不到则 null：预览跟随鼠标，逐格标红提示
    this.cancelGhost();
    this.exitUpgradeMode();
    this.selection = null;
    FG.Events.emit('selection:change');
    this.bpMode = 'place';
    this.bpSelect = null;
    if (anchor) {
      this.logMsg('⚡ 一键流水线「' + preset.name + '」已就位：左键提交整套施工，R 旋转，'
        + 'F 重新智能选位，Esc 取消', 'unlock');
    } else {
      this.logMsg('⚡ 「' + preset.name + '」附近未找到合适落点（矿机须对准矿脉）——'
        + '移动鼠标选位，或按 F 重新搜索', 'error');
    }
    FG.Events.emit('blueprint:mode', 'place');
    FG.Events.emit('blueprint:change');
    return true;
  }

  /** 重新在鼠标格附近智能搜索落点 */
  refindPipelineAnchor(tile) {
    if (this.bpMode !== 'place' || !this.blueprint) return;
    const c = tile || this._lastMouseTile;
    if (!c) return;
    this.bpAnchor = FG.Pipelines.findAnchor(this, this.blueprint, c.x, c.y, FG.Config.PIPELINE_SEARCH_RADIUS);
    if (this.bpAnchor) this.logMsg('已重新定位到可放置落点：(' + this.bpAnchor.x + ',' + this.bpAnchor.y + ')', 'info');
    else this.logMsg('附近仍未找到有效落点', 'error');
    FG.Events.emit('blueprint:change');
  }

  /** 流水线预览原点：智能选位优先，否则跟随鼠标 */
  blueprintOrigin(mx, my) {
    return this.bpAnchor || { x: mx, y: my };
  }

  /** 提交施工计划：按科技与地形校验，全部通过后进入施工队列 */
  submitBlueprintPlanAt(ox, oy) {
    if (!this.blueprint) return false;
    const v = FG.Blueprint.validate(this, this.blueprint, ox, oy);
    if (!v.ok) {
      this.logMsg('❌ 无法提交施工计划：' + v.reason, 'error');
      return false;
    }
    const preset = this.pipelineId ? FG.Pipelines.byId(this.pipelineId) : null;
    const plan = this.construction.addPlan(this.blueprint, ox, oy);
    if (preset) plan.name = preset.name + '（一键流水线）';
    this.logMsg('🏗 已提交' + (preset ? '⚡一键流水线' : '施工计划') + '「' + plan.name + '」：'
      + plan.entries.length + ' 栋建筑，开始从物流（箱子/地面堆）预留建材', 'info');
    // 一键流水线：在刚提交位置附近继续搜索下一个落点，方便连续铺设；找不到则回鼠标跟随
    if (preset) {
      this.bpAnchor = FG.Pipelines.findAnchor(this, this.blueprint, ox, oy + this.blueprint.h + 2,
        FG.Config.PIPELINE_SEARCH_RADIUS)
        || FG.Pipelines.findAnchor(this, this.blueprint, ox + this.blueprint.w + 2, oy,
          FG.Config.PIPELINE_SEARCH_RADIUS);
      FG.Events.emit('blueprint:change');
    }
    return true;
  }

  /** 取消施工计划：已预留建材返还物流，已建成建筑保留 */
  cancelConstruction(planId) { return this.construction.cancel(planId); }

  /** 施工计划调度：优先级 / 暂停 / 前置依赖（面板操作） */
  setPlanPriority(planId, priority) { return this.construction.setPriority(planId, priority); }
  togglePlanPaused(planId) { return this.construction.togglePaused(planId); }
  addPlanDep(planId, depId) { return this.construction.addDep(planId, depId); }
  removePlanDep(planId, depId) { return this.construction.removeDep(planId, depId); }

  /** 分阶段施工：切分阶段 / 删除阶段边界 / 设置闸门（built 建成 / trial 试产达标） */
  splitPlanStage(planId, cut) { return this.construction.splitStage(planId, cut); }
  removePlanStage(planId, idx) { return this.construction.removeStage(planId, idx); }
  setPlanStageGate(planId, idx, gate) { return this.construction.setStageGate(planId, idx, gate); }

  /** @deprecated 旧名兼容：提交施工计划（新代码请用 submitBlueprintPlanAt） */
  submitBlueprintPlan(ox, oy) { return this.submitBlueprintPlanAt(ox, oy); }

  // ================= 原地升级 =================
  /** 切换升级模式：进入时退出幽灵/蓝图模式；再按一次退出 */
  toggleUpgradeMode() {
    if (this.state !== 'playing') return;
    if (this.upMode) { this.exitUpgradeMode(); return; }
    this.cancelGhost();
    this.exitBlueprintMode();
    this.selection = null;
    FG.Events.emit('selection:change');
    this.upMode = 'select';
    this.upSelect = null;
    this.upPreview = null;
    this.logMsg('⬆ 原地升级：框选产线，框内建筑将批量替换为已解锁的最高级型号', 'info');
    FG.Events.emit('upgrade:mode', this.upMode);
  }

  exitUpgradeMode() {
    if (!this.upMode) return;
    this.upMode = null;
    this.upSelect = null;
    this.upPreview = null;
    FG.Events.emit('upgrade:mode', null);
  }

  /**
   * 框选完成 → 生成升级预览：为每栋建筑找「已解锁的最高级替换型号」，
   * 跳过无升级链/未解锁/已有施工计划占位的格子；汇总新建筑造价为备料成本。
   */
  previewUpgrade(x0, y0, x1, y1) {
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    const entries = [];
    let locked = 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const b = this.map.buildingAt(x, y);
        if (!b) continue;
        const to = FG.Buildings.upgradeTarget(b.type, t => this.research.isBuildingUnlocked(t));
        if (!to) { if (FG.Buildings.UPGRADE_CHAIN[b.type]) locked++; continue; }
        if (this.construction.entryAt(x, y)) continue;   // 已有施工/升级计划占位
        entries.push({ from: b.type, to, x, y, dir: b.dir || 0 });
      }
    }
    this.upSelect = null;
    if (!entries.length) {
      this.logMsg(locked
        ? '框内建筑的高级型号尚未解锁 —— 请先在科技树完成对应研究'
        : '框选区域内没有可升级的建筑', 'error');
      FG.Events.emit('upgrade:change');
      return 0;
    }
    const cost = {};
    for (const e of entries) {
      const c = FG.Buildings.costOf(e.to);
      for (const k of Object.keys(c)) cost[k] = (cost[k] || 0) + c[k];
    }
    this.upPreview = { entries, cost };
    this.upMode = 'confirm';
    const costTxt = Object.keys(cost).map(k => FG.Items.byId(k).name + '×' + cost[k]).join(' ');
    this.logMsg('⬆ 升级预览：' + entries.length + ' 栋建筑 → 高级型号（备料 ' + costTxt
      + '）—— 左键确认提交，右键/Esc 重选', 'info');
    FG.Events.emit('upgrade:mode', 'confirm');
    FG.Events.emit('upgrade:change');
    return entries.length;
  }

  /** 确认预览 → 提交升级施工计划（备料后分步原地切换），并回到框选继续选下一片 */
  confirmUpgrade() {
    if (this.upMode !== 'confirm' || !this.upPreview) return false;
    const plan = this.construction.addUpgradePlan(this.upPreview.entries);
    this.logMsg('⬆ 已提交升级计划「' + plan.name + '」：' + plan.entries.length
      + ' 栋建筑将按施工计划备料、分步原地替换（配方/库存/在途物料保留）', 'info');
    this.upPreview = null;
    this.upMode = 'select';
    FG.Events.emit('upgrade:mode', 'select');
    FG.Events.emit('upgrade:change');
    return true;
  }

  /** 右键/Esc：预览中 → 放弃预览回到框选；框选中 → 退出升级模式 */
  cancelUpgradePreview() {
    if (this.upMode === 'confirm') {
      this.upPreview = null;
      this.upMode = 'select';
      FG.Events.emit('upgrade:mode', 'select');
      FG.Events.emit('upgrade:change');
    } else {
      this.exitUpgradeMode();
    }
  }

  setSpeed(s) { this.speed = s; FG.Events.emit('speed:change', s); }
  togglePause() { this.paused = !this.paused; FG.Events.emit('pause:change', this.paused); }

  // ================= 科研 =================
  startResearch(id) { return this.research.start(id); }
  cancelResearch() { this.research.cancel(); }

  // ================= 消息 =================
  logMsg(text, cls) {
    this.log.push({ t: Date.now(), text, cls: cls || 'info' });
    if (this.log.length > 200) this.log.shift();
    FG.Events.emit('message', { text, cls });
  }

  /** 盘点全图物品（每 1 秒刷新顶栏），含在途物品（传送带/机械臂手上/地面堆） */
  inventory() {
    const counts = {};
    const add = (id, n) => { if (id) counts[id] = (counts[id] || 0) + n; };
    for (const b of this.map.buildings.values()) {
      if (b.items) for (const it of b.items) add(it.type, 1);
      if (b.held) add(b.held.type, 1);
      if (b.chest) for (const s of b.chest) if (s.count > 0) add(s.type, s.count);
      if (b.slots) {
        for (const k of Object.keys(b.slots.inputs)) add(k, b.slots.inputs[k].count);
        for (const k of Object.keys(b.slots.outputs)) add(k, b.slots.outputs[k].count);
      }
    }
    for (const pile of this.map.piles.values()) for (const s of pile) add(s.type, s.count);
    // 列车在途货物（运输中的货物随全局盘点可见）
    if (this.railway) for (const tr of this.railway.trains) for (const s of tr.cargo) add(s.type, s.count);
    return counts;
  }

  totalBuildings() { return this.map ? this.map.buildings.size : 0; }
};
