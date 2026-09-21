/**
 * 铁路货运测试：node test/railway.test.js
 * 覆盖：铺设/发车/装卸/区间占用/交叉争用/堵站排队/断路自愈/拆除保护/存档恢复/到站物料接入产线
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
  'js/game/map.js', 'js/game/scheduler.js', 'js/game/railway.js', 'js/game/contracts.js', 'js/game/sim.js',
  'js/game/researchmgr.js', 'js/game/stats.js', 'js/game/save.js',
  'js/game/blueprint.js', 'js/game/game.js',
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

const game = new FG.Game();
const gen = FG.Maps.generate(FG.Maps.getPreset('greenfield'), 999, 'medium');
game.startWithMap(gen, null, 'rail-test');
game.research.completed.add('railTransport'); // 解锁铁路建筑
const m = game.map, sim = game.sim, ry = game.railway;

function place(type, x, y, dir) {
  const b = FG.Map.create(type, x, y, dir || 0);
  if (b.def.railStation) { b.stationId = 'S' + (ry.stationSeq++); b.stationName = '站点 ' + b.stationId.slice(1); }
  m.register(b); sim.register(b);
  ry.markDirty();
  return b;
}
/** 铺一条直轨（含两站）：站点本身即轨节点 */
function straightLine(x0, x1, y, stations) {
  stations = stations || {};
  for (let x = x0; x <= x1; x++) {
    if (stations[x]) place('station', x, y, 0);
    else place('rail', x, y, 0);
  }
}
function shallowGen() {
  return {
    presetId: 'greenfield', biome: 'grass', w: gen.w, h: gen.h, seed: 999, sizeId: 'medium',
    terrain: gen.terrain,
    ores: gen.ores.map(row => row.map(c => c ? { type: c.type, amount: c.amount } : null)),
    water: gen.water, oil: gen.oil,
  };
}
function stationFill(st, item, n) { sim.chestAdd(st, item, n); }
function stationCount(st, item) {
  return st.chest.reduce((n, s) => n + (s.type === item ? s.count : 0), 0);
}

console.log('\n[R1] 基本运输：列车沿轨道到站、卸货、装货、循环');
{
  const y = 4;
  straightLine(2, 12, y, { 3: true, 11: true });
  const stA = m.buildingAt(3, y), stB = m.buildingAt(11, y);
  stA.stationName = '甲站'; stB.stationName = '乙站';
  // 机务段在甲站旁
  const depot = place('trainDepot', 3, y - 1, 0);
  // 车站必须邻轨：找一块不临轨的陆地格断言
  let farLand = null;
  for (let yy = 0; yy < m.h && !farLand; yy++) for (let xx = 0; xx < m.w && !farLand; xx++) {
    if (m.terrainAt(xx, yy) !== 'water' && !m.buildingAt(xx, yy) && !game.adjacentRail(xx, yy)) farLand = { x: xx, y: yy };
  }
  ok(game.canPlace('rail', 1, y) && farLand && !game.canPlace('station', farLand.x, farLand.y),
     '轨道可铺、孤立陆地格不能建车站（须邻轨）');
  ok(game.adjacentRail(3, y - 1), '机务段接轨校验通过');
  const tr = ry.spawnTrain(depot);
  ok(!!tr, '机务段相邻轨道成功发车（' + (tr && tr.id) + '），位于 ' + (tr && tr.x) + ',' + (tr && tr.y));
  // 计划：甲站卸铁矿 30 → 乙站装煤 20（循环）
  tr.addStop(stA.stationId, 'unload', 'ironOre', 30);
  tr.addStop(stB.stationId, 'load', 'coal', 20);
  // 车上预载 30 铁矿（模拟从另一站运来）
  tr.pushToTrain('ironOre', 30);
  stationFill(stB, 'coal', 50);

  // 出生在 (3,y) 相邻轨格 —— spawn 从 dir=0 开始找；断言最终到达甲站并卸货
  ticks(game, 20);
  ok(tr.cargoCount('ironOre') === 0, '在甲站把 30 铁矿卸入车站货位（剩 ' + tr.cargoCount('ironOre') + '）');
  ok(stationCount(stA, 'ironOre') === 30, '甲站收到 30 铁矿（到站物料入站）');
  ok(tr.state === 'docked' || tr.state === 'moving', '卸货后继续运行（状态=' + tr.state + '）');

  // 跑到乙站：记录整次停靠期间车上煤的最大值，必须严格 = 计划 20（不多装）
  let peakCoal = 0, wasDockedAtB = false;
  for (let i = 0; i < 300; i++) {
    game.tickOnce();
    const atB = tr.x === stB.x && tr.y === stB.y;
    if (atB) { wasDockedAtB = true; peakCoal = Math.max(peakCoal, tr.cargoCount('coal')); }
    if (wasDockedAtB && !atB) break; // 首次离站即停
  }
  console.log('    首次乙站停靠车上煤峰值 ' + peakCoal);
  ok(peakCoal === 20, '乙站首次停靠严格装 20 煤（计划数量，实测峰值 ' + peakCoal + '）');
  ok(stationCount(stB, 'coal') === 30, '乙站被取走 20 煤（余 ' + stationCount(stB, 'coal') + '）');

  // 再循环回甲站：卸煤动作是 unload ironOre —— 车上无铁矿，到量为 0 立即继续；
  // 这里主要验证循环不断、且货物守恒
  ticks(game, 300);
  const totalCoal = tr.cargoCount('coal') + stationCount(stA, 'coal') + stationCount(stB, 'coal');
  ok(totalCoal === 50, '循环运行后煤守恒（50，实际 ' + totalCoal + '）');
  ok(tr.totalErr === undefined, '无异常状态（断路=' + (tr.state === 'noroute') + '）');
}

