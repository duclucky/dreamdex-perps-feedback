import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { writeFile, readFile } from 'node:fs/promises';
import { SomniaMarkets } from '@somnia-chain/markets-sdk';

// Controlled logic reproduction: no SDK client/transport/signer is constructed.
// The real SDK fetchPositions scans a fixture registry; all engine responses and
// the documented cache boundary are fixtures. Only source downloads use network.
const commit = '4e75896896e024c03e2033d5920514f249998cd6';
const specs = {
  guard: ['strategies/perp-guard/src/index.ts', '5a7712eb30e5baaa8a4657301d121055ecff804e967c7f189637df309ef5e21a'],
  markets: ['packages/perp-core/src/markets.ts', '95dfbbb84d114927f5a5df87f4a0d96114d3904cb98a8c06c42c3823880a0520'],
  orders: ['packages/perp-core/src/orders.ts', 'a9ed57032c74315deafaea99a9ce349875b5bcd4b6eb0d09e2c5065c9402c583'],
  margin: ['packages/perp-core/src/margin.ts', '041cfbb5a34bc80c6ddb2d71d81b592c979826a950d617aebdbb2533ea58d23a'],
};
const out = { at: new Date().toISOString(), kitCommit: commit, sdk: '0.32.1',
  mode: 'offline controlled-source harness', syntheticState: true, rpcCalls: 0, transactions: 0,
  fixtureDisclosure: 'Healthy registry cache, registry listing, engine positions/health, timers, startup and close boundary are controlled. Actual SDK fetchPositions and upstream guard/watchList/perpMarkets/positionIn/marginSnapshot/healthRatio bodies execute. No real close is attempted.',
  checks: [], cases: [], sourceHashes: Object.fromEntries(Object.entries(specs).map(([k,v])=>[k,v[1]])) };
