import { writeFile } from 'node:fs/promises';
import { SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES, fromHuman, toHumanString, fundingRate1h, fundingRate8h, perpLiquidationPrice } from '@somnia-chain/markets-sdk';
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains';
const sdk = new SomniaMarkets({ chain: hidekiTestnet, indexerUrl: 'https://hideki-dev.smk.somnia.host/v1/graphql', addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES });
const out = { at: new Date().toISOString(), sdk: '0.32.1', chainId: hidekiTestnet.id, signing: false, checks: [] };
const stringify = x => JSON.stringify(x, (_,v) => typeof v === 'bigint' ? v.toString() : v, 2);
async function check(name,fn){const start=Date.now();try{const value=await fn();out.checks.push({name,ok:true,milliseconds:Date.now()-start,value});console.log(name,'OK', typeof value==='object' ? Object.keys(value??{}).slice(0,8).join(',') : String(value));return value;}catch(e){out.checks.push({name,ok:false,milliseconds:Date.now()-start,error:{name:e.name,message:e.message.slice(0,1200)}});console.log(name,'FAIL',e.name,e.message.slice(0,180));}}
const deadline=setTimeout(()=>{console.error('Bounded survey deadline reached');sdk.close();process.exitCode=1;},60000);
try {
 const markets=await check('discover-perps',()=>sdk.client.listPerpMarkets());
 await check('unified-load',async()=>{const m=await sdk.loadMarkets();return Object.values(m).map(x=>({symbol:x.symbol,type:x.type,base:x.base,quote:x.quote}));});
 for(const m of (markets??[]).filter(x=>['BTC','SOL','NEAR'].includes(x.baseSymbol))){
  await check('state-'+m.baseSymbol,()=>sdk.client.getPerpState(m.poolAddress));
  await check('risk-'+m.baseSymbol,()=>sdk.client.getPerpRiskParams(m.poolAddress));
 }
 await check('exact-decimal-string',()=>[{input:'0.0000009',decimals:6,output:fromHuman('0.0000009',6).toString()},{input:'0.123456789',decimals:8,output:fromHuman('0.123456789',8).toString()},{input:'1.2345',decimals:2,output:fromHuman('1.2345',2).toString()}]);
 await check('unit-roundtrip',()=>[6,8,9,18,24].map(d=>({decimals:d,input:'0.1',output:toHumanString(fromHuman('0.1',d),d)})));
 await check('funding-normalization',()=>({hour:fundingRate1h(8000000000000000n,28800),eightHour:fundingRate8h(8000000000000000n,28800)}));
 await check('liquidation-symmetry',()=>[1n,-1n].map(size=>perpLiquidationPrice({equity:100n*10n**18n,mmReq:25n*10n**18n,size:size*10n**18n,markPrice:1000n*10n**18n,maintenanceMarginBps:250n,oneBase:10n**18n})));
} finally {clearTimeout(deadline);await sdk.close();await writeFile('evidence/read-only-survey.json',stringify(out)+'\n');}
