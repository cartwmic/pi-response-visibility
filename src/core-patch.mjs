import { readFile, writeFile, realpath, lstat, unlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
export const CONTRACT = 'pi.response-visibility.telemetry.v1';
export const BRIDGE = Symbol.for(CONTRACT);
export const SANITIZER = 'pi.response-visibility.sanitizer.v1';
const marker = '/* pi-response-visibility:v1 */';
const runtime = 'dist/core/model-runtime.js';
const runner = 'dist/core/extensions/runner.js';
const sdk = 'dist/core/sdk.js';
const bridgePath = 'dist/core/response-visibility-bridge.mjs';
// pi-ai files: resolved against nested (npm global) or hoisted sibling (managed install) pi-ai.
const http = 'pi-ai:dist/api/openai-completions.js';
const codex = 'pi-ai:dist/api/openai-codex-responses.js';
// The `pi` CLI runs dist/bundle/chunks/*. Each chunk is located by a needle that survives patching.
const bundleCodex = 'bundle:async function*parseWebSocket(socket,signal,idleTimeoutMs';
const bundleHttp = 'bundle:for await(let chunk of openaiStream)';
const bundleMain = 'bundle:async prepareRequest(model,options){';
const m = marker;
const telemetry = `globalThis[Symbol.for("${CONTRACT}")]`;
// Minified equivalents of the SDK specs, for Pi builds that ship a bundle.
const bundleSpecs = [
  [bundleCodex, 'let reader=response.body.getReader(),decoder=new TextDecoder,buffer="",onAbort=()=>{reader.cancel().catch(()=>{})};', `let reader=response.body.getReader(),decoder=new TextDecoder,buffer="",onAbort=()=>{reader.cancel().catch(()=>{})};visibilityCodex?.emit({stage:"registration",transport:"sse"});${m}`],
  [bundleCodex, 'async function*mapCodexEvents(events,output,model,onProviderStreamEvent){', `async function*mapCodexEvents(events,output,model,onProviderStreamEvent,visibilityCodex){${m}`],
  [bundleCodex, 'for await(let event of events){try{', `for await(let event of events){visibilityCodex?.event(event);${m}try{`],
  [bundleCodex, 'mapCodexEvents(parseSSE(response,options?.signal),output,model,options?.onProviderStreamEvent)', `mapCodexEvents(parseSSE(response,options?.signal,visibilityCodex),output,model,options?.onProviderStreamEvent,visibilityCodex)${m}`],
  [bundleCodex, 'mapCodexEvents(parseWebSocket(socket,options?.signal,idleTimeoutMs),output,model,options?.onProviderStreamEvent)', `mapCodexEvents(parseWebSocket(socket,options?.signal,idleTimeoutMs,visibilityCodex),output,model,options?.onProviderStreamEvent,visibilityCodex)${m}`],
  [bundleCodex, 'try{let apiKey=options?.apiKey;', `let visibilityCodex=${telemetry}?.codex?.(options,model);${m}try{let apiKey=options?.apiKey;`],
  [bundleCodex, '()=>{websocketStarted=!0,', `()=>{visibilityCodex?.emit({stage:"first-event",transport:"websocket"}),${m}websocketStarted=!0,`],
  [bundleCodex, 'accountId,grammarToolInputProperties,options),', `accountId,grammarToolInputProperties,options,visibilityCodex),${m}`],
  [bundleCodex, 'throw error;recordWebSocketSseFallback(cacheSessionId);break', `throw error;visibilityCodex?.emit({stage:"fallback",transport:"sse"});${m}recordWebSocketSseFallback(cacheSessionId);break`],
  [bundleCodex, 'response=await(options?.fetch??globalThis.fetch)', `response=await(visibilityCodex?.fetch??options?.fetch??globalThis.fetch)${m}`],
  [bundleCodex, 'await processStream(response,output,stream2,model,grammarToolInputProperties,options)', `await processStream(response,output,stream2,model,grammarToolInputProperties,options,visibilityCodex)${m}`],
  [bundleCodex, 'stream2.end()}})(),stream2}', `stream2.end()}finally{visibilityCodex?.dispose()}${m}})(),stream2}`],
  [bundleCodex, 'async function processStream(response,output,stream2,model,grammarToolInputProperties,options){', `async function processStream(response,output,stream2,model,grammarToolInputProperties,options,visibilityCodex){${m}`],
  [bundleCodex, 'async function*parseSSE(response,signal){', `async function*parseSSE(response,signal,visibilityCodex){${m}`],
  [bundleCodex, 'let{done,value}=await reader.read();', `let{done,value}=await reader.read();visibilityCodex?.emit({stage:done?"close":"activity",transport:"sse",responseBytes:value?.byteLength??0});${m}`],
  [bundleCodex, 'async function*parseWebSocket(socket,signal,idleTimeoutMs){', `async function*parseWebSocket(socket,signal,idleTimeoutMs,visibilityCodex){${m}`],
  [bundleCodex, '(text=await decodeWebSocketData(event.data),!text)', `(visibilityCodex?.bytes(event.data),text=await decodeWebSocketData(event.data),!text)${m}`],
  [bundleCodex, 'onClose=event=>{if(sawCompletion){', `onClose=event=>{visibilityCodex?.emit({stage:"close",transport:"websocket",closeCode:typeof event.code=="number"?event.code:null});${m}if(sawCompletion){`],
  [bundleCodex, 'socket.addEventListener("message",onMessage),', `socket.addEventListener("message",onMessage),visibilityCodex?.emit({stage:"registration",transport:"websocket"}),${m}`],
  [bundleCodex, 'grammarToolInputProperties,options){let{socket,entry,reused,release}=await acquireWebSocket(', `grammarToolInputProperties,options,visibilityCodex){let visibilityConnectionStart=performance.now();visibilityCodex?.phase("connecting");${m}let{socket,entry,reused,release}=await acquireWebSocket(`],
  [bundleCodex, 'keepConnection=!0,', `keepConnection=(visibilityCodex?.emit({stage:"connection",transport:"websocket",reused,durationMs:performance.now()-visibilityConnectionStart}),!0),${m}`],
  [bundleCodex, 'socket.send(JSON.stringify({type:"response.create",...requestBody}))', `(()=>{let visibilityFrame=JSON.stringify({type:"response.create",...requestBody});socket.send(visibilityFrame),visibilityCodex?.emit({stage:"dispatch",transport:"websocket",requestBytes:new TextEncoder().encode(visibilityFrame).byteLength})})()${m}`],
  [bundleCodex, 'validateRetryDelayMs(retryAfterDelayMs,options);await sleep(delayMs,options?.signal);', `validateRetryDelayMs(retryAfterDelayMs,options);let visibilityBackoffStart=performance.now();visibilityCodex?.emit({stage:"backoff",delayMs});await sleep(delayMs,options?.signal);visibilityCodex?.emit({stage:"backoff",delayMs,durationMs:performance.now()-visibilityBackoffStart});${m}`],
  [bundleCodex, 'let delayMs=BASE_DELAY_MS*2**attempt;await sleep(delayMs,options?.signal);', `let delayMs=BASE_DELAY_MS*2**attempt,visibilityBackoffStart=performance.now();visibilityCodex?.emit({stage:"backoff",delayMs});await sleep(delayMs,options?.signal);visibilityCodex?.emit({stage:"backoff",delayMs,durationMs:performance.now()-visibilityBackoffStart});${m}`],
  [bundleCodex, 'if(websocketDisabledForSession&&recordWebSocketSseFallback(cacheSessionId),', `if(websocketDisabledForSession&&(visibilityCodex?.emit({stage:"fallback",transport:"sse"}),recordWebSocketSseFallback(cacheSessionId)),${m}`],
  [bundleHttp, 'timestamp:Date.now()},streamedReasoningDetails,applyStreamedReasoningDetails=', `timestamp:Date.now()},visibilityHTTP=${telemetry}?.http?.(options,model),${m}streamedReasoningDetails,applyStreamedReasoningDetails=`],
  [bundleHttp, 'options?.headers,options?.fetch,cacheSessionId,compat)', `options?.headers,visibilityHTTP?.fetch??options?.fetch,cacheSessionId,compat)${m}`],
  [bundleHttp, 'for await(let chunk of openaiStream){', `for await(let chunk of openaiStream){visibilityHTTP?.event(chunk);${m}`],
  [bundleHttp, 'stream2.end()}})(),stream2}', `stream2.end()}finally{visibilityHTTP?.dispose()}${m}})(),stream2}`],
  [bundleMain, 'modelRuntime.streamSimple(model2,context,requestOptions)}', `modelRuntime.streamSimple(model2,context,visibilityForeground({...requestOptions}))${m}}`],
  [bundleMain, 'async prepareRequest(model,options){let provider=', `async prepareRequest(model,options){let visibility=visibilityBegin(options),visibilityEnd=visibility.span("prepare");${m}try{let provider=`],
  [bundleMain, 'let resolution=await this.getAuth(model,{apiKey:options?.apiKey,env:options?.env,signal:options?.signal});', `let visibilityAuthEnd=visibility.span("auth"),resolution;${m}try{resolution=await this.getAuth(model,{apiKey:options?.apiKey,env:options?.env,signal:options?.signal})}finally{visibilityAuthEnd()}visibility.credentials(resolution),visibility.credentials(options?.apiKey),visibility.credentials(options?.headers),visibility.credentials(options?.env);`],
  [bundleMain, ',requestModel=resolution.auth.baseUrl?{...model,baseUrl:resolution.auth.baseUrl}:model;return{provider,model:requestModel,options:{...providerOptions,apiKey:providerOptions.apiKey??resolution.auth.apiKey,headers,env}}}stream(model,context,options){', `,requestModel=(visibility.credentials(headers),visibility.credentials(env),resolution.auth.baseUrl?{...model,baseUrl:resolution.auth.baseUrl}:model),visibilityPrepared={provider,model:requestModel,options:{...providerOptions,apiKey:providerOptions.apiKey??resolution.auth.apiKey,headers,env}};return visibility.handoff(visibilityPrepared.options,requestModel),visibilityPrepared}finally{visibilityEnd(),visibility.dispose()}${m}}stream(model,context,options){`],
  [bundleMain, 'async emitBeforeAgentStart(prompt,images,systemPromptOptions){', `async emitBeforeAgentStart(prompt,images,systemPromptOptions){let visibility=visibilityBegin(),visibilityEnd=visibility.span("hook");${m}try{`],
  [bundleMain, 'return{messages,systemPromptOptions:currentOptions}}async emitResourcesDiscover(', `return{messages,systemPromptOptions:currentOptions}}finally{visibilityEnd(),visibility.dispose()}${m}}async emitResourcesDiscover(`],
];
const specs = [
  [codex, "    const reader = response.body.getReader();", "    const reader = response.body.getReader();\n    visibilityCodex?.emit({ stage: \"registration\", transport: \"sse\" }); /* pi-response-visibility:v1 */"],
  [codex, "async function* mapCodexEvents(events, output, model, onProviderStreamEvent) {", "async function* mapCodexEvents(events, output, model, onProviderStreamEvent, visibilityCodex) { /* pi-response-visibility:v1 */"],
  [codex, "    for await (const event of events) {\n        try {", "    for await (const event of events) {\n        visibilityCodex?.event(event);\n        try { /* pi-response-visibility:v1 */"],
  [codex, "mapCodexEvents(parseSSE(response, options?.signal), output, model, options?.onProviderStreamEvent)", "mapCodexEvents(parseSSE(response, options?.signal, visibilityCodex), output, model, options?.onProviderStreamEvent, visibilityCodex) /* pi-response-visibility:v1 */"],
  [codex, "mapCodexEvents(parseWebSocket(socket, options?.signal, idleTimeoutMs), output, model, options?.onProviderStreamEvent)", "mapCodexEvents(parseWebSocket(socket, options?.signal, idleTimeoutMs, visibilityCodex), output, model, options?.onProviderStreamEvent, visibilityCodex) /* pi-response-visibility:v1 */"],
  [codex, "        try {\n            const apiKey = options?.apiKey;", "        const visibilityCodex = globalThis[Symbol.for(\"pi.response-visibility.telemetry.v1\")]?.codex?.(options, model);\n        try {\n            const apiKey = options?.apiKey; /* pi-response-visibility:v1 */"],
  [codex, "                            websocketStarted = true;", "                            visibilityCodex?.emit({ stage: \"first-event\", transport: \"websocket\" });\n                            websocketStarted = true; /* pi-response-visibility:v1 */"],
  [codex, "accountId, grammarToolInputProperties, options);", "accountId, grammarToolInputProperties, options, visibilityCodex); /* pi-response-visibility:v1 */"],
  [codex, "                        recordWebSocketSseFallback(cacheSessionId);", "                        visibilityCodex?.emit({ stage: \"fallback\", transport: \"sse\" });\n                        recordWebSocketSseFallback(cacheSessionId); /* pi-response-visibility:v1 */"],
  [codex, "response = await (options?.fetch ?? globalThis.fetch)", "response = await (visibilityCodex?.fetch ?? options?.fetch ?? globalThis.fetch) /* pi-response-visibility:v1 */"],
  [codex, "await processStream(response, output, stream, model, grammarToolInputProperties, options);", "await processStream(response, output, stream, model, grammarToolInputProperties, options, visibilityCodex); /* pi-response-visibility:v1 */"],
  [codex, "            stream.end();\n        }\n    })();", "            stream.end();\n        } finally { visibilityCodex?.dispose(); }\n    })(); /* pi-response-visibility:v1 */"],
  [codex, "async function processStream(response, output, stream, model, grammarToolInputProperties, options) {", "async function processStream(response, output, stream, model, grammarToolInputProperties, options, visibilityCodex) { /* pi-response-visibility:v1 */"],
  [codex, "async function* parseSSE(response, signal) {", "async function* parseSSE(response, signal, visibilityCodex) { /* pi-response-visibility:v1 */"],
  [codex, "            const { done, value } = await reader.read();", "            const { done, value } = await reader.read();\n            visibilityCodex?.emit({ stage: done ? \"close\" : \"activity\", transport: \"sse\", responseBytes: value?.byteLength ?? 0 }); /* pi-response-visibility:v1 */"],
  [codex, "async function* parseWebSocket(socket, signal, idleTimeoutMs) {", "async function* parseWebSocket(socket, signal, idleTimeoutMs, visibilityCodex) { /* pi-response-visibility:v1 */"],
  [codex, "                text = await decodeWebSocketData(event.data);", "                visibilityCodex?.bytes(event.data);\n                text = await decodeWebSocketData(event.data); /* pi-response-visibility:v1 */"],
  [codex, "        if (sawCompletion) {", "        visibilityCodex?.emit({ stage: \"close\", transport: \"websocket\", closeCode: typeof event.code === \"number\" ? event.code : null });\n        if (sawCompletion) { /* pi-response-visibility:v1 */"],
  [codex, "    socket.addEventListener(\"message\", onMessage);", "    socket.addEventListener(\"message\", onMessage);\n    visibilityCodex?.emit({ stage: \"registration\", transport: \"websocket\" }); /* pi-response-visibility:v1 */"],
  [codex, "grammarToolInputProperties, options) {\n    const { socket, entry, reused, release }", "grammarToolInputProperties, options, visibilityCodex) {\n    const visibilityConnectionStart = performance.now();\n    visibilityCodex?.phase(\"connecting\");\n    const { socket, entry, reused, release } /* pi-response-visibility:v1 */"],
  [codex, "    let keepConnection = true;", "    visibilityCodex?.emit({ stage: \"connection\", transport: \"websocket\", reused, durationMs: performance.now() - visibilityConnectionStart });\n    let keepConnection = true; /* pi-response-visibility:v1 */"],
  [codex, "        socket.send(JSON.stringify({ type: \"response.create\", ...requestBody }));", "        const visibilityFrame = JSON.stringify({ type: \"response.create\", ...requestBody });\n        socket.send(visibilityFrame);\n        visibilityCodex?.emit({ stage: \"dispatch\", transport: \"websocket\", requestBytes: new TextEncoder().encode(visibilityFrame).byteLength }); /* pi-response-visibility:v1 */"],
  [codex, "validateRetryDelayMs(retryAfterDelayMs, options);\n                        await sleep(delayMs, options?.signal);", "validateRetryDelayMs(retryAfterDelayMs, options);\n                        const visibilityBackoffStart = performance.now();\n                        visibilityCodex?.emit({ stage: \"backoff\", delayMs });\n                        await sleep(delayMs, options?.signal);\n                        visibilityCodex?.emit({ stage: \"backoff\", delayMs, durationMs: performance.now() - visibilityBackoffStart }); /* pi-response-visibility:v1 */"],
  [codex, "const delayMs = BASE_DELAY_MS * 2 ** attempt;\n                        await sleep(delayMs, options?.signal);", "const delayMs = BASE_DELAY_MS * 2 ** attempt;\n                        const visibilityBackoffStart = performance.now();\n                        visibilityCodex?.emit({ stage: \"backoff\", delayMs });\n                        await sleep(delayMs, options?.signal);\n                        visibilityCodex?.emit({ stage: \"backoff\", delayMs, durationMs: performance.now() - visibilityBackoffStart }); /* pi-response-visibility:v1 */"],
  [codex, "if (websocketDisabledForSession) {\n                recordWebSocketSseFallback(cacheSessionId);", "if (websocketDisabledForSession) {\n                visibilityCodex?.emit({ stage: \"fallback\", transport: \"sse\" });\n                recordWebSocketSseFallback(cacheSessionId); /* pi-response-visibility:v1 */"],
  [http, '        let streamedReasoningDetails;', `        const visibilityHTTP = globalThis[Symbol.for("${CONTRACT}")]?.http?.(options, model); ${marker}\n        let streamedReasoningDetails;`],
  [http, 'options?.headers, options?.fetch, cacheSessionId, compat);', `options?.headers, visibilityHTTP?.fetch ?? options?.fetch, cacheSessionId, compat); ${marker}`],
  [http, '            for await (const chunk of openaiStream) {', `            for await (const chunk of openaiStream) {\n                visibilityHTTP?.event(chunk); ${marker}`],
  [http, '            stream.end();\n        }\n    })();', `            stream.end();\n        } finally { visibilityHTTP?.dispose(); } ${marker}\n    })();`],
  [sdk, '            return modelRuntime.streamSimple(model, context, requestOptions);', `            return modelRuntime.streamSimple(model, context, visibilityForeground({ ...requestOptions })); ${marker}`],
  [runtime, 'import { dirname, join } from "node:path";', `import { begin as visibilityBegin } from "./response-visibility-bridge.mjs"; ${marker}\nimport { dirname, join } from "node:path";`],
  [runtime, '    async prepareRequest(model, options) {', `    async prepareRequest(model, options) {\n        const visibility = visibilityBegin(options); ${marker}\n        const visibilityEnd = visibility.span("prepare");\n        try {`],
  [runtime, '        const resolution = await this.getAuth(model, {\n            apiKey: options?.apiKey,\n            env: options?.env,\n            signal: options?.signal,\n        });', `        const visibilityAuthEnd = visibility.span("auth"); ${marker}\n        let resolution;\n        try {\n            resolution = await this.getAuth(model, {\n                apiKey: options?.apiKey,\n                env: options?.env,\n                signal: options?.signal,\n            });\n        } finally { visibilityAuthEnd(); }\n        visibility.credentials(resolution);\n        visibility.credentials(options?.apiKey);\n        visibility.credentials(options?.headers);\n        visibility.credentials(options?.env);`],
  [runtime, '        const requestModel = resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model;', `        visibility.credentials(headers); ${marker}\n        visibility.credentials(env);\n        const requestModel = resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model;`],
  [runtime, `        return {
            provider,
            model: requestModel,
            options: {
                ...providerOptions,
                apiKey: providerOptions.apiKey ?? resolution.auth.apiKey,
                headers,
                env,
            },
        };`, `        const visibilityPrepared = {
            provider,
            model: requestModel,
            options: {
                ...providerOptions,
                apiKey: providerOptions.apiKey ?? resolution.auth.apiKey,
                headers,
                env,
            },
        };
        visibility.handoff(visibilityPrepared.options, requestModel);
        return visibilityPrepared; ${marker}`],
  [runtime, '    }\n    stream(model, context, options) {', `        } finally { visibilityEnd(); visibility.dispose(); } ${marker}\n    }\n    stream(model, context, options) {`],
  [runner, '    async emitBeforeAgentStart(prompt, images, systemPromptOptions) {', `    async emitBeforeAgentStart(prompt, images, systemPromptOptions) {\n        const visibility = visibilityBegin(); ${marker}\n        const visibilityEnd = visibility.span("hook");\n        try {`],
  [runner, '        return { messages, systemPromptOptions: currentOptions };\n    }', `        return { messages, systemPromptOptions: currentOptions };\n        } finally { visibilityEnd(); visibility.dispose(); } ${marker}\n    }`],
];
// Runner imports vary with sibling patches: prepend a separately owned exact block.
const sdkImport = `import { foreground as visibilityForeground } from "./response-visibility-bridge.mjs"; ${marker}\n`;
const runnerImport = `import { begin as visibilityBegin } from "../response-visibility-bridge.mjs"; ${marker}\n`;
const bundleImport = `import{begin as visibilityBegin,foreground as visibilityForeground}from"../../core/response-visibility-bridge.mjs";${marker}\n`;
const count = (text, needle) => text.split(needle).length - 1;
function piAiDir(root) {
  for (const dir of [join(root, 'node_modules/@earendil-works/pi-ai'), join(root, '../pi-ai')]) if (existsSync(join(dir, 'package.json'))) return dir;
  throw new Error('pi-ai package not found next to Pi');
}
// Map each logical target key to its file. Bundle chunks are optional (older Pi builds have none).
async function resolveTargets(root) {
  const files = new Map([[runtime, join(root, runtime)], [runner, join(root, runner)], [sdk, join(root, sdk)]]);
  const ai = piAiDir(root);
  for (const key of [http, codex]) files.set(key, join(ai, key.slice('pi-ai:'.length)));
  const chunks = join(root, 'dist/bundle/chunks');
  if (!existsSync(chunks)) return { files, bundle: false };
  const names = (await readdir(chunks)).filter(name => name.endsWith('.js'));
  const texts = await Promise.all(names.map(name => readFile(join(chunks, name), 'utf8')));
  for (const key of [bundleCodex, bundleHttp, bundleMain]) {
    const hits = names.filter((_, i) => texts[i].includes(key.slice('bundle:'.length)));
    if (hits.length !== 1) throw new Error(`Expected one bundle chunk for ${key}, found ${hits.length}`);
    files.set(key, join(chunks, hits[0]));
  }
  return { files, bundle: true };
}
export async function resolvePiRoot(root) {
  if (root !== undefined) {
    if (!isAbsolute(root)) throw new Error('--pi-root must be absolute');
    return realpath(root);
  }
  const require = createRequire(import.meta.url);
  return realpath(join(require.resolve('@earendil-works/pi-coding-agent/package.json'), '..'));
}
export async function corePatch(action, suppliedRoot) {
  if (!['check', 'apply', 'rollback'].includes(action)) throw new Error('Expected check, apply or rollback');
  const root = await resolvePiRoot(suppliedRoot);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  // Any Pi version is accepted; the unique-anchor checks below are the compatibility gate.
  if (pkg.name !== '@earendil-works/pi-coding-agent') throw new Error('Unsupported Pi install (expected @earendil-works/pi-coding-agent)');
  const { files, bundle } = await resolveTargets(root);
  const allSpecs = bundle ? [...specs, ...bundleSpecs] : specs;
  const sources = new Map();
  for (const [key, file] of files) {
    if (!(await lstat(file)).isFile()) throw new Error('Patch targets must be regular files');
    sources.set(key, await readFile(file, 'utf8'));
  }
  const states = allSpecs.map(([path, before, after]) => {
    const text = sources.get(path);
    const patched = count(text, after);
    if (patched === 1) return 'applied';
    if (patched !== 0 || count(text, before) !== 1) throw new Error(`Unsupported or ambiguous anchor in ${path}: ${before.slice(0, 80)}`);
    return 'stock';
  });
  if (new Set(states).size !== 1) throw new Error('Partial patch rejected');
  const state = states[0];
  const runnerText = sources.get(runner);
  if (count(runnerText, runnerImport) !== (state === 'applied' ? 1 : 0)) throw new Error('Runner import mismatch');
  if (count(sources.get(sdk), sdkImport) !== (state === 'applied' ? 1 : 0)) throw new Error('SDK import mismatch');
  if (bundle && count(sources.get(bundleMain), bundleImport) !== (state === 'applied' ? 1 : 0)) throw new Error('Bundle import mismatch');
  const bridgeSource = await readFile(new URL('./core-bridge.mjs', import.meta.url), 'utf8');
  let installed;
  try { installed = await readFile(join(root, bridgePath), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (installed !== undefined && installed !== bridgeSource) throw new Error('Bridge collision or modified bridge');
  if (state === 'applied' && installed === undefined) throw new Error('Missing bridge');
  if (state === 'stock' && installed !== undefined) throw new Error('Orphan bridge rejected');
  if (action === 'check' || (action === 'apply' && state === 'applied') || (action === 'rollback' && state === 'stock')) return { root, state, version: 1 };
  const applying = action === 'apply';
  // Function replacers: anchors contain `$` sequences that String.replace would otherwise expand.
  for (const [path, before, after] of allSpecs) sources.set(path, sources.get(path).replace(applying ? before : after, () => (applying ? after : before)));
  sources.set(runner, applying ? runnerImport + sources.get(runner) : sources.get(runner).replace(runnerImport, ''));
  sources.set(sdk, applying ? sdkImport + sources.get(sdk) : sources.get(sdk).replace(sdkImport, ''));
  if (bundle) sources.set(bundleMain, applying ? bundleImport + sources.get(bundleMain) : sources.get(bundleMain).replace(bundleImport, ''));
  if (applying) await writeFile(join(root, bridgePath), bridgeSource, { flag: 'wx', mode: 0o600 });
  for (const [key, text] of sources) await writeFile(files.get(key), text);
  if (!applying) await unlink(join(root, bridgePath));
  return { root, state: applying ? 'applied' : 'stock', version: 1 };
}
