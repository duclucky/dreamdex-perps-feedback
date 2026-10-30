import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPublicClient, http } from 'viem';
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains';
import { marginBankReadAbi } from '../node_modules/@somnia-chain/markets-sdk/dist/readsAbi.js';
import { getPerpPositionAnalytics, listPerpPositionAnalytics } from '../node_modules/@somnia-chain/markets-sdk/dist/perp/margin.js';

// Read-only archive replay. The client has no account, signer or writer.
const blockNumber = 37225356n;
const marginBank = '0x478769e1177c0773c43a593dccc4ad15f15f1394';
const rpcUrl = 'https://api.hideki2.infra.testnet.somnia.network';
const rpc = createPublicClient({ chain: hidekiTestnet, transport: http(rpcUrl, { timeout: 15000, retryCount: 0 }) });
// Keep the actual SDK reader unchanged, but make its head sample the replay block.
const pinned = { ...rpc, getBlockNumber: async () => blockNumber };
const floor = (numerator, denominator) => numerator / denominator - (numerator < 0n && numerator % denominator !== 0n ? 1n : 0n);
const out = { at: new Date().toISOString(), sdk: '0.32.1', chainId: 50383, blockNumber,
  rpcUrl, marginBank, transactions: 0, assertions: [], sourceSha256: {}, singleMarketCases: [] };
