/**
 * FG.Main —— 启动：输入处理、主循环
 */
(() => {
  const canvas = document.getElementById('map-canvas');
  const wrap = document.getElementById('map-wrap');
  const tooltip = document.getElementById('map-tooltip');

  FG.game = new FG.Game();

  let panning = false;
  let dragPlace = null;      // {lastX, lastY} 传送带拖拽放置
  let bpDrag = null;         // {x, y} 蓝图框选锚点
  let upDrag = null;         // {x, y} 原地升级框选锚点

  // ================= 初始化 =================
  function init() {
    FG.Renderer.init(canvas, FG.game);
    FG.Toolbar.init();
    FG.Panels.init();
    FG.Tech.init();
    FG.Topbar.init();
    bindInput();

    window.addEventListener('resize', () => {
      FG.Renderer.resize();
      if (!document.getElementById('tech-tree').classList.contains('hidden')) FG.Tech.render();
    });

    // 首次启动：有存档显示帮助，无存档直接引导新建
    const hasSave = FG.Save.listSlots().some(s => s.exists);
    if (hasSave) FG.Modals.help();
    else FG.Modals.newGame();
  }

  // ================= 输入 =================
  function bindInput() {
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const tile = FG.Renderer.screenToTile(mx, my);
      FG.Renderer.setMouseTile(tile.x, tile.y);
      FG.game._lastMouseTile = tile;

      if (panning) {
        const t = FG.Config.TILE * FG.game.camera.zoom;
        FG.game.camera.x -= e.movementX / t;
        FG.game.camera.y -= e.movementY / t;
      }
      if (bpDrag && FG.game.bpMode === 'select') {
        FG.game.bpSelect = { x0: bpDrag.x, y0: bpDrag.y, x1: tile.x, y1: tile.y };
      }
      if (upDrag && FG.game.upMode === 'select') {
        FG.game.upSelect = { x0: upDrag.x, y0: upDrag.y, x1: tile.x, y1: tile.y };
      }
      // 一键流水线预览：智能选位锁定后，仅当鼠标所在原点本身也可放置时才改为跟随鼠标
      //（含矿机的产线只有鼠标悬停到另一处矿脉才会解锁，避免一开始就丢失自动对准）
      if (FG.game.bpMode === 'place' && FG.game.pipelineId && FG.game.bpAnchor) {
        if (FG.Blueprint.validate(FG.game, FG.game.blueprint, tile.x, tile.y).ok) {
          FG.game.bpAnchor = null;
          FG.Events.emit('blueprint:change');
        }
      }
      if (dragPlace) {
        const dx = tile.x - dragPlace.lastX, dy = tile.y - dragPlace.lastY;
        if (dx || dy) {
          const ghostDef = FG.Buildings.byId(FG.game.ghost.type);
          // 传送带拖拽自动定向；轨道拖拽沿走向铺设（方向不影响接轨）
          if (ghostDef && ghostDef.beltTier !== undefined) {
            FG.game.ghost.dir = dx !== 0 ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
          }
          if (FG.game.placeGhost(tile.x, tile.y)) {
            dragPlace.lastX = tile.x;
            dragPlace.lastY = tile.y;
          }
        }
      }
      updateTooltip(e.clientX - wrap.getBoundingClientRect().left, e.clientY - wrap.getBoundingClientRect().top, tile);
    });

    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const tile = FG.Renderer.screenToTile(e.clientX - rect.left, e.clientY - rect.top);
      if (e.button === 2 || e.button === 1) {
        panning = true;
        return;
      }
      if (e.button === 0) {
        const game = FG.game;
        game._lastMouseTile = tile;
        // 原地升级：框选 / 确认提交升级计划
        if (game.upMode === 'select') {
          upDrag = { x: tile.x, y: tile.y };
          game.upSelect = { x0: tile.x, y0: tile.y, x1: tile.x, y1: tile.y };
          return;
        }
        if (game.upMode === 'confirm') {
          game.confirmUpgrade();
          return;
        }
        // 蓝图模式：框选 / 提交施工计划
        if (game.bpMode === 'select') {
          bpDrag = { x: tile.x, y: tile.y };
          game.bpSelect = { x0: tile.x, y0: tile.y, x1: tile.x, y1: tile.y };
          return;
        }
        if (game.bpMode === 'place') {
          const o = game.blueprintOrigin(tile.x, tile.y);
          game.submitBlueprintPlanAt(o.x, o.y);
          return;
        }
        if (FG.game.ghost) {
          const gDef = FG.Buildings.byId(FG.game.ghost.type);
          if (gDef.beltTier !== undefined || gDef.railTier !== undefined) {
            dragPlace = { lastX: tile.x, lastY: tile.y };
            FG.game.placeGhost(tile.x, tile.y);
          } else {
            FG.game.placeGhost(tile.x, tile.y);
          }
        } else {
          // 先选列车（列车覆盖轨道格时优先），其次建筑
          const tr = FG.game.railway && FG.game.railway.trainAt(tile.x, tile.y);
          if (tr) FG.game.selectBuilding(tr);
          else {
            const b = FG.game.map.buildingAt(tile.x, tile.y);
            if (b) FG.game.selectBuilding(b);
            else { FG.game.selection = null; FG.Events.emit('selection:change'); }
          }
        }
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 2 || e.button === 1) panning = false;
      if (e.button === 0) {
        dragPlace = null;
        // 升级框选完成：生成升级预览（拖拽中途退出模式则放弃）
        if (upDrag) {
          const r = FG.game.upSelect;
          upDrag = null;
          FG.game.upSelect = null;
          if (r && FG.game.upMode === 'select') FG.game.previewUpgrade(r.x0, r.y0, r.x1, r.y1);
        }
        // 蓝图框选完成：生成蓝图并进入放置预览（拖拽中途退出模式则放弃）
        if (bpDrag) {
          const r = FG.game.bpSelect;
          bpDrag = null;
          FG.game.bpSelect = null;
          if (r && FG.game.bpMode === 'select') FG.game.captureBlueprint(r.x0, r.y0, r.x1, r.y1);
        }
      }
    });

    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (FG.game.upMode) { FG.game.cancelUpgradePreview(); return; }
      if (FG.game.bpMode) { FG.game.exitBlueprintMode(); return; }
      if (FG.game.ghost) FG.game.cancelGhost();
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const cam = FG.game.camera;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = e.deltaY > 0 ? 0.88 : 1.14;
      const nz = Math.min(2.5, Math.max(0.4, cam.zoom * factor));
      const t = FG.Config.TILE;
      cam.x = (mx / (t * nz)) - (mx / (t * cam.zoom) - cam.x);
      cam.y = (my / (t * nz)) - (my / (t * cam.zoom) - cam.y);
      cam.zoom = nz;
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      const game = FG.game;
      const techOpen = !document.getElementById('tech-tree').classList.contains('hidden');
      const modalOpen = !!document.querySelector('.modal-mask');

      if (e.key === 'Escape') {
        if (modalOpen) { FG.Modals.closeAll(); return; }
        if (techOpen) { FG.Tech.close(); return; }
        if (game.upMode) { game.cancelUpgradePreview(); return; }
        if (game.bpMode) { game.exitBlueprintMode(); return; }
        if (game.ghost) { game.cancelGhost(); return; }
        game.selection = null;
        FG.Events.emit('selection:change');
        return;
      }
      if (modalOpen || techOpen) return;

      switch (e.key) {
        case 'r': case 'R':
          if (game.bpMode === 'place') game.rotateBlueprint();
          else if (game.ghost) game.rotateGhost();
          else if (game.selection && !game.selection.isTrain
                   && (game.selection.def.beltTier !== undefined || game.selection.def.inserterTier !== undefined)) {
            game.selection.dir = (game.selection.dir + 1) % 4;
          }
          break;
        case 'u': case 'U':
          game.toggleUpgradeMode();
          break;
        case 'f': case 'F':
          if (game.bpMode === 'place' && game.pipelineId) game.refindPipelineAnchor();
          break;
        case 'p': case 'P':
          if (game.state === 'playing') FG.Modals.pipelines();
          break;
        case 'b': case 'B':
          game.toggleBlueprintMode();
          break;
        case 'Delete': case 'Backspace':
          if (game.selection && game.selection.isTrain) game.removeTrainSelection();
          else if (game.selection) game.removeBuilding(game.selection);
          break;
        case ' ':
          e.preventDefault();
          game.togglePause();
          break;
        case 't': case 'T': FG.Tech.open(); break;
        case 's': case 'S': game.showStatus = !game.showStatus; break;
        case '1': game.setSpeed(0.5); break;
        case '2': game.setSpeed(1); break;
        case '3': game.setSpeed(2); break;
        case '4': game.setSpeed(4); break;
      }
    });
  }

  // ================= 悬浮提示 =================
  function updateTooltip(px, py, tile) {
    const game = FG.game;
    const modalOpen = !!document.querySelector('.modal-mask');
    const techOpen = !document.getElementById('tech-tree').classList.contains('hidden');
    if (modalOpen || techOpen || game.bpMode) { tooltip.classList.add('hidden'); return; }
    const m = game.map;
    if (!m || !m.inBounds(tile.x, tile.y)) { tooltip.classList.add('hidden'); return; }

    const b = m.buildingAt(tile.x, tile.y);
    const tr = !b && game.railway ? game.railway.trainAt(tile.x, tile.y)
      : (game.railway && b && (b.type === 'rail' || b.def.railStation)) ? game.railway.trainAt(tile.x, tile.y) : null;
    const pile = !b ? m.pileAt(tile.x, tile.y) : null;
    const planEntry = !b && game.construction ? game.construction.entryAt(tile.x, tile.y) : null;
    let html = '';
    if (tr) {
      const ST = { moving: '行驶中', docked: '装卸中', waiting: '等站排队', blocked: '堵死/让行', noroute: '断路', paused: '已停运', idle: '待命' };
      html += `<div class="tt-title">🚆 列车 ${tr.id}</div>`;
      html += `<div class="tt-row">状态：<b>${ST[tr.state] || tr.state}</b></div>`;
      html += `<div class="tt-row">载货 <b>${tr.cargoTotal()}/${FG.Config.TRAIN_CARGO_CAP}</b> 件 · 停靠 ${tr.stopIdx + 1}/${Math.max(1, tr.stops.length)}</div>`;
      const stop = tr.stops[tr.stopIdx];
      if (stop) {
        const st = game.railway.stationById(stop.stationId);
        html += `<div class="tt-row">目标：<b>${st ? st.stationName : '站点已拆除'}</b> · ${stop.action === 'load' ? '装' : '卸'} ${stop.item ? FG.Items.byId(stop.item).name : '任意'}×${stop.count}</div>`;
      }
      if (tr.cargo.length) html += `<div class="tt-row">${tr.cargo.slice(0, 4).map(s => FG.Items.byId(s.type).name + '×' + s.count).join('、')}${tr.cargo.length > 4 ? '…' : ''}</div>`;
    } else if (b) {
      const st = { working: '生产中/流动', starving: '缺料', blocked: '堵塞', idle: '闲置', empty: '枯竭' };
      html += `<div class="tt-title">${b.def.name}</div>`;
      html += `<div class="tt-row">状态：<b>${st[b.status] || b.status}</b></div>`;
      if (b.recipe) {
        const r = FG.Recipes.byId(b.recipe);
        const p = Math.min(1, b.progress / r.time);
        html += `<div class="tt-row">${r.name} <b>${(p * 100).toFixed(0)}%</b></div>`;
      }
      if (b.def.beltTier !== undefined) {
        let merge = 0;
        for (const side of [2, 3]) {
          const sv = FG.Map.beltSideVec(b.dir, side);
          const nb = m.buildingAt(b.x + sv.x, b.y + sv.y);
          if (nb && nb.def.beltTier !== undefined && FG.Map.beltFeedsInto(nb, b)) merge++;
        }
        html += `<div class="tt-row">方向 <b>${FG.Utils.dirName(b.dir)}</b> · ${b.items.length}/${FG.Config.BELT_CAP}${merge ? ` · ${merge} 路汇入` : ''}</div>`;
      }
      if (b.def.inserterTier !== undefined) html += `<div class="tt-row">方向 <b>${FG.Utils.dirName(b.dir)}</b> · 筛选 <b>${b.filter ? FG.Items.byId(b.filter).name : '任意'}</b>${b.demandMode ? ' · 按需' : ''}</div>`;
      if (b.type === 'pipe') html += `<div class="tt-row">流体 <b>${(b.level / FG.Config.FLUID_PIPE_CAP * 100).toFixed(0)}%</b></div>`;
      if (b.type === 'rail') {
        const held = game.railway.occupiedBy(b.x, b.y);
        html += `<div class="tt-row">轨道${held ? ` · <b style="color:#e05c5c">${held} 占用</b>` : ''}</div>`;
      }
      if (b.def.railStation) {
        const held = game.railway.occupiedBy(b.x, b.y);
        const tag = b.def.delivery ? '交付站' : '站号';
        html += `<div class="tt-row">${tag} <b>${b.stationId}</b>${held ? ` · <b style="color:#58c26f">${held} 停靠中</b>` : ''}</div>`;
        const cargo = b.chest.reduce((n, s) => n + s.count, 0);
        html += `<div class="tt-row">货位 <b>${cargo}/${FG.Config.STATION_SLOTS * FG.Config.STATION_SLOT_CAP}</b></div>`;
        if (b.def.delivery && game.contracts) {
          const c = game.contracts.contractAt(b);
          if (c) {
            html += `<div class="tt-row">合同 <b>${FG.Items.byId(c.item).name} ${c.delivered}/${c.qty}</b>
              · 剩 <b>${FG.Utils.fmtTime(game.contracts.remainSec(c))}</b></div>`;
          }
        }
      }
      if (b.def.railDepot) {
        const near = FG.Utils.dirs.map(v => {
          const nb = m.buildingAt(b.x + v.x, b.y + v.y);
          return nb && (nb.type === 'rail' || nb.def.railStation);
        }).filter(Boolean).length;
        html += `<div class="tt-row">接轨 <b>${near}</b> 侧 · 选中可编组发车</div>`;
      }
      if (b.type === 'miner' && b.oreType) html += `<div class="tt-row">${FG.Items.byId(b.oreType).name} <b>${FG.Utils.fmtNum(m.amountAt(b.x, b.y))}</b></div>`;
    } else if (pile) {
      html += `<div class="tt-title">地面物料</div>`;
      for (const s of pile.slice(0, 6)) html += `<div class="tt-row">${FG.Items.byId(s.type).name} <b>×${FG.Utils.fmtNum(s.count)}</b></div>`;
      html += `<div class="tt-row" style="margin-top:3px">在此格放置建筑可回收</div>`;
    } else if (planEntry) {
      const p = planEntry.plan, e = planEntry.entry;
      const def = FG.Buildings.byId(e.type);
      const cost = FG.Buildings.costOf(e.type);
      const eIdx = p.entries.indexOf(e);
      const sIdx = game.construction.stageOfEntry(p, eIdx);
      const activeTo = p.stages && p.stages.length
        ? p.stages[Math.min(p.activeStage || 0, p.stages.length - 1)].cut : p.entries.length;
      html += `<div class="tt-title">🏗 ${p.name}</div>`;
      html += `<div class="tt-row">待建：<b>${def.name}</b>（${FG.Utils.dirName(e.dir)}） · 阶段 ${sIdx + 1}/${p.stages.length}</div>`;
      const stTxt = p.paused ? '已暂停（预留已返还）'
        : p.blocked ? '等待前置计划'
        : p.stageBlocked ? (p.stageReason || '等待前置阶段放行')
        : (eIdx >= activeTo) ? '等待前置阶段放行（不占料）'
        : p.waiting ? '缺料等待（可建部分先行）'
        : '施工中';
      html += `<div class="tt-row">状态：<b>${stTxt}</b></div>`;
      const parts = Object.keys(cost).map(k =>
        `${FG.Items.byId(k).name} ${Math.min(e.stock[k] || 0, cost[k])}/${cost[k]}`);
      if (parts.length) html += `<div class="tt-row">建材：${parts.join(' · ')}</div>`;
    } else {
      const ore = m.ores[tile.y][tile.x];
      if (ore) {
        html += `<div class="tt-title">${FG.Items.byId(ore.type).name}</div>`;
        html += `<div class="tt-row">储量 <b>${FG.Utils.fmtNum(ore.amount)}</b></div>`;
      } else if (m.isOil(tile.x, tile.y)) {
        html += `<div class="tt-title">油田</div><div class="tt-row">放置抽油机抽取原油</div>`;
      } else if (m.isWater(tile.x, tile.y)) {
        html += `<div class="tt-title">水域</div><div class="tt-row">放置水泵取水</div>`;
      } else {
        tooltip.classList.add('hidden');
        return;
      }
    }
    tooltip.innerHTML = html;
    tooltip.classList.remove('hidden');
    tooltip.style.left = Math.min(px + 14, wrap.clientWidth - 250) + 'px';
    tooltip.style.top = Math.min(py + 14, wrap.clientHeight - 120) + 'px';
  }

  // ================= 主循环 =================
  let lastTime = performance.now();
  function loop(now) {
    const dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    FG.game.update(dt);
    FG.Renderer.render();
    requestAnimationFrame(loop);
  }

  init();
  requestAnimationFrame(loop);
})();
