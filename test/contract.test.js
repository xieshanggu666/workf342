/**
 * 供货合同测试：node test/contract.test.js
 * 覆盖：接单/列车分批锁付/独立记账/与生产施工统一争料/完成发科研物资/
 *       逾期释放/取消释放/超额卸货入站货位/拆站释放/读档幂等（不重复扣货领奖）
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
  'js/game/map.js', 'js/game/scheduler.js', 'js/game/railway.js', 'js/game/contracts.js',
  'js/game/sim.js', 'js/game/researchmgr.js', 'js/game/stats.js', 'js/game/save.js',
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
function stationCount(st, item) {
  return st.chest.reduce((n, s) => n + ((!item || s.type === item) ? s.count : 0), 0);
}

const game = new FG.Game();
const gen = FG.Maps.generate(FG.Maps.getPreset('greenfield'), 4242, 'medium');
game.startWithMap(gen, null, 'contract-test');
game.research.completed.add('railTransport');
game.research.completed.add('supplyContract');
const m = game.map, sim = game.sim, ry = game.railway, cm = game.contracts;

function place(type, x, y, dir) {
  const b = FG.Map.create(type, x, y, dir || 0);
  if (b.def.railStation) { b.stationId = 'S' + (ry.stationSeq++); b.stationName = '站点 ' + b.stationId.slice(1); }
  m.register(b); sim.register(b);
  ry.markDirty();
  return b;
}
/** 直线轨道（含指定站点） */
function line(x0, x1, y, stations) {
  for (let x = x0; x <= x1; x++) {
    if (stations[x]) place(stations[x], x, y, 0);
    else place('rail', x, y, 0);
  }
}
/** 跑完直到列车待命或超时 */
function runUntil(n, pred) {
  for (let i = 0; i < n; i++) { game.tickOnce(); if (pred && pred()) return; }
}

// ================= [K1] 科技门控 + 建筑就位 =================
console.log('\n[K1] 科技门控：供货合同科技解锁交付站（轨节点+货位）');
{
  const g = new FG.Game();
  g.startWithMap(FG.Maps.generate(FG.Maps.getPreset('greenfield'), 1, 'medium'), null, 'gate');
  ok(!g.research.isBuildingUnlocked('deliveryStation'), '未研究供货合同时交付站锁定');
  ok(!g.research.canStart('supplyContract'), '铁路货运未完成前不能研究供货合同');
  g.research.completed.add('railTransport');
  ok(g.research.canStart('supplyContract'), '铁路货运完成后供货合同可研究');
  g.research.completed.add('supplyContract');
  ok(g.research.isBuildingUnlocked('deliveryStation'), '研究后交付站解锁');
}

