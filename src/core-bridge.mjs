// Installed only by the explicit helper. No transport interception or global patches.
export const BRIDGE = Symbol.for('pi.response-visibility.telemetry.v1');
export const CONTRACT = 'pi.response-visibility.telemetry.v1';
export const SANITIZER = 'pi.response-visibility.sanitizer.v1';
const listeners = new Set();
let sequence = 0;
let captureMode = 'off';
function capture(requestId, origin, sanitizer, type, value) {
  if (captureMode !== 'bodies' && !(captureMode === 'events' && type === 'event')) return;
  try {
    const payload = sanitizer.capability.sanitize(value);
    publish(Object.freeze({ kind: 'capture', requestId, origin, type, payload, capability: sanitizer.capability }));
  } catch { /* Unknown coverage or unsafe snapshots never cross the bridge. */ }
}
// Identity, never timing, links the SDK caller to its lazy runtime preparation.
const requests = new WeakMap();
const resolvedRequests = new WeakMap();
function takeSanitizer(options) {
  const key = [options, options?.onPayload, options?.onResponse].find(value => value && resolvedRequests.has(value));
  const lifetime = key ? resolvedRequests.get(key) : createRequestSanitizer();
  if (key) for (const value of [options, options?.onPayload, options?.onResponse]) if (value) resolvedRequests.delete(value);
  return lifetime;
}
export function foreground(options) {
  const association = { id: `request-${++sequence}`, origin: 'foreground' };
  requests.set(options, association);
  for (const name of ['onPayload', 'onResponse', 'onProviderStreamEvent']) {
    const callback = options[name];
    if (typeof callback !== 'function') continue;
    options[name] = async function (...args) {
      const start = performance.now();
      try { return await Reflect.apply(callback, this, args); }
      finally {
        publish(Object.freeze({ kind: 'span', origin: association.origin, requestId: association.id,
          data: Object.freeze({ phase: 'sdk', callback: name, durationMs: performance.now() - start }),
          unavailable: Object.freeze(['http', 'codex', 'transport-counters', 'raw-capture']) }));
      }
    };
    requests.set(options[name], association);
  }
  return options;
}
const capabilities = Object.freeze({ prepare: true, auth: true, hook: true, sdk: true,
  http: true, codex: true, transportCounters: true, exactOrigin: true, rawCapture: true,
  sanitizer: SANITIZER, credentialCoverage: 'unknown' });
