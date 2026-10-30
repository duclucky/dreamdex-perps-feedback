import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

// Actual pinned CLI/helpers and installed SDK stop encoding/decoding. Account,
// execution, receipts, book and time are fixtures. No key, .env, RPC or broadcast.
const commit = '4e75896896e024c03e2033d5920514f249998cd6';
const specs = {
  starter: ['strategies/perp-starter/src/index.ts', '3e0158ab088489fbd63ff4a0e1a38174d6c5be6a3fee1fd85c4ea19065f731b1'],
  stops: ['packages/perp-core/src/stops.ts', '25fad946e4510d135091f8dca24e19e4347814bc8b415b89141dea67be514a25'],
  markets: ['packages/perp-core/src/markets.ts', '95dfbbb84d114927f5a5df87f4a0d96114d3904cb98a8c06c42c3823880a0520'],
  margin: ['packages/perp-core/src/margin.ts', '041cfbb5a34bc80c6ddb2d71d81b592c979826a950d617aebdbb2533ea58d23a'],
  orders: ['packages/perp-core/src/orders.ts', 'a9ed57032c74315deafaea99a9ce349875b5bcd4b6eb0d09e2c5065c9402c583'],
};
const moduleOf = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const sdkUrl = import.meta.resolve('@somnia-chain/markets-sdk');
const viemUrl = import.meta.resolve('viem');
const sdkStopsUrl = new URL('../node_modules/@somnia-chain/markets-sdk/dist/perp/stops.js', import.meta.url).href;
const sdkAbiUrl = new URL('../node_modules/@somnia-chain/markets-sdk/dist/tradeAbi.js', import.meta.url).href;
const out = { at: new Date().toISOString(), kitCommit: commit, sdk: '0.32.1', rpcCalls: 0,
  transactions: 0, syntheticState: true, checks: [], cases: [], sourceHashes: {} };
