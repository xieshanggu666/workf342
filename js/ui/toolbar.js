/**
 * FG.Toolbar —— 左侧建筑工具栏
 */
FG.Toolbar = (() => {
  const catsEl = () => document.getElementById('tb-cats');
  const listEl = () => document.getElementById('tb-buildings');
  const hintEl = () => document.getElementById('tb-hint');
  let activeCat = 'extraction';

  const HINTS = {
    extraction: '左键放置；右键/Esc 取消。矿机需放在矿脉上，水泵放水域旁。',
    production: '放置后用右侧面板选择配方；用机械臂连接传送带与建筑。',
    logistics: '传送带按住拖拽可连成直线；机械臂 R 旋转；管道连接产液与用液建筑。轨道拖拽铺设，车站旁建机务段发车；交付站可承接供货合同。',
    science: '实验室需要科学包，由组装机生产；研究在 🔬 科技树中选择。',
  };

  function init() {
    renderCats();
    renderBuildings();
    hintEl().textContent = HINTS[activeCat];
    FG.Events.on('research:complete', renderBuildings);
    FG.Events.on('ghost:change', () => { renderBuildings(); });
    FG.Events.on('game:start', () => { renderBuildings(); });
  }

  function renderCats() {
    catsEl().innerHTML = '';
    for (const cat of FG.Buildings.CATS) {
      const b = document.createElement('button');
      b.textContent = cat.name;
      b.className = cat.id === activeCat ? 'active' : '';
      b.onclick = () => {
        activeCat = cat.id;
        renderCats();
        renderBuildings();
        hintEl().textContent = HINTS[cat.id];
      };
      catsEl().appendChild(b);
    }
  }

  function renderBuildings() {
    listEl().innerHTML = '';
    const game = FG.game;
    for (const def of FG.Buildings.byCat(activeCat)) {
      const unlocked = game.research.isBuildingUnlocked(def.id);
      const btn = document.createElement('button');
      btn.className = 'bld-btn' + (unlocked ? '' : ' locked') + (game.ghost && game.ghost.type === def.id ? ' selected' : '');
      btn.title = def.desc;
      const icon = FG.Renderer.buildingIcon(def.id, 40);
      icon.width = 40; icon.height = 40;
      btn.appendChild(icon);
      const name = document.createElement('span');
      name.className = 'bld-name';
      name.textContent = def.name;
      btn.appendChild(name);
      if (!unlocked) {
        btn.title = '需要研究：' + (FG.Research.byId(def.unlockedBy) ? FG.Research.byId(def.unlockedBy).name : def.unlockedBy);
        btn.onclick = () => {
          const tech = FG.Research.byId(def.unlockedBy);
          if (tech) { FG.Tech.open(); FG.Tech.focus(def.unlockedBy); }
        };
      } else {
        btn.onclick = () => {
          if (game.ghost && game.ghost.type === def.id) game.cancelGhost();
          else game.setGhost(def.id);
        };
      }
      listEl().appendChild(btn);
    }
  }

  return { init, renderBuildings };
})();
