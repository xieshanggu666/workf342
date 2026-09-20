/**
 * FG.Recipes —— 配方定义
 * 结构：{ id, building, time(ticks), ingredients:[{item,count}], results:[{item,count}], unlockedBy }
 * 资源链条：矿石 → 冶炼 → 零件 → 科学包 → 成品
 */
FG.Recipes = (() => {
  const DEFS = {
    // ============ 冶炼（熔炉） ============
    'smelt:iron':   { id: 'smelt:iron',   name: '冶炼铁板', building: 'furnace', time: 20, ingredients: [{ item: 'ironOre', count: 1 }], results: [{ item: 'ironPlate', count: 1 }] },
    'smelt:copper': { id: 'smelt:copper', name: '冶炼铜板', building: 'furnace', time: 20, ingredients: [{ item: 'copperOre', count: 1 }], results: [{ item: 'copperPlate', count: 1 }] },
    'smelt:steel':  { id: 'smelt:steel',  name: '冶炼钢板', building: 'furnace', time: 32, ingredients: [{ item: 'ironPlate', count: 1 }, { item: 'coal', count: 1 }], results: [{ item: 'steelPlate', count: 1 }], unlockedBy: 'steelSmelting' },

    // ============ 组装（组装机） ============
    'craft:copperWire': { id: 'craft:copperWire', name: '铜线',   building: 'assembler', time: 10, ingredients: [{ item: 'copperPlate', count: 1 }], results: [{ item: 'copperWire', count: 2 }] },
    'craft:gear':       { id: 'craft:gear',       name: '齿轮',   building: 'assembler', time: 15, ingredients: [{ item: 'ironPlate', count: 1 }], results: [{ item: 'gear', count: 1 }] },
    'craft:circuit':    { id: 'craft:circuit',    name: '电路板', building: 'assembler', time: 25, ingredients: [{ item: 'copperWire', count: 3 }, { item: 'ironPlate', count: 1 }], results: [{ item: 'circuit', count: 1 }], unlockedBy: 'electronics' },
    'craft:advCircuit': { id: 'craft:advCircuit', name: '高级电路板', building: 'assembler', time: 32, ingredients: [{ item: 'circuit', count: 1 }, { item: 'copperWire', count: 4 }], results: [{ item: 'advCircuit', count: 1 }], unlockedBy: 'advancedElectronics' },
    'craft:ironBeam':   { id: 'craft:ironBeam',   name: '铁梁',   building: 'assembler', time: 20, ingredients: [{ item: 'ironPlate', count: 2 }], results: [{ item: 'ironBeam', count: 1 }], unlockedBy: 'steelSmelting' },
    'craft:engine':     { id: 'craft:engine',     name: '发动机', building: 'assembler', time: 45, ingredients: [{ item: 'gear', count: 1 }, { item: 'ironPlate', count: 2 }, { item: 'steelPlate', count: 1 }], results: [{ item: 'engine', count: 1 }], unlockedBy: 'logisticsScience' },

    // ============ 科学包 ============
    'craft:science1': { id: 'craft:science1', name: '自动化科学包', building: 'assembler', time: 30, ingredients: [{ item: 'gear', count: 1 }, { item: 'ironPlate', count: 1 }, { item: 'copperPlate', count: 1 }], results: [{ item: 'science1', count: 1 }] },
    'craft:science2': { id: 'craft:science2', name: '物流科学包',   building: 'assembler', time: 45, ingredients: [{ item: 'engine', count: 1 }, { item: 'circuit', count: 1 }], results: [{ item: 'science2', count: 1 }], unlockedBy: 'logisticsScience' },
    'craft:science3': { id: 'craft:science3', name: '化学科学包',   building: 'assembler', time: 50, ingredients: [{ item: 'advCircuit', count: 2 }, { item: 'ironBeam', count: 1 }, { item: 'coal', count: 1 }], results: [{ item: 'science3', count: 1 }], unlockedBy: 'advancedElectronics' },

    // ============ 成品 ============
    'craft:miningDrill': { id: 'craft:miningDrill', name: '采矿钻机', building: 'assembler', time: 55, ingredients: [{ item: 'gear', count: 2 }, { item: 'ironPlate', count: 3 }, { item: 'circuit', count: 1 }], results: [{ item: 'miningDrill', count: 1 }], unlockedBy: 'automationScience' },
    'craft:solarPanel':  { id: 'craft:solarPanel',  name: '太阳能板', building: 'assembler', time: 65, ingredients: [{ item: 'circuit', count: 2 }, { item: 'steelPlate', count: 2 }], results: [{ item: 'solarPanel', count: 1 }], unlockedBy: 'advancedElectronics' },
    'craft:rocketPart':  { id: 'craft:rocketPart',  name: '火箭部件', building: 'assembler', time: 90, ingredients: [{ item: 'steelPlate', count: 5 }, { item: 'advCircuit', count: 3 }, { item: 'engine', count: 1 }], results: [{ item: 'rocketPart', count: 1 }], unlockedBy: 'rocketTech' },
    'craft:rocketFuel':  { id: 'craft:rocketFuel',  name: '火箭燃料', building: 'chemPlant',  time: 40, ingredients: [{ item: 'petroleumGas', count: 10 }, { item: 'lubricant', count: 5 }], results: [{ item: 'rocketFuel', count: 1 }], unlockedBy: 'rocketTech' },
    'craft:satellite':   { id: 'craft:satellite',   name: '卫星',     building: 'assembler', time: 130, ingredients: [{ item: 'rocketPart', count: 1 }, { item: 'solarPanel', count: 2 }, { item: 'advCircuit', count: 5 }], results: [{ item: 'satellite', count: 1 }], unlockedBy: 'satellite' },

    // ============ 流体 ============
    'refine:crude': { id: 'refine:crude', name: '原油裂解', building: 'refinery', time: 30, ingredients: [{ item: 'crudeOil', count: 10 }, { item: 'water', count: 10 }], results: [{ item: 'petroleumGas', count: 6 }, { item: 'lubricant', count: 2 }], unlockedBy: 'oilProcessing' },
  };

  const byId = (id) => DEFS[id];
  const list = () => Object.values(DEFS);
  // 某建筑可用配方（含未解锁，由 UI 判断锁定）
  const forBuilding = (btype) => {
    const def = FG.Buildings.byId(btype);
    const group = (def && def.recipeGroup) || btype;
    return Object.values(DEFS).filter(r => r.building === group);
  };

  // 配方结果/原料中是否含流体
  const hasFluid = (r) =>
    (r.ingredients.some(i => FG.Items.isFluid(i.item)) || r.results.some(o => FG.Items.isFluid(o.item)));

  return { DEFS, byId, list, forBuilding, hasFluid };
})();
