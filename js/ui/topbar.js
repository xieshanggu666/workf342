/**
 * FG.Topbar —— 顶栏：时间/速度/科研进度/物品资源条
 */
FG.Topbar = (() => {
  let lastStrip = 0;
  let lastTime = 0;

  function init() {
    // 速度按钮
    const sb = document.getElementById('speed-btns');
    for (const b of sb.querySelectorAll('button')) {
      b.onclick = () => FG.game.setSpeed(parseFloat(b.dataset.speed));
    }
    document.getElementById('btn-pause').onclick = () => FG.game.togglePause();
    document.getElementById('btn-tech').onclick = () => FG.Tech.open();
    document.getElementById('btn-menu').onclick = () => FG.Modals.menu();
    document.getElementById('btn-blueprint').onclick = () => FG.game.toggleBlueprintMode();
    document.getElementById('btn-upgrade').onclick = () => FG.game.toggleUpgradeMode();
    document.getElementById('btn-pipeline').onclick = () => {
      if (FG.game.state === 'playing') FG.Modals.pipelines();
    };

    FG.Events.on('blueprint:mode', (m) => {
      document.getElementById('btn-blueprint').classList.toggle('active', !!m);
      document.getElementById('btn-pipeline').classList.toggle('active', !!FG.game.pipelineId);
      updateBpHint();
    });
    FG.Events.on('blueprint:change', updateBpHint);
    FG.Events.on('upgrade:mode', (m) => {
      document.getElementById('btn-upgrade').classList.toggle('active', !!m);
      updateBpHint();
    });
    FG.Events.on('upgrade:change', updateBpHint);

    FG.Events.on('speed:change', (s) => {
      document.querySelectorAll('#speed-btns button').forEach(b =>
        b.classList.toggle('active', parseFloat(b.dataset.speed) === s));
    });
    FG.Events.on('pause:change', (p) => {
      document.getElementById('btn-pause').textContent = p ? '▶ 继续' : '⏸ 暂停';
    });
    FG.Events.on('research:start', () => refreshResearch());
    FG.Events.on('research:complete', () => refreshResearch());
    FG.Events.on('research:cancel', () => refreshResearch());
    FG.Events.on('game:start', () => {
      refreshResearch();
      document.getElementById('btn-pause').textContent = '⏸ 暂停';
      document.querySelectorAll('#speed-btns button').forEach(b =>
        b.classList.toggle('active', parseFloat(b.dataset.speed) === FG.game.speed));
    });
    FG.Events.on('sim:tick', () => {
      const now = performance.now();
      if (now - lastTime > 200) { lastTime = now; refreshTime(); refreshResearch(); }
      if (now - lastStrip > 1000) { lastStrip = now; refreshStrip(); }
    });
  }

  function updateBpHint() {
    const el = document.getElementById('bp-hint');
    const game = FG.game;
    if (!el || game.state !== 'playing' || (!game.bpMode && !game.upMode)) { if (el) el.classList.add('hidden'); return; }
    if (game.upMode === 'select') {
      el.innerHTML = '⬆ <b>原地升级</b>：按住左键框选产线，框内建筑批量替换为<b>已解锁的最高级型号</b>'
        + '（配方/库存/在途物料保留） · <span class="bh-key">Esc</span> 退出';
    } else if (game.upMode === 'confirm') {
      const pv = game.upPreview;
      const costTxt = pv ? Object.keys(pv.cost).map(k => FG.Items.byId(k).name + '×' + pv.cost[k]).join(' ') : '';
      el.innerHTML = `⬆ <b>升级预览</b>：${pv ? pv.entries.length : 0} 栋建筑（备料 ${costTxt}）—— `
        + `<span class="bh-key">左键</span>确认提交施工 · <span class="bh-key">右键</span>/<span class="bh-key">Esc</span> 重选`;
    } else if (game.bpMode === 'select') {
      el.innerHTML = '📐 <b>框选产线</b>：按住左键拖出矩形区域，框住已有建筑生成蓝图';
    } else if (game.pipelineId) {
      const p = FG.Pipelines.byId(game.pipelineId);
      const n = game.blueprint ? game.blueprint.entries.length : 0;
      el.innerHTML = `⚡ 一键流水线 <b>${p ? p.name : ''}</b>（${n} 栋）：`
        + `<span class="bh-key">左键</span>提交整套施工 · <span class="bh-key">R</span>旋转 · `
        + `<span class="bh-key">F</span>重新智能选位 · <span class="bh-key">Esc</span>取消`
        + (game.bpAnchor ? '' : '　<span style="color:var(--red)">未找到合适落点，请对准资源后按 F</span>');
    } else {
      el.innerHTML = '📐 <b>蓝图放置</b>：<span class="bh-key">左键</span>提交施工计划 · '
        + '<span class="bh-key">R</span>旋转 · <span class="bh-key">B</span>重新框选 · <span class="bh-key">Esc</span>退出';
    }
    el.classList.remove('hidden');
  }

  function refreshTime() {
    document.getElementById('tb-time').textContent = '⏱ ' + FG.Utils.fmtTime(FG.game.playTime);
  }

  function refreshResearch() {
    const mgr = FG.game.research;
    const label = document.getElementById('rb-label');
    const fill = document.getElementById('rb-fill');
    if (mgr.current) {
      label.textContent = '研究: ' + mgr.current.name;
      fill.style.width = (mgr.progress() * 100).toFixed(1) + '%';
      fill.style.background = 'linear-gradient(90deg,#4da3ff,#7cc0ff)';
    } else {
      label.textContent = '研究: 未选择';
      fill.style.width = '0%';
      fill.style.background = '#3a4150';
    }
  }

  function refreshStrip() {
    const strip = document.getElementById('item-strip');
    const counts = FG.game.inventory();
    const entries = Object.entries(counts).filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!entries.length) { strip.innerHTML = ''; return; }
    let html = '';
    for (const [id, n] of entries) {
      const icon = FG.Renderer.itemIcon(id, 16);
      html += `<div class="item-chip" title="${FG.Items.byId(id).name}">
        ${icon.outerHTML}<span class="qty">${FG.Utils.fmtNum(n)}</span></div>`;
    }
    strip.innerHTML = html;
  }

  return { init };
})();
