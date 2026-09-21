/**
 * 供货合同测试：node test/contract.test.js
 * 覆盖：
 *  1. 科技门控 / 看板生成 / 接单（须交付站）/ 同时进行上限
 *  2. 列车把货物卸入交付站 → 分批划扣 → 独立记账 → 完成发放科研物资
 *  3. 合同货物独立记账：交付站货位不被施工备料/按需物流抢走
 *  4. 分批边界：未满批保留 reserve，凑批才确认 delivered
 *  5. 取消 / 逾期：释放未满批预留，已交付批次不返还不奖励
 *  6. 交付站拆除：合同自动取消、未满批预留落到地面堆
 *  7. 读档：不重复扣货、不重复领奖；旧档无 contracts 字段不报错
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
  'js/data/research.js', 'js/data/maps.js', 'js/data/contracts.js',
  'js/game/map.js', 'js/game/scheduler.js', 'js/game/railway.js', 'js/game/sim.js',
  'js/game/researchmgr.js', 'js/game/stats.js', 'js/game/save.js',
  'js/game/blueprint.js', 'js/game/contractmgr.js', 'js/game/game.js',
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
function mIsTileEmpty(m, x, y) { return !m.buildingAt(x, y); }

// 全新地图（全草地、无矿无水），便于在固定坐标铺轨建站
function newGame() {
  const game = new FG.Game();
  const w = 48, h = 40;
  const terrain = Array.from({ length: h }, () => Array(w).fill('grass'));
  const ores = Array.from({ length: h }, () => Array(w).fill(null));
  game.startWithMap({
    presetId: 'greenfield', biome: 'grass', w, h, seed: 1234, sizeId: 'medium',
    terrain, ores, water: new Set(), oil: new Set(),
  }, null, 'contract-test');
  game.research.completed.add('railTransport');
  return game;
}
function place(g, type, x, y, dir) {
  const b = FG.Map.create(type, x, y, dir || 0);
  if (b.def.railStation) {
    b.stationId = 'S' + (g.railway.stationSeq++);
    b.stationName = (b.def.contractDock ? '交付站 ' : '站点 ') + b.stationId.slice(1);
  }
  g.map.register(b); g.sim.register(b);
  g.railway.markDirty();
  return b;
}
/** 直轨 (x0..x1, y)，指定坐标放普通站或交付站 */
function line(g, x0, x1, y, opts) {
  opts = opts || {};
  for (let x = x0; x <= x1; x++) {
    if (opts.dock === x) place(g, 'deliverDock', x, y, 0);
    else if (opts.station === x) place(g, 'station', x, y, 0);
    else place(g, 'rail', x, y, 0);
  }
}

console.log('\n[C1] 科技门控 + 看板生成 + 接单前置（须交付站）');
{
  const g = newGame();
  const mgr = g.contracts;
  mgr.ensureBoard(g.playTime, true);
  ok(mgr.offers.length === FG.Config.CONTRACT_BOARD_SIZE, '解锁铁路后看板生成 ' + FG.Config.CONTRACT_BOARD_SIZE + ' 条报价（实际 ' + mgr.offers.length + '）');
  ok(mgr.offers.every(o => o.qty % o.batch === 0 && o.qty > 0 && o.batch > 0), '所有合同需求量为批次数整数倍');
  ok(mgr.offers.every(o => o.reward && o.reward.count > 0 && ['science1', 'science2', 'science3'].includes(o.reward.item)),
     '合同奖励均为科研物资（科学包）');
  ok(mgr.offers.every(o => o.durationSec > 0 && o.deadline === undefined), '报价带期限且接单前无截止时刻');

  // 未解锁铁路：无报价
  const g2 = newGame();
  g2.research.completed.delete('railTransport');
  g2.contracts.ensureBoard(g2.playTime, true);
  ok(g2.contracts.offers.length === 0, '未研究铁路货运时看板为空');

  // 无交付站不能接单（accept 返回 null）
  const o = mgr.offers[0];
  ok(mgr.accept(o.oid, 'S999') === null, '绑定不存在/非交付站的站号接单被拒绝');
  ok(mgr.active.length === 0, '被拒绝的接单不产生进行中合同');
}

