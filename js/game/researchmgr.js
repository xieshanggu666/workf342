/**
 * FG.ResearchMgr —— 科研管理器：进度、完成、解锁
 */
FG.ResearchMgr = class ResearchMgr {
  constructor(game) {
    this.game = game;
    this.completed = new Set();
    this.current = null;       // 科技 def
    this.points = {};          // {techId: {packId: n}}
  }

  reset() { this.completed = new Set(); this.current = null; this.points = {}; }

  isDone(id) { return this.completed.has(id); }
  canStart(id) {
    const t = FG.Research.byId(id);
    if (!t || this.completed.has(id) || this.current) return false;
    return t.prereq.every(p => this.completed.has(p));
  }

  start(id) {
    if (!this.canStart(id)) return false;
    this.current = FG.Research.byId(id);
    this.points[id] = {};
    FG.Events.emit('research:start', this.current);
    this.game.logMsg('开始研究：' + this.current.name, 'info');
    return true;
  }

  cancel() {
    if (!this.current) return;
    this.game.logMsg('取消研究：' + this.current.name, 'info');
    this.current = null;
    FG.Events.emit('research:cancel');
  }

  /** 进度 0..1（按各科学包需求量中完成度最低者） */
  progress() {
    if (!this.current) return 0;
    const t = this.current;
    let p = 1;
    for (const pack of Object.keys(t.cost)) {
      const need = t.cost[pack];
      const have = (this.points[t.id] && this.points[t.id][pack]) || 0;
      p = Math.min(p, have / need);
    }
    return p;
  }

  /** 各科学包已投入/需求 */
  packProgress() {
    if (!this.current) return {};
    const out = {};
    for (const pack of Object.keys(this.current.cost)) {
      out[pack] = { have: (this.points[this.current.id] && this.points[this.current.id][pack]) || 0, need: this.current.cost[pack] };
    }
    return out;
  }

  addPoints(pack, n) {
    if (!this.current) return;
    const id = this.current.id;
    this.points[id] = this.points[id] || {};
    this.points[id][pack] = (this.points[id][pack] || 0) + n;
    if (this.progress() >= 1) this.complete();
  }

  complete() {
    const t = this.current;
    this.completed.add(t.id);
    this.current = null;
    // 解锁建筑
    for (const b of t.unlocksB) {
      FG.Events.emit('unlock', { kind: 'building', id: b, name: FG.Buildings.byId(b).name });
      this.game.logMsg('🔓 解锁建筑：' + FG.Buildings.byId(b).name, 'unlock');
    }
    for (const r of t.unlocksR) {
      const rd = FG.Recipes.byId(r);
      this.game.logMsg('🔓 解锁配方：' + rd.name, 'unlock');
    }
    this.game.logMsg('✅ 研究完成：' + t.name, 'unlock');
    FG.Events.emit('research:complete', t);
  }

  // ============ 解锁查询 ============
  isBuildingUnlocked(type) {
    const def = FG.Buildings.byId(type);
    return !def.unlockedBy || this.completed.has(def.unlockedBy);
  }
  isRecipeUnlocked(rid) {
    const r = FG.Recipes.byId(rid);
    return !r.unlockedBy || this.completed.has(r.unlockedBy);
  }
  // 解锁该建筑的科技（用于科技树展示）
  techOf(type) {
    const def = FG.Buildings.byId(type);
    return def.unlockedBy || null;
  }
};