// ================= [K2] 接单 + 列车分批供货锁付、独立记账 =================
console.log('\n[K2] 接单：邀约生成、承接后进入台账；列车分批卸货即时锁付');
{
  const y = 4;
  // 装货站(3) —— 交付站(12) —— 清道待命线(13..16)，让卸完的列车让出交付站
  line(2, 16, y, { 3: 'station', 12: 'deliveryStation' });
  const src = m.buildingAt(3, y);
  const dst = m.buildingAt(12, y);
  src.stationName = '装货站'; dst.stationName = '交付站';
  place('trainDepot', 3, y - 1, 0);

  // 造一份固定邀约并承接
  cm.offers.set(cm.stationKey(dst), { at: game.tickCount, list: [
    { item: 'ironPlate', qty: 30, duration: 300, tier: 1, reward: { science1: 6 } },
  ] });
  ok(cm.acceptOffer(dst, 0), '承接 铁板×30 合同');
  const c = cm.contractAt(dst);
  ok(!!c && c.delivered === 0 && c.qty === 30, '合同台账建立：已交付 0/30');
  ok(cm.getOffers(dst).length === 0, '已有进行中合同时不再显示邀约（一站一单）');

  // 第一趟：装货站装 20 → 交付站卸 20（单程，卸完驶离待命）
  const tr = ry.spawnTrain(game.map.buildingAt(3, y - 1));
  tr.plan.loop = false;
  tr.addStop(src.stationId, 'load', 'ironPlate', 20);
  tr.addStop(dst.stationId, 'unload', 'ironPlate', 20);
  sim.chestAdd(src, 'ironPlate', 100);
  runUntil(2000, () => c.delivered >= 20);
  ok(c.delivered === 20, '首批 20 铁板到站后锁付（delivered=' + c.delivered + '）');
  ok(stationCount(dst, 'ironPlate') === 0, '锁付货物不进交付站货位（货位 ' + stationCount(dst, 'ironPlate') + '）');
  ok(cm.active.includes(c), '合同仍在进行（未完成）');
  // 等列车驶离交付站（让出站格给下一趟）
  runUntil(500, () => !(tr.x === dst.x && tr.y === dst.y) && tr.state === 'idle');
  ok(tr.x !== dst.x || tr.y !== dst.y, '首趟列车已驶离交付站待命（' + tr.x + ',' + tr.y + '）');

  // 第二趟：新列车补 10 件
  const tr2 = new FG.Train('Tc2', 2, y, 1);
  ry.trains.push(tr2); ry.occupy.set('2,' + y, tr2.id);
  tr2.plan.loop = false;
  tr2.addStop(dst.stationId, 'unload', 'ironPlate', 10);
  tr2.pushToTrain('ironPlate', 10);
  runUntil(2000, () => c.delivered >= 30);
  ok(c.delivered === 30, '第二批 10 铁板补齐：delivered=30');
}

// ================= [K3] 完成发奖（科研物资入站货位）、不重复发 =================
console.log('\n[K3] 交齐即完成：锁付货物被提走，科研物资发放到交付站货位');
{
  const dst = m.buildingAt(12, 4);
  const c0 = cm.history[0];
  ok(!!c0 && c0.item === 'ironPlate' && c0.qty === 30, '合同出列进入成交记录');
  ok(!cm.contractAt(dst), '进行中列表已无该合同');
  ok(stationCount(dst, 'science1') === 6, '奖励 自动化科学包×6 已放入交付站货位（实际 '
    + stationCount(dst, 'science1') + '）');
  ok(stationCount(dst, 'ironPlate') === 0, '30 件锁付铁板被客户提走（不在货位）');

  // 再跑若干 tick：不会重复发奖
  const rewardBefore = stationCount(dst, 'science1');
  ticks(game, 100);
  ok(cm.history.length === 1 && stationCount(dst, 'science1') === rewardBefore,
     '完成后继续模拟不重复发奖（奖励仍为 ' + rewardBefore + '）');
}

// ================= [K4] 统一争料 + 独立记账：锁付货物不进施工建材池/调度 =================
console.log('\n[K4] 统一争料：未运出的合同需求料可被生产/施工争用；锁付后任何预算池不可见');
{
  const y = 10;
  line(2, 16, y, { 3: 'station', 12: 'deliveryStation' });
  const src = m.buildingAt(3, y);
  const dst = m.buildingAt(12, y);
  place('trainDepot', 3, y - 1, 0);
  cm.offers.set(cm.stationKey(dst), { at: game.tickCount, list: [
    { item: 'gear', qty: 40, duration: 300, tier: 2, reward: { science1: 8, science2: 4 } },
  ] });
  cm.acceptOffer(dst, 0);
  const c = cm.contractAt(dst);

  // 装货站放 40 齿轮；同时提交一个需要齿轮的施工计划（采矿钻机：齿轮×2/台）
  sim.chestAdd(src, 'gear', 40);
  // 直接用 MaterialPool 口径验证：施工池能看到装货站里的齿轮（合同需求料仍在物流中、可争用）
  // （MaterialPool 是 blueprint.js 内的类，这里复刻其盘点口径）
  const freeBefore = countFree(game, 'gear');
  ok(freeBefore >= 40, '待运合同货物仍是自由货物，与生产/施工统一争料（自由齿轮 ' + freeBefore + '）');

  // 列车只运 25 件（分批锁付）
  const tr = ry.spawnTrain(game.map.buildingAt(3, y - 1));
  tr.plan.loop = false;
  tr.addStop(src.stationId, 'load', 'gear', 25);
  tr.addStop(dst.stationId, 'unload', 'gear', 25);
  runUntil(2000, () => c.delivered >= 25);
  ok(c.delivered === 25, '首批 25 齿轮锁付');
  ok(stationCount(dst, 'gear') === 0, '锁付齿轮不进站货位');
  // 等列车让出站格
  runUntil(500, () => tr.state === 'idle' && !(tr.x === dst.x && tr.y === dst.y));
  const freeAfter = countFree(game, 'gear');
  ok(freeAfter === freeBefore - 25, '锁付后全图自由齿轮减少 25（' + freeBefore + '→' + freeAfter + '，移出物流独立记账）');
  // 站货位里的 0 齿轮也证明调度器/机械臂取不到锁付货
  ok(!dst.chest.some(s => s.type === 'gear' && s.count > 0), '交付站货位无齿轮（锁付独立于货位）');
}

