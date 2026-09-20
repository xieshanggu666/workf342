/**
 * FG.Utils —— 通用工具函数
 * FG.Events —— 轻量事件总线
 */
FG.Utils = (() => {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);

  // 可复现随机数
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function uid() {
    return 'id_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  // 格式化数字：1234 -> 1.2k
  function fmtNum(n) {
    n = Math.round(n);
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  // 秒 -> mm:ss
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function fmtRate(n) {
    return (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10) + '/s';
  }

  // 方向（0=北 1=东 2=南 3=西）
  const DIRS = [
    { x: 0, y: -1 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
  ];
  const dirVec = (d) => DIRS[((d % 4) + 4) % 4];
  const dirOpp = (d) => (((d % 4) + 4) % 4 + 2) % 4;
  const dirName = (d) => (['北', '东', '南', '西'])[((d % 4) + 4) % 4];
  const dirs = DIRS;

  // key of tile
  const key = (x, y) => x + ',' + y;

  // 深度合并（存档默认值）
  function mergeDeep(base, extra) {
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (extra && typeof extra === 'object') {
      for (const k of Object.keys(extra)) {
        if (extra[k] && typeof extra[k] === 'object' && !Array.isArray(extra[k])
            && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
          out[k] = mergeDeep(out[k], extra[k]);
        } else {
          out[k] = extra[k];
        }
      }
    }
    return out;
  }

  return { clamp, lerp, dist, mulberry32, uid, fmtNum, fmtTime, fmtRate, dirVec, dirOpp, dirName, dirs, key, mergeDeep };
})();

FG.Events = (() => {
  const map = {};
  function on(type, fn) {
    (map[type] = map[type] || []).push(fn);
    return () => off(type, fn);
  }
  function off(type, fn) {
    if (!map[type]) return;
    map[type] = map[type].filter(f => f !== fn);
  }
  function emit(type, data) {
    (map[type] || []).forEach(fn => {
      try { fn(data); } catch (e) { console.error('[Event]', type, e); }
    });
  }
  return { on, off, emit };
})();
