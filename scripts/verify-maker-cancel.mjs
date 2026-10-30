import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

// Offline logic test. The only network requests download three hash-pinned official
// source files. All exchange data, order IDs, fills, cancellations and timers below
// are controlled fixtures; this script has no RPC, wallet, key or chain write.
const commit = '25798660bbe4674a6f83a960b202852896e2fed4';
const specs = {
  markets: ['packages/perp-core/src/markets.ts', '95dfbbb84d114927f5a5df87f4a0d96114d3904cb98a8c06c42c3823880a0520'],
  orders: ['packages/perp-core/src/orders.ts', 'a9ed57032c74315deafaea99a9ce349875b5bcd4b6eb0d09e2c5065c9402c583'],
  maker: ['strategies/perp-maker/src/index.ts', 'ed8ccfafe233796f9764ea6f946c8450fd732754f3abcc853f74dd46a9c62e32'],
};
const asModule = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const sdkUrl = import.meta.resolve('@somnia-chain/markets-sdk');
const viemUrl = import.meta.resolve('viem');
const out = { at: new Date().toISOString(), kitCommit: commit, sdk: '0.32.1',
  mode: 'offline controlled-source harness', transactions: 0, rpcCalls: 0, syntheticOrderState: true,
  sourceHashes: Object.fromEntries(Object.entries(specs).map(([key, value]) => [key, value[1]])), checks: [], cases: [] };
