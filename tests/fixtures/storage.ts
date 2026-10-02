import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { appendFileSync } from 'node:fs';
export default function(pi:any) {
 pi.registerProvider('storage-proof',{baseUrl:'http://scripted.invalid',apiKey:'DUMMY_STORAGE_CREDENTIAL',api:'proof',models:[{id:'scripted',name:'Storage proof',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000}],
 streamSimple(model:any,context:any,options:any){
  const s=createAssistantMessageEventStream();
  const m:any={role:'assistant',api:'proof',provider:model.provider,model:model.id,timestamp:Date.now(),content:[{type:'text',text:''}],stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  (async()=>{
   appendFileSync(process.env.PROOF_LOG!,JSON.stringify({event:'request',prompt:context.messages})+'\n');
   await options.onPayload?.({prompt:'STORAGE_PROMPT_MARKER',oversize:'x'.repeat(2*1024*1024)});
   s.push({type:'start',partial:m});s.push({type:'text_start',contentIndex:0,partial:m});
   for(let i=0;i<600;i++)await options.onProviderStreamEvent?.({type:'heartbeat',body:'STORAGE_EVENT_MARKER',oversize:'x'.repeat(4096)},model);
   m.content[0].text='STORAGE_OUTPUT_COMPLETE';s.push({type:'text_delta',contentIndex:0,delta:m.content[0].text,partial:m});s.push({type:'text_end',contentIndex:0,content:m.content[0].text,partial:m});s.push({type:'done',reason:'stop',message:m});s.end();
   appendFileSync(process.env.PROOF_LOG!,JSON.stringify({event:'completed'})+'\n');
  })().catch(()=>{appendFileSync(process.env.PROOF_LOG!,'{"event":"error"}\n');s.end();});return s;
 }});
}
