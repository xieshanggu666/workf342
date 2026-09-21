/**
 * FG.Contracts —— 供货合同模板与看板生成
 *
 * 合同模型（运行态见 FG.ContractMgr）：
 *  - 玩家在看板接单后，用列车把指定货物分批运到一座「交付站」；
 *  - 合同货物与生产、施工统一争料，但独立记账（delivered 账本），完成后发放科研物资；
 *  - 支持逾期（deadline，仿真秒绝对时刻）与取消：未交付的预留（reserve）返还交付站货位，
 *    已交付批次不返还、不奖励；
 *  - 看板按当前已研究进度滚动生成可接合同，完成/逾期/取消后刷新补位。
 *
 * 仅固体货物可走铁路交付；奖励为科学包（科研物资），直接发到交付站货位供实验室取走。
 */
FG.Contracts = (() => {
  // 合同可要求的货物池：按解锁前置科技分组，研究越深可接越高级的合同
  // 每项：{ item, tier, min, max, weight }  tier 对应「研究完成科技节点数」门槛
  const POOL = [
    { item: 'ironOre',      tier: 0, weight: 10 },
    { item: 'copperOre',    tier: 0, weight: 10 },
    { item: 'coal',         tier: 0, weight: 8 },
    { item: 'stone',        tier: 0, weight: 8 },
    { item: 'ironPlate',    tier: 0, weight: 9 },
    { item: 'copperPlate',  tier: 1, weight: 8 },
    { item: 'gear',         tier: 1, weight: 7 },
    { item: 'ironBeam',     tier: 2, weight: 6 },
    { item: 'steelPlate',   tier: 2, weight: 6 },
    { item: 'copperWire',   tier: 1, weight: 6 },
    { item: 'circuit',      tier: 2, weight: 6 },
    { item: 'advCircuit',   tier: 4, weight: 5 },
    { item: 'engine',       tier: 4, weight: 4 },
    { item: 'science1',     tier: 2, weight: 3 },
    { item: 'science2',     tier: 4, weight: 3 },
    { item: 'science3',     tier: 6, weight: 2 },
    { item: 'rocketPart',   tier: 8, weight: 2 },
    { item: 'rocketFuel',   tier: 8, weight: 2 },
  ];

  // 奖励池：完成合同后发放的科研物资（科学包）。按需求货物 tier 决定奖励档位
  // reward: { item, per } 每交付 per 件合同货物发放 1 个该科学包（取整 + 保底）
  const REWARDS = [
    { minTier: 0, item: 'science1', per: 12 },
    { minTier: 2, item: 'science2', per: 10 },
    { minTier: 4, item: 'science3', per: 8 },
  ];

  /** 玩家当前研究进度档位：已完成科技节点数 */
  function researchTier(game) {
    return game.research.completed.size;
  }

  /** 某货物条目在当前研究进度下是否可出现 */
  function poolUnlocked(entry, tier) {
    return tier >= entry.tier;
  }

  function pickWeighted(list, rng) {
    let total = 0;
    for (const e of list) total += e.weight;
    let r = rng() * total;
    for (const e of list) { r -= e.weight; if (r <= 0) return e; }
    return list[list.length - 1];
  }

  /**
   * 生成一份合同模板（未接单）。
   * @param rng 可复现随机函数
   * @returns {id:'', item, qty, batch, reward:{item,count}, durationSec, fromTemplate}
   */
  function generate(game, rng) {
    rng = rng || Math.random;
    const tier = researchTier(game);
    const avail = POOL.filter(e => poolUnlocked(e, tier));
    const tpl = pickWeighted(avail.length ? avail : POOL.slice(0, 1), rng);

    // 需求量：随 tier 提升，限定为批次数的整数倍
    const batch = [10, 20, 20, 40, 40][Math.min(4, Math.floor(tier / 2))] || 40;
    const batches = 3 + Math.floor(rng() * 6) + Math.floor(tier / 3); // 3~8+ 批
    const qty = batch * batches;

    // 奖励：选需求货物 tier 能解锁的最高档科研物资
    let rewardDef = REWARDS[0];
    for (const rd of REWARDS) if (tpl.tier >= rd.minTier) rewardDef = rd;
    const rewardCount = Math.max(2, Math.round(qty / rewardDef.per));

    // 期限：每批约 30~45 秒 + 基础宽限
    const durationSec = 90 + batches * (30 + Math.floor(rng() * 16));

    return {
      item: tpl.item,
      qty,
      batch,
      reward: { item: rewardDef.item, count: rewardCount },
      durationSec,
    };
  }

  /** 生成整版看板（去重：同一货物至多 2 条） */
  function generateBoard(game, n, rng) {
    rng = rng || Math.random;
    const out = [];
    const seen = {};
    let guard = 0;
    while (out.length < n && guard++ < 100) {
      const t = generate(game, rng);
      seen[t.item] = (seen[t.item] || 0) + 1;
      if (seen[t.item] > 2) continue;
      out.push(t);
    }
    return out;
  }

  /** 奖励/需求物品是否合法（读档校验用） */
  function knownItem(id) { return !!FG.Items.byId(id); }

  return { POOL, REWARDS, generate, generateBoard, researchTier, knownItem };
})();