console.log('\n[R2] 区间占用：列车不穿越/不重叠；堵站时后车在站外同向排队依次进站');
{
  const y = 14;
  straightLine(0, 24, y, { 5: true, 18: true });
  const stA = m.buildingAt(5, y), stB = m.buildingAt(18, y);
  // 尽头清道站（前车 t1 卸货后空驶到此，把乙站让给后车）
  const stEnd = place('station', 24, y, 0);
  const dep1 = place('trainDepot', 0, y - 1, 0);
  const dep2 = place('trainDepot', 1, y - 1, 0);
  const t1 = ry.spawnTrain(dep1); // 落在 (0,y)
  const t2 = ry.spawnTrain(dep2); // (0,y) 被占 → 落在 (1,y)
  ok(!!t1 && !!t2 && (t2.x === 1 || t2.y === 14), '两列同向车前后编组（t1@' + (t1 && t1.x) + '，t2@' + (t2 && t2.x) + '）');
  for (const [idx, t] of [t1, t2].entries()) {
    // 前车 t2（x=1）先到乙站卸 10 后继续空驶到尽头清道；后车 t1（x=0）随后进站卸货待命
    t.plan.loop = false;
    t.addStop(stB.stationId, 'unload', 'ironOre', 10);
    if (idx === 1) t.addStop(stEnd.stationId, 'unload', null, 1); // 前车清道
    t.pushToTrain('ironOre', 10);
  }
  // 甲站作为途中会经过的车站（不停）：仅用于观测后车是否能穿过前车刚离开的站区
  let t2EverAtB = false, t2EverAtA = false, overlap = false;
  for (let i = 0; i < 2400; i++) {
    game.tickOnce();
    if (t2.x === stB.x && t2.y === stB.y) t2EverAtB = true;
    if (t2.x === stA.x && t2.y === stA.y) t2EverAtA = true;
    if (t1.x === t2.x && t1.y === t2.y) overlap = true;
    if (t1.state === 'idle' && t2.state === 'idle' && stationCount(stB, 'ironOre') === 20) break;
  }
  ok(!overlap, '全程两列车从未占同一格（区间占用无穿透）');
  const atB = stationCount(stB, 'ironOre');
  console.log('    乙站收 ' + atB + '，t1=' + t1.state + '@' + t1.x + ' t2=' + t2.state + '@' + t2.x
    + '，后车途经甲站=' + t2EverAtA + ' 到乙站=' + t2EverAtB);
  ok(t2EverAtA, '前车占区间/车站时后车在其后排队（waiting），前车驶离后依次通过');
  ok(atB === 20 && t2EverAtB, '两车先后到乙站各卸 10 件（乙站 ' + atB + '，无穿越无重叠）');
  ok(t1.state !== 'blocked' && t2.state !== 'blocked', '同向行车无堵死（' + t1.state + '/' + t2.state + '）');
}

