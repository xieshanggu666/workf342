/**
 * 一键流水线测试：node test/pipeline.test.js
 * 覆盖：
 *  - 预设蓝图归一化（负坐标/包围盒）
 *  - 智能选位（矿脉/水域对准、占用避让）
 *  - 科技（建筑/配方）锁定与解锁
 *  - 旋转保留 require
 *  - 端到端：提交施工 → 建材预留 → 落成 → 实际产出（铁矿冶炼/齿轮/电路板/科学包/石料/实验室/水泵）
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
  'js/data/research.js', 'js/data/maps.js', 'js/data/pipelines.js',
  'js/game/map.js', 'js/game/scheduler.js', 'js/game/railway.js', 'js/game/contracts.js', 'js/game/sim.js', 'js/game/researchmgr.js',
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
function chestAt(m, x, y) { return m.buildingAt(x, y); }
function chestCount(b, type) { if (!b || !b.chest) return 0; const s = b.chest.find(x => x.type === type); return s ? s.count : 0; }

// 构造大地图：全草地，按需要铺设矿脉/水域
function newMap(orePatches) {
  const game = new FG.Game();
  const w = 80, h = 80;
  const terrain = Array.from({ length: h }, () => Array(w).fill('grass'));
  const ores = Array.from({ length: h }, () => Array(w).fill(null));
  const water = new Set();
  for (const pt of (orePatches || [])) {
    ores[pt.y][pt.x] = { type: pt.type, amount: pt.amount || 99999 };
  }
  game.startWithMap({
    presetId: 'greenfield', biome: 'grass', w, h, seed: 1, sizeId: 'large',
    terrain, ores, water, oil: new Set(),
  }, null, 'pipe-test');
  return game;
}

// 给全图供应建材：箱子只有 4 槽，沿底排放多个箱子塞满建材
function supplyChest(game) {
  const m = game.map, sim = game.sim;
  const mats = ['ironPlate', 'copperPlate', 'steelPlate', 'gear', 'circuit', 'advCircuit',
    'ironBeam', 'stone', 'copperWire'];
  const chests = [];
  for (let i = 0; i < mats.length; i++) {
    const c = FG.Map.create('chest', 70 + (i % 9), 78, 0);
    m.register(c); sim.register(c);
    sim.chestAdd(c, mats[i], 500);
    chests.push(c);
  }
  return chests;
}

console.log('\n[1] 预设定义完整性');
{
  for (const p of FG.Pipelines.list()) {
    const bp = FG.Pipelines.blueprintOf(p);
    // 无重复格
    const seen = new Set();
    let dup = false;
    for (const e of bp.entries) {
      const k = e.dx + ',' + e.dy;
      if (seen.has(k)) dup = true;
      seen.add(k);
    }
    ok(!dup, p.name + '：条目无重叠格');
    // 包围盒从 (0,0) 起
    let minX = 99, minY = 99, maxX = -1, maxY = -1;
    for (const e of bp.entries) { minX = Math.min(minX, e.dx); minY = Math.min(minY, e.dy); maxX = Math.max(maxX, e.dx); maxY = Math.max(maxY, e.dy); }
    ok(minX === 0 && minY === 0 && bp.w === maxX + 1 && bp.h === maxY + 1,
      p.name + '：归一化包围盒 ' + bp.w + '×' + bp.h);
    // 配方建筑必须带配方
    for (const e of bp.entries) {
      const def = FG.Buildings.byId(e.type);
      if (def.recipeBuilding && e.type !== 'lab') ok(!!e.recipe, p.name + '：' + def.name + ' 已配配方');
    }
  }
}

console.log('\n[2] 科技锁定：未解锁的建筑/配方让预设不可用');
{
  const game = newMap();
  const circuit = FG.Pipelines.byId('craftCircuit');
  ok(!FG.Pipelines.isAvailable(circuit, game), '电路板线初始锁定（配方：电子学）');
  game.research.completed.add('electronics');
  ok(FG.Pipelines.isAvailable(circuit, game), '研究电子学后电路板线可用');
  const gear = FG.Pipelines.byId('craftGear');
  ok(FG.Pipelines.isAvailable(gear, game), '齿轮线无科技门槛');
}

console.log('\n[3] 智能选位：矿机对准矿脉，水域旁落水泵');
{
  const game = newMap([{ x: 30, y: 30, type: 'ironOre' }]);
  // 在 10,10 附近搜索铁矿冶炼线，应自动跳到矿脉 (30,30) 上的矿机位置
  const bp = FG.Pipelines.blueprintOf(FG.Pipelines.byId('smeltIron'));
  const anchor = FG.Pipelines.findAnchor(game, bp, 10, 10, 40);
  ok(!!anchor, '找到铁矿冶炼线落点');
  const minerE = bp.entries.find(e => e.type === 'miner');
  ok(game.map.oreAt(anchor.x + minerE.dx, anchor.y + minerE.dy) === 'ironOre',
    '矿机格落在铁矿脉上 (' + (anchor.x + minerE.dx) + ',' + (anchor.y + minerE.dy) + ')');
  // 全图无铜矿 → 找不到
  const bpC = FG.Pipelines.blueprintOf(FG.Pipelines.byId('smeltCopper'));
  ok(FG.Pipelines.findAnchor(game, bpC, 10, 10, 40) === null, '无铜矿时铜矿线无落点');
  // 供水站：制造一片水域（water 集合 + terrain 同步）
  for (let x = 50; x <= 52; x++) {
    game.map.water.add(FG.Utils.key(x, 50));
    game.map.terrain[50][x] = 'water';
  }
  const bpW = FG.Pipelines.blueprintOf(FG.Pipelines.byId('waterSupply'));
  const aW = FG.Pipelines.findAnchor(game, bpW, 45, 45, 40);
  ok(!!aW, '水域旁找到供水站落点');
  const pumpE = bpW.entries.find(e => e.type === 'pump');
  ok(game.adjacentWater(aW.x + pumpE.dx, aW.y + pumpE.dy), '水泵紧邻水域且在陆地上');
}

console.log('\n[4] 旋转保留 require 与配置');
{
  const bp = FG.Pipelines.blueprintOf(FG.Pipelines.byId('smeltIron'));
  const r = FG.Blueprint.rotate(bp);
  const miner = r.entries.find(e => e.type === 'miner');
  ok(!!miner.require && miner.require.terrain === 'ore' && miner.require.oreType === 'ironOre',
    '旋转后矿机 require（铁矿）保留');
  const furnace = r.entries.find(e => e.type === 'furnace');
  ok(furnace.recipe === 'smelt:iron', '旋转后熔炉配方保留');
}

console.log('\n[5] 端到端：铁矿冶炼线 —— 矿石 → 铁板入箱');
{
  const game = newMap([{ x: 20, y: 20, type: 'ironOre', amount: 999999 }]);
  supplyChest(game);
  ok(game.startPipeline('smeltIron', { x: 20, y: 20 }), '启动铁矿冶炼线');
  ok(!!game.bpAnchor, '智能选位成功');
  const a = game.bpAnchor;
  ok(game.submitBlueprintPlanAt(a.x, a.y), '提交施工计划');
  ticks(game, 200);
  ok(game.construction.plans.length === 0, '施工完成');
  // 成品箱（预设中最后一个 chest）里应当出现铁板
  const bp = FG.Pipelines.blueprintOf(FG.Pipelines.byId('smeltIron'));
  const outChestE = bp.entries.filter(e => e.type === 'chest').pop();
  const out = chestAt(game.map, a.x + outChestE.dx, a.y + outChestE.dy);
  ticks(game, 600);
  ok(chestCount(out, 'ironPlate') > 0, '铁板产出并送入成品箱（' + chestCount(out, 'ironPlate') + ' 件）');
}

console.log('\n[6] 端到端：石料采集线 —— 石料 → 箱子');
{
  const game = newMap([{ x: 25, y: 25, type: 'stone', amount: 999999 }]);
  supplyChest(game);
  game.startPipeline('quarryStone', { x: 25, y: 25 });
  const a = game.bpAnchor;
  ok(!!a, '石料线选位成功');
  game.submitBlueprintPlanAt(a.x, a.y);
  ticks(game, 300);
  const bp = FG.Pipelines.blueprintOf(FG.Pipelines.byId('quarryStone'));
  const cE = bp.entries.find(e => e.type === 'chest');
  const out = chestAt(game.map, a.x + cE.dx, a.y + cE.dy);
  ok(chestCount(out, 'stone') > 0, '石料送达箱子（' + chestCount(out, 'stone') + ' 件）');
}

console.log('\n[7] 端到端：齿轮线 —— 铁板箱 → 齿轮箱');
{
  const game = newMap();
  const mats = supplyChest(game);
  game.startPipeline('craftGear', { x: 30, y: 30 });
  const a = game.bpAnchor;
  ok(!!a && game.submitBlueprintPlanAt(a.x, a.y), '齿轮线选位并提交');
  ticks(game, 150);
  const bp = FG.Pipelines.blueprintOf(FG.Pipelines.byId('craftGear'));
  const inE = bp.entries[0], outE = bp.entries[bp.entries.length - 1];
  const inChest = chestAt(game.map, a.x + inE.dx, a.y + inE.dy);
  const outChest = chestAt(game.map, a.x + outE.dx, a.y + outE.dy);
  game.sim.chestAdd(inChest, 'ironPlate', 100);
  ticks(game, 600);
  ok(chestCount(outChest, 'gear') > 0, '齿轮产出入箱（' + chestCount(outChest, 'gear') + ' 件）');
}

console.log('\n[8] 端到端：电路板线 —— 铜板+铁板 → 电路板');
{
  const game = newMap();
  game.research.completed.add('electronics');
  supplyChest(game);
  game.startPipeline('craftCircuit', { x: 30, y: 30 });
  const a = game.bpAnchor;
  ok(!!a && game.submitBlueprintPlanAt(a.x, a.y), '电路板线选位并提交');
  ticks(game, 150);
  ok(game.construction.plans.length === 0, '电路板线施工完成');
  const bp = FG.Pipelines.blueprintOf(FG.Pipelines.byId('craftCircuit'));
  // 铜线组装机北侧是铜板箱（dy-2）；电路板组装机西侧是铁板箱（dx-2）
  const wireAss = bp.entries.find(e => e.recipe === 'craft:copperWire');
  const circAss = bp.entries.find(e => e.recipe === 'craft:circuit');
  const copperChest = chestAt(game.map, a.x + wireAss.dx, a.y + wireAss.dy - 2);
  const ironChest = chestAt(game.map, a.x + circAss.dx - 2, a.y + circAss.dy);
  ok(!!copperChest && !!ironChest, '找到两个原料箱');
  game.sim.chestAdd(copperChest, 'copperPlate', 200);
  game.sim.chestAdd(ironChest, 'ironPlate', 100);
  const outE = bp.entries[bp.entries.length - 1];
  const outChest = chestAt(game.map, a.x + outE.dx, a.y + outE.dy);
  ticks(game, 1200);
  ok(chestCount(outChest, 'circuit') > 0, '电路板产出入箱（' + chestCount(outChest, 'circuit') + ' 件）');
}

console.log('\n[9] 端到端：自动化科学包线 —— 三料 → 科学包');
{
  const game = newMap();
  supplyChest(game);
  game.startPipeline('craftScience1', { x: 30, y: 30 });
  const a = game.bpAnchor;
  ok(!!a && game.submitBlueprintPlanAt(a.x, a.y), '科学包线选位并提交');
  ticks(game, 150);
  const bp = FG.Pipelines.blueprintOf(FG.Pipelines.byId('craftScience1'));
  const ass = bp.entries.find(e => e.recipe === 'craft:science1');
  // 三个料箱分别在组装机 北2 / 西2 / 南2
  const gearC = chestAt(game.map, a.x + ass.dx, a.y + ass.dy - 2);
  const ironC = chestAt(game.map, a.x + ass.dx - 2, a.y + ass.dy);
  const copC = chestAt(game.map, a.x + ass.dx, a.y + ass.dy + 2);
  ok(!!gearC && !!ironC && !!copC, '三个原料箱就位');
  game.sim.chestAdd(gearC, 'gear', 100);
  game.sim.chestAdd(ironC, 'ironPlate', 100);
  game.sim.chestAdd(copC, 'copperPlate', 100);
  const outE = bp.entries[bp.entries.length - 1];
  const outChest = chestAt(game.map, a.x + outE.dx, a.y + outE.dy);
  ticks(game, 1400);
  ok(chestCount(outChest, 'science1') > 0, '自动化科学包产出入箱（' + chestCount(outChest, 'science1') + ' 件）');
}

console.log('\n[10] 端到端：实验室组消费科学包推进研究');
{
  const game = newMap();
  supplyChest(game);
  game.startPipeline('labRow', { x: 30, y: 30 });
  const a = game.bpAnchor;
  ok(!!a && game.submitBlueprintPlanAt(a.x, a.y), '实验室组选位并提交');
  ticks(game, 150);
  const bp = FG.Pipelines.blueprintOf(FG.Pipelines.byId('labRow'));
  const cE = bp.entries.find(e => e.type === 'chest');
  const feed = chestAt(game.map, a.x + cE.dx, a.y + cE.dy);
  ok(!!feed, '科学包料箱就位');
  game.sim.chestAdd(feed, 'science1', 200);
  game.research.start('automationScience'); // 需要 30 science1
  ticks(game, 4000);
  ok(game.research.isDone('automationScience'), '自动化科学 I 研究完成（实验室消耗科学包）');
}

console.log('\n[11] 施工语义：缺料挂起、连续铺设、取消返还（与蓝图共用）');
{
  const game = newMap([{ x: 20, y: 20, type: 'ironOre', amount: 999999 }, { x: 40, y: 40, type: 'ironOre', amount: 999999 }]);
  const c = FG.Map.create('chest', 70, 70, 0);
  game.map.register(c); game.sim.register(c);
  game.sim.chestAdd(c, 'ironPlate', 5); // 明显不够一条线
  game.startPipeline('smeltIron', { x: 20, y: 20 });
  const a = game.bpAnchor;
  game.submitBlueprintPlanAt(a.x, a.y);
  ticks(game, 200);
  ok(game.construction.plans.length === 1 && game.construction.plans[0].waiting, '建材不足 → 计划挂起等待');
  const id = game.construction.plans[0].id;
  const before = chestCount(c, 'ironPlate');  game.cancelConstruction(id);
  ok(game.construction.plans.length === 0, '取消计划');
  ok(chestCount(c, 'ironPlate') >= before, '取消后预留建材返还');
}

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