const check = (name, condition) => {
  assert.ok(condition, name);
  out.assertions.push(name);
  console.log('VERIFIED', name);
};
const deadline = setTimeout(() => { console.error('Read-only archive replay exceeded 90 seconds'); process.exit(2); }, 90000);
try {
  const packageJson = JSON.parse(await readFile('node_modules/@somnia-chain/markets-sdk/package.json', 'utf8'));
  assert.equal(packageJson.version, '0.32.1');
  for (const file of ['src/perp/margin.ts', 'dist/perp/margin.js', 'dist/readsAbi.js']) {
    out.sourceSha256[file] = createHash('sha256').update(await readFile(`node_modules/@somnia-chain/markets-sdk/${file}`)).digest('hex');
  }
  const cases = [
    ['BNB fractional-loss short', '0xc8e6ba18fd99cf251c3fb97a2202968b4c186fc0', 1n],
    ['AVAX fractional-loss short', '0xdc73254d22f88dc8394e6390bd836798758e7ea7', 1n],
    ['SOL fractional-loss short', '0xa8ef09c2e86a16cea560a5f19ac01c54914223c2', 1n],
    ['NEAR fractional-loss short A', '0xe8c0d36d69a10bea8d00fe45a2fde45527eda984', 1n],
    ['NEAR fractional-loss short B', '0x603ba06b12e055ad1b13ba2745c08200b6f3c89d', 1n],
    ['ETH profitable short control', '0x6c2986a550dc4212b49a1710d8466553e3761ce4', 0n],
    ['NEAR profitable long control', '0xdd2b62102444cf8191a79de10c3e9ce03f51f82c', 0n],
    ['BTC exact-loss long control', '0x0b8a3f48e04cbf8cb868c165619b882cf1160ce2', 0n],
  ];
  for (const [label, account, expectedDifference] of cases) {
    const call = { address: marginBank, abi: marginBankReadAbi, args: [account], blockNumber };
    const [state, health, equity] = await Promise.all([
      rpc.readContract({ ...call, functionName: 'getAccountState' }),
      rpc.readContract({ ...call, functionName: 'getAccountHealth' }),
      rpc.readContract({ ...call, functionName: 'getAccountEquity' }),
    ]);
    assert.equal(state.activePerpPools.length, 1, `${label}: one active pool is required for isolation`);
    const pool = state.activePerpPools[0];
    const metrics = await getPerpPositionAnalytics({ marginBank, account, pool }, pinned);
    check(`${label}: one non-flat, priceable pool; zero funding; same-block contract equity agrees`,
      metrics.priceable && metrics.asOfBlock === blockNumber && metrics.size !== 0n
      && metrics.accruedFunding === 0n && health[0] === equity);
    // The deployed pools' base scale is obtained directly from their snapshot.
    const { perpPoolReadAbi } = await import('../node_modules/@somnia-chain/markets-sdk/dist/readsAbi.js');
    const snapshot = await rpc.readContract({ address: pool, abi: perpPoolReadAbi,
      functionName: 'tryGetHealthSnapshot', blockNumber });
    assert.equal(snapshot[0], true);
    const numerator = (metrics.markPrice - metrics.avgEntryPrice) * metrics.size;
    const denominator = snapshot[1].oneBase;
    const sdkEquity = state.unlockedCollateralBalance + metrics.equityContribution;
    const floorPnl = floor(numerator, denominator);
    const floorEquity = state.unlockedCollateralBalance + floorPnl - metrics.accruedFunding;
    const difference = sdkEquity - equity;
    const row = { label, account, pool, state, health, contractEquity: equity, snapshot, metrics,
      numerator, denominator, sdkEquity, floorPnl, floorEquity, difference };
    out.singleMarketCases.push(row);
    check(`${label}: observed SDK equity difference is ${expectedDifference} collateral wei`,
      difference === expectedDifference && metrics.unrealizedPnl === numerator / denominator
      && (expectedDifference !== 1n || (numerator < 0n && numerator % denominator !== 0n)));
    check(`${label}: floor-PnL counterfactual exactly reconciles equity, while all three SDK margin requirements already match`,
      floorEquity === equity && metrics.initialMarginRequirement === health[1]
      && metrics.maintenanceMarginRequirement === health[2] && metrics.closeOutMarginRequirement === health[3]);
  }

  const account = '0x47537e3a3ea6e9391f3b26ea45618db6828c8bff';
  const call = { address: marginBank, abi: marginBankReadAbi, args: [account], blockNumber };
  const [state, health, rows] = await Promise.all([
    rpc.readContract({ ...call, functionName: 'getAccountState' }),
    rpc.readContract({ ...call, functionName: 'getAccountHealth' }),
    listPerpPositionAnalytics({ marginBank, account }, pinned),
  ]);
  check('Multi-market: actual SDK reader returns all 21 active-pool rows at the fixed block',
    rows.length === 21 && state.activePerpPools.length === 21
    && rows.every(r => r.priceable && r.asOfBlock === blockNumber));
  const { perpPoolReadAbi } = await import('../node_modules/@somnia-chain/markets-sdk/dist/readsAbi.js');
  const corrected = [];
  // Sequential bounded reads avoid a large extra RPC burst.
  for (const row of rows) {
    const [ok, snapshot] = await rpc.readContract({ address: row.pool, abi: perpPoolReadAbi,
      functionName: 'tryGetHealthSnapshot', blockNumber });
    assert.ok(ok);
    const numerator = (row.markPrice - row.avgEntryPrice) * row.size;
    corrected.push({ pool: row.pool, size: row.size, unrealizedPnl: row.unrealizedPnl,
      floorPnl: floor(numerator, snapshot.oneBase), accruedFunding: row.accruedFunding });
  }
  const sum = field => rows.reduce((total, row) => total + row[field], 0n);
  const sdkEquity = state.unlockedCollateralBalance + sum('equityContribution');
  const floorEquity = state.unlockedCollateralBalance + corrected.reduce((total, row) => total + row.floorPnl - row.accruedFunding, 0n);
  const affected = corrected.filter(row => row.unrealizedPnl !== row.floorPnl);
  out.multiMarketCase = { account, state, health, rows, corrected, sdkEquity, floorEquity, affected };
  check('Multi-market: SDK analytics overstate contract equity by exactly two collateral wei', sdkEquity - health[0] === 2n);
  check('Multi-market: floor correction on the two fractional-loss rows restores exact contract equity',
    affected.length === 2 && affected.every(row => row.unrealizedPnl - row.floorPnl === 1n) && floorEquity === health[0]);
  check('Multi-market: SDK initial, maintenance and close-out requirements already reconcile exactly',
    sum('initialMarginRequirement') === health[1] && sum('maintenanceMarginRequirement') === health[2]
    && sum('closeOutMarginRequirement') === health[3]);
} catch (error) {
  out.error = { name: error.name, message: error.message.slice(0, 1500) };
  process.exitCode = 1;
  console.error(out.error);
} finally {
  clearTimeout(deadline);
  out.completedAt = new Date().toISOString();
  await writeFile('evidence/analytics-rounding-round7.json', JSON.stringify(out, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n', 'utf8');
  console.log(`Saved ${out.assertions.length} assertions. Zero transactions/signatures.`);
}