// ================= [K5] 超额/错卸货物入站货位（自由货物） =================
console.log('\n[K5] 超额卸货：只锁付缺口数量，多卸部分进站货位');
{
  const dst = m.buildingAt(12, 10);
  const c = cm.contractAt(dst);
  // 另造一列：车上 30 齿轮（缺口只剩 15），另带 5 铁板（错卸）
  const y = 10;
  const tr2 = new FG.Train('Txd', 2, y, 1);
  ry.trains.push(tr2); ry.occupy.set('2,' + y, tr2.id);
  tr2.plan.loop = false;
  tr2.addStop(dst.stationId, 'unload', null, 40); // 任意物品全卸
  tr2.pushToTrain('gear', 30);
  tr2.pushToTrain('ironPlate', 5);
  runUntil(2000, () => !cm.contractAt(dst));
  // 合同在卸货中途即完成：继续等到列车把余量卸完并驶离待命
  runUntil(2000, () => tr2.state === 'idle' && !(tr2.x === dst.x && tr2.y === dst.y));
  ok(c.delivered === 40 || cm.history[0].qty === 40, '40 齿轮全部锁付（' + c.delivered + '）');
  // 超出缺口 15 齿轮 + 5 铁板应在站货位
  ok(stationCount(dst, 'gear') === 15, '多卸 15 齿轮进入站货位（实际 ' + stationCount(dst, 'gear') + '）');
  ok(stationCount(dst, 'ironPlate') === 5, '非合同货物 5 铁板照常进入站货位');
  ok(stationCount(dst, 'science1') >= 8, '完成发放科学包1 奖励（' + stationCount(dst, 'science1') + '，含上一单）');
  ok(stationCount(dst, 'science2') === 4, '完成发放科学包2×4 奖励');
}

// ================= [K6] 取消合同：释放未交付预留（锁付货物回站货位） =================
console.log('\n[K6] 取消合同：锁付货物释放回交付站物流（站货位/地面堆）');
{
  const y = 16;
  line(2, 16, y, { 3: 'station', 12: 'deliveryStation' });
  const src = m.buildingAt(3, y);
  const dst = m.buildingAt(12, y);
  place('trainDepot', 3, y - 1, 0);
  cm.offers.set(cm.stationKey(dst), { at: game.tickCount, list: [
    { item: 'copperPlate', qty: 50, duration: 300, tier: 1, reward: { science1: 5 } },
  ] });
  cm.acceptOffer(dst, 0);
  const c = cm.contractAt(dst);
  const tr = ry.spawnTrain(game.map.buildingAt(3, y - 1));
  tr.plan.loop = false;
  tr.addStop(src.stationId, 'load', 'copperPlate', 30);
  tr.addStop(dst.stationId, 'unload', 'copperPlate', 30);
  sim.chestAdd(src, 'copperPlate', 60);
  runUntil(2000, () => c.delivered >= 30);
  ok(c.delivered === 30, '已分批锁付 30 铜板');
  ok(stationCount(dst, 'copperPlate') === 0, '锁付中货位为 0');
  cm.cancel(c.id);
  ok(!cm.contractAt(dst), '取消后合同出列');
  ok(stationCount(dst, 'copperPlate') === 30, '30 件锁付预留释放回交付站货位（实际 '
    + stationCount(dst, 'copperPlate') + '）');
  // 释放后再次成为自由货物：复刻施工池盘点可见
  ok(countFree(game, 'copperPlate') >= 30, '释放货物重新进入统一料池可被争用');
}

