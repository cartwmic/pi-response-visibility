import { performance } from 'node:perf_hooks';
import { validateConfig } from './config.mjs';

export const NOTICES = Object.freeze({ dropped: 'Diagnostics dropped: capacity reached.',
  failure: 'Diagnostics unavailable: recording failed.', raw: 'Raw capture unavailable: required credential-sanitization telemetry unavailable; credential sanitization is not proven.',
  sensitive: 'Sensitive capture enabled: conversation and source content may be stored.' });
const phases = ['preparing', 'connecting', 'waiting', 'receiving', 'backoff'];
const immutable = value => Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) =>
  [k, Array.isArray(v) ? Object.freeze(v.map(immutable)) : v && typeof v === 'object' ? immutable(v) : v])));
export const unavailable = () => Object.freeze({ provenance: 'unavailable', value: null });
export const observed = value => Object.freeze({ provenance: 'observed', value });
export const estimated = value => Object.freeze({ provenance: 'estimated', value });

// Pi final reported usage only; never infer tokens or retain provider containers.
export function selectReportedUsage(input) {
  const value = {};
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
    if (Number.isSafeInteger(input?.[key]) && input[key] >= 0) value[key] = input[key];
  }
  const cost = {};
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
    if (Number.isFinite(input?.cost?.[key]) && input.cost[key] >= 0) cost[key] = input.cost[key];
  }
  if (Object.keys(cost).length) value.cost = cost;
  return Object.keys(value).length ? immutable(observed(value)) : unavailable();
}

/** UI/core contract: event(kind, data) accepts ONLY sanitized observations, never errors,
 * headers, prompt/output text or credential values. Kinds: phase {phase}, activity {},
 * content {channel: text|reasoning|tool}, complete {status: success|failed|aborted,
 * usage?: Pi final reported numeric input/output/cacheRead/cacheWrite/totalTokens,
 * cost?: numeric fields within usage.cost}. Missing/invalid usage is unavailable.
 * transport {provenance: observed, stage, numeric measurements, enum providerPath/transport,
 * reused: boolean}. Unknown transport fields are discarded; no caller object is retained.
 * Transport transitions reset local preparation/connection progress, never content wait.
 * begin() returns a bounded numeric local id; pass it to event(kind,data,id) for overlap.
 * Clock is monotonic milliseconds. No transport/server phase is inferred from activity.
 * Waiting/receiving share a content-progress clock; re-entry after preparation,
 * connection or backoff starts a fresh wait. Activity never resets that clock.
 * Snapshots/history are immutable; all notices are fixed text. No recovery callbacks.
 */