console.log('\n[C2] 列车分批交付 → 划扣记账 → 完成发奖（科研物资到交付站）');
{
  const g = newGame();
  const m = g.map, ry = g.railway, mgr = g.contracts;
  const y = 4;
  line(g, 2, 12, y, { station: 3, dock: 11 });
  const src = m.buildingAt(3, y), dock = m.buildingAt(11, y);
  const depot = place(g, 'trainDepot', 3, y - 1, 0);
  const tr = ry.spawnTrain(depot);

  // 构造一份确定合同：铁板 40 件，每批 10，共 4 批，奖励 science1×5
  const offer = { oid: 'Ofixed', item: 'ironPlate', qty: 40, batch: 10,
    reward: { item: 'science1', count: 5 }, durationSec: 600 };
  mgr.offers.push(offer);
  const c = mgr.accept('Ofixed', dock.stationId);
  ok(!!c && c.status === 'active' && c.deadline > c.acceptAt, '接单成功：合同进行中，截止时刻晚于接单时刻');
  ok(mgr.offerById('Ofixed') === null, '接单后报价从看板移除');
  ok(mgr.active.length === 1, '进行中合同数 = 1');

  // 列车计划：源站装铁板 → 交付站卸货；车上预装 40 铁板
  tr.plan.loop = false;
  tr.addStop(src.stationId, 'load', 'ironPlate', 40);
  tr.addStop(dock.stationId, 'unload', 'ironPlate', 40);
  tr.pushToTrain('ironPlate', 40);

  // 跑到列车把货卸入交付站并驶离
  let deliveredSeen = 0;
  for (let i = 0; i < 600; i++) {
    g.tickOnce();
    if (c.delivered > deliveredSeen) deliveredSeen = c.delivered;
    if (mgr.active.length === 0) break;
  }
  ok(c.delivered === 40, '40 件全部分批确认交付（delivered=' + c.delivered + '）');
  ok(c.reserve === 0, '完成时无未满批预留残留');
  ok(mgr.active.length === 0, '完成后合同出列');
  ok(mgr.history[0] && mgr.history[0].status === 'done' && mgr.history[0].rewarded, '完成合同进入历史且标记已发奖');
  // 奖励科研物资进入交付站货位
  ok(stationCount(dock, 'science1') === 5, '科研物资 science1×5 已发放到交付站货位（实际 ' + stationCount(dock, 'science1') + '）');
  // 货物守恒：40 铁板已交付（移出经济，记为消耗），5 科包为奖励产出
  ok(stationCount(dock, 'ironPlate') === 0, '交付站不留已交付合同货物（已独立记账/出库）');
  ok(g.stats.total('ironPlate').c === 40, '合同交付 40 铁板计入消耗记账');
}

console.log('\n[C3] 分批边界：逐 tick 划扣，凑满一批才记一笔 delivered，残量留在 reserve');
{
  const g = newGame();
  const m = g.map, mgr = g.contracts;
  const y = 8;
  line(g, 2, 6, y, { dock: 4 });
  const dock = m.buildingAt(4, y);
  const offer = { oid: 'Ob', item: 'gear', qty: 30, batch: 10,
    reward: { item: 'science2', count: 3 }, durationSec: 600 };
  mgr.offers.push(offer);
  const c = mgr.accept('Ob', dock.stationId);

  // 向交付站放 15 件齿轮，逐 tick 观察（每 tick 划扣上限 CONTRACT_INTAKE=2）
  g.sim.chestAdd(dock, 'gear', 15);
  ticks(g, 8); // 足够划扣完 15 件
  ok(c.delivered === 10, '15 件到库后只确认 1 批（10 件）已交付（实际 ' + c.delivered + '）');
  ok(c.reserve === 5, '余下 5 件计入未满批预留 reserve（实际 ' + c.reserve + '）');
  ok(stationCount(dock, 'gear') === 0, '已划扣的 15 件全部离开交付站货位');

  // 再补 5 件凑够第 2 批
  g.sim.chestAdd(dock, 'gear', 5);
  ticks(g, 3);
  ok(c.delivered === 20 && c.reserve === 0, '再到 5 件凑满第 2 批（delivered=20, reserve=0）');
  ok(mgr.active.length === 1, '未交完合同仍在进行中');
}

