import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObserver, NOTICES, estimated } from '../src/observer.mjs';
import { DEFAULTS, validateConfig, saveConfig, loadConfig } from '../src/config.mjs';
import { createTraceWriter } from '../src/trace.mjs';

async function temporary(t) { const path = await mkdtemp(join(tmpdir(), 'visibility-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
async function contents(path) { const names = await readdir(path); return { names, text: (await Promise.all(names.map(n => readFile(join(path, n), 'utf8')))).join('') }; }

test('settings defaults, validation, private saved roundtrip', async t => {
  assert.equal(DEFAULTS.preset, 'compact'); assert.equal(DEFAULTS.capture, 'metadata');
  assert.equal(DEFAULTS.historyLimit, 50); assert.equal(DEFAULTS.traceBytes, 100 * 1024 ** 2);
  assert.equal(DEFAULTS.quietMs, 30000); assert.equal(DEFAULTS.slowMs, 30000);
  for (const bad of [{ preset: 'magic' }, { capture: 'raw' }, { historyLimit: Infinity }, { sections: { secret: true } }, { sections: [] }, { extra: 1 }]) assert.throws(() => validateConfig(bad));
  const path = join(await temporary(t), 'settings.json');
  const c = await saveConfig(path, { preset: 'off', sections: { health: false } });
  assert.deepEqual(await loadConfig(path), c); assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(c.capture, 'metadata'); assert(Object.isFrozen(c.sections));
});

test('phase-aware clocks distinguish lifecycle from useful content without inference', () => {
  let time = 0; const o = createObserver({ clock: () => time }); const id = o.begin();
  time = 30000; assert.equal(o.snapshot().quiet.absent, 'phase progress');
  o.event('phase', { phase: 'connecting' }); assert.equal(o.snapshot().quiet, null);
  time = 31000; o.event('phase', { phase: 'waiting' });
  time = 60000; o.event('activity'); time = 61000;
  const s = o.snapshot(); assert.equal(s.quiet.absent, 'content progress');
  assert.deepEqual(s.activityAgeMs, { provenance: 'observed', value: 1000 });
  assert.equal(s.contentAgeMs.provenance, 'unavailable'); assert.equal(s.transport.provenance, 'unavailable');
  o.event('content', { channel: 'reasoning' }); assert.equal(o.snapshot().quiet, null);
  time = 91000; o.event('activity'); assert.equal(o.snapshot().quiet.ageMs, 30000);
  assert.equal(o.snapshot().firstContentMs.value, 61000);
  time = 1; assert.equal(o.snapshot().elapsedMs, 91000); // regressing clock clamped
  assert.equal(o.event('complete', { status: 'success' }, id).summary, true);
  assert.equal(o.snapshot(), null); assert.equal(o.history()[0].status, 'success');
  assert.deepEqual(estimated(42), { provenance: 'estimated', value: 42 });
});

test('bounded busy timeline/history/overlap and selective immutable completion', () => {
  let time = 0; const messages = [];
  const o = createObserver({ clock: () => time, config: { historyLimit: 2 }, timelineLimit: 3, activeLimit: 2, notify: m => messages.push(m) });
  const first = o.begin(), second = o.begin(); assert.equal(o.begin(), null);
  for (let i = 0; i < 10000; i++) o.event('activity', { secret: 'credential-marker' }, first);
  assert.equal(o.snapshot(first).timeline.length, 3); assert.equal(o.snapshot(first).timelineDropped, 9997);
  assert.equal(o.snapshot(second).events, 0);
  const s = o.event('complete', { status: 'success' }, first); assert.equal(s.summary, false);
  assert.throws(() => { s.timeline.push({}); }); assert.throws(() => { s.phase = 'bad'; });
  assert.equal(o.event('complete', { status: 'failed', error: 'credential-marker' }, second).summary, true);
  const third = o.begin(); assert.equal(o.event('complete', { status: 'aborted' }, third).summary, true);
  assert.equal(o.history().length, 2); assert(!JSON.stringify(o.history()).includes('credential-marker'));
  assert.deepEqual(messages, [NOTICES.dropped]); o.dispose(); assert.equal(o.snapshot(), null);
});

test('metadata actual files omit prompts, headers, errors and arbitrary strings; private rotation', async t => {
  const directory = join(await temporary(t), 'traces'), messages = [];
  const w = createTraceWriter({ directory, config: { preset: 'off', traceBytes: 180 }, notify: m => messages.push(m) });
  for (let i = 0; i < 30; i++) {
    assert(w.enqueue({ id: i, kind: 'activity', error: 'credential-marker', headers: { Authorization: 'credential-marker' }, provider: 'credential-marker', status: 'credential-marker', prompt: 'raw-prompt-marker' }, { output: 'raw-output-marker' }));
    await w.flush();
  }
  await w.close(); const { text, names } = await contents(directory);
  for (const marker of ['credential-marker', 'raw-prompt-marker', 'raw-output-marker', 'Authorization', 'error']) assert(!text.includes(marker));
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  let total = 0; for (const n of names) { const s = await stat(join(directory, n)); total += s.size; assert.equal(s.mode & 0o777, 0o600); }
  assert(total <= 180); assert(names.length < 30); assert.equal(messages.length, 0);
});

test('raw capture refuses unknown coverage; proven sanitizer warnings and credential exclusion', async t => {
  const root = await temporary(t), messages = [];
  const denied = createTraceWriter({ directory: join(root, 'denied'), config: { capture: 'events' }, capability: { sanitize: x => x }, notify: m => messages.push(m) });
  assert.equal(denied.enqueue({ id: 1 }, { token: 'credential-marker' }), false); await denied.close();
  assert.deepEqual(messages, [NOTICES.raw]); assert.equal((await readdir(root)).length, 0);
  const directory = join(root, 'raw');
  const w = createTraceWriter({ directory, config: { capture: 'bodies' }, capability: { credentialCoverage: 'proven', sanitize: value => ({ body: value.body.replaceAll('credential-marker', '[redacted]') }) }, notify: m => messages.push(m) });
  w.enqueue({ id: 1 }, { headers: { Authorization: 'credential-marker' }, body: 'raw-prompt-marker credential-marker' });
  await w.close(); const { text } = await contents(directory);
  assert(!text.includes('credential-marker')); assert(!text.includes('Authorization')); assert(text.includes('raw-prompt-marker'));
  assert(messages.includes(NOTICES.sensitive));
});

test('request-scoped raw capability refusal is visible and later proven capture remains usable', async t => {
  const root = await temporary(t), directory = join(root, 'raw'), messages = [];
  const w = createTraceWriter({ directory, config: { capture: 'events' }, notify: m => messages.push(m) });
  assert.equal(w.enqueue({ id: 1 }), false);
  assert.equal(w.enqueue({ id: 1 }, { body: 'credential-marker' }), false);
  assert.deepEqual(messages, [NOTICES.raw]);
  assert.equal((await readdir(root)).length, 0);
  const capability = { credentialCoverage: 'proven', sanitize: () => ({ body: '[redacted]' }) };
  assert.equal(w.enqueue({ id: 2 }, { body: 'credential-marker', headers: { Authorization: 'credential-marker' } }, capability), true);
  await w.close();
  const { text } = await contents(directory);
  assert(!text.includes('credential-marker')); assert(!text.includes('Authorization'));
  assert.deepEqual(messages, [NOTICES.raw, NOTICES.sensitive]);
  assert.equal(w.stats().failures, 0);
});

test('overflow, oversized, disk and sanitizer faults are fixed-safe and do not alter result', async t => {
  const root = await temporary(t), messages = [];
  const file = join(root, 'not-directory'); await writeFile(file, 'original');
  const w = createTraceWriter({ directory: file, queueLimit: 2, eventBytes: 64, notify: m => messages.push(m) });
  const original = Object.freeze({ answer: 'unchanged', status: 'success' });
  function providerPath() { for (let i = 0; i < 10000; i++) w.enqueue({ id: i, error: 'credential-marker' }); return original; }
  assert.equal(providerPath(), original); await w.close();
  assert(w.stats().dropped > 0); assert(w.stats().failures > 0);
  assert.deepEqual(new Set(messages), new Set([NOTICES.dropped, NOTICES.failure]));
  const raw = createTraceWriter({ directory: join(root, 'raw'), eventBytes: 64, config: { capture: 'events' }, capability: { credentialCoverage: 'proven', sanitize: () => { throw new Error('credential-marker'); } }, notify: m => messages.push(m) });
  assert.equal(raw.enqueue({}, 'x'.repeat(10000)), false);
  assert.equal(raw.enqueue({}, { body: 'raw-prompt-marker' }), false); await raw.close();
  assert(messages.every(m => !m.includes('credential-marker') && !m.includes('raw-prompt-marker')));
  assert.equal(await readFile(file, 'utf8'), 'original');
});

test('backoff and renewed response registration start a fresh content wait without erasing measured ages', () => {
  let time = 0;
  const o = createObserver({ clock: () => time, config: { quietMs: 100, slowMs: 1000 } });
  o.begin(); o.event('phase', { phase: 'waiting' });
  time = 10; o.event('content', { channel: 'tool' });
  time = 110; assert.equal(o.snapshot().quiet.ageMs, 100);
  o.event('phase', { phase: 'backoff' }); assert.equal(o.snapshot().quiet, null);
  time = 210; assert.equal(o.snapshot().quiet.absent, 'phase progress');
  o.event('phase', { phase: 'connecting' });
  time = 220; o.event('phase', { phase: 'waiting' });
  assert.equal(o.snapshot().quiet, null); assert.equal(o.snapshot().contentAgeMs.value, 210);
  time = 270; o.event('phase', { phase: 'receiving' }); o.event('activity');
  time = 320; assert.equal(o.snapshot().quiet.ageMs, 100);
  o.event('content', { channel: 'text' }); assert.equal(o.snapshot().quiet, null);
  assert.equal(o.snapshot().firstContentMs.value, 10);
  const completion = o.event('complete', { status: 'success' });
  assert.equal(completion.summary, false); assert.deepEqual(o.history(), [completion]);
  time = 10000; assert.equal(o.history()[0].elapsedMs, 320);
});

test('off, closed, cyclic, oversized sanitized and asynchronous capture never create files', async t => {
  const root = await temporary(t), messages = [];
  const off = createTraceWriter({ directory: join(root, 'off'), config: { capture: 'off' } });
  assert.equal(off.enqueue({ id: 1 }, 'raw-prompt-marker'), false); await off.close();
  const cycle = {}; cycle.self = cycle;
  const capability = { credentialCoverage: 'proven', sanitize: x => x };
  const w = createTraceWriter({ directory: join(root, 'raw'), config: { capture: 'events' }, capability,
    eventBytes: 128, notify: m => messages.push(m) });
  assert.equal(w.enqueue({}, cycle), false);
  capability.sanitize = () => 'x'.repeat(1024);
  assert.equal(w.enqueue({}, {}), false);
  capability.sanitize = async () => { throw new Error('credential-marker'); };
  assert.equal(w.enqueue({}, {}), false);
  await w.close(); assert.equal(w.enqueue({ id: 1 }), false);
  assert.equal((await readdir(root)).length, 0);
  assert.equal(w.stats().dropped, 2); assert.equal(w.stats().failures, 1);
  assert.deepEqual(new Set(messages), new Set([NOTICES.sensitive, NOTICES.dropped, NOTICES.failure]));
});

test('transport snapshots allowlist bounded detached measurements and preserve content quiet clock', () => {
  let time = 0;
  const o = createObserver({ clock: () => time, config: { quietMs: 100 } });
  o.begin(); o.event('phase', { phase: 'connecting' });
  time = 100; assert.equal(o.snapshot().quiet.absent, 'phase progress');
  const input = { provenance: 'observed', stage: 'connection', atMs: 100, responseBytes: 2,
    providerPath: 'openai-codex-responses', transport: 'websocket', reused: true,
    error: 'credential-marker', headers: { Authorization: 'credential-marker' },
    prompt: 'raw-prompt-marker'.repeat(100000), arbitrary: { nested: true }, durationMs: Infinity };
  const first = o.event('transport', input);
  assert.equal(first.quiet, null);
  assert.deepEqual(first.transport.value, { stage: 'connection', atMs: 100, responseBytes: 2,
    providerPath: 'openai-codex-responses', transport: 'websocket', reused: true });
  input.responseBytes = 999; assert.equal(first.transport.value.responseBytes, 2);
  assert(Object.isFrozen(first.transport.value));
  o.event('phase', { phase: 'waiting' });
  time = 200; o.event('transport', { provenance: 'observed', stage: 'activity', atMs: 200 });
  assert.equal(o.snapshot().quiet.absent, 'content progress');
  assert.equal(o.snapshot().quiet.ageMs, 100);
  assert.equal(o.snapshot().contentAgeMs.provenance, 'unavailable');
  o.event('complete', { status: 'success' });
  const saved = JSON.stringify(o.history());
  for (const marker of ['credential-marker', 'raw-prompt-marker', 'Authorization', 'arbitrary', 'Infinity']) assert(!saved.includes(marker));
  assert(saved.length < 2000);
});

test('reported final usage and HTTP status survive immutable history and metadata files without containers', async t => {
  const root = await temporary(t);
  const o = createObserver(); const id = o.begin();
  o.event('transport', { provenance: 'observed', stage: 'headers', status: 200,
    providerPath: 'openai-completions', headers: { Authorization: 'credential-marker' } }, id);
  const usage = { input: 12, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 17,
    cost: { input: 0.1, output: 0.2, total: 0.3, secret: 'credential-marker' },
    secret: 'credential-marker', invalid: Infinity };
  const done = o.event('complete', { status: 'success', usage }, id);
  assert.equal(done.usage.provenance, 'observed');
  assert.deepEqual(done.usage.value, { input: 12, output: 3, cacheRead: 2, cacheWrite: 0,
    totalTokens: 17, cost: { input: 0.1, output: 0.2, total: 0.3 } });
  usage.input = 99; assert.equal(done.usage.value.input, 12);
  assert(Object.isFrozen(done.usage.value.cost));
  assert.equal(done.transport.value.status, 200);
  assert.equal(done.transport.value.headers, undefined);
  const w = createTraceWriter({ directory: root });
  assert(w.enqueue({ ...done, kind: 'complete' })); await w.close();
  const text = (await Promise.all((await readdir(root)).map(name => readFile(join(root, name), 'utf8')))).join('');
  const record = JSON.parse(text);
  assert.deepEqual(record.usage, done.usage);
  assert.equal(record.transport.status, 200);
  assert(!text.includes('credential-marker')); assert.equal(record.transport.headers, undefined);
  o.begin(); assert.equal(o.event('complete', { status: 'success', usage: { input: NaN, output: -1 } }).usage.provenance, 'unavailable');
});

test('invalid observations cannot promote content or preserve arbitrary data; history shrinks immediately', () => {
  let time = 0; const o = createObserver({ clock: () => time });
  const id = o.begin();
  for (const [kind, data] of [['phase', { phase: 'credential-marker' }], ['content', { channel: 'heartbeat' }],
    ['complete', { status: 'raw-prompt-marker' }], ['error', { error: 'credential-marker' }]]) {
    assert.equal(o.event(kind, data), null);
  }
  assert.equal(o.snapshot().events, 0); assert.equal(o.snapshot().timeline.length, 0);
  time = 1; o.event('content', { channel: 'reasoning' }, id);
  o.event('complete', { status: 'success' }, id);
  for (const status of ['failed', 'aborted']) { o.begin(); o.event('complete', { status }); }
  const prior = o.history(); o.configure({ historyLimit: 1 });
  assert.equal(prior.length, 3); assert.equal(o.history().length, 1);
  assert.equal(o.history()[0].status, 'aborted'); assert(Object.isFrozen(prior));
  assert(!JSON.stringify(prior).includes('credential-marker'));
});
