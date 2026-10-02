import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { appendFileSync } from 'node:fs';
const sleep = (ms:number) => new Promise(r=>setTimeout(r,ms));
const log = (event:string) => appendFileSync(process.env.PROOF_LOG!,JSON.stringify({event,at:performance.now()})+'\n');
export default function(pi:any) {
 pi.on('before_provider_request',async()=>{log('hook-start');await sleep(1300);log('hook-end');});
 pi.registerProvider('clock-proof',{baseUrl:'http://scripted.invalid',apiKey:'dummy',api:'proof',models:[{id:'scripted',name:'Scripted clocks',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000}],
 streamSimple(model:any,context:any,options:any){
  log('request');const s=createAssistantMessageEventStream();
  const m:any={role:'assistant',api:'proof',provider:model.provider,model:model.id,timestamp:Date.now(),content:[],stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  (async()=>{
   await options.onPayload?.({fixture:'clocks'});s.push({type:'start',partial:m});
   for(let i=0;i<15;i++){await sleep(100);await options.onProviderStreamEvent?.({type:'heartbeat'},model);log('heartbeat');}
   for(const [kind,index] of [['thinking',0],['text',1],['toolcall',2]] as const){
    m.content[index]=kind==='thinking'?{type:'thinking',thinking:''}:kind==='text'?{type:'text',text:''}:{type:'toolCall',id:'fixture-tool',name:'unused',arguments:{}};
    s.push({type:kind+'_start',contentIndex:index,partial:m} as any);
    for(let i=0;i<8;i++){
     await sleep(180);const delta=kind==='toolcall'?(i===0?'{':i===7?'}':' '):'x';
     if(kind==='thinking')m.content[index].thinking+=delta;
     if(kind==='text')m.content[index].text+=delta;
     s.push({type:kind+'_delta',contentIndex:index,delta,partial:m} as any);log(kind+'-delta');
    }
    s.push({type:kind+'_end',contentIndex:index,content:kind==='toolcall'?m.content[index]:'xxxxxxxx',partial:m} as any);
   }
   m.content=m.content.filter((x:any)=>x.type!=='toolCall');m.content.push({type:'text',text:'CLOCK_PROOF_COMPLETE'});
   s.push({type:'text_delta',contentIndex:2,delta:'CLOCK_PROOF_COMPLETE',partial:m});s.push({type:'done',reason:'stop',message:m});s.end();log('completed');
  })().catch(e=>{log('error:'+String(e));s.end();});return s;
 }});
}
