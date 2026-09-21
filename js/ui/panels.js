/**
 * FG.Panels —— 右侧面板：信息 / 统计 / 日志
 */
FG.Panels = (() => {
  let activeTab = 'info';
  let chartItems = [];
  let lastRefresh = 0;

  const tabsEl = () => document.getElementById('sp-tabs');
  const bodyEl = () => document.getElementById('sp-body');

  const STATUS_NAMES = { working: '生产中', starving: '缺料', blocked: '堵塞', idle: '闲置', empty: '枯竭' };

  function init() {
    for (const b of tabsEl().querySelectorAll('button')) {
      b.onclick = () => {
        activeTab = b.dataset.tab;
        tabsEl().querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
        render();
      };
    }
    FG.Events.on('sim:tick', () => {
      const now = performance.now();
      if (now - lastRefresh > 150) { lastRefresh = now; render(); }
    });
    FG.Events.on('selection:change', () => { render(); });
    FG.Events.on('recipe:change', () => { render(); });
    FG.Events.on('construction:change', () => { if (activeTab === 'build') render(); });
    FG.Events.on('blueprint:change', () => { if (activeTab === 'build') render(); });
    FG.Events.on('contract:change', () => { if (activeTab === 'contract') render(); });
    FG.Events.on('contract:complete', () => { if (activeTab === 'contract') render(); });
    FG.Events.on('message', () => { if (activeTab === 'log') render(); });
  }

  function render() {
    if (!FG.game || FG.game.state !== 'playing') return;
    if (activeTab === 'info') renderInfo();
    else if (activeTab === 'stats') renderStats();
    else if (activeTab === 'build') renderBuild();
    else if (activeTab === 'contract') renderContract();
    else if (activeTab === 'log') renderLog();
    bindActions();
  }

  // ================= 信息 =================
  function renderInfo() {
    const game = FG.game;
    const sel = game.selection;
    let html = '';
    if (!sel) {
      const ry = game.railway;
      html += `<div class="panel-sec"><h4>工厂概况</h4>
        <div class="info-grid">
          <div class="k">建筑数</div><div class="v">${game.totalBuildings()}</div>
          <div class="k">列车</div><div class="v">${ry ? ry.trains.length : 0}</div>
          <div class="k">火车站</div><div class="v">${ry ? ry.stationList().length : 0}</div>
          <div class="k">已研究</div><div class="v">${game.research.completed.size} / ${FG.Research.list().length}</div>
          <div class="k">游戏时间</div><div class="v">${FG.Utils.fmtTime(game.playTime)}</div>
        </div>
        <div style="color:var(--text-dim);font-size:11px;margin-top:8px;line-height:1.6">
          点击地图上的建筑查看详情。<br>
          拖动右键平移视野，滚轮缩放。<br>
          矿机→熔炉→组装机→科学包，最后发射卫星！<br>
          研究「铁路货运」后铺轨道、建车站，用列车跨区运料。
        </div></div>`;
    } else if (sel.isTrain) {
      html += trainInfo(sel);
    } else {
      html += buildingInfo(sel);
    }
    bodyEl().innerHTML = html;
  }

  function buildingInfo(b) {
    const game = FG.game;
    let h = `<div class="panel-sec"><h4>${b.def.name}</h4>
      <div class="info-grid">
        <div class="k">状态</div><div class="v status-${b.status}">${STATUS_NAMES[b.status] || b.status}</div>
        <div class="k">坐标</div><div class="v">(${b.x}, ${b.y})</div>
        ${b.def.beltTier !== undefined ? `<div class="k">方向</div><div class="v">${FG.Utils.dirName(b.dir)}</div>` : ''}
        ${b.def.inserterTier !== undefined ? `<div class="k">方向</div><div class="v">${FG.Utils.dirName(b.dir)}</div>` : ''}
        ${b.def.beltTier !== undefined ? `<div class="k">物品</div><div class="v">${b.items.length}/${FG.Config.BELT_CAP}</div>` : ''}
        ${b.type === 'pipe' ? `<div class="k">流体</div><div class="v">${(b.level / FG.Config.FLUID_PIPE_CAP * 100).toFixed(0)}%</div>` : ''}
        ${b.def.inserterTier !== undefined ? `<div class="k">手持</div><div class="v">${b.held ? FG.Items.byId(b.held.type).name : '空'}</div>` : ''}
        ${b.def.inserterTier !== undefined ? `<div class="k">筛选</div><div class="v">${b.filter ? FG.Items.byId(b.filter).name : '任意'}</div>` : ''}
        ${b.def.inserterTier !== undefined ? `<div class="k">按需供给</div><div class="v">${b.demandMode ? '开' : '关'}</div>` : ''}
        ${b.type === 'miner' ? `<div class="k">矿种</div><div class="v">${b.oreType ? FG.Items.byId(b.oreType).name : '无'}</div>` : ''}
        ${b.type === 'miner' && b.oreType ? `<div class="k">剩余</div><div class="v">${FG.Utils.fmtNum(game.map.amountAt(b.x, b.y))}</div>` : ''}
        ${b.def.recipeBuilding || b.type === 'lab' ? `<div class="k">供料优先级</div><div class="v">${({ high: '高', normal: '中', low: '低' })[b.priority] || '中'}</div>` : ''}
        ${b.def.recipeBuilding ? `<div class="k">产量</div><div class="v">${FG.Utils.fmtNum(b.totalCrafted)}</div>` : ''}
      </div>
      <div style="color:var(--text-dim);font-size:11px;margin-top:6px;line-height:1.5">${b.def.desc}</div></div>`;

    // 机械臂：筛选条件 + 下游缺料开关
    if (b.def.inserterTier !== undefined) {
      const solids = FG.Items.list().filter(i => !i.fluid);
      const wanted = FG.game.sim ? FG.game.sim.inserterWanted(b) : null;
      let needTxt = '—';
      if (wanted === null) needTxt = '任意（终端/箱子）';
      else if (!wanted.size) needTxt = '下游暂不缺料';
      else needTxt = Array.from(wanted).slice(0, 5).map(id => FG.Items.byId(id).name).join('、')
        + (wanted.size > 5 ? '…' : '');
      h += `<div class="panel-sec"><h4>取放规则</h4>
        <label class="cfg-row"><input type="checkbox" id="ins-demand" ${b.demandMode ? 'checked' : ''}>
          <span>按需供给：按下游缺口数量与在途预留联动（沿带追踪 ${FG.Config.BELT_TRACE_DEPTH} 格）</span></label>
        <div style="font-size:11px;color:var(--text-dim);margin:4px 0 6px">当前需求：<b style="color:var(--accent2)">${needTxt}</b></div>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px">筛选物品（点击切换，再点取消）：</div>
        <div class="filter-grid">
          <button class="filter-chip ${b.filter === null ? 'active' : ''}" data-filter="">任意</button>
          ${solids.map(i => `<button class="filter-chip ${b.filter === i.id ? 'active' : ''}" data-filter="${i.id}">${i.name}</button>`).join('')}
        </div></div>`;
    }

    // 生产线供料优先级（消费者：生产建筑 + 实验室）
    if (b.def.recipeBuilding || b.type === 'lab') {
      const cur = b.priority || 'normal';
      const opts = [['high', '高优先', '缺料时优先供料'], ['normal', '普通', '同级轮转公平供料'], ['low', '低优先', '物料紧张时最后供料']];
      h += `<div class="panel-sec"><h4>生产线供料优先级</h4>
        <div class="prio-row">
          ${opts.map(([id, name, tip]) => `<button class="prio-btn prio-${id} ${cur === id ? 'active' : ''}"
            data-prio="${id}" title="${tip}">${name}</button>`).join('')}
        </div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:4px;line-height:1.5">
          料源紧张时高优先级产线先得料，同优先级轮转均分；在途货物自动预留，在带面上以青色环标记。</div></div>`;
    }

    // 配方选择
    if (b.def.recipeBuilding) {
      const recipes = FG.Recipes.forBuilding(b.type);
      const r = b.recipe ? FG.Recipes.byId(b.recipe) : null;
      if (r) {
        const p = Math.min(1, b.progress / r.time);
        h += `<div class="panel-sec"><h4>生产进度</h4>
          <div class="progress-bar"><div class="fill" style="width:${(p * 100).toFixed(1)}%"></div></div>
          <div style="font-size:11px;color:var(--text-dim)">${r.name} · ${(p * 100).toFixed(0)}%</div></div>`;
      }
      h += `<div class="panel-sec"><h4>配方</h4><div class="recipe-list">`;
      for (const rc of recipes) {
        const unlocked = game.research.isRecipeUnlocked(rc.id);
        const ing = rc.ingredients.map(i => `${FG.Items.byId(i.item).name}×${i.count}`).join(' + ');
        h += `<button class="recipe-btn ${b.recipe === rc.id ? 'selected' : ''} ${unlocked ? '' : 'locked'}"
          data-recipe="${rc.id}"
          title="${unlocked ? '' : '需要研究：' + (FG.Research.byId(rc.unlockedBy) ? FG.Research.byId(rc.unlockedBy).name : rc.unlockedBy)}">
          <span class="rc-name">${rc.name}</span>
          <span class="rc-ing">${ing}</span>
        </button>`;
      }
      h += `</div></div>`;
    }

    // 输入/输出槽
    const hasSlots = Object.keys(b.slots.inputs).length || Object.keys(b.slots.outputs).length;
    if (hasSlots) {
      const recipe = b.recipe ? FG.Recipes.byId(b.recipe) : null;
      const needed = new Set(recipe ? recipe.ingredients.filter(i => !FG.Items.isFluid(i.item)).map(i => i.item) : []);
      h += `<div class="panel-sec"><h4>物料</h4>`;
      for (const k of Object.keys(b.slots.inputs)) {
        const s = b.slots.inputs[k];
        const orphan = b.def.recipeBuilding && !needed.has(k);
        h += slotRow((orphan ? '残留 ' : '输入 ') + FG.Items.byId(k).name, s, orphan);
      }
      for (const k of Object.keys(b.slots.outputs)) {
        const s = b.slots.outputs[k];
        h += slotRow('输出 ' + FG.Items.byId(k).name, s);
      }
      h += `</div>`;
    }
    // 流体罐
    if (Object.keys(b.fluidTanks).length) {
      h += `<div class="panel-sec"><h4>流体缓冲</h4>`;
      for (const k of Object.keys(b.fluidTanks)) {
        const cap = FG.Config.FLUID_TANK_CAP;
        h += `<div class="slot-row"><span class="sl-name">${FG.Items.byId(k).name}</span>
          <div class="sl-bar"><div class="fill" style="width:${(b.fluidTanks[k] / cap * 100).toFixed(0)}%"></div></div>
          <span class="sl-count">${FG.Utils.fmtNum(b.fluidTanks[k])}</span></div>`;
      }
      h += `</div>`;
    }
    // 箱子 / 火车站货位
    if (b.def.storage) {
      h += `<div class="panel-sec"><h4>${b.def.railStation ? '车站货位（接入产线供料）' : '存储'}</h4>`;
      for (const s of b.chest) {
        h += slotRow(s.type ? FG.Items.byId(s.type).name : '空', s);
      }
      h += `</div>`;
    }

    // 火车站：命名 + 在本站停靠的列车计划
    if (b.def.railStation) {
      h += `<div class="panel-sec"><h4>火车站</h4>
        <div class="info-grid">
          <div class="k">站号</div><div class="v">${b.stationId}</div>
        </div>
        <label class="cfg-row" style="margin:4px 0">站名
          <input type="text" id="station-name" class="txt-input" value="${(b.stationName || '').replace(/"/g, '&quot;')}" maxlength="12">
        </label>
        <div style="font-size:11px;color:var(--text-dim);line-height:1.5">
          机械臂/传送带可直接与本站货位转运：到站物料即接入按需物流，供周边产线使用。</div>`;
      const users = [];
      for (const tr of game.railway.trains) {
        tr.stops.forEach((s, i) => { if (s.stationId === b.stationId) users.push({ tr, i }); });
      }
      if (users.length) {
        h += `<div style="font-size:11px;color:var(--text-dim);margin-top:6px">停靠列车：</div>`;
        for (const u of users) {
          h += `<div class="slot-row"><span class="sl-name">🚆 ${u.tr.id}</span>
            <span style="color:var(--text)">第 ${u.i + 1} 站 · ${u.tr.stops[u.i].action === 'load' ? '装' : '卸'}
            ${u.tr.stops[u.i].item ? FG.Items.byId(u.tr.stops[u.i].item).name : '任意'}×${u.tr.stops[u.i].count}</span></div>`;
        }
      }
      h += `</div>`;
    }

    // 交付站：列出绑定到此站的进行中合同
    if (b.def.contractDock) {
      const list = game.contracts.contractAtDock(b.stationId);
      h += `<div class="panel-sec"><h4>📦 交付站 · 供货合同</h4>
        <div style="font-size:11px;color:var(--text-dim);line-height:1.5;margin-bottom:4px">
          列车把合同货物卸入本站货位后自动划扣记账；本站货位不参与施工备料，合同在途货物不会被抢。</div>`;
      if (!list.length) {
        h += `<div style="color:var(--text-dim);font-size:11px">本站暂无绑定合同，在右侧「合同」页接单时选择本站。</div>`;
      }
      for (const c of list) {
        h += `<div class="slot-row"><span class="sl-name">${FG.Items.byId(c.item).name} ${c.delivered}/${c.qty}</span>
          <span style="color:var(--accent2);font-size:11px">${c.reserve ? '本批到货 ' + c.reserve + '/' + c.batch + ' · ' : ''}剩 ${FG.Utils.fmtTime(game.contracts.remainSec(c))}</span></div>`;
      }
      h += `</div>`;
    }

    // 机务段：发车
    if (b.def.railDepot) {
      const trains = game.railway.trains;
      h += `<div class="panel-sec"><h4>机务段</h4>
        <div style="font-size:11px;color:var(--text-dim);line-height:1.5;margin-bottom:6px">
          向相邻空轨道编组一列新车；选中列车可编辑其运输计划（站点顺序与装卸规则）。</div>
        <div class="action-row"><button id="btn-spawn-train">🚆 编组列车</button></div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:4px">在役列车 ${trains.length} 列</div></div>`;
    }

    // 操作按钮
    h += `<div class="action-row">`;
    if (b.def.beltTier !== undefined || b.def.inserterTier !== undefined) {
      h += `<button id="btn-rotate">旋转</button>`;
    }
    h += `<button id="btn-demolish" class="danger">拆除</button>
      <button id="btn-clear">取消选择</button></div>`;

    return h;
  }

  function slotRow(name, s, warn) {
    return `<div class="slot-row${warn ? ' slot-warn' : ''}" title="${warn ? '当前配方不再需要，机械臂会将其运走' : ''}"><span class="sl-name">${name}</span>
      <div class="sl-bar"><div class="fill" style="width:${Math.min(100, s.count / s.cap * 100).toFixed(0)}%"></div></div>
      <span class="sl-count">${FG.Utils.fmtNum(s.count)}/${FG.Utils.fmtNum(s.cap)}</span></div>`;
  }

  // ================= 列车 =================
  const TRAIN_STATE_NAMES = { moving: '行驶中', docked: '装卸中', waiting: '等站排队', blocked: '堵死/让行', noroute: '断路（待轨网接通）', paused: '已停运', idle: '待命' };

  function trainInfo(tr) {
    const game = FG.game, ry = game.railway;
    let h = `<div class="panel-sec"><h4>🚆 列车 ${tr.id}</h4>
      <div class="info-grid">
        <div class="k">状态</div><div class="v status-${tr.state === 'docked' ? 'working' : tr.state === 'blocked' || tr.state === 'noroute' ? 'blocked' : 'idle'}">${TRAIN_STATE_NAMES[tr.state] || tr.state}</div>
        <div class="k">位置</div><div class="v">(${tr.x}, ${tr.y})</div>
        <div class="k">载货</div><div class="v">${tr.cargoTotal()}/${FG.Config.TRAIN_CARGO_CAP}</div>
        <div class="k">停站</div><div class="v">${tr.stops.length ? (tr.stopIdx + 1) + ' / ' + tr.stops.length : '无计划'}</div>
      </div></div>`;

    // 车载货物
    h += `<div class="panel-sec"><h4>车载货物</h4>`;
    if (!tr.cargo.length) h += `<div style="color:var(--text-dim);font-size:11px">空车</div>`;
    for (const s of tr.cargo) {
      h += `<div class="slot-row"><span class="sl-name">${FG.Items.byId(s.type).name}</span>
        <div class="sl-bar"><div class="fill" style="width:${(s.count / FG.Config.TRAIN_CARGO_CAP * 100).toFixed(0)}%"></div></div>
        <span class="sl-count">${FG.Utils.fmtNum(s.count)}</span></div>`;
    }
    h += `</div>`;

    // 运输计划
    const stations = ry.stationList();
    const solids = FG.Items.list().filter(i => !i.fluid);
    h += `<div class="panel-sec"><h4>运输计划（${tr.plan.loop === false ? '单程：末站卸完待命' : '循环执行'}）</h4>
      <label class="cfg-row"><input type="checkbox" id="train-loop" ${tr.plan.loop !== false ? 'checked' : ''}>
        <span>循环运输：末站完成后自动返回首站；取消则末站卸完即待命</span></label>`;
    if (!stations.length) {
      h += `<div style="color:var(--red);font-size:11px">图上还没有火车站：先在轨道旁建「火车站」，再为其添加停靠动作。</div>`;
    }
    tr.stops.forEach((s, i) => {
      const st = ry.stationById(s.stationId);
      h += `<div class="bp-plan ${i === tr.stopIdx && tr.state === 'docked' ? '' : ''}" style="margin-bottom:6px">
        <div class="bp-head"><span>第 ${i + 1} 站 · ${st ? st.stationName : '⚠ 站点已拆除'}</span>
          <span class="plan-st ${s.action === 'load' ? 'st-active' : 'st-waiting'}">${s.action === 'load' ? '装货' : '卸货'}</span></div>
        <div class="stop-cfg">
          <select data-stop-act="${i}">
            <option value="unload" ${s.action === 'unload' ? 'selected' : ''}>卸货（车→站）</option>
            <option value="load" ${s.action === 'load' ? 'selected' : ''}>装货（站→车）</option>
          </select>
          <select data-stop-item="${i}">
            <option value="">任意物品</option>
            ${solids.map(it => `<option value="${it.id}" ${s.item === it.id ? 'selected' : ''}>${it.name}</option>`).join('')}
          </select>
          <input type="number" min="1" max="${FG.Config.TRAIN_CARGO_CAP}" class="num-input" data-stop-count="${i}" value="${s.count}">
        </div>
        <div class="action-row" style="margin-top:4px">
          <button data-stop-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button data-stop-down="${i}" ${i === tr.stops.length - 1 ? 'disabled' : ''}>↓</button>
          <button data-stop-skip="${i}">立即跳过</button>
          <button data-stop-rm="${i}" class="danger">删除</button>
        </div>
      </div>`;
    });
    if (stations.length) {
      h += `<div class="stop-cfg" style="margin-top:6px">
        <select id="add-stop-station">
          ${stations.map(s => `<option value="${s.stationId}">${s.stationName} (${s.x},${s.y})</option>`).join('')}
        </select>
        <select id="add-stop-act">
          <option value="load">装货</option>
          <option value="unload">卸货</option>
        </select>
        <select id="add-stop-item">
          <option value="">任意物品</option>
          ${solids.map(it => `<option value="${it.id}">${it.name}</option>`).join('')}
        </select>
        <input type="number" id="add-stop-count" class="num-input" min="1" value="20">
        <button id="btn-add-stop">＋ 添加停靠</button>
      </div>`;
    }
    h += `</div>`;

    h += `<div class="action-row">
      <button id="btn-train-pause">${tr.plan.paused ? '▶ 恢复运行' : '⏸ 停运'}</button>
      <button id="btn-train-skip">跳过当前站</button>
      <button id="btn-remove-train" class="danger">解编（货落地）</button>
      <button id="btn-clear">取消选择</button></div>`;
    return h;
  }

  // ================= 统计 =================
  function renderStats() {
    const game = FG.game;
    const stats = game.stats;
    let h = '';

    // 概况
    h += `<div class="panel-sec"><h4>全局状态</h4>
      <div class="info-grid">
        <div class="k">建筑</div><div class="v">${game.totalBuildings()}</div>
        <div class="k">缺料</div><div class="v" style="color:${stats.agg.starveCount ? 'var(--red)' : 'inherit'}">${stats.agg.starveCount}</div>
        <div class="k">堵塞</div><div class="v" style="color:${stats.agg.blockCount ? 'var(--orange)' : 'inherit'}">${stats.agg.blockCount}</div>
      </div></div>`;

    // 瓶颈
    const defs = stats.deficits();
    h += `<div class="panel-sec"><h4>瓶颈分析（近 30s 消耗>产出）</h4>`;
    if (!defs.length && !stats.agg.starveCount && !stats.agg.blockCount) {
      h += `<div style="color:var(--text-dim);font-size:11px">暂无瓶颈，流水线运转良好</div>`;
    } else {
      for (const d of defs.slice(0, 8)) {
        h += `<div class="bottleneck-item warn">
          <span>${FG.Items.byId(d.id).name}</span>
          <span class="gap">缺口 ${FG.Utils.fmtRate(d.gap)}</span>
        </div>`;
      }
      for (const [item, n] of Object.entries(stats.agg.starveByItem)) {
        h += `<div class="bottleneck-item warn"><span>🔴 缺料：${FG.Items.byId(item).name}</span><span class="gap">${n} 座</span></div>`;
      }
      for (const [item, n] of Object.entries(stats.agg.blockByItem)) {
        h += `<div class="bottleneck-item warn"><span>🟠 堵塞：${FG.Items.byId(item).name}</span><span class="gap">${n} 座</span></div>`;
      }
    }
    h += `</div>`;

    // 图表
    h += `<div class="panel-sec"><h4>产量 / 消耗曲线（近 4 分钟）</h4>
      <div class="stats-toolbar" id="chart-items"></div>
      <div class="chart-box"><canvas id="chart-canvas"></canvas></div>
      <div style="font-size:10px;color:var(--text-dim)">
        <span style="color:var(--green)">■ 产出</span> &nbsp; <span style="color:var(--red)">■ 消耗</span>
      </div></div>`;

    // 汇总表
    h += `<div class="panel-sec"><h4>累计产量</h4>`;
    const ids = stats.itemIds().slice(0, 16);
    for (const id of ids) {
      const t = stats.total(id);
      const r = stats.rate(id);
      h += `<div class="rate-row"><span class="rk">${FG.Items.byId(id).name}</span>
        <span class="rv">${FG.Utils.fmtNum(t.p)} 累计 · ${FG.Utils.fmtRate(r.p)} 产出 · ${FG.Utils.fmtRate(r.c)} 消耗</span></div>`;
    }
    if (!ids.length) h += `<div style="color:var(--text-dim);font-size:11px">尚无生产记录</div>`;
    h += `</div>`;

    bodyEl().innerHTML = h;

    // 图表物品选择
    const chipWrap = document.getElementById('chart-items');
    if (chipWrap) {
      if (!chartItems.length) chartItems = ids.slice(0, 4);
      for (const id of ids) {
        const chip = document.createElement('span');
        chip.className = 'chip-item' + (chartItems.includes(id) ? ' active' : '');
        chip.textContent = FG.Items.byId(id).name;
        chip.onclick = () => {
          if (chartItems.includes(id)) chartItems = chartItems.filter(i => i !== id);
          else { if (chartItems.length < 5) chartItems.push(id); }
          renderStats();
        };
        chipWrap.appendChild(chip);
      }
      drawChart();
    }
  }

  function drawChart() {
    const cv = document.getElementById('chart-canvas');
    if (!cv) return;
    const stats = FG.game.stats;
    const dpr = window.devicePixelRatio || 1;
    cv.width = cv.clientWidth * dpr;
    cv.height = cv.clientHeight * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = cv.clientWidth, H = cv.clientHeight;
    ctx.fillStyle = '#12151d';
    ctx.fillRect(0, 0, W, H);
    if (!chartItems.length) return;

    // 计算 Y 范围
    let maxV = 1;
    const hist = stats.history;
    for (const id of chartItems) {
      for (const bk of hist) {
        maxV = Math.max(maxV, bk.p[id] || 0, bk.c[id] || 0);
      }
    }
    const pad = 4;
    const step = hist.length > 1 ? (W - pad * 2) / (hist.length - 1) : W;

    // 网格
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad + (H - pad * 2) * (i / 4);
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
    }

    for (const id of chartItems) {
      const color = FG.Items.byId(id).color;
      for (const [kind, key, kcol] of [['p', 'p', color], ['c', 'c', 'rgba(224,92,92,0.9)']]) {
        ctx.strokeStyle = kind === 'p' ? color : 'rgba(224,92,92,0.85)';
        ctx.lineWidth = kind === 'p' ? 2 : 1.5;
        ctx.beginPath();
        hist.forEach((bk, i) => {
          const v = bk[key][id] || 0;
          const x = pad + i * step;
          const y = H - pad - (v / maxV) * (H - pad * 2);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
    }
    // 图例当前值
    ctx.fillStyle = '#8b93a8';
    ctx.font = '10px Consolas';
    chartItems.forEach((id, i) => {
      const r = stats.rate(id);
      ctx.fillText(`${FG.Items.byId(id).name} 产出${FG.Utils.fmtRate(r.p)}`, pad + 4, 14 + i * 12);
    });
  }

  // ================= 施工（蓝图） =================
  function renderBuild() {
    const game = FG.game;
    const cons = game.construction;
    let h = '';

    // 当前蓝图（剪贴板）
    h += `<div class="panel-sec"><h4>蓝图</h4>`;
    h += `<div class="action-row" style="margin-bottom:6px">
      <button id="build-open-pipeline">⚡ 一键流水线 (P)</button>
    </div>`;
    if (game.blueprint) {
      const bp = game.blueprint;
      const cost = FG.Blueprint.costOf(bp);
      const costTxt = Object.keys(cost).map(k => FG.Items.byId(k).name + '×' + cost[k]).join('　');
      const preset = bp.fromPreset ? FG.Pipelines.byId(bp.fromPreset) : null;
      h += `<div class="info-grid">
        <div class="k">来源</div><div class="v">${preset ? '⚡ ' + preset.name : '框选蓝图'}</div>
        <div class="k">规模</div><div class="v">${bp.entries.length} 栋 · ${bp.w}×${bp.h}</div>
        <div class="k">建材</div><div class="v" style="font-family:inherit">${costTxt || '无'}</div>
      </div>
      <div style="color:var(--text-dim);font-size:11px;margin-top:6px;line-height:1.6">
        ${preset ? '左键提交整套施工 · <b>R</b> 旋转 · <b>F</b> 重新智能选位 · 可连续盖章。'
          : '按 <b>B</b> 放置预览：移动选位、<b>R</b> 旋转、左键提交施工计划；再按 <b>B</b> 重新框选。'}
      </div>`;
    } else {
      h += `<div style="color:var(--text-dim);font-size:11px;line-height:1.7">
        按 <b>P</b> 选择<b style="color:var(--accent2)">预设流水线</b>一键铺设，或按 <b>B</b> 框选已有产线生成蓝图。<br>
        施工计划自动从<b>箱子 / 地面物料堆</b>预留建材；缺料时等待，取消时返还。
      </div>`;
    }
    h += `</div>`;

    // 施工计划列表（高优先级排前，同级按提交顺序）
    const order = { high: 0, normal: 1, low: 2 };
    const sorted = cons.plans.slice().sort((a, b) => (order[a.priority] - order[b.priority]));
    h += `<div class="panel-sec"><h4>施工计划（${cons.plans.length}）</h4>`;
    if (!cons.plans.length) {
      h += `<div style="color:var(--text-dim);font-size:11px">暂无进行中的施工计划</div>`;
    }
    for (const p of sorted) {
      const total = p.entries.length;
      const done = p.entries.filter(e => e.state === 'done').length;
      const skipped = p.entries.filter(e => e.state === 'skip').length;
      let head = null;
      for (let i = p.cursor; i < total; i++) {
        if (p.entries[i].state === 'wait') { head = p.entries[i]; break; }
      }
      if (!head) head = p.entries.find(e => e.state === 'wait') || null;
      const st = planStatus(p);
      h += `<div class="bp-plan${p.paused ? ' is-paused' : ''}">
        <div class="bp-head"><span title="${p.id}">${p.kind === 'upgrade' ? '<span class="up-badge">升级</span>' : ''}${p.name}</span><span class="plan-st ${st.cls}">${st.txt}</span></div>
        <div class="progress-bar"><div class="fill" style="width:${(done / total * 100).toFixed(1)}%"></div></div>
        <div style="font-size:11px;color:var(--text-dim)">进度 ${done}/${total} 栋${skipped ? ' · 跳过 ' + skipped : ''}</div>`;

      // —— 分阶段施工：阶段列表 + 闸门设置 + 新增切分 ——
      h += renderStages(cons, p);

      // 计划优先级：高/中/低 —— 统一建材池分层拨付，高层未取料前低层等待
      h += `<div class="prio-row plan-prio">
        ${[['high', '高'], ['normal', '中'], ['low', '低']].map(([id, nm]) =>
          `<button class="prio-btn prio-${id} ${p.priority === id ? 'active' : ''}" data-plan-prio="${p.id}:${id}">${nm}</button>`).join('')}
      </div>`;

      // 前置依赖
      const depChips = p.deps.map(id => {
        const d = cons.byId(id);
        return d
          ? `<span class="dep-chip">⛓ ${d.name} <b data-plan-dep-rm="${p.id}:${id}" title="移除前置">×</b></span>`
          : '';
      }).join('');
      const canDeps = cons.plans.filter(q => q.id !== p.id && !p.deps.includes(q.id) && !dependsOn(q, p.id));
      h += `<div class="dep-row">${depChips}`;
      if (canDeps.length) {
        h += `<select class="dep-select" data-plan-dep-add="${p.id}">
          <option value="">＋ 设前置…</option>
          ${canDeps.map(q => `<option value="${q.id}">${q.name}</option>`).join('')}
        </select>`;
      }
      h += `</div>`;

      // 当前待建条目与条目级预留
      if (head && head.state === 'wait') {
        const def = FG.Buildings.byId(head.type);
        const cost = FG.Buildings.costOf(head.type);
        const parts = Object.keys(cost).map(k =>
          `${FG.Items.byId(k).name} ${Math.min(head.stock[k] || 0, cost[k])}/${cost[k]}`);
        const headName = head.from
          ? FG.Buildings.byId(head.from).name + ' → ' + def.name
          : def.name;
        h += `<div style="font-size:11px;color:var(--text-dim);margin-top:3px">${head.from ? '待换' : '待建'}：${headName}（${head.x},${head.y}）${parts.length ? ' · ' + parts.join(' · ') : ''}</div>`;
        if (!p.paused && !p.blocked && p.waiting) {
          h += `<div style="font-size:10px;color:var(--text-dim);margin-top:2px">前沿缺料：后续能凑齐建材的建筑会先行建成</div>`;
        }
        if (p.blocked) {
          const names = p.deps.map(id => cons.byId(id) ? cons.byId(id).name : null).filter(Boolean).join('、');
          h += `<div style="font-size:10px;color:var(--text-dim);margin-top:2px">等待前置计划完工：${names}</div>`;
        }
        if (!p.paused && !p.blocked && p.stageBlocked) {
          h += `<div style="font-size:10px;color:#7fc7ff;margin-top:2px">⏳ ${p.stageReason || '等待前置阶段放行'}</div>`;
        }
      }
      h += `<div class="action-row">
        <button data-plan-pause="${p.id}">${p.paused ? '▶ 继续' : '⏸ 暂停'}</button>
        <button data-cancel-plan="${p.id}" class="danger">取消并返还建材</button>
      </div></div>`;
    }
    h += `</div>`;
    bodyEl().innerHTML = h;
    const btnPipeline = bodyEl().querySelector('#build-open-pipeline');
    if (btnPipeline) btnPipeline.onclick = () => FG.Modals.pipelines();
    for (const el of bodyEl().querySelectorAll('[data-cancel-plan]')) {
      el.onclick = () => { FG.game.cancelConstruction(el.dataset.cancelPlan); };
    }
    for (const el of bodyEl().querySelectorAll('[data-plan-prio]')) {
      el.onclick = () => {
        const [id, pri] = el.dataset.planPrio.split(':');
        FG.game.setPlanPriority(id, pri);
      };
    }
    for (const el of bodyEl().querySelectorAll('[data-plan-pause]')) {
      el.onclick = () => { FG.game.togglePlanPaused(el.dataset.planPause); };
    }
    for (const el of bodyEl().querySelectorAll('[data-plan-dep-rm]')) {
      el.onclick = () => {
        const [id, dep] = el.dataset.planDepRm.split(':');
        FG.game.removePlanDep(id, dep);
      };
    }
    for (const sel of bodyEl().querySelectorAll('[data-plan-dep-add]')) {
      sel.onchange = () => {
        if (sel.value) FG.game.addPlanDep(sel.dataset.planDepAdd, sel.value);
      };
    }

    // —— 分阶段施工事件 ——
    // 在某条目前切分新阶段
    for (const sel of bodyEl().querySelectorAll('[data-stage-split]')) {
      sel.onchange = () => {
        const cut = parseInt(sel.value, 10);
        if (cut > 0) FG.game.splitPlanStage(sel.dataset.stageSplit, cut);
      };
    }
    // 删除阶段边界
    for (const el of bodyEl().querySelectorAll('[data-stage-rm]')) {
      el.onclick = () => {
        const [id, idx] = el.dataset.stageRm.split(':');
        FG.game.removePlanStage(id, parseInt(idx, 10));
      };
    }
    // 闸门模式：none=移除闸门 built=建成放行 trial=试产达标
    for (const sel of bodyEl().querySelectorAll('[data-stage-gate-mode]')) {
      sel.onchange = () => {
        const [id, idx] = sel.dataset.stageGateMode.split(':');
        const k = parseInt(idx, 10);
        const cons = FG.game.construction;
        const p = cons.byId(id);
        if (!p) return;
        const prev = p.stages[k] && p.stages[k].gate;
        if (sel.value === 'none') FG.game.setPlanStageGate(id, k, null);
        else if (sel.value === 'built') FG.game.setPlanStageGate(id, k, { mode: 'built' });
        else FG.game.setPlanStageGate(id, k, {
          mode: 'trial',
          item: prev && prev.item ? prev.item : null,
          n: prev && prev.n ? prev.n : FG.Config.STAGE_TRIAL_COUNT,
        });
      };
    }
    // 试产产物（空=任意产物）
    for (const sel of bodyEl().querySelectorAll('[data-stage-gate-item]')) {
      sel.onchange = () => {
        const [id, idx] = sel.dataset.stageGateItem.split(':');
        const k = parseInt(idx, 10);
        const p = FG.game.construction.byId(id);
        if (!p || !p.stages[k].gate || p.stages[k].gate.mode !== 'trial') return;
        FG.game.setPlanStageGate(id, k, {
          mode: 'trial', item: sel.value || null, n: p.stages[k].gate.n || FG.Config.STAGE_TRIAL_COUNT,
        });
      };
    }
    // 试产次数
    for (const inp of bodyEl().querySelectorAll('[data-stage-gate-n]')) {
      inp.onchange = () => {
        const [id, idx] = inp.dataset.stageGateN.split(':');
        const k = parseInt(idx, 10);
        const p = FG.game.construction.byId(id);
        if (!p || !p.stages[k].gate || p.stages[k].gate.mode !== 'trial') return;
        const n = Math.max(1, Math.min(999, parseInt(inp.value, 10) || FG.Config.STAGE_TRIAL_COUNT));
        FG.game.setPlanStageGate(id, k, { mode: 'trial', item: p.stages[k].gate.item || null, n });
      };
    }
  }

  /** 计划状态徽章 */
  function planStatus(p) {
    if (p.paused) return { txt: '已暂停', cls: 'st-paused' };
    if (p.blocked) return { txt: '等待前置', cls: 'st-blocked' };
    if (p.stageBlocked) return { txt: '阶段试产', cls: 'st-stage' };
    if (p.waiting) return { txt: '缺料等待', cls: 'st-waiting' };
    return { txt: '施工中', cls: 'st-active' };
  }

  /**
   * 分阶段施工区块：
   *  - 逐阶段显示进度/闸门状态（建成放行/试产达标 + 可选产物 + 次数）；
   *  - 闸门可在「无 / 建成 / 试产」间切换，试产产物取阶段建筑当前产物；
   *  - 可在当前待建条目之前切分新阶段、删除已建阶段边界。
   */
  function renderStages(cons, p) {
    const nStages = p.stages.length;
    let html = `<div class="stage-box">`;
    html += `<div class="stage-title">🧱 分阶段施工（${nStages} 阶段）</div>`;
    for (let k = 0; k < nStages; k++) {
      const { from, to } = cons.stageRange(p, k);
      const stageEntries = p.entries.slice(from, to);
      const sDone = stageEntries.filter(e => e.state === 'done').length;
      const sSkip = stageEntries.filter(e => e.state === 'skip').length;
      const isActive = (p.activeStage || 0) === k;
      const gate = k < nStages - 1 ? p.stages[k].gate : null;
      const isLast = k === nStages - 1;

      let stateCls = 'stg-done';
      let stateTxt = '✓ 已放行';
      if (isActive && p.stageBlocked) { stateCls = 'stg-trial'; stateTxt = '⏳ 试产中'; }
      else if (isActive) { stateCls = 'stg-active'; stateTxt = '▶ 施工中'; }
      else if (!gate || gate.opened) { stateCls = 'stg-done'; stateTxt = isLast ? '末阶段' : '✓ 已放行'; }
      else { stateCls = 'stg-pending'; stateTxt = '待开工'; }

      html += `<div class="stage-row ${isActive ? 'is-active' : ''}">
        <div class="stage-head">
          <span class="stage-name">阶段 ${k + 1}</span>
          <span class="stage-state ${stateCls}">${stateTxt}</span>
          <span class="stage-cnt">${sDone}/${stageEntries.length} 栋${sSkip ? '（跳 ' + sSkip + '）' : ''}</span>
        </div>`;

      // 闸门编辑（末尾阶段无闸门）
      if (!isLast) {
        const mode = gate ? gate.mode : 'none';
        const trialItems = cons.stageTrialItems(p, k);
        html += `<div class="gate-row">
          <span class="gate-label">放行：</span>
          <select data-stage-gate-mode="${p.id}:${k}">
            <option value="none" ${mode === 'none' ? 'selected' : ''}>无（建成即放行）</option>
            <option value="built" ${mode === 'built' ? 'selected' : ''}>建成放行</option>
            <option value="trial" ${mode === 'trial' ? 'selected' : ''}>试产达标…</option>
          </select>`;
        if (mode === 'trial') {
          const need = gate.n || FG.Config.STAGE_TRIAL_COUNT;
          html += `<select data-stage-gate-item="${p.id}:${k}" title="试产产物（空=任意产物）">
            <option value="" ${!gate.item ? 'selected' : ''}>任意产物</option>
            ${trialItems.map(it => `<option value="${it}" ${gate.item === it ? 'selected' : ''}>${FG.Items.byId(it).name}</option>`).join('')}
          </select>
          <input type="number" min="1" max="999" class="gate-n" value="${need}" data-stage-gate-n="${p.id}:${k}" title="需要完成的生产次数">
          <span class="gate-prog">${cons.trialProgress(p, k)}/${need}</span>`;
        }
        html += `</div>`;
        // 已开放闸门再收紧（无/试产）会重新挂起后续阶段
        if (gate && gate.opened) {
          html += `<div class="gate-hint">已放行：收紧闸门将重新挂起后续施工</div>`;
        }
        // 删除该阶段边界（与下一阶段合并，闸门一并移除 = 取消前置）
        html += `<b class="stage-rm" data-stage-rm="${p.id}:${k}" title="删除此阶段边界（并入下一阶段、取消该闸门）">×</b>`;
      }
      html += `</div>`;
    }

    // 在「下一个待建条目」前切分新阶段（光标位置只能在待建区域，已建部分不可再切）
    const firstWait = p.entries.findIndex(e => e.state === 'wait');
    html += `<div class="stage-add">
      <select data-stage-split="${p.id}">
        <option value="">＋ 在条目前切分新阶段…</option>`;
    if (firstWait >= 0) {
      for (let i = Math.max(1, firstWait); i < p.entries.length; i++) {
        if (p.stages.some(s => s.cut === i)) continue;
        const e = p.entries[i];
        const nm = e.from
          ? FG.Buildings.byId(e.from).name + '→' + FG.Buildings.byId(e.type).name
          : FG.Buildings.byId(e.type).name;
        html += `<option value="${i}">#${i + 1} ${nm}（${e.x},${e.y}）前</option>`;
      }
    }
    html += `</select></div>`;
    html += `</div>`;
    return html;
  }

  /** q 是否（经依赖链传递）依赖 planId —— 用于过滤会成环的前置选项 */
  function dependsOn(q, planId) {
    const cons = FG.game.construction;
    const stack = q.deps.slice();
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (id === planId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const d = cons.byId(id);
      if (d) stack.push(...d.deps);
    }
    return false;
  }

  // ================= 供货合同 =================
  function renderContract() {
    const game = FG.game, mgr = game.contracts;
    mgr.ensureBoard(game.playTime, false);
    const unlocked = game.research.isDone('railTransport');
    let h = '';

    h += `<div class="panel-sec"><h4>📦 供货合同</h4>`;
    if (!unlocked) {
      h += `<div style="color:var(--text-dim);font-size:11px;line-height:1.7">
        研究科技树中的「<b>铁路货运</b>」后解锁供货合同。<br><br>
        接单后用列车把合同货物运到一座<b>交付站</b>，系统分批划扣、独立记账；
        合同货物在共同料源处与生产、施工统一争料，完成后发放<b>科研物资</b>。逾期未交或取消会释放未满批预留。</div>`;
      bodyEl().innerHTML = h;
      return;
    }
    const docks = mgr.docks();
    h += `<div style="font-size:11px;color:var(--text-dim);line-height:1.6;margin-bottom:6px">
      列车把货物卸入<b>交付站</b>货位即自动划扣：每凑满一批记一笔交付，全部交完发放科研物资到该站货位。<br>
      进行中 ${mgr.active.length}/${FG.Config.CONTRACT_MAX_ACTIVE} · 交付站 ${docks.length} 座
      <span style="float:right"><a id="ct-refresh" style="color:var(--accent2);cursor:pointer">换一批 ↻</a></span></div>`;
    h += `</div>`;

    // —— 进行中合同 ——
    h += `<div class="panel-sec"><h4>进行中（${mgr.active.length}）</h4>`;
    if (!mgr.active.length) h += `<div style="color:var(--text-dim);font-size:11px">暂无进行中的合同，去看板接单。</div>`;
    for (const c of mgr.active) {
      const remain = mgr.remainSec(c);
      const overdueSoon = remain <= 60;
      const totalDone = c.delivered + Math.floor(c.reserve / c.batch) * c.batch;
      const pct = Math.min(100, c.delivered / c.qty * 100);
      const batches = c.qty / c.batch;
      const doneBatches = c.delivered / c.batch;
      const dock = mgr.dockById(c.dockStationId);
      h += `<div class="bp-plan ct-active">
        <div class="bp-head">
          <span title="${c.id}">📦 ${FG.Items.byId(c.item).name} ×${c.qty}</span>
          <span class="plan-st ${overdueSoon ? 'st-blocked' : 'st-active'}">⏳ ${FG.Utils.fmtTime(remain)}</span>
        </div>
        <div class="progress-bar"><div class="fill" style="width:${pct.toFixed(1)}%;background:linear-gradient(90deg,#58c26f,#8fd9a3)"></div></div>
        <div style="font-size:11px;color:var(--text-dim)">
          已交付 <b style="color:var(--green)">${c.delivered}/${c.qty}</b>（${doneBatches}/${batches} 批）
          ${c.reserve ? `· 本批已到 <b style="color:var(--accent2)">${c.reserve}</b>/${c.batch}` : ''}
        </div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:2px">
          交付站：${dock ? dock.stationName : '<span style="color:var(--red)">⚠ ' + (c.dockName || c.dockStationId) + ' 已拆除</span>'}
          · 奖励 <b style="color:var(--yellow)">${FG.Items.byId(c.reward.item).name}×${c.reward.count}</b>
        </div>
        <div class="action-row" style="margin-top:5px">
          <button data-ct-cancel="${c.id}" class="danger">取消（释放未满批预留）</button>
        </div>
      </div>`;
    }
    h += `</div>`;

    // —— 看板报价 ——
    h += `<div class="panel-sec"><h4>合同看板（${mgr.offers.length}）</h4>`;
    if (!docks.length) {
      h += `<div style="color:var(--orange);font-size:11px;margin-bottom:6px">图上还没有「交付站」：先在轨道旁建一座交付站才能接单（列车停靠卸货）。</div>`;
    }
    for (const o of mgr.offers) {
      const batches = o.qty / o.batch;
      h += `<div class="bp-plan ct-offer">
        <div class="bp-head"><span>${FG.Items.byId(o.item).name} ×${o.qty}</span>
          <span class="plan-st st-waiting">${batches} 批 · 每批 ${o.batch}</span></div>
        <div style="font-size:11px;color:var(--text-dim);margin:2px 0">
          期限 ${FG.Utils.fmtTime(o.durationSec)} · 奖励 <b style="color:var(--yellow)">${FG.Items.byId(o.reward.item).name}×${o.reward.count}</b>
        </div>
        <div class="stop-cfg" style="margin-top:3px">
          <select data-ct-dock="${o.oid}">
            ${docks.length ? docks.map(d => `<option value="${d.stationId}">${d.stationName} (${d.x},${d.y})</option>`).join('') : '<option value">无交付站</option>'}
          </select>
          <button data-ct-accept="${o.oid}" ${docks.length ? '' : 'disabled'}>接单</button>
        </div>
      </div>`;
    }
    h += `</div>`;

    // —— 最近结算 ——
    if (mgr.history.length) {
      h += `<div class="panel-sec"><h4>最近结算</h4>`;
      const STNAME = { done: ['✅ 完成', 'var(--green)'], overdue: ['⏰ 逾期', 'var(--red)'], canceled: ['取消', 'var(--text-dim)'] };
      for (const c of mgr.history.slice(0, 8)) {
        const [nm, col] = STNAME[c.status] || [c.status, 'var(--text-dim)'];
        const rw = c.reward ? FG.Items.byId(c.reward.item).name + '×' + c.reward.count : '—';
        h += `<div class="slot-row"><span class="sl-name" style="color:${col}">${nm}</span>
          <span style="color:var(--text-dim);font-size:11px">${FG.Items.byId(c.item).name} ${c.delivered}/${c.qty} · ${rw}</span></div>`;
      }
      h += `</div>`;
    }

    bodyEl().innerHTML = h;

    const refr = document.getElementById('ct-refresh');
    if (refr) refr.onclick = () => mgr.refreshBoard();
    for (const btn of bodyEl().querySelectorAll('[data-ct-accept]')) {
      btn.onclick = () => {
        const oid = btn.dataset.ctAccept;
        const sel = bodyEl().querySelector(`[data-ct-dock="${oid}"]`);
        const sid = sel ? sel.value : (docks[0] && docks[0].stationId);
        if (sid) mgr.accept(oid, sid);
      };
    }
    for (const btn of bodyEl().querySelectorAll('[data-ct-cancel]')) {
      btn.onclick = () => mgr.cancel(btn.dataset.ctCancel);
    }
  }

  // ================= 日志 =================
  function renderLog() {
    const game = FG.game;
    let h = `<div class="panel-sec"><h4>事件日志</h4><div class="log-list">`;
    for (const l of game.log) {
      const t = new Date(l.t);
      h += `<div class="log-line msg-${l.cls}"><span class="log-time">${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}</span>${l.text}</div>`;
    }
    h += `</div></div>`;
    bodyEl().innerHTML = h;
    bodyEl().scrollTop = bodyEl().scrollHeight;
  }

  function bindTrainActions(tr) {
    const refresh = () => render();
    const loopChk = document.getElementById('train-loop');
    if (loopChk) loopChk.onchange = () => { tr.plan.loop = loopChk.checked; refresh(); };
    document.querySelectorAll('[data-stop-act]').forEach(sel => {
      sel.onchange = () => tr.updateStop(+sel.dataset.stopAct, { action: sel.value });
    });
    document.querySelectorAll('[data-stop-item]').forEach(sel => {
      sel.onchange = () => tr.updateStop(+sel.dataset.stopItem, { item: sel.value || null });
    });
    document.querySelectorAll('[data-stop-count]').forEach(inp => {
      inp.onchange = () => { const n = parseInt(inp.value, 10); tr.updateStop(+inp.dataset.stopCount, { count: isNaN(n) ? 1 : n }); refresh(); };
    });
    document.querySelectorAll('[data-stop-rm]').forEach(btn => {
      btn.onclick = () => { tr.removeStop(+btn.dataset.stopRm); refresh(); };
    });
    document.querySelectorAll('[data-stop-skip]').forEach(btn => {
      btn.onclick = () => {
        const i = +btn.dataset.stopSkip;
        if (i === tr.stopIdx) tr.skip();
        else tr.removeStop(i);
        refresh();
      };
    });
    document.querySelectorAll('[data-stop-up]').forEach(btn => {
      btn.onclick = () => { moveStop(tr, +btn.dataset.stopUp, -1); refresh(); };
    });
    document.querySelectorAll('[data-stop-down]').forEach(btn => {
      btn.onclick = () => { moveStop(tr, +btn.dataset.stopDown, 1); refresh(); };
    });
    const add = document.getElementById('btn-add-stop');
    if (add) add.onclick = () => {
      const sid = document.getElementById('add-stop-station').value;
      const act = document.getElementById('add-stop-act').value;
      const item = document.getElementById('add-stop-item').value || null;
      const n = parseInt(document.getElementById('add-stop-count').value, 10);
      tr.addStop(sid, act, item, isNaN(n) ? 1 : n);
      refresh();
    };
    const pause = document.getElementById('btn-train-pause');
    if (pause) pause.onclick = () => { tr.setPaused(!tr.plan.paused); refresh(); };
    const skip = document.getElementById('btn-train-skip');
    if (skip) skip.onclick = () => { tr.skip(); refresh(); };
    const rm = document.getElementById('btn-remove-train');
    if (rm) rm.onclick = () => FG.game.removeTrainSelection();
  }

  /** 上移/下移停靠站（简单交换；当前停站索引同步） */
  function moveStop(tr, i, dir) {
    const j = i + dir;
    if (j < 0 || j >= tr.stops.length) return;
    const arr = tr.stops;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    if (tr.stopIdx === i) tr.stopIdx = j;
    else if (tr.stopIdx === j) tr.stopIdx = i;
  }

  function bindActions() {
    const game = FG.game;
    // 火车站改名
    const nameInp = document.getElementById('station-name');
    if (nameInp) nameInp.onchange = () => {
      const b = game.selection;
      if (b && b.def.railStation) b.stationName = nameInp.value.trim() || ('站点 ' + b.stationId.slice(1));
    };
    // 机务段发车
    const spawn = document.getElementById('btn-spawn-train');
    if (spawn) spawn.onclick = () => {
      const depot = game.selection;
      const tr = game.railway.spawnTrain(depot);
      if (tr) {
        game.logMsg('🚆 已编组列车 ' + tr.id + '：选中列车添加停靠站点与装卸规则', 'unlock');
        game.selectBuilding(tr);
      } else {
        game.logMsg('⚠ 机务段四周没有空闲轨道（接轨格被占或未铺轨）', 'error');
      }
    };
    // 列车计划编辑
    const sel = game.selection;
    if (sel && sel.isTrain) bindTrainActions(sel);

    const btn = document.getElementById('btn-demolish');
    if (btn) btn.onclick = () => {
      if (FG.game.selection && FG.game.selection.isTrain) FG.game.removeTrainSelection();
      else if (FG.game.selection) FG.game.removeBuilding(FG.game.selection);
    };
    const rot = document.getElementById('btn-rotate');
    if (rot) rot.onclick = () => {
      const b = FG.game.selection;
      if (b && !b.isTrain) { b.dir = (b.dir + 1) % 4; render(); }
    };
    const clr = document.getElementById('btn-clear');
    if (clr) clr.onclick = () => { FG.game.selection = null; FG.Events.emit('selection:change'); };
    for (const el of document.querySelectorAll('.recipe-btn')) {
      el.onclick = () => {
        const b = FG.game.selection;
        if (!b) return;
        const rid = el.dataset.recipe;
        if (!FG.game.research.isRecipeUnlocked(rid)) return;
        FG.game.setRecipe(b, rid);
      };
    }
    const dm = document.getElementById('ins-demand');
    if (dm) dm.onchange = () => {
      const b = FG.game.selection;
      if (b) { b.demandMode = dm.checked; render(); }
    };
    for (const el of document.querySelectorAll('.filter-chip')) {
      el.onclick = () => {
        const b = FG.game.selection;
        if (!b) return;
        b.filter = el.dataset.filter || null;
        render();
      };
    }
    for (const el of document.querySelectorAll('.prio-btn')) {
      el.onclick = () => {
        const b = FG.game.selection;
        if (!b) return;
        b.priority = el.dataset.prio;
        render();
      };
    }
  }

  return { init, render, bindActions };
})();