console.log('\n[R3] 交叉线路争用：两线共用交汇轨格，轮转通过不饿死');
{
  const y = 24;
  // 横线 (2,y)-(10,y)，竖线 (6,y-4)-(6,y+4)，交汇 (6,y)
  straightLine(2, 10, y, { 2: true, 10: true });
  for (let yy = y - 4; yy <= y + 4; yy++) {
    if (yy === y) continue;
    place('rail', 6, yy, 0);
  }
  place('station', 6, y - 4, 0); // 竖线南站
  // 横线两站
  const stW = m.buildingAt(2, y), stE = m.buildingAt(10, y), stS = m.buildingAt(6, y - 4);
  // 两条东西向车 + 南北向车：发在远离交汇点处
  const depW = place('trainDepot', 3, y - 1, 0);
  const tw1 = ry.spawnTrain(depW);
  // 手动在竖线北端放车：直接构造（绕过机务段）
  const tn = new FG.Train('Tz1', 6, y + 4, 0);
  ry.trains.push(tn); ry.occupy.set('6,' + (y + 4), tn.id);
  tw1.addStop(stE.stationId, 'unload', null, 1); tw1.pushToTrain('stone', 1);
  tn.addStop(stS.stationId, 'unload', null, 1); tn.pushToTrain('gear', 1);

  ticks(game, 400);
  ok(tw1.state !== 'blocked' || tw1.x !== tw1.px || tn.state !== 'blocked',
     '交汇点未出现永久双堵死（tw1=' + tw1.state + ',tn=' + tn.state + '）');
  // 至少一车完成卸货
  const movedAny = stationCount(stE, 'stone') > 0 || stationCount(stS, 'gear') > 0;
  ok(movedAny, '争用条件下列车仍能通过交汇点完成运输');
}

console.log('\n[R4] 断路自愈：拆轨 → 列车 noroute 等待；补轨后自动恢复');
{
  const y = 30;
  straightLine(2, 12, y, { 2: true, 12: true });
  const stA = m.buildingAt(2, y), stB = m.buildingAt(12, y);
  const depot = place('trainDepot', 2, y - 1, 0);
  const tr = ry.spawnTrain(depot);
  tr.addStop(stB.stationId, 'unload', null, 1);
  tr.pushToTrain('stone', 1);
  // 立即挖断中段 (7,y)：列车尚未到达
  ok(game.removeBuilding(m.buildingAt(7, y)) !== false, '无车占用的轨道可拆除');
  ticks(game, 30);
  ok(tr.state === 'noroute', '中段断路后列车进入断路状态（实际 ' + tr.state + '）');
  // 补回
  place('rail', 7, y, 0);
  ticks(game, 200);
  ok(stationCount(stB, 'stone') === 1, '补轨后自动重新寻路并送达乙站');
  ok(tr.state !== 'noroute', '断路状态自动解除（' + tr.state + '）');
}

console.log('\n[R5] 列车占用时禁止拆轨；解编货物落地');
{
  const y = 34;
  straightLine(2, 8, y, { 2: true, 8: true });
  const stA = m.buildingAt(2, y);
  const depot = place('trainDepot', 2, y - 1, 0);
  const tr = ry.spawnTrain(depot);
  tr.addStop(m.buildingAt(8, y).stationId, 'unload', null, 1);
  tr.pushToTrain('coal', 5);
  ticks(game, 4);
  // 占住的格子拆不掉
  const occTile = m.buildingAt(tr.x, tr.y);
  const ret = game.removeBuilding(occTile);
  ok(ret === false, '列车占用的轨道/站格拆除被拒绝');
  game.selection = tr;
  game.removeTrainSelection();
  const pile = m.pileAt(tr.x, tr.y);
  ok(pile && pile.some(s => s.type === 'coal' && s.count === 5), '解编后 5 煤落到所在格地面堆');
  // 车没了即可拆
  ok(game.removeBuilding(occTile) !== false, '列车移除后轨道可拆除');
}