const check = (name, ok) => { assert.ok(ok, name); out.checks.push(name); console.log('VERIFIED', name); };
const deadline = setTimeout(() => process.exit(2), 60_000);
try {
  const source = {};
  for (const [key, [path, expected]] of Object.entries(specs)) {
    const response = await fetch(`https://raw.githubusercontent.com/somnia-chain/dreamdex-bot-kit/${commit}/${path}`, { signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(createHash('sha256').update(text).digest('hex'), expected, key);
    source[key] = stripTypeScriptTypes(text, { mode: 'strip' });
  }
  const marketsUrl = asModule(source.markets);
  const ordersUrl = asModule(source.orders
    .replaceAll('"@somnia-chain/markets-sdk"', JSON.stringify(sdkUrl))
    .replaceAll('"viem"', JSON.stringify(viemUrl))
    .replaceAll('"./markets.js"', JSON.stringify(marketsUrl))
    .replaceAll('"./exchange.js"', JSON.stringify(asModule('export function assertTxOk(r){if(r.receipt?.status!=="success")throw Error("Unexpected fixture result")}')))
    .replaceAll('"./operator.js"', JSON.stringify(asModule('export async function placeFor(){throw Error("Operator writes blocked")} export async function cancelFor(){throw Error("Operator writes blocked")}'))));

  const scenarios = [
    { name: 'healthy_requote', cycles: 2, failure: 'none' },
    { name: 'both_old_cancels_fail', cycles: 2, failure: 'first_pair' },
    { name: 'one_old_cancel_fails', cycles: 2, failure: 'first_id' },
    { name: 'shutdown_cancels_fail', cycles: 1, failure: 'all' },
    { name: 'already_filled_race', cycles: 2, failure: 'gone' },
  ];
  for (const scenario of scenarios) {
    const fixtureUrl = asModule(`
      import {RpcError, ContractRevertError, ORDER_TYPE} from ${JSON.stringify(sdkUrl)};
      export {ORDER_TYPE};
      export {sizeOrder, placePerp, cancelQuietly, positionIn} from ${JSON.stringify(ordersUrl)};
      export {sizeForNotional, requireMarket, liveMark} from ${JSON.stringify(marketsUrl)};
      const cfg = ${JSON.stringify(scenario)};
      export const state = {name:cfg.name, sleeps:0, next:1n, orders:new Map(), trace:[], shutdown:0};
      const pool='0x0000000000000000000000000000000000000001';
      const info={poolAddress:pool, marginBank:'0x0000000000000000000000000000000000000002',baseSymbol:'ETH',quoteSymbol:'USDso',baseDecimals:18,quoteDecimals:18,tickSize:'10000000000000000',lotSize:'100000000000000',minQuantity:'4000000000000000',markPrice:'100000000000000000000'};
      const symbol='ETH/USDso:USDso';
      const exchange={walletAddress:'0x0000000000000000000000000000000000000003',
        async loadMarkets(){return {[symbol]:{symbol,type:'swap',active:true,info}}},
        async fetchPositions(){return []},
        client:{async getPerpHealthSnapshot(){return {priceable:true,markPrice:BigInt(100+state.sleeps)*10n**18n}},
          async getMaxPerpOrderSize(){return {priceable:true,placeable:true,maxQuantity:10n**18n,limitedBy:'initialMargin',effectiveImfBps:500n}}},
        trader:{async placePerpOrder(p){const orderId=state.next++;state.orders.set(orderId,p);state.trace.push({op:'place',id:orderId,poll:state.sleeps,open:[...state.orders.keys()]});return {orderId,receipt:{status:'success'},fills:[]}},
          async cancelOrder({orderId}){state.trace.push({op:'cancel_attempt',id:orderId,poll:state.sleeps});
            if(cfg.failure==='gone' && orderId<=2n){state.orders.delete(orderId);state.trace.push({op:'already_gone',id:orderId});throw new ContractRevertError({errorName:'IncorrectOrder',args:[]})}
            if(cfg.failure==='all'||(cfg.failure==='first_pair'&&orderId<=2n)||(cfg.failure==='first_id'&&orderId===1n)){state.trace.push({op:'cancel_failed',id:orderId,error:'RpcError'});throw new RpcError('cancelOrder','controlled cancellation transport failure; fixture order remains live')}
            state.orders.delete(orderId);state.trace.push({op:'cancel_ok',id:orderId});return {receipt:{status:'success'}}}}};
      export function createExchange(){return {exchange,config:{dryRun:false,symbol:'ETH-PERP'}}}
      export function loadEnv(){}
      export function envNum(_key, value){return value}
      export function onStop(){return ()=>state.sleeps>=cfg.cycles}
      export async function sleep(){state.sleeps++}
      export async function shutdown(){state.shutdown++}
      export async function tradingKeyCheck(){return {ok:true}}
      export async function preflight(){return {ok:true,message:'controlled startup check'}}
      export async function ensureLeverage(){return {changed:false,from:2,to:2}}
    `);
    // Only detach the CLI entry invocation so the test can await main without
    // executing process.exit. The strategy's main/control flow is unchanged.
    const entryIndex = source.maker.lastIndexOf('\nmain().then(');
    assert.ok(entryIndex > 0);
    const makerUrl = asModule(source.maker.slice(0, entryIndex)
      .replaceAll('"@dreamdex-bot-kit/perp-core"', JSON.stringify(fixtureUrl)) + '\nexport {main};');
    const { state } = await import(fixtureUrl);
    const { main } = await import(makerUrl);
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try { await main(); } finally { console.log = originalLog; }
    out.cases.push({ scenario, openAtExit: [...state.orders.keys()], peakOpen: Math.max(...state.trace.filter(x=>x.op==='place').map(x=>x.open.length)),
      replacements: state.trace.filter(x=>x.op==='place'&&x.poll>0).length, trace: state.trace, logs, shutdownCalls: state.shutdown });
  }
  const [healthy, both, one, shutdown, gone] = out.cases;
  check('Healthy control cancels old quotes and all final quotes', healthy.openAtExit.length===0 && healthy.peakOpen===2);
  check('Healthy control still replaces both sides', healthy.replacements===2);
  check('Both failed old cancels leave both original IDs live at exit', both.openAtExit.join(',')==='1,2');
  check('Both failed old cancels are followed by two replacement placements', both.replacements===2 && both.peakOpen===4);
  check('Original IDs are never retried after being forgotten', [1n,2n].every(id=>both.trace.filter(x=>x.op==='cancel_attempt'&&x.id===id).length===1));
  check('Strategy claims quotes pulled despite two simulated live orders', both.logs.includes('quotes pulled, exiting'));
  check('Single failed old cancel leaves one orphan ID', one.openAtExit.join(',')==='1' && one.peakOpen===3);
  check('Single failure does not prevent replacement quotes', one.replacements===2);
  check('Shutdown-only failure leaves two simulated live orders', shutdown.openAtExit.length===2);
  check('Shutdown-only failure still claims successful cleanup', shutdown.logs.includes('quotes pulled, exiting') && shutdown.shutdownCalls===1);
  check('Already-filled race control leaves no orphan orders', gone.openAtExit.length===0 && gone.peakOpen===2);
  check('Already-filled race control still replaces and exits normally', gone.replacements===2 && gone.shutdownCalls===1);
} catch (error) {
  out.error = {name:error.name,message:error.message.slice(0,1400)}; process.exitCode=1;
} finally {
  clearTimeout(deadline);
  await writeFile('evidence/maker-cancel-round4.json', JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
  console.log('Saved',out.checks.length,'offline checks',out.error??'');
}
