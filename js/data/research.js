/**
 * FG.Research —— 科技树定义
 * 节点结构：{ id, name, desc, cost:{scienceX:n}, prereq:[], unlocksB:[], unlocksR:[], col, row }
 * 渲染位置由 col/row 决定（列*间距, 行*间距）
 */
FG.Research = (() => {
  const DEFS = {
    automationScience: {
      id: 'automationScience', name: '自动化科学 I', col: 0, row: 0,
      desc: '研究体系的起点：消耗自动化科学包，解锁采矿钻机配方。',
      cost: { science1: 30 }, prereq: [],
      unlocksB: [], unlocksR: ['craft:miningDrill'],
    },
    steelSmelting: {
      id: 'steelSmelting', name: '钢冶炼', col: 1, row: 0,
      desc: '解锁钢板配方、铁梁与钢炉。',
      cost: { science1: 40 }, prereq: ['automationScience'],
      unlocksB: ['steelFurnace'], unlocksR: ['smelt:steel', 'craft:ironBeam'],
    },
    electronics: {
      id: 'electronics', name: '电子学', col: 1, row: 1,
      desc: '解锁电路板配方。',
      cost: { science1: 40 }, prereq: ['automationScience'],
      unlocksB: [], unlocksR: ['craft:circuit'],
    },
    logistics2: {
      id: 'logistics2', name: '物流学 II', col: 2, row: 0,
      desc: '解锁快速传送带、快速/长臂机械臂。',
      cost: { science1: 20, science2: 15 }, prereq: ['automationScience'],
      unlocksB: ['fastBelt', 'fastInserter', 'longInserter'], unlocksR: [],
    },
    logistics3: {
      id: 'logistics3', name: '物流学 III', col: 3, row: 0,
      desc: '解锁极速传送带。',
      cost: { science1: 30, science2: 40 }, prereq: ['logistics2'],
      unlocksB: ['expressBelt'], unlocksR: [],
    },
    railTransport: {
      id: 'railTransport', name: '铁路货运', col: 4, row: 3,
      desc: '铺设轨道、建设火车站与机务段，编组列车按运输计划跨区长距离运输散装物料。',
      cost: { science1: 20, science2: 30 }, prereq: ['logistics2'],
      unlocksB: ['rail', 'station', 'trainDepot'], unlocksR: [],
    },
    advancedElectronics: {
      id: 'advancedElectronics', name: '高级电子学', col: 2, row: 1,
      desc: '解锁高级电路板、二级组装机与太阳能板。',
      cost: { science1: 30, science2: 40 }, prereq: ['electronics', 'steelSmelting'],
      unlocksB: ['assembler2'], unlocksR: ['craft:advCircuit', 'craft:solarPanel'],
    },
    oilProcessing: {
      id: 'oilProcessing', name: '石油加工', col: 2, row: 2,
      desc: '解锁抽油机与炼油厂，将原油转化为石油气与润滑油。',
      cost: { science1: 30, science2: 50 }, prereq: ['electronics'],
      unlocksB: ['pumpjack', 'refinery'], unlocksR: ['refine:crude'],
    },
    logisticsScience: {
      id: 'logisticsScience', name: '物流科学包', col: 3, row: 1,
      desc: '解锁物流科学包配方与发动机。',
      cost: { science1: 20, science2: 40 }, prereq: ['advancedElectronics'],
      unlocksB: [], unlocksR: ['craft:science2', 'craft:engine'],
    },
    chemicalScience: {
      id: 'chemicalScience', name: '化学科学包', col: 4, row: 2,
      desc: '解锁化工厂与化学科学包配方。',
      cost: { science2: 40, science3: 30 }, prereq: ['oilProcessing', 'advancedElectronics'],
      unlocksB: ['chemPlant'], unlocksR: ['craft:science3'],
    },
    rocketTech: {
      id: 'rocketTech', name: '火箭科技', col: 5, row: 1,
      desc: '解锁火箭部件与火箭燃料配方。',
      cost: { science2: 40, science3: 60 }, prereq: ['chemicalScience', 'logisticsScience'],
      unlocksB: [], unlocksR: ['craft:rocketPart', 'craft:rocketFuel'],
    },
    satellite: {
      id: 'satellite', name: '卫星发射', col: 6, row: 1,
      desc: '解锁卫星配方 —— 达成最终胜利目标。',
      cost: { science3: 100 }, prereq: ['rocketTech'],
      unlocksB: [], unlocksR: ['craft:satellite'],
    },
  };

  const byId = (id) => DEFS[id];
  const list = () => Object.values(DEFS);

  // 依赖关系辅助
  const prereqOf = (id) => DEFS[id].prereq;
  const isPrereqDone = (id, doneSet) => DEFS[id].prereq.every(p => doneSet.has(p));

  return { DEFS, byId, list, prereqOf, isPrereqDone };
})();
