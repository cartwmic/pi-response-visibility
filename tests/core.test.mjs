import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { begin, bridge, foreground } from '../src/core-bridge.mjs';
const cli = new URL('../bin/core.mjs', import.meta.url).pathname;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'visibility-core-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const install = dirname(dirname(dirname(await realpath(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()))));
  for (const path of ['package.json', 'dist/core/model-runtime.js', 'dist/core/extensions/runner.js', 'dist/core/sdk.js', 'node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js', 'node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js']) await cp(join(install, path), join(root, path), { recursive: true });
  return root;
}
const run = (root, action) => JSON.parse(execFileSync(process.execPath, [cli, action, '--pi-root', root], { encoding: 'utf8' }));
test('explicit CLI private-copy cycle, idempotence and sibling preservation', async t => {
  const root = await fixture(t);
  const path = join(root, 'dist/core/model-runtime.js');
  const original = await readFile(path, 'utf8');
  assert.equal(run(root, 'check').state, 'stock');
  assert.equal(run(root, 'apply').state, 'applied');
  const patched = await readFile(path, 'utf8');
  run(root, 'apply'); assert.equal(await readFile(path, 'utf8'), patched);
  assert.equal(run(root, 'check').state, 'applied');
  await writeFile(path, patched + '\n// sibling patch\n');
  run(root, 'rollback'); run(root, 'rollback');
  assert.equal(run(root, 'check').state, 'stock');
  assert.equal(await readFile(path, 'utf8'), original + '\n// sibling patch\n');
});
test('unsupported versions and ambiguous anchors fail before any writes', async t => {
  const root = await fixture(t);
  const path = join(root, 'dist/core/model-runtime.js');
  const original = await readFile(path, 'utf8');
  const pkgPath = join(root, 'package.json');
  const pkg = await readFile(pkgPath, 'utf8');
  await writeFile(pkgPath, pkg.replace('0.99.2', '0.99.3'));
  assert.throws(() => run(root, 'apply'));
  assert.equal(await readFile(path, 'utf8'), original);
  await writeFile(pkgPath, pkg);
  await writeFile(path, original + '\n    async prepareRequest(model, options) {\n');
  const ambiguous = await readFile(path, 'utf8');
  assert.throws(() => run(root, 'apply'));
  assert.equal(await readFile(path, 'utf8'), ambiguous);
});
test('generic unknown sanitizer rejects snapshots and observers cannot alter spans', () => {
  const observations = [];
  const stop = bridge.subscribe(e => observations.push(e));
  const bad = bridge.subscribe(() => { throw new Error('observer'); });
  const request = begin();
  request.credentials({ apiKey: 'CREDENTIAL_MARKER', headers: { Authorization: 'Bearer CREDENTIAL_MARKER' } });
  assert.throws(() => request.sanitize({ error: 'CREDENTIAL_MARKER' }), /unavailable/);
  const end = request.span('prepare'); end(); end(); request.dispose(); stop(); bad();
  assert.equal(observations.length, 1);
  assert.equal(observations[0].origin, 'unknown');
  assert.ok(!JSON.stringify(observations).includes('CREDENTIAL_MARKER'));
  assert.equal(request.capabilities.rawCapture, true);
});
test('caller identity associates only foreground options, not overlapping background or hook work', () => {
  const observations = [];
  const stop = bridge.subscribe(e => observations.push(e));
  const options = foreground({ signal: new AbortController().signal });
  const foregroundRequest = begin(options);
  const backgroundRequest = begin({ ...options });
  const hook = begin();
  backgroundRequest.span('prepare')();
  foregroundRequest.span('auth')();
  hook.span('hook')();
  foregroundRequest.span('prepare')();
  stop();
  assert.deepEqual(observations.map(e => e.origin), ['unknown', 'foreground', 'unknown', 'foreground']);
  assert.equal(observations[1].requestId, observations[3].requestId);
  assert.notEqual(observations[0].requestId, observations[1].requestId);
  assert.notEqual(observations[2].requestId, observations[1].requestId);
});
test('SDK callback spans preserve receiver, arguments, resolved result and error identity without snapshots', async () => {
  const events = [];
  const stop = bridge.subscribe(event => events.push(event));
  const payload = { marker: 'CREDENTIAL_MARKER' };
  const failure = new Error('CREDENTIAL_MARKER');
  const receiver = {};
  const options = foreground({
    async onPayload(value) { assert.equal(this, receiver); assert.equal(value, payload); return value; },
    async onResponse(value) { assert.equal(value, payload); throw failure; },
  });
  assert.equal(await options.onPayload.call(receiver, payload), payload);
  await assert.rejects(options.onResponse(payload), error => error === failure);
  stop();
  assert.equal(events.length, 2);
  assert.equal(events[0].requestId, events[1].requestId);
  assert.ok(events.every(event => event.origin === 'foreground' && event.data.phase === 'sdk'));
  assert.ok(!JSON.stringify(events).includes('CREDENTIAL_MARKER'));
});
test('paired scripted completion preserves request options, abort and errors', async t => {
  const root = await fixture(t);
  const path = join(root, 'dist/core/model-runtime.js');
  const stock = await readFile(path, 'utf8');
  run(root, 'apply');
  const patched = await readFile(path, 'utf8');
  async function exercise(source) {
    const start = source.indexOf('    async prepareRequest(model, options) {');
    const end = source.indexOf('    complete(model, context, options) {', start);
    const method = source.slice(start, end);
    const module = `import { begin as visibilityBegin } from ${JSON.stringify(pathToFileURL(join(root, 'dist/core/response-visibility-bridge.mjs')).href)};\nconst mergeHeaders=(a,b)=>({...a,...b}); const normalizeContext=x=>x; const assertChatModel=()=>{}; const lazyStream=(m,f)=>({result:async()=>{const s=await f();return s.result();}}); const ModelsError=Error; export class Runtime { ${method} }`;
    const { Runtime } = await import('data:text/javascript;base64,' + Buffer.from(module).toString('base64'));
    const runtime = new Runtime();
    const controller = new AbortController();
    const marker = 'CREDENTIAL_MARKER'; const body = { messages: ['hello'] };
    let received;
    const outcome = { completed: true };
    runtime.models = { getProvider: () => ({ stream(model, context, options) { received = { model, context, options }; return { result: async () => { options.signal.throwIfAborted(); return outcome; } }; } }) };
    runtime.getAuth = async () => ({ auth: { apiKey: marker, headers: { Authorization: marker } }, env: { TOKEN: marker } });
    const options = { signal: controller.signal, custom: body, transformHeaders: async h => ({ ...h, extra: 'x' }) };
    const model = { provider: 'scripted' };
    assert.equal(await runtime.stream(model, body, options).result(), outcome);
    assert.equal(received.options.signal, controller.signal);
    assert.equal(received.options.custom, body);
    assert.equal(received.context, body);
    const bytes = JSON.stringify({ model: received.model, context: received.context, options: { ...received.options, signal: undefined } });
    controller.abort(new Error('scripted abort'));
    await assert.rejects(runtime.stream(model, body, options).result(), e => e === controller.signal.reason);
    const failure = new Error(marker); runtime.getAuth = async () => { throw failure; };
    await assert.rejects(runtime.stream(model, body, options).result(), e => e === failure);
    return bytes;
  }
  assert.equal(await exercise(stock), await exercise(patched));
});