export const bridge = Object.freeze({ version: 1, contract: CONTRACT, capabilities, http: observeHTTP, codex: observeCodex,
  setCapture(mode) {
    if (!['off', 'metadata', 'events', 'bodies'].includes(mode)) throw new Error('Invalid capture mode');
    captureMode = mode;
  },
  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener required');
    listeners.add(listener); return () => listeners.delete(listener);
  },
});
// Do not replace another bridge, including an incompatible one.
function installBridge() { if (!globalThis[BRIDGE]) globalThis[BRIDGE] = bridge; }
installBridge();
function publish(event) {
  if (globalThis[BRIDGE] !== bridge) return;
  for (const listener of [...listeners]) { try { listener(event); } catch {} }
}
// Transport adapters must hold this object through terminal/abort. Coverage is
// asserted only by an audited core adapter, never by extension/provider metadata.
export function createRequestSanitizer({ signal } = {}) {
  const secrets = new Set();
  const headerNames = new Set();
  let active = true, proven = false;
  function credentials(value, seen = new Set()) {
    if (!active) throw new Error('Capture request closed');
    if (typeof value === 'string' && value) secrets.add(value);
    else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if ('value' in descriptor) credentials(descriptor.value, seen);
      }
    }
  }
  function headers(value, resolved = true) {
    if (resolved) credentials(value);
    else if (value && typeof value === 'object') {
      for (const [name, content] of Object.entries(value)) {
        if (headerNames.has(name.toLowerCase()) || /auth|cookie|token|secret|password|api[-_]?key/i.test(name)) credentials(content);
      }
    }
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) headerNames.add(key.toLowerCase());
    }
  }
  function scrubString(value) {
    // Longest first prevents a short secret from exposing a longer one's suffix.
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      value = value.split(secret).join('[redacted]');
    }
    return value;
  }
  function sanitize(value) {
    if (!active || !proven) throw new Error('Raw capture unavailable');
    const seen = new Set(); let nodes = 0;
    function visit(v, depth) {
      if (++nodes > 4096 || depth > 32) throw new Error('Capture limit');
      if (typeof v === 'string') {
        if (v.length > 1024 * 1024) throw new Error('Capture limit');
        return scrubString(v);
      }
      if (v === null || typeof v === 'boolean') return v;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (!v || typeof v !== 'object' || seen.has(v)) throw new Error('Unsafe capture');
      const proto = Object.getPrototypeOf(v);
      if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) throw new Error('Unsafe capture');
      seen.add(v);
      const result = Array.isArray(v) ? [] : Object.create(null);
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
        if (Array.isArray(v) && key === 'length') continue;
        if (!('value' in descriptor)) throw new Error('Unsafe capture');
        // Drop credential fields, all resolved header names, and entire header
        // containers, including tuple arrays. Never copy credentials to UI.
        if (headerNames.has(key.toLowerCase()) || /auth|cookie|token|secret|password|api[-_]?key|headers|^env$/i.test(key)) continue;
        result[Array.isArray(v) ? key : scrubString(key)] = visit(descriptor.value, depth + 1);
      }
      seen.delete(v); return result;
    }
    return visit(value, 0);
  }
  function dispose() {
    if (!active) return;
    active = false; proven = false; secrets.clear(); headerNames.clear();
    signal?.removeEventListener('abort', dispose);
  }
  const capability = Object.freeze({ contract: SANITIZER,
    get credentialCoverage() { return active && proven ? 'proven' : 'unknown'; }, sanitize });
  if (signal?.aborted) dispose(); else signal?.addEventListener('abort', dispose, { once: true });
  return Object.freeze({ capability, credentials, headers, dispose,
    // This is a core-only adapter control. Do not publish it through the bridge.
    seal() { if (!active) throw new Error('Capture request closed'); proven = true; } });
}
// Called only at the audited built-in openai-completions adapter, never globally.
export function observeHTTP(options, model) {
  const association = requests.get(options ?? {}) ?? requests.get(options?.onPayload ?? {})
    ?? requests.get(options?.onResponse ?? {});
  const requestId = association?.id ?? `request-${++sequence}`;
  const origin = association?.origin ?? 'background';
  let attempt = 0, first = true;
  const sanitizer = takeSanitizer(options);
  sanitizer.credentials(options?.apiKey); sanitizer.headers(options?.headers); sanitizer.headers(model?.headers); sanitizer.credentials(options?.env);
  if (options?.apiKey && !options?.fetch && model?.provider !== 'github-copilot') sanitizer.seal();
  const dispose = () => { sanitizer.dispose(); options?.signal?.removeEventListener('abort', dispose); };
  if (options?.signal?.aborted) dispose(); else options?.signal?.addEventListener('abort', dispose, { once: true });
  const emit = data => publish(Object.freeze({ kind: 'transport', requestId, origin,
    data: Object.freeze({ ...data, provenance: 'observed', providerPath: 'openai-completions',
      responseBytes: null }), unavailable: Object.freeze(['response-wire-bytes', 'socket', 'server-time']) }));
  const original = options?.fetch ?? globalThis.fetch;
  function fetch(...args) {
    const current = ++attempt, start = performance.now();
    // Include the assembled SDK headers, not only caller-provided headers.
    try { sanitizer.headers(Object.fromEntries(new Headers(args[1]?.headers).entries()), false); } catch { sanitizer.dispose(); }
    const body = args[1]?.body;
    if (typeof body === 'string') {
      try { capture(requestId, origin, sanitizer, 'payload', JSON.parse(body)); } catch {}
    }
    const requestBytes = typeof body === 'string' ? new TextEncoder().encode(body).byteLength
      : ArrayBuffer.isView(body) ? body.byteLength : body instanceof ArrayBuffer ? body.byteLength : null;
    emit({ stage: 'dispatch', attempt: current, atMs: start, requestBytes });
    // Preserve receiver, argument identities, promise/result and synchronous throws.
    const result = Reflect.apply(original, this, args);
    Promise.resolve(result).then(response => {
      const headers = Object.create(null);
      for (const name of ['x-request-id', 'request-id', 'retry-after', 'x-ratelimit-limit-requests',
        'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests', 'x-ratelimit-limit-tokens',
        'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens']) {
        const value = response.headers?.get(name);
        // Do not snapshot arbitrary header strings (including echoed credentials).
        if (value && /^[\w. :,+/=-]{1,128}$/.test(value)) {
          try { headers[name] = sanitizer.capability.sanitize(value); } catch { /* unknown coverage */ }
        }
      }
      emit({ stage: 'headers', attempt: current, atMs: performance.now(),
        durationMs: performance.now() - start, status: response.status, headers, requestBytes });
    }, () => emit({ stage: 'rejection', attempt: current, atMs: performance.now() })).catch(() => {});
    return result;
  }
  return Object.freeze({ fetch, dispose, event(chunk) {
    capture(requestId, origin, sanitizer, 'event', chunk);
    emit({ stage: first ? 'first-event' : 'activity', attempt, atMs: performance.now() }); first = false;
    const deltas = chunk?.choices?.map(choice => choice.delta) ?? [];
    if (deltas.some(delta => delta?.content || delta?.reasoning || delta?.reasoning_content ||
      delta?.reasoning_text || delta?.tool_calls?.some(tool => tool.function?.arguments))) {
      emit({ stage: 'content', attempt, atMs: performance.now() });
    }
  } });
}
export function observeCodex(options, model) {
  const association = requests.get(options ?? {}) ?? requests.get(options?.onPayload ?? {})
    ?? requests.get(options?.onResponse ?? {});
  const requestId = association?.id ?? `request-${++sequence}`;
  const origin = association?.origin ?? 'background';
  const sanitizer = takeSanitizer(options);
  sanitizer.credentials(options?.apiKey); sanitizer.headers(options?.headers);
  sanitizer.headers(model?.headers); sanitizer.credentials(options?.env);
  // Codex may add ambient OAuth/transport credentials; coverage is not yet audited.
  // Keep rich capture unavailable for this adapter.
  let active = true, attempt = 0;
  if (options?.signal?.aborted) dispose();
  else options?.signal?.addEventListener('abort', dispose, { once: true });
  const emit = data => {
    if (!active) return;
    if (data.stage === 'registration') publish(Object.freeze({ kind: 'phase', requestId, origin, data: Object.freeze({ phase: 'waiting' }) }));
    publish(Object.freeze({ kind: 'transport', requestId, origin,
      data: Object.freeze({ ...data, atMs: performance.now(), provenance: 'observed', providerPath: 'openai-codex-responses' }),
      unavailable: Object.freeze(['server-time', 'network-framing-bytes']) }));
  };
  const original = options?.fetch ?? globalThis.fetch;
  let first = true;
  return Object.freeze({ emit,
    phase(phase) {
      if (active && ['connecting', 'waiting'].includes(phase)) publish(Object.freeze({ kind: 'phase', requestId, origin, data: Object.freeze({ phase }) }));
    },
    event(event) {
      emit({ stage: first ? 'first-event' : 'activity' }); first = false;
      if (['response.output_text.delta', 'response.reasoning_text.delta', 'response.reasoning_summary_text.delta', 'response.function_call_arguments.delta'].includes(event?.type) && event.delta) emit({ stage: 'content' });
    },
    fetch(...args) {
      const body = args[1]?.body;
      emit({ stage: 'dispatch', transport: 'sse', attempt: ++attempt,
        requestBytes: typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body?.byteLength ?? null });
      const result = Reflect.apply(original, this, args);
      Promise.resolve(result).then(response => emit({ stage: 'headers', transport: 'sse', status: response.status }),
        () => emit({ stage: 'rejection', transport: 'sse' })).catch(() => {});
      return result;
    },
    bytes(data) {
      const responseBytes = typeof data === 'string' ? new TextEncoder().encode(data).byteLength
        : data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data.byteLength
        : typeof Blob !== 'undefined' && data instanceof Blob ? data.size : null;
      emit({ stage: 'activity', transport: 'websocket', responseBytes });
    },
    dispose,
  });
  function dispose() {
    active = false; sanitizer.dispose();
    options?.signal?.removeEventListener('abort', dispose);
  }
}
export function begin(options) {
  installBridge();
  const association = options && requests.get(options);
  const id = association?.id ?? `request-${++sequence}`;
  const origin = association?.origin ?? 'unknown';
  // Preparation owns cleanup until handoff. The audited adapter owns abort and
  // terminal cleanup afterward; pending handoffs are held only by weak keys.
  const lifetime = createRequestSanitizer();
  let transferred = false;
  function closeOver(value, seen = new Set()) {
    if (typeof value === 'string' && value) lifetime.credentials(value);
    else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if ('value' in descriptor) closeOver(descriptor.value, seen);
      }
    }
  }
  const sanitize = lifetime.capability.sanitize;
  return Object.freeze({ id, sanitize, capabilities,
    handoff(preparedOptions, model) {
      const codex = model?.api === 'openai-codex-responses';
      if (!codex && (model?.api !== 'openai-completions' || preparedOptions?.fetch || !preparedOptions?.apiKey || model?.provider === 'github-copilot')) return;
      for (const key of [preparedOptions, preparedOptions?.onPayload, preparedOptions?.onResponse]) {
        if (key && (typeof key === 'object' || typeof key === 'function')) resolvedRequests.set(key, lifetime);
      }
      transferred = true;
    },
    credentials(value) { try { closeOver(value); } catch {} },
    span(phase) {
      if (!['prepare', 'auth', 'hook'].includes(phase)) throw new Error('Unsupported span');
      const start = performance.now(); let ended = false;
      return () => {
        if (ended) return; ended = true;
        publish(Object.freeze({ kind: 'span', origin, requestId: id,
          data: Object.freeze({ phase, durationMs: performance.now() - start }),
          unavailable: Object.freeze([...(origin === 'unknown' ? ['exact-origin'] : []), 'http', 'codex', 'transport-counters', 'raw-capture']) }));
      };
    },
    dispose() { if (!transferred) lifetime.dispose(); },
  });
}
