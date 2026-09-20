/**
 * FG.Modals —— 弹窗系统：新建游戏 / 存档管理 / 菜单 / 帮助
 */
FG.Modals = (() => {
  const root = () => document.getElementById('modal-root');

  function show(html) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `<div class="modal">${html}</div>`;
    root().appendChild(mask);
    return mask;
  }

  function closeAll() {
    root().querySelectorAll('.modal-mask').forEach(m => m.remove());
  }

  // ================= 新建游戏 =================
  let sel = { preset: 'greenfield', size: 'medium', slot: '1' };

  function newGame() {
    let html = `<h2>🏭 新建工厂</h2>`;
    html += `<h3>选择地图场景</h3><div id="ng-maps">`;
    for (const p of FG.Maps.PRESETS) {
      html += `<div class="map-card" data-preset="${p.id}">
        <div class="mc-name">${p.name}</div>
        <div class="mc-desc">${p.desc}</div>
      </div>`;
    }
    html += `</div>`;

    html += `<h3>地图尺寸</h3><div style="display:flex;gap:6px" id="ng-size">`;
    for (const [k, v] of Object.entries(FG.Config.MAP_SIZES)) {
      html += `<button data-size="${k}">${v.label} (${v.w}×${v.h})</button>`;
    }
    html += `</div>`;

    html += `<h3>随机种子</h3>
      <div class="seed-row"><input id="ng-seed" type="text" placeholder="留空随机">
      <button id="ng-seed-rand">🎲</button></div>`;

    html += `<h3>工厂名称</h3>
      <div class="seed-row"><input id="ng-name" type="text" value="我的工厂"></div>`;

    html += `<h3>保存槽位</h3><div style="display:flex;gap:6px" id="ng-slot">`;
    for (const s of ['1', '2', '3']) {
      const info = FG.Save.listSlots().find(x => x.id === s);
      html += `<button data-slot="${s}" class="${s === sel.slot ? 'active' : ''}">${s}${info.exists ? '（已有存档）' : ''}</button>`;
    }
    html += `</div>`;

    html += `<div class="m-btns"><button id="ng-cancel">取消</button><button id="ng-start" class="active">开始游戏</button></div>`;

    const mask = show(html);
    const q = (s) => mask.querySelector(s);

    q('#ng-maps').querySelectorAll('.map-card').forEach(c => {
      c.classList.toggle('active', c.dataset.preset === sel.preset);
      c.style.borderColor = c.dataset.preset === sel.preset ? 'var(--accent)' : '';
      c.onclick = () => { sel.preset = c.dataset.preset; newGame(); };
    });
    q('#ng-size').querySelectorAll('button').forEach(b => {
      b.classList.toggle('active', b.dataset.size === sel.size);
      b.onclick = () => { sel.size = b.dataset.size; newGame(); };
    });
    q('#ng-slot').querySelectorAll('button').forEach(b => {
      b.onclick = () => { sel.slot = b.dataset.slot; newGame(); };
    });
    q('#ng-seed-rand').onclick = () => { q('#ng-seed').value = Math.floor(Math.random() * 99999); };
    q('#ng-cancel').onclick = closeAll;
    q('#ng-start').onclick = () => {
      const seed = parseInt(q('#ng-seed').value, 10);
      const name = q('#ng-name').value.trim() || '我的工厂';
      const s = (seed && seed > 0) ? seed : Math.floor(Math.random() * 99999);
      closeAll();
      FG.game.newGame(sel.preset, sel.size, s, sel.slot, name);
      FG.game.saveTo(sel.slot, name);
    };
  }

  // ================= 存档管理 =================
  function saveLoad() {
    let html = `<h2>💾 存档管理</h2>`;
    html += `<div style="color:var(--text-dim);font-size:11px;margin-bottom:10px">自动存档每 ${FG.Config.AUTOSAVE_SEC}s 写入「auto」槽位。可导出 JSON 备份或导入恢复。</div>`;

    const slots = ['1', '2', '3', 'auto'];
    for (const id of slots) {
      const info = FG.Save.listSlots().find(x => x.id === id);
      html += `<div class="save-row" data-slot="${id}">
        <div class="sr-info">
          ${info.exists
            ? `<div class="sr-name">${info.meta.name || '存档'}</div>
               <div class="sr-meta">槽位 ${id} · 游戏时间 ${FG.Utils.fmtTime(info.meta.playTime || 0)} · ${info.meta.date || ''}</div>`
            : `<div class="sr-empty">槽位 ${id} · 空</div>`}
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          <button class="sl-load" ${info.exists ? '' : 'disabled'}>载入</button>
          <button class="sl-save">保存</button>
          <button class="sl-export" ${info.exists ? '' : 'disabled'}>导出</button>
          <button class="sl-del danger" ${info.exists ? '' : 'disabled'}>删除</button>
          <label class="sl-import" style="cursor:pointer"><input type="file" accept=".json" hidden>导入</label>
        </div>
      </div>`;
    }
    html += `<div class="m-btns"><button id="sl-close">关闭</button></div>`;

    const mask = show(html);
    mask.querySelectorAll('.save-row').forEach(row => {
      const id = row.dataset.slot;
      const q = (s) => row.querySelector(s);
      q('.sl-load').onclick = () => {
        closeAll();
        FG.game.loadSlot(id);
      };
      q('.sl-save').onclick = () => {
        FG.game.saveTo(id, null);
        saveLoad();
      };
      q('.sl-export').onclick = () => { FG.Save.exportSlot(id); };
      q('.sl-del').onclick = () => {
        FG.Save.deleteSlot(id);
        if (FG.game.saveInfo.slot === id) FG.game.saveInfo.slot = null;
        saveLoad();
      };
      q('.sl-import input').onchange = (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
          const obj = FG.Save.importText(String(reader.result));
          if (!obj) { alert('导入失败：无效的存档文件'); return; }
          FG.Save.saveToSlot(id, obj.meta || { name: '导入存档', playTime: 0, date: new Date().toLocaleString('zh-CN') }, obj.data);
          saveLoad();
        };
        reader.readAsText(f);
      };
    });
    mask.querySelector('#sl-close').onclick = closeAll;
  }

  // ================= 菜单 =================
  function menu() {
    const html = `<h2>☰ 菜单</h2>
      <div style="display:flex;flex-direction:column;gap:8px;min-width:220px">
        <button id="m-continue">继续游戏</button>
        <button id="m-save">保存游戏</button>
        <button id="m-saveload">存档管理</button>
        <button id="m-tech">科技树</button>
        <button id="m-pipeline">⚡ 一键流水线</button>
        <button id="m-new">新建游戏</button>
        <button id="m-help">帮助</button>
        <button id="m-close" class="danger">关闭</button>
      </div>`;
    const mask = show(html);
    mask.querySelector('#m-continue').onclick = closeAll;
    mask.querySelector('#m-save').onclick = () => {
      closeAll();
      if (FG.game.saveInfo.slot) FG.game.saveTo(FG.game.saveInfo.slot, null);
      else saveLoad();
    };
    mask.querySelector('#m-saveload').onclick = () => { closeAll(); saveLoad(); };
    mask.querySelector('#m-tech').onclick = () => { closeAll(); FG.Tech.open(); };
    mask.querySelector('#m-pipeline').onclick = () => { closeAll(); pipelines(); };
    mask.querySelector('#m-new').onclick = () => { closeAll(); newGame(); };
    mask.querySelector('#m-help').onclick = () => { closeAll(); help(); };
    mask.querySelector('#m-close').onclick = closeAll;
  }

  // ================= 帮助 =================
  function help() {
    const html = `<h2>📖 帮助</h2>
      <div style="font-size:12px;line-height:1.8;color:var(--text)">
        <b style="color:var(--accent)">目标</b>：从矿脉开采资源，经过 冶炼→零件→科学包 的流水线，研究科技并最终发射<b>卫星</b>。<br><br>
        <b style="color:var(--accent)">玩法</b>：<br>
        1. 放置<b>矿机</b>在矿脉上 → 用<b>机械臂</b>装入<b>传送带</b>；<br>
        2. <b>熔炉</b>冶炼矿石（右侧面板切配方）→ <b>组装机</b>加工零件；<br>
        3. 组装机生产<b>科学包</b> → 送入<b>实验室</b>；<br>
        4. 在 <b>🔬 科技树</b> 中选择研究，解锁新建筑与配方；<br>
        5. 水泵+管道把<b>水</b>送入<b>炼油厂</b>裂解<b>原油</b>，流体走<b>管道</b>。<br><br>
        <b style="color:var(--accent)">操作</b>：<br>
        左键 放置/选择 · 右键拖拽 平移 · 滚轮 缩放<br>
        R 旋转 · Del 拆除 · 空格 暂停 · T 科技树<br>
        Esc 取消放置 · S 状态高亮 · 1-4 游戏速度<br>
        B 蓝图：框选产线 → 移动预览、R 旋转 → 左键提交施工<br>
        U 原地升级：框选产线 → 预览高级型号与备料 → 左键提交分步替换<br>
        P <b style="color:var(--accent2)">一键流水线</b>：选择预设产线（采石/冶炼/制造/科研）→<br>
        自动搜索落点并预览 → 左键一键提交整套工程，F 重新选位<br><br>
        <b style="color:var(--accent2)">⚡ 一键流水线</b>：<br>
        预设产线含采集、传送带、机械臂、生产建筑与成品箱，配方/筛选全配好；<br>
        矿机自动对准矿脉、水泵自动找水域；科技不足的产线会锁定并提示所需科技。<br><br>
        <b style="color:var(--accent)">蓝图施工</b>：<br>
        施工计划按科技与地形校验，自动从<b>箱子/地面物料堆</b>预留建材；<br>
        缺料时等待补货，可在「施工」页取消并返还建材；<br>
        建成后自动接入生产调度，施工进度随存档恢复。<br><br>
        <b style="color:var(--accent)">⬆ 原地升级 (U)</b>：<br>
        框选产线，框内建筑批量替换为<b>已解锁的最高级型号</b>（石炉→钢炉、<br>
        组装机→二级组装机、传送带→快速/极速、机械臂→快速机械臂）；<br>
        按施工计划备料分步切换，配方/库存/在途物料保留，暂停或取消返还未用建材。<br><br>
        <b style="color:var(--accent)">提示</b>：缺料(红)与堵塞(橙)会用颜色高亮，统计面板会列出瓶颈。
      </div>
      <div class="m-btns"><button id="h-close">关闭</button></div>`;
    const mask = show(html);
    mask.querySelector('#h-close').onclick = closeAll;
  }

  // ================= 一键流水线 =================
  function pipelines() {
    if (FG.game.state !== 'playing') return;
    const presets = FG.Pipelines.list();
    let html = `<h2>⚡ 一键流水线</h2>
      <div style="color:var(--text-dim);font-size:11px;line-height:1.7;margin-bottom:10px">
        选择一套预设产线，系统会<b style="color:var(--accent2)">自动搜索合适落点</b>（矿机对准矿脉、水泵紧邻水域）并进入预览：<br>
        <b>左键</b> 提交整套施工计划 · <b>R</b> 旋转 · <b>F</b> 重新智能选位 · <b>Esc</b> 取消。<br>
        施工计划自动从<b>箱子/地面物料堆</b>预留建材，缺料时挂起等待，建成即接入生产调度。
      </div>
      <div class="pl-grid">`;
    for (const p of presets) {
      const bp = FG.Pipelines.blueprintOf(p);
      const cost = FG.Blueprint.costOf(bp);
      const locked = FG.Pipelines.lockedReasons(p, FG.game);
      const costStr = Object.keys(cost).map(k =>
        `${FG.Items.byId(k).name}×${cost[k]}`).join(' · ');
      html += `<div class="pl-card${locked.length ? ' locked' : ''}" data-pipeline="${p.id}">
        <div class="pl-head"><span class="pl-icon">${p.icon}</span><span class="pl-name">${p.name}</span>
          <span class="pl-size">${bp.w}×${bp.h} · ${bp.entries.length} 栋</span></div>
        <div class="pl-chain">${p.chain}</div>
        <div class="pl-desc">${p.desc}</div>
        <div class="pl-cost">建材：${costStr || '无'}</div>
        ${locked.length ? `<div class="pl-lock">🔒 ${locked.join('、')}</div>` : '<div class="pl-go">点击放置 →</div>'}
      </div>`;
    }
    html += `</div><div class="m-btns"><button id="pl-close">关闭</button></div>`;

    const mask = show(html);
    mask.querySelector('#pl-close').onclick = closeAll;
    mask.querySelectorAll('.pl-card').forEach(card => {
      card.onclick = () => {
        if (card.classList.contains('locked')) return;
        const p = FG.Pipelines.byId(card.dataset.pipeline);
        closeAll();
        FG.game.startPipeline(p);
      };
    });
  }

  return { newGame, saveLoad, menu, help, pipelines, show, closeAll };
})();
