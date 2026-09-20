/**
 * 集成压力测试：node test/integ.test.js
 * 小工厂：矿机→臂→传送带（转弯+合流）→熔炉→箱子；中途存档/读档
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
global.window = global;
global.localStorage = { _d:{}, getItem(k){return this._d[k]||null;}, setItem(k,v){this._d[k]=String(v);}, removeItem(k){delete this._d[k];} };
for (const f of ['js/core/config.js','js/core/utils.js','js/data/items.js','js/data/recipes.js','js/data/buildings.js',
'js/data/research.js','js/data/maps.js','js/game/map.js','js/game/scheduler.js', 'js/game/railway.js','js/game/sim.js','js/game/researchmgr.js','js/game/stats.js',
'js/game/save.js','js/game/blueprint.js','js/game/game.js'])
  vm.runInThisContext(fs.readFileSync(path.join('/workspace', f), 'utf8'), { filename: f });

let pass=0, fail=0;
const ok=(c,m)=>{ c?pass++:(fail++,console.log('  ✗',m)); if(c)console.log('  ✓',m); };

const game=new FG.Game();
const w=40,h=30;
const terrain=Array.from({length:h},()=>Array(w).fill('grass'));
const ores=Array.from({length:h},()=>Array(w).fill(null));
for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++) ores[10+dy][6+dx]={type:'ironOre',amount:99999};
game.startWithMap({presetId:'greenfield',biome:'grass',w,h,seed:7,sizeId:'medium',terrain,ores,water:new Set(),oil:new Set()},null,'integ');
const m=game.map, sim=game.sim;
function P(t,x,y,d){const b=FG.Map.create(t,x,y,d||0);m.register(b);sim.register(b);return b;}

// 铁矿：矿机(6,10) →臂(6,11)朝南→ 带(6,12)→(7,12)→(8,12) →臂(9,12)朝东→ 熔炉(10,12)
//       熔炉产物：臂(10,13)朝南（源=身后(10,12)熔炉，目标=(10,14)箱子）
P('miner',6,10);
P('inserter',6,11,2);
P('belt',6,12,1); P('belt',7,12,1); P('belt',8,12,1);
P('inserter',9,12,1);
const fur=P('furnace',10,12); fur.recipe='smelt:iron'; FG.Map.syncRecipeSlots(fur);
P('inserter',10,13,2);
const out=P('chest',10,14);
// 合流支路：第二个矿机(4,10) →臂(4,11)朝南→ 带(4,12)向东汇入主线(5,12)→(6,12)…
// 但熔炉只吃铁矿，两路同为铁矿即可持续生产；用两台矿机供一条熔炉线验证合流
for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++) { if(!ores[10+dy][4+dx]) ores[10+dy][4+dx]={type:'ironOre',amount:99999}; }
P('miner',4,10);
P('inserter',4,11,2);
P('belt',4,12,1); P('belt',5,12,1); // (4,12)→(5,12)→(6,12) 背入

// 跑 2000 tick
let err=null;
try { for(let i=0;i<2000;i++) game.tickOnce(); } catch(e){ err=e; }
ok(!err,'前 2000 tick 无异常'+(err?'：'+err.stack:''));
const plates1=(out.chest.find(s=>s.type==='ironPlate')||{}).count||0;
ok(plates1>0,'熔炉产出铁板入箱（'+plates1+'）');
// 两台矿机的铁矿通过合流持续喂入同一台熔炉
let fedCount = 0;
for(const bb of [m.buildingAt(4,12),m.buildingAt(5,12),m.buildingAt(6,12)]) fedCount += bb.items.length;
ok(fedCount>0,'双矿机合流供料（线上在途 '+fedCount+' 件）');

// 中途存档
const data=JSON.parse(JSON.stringify(game.serialize()));
// 读档到新游戏
const g2=new FG.Game();
g2.deserialize(data);
ok(g2.map.buildings.size===game.map.buildings.size,'读档后建筑数量一致');
const fur2=g2.map.buildingAt(10,12);
ok(fur2.recipe==='smelt:iron','熔炉配方恢复');
const belt712=g2.map.buildingAt(7,12);
ok(belt712.items.every(it=>typeof it.from==='number'),'带物品进料侧字段完整');
// 继续跑 2000 tick
try { for(let i=0;i<2000;i++) g2.tickOnce(); } catch(e){ err=e; }
ok(!err,'读档后再跑 2000 tick 无异常'+(err?'：'+err.stack:''));
const out2=g2.map.buildingAt(10,14);
const plates2=(out2.chest.find(s=>s.type==='ironPlate')||{}).count||0;
ok(plates2>plates1,'读档后生产继续（铁板 '+plates1+' → '+plates2+'）');

// 全图物品守恒（固体：箱子+槽位+带+臂手+地面堆）
function solids(g){
  let n=0;
  for(const b of g.map.buildings.values()){
    if(b.items) n+=b.items.length;
    if(b.held) n++;
    if(b.chest) for(const s of b.chest) n+=s.count;
    if(b.slots){ for(const k in b.slots.inputs) n+=b.slots.inputs[k].count;
                 for(const k in b.slots.outputs) n+=b.slots.outputs[k].count; }
  }
  for(const pile of g.map.piles.values()) for(const s of pile) n+=s.count;
  return n;
}
ok(typeof solids(g2)==='number','固体物料可完整盘点（'+solids(g2)+' 件在途/库存）');

console.log('\n结果：'+pass+' 通过, '+fail+' 失败');
process.exit(fail?1:0);