// ================= [K7] 逾期：自动终止并释放锁付 =================
console.log('\n[K7] 逾期合同：到点自动终止，锁付货物释放，不再收新货');
{
  const y = 22;
  line(2, 16, y, { 12: 'deliveryStation' });
  const dst = m.buildingAt(12, y);
  cm.offers.set(cm.stationKey(dst), { at: game.tickCount, list: [
    { item: 'stone', qty: 20, duration: 5, tier: 1, reward: { science1: 4 } },
  ] });
  cm.acceptOffer(dst, 0);
  const c = cm.contractAt(dst);
  // 直接在台账上记 12 件锁付（模拟已交付未完成），并在站格放实物验证释放路径
  c.delivered = 12;
  const scienceBefore = stationCount(dst, 'science1');
  // 推进超过期限（contracts.tick 按 playTime 判定；tickOnce 不推进 playTime，手动拨时钟）
  game.playTime = c.dueAt + 1;
  cm.tick();
  ok(!cm.contractAt(dst), '逾期后合同自动终止');
  ok(stationCount(dst, 'stone') === 12, '12 件锁付货物逾期释放回站货位（实际 ' + stationCount(dst, 'stone') + '）');
  ok(stationCount(dst, 'science1') === scienceBefore, '逾期不发奖励');

  // 逾期后再有车来卸货，不会再被锁付（合同已不存在）
  const tr = new FG.Train('Tlate', 2, y, 1);
  ry.trains.push(tr); ry.occupy.set('2,' + y, tr.id);
  tr.plan.loop = false;
  tr.addStop(dst.stationId, 'unload', 'stone', 8);
  tr.pushToTrain('stone', 8);
  runUntil(2000, () => tr.state === 'idle');
  ok(stationCount(dst, 'stone') === 20, '逾期后卸货不再锁付：8 件全部入站货位（12+8=20）');
}

// ================= [K8] 拆除交付站：终止合同、锁付货物落地不丢失 =================
console.log('\n[K8] 拆除交付站：合同终止，锁付货物落到站格地面堆');
{
  const y = 26;
  line(2, 16, y, { 12: 'deliveryStation' });
  const dst = m.buildingAt(12, y);
  cm.offers.set(cm.stationKey(dst), { at: game.tickCount, list: [
    { item: 'coal', qty: 30, duration: 300, tier: 1, reward: { science1: 3 } },
  ] });
  cm.acceptOffer(dst, 0);
  const c = cm.contractAt(dst);
  c.delivered = 18;
  ok(game.removeBuilding(dst) !== false, '无车占用时可拆除交付站');
  ok(!cm.active.find(x => x.id === c.id), '合同随站终止，进行中合同已移除');
  const pile = m.pileAt(12, y);
  ok(pile && pile.some(s => s.type === 'coal' && s.count === 18), '18 件锁付煤落到站格地面堆');
}

