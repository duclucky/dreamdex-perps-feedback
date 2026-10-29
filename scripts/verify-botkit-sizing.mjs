import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES, contractErrorsAbi, ORDER_TYPE } from '@somnia-chain/markets-sdk';
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains';
import { createPublicClient, http, parseAbi } from 'viem';
import { getMaxPerpOrderSize, previewPerpOrderMargin } from '../node_modules/@somnia-chain/markets-sdk/dist/perp/margin.js';

// This harness executes reviewed upstream helper bodies unchanged after removing
// types and redirecting imports. Every "write" seam is replaced by eth_call or a
// throw; it cannot sign or broadcast. A synthetic success wrapper only allows the
// helper's post-call logging. It is never presented as a receipt or mined fill.
const commit = '25798660bbe4674a6f83a960b202852896e2fed4';
const sourceHashes = {
  orders: 'a9ed57032c74315deafaea99a9ce349875b5bcd4b6eb0d09e2c5065c9402c583',
  markets: '95dfbbb84d114927f5a5df87f4a0d96114d3904cb98a8c06c42c3823880a0520',
};
const dataModule = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function upstream(name) {
  const url = `https://raw.githubusercontent.com/somnia-chain/dreamdex-bot-kit/${commit}/packages/perp-core/src/${name}.ts`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, 200);
  const source = await response.text();
  assert.equal(createHash('sha256').update(source).digest('hex'), sourceHashes[name]);
  return stripTypeScriptTypes(source, { mode: 'strip' });
}
const exchange = new SomniaMarkets({ chain: hidekiTestnet, indexerUrl: 'https://hideki-dev.smk.somnia.host/v1/graphql', addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES });
const rpc = createPublicClient({ chain: hidekiTestnet, transport: http('https://api.hideki2.infra.testnet.somnia.network') });
const account = '0x3390B5CE917F61640DBb68FD1D86F45E483648AC';
const block = BigInt(process.env.ROUND3_BLOCK ?? '36620783');
const pinned = { ...rpc, getBlockNumber: async () => block };
const out = { at: new Date().toISOString(), sdk: '0.32.1', kitCommit: commit, sourceHashes,
  chainId: 50383, block, account, transactions: 0, signer: false,
  sentFlagMeaning: 'An upstream helper sent=true flag means the controlled eth_call seam completed. No transaction was broadcast; synthetic fills are empty and are not execution evidence.',
  fixtures: ['assertTxOk success wrapper', 'all trader writes replaced with pinned eth_call', 'operator writes always throw'], checks: [], cases: [] };