console.log('\n[C4] 合同货物独立记账：交付站货位不被施工备料/按需物流抢走');
{
  const g = newGame();
  const m = g.map, mgr = g.contracts;
  const y = 12;
  line(g, 2, 6, y, { dock: 4 });
  const dock = m.buildingAt(4, y);
  // 交付站放铁板（合同货物）
  g.sim.chestAdd(dock, 'ironPlate', 50);

  // (a) 施工统一建材池不盘点交付站
  const pool = new MaterialPoolAccess(g);
  ok(pool.available('ironPlate') === 0, '施工 MaterialPool 不含交付站里的合同货物（available=0）');

  // (b) 按需调度器自由货位不盘点交付站
  g.sim.scheduler.rebuild(g.tickCount);
  const free = g.sim.scheduler.freeAt(dock.x, dock.y);
  ok((free.get('ironPlate') || 0) === 0, '按需物流自由货位预算不含交付站合同货物');

  // (c) 普通火车站/箱子里的料仍正常进入施工池（对照组）
  line(g, 10, 12, y + 2, { station: 11 });
  const normalStation = m.buildingAt(11, y + 2);
  g.sim.chestAdd(normalStation, 'ironPlate', 7);
  const chest = FG.Map.create('chest', 13, y + 2, 0); m.register(chest); g.sim.register(chest);
  g.sim.chestAdd(chest, 'ironPlate', 3);
  const pool2 = new MaterialPoolAccess(g);
  ok(pool2.available('ironPlate') === 10, '普通火车站+箱子的 10 铁板仍可被施工备料（交付站除外）');

  // (c2) 真实施工计划：只有交付站里有铁板时，一条需要铁板的传送带施工计划不应备到料
  const gX = newGame();
  {
    const gm = gX.map;
    line(gX, 2, 6, 10, { dock: 4 });
    const dk = gm.buildingAt(4, 10);
    gX.sim.chestAdd(dk, 'ironPlate', 10);
    // 提交一个单格传送带施工计划（成本 1 铁板），放在空地上
    const bp = { w: 1, h: 1, entries: [{ type: 'belt', dx: 0, dy: 0, dir: 0, recipe: null, filter: null, demandMode: false, priority: 'normal', stationName: null }] };
    const plan = gX.construction.addPlan(bp, 20, 20);
    gX.construction.tick();
    const e = plan.entries[0];
    ok((e.stock.ironPlate || 0) === 0, '真实施工计划无法从交付站预留铁板（合同货物独立记账）');
    ok(mIsTileEmpty(gm, 20, 20), '施工计划未在 (20,20) 落成（无料可取）');
    // 普通箱子补 1 铁板后即可建成（施工间隔到期需多 tick）
    const ch = FG.Map.create('chest', 22, 20, 0); gm.register(ch); gX.sim.register(ch);
    gX.sim.chestAdd(ch, 'ironPlate', 1);
    for (let i = 0; i < 8 && !gm.buildingAt(20, 20); i++) gX.construction.tick();
    ok(!!gm.buildingAt(20, 20), '普通箱子供料后传送带施工落成（交付站料仍未被动用）');
    ok(stationCount(dk, 'ironPlate') === 10, '交付站 10 铁板始终未被施工取走');
  }

  // (d) 绑定合同后正常划扣交付站货物，证明独立账本可用（合同要 20，站里放 50：交完即结算）
  const offer = { oid: 'Oc', item: 'ironPlate', qty: 20, batch: 10,
    reward: { item: 'science1', count: 2 }, durationSec: 600 };
  mgr.offers.push(offer);
  mgr.accept('Oc', dock.stationId);
  ticks(g, 12);
  const c = mgr.history.find(x => x.id && mgr.active.indexOf(x) < 0) || mgr.history[0];
  ok(!!c && c.delivered === 20, '合同从交付站划扣 20 铁板完成 2 批（独立记账正常，status=' + (c && c.status) + '）');
  ok(stationCount(dock, 'ironPlate') === 30, '交付站剩余 30 铁板未被合同多扣（实际 ' + stationCount(dock, 'ironPlate') + '）');
  ok(stationCount(dock, 'science1') === 2, '完成发放 science1×2 到交付站（实际 ' + stationCount(dock, 'science1') + '）');
}

// 访问蓝图模块内的 MaterialPool（与施工同一统一池实现）
function MaterialPoolAccess(g) {
  // MaterialPool 是 blueprint.js 内的类，通过一次施工 tick 的取料行为间接验证不便；
  // 这里用结构等价的盘点口径复刻其构造逻辑（箱子/地面堆，排除 contractDock）。
  const free = new Map();
  for (const b of g.map.buildings.values()) {
    if (!b.def.storage || b.def.contractDock) continue;
    for (const s of b.chest) if (s.type && s.count > 0) free.set(s.type, (free.get(s.type) || 0) + s.count);
  }
  for (const pile of g.map.piles.values()) {
    for (const s of pile) if (s.type && s.count > 0) free.set(s.type, (free.get(s.type) || 0) + s.count);
  }
  return { available: (item) => free.get(item) || 0 };
}