// ================= [K9] 读档幂等：不重复扣货、不重复领奖，可继续分批供货 =================
console.log('\n[K9] 存档往返：合同台账/期限/邀约恢复，读档后结算不重复');
{
  const y = 30;
  line(2, 16, y, { 3: 'station', 12: 'deliveryStation' });
  const src = m.buildingAt(3, y);
  const dst = m.buildingAt(12, y);
  place('trainDepot', 3, y - 1, 0);
  cm.offers.set(cm.stationKey(dst), { at: game.tickCount, list: [
    { item: 'steelPlate', qty: 25, duration: 300, tier: 2, reward: { science1: 10, science2: 5 } },
  ] });
  cm.acceptOffer(dst, 0);
  const c = cm.contractAt(dst);
  const tr = ry.spawnTrain(game.map.buildingAt(3, y - 1));
  tr.plan.loop = false;
  tr.addStop(src.stationId, 'load', 'steelPlate', 10);
  tr.addStop(dst.stationId, 'unload', 'steelPlate', 10);
  sim.chestAdd(src, 'steelPlate', 60);
  runUntil(2000, () => c.delivered >= 10);
  ok(c.delivered === 10, '读档前已锁付 10 钢板');

  const data = JSON.parse(JSON.stringify(game.serialize()));
  const g2 = new FG.Game();
  g2.deserialize(data);
  const dst2 = g2.map.buildingAt(12, y);
  const c2 = g2.contracts.contractAt(dst2);
  ok(!!c2 && c2.delivered === 10 && c2.qty === 25, '读档后合同台账恢复（10/25），未重复扣货');
  ok(stationCount(dst2, 'steelPlate') === 0, '读档后锁付货物仍不占站货位');
  const histBefore = g2.contracts.history.length;
  ticks(g2, 200);
  ok(g2.contracts.contractAt(dst2) && g2.contracts.contractAt(dst2).delivered === 10,
     '无新卸货事件时台账不变（不凭空结算）');
  ok(g2.contracts.history.length === histBefore, '未完成合同不会在读档后被误判完成、不重复领奖');

  // 读档后继续分批供货：在 g2 中直接调用锁付模拟余下 15 件（等价于第二趟列车卸货）
  sim.chestAdd(dst2, 'steelPlate', 15);
  g2.contracts.onTrainUnloaded(dst2, 'steelPlate');
  ok(!g2.contracts.contractAt(dst2), '补齐 15 件后合同完成');
  ok(stationCount(dst2, 'science1') === 10 && stationCount(dst2, 'science2') === 5,
     '读档后完成仅发一次奖励（s1=' + stationCount(dst2, 'science1') + ', s2=' + stationCount(dst2, 'science2') + '）');
  ok(stationCount(dst2, 'steelPlate') === 0, '25 件锁付钢板全部提走，无重复扣货');
  ticks(g2, 100);
  ok(stationCount(dst2, 'science1') === 10 && stationCount(dst2, 'science2') === 5,
     '读档完成后再模拟不重复发奖');
}

// ================= [K10] 旧存档兼容：无 contracts 字段正常读取推进 =================
console.log('\n[K10] 旧存档兼容：无 contracts 字段不报错，交付站按普通站工作');
{
  const g = new FG.Game();
  const gen2 = FG.Maps.generate(FG.Maps.getPreset('greenfield'), 7, 'medium');
  g.startWithMap(gen2, null, 'old-save');
  const data = JSON.parse(JSON.stringify(g.serialize()));
  delete data.contracts;
  const g2 = new FG.Game();
  let err = null;
  try { g2.deserialize(data); ticks(g2, 50); } catch (e) { err = e; }
  ok(!err, '无 contracts 字段旧档读取/推进不报错' + (err ? '：' + err.stack : ''));
  ok(g2.contracts.active.length === 0, '旧档无进行中合同');
}

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);

// ================= 辅助：复刻施工 MaterialPool 的自由货物盘点口径 =================
function countFree(g, item) {
  let n = 0;
  for (const b of g.map.buildings.values()) {
    if (!b.def.storage) continue;
    for (const s of b.chest) if (s.type === item) n += s.count;
  }
  for (const pile of g.map.piles.values()) {
    for (const s of pile) if (s.type === item) n += s.count;
  }
  return n;
}
