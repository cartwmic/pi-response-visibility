import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { corePatch } from '../src/core-patch.mjs';
const install=process.env.PI_TEST_ROOT ?? '/Users/cartwmic/.local/share/mise/installs/node/24.18.1/lib/node_modules/@earendil-works/pi-coding-agent';
const artifacts=process.env.CODEX_ARTIFACT_ROOT;
test('private Pi native Codex SSE, WS and failure fallback preserve paired captures', { skip: !artifacts }, async () => {
  assert.ok(artifacts,'CODEX_ARTIFACT_ROOT required (evidence is retained)');
  await mkdir(artifacts,{recursive:true});
  const root=await mkdtemp(join(artifacts,'private-pi-'));
  await cp(install,root,{recursive:true});
  const require=createRequire(join(root,'package.json'));
  const { WebSocket, WebSocketServer }=require('ws');
  const saved=globalThis.WebSocket; globalThis.WebSocket=WebSocket;
  const records=[]; let mode='sse';
  const events=[{type:'response.created',response:{id:'fixture',status:'in_progress',output:[]}},
    {type:'response.output_item.added',output_index:0,item:{type:'message',id:'m',role:'assistant',content:[]}},
    {type:'response.content_part.added',output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},
    {type:'response.output_text.delta',output_index:0,content_index:0,delta:'CODEX_PROOF_COMPLETE'},
    {type:'response.completed',response:{id:'fixture',status:'completed',output:[],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req) chunks.push(chunk);
    records.push({transport:'sse',body:Buffer.concat(chunks).toString('base64'),headers:req.headers});
    if(mode==='sse-retry' && records.filter(x=>x.transport==='sse').length===1){res.writeHead(503,{'retry-after':'0'});res.end('{"error":{"message":"scripted retry"}}');return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);res.end();
  });
  const ws=new WebSocketServer({noServer:true});
  server.on('upgrade',(req,socket,head)=>{
    records.push({transport:'upgrade',headers:req.headers});
    if(mode==='fallback'){socket.write('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n');socket.destroy();return;}
    ws.handleUpgrade(req,socket,head,s=>ws.emit('connection',s));
  });
  ws.on('connection',socket=>socket.on('message',data=>{
    records.push({transport:'websocket',body:JSON.parse(data.toString())});
    for(const event of events)socket.send(JSON.stringify(event));
  }));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const token=`dummy.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'dummy-account'}})).toString('base64url')}.dummy`;
  const outcomes=[], failures=[];
  try {
    {
      assert.equal((await corePatch('check',root)).state,'stock');
      // Each leg imports a fresh provider URL; native module caches stay leg-local.
      for(const enabled of [false,true]) {
        const codexPath=join(root,'node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js');
        const original=await readFile(codexPath,'utf8');
        if(enabled){await corePatch('apply',root);await writeFile(codexPath,(await readFile(codexPath,'utf8'))+'\n// same-version sibling fixture\n');await corePatch('check',root);}
        const provider=await import(pathToFileURL(join(root,'node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js')).href+`?enabled=${enabled}`);
        const bridge=enabled?await import(pathToFileURL(join(root,'dist/core/response-visibility-bridge.mjs')).href):null;
        for(mode of ['sse','sse-retry','websocket','fallback']) {
          records.length=0;const telemetry=[];const off=bridge?.bridge.subscribe(e=>telemetry.push(e));
          const model={id:'scripted',name:'scripted',api:'openai-codex-responses',provider:'openai-codex',baseUrl:`http://127.0.0.1:${server.address().port}`,reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
          let options={apiKey:token,transport:mode.startsWith('sse')?'sse':'auto',maxRetries:1,sessionId:`fixture-${mode}`,onPayload:x=>x};
          if(bridge)options=bridge.foreground(options);
          const response=await provider.stream(model,{messages:[{role:'user',content:'fixture prompt',timestamp:1}]},options).result();
          provider.closeOpenAICodexWebSocketSessions();
          off?.(); assert.equal(response.stopReason,'stop',JSON.stringify(response));
          assert.ok(response.content.some(x=>x.text==='CODEX_PROOF_COMPLETE'));
          if(enabled){
            assert.ok(telemetry.some(e=>e.data.providerPath==='openai-codex-responses'));
            assert.ok(telemetry.every(e=>e.origin==='foreground' && e.requestId===telemetry[0].requestId));
            assert.ok(!JSON.stringify(telemetry).includes(token));
            const measured=(stage,transport)=>telemetry.filter(e=>e.data.stage===stage && (!transport || e.data.transport===transport));
            const transport=mode==='websocket'?'websocket':'sse';
            assert.ok(measured('registration',transport).length,`${mode}: reader/listener registration`);
            assert.ok(measured('dispatch',transport).some(e=>e.data.requestBytes>0),`${mode}: sent payload bytes`);
            assert.ok(measured('activity',transport).some(e=>e.data.responseBytes>0),`${mode}: received payload bytes`);
            assert.ok(measured('content').length,`${mode}: content progress`);
            if(mode==='websocket')assert.ok(measured('connection','websocket').some(e=>typeof e.data.reused==='boolean' && e.data.durationMs>=0));
            else {
              assert.ok(measured('headers','sse').some(e=>e.data.status===200));
              // Native mapping returns at response.completed; reader EOF need not
              // be observed. Do not infer a transport close from model completion.
              assert.ok(measured('close','sse').every(e=>e.data.responseBytes===0));
            }
            if(mode==='fallback')assert.ok(measured('fallback','sse').length);
            if(mode==='sse-retry')assert.ok(measured('backoff').some(e=>typeof e.data.durationMs==='number'));
          }
          const capture=structuredClone(records);
          // These native random handshake identifiers are not diagnostics changes.
          for(const row of capture){if(row.headers){delete row.headers['sec-websocket-key'];delete row.headers['x-client-request-id'];}}
          outcomes.push({enabled,mode,response,capture,telemetry});
          if(!mode.startsWith('sse')) for(const tuiMode of ['regular','fullscreen']) {
            const home=join(artifacts,`home-${enabled}-${mode}-${tuiMode}`);await mkdir(join(home,'agent'),{recursive:true});
            await writeFile(join(home,'agent/models.json'),JSON.stringify({providers:{'codex-proof':{baseUrl:model.baseUrl,api:model.api,apiKey:token,models:[{id:'scripted'}]}}}));
            const bootstrap=join(root,'codex-bootstrap.mjs');
            await writeFile(bootstrap,`import WebSocket from './node_modules/ws/wrapper.mjs'; globalThis.WebSocket=WebSocket; await import('./dist/cli.js');`);
            records.length=0;
            const args=[new URL('./codex-tui.py',import.meta.url).pathname,'--home',home,'--bootstrap',bootstrap,'--artifact',join(artifacts,`screen-${enabled}-${mode}-${tuiMode}.ansi`),'--mode',tuiMode];
            if(enabled)args.push('--extension',new URL('../index.ts',import.meta.url).pathname);
            await new Promise((resolve,reject)=>{const child=spawn('python3',args);let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(output)));});
            const tuiCapture=structuredClone(records);
            for(const row of tuiCapture) {
              if(row.headers){delete row.headers['sec-websocket-key'];delete row.headers['x-client-request-id'];delete row.headers['session-id'];delete row.headers['content-length'];}
              if(row.body){
                if(row.transport==='sse') {let bytes=Buffer.from(row.body,'base64');if(row.headers['content-encoding']==='zstd')bytes=require('node:zlib').zstdDecompressSync(bytes);row.body=JSON.parse(bytes);}
                delete row.body.prompt_cache_key;
              }
            }
            outcomes.at(-1).tui={completed:true,inspector:enabled,transports:records.map(x=>x.transport),capture:tuiCapture};
            (outcomes.at(-1).tuiModes??={})[tuiMode]=outcomes.at(-1).tui;
            assert.ok(records.some(x=>x.transport===(mode==='fallback'?'sse':'websocket')));
          }
        }
        for(const kind of ['payload-error','response-error','event-error','abort']) {
          mode=kind==='event-error'?'websocket':'sse';records.length=0;
          const model={id:'scripted',api:'openai-codex-responses',provider:'openai-codex',baseUrl:`http://127.0.0.1:${server.address().port}`,reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
          let calls=0;const failure=new Error(`scripted-${kind}`);const callback=()=>{calls++;throw failure;};
          let options={apiKey:token,transport:mode==='sse'?'sse':'auto',maxRetries:0};
          if(kind==='payload-error')options.onPayload=callback;
          if(kind==='response-error')options.onResponse=callback;
          if(kind==='event-error')options.onProviderStreamEvent=callback;
          if(kind==='abort'){const controller=new AbortController();controller.abort();options.signal=controller.signal;}
          if(bridge)options=bridge.foreground(options);
          const response=await provider.stream(model,{messages:[{role:'user',content:'fixture prompt',timestamp:1}]},options).result();
          assert.equal(response.stopReason,kind==='abort'?'aborted':'error');
          if(kind!=='abort'){assert.equal(calls,1,`${kind}: ${response.errorMessage}`);assert.ok(response.errorMessage.includes(failure.message));}
          if(kind==='event-error')assert.ok(!records.some(x=>x.transport==='sse'),'callback failure must not trigger SSE fallback');
          failures.push({enabled,kind,stopReason:response.stopReason,errorMessage:response.errorMessage,calls,transports:records.map(x=>x.transport)});
          provider.closeOpenAICodexWebSocketSessions();
        }
        if(enabled){await corePatch('check',root);await corePatch('rollback',root);await corePatch('check',root);assert.equal(await readFile(codexPath,'utf8'),original+'\n// same-version sibling fixture\n');}
      }
    }
    for(const mode of ['sse','sse-retry','websocket','fallback']){
      const pair=outcomes.filter(x=>x.mode===mode);assert.deepEqual(pair[0].capture,pair[1].capture);
      assert.deepEqual(pair[0].response.content,pair[1].response.content);
      if(!mode.startsWith('sse'))for(const tuiMode of ['regular','fullscreen'])assert.deepEqual(pair[0].tuiModes[tuiMode].capture,pair[1].tuiModes[tuiMode].capture);
    }
    for(const kind of ['payload-error','response-error','event-error','abort']){const pair=failures.filter(x=>x.kind===kind);const {enabled:a,...left}=pair[0],{enabled:b,...right}=pair[1];assert.deepEqual(left,right);}
    // Retained evidence never contains the dummy resolved credential header/value.
    for(const row of outcomes)for(const capture of [...row.capture,...Object.values(row.tuiModes??{}).flatMap(x=>x.capture)])if(capture.headers){delete capture.headers.authorization;delete capture.headers['chatgpt-account-id'];}
    await writeFile(join(artifacts,'outcomes.json'),JSON.stringify({status:'passed',outcomes,failures},null,2));
  } finally {globalThis.WebSocket=saved;ws.close();await new Promise(resolve=>server.close(resolve));}
});