export function createObserver({ config = {}, clock = () => performance.now(), timelineLimit = 256, activeLimit = 16, notify = () => {} } = {}) {
  let c = validateConfig(config);
  if (!Number.isSafeInteger(timelineLimit) || timelineLimit < 1 || timelineLimit > 4096 || !Number.isSafeInteger(activeLimit) || activeLimit < 1 || activeLimit > 256) throw new TypeError('Invalid observer bounds');
  let last = 0, next = 0, selected;
  const active = new Map(), completed = [];
  const now = () => { const n = clock(); if (Number.isFinite(n)) last = Math.max(last, n); return last; };
  const notice = key => { try { notify(NOTICES[key]); } catch {} };
  function snapshot(r, t = now()) {
    const base = ['waiting', 'receiving'].includes(r.phase) ? Math.max(r.contentAt ?? r.start, r.waitAt ?? r.start) : r.progressAt;
    return immutable({ id: r.id, phase: r.phase, status: r.status, elapsedMs: (r.end ?? t) - r.start,
      activityAgeMs: r.activityAt === null ? unavailable() : observed((r.end ?? t) - r.activityAt),
      contentAgeMs: r.contentAt === null ? unavailable() : observed((r.end ?? t) - r.contentAt),
      firstEventMs: r.firstEvent === null ? unavailable() : observed(r.firstEvent - r.start),
      firstContentMs: r.firstContent === null ? unavailable() : observed(r.firstContent - r.start),
      transport: r.transport ? observed(r.transport) : unavailable(), usage: r.usage ?? unavailable(), server: unavailable(), events: r.events, contents: r.contents,
      timeline: r.timeline, timelineDropped: r.dropped,
      quiet: r.end === undefined && t - base >= c.quietMs ? { phase: r.phase, absent: ['waiting', 'receiving'].includes(r.phase) ? 'content progress' : 'phase progress', ageMs: t - base } : null });
  }
  function begin() {
    if (active.size >= activeLimit) { notice('dropped'); return null; }
    const t = now(), id = ++next;
    active.set(id, { id, start: t, progressAt: t, phase: 'preparing', status: 'active', activityAt: null,
      contentAt: null, firstEvent: null, firstContent: null, waitAt: null, events: 0, contents: 0, timeline: [], dropped: 0 });
    selected = id; return id;
  }
  function event(kind, data = {}, id = selected) {
    const r = active.get(id); if (!r) return null;
    const t = now();
    if (kind === 'transport' && data.provenance === 'observed' && ['dispatch', 'headers', 'rejection', 'first-event', 'activity', 'content', 'connection', 'registration', 'close', 'fallback', 'backoff'].includes(data.stage)) {
      const measured = { stage: data.stage };
      for (const key of ['attempt', 'status', 'requestBytes', 'responseBytes', 'closeCode', 'delayMs', 'durationMs', 'atMs', 'dispatchAtMs', 'headersAtMs', 'firstEventAtMs', 'activityAtMs', 'contentAtMs']) {
        if (data[key] === null || (Number.isFinite(data[key]) && data[key] >= 0)) measured[key] = data[key];
      }
      if (['openai-completions', 'openai-codex-responses'].includes(data.providerPath)) measured.providerPath = data.providerPath;
      if (['sse', 'websocket'].includes(data.transport)) measured.transport = data.transport;
      if (typeof data.reused === 'boolean') measured.reused = data.reused;
      // Only core-sanitized explicit metadata, never arbitrary header containers.
      if (data.stage === 'headers' && data.providerPath === 'openai-completions' && data.headers && typeof data.headers === 'object') {
        const headers = Object.create(null);
        for (const name of ['x-request-id', 'request-id', 'retry-after', 'x-ratelimit-limit-requests',
          'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests', 'x-ratelimit-limit-tokens',
          'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens']) {
          const value = data.headers[name];
          if (typeof value === 'string' && value.length <= 256) headers[name] = value;
        }
        if (Object.keys(headers).length) measured.headers = headers;
      }
      const timestampKey = { dispatch: 'dispatchAtMs', headers: 'headersAtMs',
        'first-event': 'firstEventAtMs', activity: 'activityAtMs', content: 'contentAtMs' }[data.stage];
      if (timestampKey && measured.atMs !== undefined) measured[timestampKey] = measured.atMs;
      r.transport = { ...(r.transport ?? {}), ...measured };
      if (['preparing', 'connecting'].includes(r.phase)) r.progressAt = t;
    } else if (kind === 'phase' && phases.includes(data.phase)) {
      if (r.phase !== data.phase) {
        if (['waiting', 'receiving'].includes(data.phase) && !['waiting', 'receiving'].includes(r.phase)) r.waitAt = t;
        r.phase = data.phase; r.progressAt = t;
      }
    } else if (kind === 'activity' || kind === 'content') {
      if (kind === 'content' && !['text', 'reasoning', 'tool'].includes(data.channel)) return null;
      r.activityAt = t; r.firstEvent ??= t; r.events++;
      if (kind === 'content') { r.contentAt = t; r.firstContent ??= t; r.contents++; r.phase = 'receiving'; r.waitAt ??= t; }
    } else if (kind === 'complete' && ['success', 'failed', 'aborted'].includes(data.status)) {
      r.status = data.status; r.end = t; r.usage = selectReportedUsage(data.usage);
    } else return null;
    if (r.timeline.length === timelineLimit) { r.timeline.shift(); r.dropped++; }
    r.timeline.push({ kind, atMs: t - r.start, phase: r.phase });
    const result = snapshot(r, t);
    if (kind === 'complete') {
      const completion = immutable({ ...result, summary: r.status !== 'success' || t - r.start >= c.slowMs });
      active.delete(id); completed.push(completion); if (completed.length > c.historyLimit) completed.shift();
      return completion;
    }
    return result;
  }
  return Object.freeze({ configure: config => { c = validateConfig(config); while (completed.length > c.historyLimit) completed.shift(); }, begin, event, snapshot: (id = selected) => active.has(id) ? snapshot(active.get(id)) : null,
    history: () => Object.freeze([...completed]), dispose: () => { active.clear(); selected = undefined; } });
}
