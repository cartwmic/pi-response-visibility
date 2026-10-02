import { mkdir, chmod, readdir, lstat, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { validateConfig } from './config.mjs';
import { NOTICES, selectReportedUsage } from './observer.mjs';

// Metadata is numeric/enum-only: arbitrary provider names, IDs, URLs and errors can
// contain credentials. Adapters map these to safe local IDs instead of copying them.
export function selectMetadata(input) {
  const result = {};
  for (const key of ['id', 'atMs', 'elapsedMs', 'events', 'contents', 'inputTokens', 'outputTokens', 'statusCode', 'dropped']) {
    if (Number.isFinite(input?.[key]) && input[key] >= 0) result[key] = input[key];
  }
  for (const [key, values] of Object.entries({ kind: ['phase', 'activity', 'content', 'complete', 'health', 'transport'],
    phase: ['preparing', 'connecting', 'waiting', 'receiving', 'backoff'], status: ['success', 'failed', 'aborted'],
    provenance: ['observed', 'estimated', 'unavailable'], origin: ['foreground', 'background', 'unknown'] })) {
    if (values.includes(input?.[key])) result[key] = input[key];
  }
  if (input?.usage?.provenance === 'observed') {
    const usage = selectReportedUsage(input.usage.value);
    if (usage.provenance === 'observed') result.usage = usage;
  }
  const transport = input?.transport?.provenance === 'observed' ? input.transport.value : null;
  if (transport) {
    const measured = {};
    for (const key of ['attempt', 'status', 'requestBytes', 'responseBytes', 'closeCode', 'delayMs', 'durationMs', 'atMs', 'dispatchAtMs', 'headersAtMs', 'firstEventAtMs', 'activityAtMs', 'contentAtMs']) {
      if (Number.isFinite(transport[key]) && transport[key] >= 0) measured[key] = transport[key];
    }
    for (const [key, values] of Object.entries({ stage: ['dispatch', 'headers', 'rejection', 'first-event', 'activity', 'content', 'connection', 'registration', 'close', 'fallback', 'backoff'], providerPath: ['openai-completions', 'openai-codex-responses'], transport: ['sse', 'websocket'] })) {
      if (values.includes(transport[key])) measured[key] = transport[key];
    }
    if (typeof transport.reused === 'boolean') measured.reused = transport.reused;
    result.transport = measured;
  }
  return result;
}

// Reject oversized/deep inputs before JSON.stringify allocates an unbounded string.
function boundedJSON(value, limit) {
  let budget = limit, nodes = 0;
  const seen = new Set();
  function visit(v, depth) {
    if (++nodes > 4096 || depth > 32) throw new Error('Capture limit');
    if (typeof v === 'string') budget -= Buffer.byteLength(v) + 2;
    else if (v && typeof v === 'object') {
      if (seen.has(v)) throw new Error('Capture cycle');
      seen.add(v);
      for (const key in v) {
        if (!Object.hasOwn(v, key)) continue;
        budget -= Buffer.byteLength(key) + 4;
        if (budget < 0) throw new Error('Capture limit');
        visit(v[key], depth + 1);
      }
      seen.delete(v);
    } else budget -= 8;
    if (budget < 0) throw new Error('Capture limit');
  }
  visit(value, 0);
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > limit) throw new Error('Capture limit');
  return json;
}

/** Nonblocking enqueue; flush/close are for teardown/tests, never provider callbacks.
 * Raw capability contract: {credentialCoverage:'proven', sanitize(value): JSON-safe value}.
 * The core closure must remove credential headers and every resolved secret (including
 * strings embedded in errors); unknown ambient auth MUST NOT assert proven coverage.
 * Sanitize runs before enqueue. The writer never logs thrown errors or original values.
 */
