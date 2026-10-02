import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestSanitizer, begin, foreground, bridge, observeHTTP } from '../src/core-bridge.mjs';
import { createTraceWriter } from '../src/trace.mjs';

test('opaque request capability scrubs before enqueue and revokes on terminal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'safe-capture-'));
  const core = createRequestSanitizer();
  const key = 'dummy-resolved-key-747';
  const header = 'dummy-header-929';
  core.credentials({ apiKey: key, oauth: { accessToken: 'dummy-oauth-484' }, env: { CREDENTIAL: 'dummy-env-636' } });
  core.headers({ Authorization: `Bearer ${key}`, 'X-Custom-Credential': header });
  assert.throws(() => core.capability.sanitize({ prompt: 'prompt-marker' }));
  core.seal();
  assert.deepEqual(Object.keys(core.capability), ['contract', 'credentialCoverage', 'sanitize']);
  const payload = { prompt: 'prompt-marker', response: 'response-marker',
    headers: [['X-Custom-Credential', header]], 'X-Custom-Credential': header,
    diagnostic: `${key} ${header} dummy-oauth-484 dummy-env-636` };
  const notices = [];
  const writer = createTraceWriter({ directory, config: { capture: 'bodies' }, capability: core.capability, notify: n => notices.push(n) });
  assert.equal(writer.enqueue({ kind: 'activity' }, payload), true);
  core.dispose();
  assert.throws(() => core.capability.sanitize(payload));
  assert.equal(writer.enqueue({ kind: 'activity' }, payload), false);
  await writer.close();
  const output = (await Promise.all((await readdir(directory)).map(n => readFile(join(directory, n), 'utf8')))).join('');
  assert.match(output, /prompt-marker/); assert.match(output, /response-marker/);
  for (const secret of [key, header, 'dummy-oauth-484', 'dummy-env-636', 'X-Custom-Credential']) assert.ok(!output.includes(secret));
  assert.ok(notices.length);
  await rm(directory, { recursive: true });
});

test('metadata excludes conversation; unknown coverage and abort refuse rich capture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'safe-capture-'));
  const abort = new AbortController();
  const core = createRequestSanitizer({ signal: abort.signal });
  const denied = createTraceWriter({ directory, config: { capture: 'events' }, capability: core.capability });
  assert.equal(denied.enqueue({ kind: 'activity' }, { prompt: 'prompt-marker' }), false);
  const metadata = createTraceWriter({ directory, config: { capture: 'metadata' } });
  assert.equal(metadata.enqueue({ kind: 'activity' }, { prompt: 'prompt-marker', response: 'response-marker' }), true);
  core.credentials('dummy-abort-key'); core.seal(); abort.abort();
  assert.equal(core.capability.credentialCoverage, 'unknown');
  assert.throws(() => core.capability.sanitize({ text: 'dummy-abort-key' }));
  await denied.close(); await metadata.close();
  const output = (await Promise.all((await readdir(directory)).map(n => readFile(join(directory, n), 'utf8')))).join('');
  assert.ok(!output.includes('prompt-marker')); assert.ok(!output.includes('response-marker'));
  await rm(directory, { recursive: true });
});

test('capture rejects accessors without running them', () => {
  const core = createRequestSanitizer(); core.seal();
  let called = false;
  assert.throws(() => core.capability.sanitize({ get prompt() { called = true; return 'unsafe'; } }));
  assert.equal(called, false); core.dispose();
});

test('resolved closure survives preparation and transport callbacks, then revokes; custom fetch refuses', async () => {
  const original = globalThis.fetch;
  const captures = [];
  const off = bridge.subscribe(event => { if (event.kind === 'capture') captures.push(event); });
  bridge.setCapture('bodies');
  globalThis.fetch = () => Promise.resolve(new Response('ok'));
  try {
    const options = foreground({ apiKey: 'dummy-key', onPayload: value => value });
    const preparation = begin(options);
    preparation.credentials({ oauth: { accessToken: 'dummy-oauth', refreshToken: 'dummy-refresh' }, env: { AUTH: 'dummy-env' } });
    const prepared = { ...options };
    preparation.handoff(prepared, { api: 'openai-completions' });
    preparation.dispose();
    const adapter = observeHTTP(prepared, { api: 'openai-completions' });
    await adapter.fetch('http://fixture', { body: JSON.stringify({ prompt: 'prompt-marker dummy-refresh' }) });
    adapter.event({ choices: [{ delta: { content: 'response-marker dummy-oauth dummy-env dummy-key' } }] });
    assert.equal(captures.length, 2);
    const output = JSON.stringify(captures.map(event => event.payload));
    assert.match(output, /prompt-marker/); assert.match(output, /response-marker/);
    for (const secret of ['dummy-oauth', 'dummy-refresh', 'dummy-env', 'dummy-key']) assert.ok(!output.includes(secret));
    const capability = captures[0].capability;
    adapter.dispose();
    assert.equal(capability.credentialCoverage, 'unknown');
    assert.throws(() => capability.sanitize({ prompt: 'after-terminal' }));
    const unknown = observeHTTP({ ...options, fetch: globalThis.fetch }, {});
    await unknown.fetch('http://fixture', { body: '{"prompt":"unknown-marker"}' });
    unknown.event({ text: 'unknown-marker' }); unknown.dispose();
    assert.equal(captures.length, 2);
  } finally { off(); bridge.setCapture('off'); globalThis.fetch = original; }
});
