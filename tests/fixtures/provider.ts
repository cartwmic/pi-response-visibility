import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { appendFileSync } from 'node:fs';
export default function(pi) {
 pi.registerProvider('visibility-proof', { baseUrl:'http://scripted.invalid',apiKey:'dummy',api:'proof',models:[{id:'scripted',name:'Scripted',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000}],
 streamSimple(model, context, options) {
 const log=(event,data={})=>appendFileSync(process.env.PROOF_LOG!,JSON.stringify({event,...data})+'\n');
 const users=context.messages.filter(x=>x.role==='user').map(x=>JSON.stringify(x.content));
 const text=users.at(-1)||'';
 const prior=users.slice(0,-1).join('\n');
 log('request',{messages:context.messages,tools:context.tools,payload:{test:true}});
 const s=createAssistantMessageEventStream();
 const m:any={role:'assistant',api:'proof',provider:model.provider,model:model.id,timestamp:Date.now(),content:[],stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
 (async()=>{
 await options.onPayload?.({test:true}); s.push({type:'start',partial:m}); log('started');
 const slow=text.includes('SLOW') && !text.includes('FOLLOWUP');
 for(let i=0;i<(slow?60:1);i++){await new Promise(r=>setTimeout(r,100)); if(options.signal?.aborted){m.stopReason='aborted';log('abort');s.push({type:'error',reason:'aborted',error:m});s.end();return;} await options.onProviderStreamEvent?.({type:'heartbeat'},model);}
 if(text.includes('ERROR')&&!text.includes('FOLLOWUP')){m.stopReason='error';m.errorMessage='SCRIPTED_FAILURE';s.push({type:'error',reason:'error',error:m});}
 else {const answer=text.includes('FOLLOWUP')?(prior.includes('SLOW cedar')&&prior.includes('SLOW violet')?'COHERENT cedar violet DONE_FOLLOWUP':'INCOHERENT unknown cedar or violet DONE_FOLLOWUP'):'PROOF_COMPLETE';log('answer',{answer});m.content=[{type:'text',text:''}];s.push({type:'text_start',contentIndex:0,partial:m});m.content[0].text=answer;s.push({type:'text_delta',contentIndex:0,delta:answer,partial:m});s.push({type:'text_end',contentIndex:0,content:answer,partial:m});s.push({type:'done',reason:'stop',message:m});}
 s.end(); log('completed',{reason:m.stopReason});
 })().catch(e=>{log('fixture-error',{error:String(e)});s.end();});return s;
 }});
}