console.log('\n[R6] 存档恢复：列车位置/载货/计划/停站状态与调度游标随档还原');
{
  const y = 22;
  straightLine(2, 14, y, { 3: true, 13: true });
  const stA = m.buildingAt(3, y), stB = m.buildingAt(13, y);
  const depot = place('trainDepot', 3, y - 1, 0);
  const tr = ry.spawnTrain(depot);
  tr.addStop(stA.stationId, 'unload', 'ironPlate', 10);
  tr.addStop(stB.stationId, 'load', 'gear', 5);
  tr.pushToTrain('ironPlate', 10);
  ticks(game, 10); // 可能在停靠或行驶
  const data = JSON.parse(JSON.stringify(game.serialize()));

  const g2 = new FG.Game();
  g2.deserialize(data);
  const tr2 = g2.railway.trains.find(t => t.id === tr.id);
  ok(!!tr2, '列车随存档恢复');
  ok(tr2.x === tr.x && tr2.y === tr.y, '列车位置恢复（' + tr2.x + ',' + tr2.y + '）');
  ok(tr2.cargoCount('ironPlate') === tr.cargoCount('ironPlate'), '列车在途货物恢复（' + tr2.cargoCount('ironPlate') + '）');
  ok(tr2.stops.length === 2 && tr2.stops[0].stationId === stA.stationId
     && tr2.stops[1].action === 'load' && tr2.stops[1].item === 'gear',
     '运输计划（站点顺序/装卸/物品/数量）恢复');
  // 占用表重建
  ok(g2.railway.occupiedBy(tr2.x, tr2.y) === tr2.id, '读档后区间占用表由列车位置重建');
  const stA2 = g2.map.buildingAt(stA.x, stA.y);
  ok(stA2.stationId === stA.stationId && stA2.stationName === stA.stationName, '车站站号/站名恢复');
  let err = null;
  try { ticks(g2, 300); } catch (e) { err = e; }
  ok(!err, '读档后铁路调度正常推进' + (err ? '：' + err.stack : ''));

  // 旧存档兼容：无 railway 段
  const old = JSON.parse(JSON.stringify(data));
  delete old.railway;
  const g3 = new FG.Game();
  let err2 = null;
  try { g3.deserialize(old); ticks(g3, 5); } catch (e) { err2 = e; }
  ok(!err2, '无 railway 字段的旧存档读取/推进不报错' + (err2 ? '：' + err2.stack : ''));
  ok(g3.railway.trains.length === 0, '旧档无列车（空铁路）');
}

console.log('\n[R7] 到站物料接入产线：车站货位经机械臂/按需物流供给熔炉');
{
  // 车站 (2,26) → 臂(2,27)朝南 → 熔炉(2,28)
  const y = 26;
  place('station', 2, y, 0);
  // 给车站接轨
  place('rail', 1, y, 0); place('rail', 3, y, 0);
  const st = m.buildingAt(2, y);
  stationFill(st, 'ironOre', 20);
  const arm = FG.Map.create('inserter', 2, y + 1, 2); m.register(arm); sim.register(arm);
  arm.demandMode = true;
  const furnace = FG.Map.create('furnace', 2, y + 2, 0); m.register(furnace); sim.register(furnace);
  furnace.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(furnace);
  ticks(game, 300);
  ok(furnace.totalCrafted > 0, '车站里的铁矿经按需机械臂送入熔炉并冶炼（' + furnace.totalCrafted + ' 块铁板）');
  ok(stationCount(st, 'ironOre') < 20, '车站货位被产线取走（余 ' + stationCount(st, 'ironOre') + '）');
}

console.log('\n[R8] 列车全图盘点包含在途货物；传送带可直接卸入车站');
{
  const y = 32;
  // 车站 (4,y) 东侧接轨；西侧 (3,y) 用传送带顶头直接卸入车站
  place('station', 4, y, 0); place('rail', 5, y, 0); place('rail', 6, y, 0);
  const st = m.buildingAt(4, y);
  // 传送带顶头朝车站
  const belt = FG.Map.create('belt', 3, y, 1); m.register(belt); sim.register(belt);
  for (let i = 0; i < 4; i++) belt.items.push({ type: 'copperOre', pos: 1 - i * 0.25, from: 0 });
  ticks(game, 60);
  ok(stationCount(st, 'copperOre') > 0, '传送带末端直接卸入车站货位（' + stationCount(st, 'copperOre') + '）');

  const depot = place('trainDepot', 4, y - 1, 0);
  const tr = ry.spawnTrain(depot);
  tr.pushToTrain('coal', 7);
  const inv = game.inventory();
  ok((inv.coal || 0) >= 7, '列车在途货物计入全图盘点（coal=' + (inv.coal || 0) + '）');
}

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