const deadline = setTimeout(() => process.exit(2), 120_000);
const check = (label, ok) => { assert.ok(ok, label); out.checks.push(label); console.log('VERIFIED', label); };
const describeError = e => {
  let errorName;
  for (let cause = e; cause; cause = cause.cause) errorName ??= cause.data?.errorName;
  return { errorName, message: (e.shortMessage ?? e.message).slice(0, 1000) };
};
try {
  console.log('MODE: pinned eth_call only; upstream placed/sent logs below do not mean a transaction was sent.');
  const marketsCode = await upstream('markets');
  const marketsModule = dataModule(marketsCode);
  const { sizeForNotional } = await import(marketsModule);
  let ordersCode = await upstream('orders');
  ordersCode = ordersCode.replaceAll('"@somnia-chain/markets-sdk"', JSON.stringify(import.meta.resolve('@somnia-chain/markets-sdk')))
    .replaceAll('"viem"', JSON.stringify(import.meta.resolve('viem')))
    .replaceAll('"./markets.js"', JSON.stringify(marketsModule))
    .replaceAll('"./exchange.js"', JSON.stringify(dataModule('export function assertTxOk(r){if(r.receipt?.status!=="success")throw Error("Bad controlled call wrapper");}')))
    .replaceAll('"./operator.js"', JSON.stringify(dataModule('export async function placeFor(){throw Error("Operator writes blocked")} export async function cancelFor(){throw Error("Operator writes blocked")}')));
  const { sizeOrder, placePerp } = await import(dataModule(ordersCode));
  const rows = await exchange.client.listPerpMarkets();
  const row = rows.find(m => m.baseSymbol === 'ETH');
  assert.ok(row);
  const abi = [...parseAbi([
    'function getBookLevels(bool isBid, uint64 numLevels) view returns ((uint256 price, uint256 quantity)[])',
    'function placeOrder(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)',
  ]), ...contractErrorsAbi];
  // Use the known published schema for book parameters through the installed ABI.
  const { perpPoolReadAbi } = await import('../node_modules/@somnia-chain/markets-sdk/dist/readsAbi.js');
  const book = await rpc.readContract({ address: row.poolAddress, abi: perpPoolReadAbi, functionName: 'getOrderBookParameters', blockNumber: block });
  const market = { symbol: 'ETH/USDso:USDso', display: 'ETH-PERP', info: { ...row, tickSize: book.tickSize.toString(), lotSize: book.lotSize.toString(), minQuantity: book.minQuantity.toString() } };
  out.market = market;
  const args = { pool: row.poolAddress, marginBank: row.marginBank, account, autoPull: false };
  const traderSeam = async p => {
    const simulated = await rpc.simulateContract({ address: p.pool, abi, functionName: 'placeOrder', account,
      args: [p.isBid, 0n, p.price, p.quantity, 4_000_000_000_000_000_000n, p.orderType, 0, '0x0000000000000000000000000000000000000000', 0n], blockNumber: block, gas: 30_000_000n });
    assert.equal(simulated.result[0], true, 'The control eth_call must return placement success, not just avoid a revert');
    out.simulations ??= [];
    out.simulations.push({ isBid: p.isBid, price: p.price, quantity: p.quantity, orderType: p.orderType, result: simulated.result });
    return { receipt: { status: 'success' }, fills: [] };
  };
  for (const side of ['long', 'short']) {
    const isBid = side === 'long';
    const levels = await rpc.readContract({ address: row.poolAddress, abi, functionName: 'getBookLevels', args: [!isBid, 1n], blockNumber: block });
    assert.ok(levels[0]);
    const price = levels[0].price;
    const wanted = sizeForNotional(50, market.info, Number(price) / 1e18);
    const readSeam = { client: { getMaxPerpOrderSize: p => getMaxPerpOrderSize(p, pinned) }, trader: { placePerpOrder: traderSeam } };
    const sized = await sizeOrder(readSeam, { market, account, side, price, wanted });
    check(`${side}: real sizeOrder accepts an affordable base-price size`, sized.ok);
    const proposed = [];
    const ctx = { config: { dryRun: false }, exchange: { trader: { placePerpOrder: p => { proposed.push(p); return traderSeam(p); } } } };
    let baseResult, shiftedError;
    try { baseResult = await placePerp({ ctx, market, side, price, quantity: sized.quantity, orderType: ORDER_TYPE.MARKET, slippageBps: 0 }); }
    catch (e) { baseResult = { error: describeError(e) }; }
    try { await placePerp({ ctx, market, side, price, quantity: sized.quantity, orderType: ORDER_TYPE.MARKET }); }
    catch (e) { shiftedError = describeError(e); }
    const actualPrice = proposed.at(-1).price;
    const actualQuote = await previewPerpOrderMargin({ ...args, isBid, price: actualPrice, quantity: sized.quantity }, pinned);
    check(`${side}: default placePerp changes the price after sizing`, actualPrice !== price);
    check(`${side}: the shifted exact price fails initial margin at the same block`, !actualQuote.meetsInitialMargin && !actualQuote.sufficient);
    check(`${side}: the actual pool eth_call rejects the shifted helper call for margin`, shiftedError?.errorName === 'InsufficientMarginForOrder');
    const corrected = await sizeOrder(readSeam, { market, account, side, price: actualPrice, wanted });
    const correctedQuote = await previewPerpOrderMargin({ ...args, isBid, price: actualPrice, quantity: corrected.quantity }, pinned);
    check(`${side}: sizing at the final price lowers size and passes the margin quote`, corrected.ok && corrected.quantity < sized.quantity && correctedQuote.sufficient);
    let correctedResult;
    try { correctedResult = await placePerp({ ctx, market, side, price: actualPrice, quantity: corrected.quantity, orderType: ORDER_TYPE.MARKET, slippageBps: 0 }); }
    catch (e) { correctedResult = { error: describeError(e) }; }
    check(`${side}: the no-slippage original-price eth_call is accepted`, !baseResult.error && !baseResult.noFill);
    check(`${side}: the corrected final-price quantity eth_call is accepted`, !correctedResult.error && !correctedResult.noFill);
    out.cases.push({ side, touch: price, sized, baseResult, actualPrice, shiftedError, actualQuote, corrected, correctedQuote, correctedResult });
  }
} catch (error) {
  out.error = { name: error.name, message: error.message.slice(0, 1500) }; process.exitCode = 1;
} finally {
  clearTimeout(deadline); await exchange.close();
  await writeFile('evidence/botkit-sizing-round3.json', JSON.stringify(out, (_,v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
  console.log('Saved', out.checks.length, 'checks', out.error ?? '');
}
