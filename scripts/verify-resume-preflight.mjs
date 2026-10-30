import assert from 'node:assert/strict';
import {stripTypeScriptTypes} from 'node:module';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {createPublicClient,http,parseAbi} from 'viem';
import {hidekiTestnet} from '@somnia-chain/markets-sdk/chains';
import {contractErrorsAbi,ORDER_TYPE} from '@somnia-chain/markets-sdk';
import {getMarginAccount,previewPerpOrderMargin} from '../node_modules/@somnia-chain/markets-sdk/dist/perp/margin.js';
import {perpPoolReadAbi,marginBankReadAbi} from '../node_modules/@somnia-chain/markets-sdk/dist/readsAbi.js';

// Actual strategy CLI workers use fixture exchange/startup/close boundaries and
// sanitized environments, never a key. The additional historical check uses only
// reads and eth_call; an accepted simulation is not a mined fill or closed position.
const commit='4e75896896e024c03e2033d5920514f249998cd6';
const specs={
  starter:['strategies/perp-starter/src/index.ts','3e0158ab088489fbd63ff4a0e1a38174d6c5be6a3fee1fd85c4ea19065f731b1'],
  funding:['strategies/perp-funding/src/index.ts','0e622d76f877566d2385f30aad43fcf48550b2a9e9a7ee8b9bfd2eb8b3d79423'],
  margin:['packages/perp-core/src/margin.ts','041cfbb5a34bc80c6ddb2d71d81b592c979826a950d617aebdbb2533ea58d23a'],
  markets:['packages/perp-core/src/markets.ts','95dfbbb84d114927f5a5df87f4a0d96114d3904cb98a8c06c42c3823880a0520'],
  orders:['packages/perp-core/src/orders.ts','a9ed57032c74315deafaea99a9ce349875b5bcd4b6eb0d09e2c5065c9402c583'],
  rates:['packages/perp-core/src/funding.ts','c118b8fa828129449ce81e4bef35e6cac5459e370dbfcc32e96925cd9d2bb91f'],
};
const dataModule=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const sdkUrl=import.meta.resolve('@somnia-chain/markets-sdk');
const out={at:new Date().toISOString(),sdk:'0.32.1',kitCommit:commit,transactions:0,signer:false,
  mode:'controlled strategy workers plus read-only historical contract control',
  sourceHashes:Object.fromEntries(Object.entries(specs).map(([k,v])=>[k,v[1]])),checks:[],cases:[]};
