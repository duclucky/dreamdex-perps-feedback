import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES } from '@somnia-chain/markets-sdk';
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains';

// Read-only probe of the published SDK. No account, signer or transaction method.
const exchange = new SomniaMarkets({
  chain: hidekiTestnet,
  indexerUrl: 'https://hideki-dev.smk.somnia.host/v1/graphql',
  addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
});
const out = { startedAt: new Date().toISOString(), sdk: '0.32.1', chainId: 50383,
  transactions: 0, account: null, checks: [], observations: {} };
const output = process.env.ROUND2_OUTPUT ?? 'evidence/history-round2.json';
const check = (name, condition) => {
  assert.ok(condition, name);
  out.checks.push(name);
  console.log('VERIFIED', name);
};
const bounded = setTimeout(() => {
  console.error('Read-only history probe exceeded 90 seconds');
  process.exit(2);
}, 90_000);
try {
  const source = await readFile('node_modules/@somnia-chain/markets-sdk/src/unified/exchange.ts');
  out.sourceSha256 = createHash('sha256').update(source).digest('hex');
  const markets = await exchange.loadMarkets();
  const requestedBase = process.env.ROUND2_BASE ?? 'ETH';
  const eth = Object.values(markets).find(m => m.type === 'swap' && m.base === requestedBase);
  assert.ok(eth, `${requestedBase} perp discovered`);
  const symbol = eth.symbol;
  const native = exchange.market(symbol).market;
  const pool = native.poolAddress;
  out.observations.market = { symbol, pool, quoteDecimals: native.quoteDecimals, baseDecimals: native.baseDecimals };

  // Anchor to the latest completed funding row; the requested timestamp then stays
  // fixed across calls, even if a new settlement is mined during this probe.
  const latest = await exchange.fetchFundingRateHistory(symbol, undefined, 2);
  assert.equal(latest.length, 2);
  const since = latest[0].timestamp;
  const first = await exchange.fetchFundingRateHistory(symbol, since, 1);
  const nextSince = first[0].timestamp + 1;
  const second = await exchange.fetchFundingRateHistory(symbol, nextSince, 1);
  const third = await exchange.fetchFundingRateHistory(symbol, second[0].timestamp + 1, 1);
  const wholeSecond = await exchange.fetchFundingRateHistory(symbol, first[0].timestamp + 1000, 1);
  out.observations.funding = { since, first, nextSince, second, third, wholeSecond };
  check('Funding cursor +1ms returns a row older than the inclusive since bound', second[0].timestamp < nextSince);
  check('Funding cursor +1ms repeats the exact indexed event', first[0].info.id === second[0].info.id);
  check('Documented pagination is still stuck on a third call', second[0].info.id === third[0].info.id);
  check('Control: advancing by a whole second returns the next event', wholeSecond[0].timestamp > first[0].timestamp);
  const tailSince = latest.at(-1).timestamp + 1;
  const pastTail = await exchange.fetchFundingRateHistory(symbol, tailSince, 100);
  out.observations.funding.tailSince = tailSince;
  out.observations.funding.pastTail = pastTail;
  check('Funding tail cursor still includes an event before since at limit 100', pastTail.some(row => row.timestamp < tailSince));

  // Public exact-range reader supplies the historical control without changing SDK
  // methods or generating candles/trades. The unified result should include that
  // existing old bucket when the caller explicitly asks from its timestamp.
  const recent = await exchange.fetchOHLCV(symbol, '1m', undefined, 2);
  assert.equal(recent.length, 2);
  const endOfOldWindow = Math.floor(recent[0][0] / 1000) - 3600;
  const older = await exchange.client.getCandles(pool, 60, { to: endOfOldWindow, limit: 2, market: native.id });
  assert.equal(older.length, 2);
  const oldSince = Number(older[0].bucketStart) * 1000;
  const fromOld = await exchange.fetchOHLCV(symbol, '1m', oldSince, 2);
  const nativeRange = await exchange.client.getCandles(pool, 60, {
    from: oldSince / 1000, to: Number(older[1].bucketStart), limit: 2, market: native.id,
  });
  out.observations.candles = { recent, older, oldSince, fromOld, nativeRange };
  check('Control: exact historical range returns the requested two real candles', nativeRange.length === 2 && Number(nativeRange[0].bucketStart) * 1000 === oldSince);
  check('Unified since returns only newest candles, skipping existing requested history', fromOld.length === 2 && fromOld[0][0] > Number(older[1].bucketStart) * 1000);
  const futureSince = Date.now() + 86_400_000;
  const futureCandles = await exchange.fetchOHLCV(symbol, '1m', futureSince, 2);
  out.observations.candles.futureSince = futureSince;
  out.observations.candles.futureCandles = futureCandles;
  check('Control: unified OHLCV does apply its lower-bound filter for a future since', futureCandles.length === 0);
} catch (error) {
  out.error = { name: error.name, message: error.message.slice(0, 1400) };
  process.exitCode = 1;
} finally {
  clearTimeout(bounded);
  await exchange.close();
  out.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(out, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
  console.log('Saved', output, out.checks.length, 'checks');
  if (out.error) console.error(out.error);
}
