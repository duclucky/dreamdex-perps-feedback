import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES, fromHuman, toHumanString, fundingRatePerInterval } from '@somnia-chain/markets-sdk';
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains';
const result = { at: new Date().toISOString(), sdk: '0.32.1', chainId: 50383, signedOrSentTransactions: false, assertions: [], observations: [] };
function verified(name,fn) {fn();result.assertions.push(name);console.log('VERIFIED',name);}
const units = await readFile('node_modules/@somnia-chain/markets-sdk/dist/units.d.ts','utf8');
verified('Published string contract promises exact preservation or rejection',()=>assert.ok(units.includes('string when you need the exact value preserved or rejected')));
const cases=[{input:'0.0000009',decimals:6,raw:1n,human:'0.000001'},{input:'0.123456789',decimals:8,raw:12345679n,human:'0.12345679'},{input:'0.0000000000000000009',decimals:18,raw:1n,human:'0.000000000000000001'}];
for(const c of cases){const raw=fromHuman(c.input,c.decimals);verified(`String ${c.input} at ${c.decimals} decimals is rounded without rejection`,()=>{assert.equal(raw,c.raw);assert.equal(toHumanString(raw,c.decimals),c.human);assert.notEqual(c.input,c.human);});result.observations.push({...c,raw:raw.toString()});}
verified('Exactly representable strings preserve value (control)',()=>assert.equal(fromHuman('0.12345678',8),12345678n));
const stateType=await readFile('node_modules/@somnia-chain/markets-sdk/dist/perp/state.d.ts','utf8');
verified('Published fundingRate property says per settlement window',()=>assert.ok(stateType.includes('Current funding rate per settlement window')));
verified('Same declaration says denominator is calculation window, not settlement interval',()=>assert.ok(stateType.includes('not per settlement interval')));
const guide=await readFile('node_modules/@somnia-chain/markets-sdk/docs/PERPS.md','utf8');
verified('Live guide recommends watchPerpMarkets and later says tail subscribes neither singleton',()=>{assert.ok(guide.includes('watchPerpMarkets()'));assert.ok(guide.includes("SDK's own live tail does not subscribe either singleton yet"));});
const sdk=new SomniaMarkets({chain:hidekiTestnet,indexerUrl:'https://hideki-dev.smk.somnia.host/v1/graphql',addresses:SOMNIA_HIDEKI_TESTNET_ADDRESSES});
let watch;
const deadline=setTimeout(()=>{sdk.close();console.error('Verification deadline exceeded');process.exitCode=1;},30000);
try{
 const markets=await sdk.client.listPerpMarkets();const btc=markets.find(m=>m.baseSymbol==='BTC');assert.ok(btc);
 const state=await sdk.client.getPerpState(btc.poolAddress);
 verified('Live BTC calculation window and settlement interval differ by factor eight',()=>assert.equal(state.fundingWindowSec/state.fundingIntervalSec,8));
 const normalized=fundingRatePerInterval(state.fundingRate,state.fundingWindowSec,state.fundingIntervalSec);
 verified('Current raw rate requires eightfold denominator adjustment for one settlement',()=>assert.equal(normalized,state.fundingRate/8n));
 result.observations.push({name:'live-funding',pool:btc.poolAddress,rawFundingRate:state.fundingRate.toString(),windowSec:state.fundingWindowSec,intervalSec:state.fundingIntervalSec,perIntervalRate:normalized.toString()});
 watch=await sdk.client.watchPerpMarkets();
 const liqs=sdk.client.listLiveLiquidations({limit:3}),funding=sdk.client.listLiveFundingPayments({limit:3});
 verified('Shipped SDK acquires the singleton perp plane',()=>assert.equal(typeof watch.stop,'function'));
 result.observations.push({name:'watch-perp-plane',liquidationRows:liqs.length,fundingPaymentRows:funding.length,liquidationIds:liqs.map(x=>x.id),fundingIds:funding.map(x=>x.id),limitation:'Watch acquisition/hydration verified; no newly mined event was required or claimed.'});
} catch(e){result.liveError={name:e.name,message:e.message.slice(0,1200)};throw e;}finally{watch?.stop();await sdk.close();clearTimeout(deadline);await writeFile('evidence/candidate-verification.json',JSON.stringify(result,null,2)+'\n');}
