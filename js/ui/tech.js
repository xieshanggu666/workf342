/**
 * FG.Tech —— 科技树弹窗（Canvas 渲染 + 拖拽/缩放）
 */
FG.Tech = (() => {
  let wrap = null, canvas = null, detail = null;
  let view = { zoom: 0.85, panX: 20, panY: 20 };
  let dragging = false, last = { x: 0, y: 0 };
  let hoverId = null;

  const NODE_R = 27;
  const COL_W = 250, ROW_H = 120, M = 50;

  function layout() {
    const defs = FG.Research.list();
    const pos = {};
    let maxX = 0, maxY = 0;
    for (const t of defs) {
      pos[t.id] = { x: M + t.col * COL_W, y: M + t.row * ROW_H };
      maxX = Math.max(maxX, t.col);
      maxY = Math.max(maxY, t.row);
    }
    return { pos, w: (maxX + 1) * COL_W + M * 2, h: (maxY + 1) * ROW_H + M * 2 };
  }

  function init() {
    const root = document.getElementById('modal-root');
    root.innerHTML += `
      <div id="tech-tree" class="hidden">
        <div class="tt-head">
          <h2>🔬 科技树</h2>
          <span style="color:var(--text-dim);font-size:11px">滚轮缩放 · 拖拽平移 · 点击节点研究</span>
          <button id="tech-close">关闭 (Esc)</button>
        </div>
        <div id="tech-wrap">
          <canvas id="tech-canvas"></canvas>
          <div id="tech-detail" class="hidden"></div>
        </div>
      </div>`;
    wrap = document.getElementById('tech-wrap');
    canvas = document.getElementById('tech-canvas');
    detail = document.getElementById('tech-detail');
    document.getElementById('tech-close').onclick = close;

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const nz = Math.min(1.6, Math.max(0.3, view.zoom * factor));
      // 以鼠标为中心缩放
      view.panX = mx - (mx - view.panX) * (nz / view.zoom);
      view.panY = my - (my - view.panY) * (nz / view.zoom);
      view.zoom = nz;
      render();
    }, { passive: false });

    canvas.addEventListener('mousedown', (e) => {
      dragging = true; last = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('mousemove', (e) => {
      if (dragging) {
        view.panX += e.clientX - last.x;
        view.panY += e.clientY - last.y;
        last = { x: e.clientX, y: e.clientY };
        render();
      }
      const n = nodeAt(e);
      if (n !== hoverId) { hoverId = n; render(); }
    });
    window.addEventListener('mouseup', (e) => {
      if (dragging && Math.abs(e.clientX - last.x) < 3 && Math.abs(e.clientY - last.y) < 3) {
        const n = nodeAt(e);
        if (n) selectNode(n);
      }
      dragging = false;
    });

    FG.Events.on('research:start', render);
    FG.Events.on('research:complete', () => { render(); });
    FG.Events.on('research:cancel', render);
  }

  function open() {
    document.getElementById('tech-tree').classList.remove('hidden');
    resize();
    render();
  }
  function close() { document.getElementById('tech-tree').classList.add('hidden'); }

  function focus(techId) {
    open();
    const L = layout();
    const p = L.pos[techId];
    // 居中该节点
    const rect = wrap.getBoundingClientRect();
    view.zoom = Math.min(rect.width / L.w, rect.height / L.h, 1);
    view.panX = rect.width / 2 - p.x * view.zoom;
    view.panY = rect.height / 2 - p.y * view.zoom;
    render();
    selectNode(techId);
  }

  function resize() {
    const rect = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    const L = layout();
    const fit = Math.min(rect.width / L.w, rect.height / L.h);
    view.zoom = Math.min(fit, view.zoom || fit);
  }

  function nodeAt(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const L = layout();
    for (const [id, p] of Object.entries(L.pos)) {
      const nx = p.x * view.zoom + view.panX;
      const ny = p.y * view.zoom + view.panY;
      if (Math.hypot(sx - nx, sy - ny) < NODE_R * view.zoom + 8) return id;
    }
    return null;
  }

  function nodeState(id) {
    const mgr = FG.game.research;
    if (mgr.isDone(id)) return 'done';
    if (mgr.current && mgr.current.id === id) return 'current';
    const t = FG.Research.byId(id);
    return t.prereq.every(p => mgr.isDone(p)) ? 'available' : 'locked';
  }

  function render() {
    if (!FG.game || document.getElementById('tech-tree').classList.contains('hidden')) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = canvas.width / dpr, H = canvas.height / dpr;
    ctx.fillStyle = '#0f121a';
    ctx.fillRect(0, 0, W, H);

    const L = layout();
    const mgr = FG.game.research;

    ctx.save();
    ctx.translate(view.panX, view.panY);
    ctx.scale(view.zoom, view.zoom);

    // 连线
    for (const t of FG.Research.list()) {
      const p = L.pos[t.id];
      for (const pre of t.prereq) {
        const pp = L.pos[pre];
        if (!pp) continue;
        const done = mgr.isDone(pre);
        ctx.strokeStyle = done ? 'rgba(88,194,111,0.7)' : '#3a4150';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(pp.x + NODE_R, pp.y);
        const midX = (pp.x + p.x) / 2;
        ctx.bezierCurveTo(midX, pp.y, midX, p.y, p.x - NODE_R, p.y);
        ctx.stroke();
      }
    }

    // 节点
    for (const t of FG.Research.list()) {
      const p = L.pos[t.id];
      const st = nodeState(t.id);
      const colors = { done: '#58c26f', available: '#4da3ff', current: '#e8a33d', locked: '#3a4150' };
      const isHover = hoverId === t.id;
      ctx.beginPath();
      ctx.arc(p.x, p.y, NODE_R + (isHover ? 3 : 0), 0, Math.PI * 2);
      ctx.fillStyle = colors[st];
      ctx.globalAlpha = st === 'locked' ? 0.55 : 1;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (st === 'current') {
        ctx.strokeStyle = '#ffd27a';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(p.x, p.y, NODE_R + 6, 0, Math.PI * 2); ctx.stroke();
      }
      // 图标（取该科技解锁的首个建筑）
      const iconType = t.unlocksB[0];
      if (iconType) {
        const icon = FG.Renderer.buildingIcon(iconType, 34);
        const ds = 34 * view.zoom;
        ctx.drawImage(icon, p.x - 17, p.y - 17, 34, 34);
      } else {
        ctx.fillStyle = '#0d0f14';
        ctx.font = '20px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('★', p.x, p.y + 1);
      }
      // 名称
      ctx.fillStyle = st === 'locked' ? '#7a8194' : '#d6dbe8';
      ctx.font = '11px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(t.name, p.x, p.y + NODE_R + 14);
    }
    ctx.restore();

    // 图例
    ctx.fillStyle = '#8b93a8';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    let ly = 20;
    for (const [k, v] of [['已完成', '#58c26f'], ['可研究', '#4da3ff'], ['研究中', '#e8a33d'], ['未解锁', '#3a4150']]) {
      ctx.fillStyle = v;
      ctx.fillRect(12, ly - 9, 12, 12);
      ctx.fillStyle = '#8b93a8';
      ctx.fillText(k, 30, ly);
      ly += 18;
    }
  }

  function selectNode(id) {
    const mgr = FG.game.research;
    const t = FG.Research.byId(id);
    const st = nodeState(id);
    const L = layout();
    const p = L.pos[id];

    let h = `<h4>${t.name}</h4>`;
    if (st === 'current') {
      const pp = mgr.packProgress();
      h += `<div style="color:var(--accent);margin:4px 0">研究中 … ${(mgr.progress() * 100).toFixed(0)}%</div>`;
      for (const [pack, v] of Object.entries(pp)) {
        h += `<div class="td-cost">${FG.Items.byId(pack).name} ${v.have}/${v.need}</div>`;
      }
      h += `<button id="td-cancel">取消研究</button>`;
    } else if (st === 'available') {
      h += `<div class="td-cost">`;
      for (const [pack, n] of Object.entries(t.cost)) h += `${FG.Items.byId(pack).name} × ${n} `;
      h += `</div>`;
      h += `<div class="td-desc">${t.desc}</div>`;
      h += `<div class="td-desc">解锁：${[...t.unlocksB.map(b => FG.Buildings.byId(b).name), ...t.unlocksR.map(r => FG.Recipes.byId(r).name)].join('、')}</div>`;
      h += `<button id="td-start" style="margin-top:8px">开始研究</button>`;
    } else if (st === 'done') {
      h += `<div style="color:var(--green);margin:4px 0">✅ 已完成</div>`;
      h += `<div class="td-desc">${t.desc}</div>`;
    } else {
      const need = t.prereq.filter(pr => !mgr.isDone(pr)).map(pr => FG.Research.byId(pr).name).join('、');
      h += `<div style="color:var(--red);margin:4px 0">🔒 需先完成：${need}</div>`;
      h += `<div class="td-desc">${t.desc}</div>`;
    }

    detail.innerHTML = h;
    detail.classList.remove('hidden');
    const rect = wrap.getBoundingClientRect();
    detail.style.left = Math.min(rect.width - 250, p.x * view.zoom + view.panX + 30) + 'px';
    detail.style.top = Math.max(10, Math.min(rect.height - 200, p.y * view.zoom + view.panY - 40)) + 'px';

    const start = document.getElementById('td-start');
    if (start) start.onclick = () => { FG.game.startResearch(id); };
    const cancel = document.getElementById('td-cancel');
    if (cancel) cancel.onclick = () => { FG.game.cancelResearch(); };
  }

  return { init, open, close, focus, render };
})();
