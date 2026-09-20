/**
 * 原地升级测试：node test/upgrade.test.js
 * 升级链计算 → 框选预览（科技门控/成本汇总/占位跳过）→ 提交升级计划 →
 * 备料分步替换（配方/库存/在途物料/筛选/优先级保留）→ 缺料等待 →
 * 暂停/取消返还未用建材 → 原建筑变更跳过 → 进度随存档恢复（兼容旧存档）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
global.window = global;
global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] !== undefined ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

const files = [
  'js/core/config.js', 'js/core/utils.js',
  'js/data/items.js', 'js/data/recipes.js', 'js/data/buildings.js',
  'js/data/research.js', 'js/data/maps.js',
  'js/game/map.js', 'js/game/scheduler.js', 'js/game/railway.js', 'js/game/sim.js', 'js/game/researchmgr.js',
  'js/game/stats.js', 'js/game/save.js', 'js/game/blueprint.js', 'js/game/game.js',
];
for (const f of files) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
function ticks(g, n) { for (let i = 0; i < n; i++) g.tickOnce(); }

function mkGen() {
  const w = 60, h = 40;
  return {
    presetId: 'greenfield', biome: 'grass', w, h, seed: 1, sizeId: 'medium',
    terrain: Array.from({ length: h }, () => Array(w).fill('grass')),
    ores: Array.from({ length: h }, () => Array(w).fill(null)),
    water: new Set(), oil: new Set(),
  };
}

const game = new FG.Game();
game.startWithMap(mkGen(), null, 'up-test');
const m = game.map, sim = game.sim;

function P(t, x, y, d) { const b = FG.Map.create(t, x, y, d || 0); m.register(b); sim.register(b); return b; }
function chestCount(b, type) { const s = b.chest.find(x => x.type === type); return s ? s.count : 0; }
function clearChest(b) { for (const s of b.chest) { s.type = null; s.count = 0; } }

console.log('\n[1] 升级链：已解锁的最高级替换型号');
{
  ok(FG.Buildings.upgradeTarget('furnace', () => false) === null, '钢炉未解锁 → 无替换');
  ok(FG.Buildings.upgradeTarget('furnace', t => t === 'steelFurnace') === 'steelFurnace', '石炉 → 钢炉');
  ok(FG.Buildings.upgradeTarget('belt', t => t === 'fastBelt') === 'fastBelt', '仅物流学 II → 传送带升至快速');
  ok(FG.Buildings.upgradeTarget('belt', () => true) === 'expressBelt', '全解锁 → 传送带直升极速（最高级）');
  ok(FG.Buildings.upgradeTarget('fastBelt', () => true) === 'expressBelt', '快速传送带 → 极速传送带');
  ok(FG.Buildings.upgradeTarget('expressBelt', () => true) === null, '极速传送带已是顶级');
  ok(FG.Buildings.upgradeTarget('chest', () => true) === null, '箱子无升级链');
  ok(FG.Buildings.upgradeTarget('longInserter', () => true) === null, '长臂机械臂（旁系）不在升级链上');
}

console.log('\n[2] 框选预览：科技门控 / 成本汇总 / 计划占位跳过');
{
  const g2 = new FG.Game();
  g2.startWithMap(mkGen(), null, 'up-preview');
  const m2 = g2.map, s2 = g2.sim;
  const Q = (t, x, y, d) => { const b = FG.Map.create(t, x, y, d || 0); m2.register(b); s2.register(b); return b; };
  Q('furnace', 20, 10); Q('belt', 21, 10, 1); Q('inserter', 22, 10, 1); Q('chest', 23, 10);

  ok(g2.previewUpgrade(20, 10, 23, 10) === 0 && !g2.upPreview, '高级型号全未解锁 → 无可升级条目');
  g2.research.completed.add('logistics2');
  ok(g2.previewUpgrade(20, 10, 23, 10) === 2, '物流学 II → 传送带/机械臂可升级（2 栋）');
  const pv = g2.upPreview;
  ok(pv.entries.some(e => e.from === 'belt' && e.to === 'fastBelt')
    && pv.entries.some(e => e.from === 'inserter' && e.to === 'fastInserter'),
    '预览条目：传送带→快速传送带、机械臂→快速机械臂');
  ok(pv.cost.ironPlate === 2 && pv.cost.gear === 1 && pv.cost.circuit === 1 && !pv.cost.stone,
    '备料成本汇总（铁板2 齿轮1 电路板1，实际 ' + JSON.stringify(pv.cost) + '）');
  ok(!pv.entries.some(e => e.from === 'chest'), '箱子不参与升级');

  g2.research.completed.add('logistics3');
  g2.research.completed.add('steelSmelting');
  g2.cancelUpgradePreview();          // 放弃上一预览，重选
  ok(g2.previewUpgrade(20, 10, 23, 10) === 3, '解锁钢冶炼/物流学 III → 3 栋可升级');
  const pv2 = g2.upPreview;
  ok(pv2.entries.some(e => e.from === 'belt' && e.to === 'expressBelt'), '传送带直升极速传送带');
  ok(pv2.entries.some(e => e.from === 'furnace' && e.to === 'steelFurnace'), '石炉 → 钢炉');
  ok(pv2.cost.stone === 6 && pv2.cost.steelPlate === 5 && pv2.cost.gear === 1
    && pv2.cost.ironPlate === 1 && pv2.cost.circuit === 1,
    '成本按最高级型号汇总（实际 ' + JSON.stringify(pv2.cost) + '）');

  // 确认提交后，同区域再次框选：已有计划占位的格子被跳过
  ok(g2.confirmUpgrade(), '提交升级计划');
  ok(g2.construction.plans.length === 1 && g2.construction.plans[0].kind === 'upgrade',
    '升级计划进入施工队列（kind=upgrade）');
  ok(g2.previewUpgrade(20, 10, 23, 10) === 0, '计划占位格子不再重复生成升级条目');
  g2.construction.cancel(g2.construction.plans[0].id);
  g2.exitUpgradeMode();
}

console.log('\n[3] swapEntry 状态迁移：配方/进度/库存/在途物料/筛选/优先级');
{
  const f = P('furnace', 30, 20, 1);
  f.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(f);
  f.progress = 7;
  f.slots.inputs.ironOre.count = 5;
  f.slots.outputs.ironPlate.count = 3;
  f.priority = 'high'; f.totalCrafted = 9;
  f.fluidTanks.water = 12.5;
  game.selection = f;
  const nb = game.construction.swapEntry({ from: 'furnace', type: 'steelFurnace', x: 30, y: 20 });
  ok(nb && nb.type === 'steelFurnace' && nb.dir === 1, '钢炉同格同向落成');
  ok(nb.recipe === 'smelt:iron' && nb.progress === 7, '配方与生产进度保留');
  ok(nb.slots.inputs.ironOre.count === 5 && nb.slots.outputs.ironPlate.count === 3, '输入/输出槽库存保留');
  ok(nb.fluidTanks.water === 12.5, '流体缓冲保留');
  ok(nb.priority === 'high' && nb.totalCrafted === 9, '供料优先级与累计产量保留');
  ok(m.buildingAt(30, 20) === nb && sim.crafters.includes(nb) && !sim.crafters.includes(f),
    '新建筑注册进仿真，旧建筑注销');
  ok(game.selection === nb, '选中态跟随新建筑');
  game.selection = null;

  const bt = P('belt', 31, 20, 2);
  bt.items.push({ type: 'ironPlate', pos: 0.4, from: 2, tag: { c: '1,2', item: 'ironPlate', t0: 3 } });
  bt.rr = 1;
  const nb2 = game.construction.swapEntry({ from: 'belt', type: 'fastBelt', x: 31, y: 20 });
  ok(nb2.items.length === 1 && nb2.items[0].pos === 0.4 && nb2.items[0].from === 2
    && nb2.items[0].tag && nb2.items[0].tag.c === '1,2',
    '传送带在途物品（含在途预留标签与进料侧）保留');
  ok(nb2.rr === 1 && sim.belts.includes(nb2) && !sim.belts.includes(bt), '合流游标保留并换注册');

  const ins = P('inserter', 32, 20, 3);
  ins.held = { type: 'gear', tag: { c: '9,9', item: 'gear', t0: 1 } };
  ins.phase = 'swing'; ins.timer = 3; ins.filter = 'gear'; ins.demandMode = true;
  const nb3 = game.construction.swapEntry({ from: 'inserter', type: 'fastInserter', x: 32, y: 20 });
  ok(nb3.held && nb3.held.type === 'gear' && nb3.held.tag && nb3.held.tag.c === '9,9',
    '机械臂手持物品（含预留标签）保留');
  ok(nb3.phase === 'swing' && nb3.timer === 3 && nb3.filter === 'gear' && nb3.demandMode === true,
    '机械臂相位/计时/筛选/按需保留');
  ok(sim.inserters.includes(nb3) && !sim.inserters.includes(ins), '新机械臂换注册');
  ok(game.construction.swapEntry({ from: 'furnace', type: 'steelFurnace', x: 35, y: 20 }) === null,
    '空格/型号不符时替换安全返回 null');
}

console.log('\n[4] 完整流程：备料 → 分步原地切换 → 保留产线状态并接入调度');
{
  game.research.completed.add('steelSmelting');
  game.research.completed.add('advancedElectronics');
  game.research.completed.add('logistics2');
  game.research.completed.add('logistics3');

  const chestA = P('chest', 5, 5), chestB = P('chest', 6, 5);
  sim.chestAdd(chestA, 'stone', 100); sim.chestAdd(chestA, 'steelPlate', 100); sim.chestAdd(chestA, 'gear', 100);
  sim.chestAdd(chestB, 'circuit', 100); sim.chestAdd(chestB, 'ironPlate', 100);
  game._chestA = chestA; game._chestB = chestB;

  // 产线：石炉(配方/库存/优先级) + 组装机(配方/优先级) + 传送带(在途预留) + 机械臂(手持/筛选/按需) + 箱子(不升级)
  const fur = P('furnace', 10, 10);
  fur.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(fur);
  fur.slots.outputs.ironPlate.count = 3; fur.priority = 'high';
  const asm = P('assembler', 11, 10);
  asm.recipe = 'craft:gear'; FG.Map.syncRecipeSlots(asm); asm.priority = 'low';
  const belt = P('belt', 12, 10, 1);
  belt.items.push({ type: 'ironPlate', pos: 0.5, from: 0, tag: { c: '11,10', item: 'ironPlate', t0: 0 } });
  const ins = P('inserter', 13, 10, 0);
  ins.held = { type: 'ironPlate' }; ins.filter = 'ironPlate'; ins.demandMode = true; ins.timer = 3;
  P('chest', 14, 10);

  ok(game.previewUpgrade(10, 10, 14, 10) === 4, '框选 5 栋 → 4 栋可升级（箱子除外）');
  ok(game.confirmUpgrade(), '提交升级计划');
  const plan = game.construction.plans[0];
  ok(plan && plan.kind === 'upgrade' && plan.entries.length === 4, '升级计划含 4 个条目');
  ok(plan.entries[0].from === 'furnace' && plan.entries[0].type === 'steelFurnace', '条目记录原型号与目标型号');

  ticks(game, 1);
  ok(m.buildingAt(10, 10).type === 'steelFurnace' && m.buildingAt(11, 10).type === 'assembler',
    '分步切换：首栋立即替换，后续按施工间隔推进');
  ticks(game, 60);
  ok(game.construction.plans.length === 0, '全部替换完成，计划出列');

  const fur2 = m.buildingAt(10, 10);
  ok(fur2.type === 'steelFurnace' && fur2.recipe === 'smelt:iron'
    && fur2.slots.outputs.ironPlate.count === 3 && fur2.priority === 'high',
    '石炉→钢炉：配方/库存/优先级保留');
  ok(sim.crafters.includes(fur2), '钢炉接入生产调度');
  const asm2 = m.buildingAt(11, 10);
  ok(asm2.type === 'assembler2' && asm2.recipe === 'craft:gear' && asm2.priority === 'low',
    '组装机→二级组装机：配方/优先级保留');
  const belt2 = m.buildingAt(12, 10);
  ok(belt2.type === 'expressBelt' && belt2.items.length === 1
    && belt2.items[0].tag && belt2.items[0].tag.c === '11,10',
    '传送带→极速传送带：在途物品与预留标签保留（消费者坐标不变，预留继续有效）');
  const ins2 = m.buildingAt(13, 10);
  ok(ins2.type === 'fastInserter' && ins2.held && ins2.held.type === 'ironPlate'
    && ins2.filter === 'ironPlate' && ins2.demandMode === true,
    '机械臂→快速机械臂：手持/筛选/按需保留');
  ok(m.buildingAt(14, 10).type === 'chest', '箱子保持原样');

  ok(chestCount(chestA, 'stone') === 94 && chestCount(chestA, 'steelPlate') === 92
    && chestCount(chestA, 'gear') === 97
    && chestCount(chestB, 'circuit') === 97 && chestCount(chestB, 'ironPlate') === 99,
    '建材按新建筑造价消耗（石6 钢8 齿轮3 电路板3 铁板1）');
}

console.log('\n[5] 缺料等待：备料不足时挂起，补料后自动续建');
{
  clearChest(game._chestA); clearChest(game._chestB);
  P('furnace', 40, 10);
  sim.chestAdd(game._chestA, 'stone', 6);   // 钢炉需 石6+钢4：只有石
  ok(game.previewUpgrade(40, 10, 40, 10) === 1 && game.confirmUpgrade(), '提交钢炉升级（缺钢板）');
  ticks(game, 5);
  const plan = game.construction.plans[0];
  ok(plan && plan.waiting && (plan.entries[0].stock.stone || 0) === 6, '缺料等待，石头已预留 6');
  ok(chestCount(game._chestA, 'stone') === 0, '预留量已从箱子扣除');
  ok(m.buildingAt(40, 10).type === 'furnace', '缺料期间不替换');
  sim.chestAdd(game._chestA, 'steelPlate', 4);
  ticks(game, 10);
  ok(m.buildingAt(40, 10).type === 'steelFurnace', '补料后自动续建完成');
  ok(game.construction.plans.length === 0, '计划出列');
}

console.log('\n[6] 暂停 / 继续：暂停即释放预留建材，继续后重新备料');
{
  clearChest(game._chestA); clearChest(game._chestB);
  P('furnace', 42, 10);
  sim.chestAdd(game._chestA, 'stone', 6);
  ok(game.previewUpgrade(42, 10, 42, 10) === 1 && game.confirmUpgrade(), '提交升级计划');
  ticks(game, 3);
  const plan = game.construction.plans[0];
  ok(plan && (plan.entries[0].stock.stone || 0) === 6 && chestCount(game._chestA, 'stone') === 0,
    '石头 6 已预留入条目');
  game.construction.setPaused(plan.id, true);
  ok(chestCount(game._chestA, 'stone') === 6 && !Object.keys(plan.entries[0].stock).length,
    '暂停后预留建材立即返还物流');
  ticks(game, 3);
  ok(m.buildingAt(42, 10).type === 'furnace', '暂停期间不替换');
  game.construction.setPaused(plan.id, false);
  ticks(game, 3);
  ok((game.construction.plans[0].entries[0].stock.stone || 0) === 6, '继续后重新备料');
  game._plan6 = game.construction.plans[0];
}

console.log('\n[7] 取消：返还未用建材，已升级的保留，未升级的旧建筑保留');
{
  // 接 [6]：取消等待中的计划
  const plan = game._plan6;
  ok(game.cancelConstruction(plan.id), '取消升级计划');
  ok(chestCount(game._chestA, 'stone') === 6, '未用建材返还箱子');
  ok(m.buildingAt(42, 10).type === 'furnace', '未替换的旧建筑保留');
  ok(game.construction.plans.length === 0, '计划已移除');

  // 两栋计划：第一栋已替换，第二栋备料中 → 取消后已升级的保留
  clearChest(game._chestA); clearChest(game._chestB);
  P('furnace', 44, 10); P('furnace', 45, 10);
  sim.chestAdd(game._chestA, 'stone', 8); sim.chestAdd(game._chestA, 'steelPlate', 4);
  ok(game.previewUpgrade(44, 10, 45, 10) === 2 && game.confirmUpgrade(), '提交双栋升级计划');
  ticks(game, 5);
  ok(m.buildingAt(44, 10).type === 'steelFurnace' && m.buildingAt(45, 10).type === 'furnace',
    '第一栋已替换，第二栋缺料等待');
  const p2 = game.construction.plans[0];
  ok((p2.entries[1].stock.stone || 0) === 2, '第二栋已预留石头 2');
  game.cancelConstruction(p2.id);
  ok(m.buildingAt(44, 10).type === 'steelFurnace' && m.buildingAt(45, 10).type === 'furnace',
    '取消后：已升级的保留，未升级的旧建筑保留');
  ok(chestCount(game._chestA, 'stone') === 2, '未用建材返还（石头 2）');
}

console.log('\n[8] 计划期间原建筑变更：被拆 → 跳过并返还；已是目标型号 → 直接记完成');
{
  clearChest(game._chestA); clearChest(game._chestB);
  const fur = P('furnace', 46, 10);
  sim.chestAdd(game._chestA, 'stone', 3);
  ok(game.previewUpgrade(46, 10, 46, 10) === 1 && game.confirmUpgrade(), '提交升级计划 A');
  ticks(game, 3);
  ok((game.construction.plans[0].entries[0].stock.stone || 0) === 3, '已预留石头 3');
  game.removeBuilding(fur);
  ticks(game, 3);
  ok(game.construction.plans.length === 0, '原建筑被拆 → 条目跳过，计划出列');
  ok(!m.buildingAt(46, 10) && chestCount(game._chestA, 'stone') === 3, '预留建材返还，无新建筑落地');

  const fur2 = P('furnace', 48, 10);
  clearChest(game._chestA); clearChest(game._chestB);   // 重新清点，排除计划 A 返还的 3 石头
  sim.chestAdd(game._chestA, 'stone', 3);
  ok(game.previewUpgrade(48, 10, 48, 10) === 1 && game.confirmUpgrade(), '提交升级计划 B');
  ticks(game, 3);
  ok((game.construction.plans[0].entries[0].stock.stone || 0) === 3, '计划 B 已预留石头 3');
  game.removeBuilding(fur2);
  P('steelFurnace', 48, 10);   // 玩家手动换成了目标型号
  ticks(game, 3);
  ok(game.construction.plans.length === 0, '该格已是目标型号 → 记完成出列');
  ok(m.buildingAt(48, 10).type === 'steelFurnace' && chestCount(game._chestA, 'stone') === 3,
    '手动替换的不耗建材，预留全额返还');
}

console.log('\n[9] 升级进度随存档恢复；旧存档（无 kind/from 字段）兼容续建');
{
  const g1 = new FG.Game();
  g1.startWithMap(mkGen(), null, 'up-save');
  g1.research.completed.add('steelSmelting');
  const m1 = g1.map, s1 = g1.sim;
  const Q = (t, x, y, d) => { const b = FG.Map.create(t, x, y, d || 0); m1.register(b); s1.register(b); return b; };
  const ch = Q('chest', 5, 5);
  s1.chestAdd(ch, 'stone', 6);
  const fur = Q('furnace', 30, 10);
  fur.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(fur);
  fur.slots.outputs.ironPlate.count = 2;
  ok(g1.previewUpgrade(30, 10, 30, 10) === 1 && g1.confirmUpgrade(), '提交升级计划');
  ticks(g1, 3);
  ok((g1.construction.plans[0].entries[0].stock.stone || 0) === 6, '存档前已预留石头 6（缺钢板等待）');

  const data = JSON.parse(JSON.stringify(g1.serialize()));
  ok(data.construction.plans[0].kind === 'upgrade' && data.construction.plans[0].entries[0].from === 'furnace',
    '存档包含升级计划（kind/from）');

  const g2 = new FG.Game();
  g2.deserialize(data);
  const p2 = g2.construction.plans[0];
  ok(p2 && p2.kind === 'upgrade' && p2.entries[0].from === 'furnace'
    && p2.entries[0].type === 'steelFurnace' && (p2.entries[0].stock.stone || 0) === 6,
    '读档后升级计划与条目预留恢复');
  s1.chestAdd && 0;
  const ch2 = g2.map.buildingAt(5, 5);
  g2.sim.chestAdd(ch2, 'steelPlate', 4);
  ticks(g2, 10);
  const fur2 = g2.map.buildingAt(30, 10);
  ok(fur2 && fur2.type === 'steelFurnace' && fur2.recipe === 'smelt:iron'
    && fur2.slots.outputs.ironPlate.count === 2,
    '读档后续建：补料完成替换且配方/库存保留');
  ok(g2.construction.plans.length === 0, '续建完成出列');

  // 旧存档：计划无 kind、条目无 from → 按普通建造计划处理，不报错
  const old = JSON.parse(JSON.stringify(data));
  for (const p of old.construction.plans) { delete p.kind; for (const e of p.entries) delete e.from; }
  const g3 = new FG.Game();
  let err = null;
  try { g3.deserialize(old); ticks(g3, 10); } catch (e) { err = e; }
  ok(!err, '旧存档（无 kind/from）读取与仿真不报错' + (err ? '：' + err.stack : ''));
  ok(g3.construction.plans.length === 0
    || (g3.construction.plans[0].kind === 'build' && g3.construction.plans[0].entries[0].from === null),
    '旧计划按普通建造处理（kind=build, from=null）');

  // 更旧的存档：完全没有 construction 字段
  const older = JSON.parse(JSON.stringify(data));
  delete older.construction;
  const g4 = new FG.Game();
  err = null;
  try { g4.deserialize(older); ticks(g4, 10); } catch (e) { err = e; }
  ok(!err && g4.construction.plans.length === 0, '无施工字段的旧存档回退空计划');
}

console.log('\n[10] 升级后产能生效：钢炉 2 倍速冶炼');
{
  const fur = m.buildingAt(10, 10);   // [4] 中升级的钢炉（配方 smelt:iron）
  ok(fur.type === 'steelFurnace' && fur.def.craftSpeed === 2, '钢炉已就位（2 倍速）');
  fur.slots.inputs.ironOre.count = 10;
  const crafted0 = fur.totalCrafted;
  ticks(game, 40);   // 配方 20 tick ÷ 2 倍速 = 10 tick/次 → 40 tick 恰好 4 次
  ok(fur.totalCrafted - crafted0 === 4, '40 tick 完成 4 次冶炼（2 倍速，实际 ' + (fur.totalCrafted - crafted0) + '）');
}

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