export function createTraceWriter({ directory, config = {}, capability, notify = () => {},
  queueLimit = 128, eventBytes = 64 * 1024, bodyBytes = 1024 * 1024 } = {}) {
  const c = validateConfig(config);
  for (const n of [queueLimit, eventBytes, bodyBytes]) if (!Number.isSafeInteger(n) || n < 1 || n > 16 * 1024 * 1024) throw new TypeError('Invalid writer bounds');
  const raw = ['events', 'bodies'].includes(c.capture);
  const permitted = !raw || (capability?.credentialCoverage === 'proven' && typeof capability.sanitize === 'function');
  let closed = false, running = null, sequence = 0, dropped = 0, failures = 0;
  const queue = [], warned = new Set();
  const notice = key => { if (!warned.has(key)) { warned.add(key); try { notify(NOTICES[key]); } catch {} } };
  if (raw && capability) notice(permitted ? 'sensitive' : 'raw');
  async function persist(line) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const dir = await lstat(directory); if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('Unsafe directory');
    await chmod(directory, 0o700);
    const files = [];
    for (const name of await readdir(directory)) {
      if (!/^trace-\d+-[a-f0-9]+-\d+\.jsonl$/.test(name)) continue;
      const path = join(directory, name), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe file');
      files.push({ path, size: stat.size, time: stat.mtimeMs });
    }
    files.sort((a, b) => a.time - b.time || a.path.localeCompare(b.path));
    let total = files.reduce((sum, f) => sum + f.size, 0);
    const bytes = Buffer.byteLength(line);
    let count = files.length;
    for (const f of files) { if (total + bytes <= c.traceBytes && count < 256) break; await unlink(f.path); total -= f.size; count--; }
    const path = join(directory, `trace-${Date.now()}-${nonce}-${++sequence}.jsonl`);
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(line); } finally { await file.close(); }
  }
  const nonce = Math.random().toString(16).slice(2);
  function schedule() {
    if (running) return;
    running = new Promise(resolve => setImmediate(resolve)).then(async () => {
      while (queue.length) { const line = queue.shift(); try { await persist(line); } catch { failures++; notice('failure'); } }
    }).finally(() => { running = null; if (queue.length) schedule(); });
  }
  function enqueue(input, payload, requestCapability = capability) {
    if (closed || c.capture === 'off') return false;
    if (raw && payload !== undefined && (requestCapability?.credentialCoverage !== 'proven' || typeof requestCapability.sanitize !== 'function')) { notice('raw'); return false; }
    if (raw && payload === undefined && !permitted) { notice('raw'); return false; }
    if (queue.length >= queueLimit) { dropped++; notice('dropped'); return false; }
    try {
      let record = selectMetadata(input);
      if (raw && payload !== undefined) {
        // Oversized originals are rejected before expensive sanitizer work.
        try { boundedJSON(payload, c.capture === 'bodies' ? bodyBytes : eventBytes); }
        catch { dropped++; notice('dropped'); return false; }
        notice('sensitive');
        const capture = requestCapability.sanitize(payload);
        if (capture && typeof capture.then === 'function') {
          // Refuse asynchronous sanitizers, but consume rejection so diagnostics
          // cannot surface an unhandled rejection in the provider process.
          void Promise.resolve(capture).catch(() => {});
          throw new Error('Synchronous sanitizer required');
        }
        record = { ...record, capture };
      }
      const max = raw && c.capture === 'bodies' ? bodyBytes : eventBytes;
      let line;
      try { line = boundedJSON(record, Math.min(max, c.traceBytes)) + '\n'; }
      catch { dropped++; notice('dropped'); return false; }
      if (Buffer.byteLength(line) > Math.min(max, c.traceBytes)) { dropped++; notice('dropped'); return false; }
      queue.push(line); schedule(); return true;
    } catch { failures++; notice('failure'); return false; }
  }
  async function flush() { while (running || queue.length) { if (!running) schedule(); await running; } }
  return Object.freeze({ enqueue, flush, close: async () => { closed = true; await flush(); },
    stats: () => Object.freeze({ queued: queue.length, dropped, failures, permitted }) });
}
