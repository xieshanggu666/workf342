/**
 * FG.Maps —— 地图场景预设与程序化生成
 * 输出：{ w, h, terrain: 2D array, oreAmount: 2D array, water: Set('x,y'), oil: Set('x,y') }
 * 扩展方式：在 PRESETS 中新增场景，或新增生成参数
 */
FG.Maps = (() => {

  const PRESETS = [
    {
      id: 'greenfield', name: '新手平原', biome: 'grass',
      desc: '资源均衡的草原，适合熟悉链条：矿石→冶炼→零件→科学包。',
      ores: { ironOre: 5, copperOre: 4, coal: 4, stone: 2 }, oil: 3, lakes: 1,
    },
    {
      id: 'desert', name: '沙漠油田', biome: 'sand',
      desc: '石油资源富集，矿物相对贫瘠，考验流体网络布局。',
      ores: { ironOre: 3, copperOre: 3, coal: 3, stone: 1 }, oil: 6, lakes: 1,
    },
    {
      id: 'alpine', name: '高山矿区', biome: 'stone',
      desc: '矿物储量巨大，水资源稀缺，石油稀少。',
      ores: { ironOre: 7, copperOre: 6, coal: 5, stone: 4 }, oil: 1, lakes: 1,
    },
    {
      id: 'random', name: '随机世界', biome: 'random',
      desc: '全随机地形与资源分布，可用种子复现。',
      ores: null, oil: null, lakes: 2, random: true,
    },
  ];

  const patchDef = {
    ironOre:   { size: [3, 5], amount: [1200, 2600], color: '#b06a4a' },
    copperOre: { size: [3, 5], amount: [1200, 2600], color: '#c98a4a' },
    coal:      { size: [3, 5], amount: [900, 2000],  color: '#3a3d42' },
    stone:     { size: [2, 4], amount: [1500, 3000], color: '#9a9488' },
  };

  // 生成单个团块：随机游走从中心扩散
  function blob(rng, cx, cy, radius, pass) {
    const tiles = [];
    const seen = new Set();
    let x = cx, y = cy;
    for (let i = 0; i < radius * radius * 9; i++) {
      if (pass(x, y)) {
        const k = x + ',' + y;
        if (!seen.has(k)) { seen.add(k); tiles.push([x, y]); }
        x += Math.floor(rng() * 3) - 1;
        y += Math.floor(rng() * 3) - 1;
      } else {
        x = cx + Math.floor(rng() * radius) - Math.floor(rng() * radius);
        y = cy + Math.floor(rng() * radius) - Math.floor(rng() * radius);
      }
      if (tiles.length >= radius * radius * 2.4) break;
    }
    return tiles;
  }

  function generate(preset, seed, sizeId) {
    const size = FG.Config.MAP_SIZES[sizeId] || FG.Config.MAP_SIZES.medium;
    const w = size.w, h = size.h;
    const rng = FG.Utils.mulberry32(seed || 1337);

    const biome = preset.random ? ['grass', 'sand', 'stone'][Math.floor(rng() * 3)] : preset.biome;

    // 地形
    const terrain = [];
    for (let y = 0; y < h; y++) {
      const row = [];
      for (let x = 0; x < w; x++) row.push(biome);
      terrain.push(row);
    }

    // 水域（湖泊）
    const water = new Set();
    const lakeCount = preset.lakes || 0;
    for (let l = 0; l < lakeCount; l++) {
      const cx = Math.floor(rng() * w), cy = Math.floor(rng() * h);
      const r = 2 + Math.floor(rng() * 3);
      blob(rng, cx, cy, r, (x, y) => x >= 1 && y >= 1 && x < w - 1 && y < h - 1).forEach(([x, y]) => {
        terrain[y][x] = 'water';
        water.add(x + ',' + y);
      });
    }

    // 矿脉（每格记录 {type, amount}）
    const ores = [];
    for (let y = 0; y < h; y++) ores.push(new Array(w).fill(null));

    const orePlan = preset.random
      ? { ironOre: 4 + Math.floor(rng() * 3), copperOre: 3 + Math.floor(rng() * 2), coal: 3 + Math.floor(rng() * 2), stone: 2 }
      : preset.ores;

    for (const [ore, count] of Object.entries(orePlan)) {
      const def = patchDef[ore];
      for (let p = 0; p < count; p++) {
        const cx = 3 + Math.floor(rng() * (w - 6)), cy = 3 + Math.floor(rng() * (h - 6));
        const radius = def.size[0] + Math.floor(rng() * (def.size[1] - def.size[0] + 1));
        const amount = def.amount[0] + Math.floor(rng() * (def.amount[1] - def.amount[0] + 1));
        blob(rng, cx, cy, radius, (x, y) => x >= 0 && y >= 0 && x < w && y < h && terrain[y][x] !== 'water')
          .forEach(([x, y]) => { if (!ores[y][x]) ores[y][x] = { type: ore, amount }; });
      }
    }

    // 油田（地块放置抽油机的位置）
    const oil = new Set();
    const oilCount = preset.random ? 3 + Math.floor(rng() * 3) : (preset.oil || 0);
    for (let p = 0; p < oilCount; p++) {
      const cx = 3 + Math.floor(rng() * (w - 6)), cy = 3 + Math.floor(rng() * (h - 6));
      const r = 1 + Math.floor(rng() * 2);
      blob(rng, cx, cy, r, (x, y) => x >= 0 && y >= 0 && x < w && y < h && terrain[y][x] !== 'water')
        .forEach(([x, y]) => oil.add(x + ',' + y));
    }

    return { presetId: preset.id, biome, w, h, terrain, ores, water, oil, seed, sizeId };
  }

  const getPreset = (id) => PRESETS.find(p => p.id === id);

  return { PRESETS, generate, getPreset };
})();
