/**
 * FG.Items —— 物品定义注册表
 * 物品分为 固体（传送带运输）与 流体（管道运输）
 * 扩展方式：直接向 DEFS 添加新条目
 */
FG.Items = (() => {
  const DEFS = {
    // ---------- 矿产 ----------
    ironOre:   { name: '铁矿石', color: '#9aa0a6', shape: 'square',  fluid: false, cat: 'raw' },
    copperOre: { name: '铜矿石', color: '#d98a4a', shape: 'circle',  fluid: false, cat: 'raw' },
    coal:      { name: '煤炭',   color: '#3a3d42', shape: 'square',  fluid: false, cat: 'raw' },
    stone:     { name: '石料',   color: '#a8a294', shape: 'circle',  fluid: false, cat: 'raw' },
    // ---------- 冶炼 ----------
    ironPlate:   { name: '铁板', color: '#c8ced6', shape: 'square',  fluid: false, cat: 'inter' },
    copperPlate: { name: '铜板', color: '#e8a35c', shape: 'square',  fluid: false, cat: 'inter' },
    steelPlate:  { name: '钢板', color: '#7c8496', shape: 'square',  fluid: false, cat: 'inter' },
    ironBeam:    { name: '铁梁', color: '#8e95a3', shape: 'beam',    fluid: false, cat: 'inter' },
    // ---------- 零件 ----------
    copperWire:   { name: '铜线',   color: '#e8a35c', shape: 'wire',    fluid: false, cat: 'part' },
    gear:         { name: '齿轮',   color: '#aab2bf', shape: 'gear',    fluid: false, cat: 'part' },
    circuit:      { name: '电路板', color: '#5fbf5f', shape: 'board',   fluid: false, cat: 'part' },
    advCircuit:   { name: '高级电路板', color: '#3ec9c0', shape: 'board', fluid: false, cat: 'part' },
    engine:       { name: '发动机', color: '#b0483f', shape: 'engine',  fluid: false, cat: 'part' },
    // ---------- 科学包 ----------
    science1: { name: '自动化科学包', color: '#d94f4f', shape: 'flask', fluid: false, cat: 'science' },
    science2: { name: '物流科学包',   color: '#5fbf5f', shape: 'flask', fluid: false, cat: 'science' },
    science3: { name: '化学科学包',   color: '#4f8fd9', shape: 'flask', fluid: false, cat: 'science' },
    // ---------- 成品 ----------
    miningDrill: { name: '采矿钻机', color: '#8a92a3', shape: 'drill',   fluid: false, cat: 'product' },
    solarPanel:  { name: '太阳能板', color: '#4da3ff', shape: 'panel',   fluid: false, cat: 'product' },
    rocketPart:  { name: '火箭部件', color: '#e8e8f0', shape: 'rocket',  fluid: false, cat: 'product' },
    rocketFuel:  { name: '火箭燃料', color: '#e8953d', shape: 'drop',    fluid: false, cat: 'product' },
    satellite:   { name: '卫星',     color: '#e8d23d', shape: 'sat',     fluid: false, cat: 'product' },
    // ---------- 流体 ----------
    water:        { name: '水',     color: '#4da3ff', shape: 'drop', fluid: true, cat: 'fluid' },
    crudeOil:     { name: '原油',   color: '#4a3a2e', shape: 'drop', fluid: true, cat: 'fluid' },
    petroleumGas: { name: '石油气', color: '#e8c84f', shape: 'drop', fluid: true, cat: 'fluid' },
    lubricant:    { name: '润滑油', color: '#9a6ad9', shape: 'drop', fluid: true, cat: 'fluid' },
  };

  const byId = (id) => DEFS[id];
  const isFluid = (id) => !!DEFS[id] && DEFS[id].fluid;
  const list = () => Object.values(DEFS);

  return { DEFS, byId, isFluid, list };
})();