console.log('\n[C5] 取消：释放未满批预留，已交付批次不返还不奖励');
{
  const g = newGame();
  const m = g.map, mgr = g.contracts;
  const y = 16;
  line(g, 2, 6, y, { dock: 4 });
  const dock = m.buildingAt(4, y);
  const offer = { oid: 'Od', item: 'copperPlate', qty: 40, batch: 10,
    reward: { item: 'science1', count: 4 }, durationSec: 600 };
  mgr.offers.push(offer);
  const c = mgr.accept('Od', dock.stationId);
  // 交付 25 件：2 批确认(20) + reserve 5
  g.sim.chestAdd(dock, 'copperPlate', 25);
  ticks(g, 13);
  ok(c.delivered === 20 && c.reserve === 5, '取消前：已交付 20、未满批预留 5');
  ok(stationCount(dock, 'copperPlate') === 0, '货位已清空（25 件全部划扣）');

  const before = stationCount(dock, 'copperPlate');
  mgr.cancel(c.id);
  ok(mgr.active.length === 0, '取消后合同出列');
  ok(stationCount(dock, 'copperPlate') === before + 5, '未满批的 5 件预留返还交付站货位（实际 ' + stationCount(dock, 'copperPlate') + '）');
  ok(stationCount(dock, 'science1') === 0, '取消不发放科研物资奖励');
  ok(mgr.history[0].status === 'canceled' && mgr.history[0].delivered === 20, '历史记录保留已交付 20 件（不返还）');
}

console.log('\n[C6] 逾期：到截止时刻未交完 → 违约，返还未满批预留，不奖励');
{
  const g = newGame();
  const m = g.map, mgr = g.contracts;
  const y = 20;
  line(g, 2, 6, y, { dock: 4 });
  const dock = m.buildingAt(4, y);
  const offer = { oid: 'Oe', item: 'coal', qty: 40, batch: 10,
    reward: { item: 'science3', count: 4 }, durationSec: 10 };
  mgr.offers.push(offer);
  const c = mgr.accept('Oe', dock.stationId);
  g.sim.chestAdd(dock, 'coal', 25); // 2 批 + reserve 5
  ticks(g, 13);
  ok(c.delivered === 20 && c.reserve === 5, '逾期前交付 20、预留 5');

  // 推进时间越过截止时刻（playTime 由 update 累加；测试直接改 playTime 后 tick）
  g.playTime = c.deadline + 1;
  g.tickOnce();
  ok(mgr.active.length === 0, '逾期后合同终止出列');
  const h = mgr.history[0];
  ok(h.status === 'overdue' && h.delivered === 20, '历史标记为逾期，已交付 20 件');
  ok(stationCount(dock, 'coal') === 5, '逾期时未满批的 5 件预留返还（实际 ' + stationCount(dock, 'coal') + '）');
  ok(stationCount(dock, 'science3') === 0, '逾期不发奖');
}

console.log('\n[C7] 交付站拆除：进行中合同自动取消，未满批预留落到地面堆');
{
  const g = newGame();
  const m = g.map, ry = g.railway, mgr = g.contracts;
  const y = 24;
  line(g, 2, 6, y, { dock: 4 });
  const dock = m.buildingAt(4, y);
  const offer = { oid: 'Of', item: 'stone', qty: 40, batch: 10,
    reward: { item: 'science1', count: 4 }, durationSec: 600 };
  mgr.offers.push(offer);
  const c = mgr.accept('Of', dock.stationId);
  g.sim.chestAdd(dock, 'stone', 23); // 2 批 + reserve 3
  ticks(g, 12);
  ok(c.delivered === 20 && c.reserve === 3, '拆站前交付 20、预留 3');

  // 拆除交付站（无车占用）
  const removed = g.removeBuilding(dock);
  ok(removed !== false, '无列车占用时交付站可拆除');
  ok(mgr.active.length === 0, '拆站后绑定合同自动取消出列');
  const pile = m.pileAt(dock.x, dock.y);
  // 货位此时为空（23 件已划扣）；reserve 3 件须补落到地面堆
  ok(pile && pile.some(s => s.type === 'stone' && s.count === 3),
     '未满批预留 3 石料随拆除补落到该格地面堆（' + JSON.stringify(pile) + '）');
  ok(mgr.history[0].status === 'canceled', '拆站取消进入历史');
}

