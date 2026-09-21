/**
 * 无头仿真测试：node test/sim.test.js
 * 加载全部数据/核心/逻辑脚本（跳过 UI），验证物流迭代项
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

const game = new FG.Game();
const gen = FG.Maps.generate(FG.Maps.getPreset('greenfield'), 12345, 'medium');
game.startWithMap(gen, null, 'test');
const m = game.map, sim = game.sim;

function place(type, x, y, dir) {
  const b = FG.Map.create(type, x, y, dir || 0);
  m.register(b); sim.register(b);
  return b;
}
function remove(b) { sim.unregister(b); m.unregister(b); }
function fillBelt(b, type) {
  b.items.length = 0;
  for (let i = 0; i < FG.Config.BELT_CAP; i++) b.items.push({ type, pos: 1 - i * 0.25, from: 0 });
}
function chestCount(b, type) {
  const s = b.chest.find(x => x.type === type);
  return s ? s.count : 0;
}
function pileCountAt(x, y, type) {
  const p = m.pileAt(x, y);
  if (!p) return 0;
  const s = p.find(x => x.type === type);
  return s ? s.count : 0;
}
function beltCount(b, t) { return b.items.filter(i => i.type === t).length; }
function shallowGen() {
  return {
    presetId: 'greenfield', biome: 'grass', w: gen.w, h: gen.h, seed: 1, sizeId: 'medium',
    terrain: gen.terrain,
    ores: gen.ores.map(row => row.map(c => c ? { type: c.type, amount: c.amount } : null)),
    water: gen.water, oil: gen.oil,
  };
}

console.log('\n[1] 传送带转弯 + 侧入合流：物品沿折线走通');
{
  const b1 = place('belt', 5, 5, 1);   // 向东
  const b2 = place('belt', 6, 5, 0);   // 向北（b1 从右侧转弯汇入）
  const b3 = place('belt', 6, 4, 1);   // 向东接走
  const chest = place('chest', 7, 4);
  fillBelt(b1, 'ironOre');
  ok(FG.Map.beltFeedsInto(b1, b2), 'b1 允许汇入 b2');
  ok(FG.Map.beltEntrySide(b2, 5, 5) === 2, '西向汇入边识别正确（side=2）');
  ticks(game, 400);
  ok(chestCount(chest, 'ironOre') > 0, '物品经转弯带送达末端箱子（' + chestCount(chest, 'ironOre') + ' 件）');
  const total = b1.items.length + b2.items.length + b3.items.length
    + chest.chest.reduce((n, s) => n + s.count, 0);
  ok(total === 4, '转弯全程物品守恒（4 件，实际 ' + total + '）');
}

console.log('\n[2] 多路汇入：轮转公平合流，一侧不会被饿死');
{
  const feedBack = place('belt', 8, 10, 1);  // 背部直入 dst
  const feedSide = place('belt', 9, 11, 0);  // 侧入 dst（向北）
  const dst = place('belt', 9, 10, 1);       // 向东
  const tail = place('belt', 10, 10, 1);
  const chest = place('chest', 11, 10);
  fillBelt(feedBack, 'ironOre');
  fillBelt(feedSide, 'coal');
  ticks(game, 500);
  const nOre = chestCount(chest, 'ironOre'), nCoal = chestCount(chest, 'coal');
  console.log('    合流结果：铁矿', nOre, '煤', nCoal);
  ok(nOre > 0 && nCoal > 0, '两路都通过（无一侧饿死）');
  ok(Math.abs(nOre - nCoal) <= 2, '两路流量均衡（轮转）');
  const total = nOre + nCoal + feedBack.items.length + feedSide.items.length
    + dst.items.length + tail.items.length;
  ok(total === 8, '合流全程物品守恒（8 件，实际 ' + total + '）');
}

console.log('\n[3] 拥堵：封闭端堵满后状态 blocked，物品不丢不增');
{
  const b1 = place('belt', 15, 15, 1);
  const b2 = place('belt', 16, 15, 1); // 前端(17,15)为空
  fillBelt(b1, 'stone');
  ticks(game, 300);
  const total = b1.items.length + b2.items.length;
  ok(total === 4, '封闭端物品守恒（4 件，实际 ' + total + '）');
  ok(b2.status === 'blocked' && b2.items.length === FG.Config.BELT_CAP, '最前端堵点 blocked 且装满（b2=' + b2.status + '）');
  const b3 = place('chest', 17, 15);
  ticks(game, 200);
  ok(chestCount(b3, 'stone') > 0, '打通后堵塞解除、物品继续流动');
}

console.log('\n[4] 机械臂筛选条件');
{
  const chest = place('chest', 20, 20);
  sim.chestAdd(chest, 'ironOre', 20);
  sim.chestAdd(chest, 'copperOre', 20);
  const arm = place('inserter', 21, 20, 1);   // 朝东：箱子(20,20)→箱子(22,20)
  const out = place('chest', 22, 20);
  arm.filter = 'ironOre';
  ticks(game, 300);
  ok(chestCount(out, 'ironOre') > 0, '筛选物品被搬运（铁矿 ' + chestCount(out, 'ironOre') + '）');
  ok(chestCount(out, 'copperOre') === 0, '未筛选物品不搬运（铜矿 0）');
}

console.log('\n[5] 机械臂按下游缺料取放（需求驱动）');
{
  // 供应链：箱子(30,25) →臂A(31,25)朝东→ 带(32,25)→(33,25)
  // (33,25)为向南转弯带，接到 (33,26)
  // 臂B(33,27)朝南(dir=2)：源=身后(33,26)带，目标=面前(33,28)熔炉
  const chest = place('chest', 30, 25);
  sim.chestAdd(chest, 'ironOre', 30);
  sim.chestAdd(chest, 'copperOre', 30);
  const armA = place('inserter', 31, 25, 1);
  armA.demandMode = true;

  // 5a 死路：只铺到 (32,25)
  const belt0 = place('belt', 32, 25, 1);
  ticks(game, 80);
  ok(belt0.items.length === 0, '下游无消费者时不抓取（死路带保持空）');

  // 5b 延长：(33,25)为向南转弯带，再接南向带与熔炉
  const corner = place('belt', 33, 25, 2);
  const beltS = place('belt', 33, 26, 2);
  const furnace = place('furnace', 33, 28);
  furnace.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(furnace);
  const armB = place('inserter', 33, 27, 2); // 朝南：源(33,26)，目标(33,28)
  armB.demandMode = true;
  ticks(game, 300);
  // 在途预留总量 = 熔炉槽内 + 带面/臂手上带预留标签的铁矿（本次升级：在途也占位）
  const pipeIron = () => {
    let n = furnace.slots.inputs.ironOre.count;
    for (const bb of [belt0, corner, beltS]) for (const it of bb.items) if (it.tag && it.tag.item === 'ironOre') n++;
    for (const a of [armA, armB]) if (a.held && a.held.tag && a.held.tag.item === 'ironOre') n++;
    return n;
  };
  const fedEver = pipeIron() > 0 || furnace.totalCrafted > 0;
  ok(fedEver, '缺料时铁矿被沿带（含转弯）追踪并送入熔炉（在途+库存 ' + pipeIron() + '，已炼 ' + furnace.totalCrafted + '）');
  ok(pipeIron() <= 2, '在途预留联动：带面+槽内总量 ≤2 份缓冲（实际 ' + pipeIron() + '）');
  const copperOnLine = beltCount(belt0, 'copperOre') + beltCount(corner, 'copperOre')
    + beltCount(beltS, 'copperOre') + (furnace.slots.inputs.copperOre ? furnace.slots.inputs.copperOre.count : 0);
  ok(copperOnLine === 0, '下游不需要的铜矿不会被按需臂投放到线上');

  // 5c 需求门控：熔炉持续生产期间，铁矿按消耗补料，槽内+在途缓冲始终不超过 2 件（不堆积）
  // 初始置为恰好 2 件在库：清掉带面/臂手上的在途预留，避免预置库存重复计数
  for (const bb of [belt0, corner, beltS]) bb.items.length = 0;
  armA.held = null; armB.held = null;
  furnace.slots.inputs.ironOre.count = 2;
  let overflow = 0;
  for (let i = 0; i < 200; i++) {
    game.tickOnce();
    if (pipeIron() > 2) overflow++;
  }
  ok(overflow === 0, '持续生产时按缺料补充，在途+槽内缓冲始终 ≤2（无过量堆积）');
  ok(furnace.totalCrafted > 0, '熔炉正常完成冶炼（' + furnace.totalCrafted + ' 次）');
}


console.log('\n[6] 切换配方：物料保留、不阻塞生产、残留可被运走');
{
  const f = place('furnace', 40, 30);
  f.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(f);
  f.slots.inputs.ironOre.count = 5;
  game.setRecipe(f, 'smelt:copper');
  ok(f.slots.inputs.ironOre && f.slots.inputs.ironOre.count === 5, '旧配方铁矿槽保留');
  ok(!!f.slots.inputs.copperOre, '新配方铜矿槽建立');
  f.slots.inputs.copperOre.count = 3;
  ticks(game, 30);
  ok(f.status === 'working', '残留槽不阻塞新配方生产（状态=' + f.status + '）');
  const chest = place('chest', 42, 30);
  const arm = place('inserter', 41, 30, 1); // 朝东：源(40,30)熔炉 → (42,30)箱子
  ticks(game, 300);
  ok(chestCount(chest, 'ironOre') === 5, '残留铁矿全部运出（5 件，实际 ' + chestCount(chest, 'ironOre') + '）');
}

console.log('\n[7] 拆除建筑：物料落地；重建回收；在途物品不丢');
{
  const f = place('furnace', 50, 40);
  f.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(f);
  f.slots.inputs.ironOre.count = 7;
  f.slots.outputs.ironPlate.count = 4;
  game.removeBuilding(f);
  const pile = m.pileAt(50, 40);
  ok(!!pile, '拆除后出现地面物料堆');
  ok(pileCountAt(50, 40, 'ironOre') === 7 && pileCountAt(50, 40, 'ironPlate') === 4, '地面物料数量正确（7+4）');

  const belt = place('belt', 51, 40, 1);
  belt.items.push({ type: 'gear', pos: 0.4, from: 3 });
  game.removeBuilding(belt);
  ok(pileCountAt(51, 40, 'gear') === 1, '传送带上在途齿轮落地');

  const arm = place('inserter', 52, 40, 1);
  arm.held = { type: 'circuit' };
  game.removeBuilding(arm);
  ok(pileCountAt(52, 40, 'circuit') === 1, '机械臂手中物品落地');

  const chest = FG.Map.create('chest', 50, 40, 0);
  m.register(chest); sim.register(chest);
  game.absorbPile(chest);
  const got = chest.chest.reduce((n, s) => n + s.count, 0);
  ok(got === 11, '重建后回收全部物料（11 件，实际 ' + got + '）');
  ok(!m.pileAt(50, 40), '回收后地面堆清空');
}

console.log('\n[8] 存档恢复：全部调度状态随存档还原');
{
  const g2 = new FG.Game();
  g2.startWithMap(shallowGen(), null, 'save-test');
  const belt = FG.Map.create('belt', 3, 3, 1);
  belt.items.push({ type: 'circuit', pos: 0.42, from: 3 });
  belt.rr = 2; belt.status = 'working';
  const ins = FG.Map.create('fastInserter', 4, 3, 0);
  ins.filter = 'gear'; ins.demandMode = true; ins.held = { type: 'gear' }; ins.timer = 3;
  const pipe = FG.Map.create('pipe', 5, 3, 0);
  pipe.level = 40; pipe.fluidType = 'water';
  for (const b of [belt, ins, pipe]) { g2.map.register(b); g2.sim.register(b); }
  g2.map.pileAdd(6, 6, 'coal', 9);

  const data = JSON.parse(JSON.stringify(g2.serialize()));
  const g3 = new FG.Game();
  g3.deserialize(data);

  const b3 = g3.map.buildingAt(3, 3);
  const i3 = g3.map.buildingAt(4, 3);
  const p3 = g3.map.buildingAt(5, 3);
  ok(b3.items.length === 1 && b3.items[0].type === 'circuit'
     && Math.abs(b3.items[0].pos - 0.42) < 1e-9 && b3.items[0].from === 3, '在途物品（类型/位置/进料侧）恢复');
  ok(b3.rr === 2, '合流轮转游标恢复');
  ok(i3.filter === 'gear' && i3.demandMode === true && i3.held.type === 'gear' && i3.timer === 3,
     '机械臂筛选/按需/手持/计时恢复');
  ok(Math.abs(p3.level - 40) < 1e-9 && p3.fluidType === 'water', '管道液位与流体类型恢复');
  const pile = g3.map.pileAt(6, 6);
  ok(pile && pile[0].type === 'coal' && pile[0].count === 9, '地面物料堆恢复');
  let err = null;
  try { ticks(g3, 30); } catch (e) { err = e; }
  ok(!err, '恢复后仿真正常推进' + (err ? '：' + err.stack : ''));
}

console.log('\n[9] 多消费者争料：高优先级产线优先得料')
{
  // 共用料箱 (6,16)（箱内仅 2 件铁矿）：
  //  A 线：箱(6,16)→臂(7,16)朝东→熔炉A(8,16)，高优先
  //  B 线：箱(6,16)→臂(6,17)朝南→熔炉B(6,18)，低优先
  const box = place('chest', 6, 16);
  sim.chestAdd(box, 'ironOre', 2);
  const aA = place('inserter', 7, 16, 1); aA.demandMode = true;
  const FA = place('furnace', 8, 16); FA.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(FA); FA.priority = 'high';
  const aB = place('inserter', 6, 17, 2); aB.demandMode = true;
  const FB = place('furnace', 6, 18); FB.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(FB); FB.priority = 'low';
  // 用累计接收量（在库 + 已冶炼）衡量谁得了料，避免矿石被即时冶炼后归零
  let maxA = 0, maxB = 0;
  for (let i = 0; i < 60; i++) {
    game.tickOnce();
    maxA = Math.max(maxA, FA.slots.inputs.ironOre.count + FA.totalCrafted);
    maxB = Math.max(maxB, FB.slots.inputs.ironOre.count + FB.totalCrafted);
  }
  console.log('    高优 A 累计得料 ' + maxA + '，低优 B 累计得料 ' + maxB);
  ok(maxA === 2 && maxB === 0, '稀缺 2 件全给高优先级产线（A=2,B=0，实际 A=' + maxA + ',B=' + maxB + '）');
}

console.log('\n[10] 同优先级轮转公平：两台熔炉长期均分')
{
  const box = place('chest', 14, 16);
  sim.chestAdd(box, 'ironOre', 40);
  const aA = place('inserter', 15, 16, 1); aA.demandMode = true;
  const FA = place('furnace', 16, 16); FA.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(FA);
  const aB = place('inserter', 14, 17, 2); aB.demandMode = true;
  const FB = place('furnace', 14, 18); FB.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(FB);
  ticks(game, 800);
  console.log('    同级 A 冶炼 ' + FA.totalCrafted + ' / B 冶炼 ' + FB.totalCrafted);
  ok(FA.totalCrafted > 0 && FB.totalCrafted > 0, '两台同级熔炉都在生产（无饿死）');
  ok(Math.abs(FA.totalCrafted - FB.totalCrafted) <= 4, '同级产量接近（轮转公平，差 ' + Math.abs(FA.totalCrafted - FB.totalCrafted) + '）');
}

console.log('\n[11] 环路传送带：预留货物沿环绕行被取走，不卡死、不重复投放')
{
  // 顺时针环（全背入）：(24,24)东→(25,24)南→(25,25)西→(24,25)北
  const L1 = place('belt', 24, 24, 1), L2 = place('belt', 25, 24, 2),
        L3 = place('belt', 25, 25, 3), L4 = place('belt', 24, 25, 0);
  // fA：臂(26,24)朝东，身后(25,24)=L2 取料，前方(27,24)放熔炉
  const aA = place('inserter', 26, 24, 1); aA.demandMode = true;
  const FA = place('furnace', 27, 24); FA.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(FA);
  // fB：臂(25,26)朝南，身后(25,25)=L3 取料，前方(25,27)放熔炉
  const aB = place('inserter', 25, 26, 2); aB.demandMode = true;
  const FB = place('furnace', 25, 27); FB.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(FB);
  // 料源：箱(22,24)→臂(23,24)朝东投入 L1(24,24)
  const chest = place('chest', 22, 24);
  sim.chestAdd(chest, 'ironOre', 30);
  const armIn = place('inserter', 23, 24, 1); armIn.demandMode = true;

  ticks(game, 600);
  const fed = FA.totalCrafted + FB.totalCrafted;
  console.log('    环上熔炉冶炼 fA=' + FA.totalCrafted + ' fB=' + FB.totalCrafted);
  ok(fed > 0, '环路上货物绕行并被取料臂送入熔炉（共炼 ' + fed + '）');
  let reservedOnLoop = 0;
  for (const bb of [L1, L2, L3, L4]) for (const it of bb.items) if (it.tag) reservedOnLoop++;
  const pipeline = reservedOnLoop
    + (aA.held && aA.held.tag ? 1 : 0) + (aB.held && aB.held.tag ? 1 : 0)
    + FA.slots.inputs.ironOre.count + FB.slots.inputs.ironOre.count;
  ok(pipeline <= 4, '两炉在途+在库预留总量 ≤4（不沿环重复投放，实际 ' + pipeline + '）');
  let rest = chestCount(chest, 'ironOre');
  for (const bb of [L1, L2, L3, L4]) rest += bb.items.length;
  for (const a of [armIn, aA, aB]) if (a.held) rest++;
  rest += FA.slots.inputs.ironOre.count + FB.slots.inputs.ironOre.count + fed;
  ok(rest === 30, '环路全程物品守恒（' + rest + '/30）');
  const tr = sim.scheduler.traceInserter(armIn);
  ok(tr && !tr.terminal && tr.items.size === 2, '环路需求追踪安全终止、无死循环（到达 2 个消费者）');

  // 死路环（无消费者）：按需臂不投放
  const chest2 = place('chest', 32, 30);
  sim.chestAdd(chest2, 'ironOre', 10);
  const D1 = place('belt', 34, 30, 1), D2 = place('belt', 35, 30, 2),
        D3 = place('belt', 35, 31, 3), D4 = place('belt', 34, 31, 0);
  const armDead = place('inserter', 33, 30, 1); armDead.demandMode = true;
  ticks(game, 100);
  let onDead = 0;
  for (const bb of [D1, D2, D3, D4]) onDead += bb.items.length;
  ok(onDead === 0 && chestCount(chest2, 'ironOre') === 10, '无消费者的死路环不被投放（环空、箱余 10）');
}

console.log('\n[12] 配方切换：旧配方在途预留立即释放，改供新配方/其他消费者')
{
  const c = place('chest', 30, 16);
  sim.chestAdd(c, 'ironOre', 30); sim.chestAdd(c, 'copperOre', 30);
  const arm = place('inserter', 31, 16, 1); arm.demandMode = true;
  const fA = place('furnace', 32, 16); fA.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(fA);
  ticks(game, 60);
  const ironFed = fA.slots.inputs.ironOre.count + fA.totalCrafted + (arm.held ? 1 : 0);
  ok(ironFed > 0, '切换前铁矿正常供入 A（' + ironFed + '）');

  // 第二台仍吃铁矿的熔炉 B：箱(30,16)→臂(30,17)朝南→B(30,18)
  const armB = place('inserter', 30, 17, 2); armB.demandMode = true;
  const fB = place('furnace', 30, 18); fB.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(fB);
  game.setRecipe(fA, 'smelt:copper');
  ticks(game, 400);
  const copper = fA.slots.inputs.copperOre.count + fA.totalCrafted;
  console.log('    切换后 A 铜板 ' + copper + '，A 铁矿残留 ' + fA.slots.inputs.ironOre.count
    + '，B 冶炼 ' + fB.totalCrafted);
  ok(copper > 0, 'A 切换后立即按新配方供入铜矿并产出铜板（' + copper + '）');
  ok(fB.totalCrafted > 0, 'A 不再需要的铁矿被调度给另一消费者 B（B 炼 ' + fB.totalCrafted + '）');
}

console.log('\n[13] 拆除释放预留 + 读档恢复调度（预留标签/优先级），兼容旧存档')
{
  // 给带面注入一件带预留标签的在途货物，模拟已预留给某熔炉
  const belt = place('belt', 40, 24, 1);
  belt.items.push({ type: 'ironOre', pos: 0.3, from: 0, tag: { c: '41,24', item: 'ironOre', t0: game.tickCount } });
  const f = place('furnace', 41, 24); f.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(f); f.priority = 'high';
  game.removeBuilding(f);
  ticks(game, 2);
  ok(!belt.items.some(it => it.tag), '目标消费者拆除后，在途预留标签自动剥离（释放给自由料池）');
  game.removeBuilding(belt);
  ok(pileCountAt(40, 24, 'ironOre') === 1, '拆带后货物作为自由物料落地');

  // 存档/读档：优先级与在途预留标签随档还原
  const g2 = new FG.Game();
  g2.startWithMap(shallowGen(), null, 'save2');
  const f2 = FG.Map.create('furnace', 5, 5, 0);
  f2.recipe = 'smelt:iron'; FG.Map.syncRecipeSlots(f2); f2.priority = 'high';
  const belt2 = FG.Map.create('belt', 4, 5, 1);
  belt2.items.push({ type: 'ironOre', pos: 0.5, from: 0, tag: { c: '5,5', item: 'ironOre', t0: 3 } });
  for (const b of [f2, belt2]) { g2.map.register(b); g2.sim.register(b); }
  const data = JSON.parse(JSON.stringify(g2.serialize()));
  const g3 = new FG.Game();
  g3.deserialize(data);
  const f3 = g3.map.buildingAt(5, 5), b3 = g3.map.buildingAt(4, 5);
  ok(f3.priority === 'high', '供料优先级随存档恢复');
  ok(b3.items[0].tag && b3.items[0].tag.c === '5,5', '在途预留标签随存档恢复（读档后调度无缝继续）');
  let err = null;
  try { ticks(g3, 20); } catch (e) { err = e; }
  ok(!err, '带预留标签读档后仿真无异常' + (err ? '：' + err.stack : ''));

  // 旧存档兼容：无 priority / 无 tag 字段
  const old = JSON.parse(JSON.stringify(data));
  delete old.buildings.find(x => x.type === 'furnace').priority;
  old.buildings.find(x => x.type === 'belt').items[0].tag = undefined;
  const g4 = new FG.Game();
  let err2 = null;
  try { g4.deserialize(old); } catch (e) { err2 = e; }
  ok(!err2, '旧存档（无优先级/无标签字段）读取不报错');
  ok(g4.map.buildingAt(5, 5).priority === 'normal', '旧存档建筑优先级回退为普通');
  ok(!g4.map.buildingAt(4, 5).items[0].tag, '旧存档在途物品无预留标签（按自由货物处理）');
  try { ticks(g4, 20); } catch (e) { err2 = e; }
  ok(!err2, '旧存档读入后仿真正常推进');
}

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
