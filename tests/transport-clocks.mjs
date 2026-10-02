// Actual Pi Codex connection/registration clocks against a delayed local backend.
import {mkdir,cp,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {corePatch} from '../src/core-patch.mjs';
const root=process.env.CLOCK_ARTIFACT_ROOT, install=process.env.PI_TEST_ROOT;
if(!root||!install)throw Error('CLOCK_ARTIFACT_ROOT and PI_TEST_ROOT required');
await mkdir(root,{recursive:true});
const privatePi=join(root,'private-pi');await cp(install,privatePi,{recursive:true});
const require=createRequire(join(privatePi,'package.json'));
const {WebSocketServer}=require('ws');const ws=new WebSocketServer({noServer:true});
const progress=[];const log=(event)=>progress.push({event,at:performance.now()});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const server=createServer();
server.on('upgrade',async(req,socket,head)=>{log('upgrade-start');await sleep(1400);log('upgrade-end');ws.handleUpgrade(req,socket,head,s=>ws.emit('connection',s));});
ws.on('connection',socket=>socket.on('message',async()=>{
 log('request');
 const send=e=>socket.send(JSON.stringify(e));
 for(let i=0;i<15;i++){send({type:'response.created',response:{id:'fixture',status:'in_progress',output:[]}});log('lifecycle');await sleep(100);}
 send({type:'response.output_item.added',output_index:0,item:{type:'message',id:'m',role:'assistant',content:[]}});
 send({type:'response.content_part.added',output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
 for(let i=0;i<8;i++){send({type:'response.output_text.delta',output_index:0,content_index:0,delta:'x'});log('delta');await sleep(180);}
 send({type:'response.output_text.delta',output_index:0,content_index:0,delta:'TRANSPORT_CLOCK_COMPLETE'});
 send({type:'response.completed',response:{id:'fixture',status:'completed',output:[],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});log('completed');
}));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const token=`dummy.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'dummy'}})).toString('base64url')}.dummy`;
const outcomes=[];
try{
 await corePatch('apply',privatePi);
 const bootstrap=join(privatePi,'clock-bootstrap.mjs');await writeFile(bootstrap,"import WebSocket from './node_modules/ws/wrapper.mjs';globalThis.WebSocket=WebSocket;await import('./dist/cli.js');");
 for(const mode of ['regular','fullscreen']){
  const d=join(root,mode);await mkdir(join(d,'home/agent'),{recursive:true});
  await writeFile(join(d,'home/agent/models.json'),JSON.stringify({providers:{'codex-clock':{baseUrl:`http://127.0.0.1:${server.address().port}`,api:'openai-codex-responses',apiKey:token,models:[{id:'scripted'}]}}}));
  const start=progress.length;
  await new Promise((resolve,reject)=>{const p=spawn('python3',[new URL('./transport-clocks.py',import.meta.url).pathname,'--artifact-root',d,'--bootstrap',bootstrap,'--mode',mode]);let output='';p.stdout.on('data',x=>output+=x);p.stderr.on('data',x=>output+=x);p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error(output)));});
  const events=progress.slice(start);if(events.filter(x=>x.event==='delta').length!==8||!events.some(x=>x.event==='completed'))throw Error('Independent backend completion/progress missing');
  await writeFile(join(d,'backend.json'),JSON.stringify(events,null,2));outcomes.push({mode,status:'passed'});
 }
}catch(error){
 outcomes.push({status:'failed',error:String(error)});throw error;
}finally{
 await writeFile(join(root,'outcomes.json'),JSON.stringify(outcomes,null,2));await corePatch('rollback',privatePi);ws.close();server.close();
}