const check = (label, condition) => { assert.ok(condition, label); out.checks.push(label); console.log('VERIFIED', label); };
const deadline = setTimeout(() => process.exit(2), 60000);
try {
  assert.equal(JSON.parse(await readFile('node_modules/@somnia-chain/markets-sdk/package.json', 'utf8')).version, '0.32.1');
  out.sdkSourceHashes = {};
  for (const path of ['dist/perp/stops.js', 'dist/tradeAbi.js']) {
    out.sdkSourceHashes[path] = createHash('sha256').update(await readFile('node_modules/@somnia-chain/markets-sdk/' + path)).digest('hex');
  }
  const sources = Object.fromEntries(await Promise.all(Object.entries(specs).map(async ([key, [path, expected]]) => {
    const response = await fetch(`https://raw.githubusercontent.com/somnia-chain/dreamdex-bot-kit/${commit}/${path}`, { signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200);
    const text = await response.text();
    const hash = createHash('sha256').update(text).digest('hex');
    assert.equal(hash, expected, key); out.sourceHashes[key] = hash;
    return [key, stripTypeScriptTypes(text, { mode: 'strip' })];
  })));
  const marketsUrl = moduleOf(sources.markets);
  const marginUrl = moduleOf(sources.margin);
  const ordersUrl = moduleOf(sources.orders
    .replaceAll('"@somnia-chain/markets-sdk"', JSON.stringify(sdkUrl))
    .replaceAll('"viem"', JSON.stringify(viemUrl))
    .replaceAll('"./markets.js"', JSON.stringify(marketsUrl))
    .replaceAll('"./exchange.js"', JSON.stringify(moduleOf('export function assertTxOk(r){if(r.receipt?.status!=="success")throw Error("Unexpected fixture receipt")}')))
    .replaceAll('"./operator.js"', JSON.stringify(moduleOf('export async function placeFor(){throw Error("Operator writes blocked")} export async function cancelFor(){throw Error("Operator writes blocked")}'))));
  const stopsUrl = moduleOf(sources.stops.replaceAll('"./markets.js"', JSON.stringify(marketsUrl)));
  const scenarios = [
    { name: 'owner_short_default', side: 'short', tp: 2, sl: 1 },
    { name: 'owner_long_default_control', side: 'long', tp: 2, sl: 1 },
    { name: 'owner_short_custom', side: 'short', tp: 4, sl: 0.5 },
    { name: 'owner_short_equal_control', side: 'short', tp: 1, sl: 1 },
    { name: 'watched_short_missed_stop', side: 'short', tp: 2, sl: 1, watched: true, pollMark: 101.5 },
    { name: 'watched_short_early_profit', side: 'short', tp: 2, sl: 1, watched: true, pollMark: 98.5 },
    { name: 'watched_long_stop_control', side: 'long', tp: 2, sl: 1, watched: true, pollMark: 98.5 },
    { name: 'watched_short_equal_control', side: 'short', tp: 1, sl: 1, watched: true, pollMark: 101.5 },
    { name: 'counterfactual_short_stop', side: 'short', tp: 2, sl: 1, watched: true, pollMark: 101.5, fix: true },
    { name: 'counterfactual_short_profit', side: 'short', tp: 2, sl: 1, watched: true, pollMark: 98.5, fix: true },
  ];
  for (const scenario of scenarios) {
    const fixtureUrl = moduleOf(`
      import {ORDER_TYPE} from ${JSON.stringify(sdkUrl)};
      import {encodeAbiParameters,encodeEventTopics,parseAbiParameters,encodeFunctionData,decodeFunctionData} from ${JSON.stringify(viemUrl)};
      import {placePerpStopOrder as sdkPlaceStop} from ${JSON.stringify(sdkStopsUrl)};
      import {perpStopRegistryEventsAbi,perpStopRegistryWriteAbi} from ${JSON.stringify(sdkAbiUrl)};
      export {ORDER_TYPE};
      export {requireMarket,liveMark,markOf,sizeForNotional} from ${JSON.stringify(marketsUrl)};
      export {preflight,ensureLeverage} from ${JSON.stringify(marginUrl)};
      export {sizeOrder,placePerp,positionIn,closePosition} from ${JSON.stringify(ordersUrl)};
      export {pendingStops,armBracket,cancelStops,somiPerStop} from ${JSON.stringify(stopsUrl)};
      const cfg=${JSON.stringify(scenario)};
      const owner='0x0000000000000000000000000000000000000003';
      const registry='0x0000000000000000000000000000000000000004';
      const symbol='ETH/USDso:USDso';
      const info={poolAddress:'0x0000000000000000000000000000000000000001',marginBank:'0x0000000000000000000000000000000000000002',stopRegistry:registry,baseSymbol:'ETH',quoteSymbol:'USDso',baseDecimals:18,quoteDecimals:18,tickSize:'10000000000000000',lotSize:'100000000000000',minQuantity:'4000000000000000',markPrice:'100000000000000000000'};
      const trace={position:0n,armed:[],sleeps:0,shutdownCalls:0,events:[]};
      const event=(op,extra={})=>trace.events.push({op,position:trace.position,...extra});
      const currentMark=()=>trace.sleeps&&cfg.pollMark?cfg.pollMark:100;
      const writer={fromAddress:owner,defaultGas:10000000n,addresses:()=>({operatorPermissionsRegistry:'0x0000000000000000000000000000000000000005'}),
        publicClient:{async readContract(p){if(p.functionName==='somiPaymentPerOrder')return 150000000000000000n;if(p.functionName==='isOperatorAuthorized')return true;throw Error('Unplanned SDK read '+p.functionName)}},
        async execute(call){
          if(call.functionName!=='createLinkedPendingOrders')throw Error('Unplanned SDK write '+call.functionName);
          // Encode and decode the real SDK call. No transport or signer exists.
          const data=encodeFunctionData(call);
          const decoded=decodeFunctionData({abi:perpStopRegistryWriteAbi,data});
          event('encoded_stop_pair',{method:decoded.functionName,legs:decoded.args,value:call.value});
          const logs=decoded.args.map((leg,i)=>({address:registry,
            topics:encodeEventTopics({abi:perpStopRegistryEventsAbi,eventName:'PendingOrderCreated',args:{orderId:101n+BigInt(i),owner}}),
            data:encodeAbiParameters(parseAbiParameters('bool,uint256,uint256,uint8,uint8,address,uint96'),[leg.order.isBid,leg.order.quantity,leg.triggerPrice,leg.triggerOperator,leg.orderType,leg.builder,leg.builderFeeBpsTimes1k])}));
          trace.armed=[101n,102n];
          return {hash:'0x'+'2'.repeat(64),receipt:{status:'success',logs}};
        }};
      const exchange={walletAddress:owner,
        async loadMarkets(){return {[symbol]:{symbol,type:'swap',active:true,info}}},
        async fetchPositions(){return trace.position?[{symbol,side:trace.position>0n?'long':'short',contracts:Number(trace.position>0n?trace.position:-trace.position)/1e18,unrealizedPnl:0}]:[]},
        async fetchOrderBook(){const mark=currentMark();return {bids:[[mark,10]],asks:[[mark,10]]}},
        client:{async getMarginAccount(){return {unlockedCollateralBalance:100n*10n**18n,lockedCollateral:0n,equity:100n*10n**18n,withdrawable:100n*10n**18n,imReq:0n,mmReq:0n,cmReq:0n,marginStatus:'Healthy',activePerpPools:[]}},
          async getPerpMaxLeverage(){return 2},
          async getPerpHealthSnapshot(){return {priceable:true,markPrice:BigInt(Math.round(currentMark()*1e18))}},
          async getMaxPerpOrderSize(){return {priceable:true,placeable:true,maxQuantity:10n**18n,limitedBy:'initialMargin',effectiveImfBps:500n}},
          async getPerpStopOrderSomiPayment(){return 150000000000000000n},
          async listPerpStopOrders(){return trace.armed.map(orderIdRaw=>({orderIdRaw}))},
          async previewPerpClosePnl(){return {priceable:true,closedQuantity:trace.position<0n?-trace.position:trace.position}}},
        trader:{async placePerpOrder(p){const wasFlat=trace.position===0n;trace.position+=p.isBid?p.quantity:-p.quantity;event(wasFlat?'entry_filled_fixture':'close_filled_fixture',{isBid:p.isBid,quantity:p.quantity,price:p.price,mark:currentMark()});return {hash:'0x'+'1'.repeat(64),receipt:{status:'success'},fills:[{quantityFilled:p.quantity}]}},
          async placePerpStopOrder(p){return sdkPlaceStop(writer,p)},
          async cancelPerpStopOrders(){trace.armed=[];event('cancel_stops')}}};
      export function createExchange(){return {exchange,config:{dryRun:false,symbol:'ETH-PERP',owner:cfg.watched?owner:undefined,operatorRegistry:'0x0000000000000000000000000000000000000005'}}}
      export function loadEnv(){}
      export function envNum(key,value){return Number(process.env[key]??value)}
      export function onStop(){return ()=>trace.sleeps>=1}
      export async function sleep(){trace.sleeps++;event('management_poll',{mark:currentMark()});if(trace.sleeps>1)throw Error('Harness poll bound exceeded')}
      export async function shutdown(){trace.shutdownCalls++}
      export async function tradingKeyCheck(){return {ok:true}}
      process.on('exit',()=>console.log('__TRACE__'+JSON.stringify(trace,(_,v)=>typeof v==='bigint'?v.toString():v)));
    `);
    let strategy = sources.starter;
    if (scenario.fix) {
      // Diagnostic arithmetic-only counterfactual. No upstream files are patched.
      assert.ok(strategy.includes('mark * (1 + TAKE_PROFIT_PCT / 100)'));
      assert.ok(strategy.includes('mark * (1 - STOP_LOSS_PCT / 100)'));
      strategy = strategy
        .replace('mark * (1 + TAKE_PROFIT_PCT / 100)', 'mark * (1 + (SIDE === "long" ? TAKE_PROFIT_PCT : STOP_LOSS_PCT) / 100)')
        .replace('mark * (1 - STOP_LOSS_PCT / 100)', 'mark * (1 - (SIDE === "long" ? STOP_LOSS_PCT : TAKE_PROFIT_PCT) / 100)');
    }
    const strategyUrl = moduleOf(strategy.replaceAll('"@dreamdex-bot-kit/perp-core"', JSON.stringify(fixtureUrl)));
    const worker = spawnSync(process.execPath, ['--input-type=module'], {
      input: `await import(${JSON.stringify(strategyUrl)});`, encoding: 'utf8', windowsHide: true,
      timeout: 10000, maxBuffer: 300000,
      env: { SystemRoot: process.env.SystemRoot ?? '', DRY_RUN: 'false', PERP_SIDE: scenario.side,
        PERP_TAKE_PROFIT_PCT: String(scenario.tp), PERP_STOP_LOSS_PCT: String(scenario.sl), PERP_NOTIONAL_USDSO: '0.4' },
    });
    if (worker.error) throw worker.error;
    const marker = worker.stdout.split(/\r?\n/).find(line => line.startsWith('__TRACE__'));
    assert.ok(marker, 'Isolated worker trace exists');
    const trace = JSON.parse(marker.slice('__TRACE__'.length));
    const logs = worker.stdout.split(/\r?\n/).filter(line => line && !line.startsWith('__TRACE__'));
    out.cases.push({ scenario, exitCode: worker.status, trace, logs, stderr: worker.stderr.slice(0, 1200) });
  }
  const [short, long, custom, equal, missed, early, longWatch, equalWatch, fixedStop, fixedProfit] = out.cases;
  check('All ten actual CLI workers finish normally with one bounded management poll',
    out.cases.every(c => c.exitCode === 0 && c.trace.sleeps === 1 && c.trace.shutdownCalls === 1));
  const legs = c => c.trace.events.find(e => e.op === 'encoded_stop_pair').legs;
  const px = leg => Number(BigInt(leg.triggerPrice)) / 1e18;
  check('Default short encodes GTE stop-loss at 102 rather than configured 101', px(legs(short)[0]) === 102);
  check('Default short encodes LTE take-profit at 99 rather than configured 98', px(legs(short)[1]) === 99);
  check('Default short still advertises TP 2% and SL 1% in startup log', short.logs.some(s => s.includes('take-profit 2% stop-loss 1%')));
  check('Short pair remains buy-to-close, whole-position, with opposite trigger operators',
    legs(short).every(l => l.order.isBid && l.order.quantity === '0') && legs(short).map(l => l.triggerOperator).join(',') === '0,1');
  check('Custom short TP 4% / SL 0.5% encodes 99.5 / 104 instead of 96 / 100.5',
    px(legs(custom)[1]) === 99.5 && px(legs(custom)[0]) === 104);
  check('Long default control encodes correct TP 102 and SL 99', px(legs(long)[0]) === 102 && px(legs(long)[1]) === 99);
  check('Long control correctly uses sell-to-close on both legs', legs(long).every(l => l.order.isBid === false));
  check('Equal-percentage short control masks the swap at TP 99 / SL 101', px(legs(equal)[1]) === 99 && px(legs(equal)[0]) === 101);
  const closes = c => c.trace.events.filter(e => e.op === 'close_filled_fixture');
  check('Watched short at mark 101.5 remains open despite crossing configured 1% stop', closes(missed).length === 0 && missed.trace.position === '-4000000000000000');
  check('Watched short reports the widened stop-loss 102', missed.logs.some(s => s.includes('watching take-profit 99.00 and stop-loss 102.00')));
  check('Watched short closes for take-profit at 98.5 before the configured 2% target 98',
    closes(early).length === 1 && early.trace.position === '0' && early.logs.some(s => s.startsWith('placed take-profit')));
  check('Watched long control closes at 98.5 through the actual close/order helpers',
    closes(longWatch).length === 1 && longWatch.trace.position === '0' && longWatch.logs.some(s => s.startsWith('placed stop-loss')));
  check('Watched equal-percentage short control closes at 101.5', closes(equalWatch).length === 1 && equalWatch.trace.position === '0');
  check('Arithmetic-only counterfactual restores the short stop at 101 and requests close at 101.5',
    fixedStop.logs.some(s => s.includes('watching take-profit 98.00 and stop-loss 101.00')) && closes(fixedStop).length === 1 && fixedStop.trace.position === '0');
  check('Arithmetic-only counterfactual waits at 98.5 until the actual 2% profit target',
    closes(fixedProfit).length === 0 && fixedProfit.trace.position === '-4000000000000000');
  check('Watched-exit scenarios never construct a registry pair', out.cases.filter(c => c.scenario.watched).every(c => !c.trace.events.some(e => e.op === 'encoded_stop_pair')));
  check('Every case starts flat and opens exactly one synthetic position',
    out.cases.every(c => c.trace.events.filter(e => e.op === 'entry_filled_fixture').length === 1));
} catch (error) {
  out.error = { name: error.name, message: error.message.slice(0, 1800) };
  process.exitCode = 1;
  console.error(out.error);
} finally {
  clearTimeout(deadline);
  out.completedAt = new Date().toISOString();
  await writeFile('evidence/starter-short-thresholds-round9.json', JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log('Saved', out.checks.length, 'checks. Zero RPC or transactions.');
}
