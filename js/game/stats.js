/**
 * FG.Stats —— 生产统计：每秒采样、速率曲线、瓶颈检测
 */
FG.Stats = class Stats {
  constructor() {
    this.history = [];          // [{p:{id:n}, c:{id:n}}] 每秒一个桶
    this.totals = {};           // {id: {p, c}} 累计
    this.cur = { p: {}, c: {} };
    this.agg = this.newAgg();
    this.sec = 0;
  }

  newAgg() {
    return { starveCount: 0, blockCount: 0, workingCount: 0, starveByItem: {}, blockByItem: {} };
  }

  reset() { this.history = []; this.totals = {}; this.cur = { p: {}, c: {} }; this.agg = this.newAgg(); this.sec = 0; }

  recordProduce(id, n) {
    if (!this.totals[id]) this.totals[id] = { p: 0, c: 0 };
    this.totals[id].p += n;
    this.cur.p[id] = (this.cur.p[id] || 0) + n;
  }

  recordConsume(id, n) {
    if (!this.totals[id]) this.totals[id] = { p: 0, c: 0 };
    this.totals[id].c += n;
    this.cur.c[id] = (this.cur.c[id] || 0) + n;
  }

  mark(status, item) {
    if (status === 'starving') {
      this.agg.starveCount++;
      if (item) this.agg.starveByItem[item] = (this.agg.starveByItem[item] || 0) + 1;
    } else if (status === 'blocked') {
      this.agg.blockCount++;
      if (item) this.agg.blockByItem[item] = (this.agg.blockByItem[item] || 0) + 1;
    }
  }

  /** 每秒调用：归档当前桶 */
  onSecond() {
    this.sec++;
    this.history.push(this.cur);
    if (this.history.length > FG.Config.STAT_HISTORY) this.history.shift();
    this.cur = { p: {}, c: {} };
    this.agg = this.newAgg();
  }

  /** 近 window 秒的平均速率（/s） */
  rate(id, window) {
    const w = Math.min(window || FG.Config.RATE_WINDOW, this.history.length);
    if (w === 0) return { p: 0, c: 0 };
    let p = 0, c = 0;
    for (let i = this.history.length - w; i < this.history.length; i++) {
      const bk = this.history[i];
      p += bk.p[id] || 0;
      c += bk.c[id] || 0;
    }
    return { p: p / w, c: c / w };
  }

  total(id) {
    const t = this.totals[id];
    return t ? { p: t.p, c: t.c } : { p: 0, c: 0 };
  }

  /** 所有出现过的物品 id */
  itemIds() {
    return Object.keys(this.totals).filter(id => this.totals[id].p > 0);
  }

  /** 瓶颈列表：消耗 > 产出的物品，按缺口降序 */
  deficits() {
    const out = [];
    for (const id of Object.keys(this.totals)) {
      const r = this.rate(id);
      const gap = r.c - r.p;
      if (gap > 0.05) out.push({ id, gap, p: r.p, c: r.c });
    }
    out.sort((a, b) => b.gap - a.gap);
    return out;
  }
};