const check = (name, value) => { assert.ok(value, name); out.checks.push(name); console.log('VERIFIED',name); };
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const sdkUrl = import.meta.resolve('@somnia-chain/markets-sdk');
const deadline = setTimeout(()=>process.exit(2),60_000);
try {
  const metadata = JSON.parse(await readFile(new URL('../node_modules/@somnia-chain/markets-sdk/package.json',import.meta.url),'utf8'));
  assert.equal(metadata.version, out.sdk);
  const sdkExchange = await readFile(new URL('../node_modules/@somnia-chain/markets-sdk/dist/unified/exchange.js',import.meta.url));
  out.sdkExchangeSha256=createHash('sha256').update(sdkExchange).digest('hex');
  const source = {};
  for (const [key,[path,hash]] of Object.entries(specs)) {
    const response=await fetch(`https://raw.githubusercontent.com/somnia-chain/dreamdex-bot-kit/${commit}/${path}`,{signal:AbortSignal.timeout(15_000)});
    assert.equal(response.status,200); const text=await response.text();
    assert.equal(createHash('sha256').update(text).digest('hex'),hash,key);
    source[key]=stripTypeScriptTypes(text,{mode:'strip'});
  }
  const marketsUrl=moduleUrl(source.markets);
  const marginUrl=moduleUrl(source.margin);
  const ordersUrl=moduleUrl(source.orders
    .replaceAll('"@somnia-chain/markets-sdk"',JSON.stringify(sdkUrl))
    .replaceAll('"viem"',JSON.stringify(import.meta.resolve('viem')))
    .replaceAll('"./markets.js"',JSON.stringify(marketsUrl))
    .replaceAll('"./exchange.js"',JSON.stringify(moduleUrl('export function assertTxOk(){throw Error("Writes blocked")}')))
    .replaceAll('"./operator.js"',JSON.stringify(moduleUrl('export async function placeFor(){throw Error("Writes blocked")} export async function cancelFor(){throw Error("Writes blocked")}'))));
  for (const scenario of [
    {name:'new_market_only',existing:false,newMarket:true},
    {name:'existing_market_new_position',existing:false,newMarket:false},
    {name:'old_and_new_markets',existing:true,newMarket:true},
    {name:'explicit_refresh_control',existing:false,newMarket:true,refresh:true},
    {name:'halted_cached_market_control',existing:false,newMarket:false,halted:true},
  ]) {
    const fixtureUrl=moduleUrl(`
      import {SomniaMarkets} from ${JSON.stringify(sdkUrl)};
      export {perpMarkets, requireMarket, liveMark, markOf} from ${JSON.stringify(marketsUrl)};
      export {positionIn} from ${JSON.stringify(ordersUrl)};
      export {healthRatio, marginSnapshot} from ${JSON.stringify(marginUrl)};
      const cfg=${JSON.stringify(scenario)};
      const address=n=>'0x'+n.toString(16).padStart(40,'0');
      const row=(base,id)=>({symbol:base+'/USDso:USDso',type:'swap',active:!cfg.halted,
        info:{poolAddress:address(id),marginBank:address(9),baseSymbol:base,quoteSymbol:'USDso',baseDecimals:18,quoteDecimals:18,markPrice:'100000000000000000000'}});
      const old=row('ETH',1), added=row('NEW',2);
      export const state={poll:0,loads:[],reads:[],health:[],closes:[],shutdown:0};
      const held=pool=>pool===old.info.poolAddress ? (cfg.existing||(!cfg.newMarket&&state.poll>0)) : (cfg.newMarket&&state.poll>0);
      const engine={async getPerpPosition({pool}){state.reads.push({pool,poll:state.poll});return {size:held(pool)?10n**16n:0n,avgEntryPrice:100n*10n**18n,lastUpdatedTimestampNs:0n}},
        async getPerpState(){throw Error('Controlled unavailable optional PnL read')},async getLiquidationPrice(){return null}};
      const exchange={walletAddress:address(3),markets:{[old.symbol]:old},
        requireAddress(){return this.walletAddress},
        async loadMarkets(reload=false){state.loads.push({reload,poll:state.poll});if(reload&&state.poll>0&&cfg.newMarket)this.markets[added.symbol]=added;return this.markets},
        async loadMarketsFor(){return this.loadMarkets()},
        market(ref){const m=this.markets[ref];if(!m)throw Error('Unknown fixture symbol');return {symbol:m.symbol,chainId:50383,pool:m.info.poolAddress,market:m.info}},
        readEngines(){return [[50383,engine]]},
        async perChain(engines,fn){return Promise.all(engines.map(([chainId,eng])=>fn(chainId,eng)))},
        async fetchPositions(){return SomniaMarkets.prototype.fetchPositions.call(this)},
        client:{async getPerpHealthSnapshot(){return {priceable:true,markPrice:100n*10n**18n}},
          async getMarginAccount(){state.health.push(state.poll);return {unlockedCollateralBalance:1n,lockedCollateral:10n,equity:11n,withdrawable:1n,imReq:20n,mmReq:10n,cmReq:5n,marginStatus:'fixture',activePerpPools:[]}}}};
      export const ctx={exchange,config:{dryRun:false,symbol:''}};
      export function createExchange(){return ctx}
      export function loadEnv(){}
      export function envNum(_key,value){return value}
      export function onStop(){return ()=>state.poll>=2}
      export async function sleep(){state.poll++;if(cfg.refresh)await exchange.loadMarkets(true)}
      export async function shutdown(){state.shutdown++}
      export async function linkCoverage(){throw Error('Linked-account branch not exercised')}
      export async function closePosition(_ctx,market,_account,opts){state.closes.push({symbol:market.symbol,poll:state.poll,label:opts.label});return {sent:false,filled:0n}}
    `);
    const entryIndex=source.guard.lastIndexOf('\nmain().then('); assert.ok(entryIndex>0);
    const guardUrl=moduleUrl(source.guard.slice(0,entryIndex).replaceAll('"@dreamdex-bot-kit/perp-core"',JSON.stringify(fixtureUrl))+'\nexport {main,watchList};');
    const {main,watchList}=await import(guardUrl); const {state,ctx}=await import(fixtureUrl);
    const logs=[]; const original=console.log; console.log=(...args)=>logs.push(args.join(' '));
    try{await main()}finally{console.log=original}
    const beforeRefresh=(await watchList(ctx,ctx.exchange.walletAddress)).map(m=>m.symbol);
    await ctx.exchange.loadMarkets(true);
    const afterRefresh=(await watchList(ctx,ctx.exchange.walletAddress)).map(m=>m.symbol);
    out.cases.push({scenario,logs,beforeRefresh,afterRefresh,...state});
  }
  const [missing,known,both,refreshed,halted]=out.cases;
  check('New-market-only case reports no positions in both cycles',missing.logs.filter(x=>x==='no open positions to guard').length===2);
  check('New-market position receives no health check or close attempt',missing.health.length===0&&missing.closes.length===0);
  check('No live loop ever asks loadMarkets to reload',out.cases.filter(c=>!c.scenario.refresh).every(c=>c.loads.filter(l=>l.poll<2).every(l=>!l.reload)));
  check('Actual SDK position read never queries the new pool before refresh',missing.reads.filter(r=>r.poll<2).every(r=>r.pool.endsWith('1')));
  check('New position on a cached market is detected without refresh',known.closes.length===1&&known.closes[0].poll===1);
  check('Old and new case guards only the cached ETH position',both.closes.length===2&&both.closes.every(c=>c.symbol==='ETH/USDso:USDso'));
  check('New market remains absent in the unrefreshed watch list',missing.beforeRefresh.length===0&&!both.beforeRefresh.includes('NEW/USDso:USDso'));
  check('One explicit refresh exposes the new held market',missing.afterRefresh.includes('NEW/USDso:USDso')&&both.afterRefresh.includes('NEW/USDso:USDso'));
  check('Refresh control checks and requests flatten on the new market',refreshed.closes.some(c=>c.symbol==='NEW/USDso:USDso'&&c.poll===1&&c.label==='guard flatten'));
  check('Halted cached market remains covered as intended',halted.closes.length===1&&halted.beforeRefresh.includes('ETH/USDso:USDso'));
  check('All ordinary guard runs finish and call shutdown',out.cases.every(c=>c.shutdown===1&&c.logs.includes('guard stopped')));
} catch(error) {
  out.error={name:error.name,message:error.message.slice(0,1200)};process.exitCode=1;
} finally {
  clearTimeout(deadline);
  await writeFile('evidence/guard-discovery-round5.json',JSON.stringify(out,(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
  console.log('Saved',out.checks.length,'offline checks',out.error??'');
}
