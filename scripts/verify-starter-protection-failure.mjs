import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

// Actual upstream CLI/helpers and SDK stop builder; synthetic account, receipts,
// transport failures and time. Only pinned source downloads use the network.
// No RPC, .env, private key, signer, real position or transaction is used.
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
  const pkg = JSON.parse(await readFile('node_modules/@somnia-chain/markets-sdk/package.json', 'utf8'));
  assert.equal(pkg.version, '0.32.1');
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
    .replaceAll('"./exchange.js"', JSON.stringify(moduleOf('export function assertTxOk(r){if(r.receipt?.status==="reverted")throw Error("Fixture receipt reverted")}')))
    .replaceAll('"./operator.js"', JSON.stringify(moduleOf('export async function placeFor(){throw Error("Operator writes blocked")} export async function cancelFor(){throw Error("Operator writes blocked")}'))));
  const stopsUrl = moduleOf(sources.stops.replaceAll('"./markets.js"', JSON.stringify(marketsUrl)));
  const scenarios = [
    { name: 'entry_then_insufficient_stop_deposit', native: '100000000000000000', error: 'none' },
    { name: 'entry_then_stop_rpc_failure', native: '500000000000000000', error: 'stop_rpc' },
    { name: 'funded_stop_control', native: '500000000000000000', error: 'none' },
    { name: 'dry_run_low_balance_control', native: '100000000000000000', error: 'none', dryRun: true },
    { name: 'entry_failure_control', native: '500000000000000000', error: 'entry' },
    { name: 'bounded_retry_counterfactual', native: '500000000000000000', error: 'stop_rpc', retry: true },
  ];
  for (const scenario of scenarios) {
    const fixtureUrl = moduleOf(`
      import {RpcError,ORDER_TYPE} from ${JSON.stringify(sdkUrl)};
      import {encodeAbiParameters,encodeEventTopics,parseAbiParameters} from ${JSON.stringify(viemUrl)};
      import {placePerpStopOrder as sdkPlaceStop} from ${JSON.stringify(sdkStopsUrl)};
      import {perpStopRegistryEventsAbi} from ${JSON.stringify(sdkAbiUrl)};
      export {ORDER_TYPE};
      export {requireMarket,liveMark,markOf,sizeForNotional} from ${JSON.stringify(marketsUrl)};
      export {preflight,ensureLeverage} from ${JSON.stringify(marginUrl)};
      export {sizeOrder,placePerp,positionIn} from ${JSON.stringify(ordersUrl)};
      export {pendingStops,armBracket,cancelStops,somiPerStop} from ${JSON.stringify(stopsUrl)};
      const cfg=${JSON.stringify(scenario)};
      const owner='0x0000000000000000000000000000000000000003';
      const registry='0x0000000000000000000000000000000000000004';
      const zero='0x0000000000000000000000000000000000000000';
      const symbol='ETH/USDso:USDso';
      const info={poolAddress:'0x0000000000000000000000000000000000000001',marginBank:'0x0000000000000000000000000000000000000002',stopRegistry:registry,baseSymbol:'ETH',quoteSymbol:'USDso',baseDecimals:18,quoteDecimals:18,tickSize:'10000000000000000',lotSize:'100000000000000',minQuantity:'4000000000000000',markPrice:'2000000000000000000000'};
      const trace={position:0n,armed:[],entryCalls:0,stopAttempts:0,positionReads:0,sleeps:0,closeCalls:0,shutdownCalls:0,events:[]};
      const event=(op,extra={})=>trace.events.push({op,position:trace.position,armed:[...trace.armed],...extra});
      const writer={fromAddress:owner,defaultGas:10000000n,addresses:()=>({operatorPermissionsRegistry:'0x0000000000000000000000000000000000000005'}),
        publicClient:{async readContract(p){if(p.functionName==='somiPaymentPerOrder')return 150000000000000000n;if(p.functionName==='isOperatorAuthorized')return true;throw Error('Unplanned SDK read '+p.functionName)}},
        async execute(call){
          trace.stopAttempts++; event('stop_attempt',{method:call.functionName,value:call.value,nativeBalance:BigInt(cfg.native)});
          if(BigInt(cfg.native)<call.value){event('stop_rejected_insufficient_balance');throw new RpcError('stop placement','controlled insufficient funds for 0.30 native stop deposit');}
          if(cfg.error==='stop_rpc'&&trace.stopAttempts===1){event('stop_rejected_rpc');throw new RpcError('stop placement','controlled transport rejection before broadcast');}
          const logs=[101n,102n].map((orderId,i)=>({address:registry,
            topics:encodeEventTopics({abi:perpStopRegistryEventsAbi,eventName:'PendingOrderCreated',args:{orderId,owner}}),
            data:encodeAbiParameters(parseAbiParameters('bool,uint256,uint256,uint8,uint8,address,uint96'),[false,0n,(i?1980n:2040n)*10n**18n,i,1,zero,0n])}));
          trace.armed=[101n,102n];event('stop_pair_created');
          return {hash:'0x'+'2'.repeat(64),receipt:{status:'success',logs}};
        }};
      const exchange={walletAddress:owner,
        async loadMarkets(){return {[symbol]:{symbol,type:'swap',active:true,info}}},
        async fetchPositions(){trace.positionReads++;event('position_read');return trace.position?[{symbol,side:'long',contracts:Number(trace.position)/1e18,unrealizedPnl:0}]:[]},
        async fetchOrderBook(){return {bids:[[1999,10]],asks:[[2000,10]]}},
        client:{async getMarginAccount(){return {unlockedCollateralBalance:100n*10n**18n,lockedCollateral:0n,equity:100n*10n**18n,withdrawable:100n*10n**18n,imReq:0n,mmReq:0n,cmReq:0n,marginStatus:'Healthy',activePerpPools:[]}},
          async getPerpMaxLeverage(){return 2},
          async getPerpHealthSnapshot(){return {priceable:true,markPrice:2000n*10n**18n}},
          async getMaxPerpOrderSize(){return {priceable:true,placeable:true,maxQuantity:10n**18n,limitedBy:'initialMargin',effectiveImfBps:500n}},
          async getPerpStopOrderSomiPayment(){event('stop_cost_read');return 150000000000000000n},
          async listPerpStopOrders(){event('stop_list_read');return trace.armed.map(orderIdRaw=>({orderIdRaw}))}},
        trader:{async placePerpOrder(p){trace.entryCalls++;event('entry_attempt',{quantity:p.quantity});if(cfg.error==='entry')throw new RpcError('entry','controlled pre-broadcast rejection');trace.position=p.quantity;event('entry_confirmed_fixture');return {hash:'0x'+'1'.repeat(64),receipt:{status:'success'},fills:[{quantityFilled:p.quantity}]}},
          async placePerpStopOrder(p){
            if(!cfg.retry)return sdkPlaceStop(writer,p);
            // Counterfactual only: the first injected error is known to precede
            // broadcast. This is not a production retry policy or upstream fix.
            try{return await sdkPlaceStop(writer,p)}catch(error){event('retry_counterfactual');return sdkPlaceStop(writer,p)}
          },
          async cancelPerpStopOrders(){event('cancel_stops');trace.armed=[]}}};
      export function createExchange(){return {exchange,config:{dryRun:!!cfg.dryRun,symbol:'ETH-PERP',operatorRegistry:'0x0000000000000000000000000000000000000005'}}}
      export function loadEnv(){}
      export function envNum(key,value){return key==='PERP_NOTIONAL_USDSO'?8:value}
      export function onStop(){return ()=>false}
      export async function sleep(){trace.sleeps++;if(trace.sleeps>1)throw Error('Harness poll bound exceeded');event('management_poll');if(trace.armed.length){trace.position=0n;trace.armed=[];event('synthetic_trigger_fired')}}
      export async function shutdown(){trace.shutdownCalls++;event('shutdown')}
      export async function tradingKeyCheck(){return {ok:true}}
      export async function closePosition(){trace.closeCalls++;event('close_request');return {sent:false,filled:0n}}
      process.on('exit',()=>console.log('__TRACE__'+JSON.stringify(trace,(_,v)=>typeof v==='bigint'?v.toString():v)));
    `);
    const strategyUrl = moduleOf(sources.starter.replaceAll('"@dreamdex-bot-kit/perp-core"', JSON.stringify(fixtureUrl)));
    const worker = spawnSync(process.execPath, ['--input-type=module'], {
      input: `await import(${JSON.stringify(strategyUrl)});`, encoding: 'utf8', windowsHide: true,
      timeout: 10000, maxBuffer: 300000,
      env: { SystemRoot: process.env.SystemRoot ?? '', DRY_RUN: scenario.dryRun ? 'true' : 'false', PERP_SIDE: 'long' },
    });
    if (worker.error) throw worker.error;
    const marker = worker.stdout.split(/\r?\n/).find(line => line.startsWith('__TRACE__'));
    assert.ok(marker, 'Isolated worker trace exists');
    out.cases.push({ scenario, exitCode: worker.status, trace: JSON.parse(marker.slice('__TRACE__'.length)),
      logs: worker.stdout.split(/\r?\n/).filter(line => line && !line.startsWith('__TRACE__')),
      stderr: worker.stderr.slice(0, 2000) });
  }
  const [low, rpc, funded, dry, entry, retry] = out.cases;
  for (const c of [low, rpc]) {
    check(c.scenario.name + ': entry confirms before the SDK bracket fails', c.exitCode === 1
      && c.trace.entryCalls === 1 && c.trace.stopAttempts === 1
      && c.trace.events.findIndex(e => e.op === 'entry_confirmed_fixture') < c.trace.events.findIndex(e => e.op === 'stop_attempt'));
    check(c.scenario.name + ': process exits with synthetic exposure and zero stops', c.trace.position === '4000000000000000' && c.trace.armed.length === 0);
    check(c.scenario.name + ': no management poll, close request or shutdown recovery executes', c.trace.sleeps === 0 && c.trace.closeCalls === 0 && c.trace.shutdownCalls === 0);
  }
  check('Insufficient-deposit case encodes 0.30 native value against the 0.10 fixture balance',
    low.trace.events.some(e => e.op === 'stop_attempt' && e.value === '300000000000000000' && e.nativeBalance === '100000000000000000'));
  check('Insufficient-deposit case already read/printed the stop cost before opening',
    low.trace.events.findIndex(e => e.op === 'stop_cost_read') < low.trace.events.findIndex(e => e.op === 'entry_attempt'));
  check('Funded control creates both decoded SDK stop IDs before entering management',
    funded.exitCode === 0 && funded.trace.events.some(e => e.op === 'stop_pair_created' && e.armed.join(',') === '101,102') && funded.trace.sleeps === 1);
  check('Funded control observes the synthetic trigger/flat state and shuts down cleanly',
    funded.trace.position === '0' && funded.trace.armed.length === 0 && funded.trace.shutdownCalls === 1);
  check('Dry-run control sends neither an entry nor a stop and leaves no exposure',
    dry.exitCode === 0 && dry.trace.entryCalls === 0 && dry.trace.stopAttempts === 0 && dry.trace.position === '0');
  check('Rejected-entry control never attempts a bracket and leaves no exposure',
    entry.exitCode === 1 && entry.trace.entryCalls === 1 && entry.trace.stopAttempts === 0 && entry.trace.position === '0');
  check('Counterfactual: the same one-time pre-broadcast fault can recover on a bounded second SDK attempt',
    retry.exitCode === 0 && retry.trace.stopAttempts === 2 && retry.trace.events.filter(e => e.op === 'retry_counterfactual').length === 1);
  check('Counterfactual: only one entry occurs and management begins after protection succeeds',
    retry.trace.entryCalls === 1 && retry.trace.sleeps === 1 && retry.trace.shutdownCalls === 1
    && retry.trace.events.findIndex(e => e.op === 'stop_pair_created') < retry.trace.events.findIndex(e => e.op === 'management_poll'));
} catch (error) {
  out.error = { name: error.name, message: error.message.slice(0, 2000) };
  process.exitCode = 1;
  console.error(out.error);
} finally {
  clearTimeout(deadline);
  out.completedAt = new Date().toISOString();
  await writeFile('evidence/starter-protection-failure-round8.json', JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log('Saved', out.checks.length, 'checks. Zero RPC or transactions.');
}