const check=(label,value)=>{assert.ok(value,label);out.checks.push(label);console.log('VERIFIED',label)};
const deadline=setTimeout(()=>process.exit(2),60_000);
try{
  const source=Object.fromEntries(await Promise.all(Object.entries(specs).map(async([key,[path,hash]])=>{
    const response=await fetch(`https://raw.githubusercontent.com/somnia-chain/dreamdex-bot-kit/${commit}/${path}`,{signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200);const text=await response.text();assert.equal(createHash('sha256').update(text).digest('hex'),hash,key);
    return [key,stripTypeScriptTypes(text,{mode:'strip'})];
  })));
  const marketsUrl=dataModule(source.markets),marginUrl=dataModule(source.margin);
  const ordersUrl=dataModule(source.orders.replaceAll('"@somnia-chain/markets-sdk"',JSON.stringify(sdkUrl))
    .replaceAll('"viem"',JSON.stringify(import.meta.resolve('viem'))).replaceAll('"./markets.js"',JSON.stringify(marketsUrl))
    .replaceAll('"./exchange.js"',JSON.stringify(dataModule('export function assertTxOk(){throw Error("Writes blocked")}')))
    .replaceAll('"./operator.js"',JSON.stringify(dataModule('export async function placeFor(){throw Error("Writes blocked")} export async function cancelFor(){throw Error("Writes blocked")}'))));
  const ratesUrl=dataModule(source.rates.replaceAll('"@somnia-chain/markets-sdk"',JSON.stringify(sdkUrl)));
  for(const strategy of ['starter','funding']) for(const scenario of [
    {name:'held_low_free',held:true,free:5,notional:50},
    {name:'held_entry_threshold_control',held:true,free:25,notional:50},
    {name:'flat_low_free_control',held:false,free:5,notional:50},
    {name:'held_lower_entry_setting_control',held:true,free:5,notional:2},
  ]){
    const fixtureUrl=dataModule(`
      export {ORDER_TYPE} from ${JSON.stringify(sdkUrl)};
      export {requireMarket,liveMark,markOf,sizeForNotional} from ${JSON.stringify(marketsUrl)};
      export {preflight,ensureLeverage} from ${JSON.stringify(marginUrl)};
      export {positionIn} from ${JSON.stringify(ordersUrl)};
      export {liveFunding} from ${JSON.stringify(ratesUrl)};
      const cfg=${JSON.stringify(scenario)};
      const owner='0x0000000000000000000000000000000000000003';
      const info={poolAddress:'0x0000000000000000000000000000000000000001',marginBank:'0x0000000000000000000000000000000000000002',baseSymbol:'ETH',quoteSymbol:'USDso',baseDecimals:18,quoteDecimals:18,markPrice:'2000000000000000000000'};
      const trace={positionReads:0,marginReads:0,closes:[],sleeps:0,shutdown:0,entryCalls:0};
      const exchange={walletAddress:owner,
        async loadMarkets(){return {'ETH/USDso:USDso':{symbol:'ETH/USDso:USDso',type:'swap',active:true,info}}},
        async fetchPositions(){trace.positionReads++;return cfg.held?[{symbol:'ETH/USDso:USDso',side:'long',contracts:0.004,unrealizedPnl:0}]:[]},
        client:{async getMarginAccount(){trace.marginReads++;return {unlockedCollateralBalance:BigInt(cfg.free)*10n**18n,lockedCollateral:0n,equity:BigInt(cfg.free)*10n**18n,withdrawable:0n,imReq:4n*10n**17n,mmReq:2n*10n**17n,cmReq:1n*10n**17n,marginStatus:'Healthy',activePerpPools:cfg.held?[info.poolAddress]:[]}},
          async getPerpMaxLeverage(){return 2},
          async getPerpHealthSnapshot(){return {priceable:true,markPrice:BigInt(trace.sleeps?1970:2000)*10n**18n}},
          async getPerpState(){return {fundingRate:10n**15n,fundingWindowSec:28800,fundingIntervalSec:3600}}}};
      export function createExchange(){return {exchange,config:{dryRun:false,owner,symbol:'ETH-PERP'},tradingKey:{owner,operator:'0x0000000000000000000000000000000000000004'}}}
      export function loadEnv(){}
      export function envNum(key,value){return key.includes('NOTIONAL_USDSO')?cfg.notional:value}
      export function onStop(){return ()=>trace.sleeps>=1}
      export async function sleep(){trace.sleeps++}
      export async function shutdown(){trace.shutdown++}
      export async function tradingKeyCheck(){return {ok:true,message:'controlled link check'}}
      export async function closePosition(_ctx,_market,_owner,opts){trace.closes.push(opts.label);return {sent:false,filled:0n}}
      export async function pendingStops(){return []}
      export async function armBracket(){throw Error('Stop writes blocked')}
      export async function cancelStops(){throw Error('Stop writes blocked')}
      export async function somiPerStop(){throw Error('Owner stop path not exercised')}
      export async function sizeOrder(){throw Error('Opening path not exercised')}
      export async function placePerp(){trace.entryCalls++;throw Error('Writes blocked')}
      process.on('exit',()=>console.log('__HARNESS_TRACE__'+JSON.stringify(trace)));
    `);
    // Actual CLI entry and process.exit remain intact; exit codes are observed in a child.
    const strategyUrl=dataModule(source[strategy].replaceAll('"@dreamdex-bot-kit/perp-core"',JSON.stringify(fixtureUrl)));
    const worker=spawnSync(process.execPath,['--input-type=module'],{
      input:`await import(${JSON.stringify(strategyUrl)});`,
      encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:300000,
      env:{SystemRoot:process.env.SystemRoot??'',DRY_RUN:'false',PERP_SIDE:'long'},
    });
    if(worker.error)throw worker.error;
    const marker=worker.stdout.split(/\r?\n/).find(l=>l.startsWith('__HARNESS_TRACE__'));assert.ok(marker,'Worker trace must exist');
    out.cases.push({strategy,scenario,exitCode:worker.status,trace:JSON.parse(marker.slice('__HARNESS_TRACE__'.length)),
      logs:worker.stdout.split(/\r?\n/).filter(l=>l&&!l.startsWith('__HARNESS_TRACE__')),stderr:worker.stderr.slice(0,1500)});
  }
  for(const strategy of ['starter','funding']){
    const [low,enough,flat,lower]=out.cases.filter(c=>c.strategy===strategy);
    check(strategy+': held low-free account exits 1 before reading its position',low.exitCode===1&&low.trace.positionReads===0&&low.trace.closes.length===0);
    check(strategy+': sufficient-free control reaches position management and close boundary',enough.exitCode===0&&enough.trace.closes.length===1);
    check(strategy+': flat low-free account still correctly fails entry preflight',flat.exitCode===1&&flat.trace.closes.length===0);
    check(strategy+': lowering unused entry notional lets the same held position be managed',lower.exitCode===0&&lower.trace.closes.length===1);
    check(strategy+': no worker reaches an opening write',out.cases.filter(c=>c.strategy===strategy).every(c=>c.trace.entryCalls===0));
  }
  const block=36620783n,account='0x3390B5CE917F61640DBb68FD1D86F45E483648AC',pool='0xd6cb1dd58580b84d76068ac21594219ce03aeddf',bank='0x478769e1177c0773c43a593dccc4ad15f15f1394';
  const client=createPublicClient({chain:hidekiTestnet,transport:http('https://api.hideki2.infra.testnet.somnia.network',{timeout:15000,retryCount:0})});
  const [margin,position,book,levels]=await Promise.all([
    getMarginAccount(bank,account,{...client,getBlockNumber:async()=>block}),
    client.readContract({address:bank,abi:marginBankReadAbi,functionName:'getPosition',args:[account,pool],blockNumber:block}),
    client.readContract({address:pool,abi:perpPoolReadAbi,functionName:'getOrderBookParameters',blockNumber:block}),
    client.readContract({address:pool,abi:parseAbi(['function getBookLevels(bool isBid, uint64 numLevels) view returns ((uint256 price, uint256 quantity)[])']),functionName:'getBookLevels',args:[true,1n],blockNumber:block}),
  ]);
  const {preflight}=await import(marginUrl);
  const checkResult=await preflight({client:{getMarginAccount:async()=>margin}},{info:{quoteDecimals:18,marginBank:bank}},account,{requiredUsdso:25,linkedAccount:false});
  const price=(levels[0].price*9980n/10000n)/book.tickSize*book.tickSize;
  const reducingQuote=await previewPerpOrderMargin({pool,marginBank:bank,account,isBid:false,quantity:position.size,price,autoPull:false},{...client,getBlockNumber:async()=>block});
  const abi=[...parseAbi(['function placeOrder(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)']),...contractErrorsAbi];
  const simulated=await client.simulateContract({address:pool,abi,functionName:'placeOrder',account,args:[false,0n,price,position.size,4000000000000000000n,ORDER_TYPE.MARKET,0,'0x0000000000000000000000000000000000000000',0n],blockNumber:block,gas:30000000n});
  out.historical={block,account,pool,bank,margin,position,book,levels,preflight:checkResult,reducingQuote,simulation:{price,quantity:position.size,result:simulated.result},
    limits:'Owner eth_call only. Success means the requested reducing order is accepted in simulation, not a mined fill, full close, operator grant or restart of a real bot.'};
  check('Historical account has a positive ETH position at the pinned block',position.size===4000000000000000n);
  check('Actual preflight rejects the actual nonempty bank for 25 USDso entry requirement',!checkResult.ok&&margin.unlockedCollateralBalance>0n&&margin.unlockedCollateralBalance<25n*10n**18n);
  check('Same-block SDK quote confirms a pure reduction with zero margin lock and no auto-pull',reducingQuote.priceable&&reducingQuote.increasingQuantity===0n&&reducingQuote.reducingQuantity===position.size&&reducingQuote.lockAmount===0n&&reducingQuote.topUpRequired===0n);
  check('Same-block reducing-order eth_call returns acceptance',simulated.result[0]===true);
}catch(error){out.error={name:error.name,message:(error.shortMessage??error.message).slice(0,1500)};process.exitCode=1}
finally{clearTimeout(deadline);await writeFile('evidence/resume-preflight-round6.json',JSON.stringify(out,(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');console.log('Saved',out.checks.length,'checks',out.error??'')}