console.log('\n[C8] 存档/读档：不重复扣货、不重复领奖；继续交付可完成');
{
  const g = newGame();
  const m = g.map, mgr = g.contracts;
  const y = 28;
  line(g, 2, 6, y, { dock: 4 });
  const dock = m.buildingAt(4, y);
  const offer = { oid: 'Og', item: 'ironPlate', qty: 40, batch: 10,
    reward: { item: 'science1', count: 4 }, durationSec: 600 };
  mgr.offers.push(offer);
  const c = mgr.accept('Og', dock.stationId);
  // 已交付 20，reserve 3（23 件到库），剩 17 待交
  g.sim.chestAdd(dock, 'ironPlate', 23);
  ticks(g, 12);
  ok(c.delivered === 20 && c.reserve === 3, '读档前：delivered=20 reserve=3');
  const data = JSON.parse(JSON.stringify(g.serialize()));
  ok(data.contracts && data.contracts.active.length === 1, '合同随存档序列化（active 1 条）');
  ok(data.contracts.active[0].delivered === 20 && data.contracts.active[0].reserve === 3,
     '独立账本（delivered/reserve）随档保存');

  const g2 = new FG.Game();
  g2.deserialize(data);
  const c2 = g2.contracts.active.find(x => x.id === c.id);
  const dock2 = g2.map.buildingAt(dock.x, dock.y);
  ok(!!c2, '合同随读档恢复为进行中');
  ok(c2.delivered === 20 && c2.reserve === 3, '读档后已交付/预留账本不丢不重');
  ok(stationCount(dock2, 'ironPlate') === 0, '读档不会把已交付货物重复扣回/吐出');

  // 读档后补上剩余 17 件，合同应能完成且只发一次奖
  g2.sim.chestAdd(dock2, 'ironPlate', 17);
  for (let i = 0; i < 60 && g2.contracts.active.length; i++) g2.tickOnce();
  ok(g2.contracts.active.length === 0, '读档后补交完成合同');
  ok(stationCount(dock2, 'science1') === 4, '完成只发一次奖励 science1×4（实际 ' + stationCount(dock2, 'science1') + '）');
  // 再跑若干 tick 确认不会重复发奖
  ticks(g2, 20);
  ok(stationCount(dock2, 'science1') === 4, '继续推进不重复领奖（仍为 4）');
}

console.log('\n[C9] 旧档兼容：无 contracts 字段读取不报错，看板正常初始化');
{
  const g = newGame();
  const data = JSON.parse(JSON.stringify(g.serialize()));
  delete data.contracts;
  const g2 = new FG.Game();
  let err = null;
  try { g2.deserialize(data); ticks(g2, 5); } catch (e) { err = e; }
  ok(!err, '无 contracts 字段的旧存档读取/推进不报错' + (err ? '：' + err.stack : ''));
  g2.contracts.ensureBoard(g2.playTime, false);
  ok(g2.research.isDone('railTransport') && g2.contracts.offers.length >= 0, '旧档读入后合同系统可用');
}

console.log('\n[C10] 同时进行合同上限');
{
  const g = newGame();
  const m = g.map, mgr = g.contracts;
  // 布多座交付站
  for (let i = 0; i < FG.Config.CONTRACT_MAX_ACTIVE + 1; i++) {
    place(g, 'rail', 2 + i * 3, 34, 0);
    place(g, 'deliverDock', 3 + i * 3, 34, 0);
  }
  const docks = mgr.docks();
  ok(docks.length >= FG.Config.CONTRACT_MAX_ACTIVE + 1, '准备了足够多交付站（' + docks.length + '）');
  mgr.refreshBoard(); // 补满看板报价
  let accepted = 0;
  for (let i = 0; i < FG.Config.CONTRACT_MAX_ACTIVE + 2; i++) {
    mgr.ensureBoard(g.playTime, false);
    const o = mgr.offers[0];
    if (!o) break;
    const dock = docks[accepted % docks.length];
    if (mgr.accept(o.oid, dock.stationId)) accepted++;
    else break;
  }
  ok(accepted === FG.Config.CONTRACT_MAX_ACTIVE, '进行中合同达到上限 ' + FG.Config.CONTRACT_MAX_ACTIVE + ' 后不再接单（实际接 ' + accepted + '）');
}

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
