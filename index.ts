import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, matchesKey } from '@earendil-works/pi-tui';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, validateConfig, SECTIONS } from './src/config.mjs';
import { createObserver } from './src/observer.mjs';
import { createTraceWriter } from './src/trace.mjs';
import { lines, component, seconds } from './src/ui.mjs';

// Optional process-local bridge v1: subscribe(listener) -> unsubscribe. Listener receives
// sanitized {kind,data,origin}; only explicitly foreground observations join the UI wait.
// Unknown/background observations never overwrite foreground state. Rich snapshots require a live core capability.
export const BRIDGE = Symbol.for('pi.response-visibility.telemetry.v1');
export default function (pi: ExtensionAPI) {
  const root = join(homedir(), '.local', 'state', 'pi-response-visibility');
  const settings = join(root, 'settings.json');
  const state: any = { config: validateConfig(), gap: 'Core telemetry unavailable (stock hooks).', health: null, spans: [] };
  let ui: any, timer: any, requestRender: any, closeOverlay: any, unsubscribe: any, writer: any;
  const notify = (text: string) => ui?.notify(text, 'warning');
  state.observer = createObserver();
  function record(kind: string, data = {}) {
    try { const r = state.observer.event(kind, data); if (r) writer?.enqueue({ ...r, kind }); return r; } catch { return null; }
  }
  function render() {
    state.current = state.observer.snapshot(); state.health = writer?.stats();
    requestRender?.();
  }
  function widget() {
    ui?.setWidget('latency', state.config.preset === 'off' ? undefined : (tui: any, theme: any) => {
      requestRender = () => tui.requestRender();
      return { render: (width: number) => lines({ ...state, current: state.observer.snapshot(), health: writer?.stats() })
        .map((line: string) => truncateToWidth(theme.fg('dim', line), width)), invalidate() {}, dispose() { requestRender = undefined; } };
    });
  }
  function recorder() {
    (globalThis as any)[BRIDGE]?.setCapture?.(state.config.capture);
    const old = writer;
    writer = createTraceWriter({ directory: join(root, 'traces'), config: state.config, notify });
    void old?.close();
  }
  state.change = (patch: any) => { state.config = validateConfig({ ...state.config, ...patch }); state.observer.configure(state.config); recorder(); widget(); render(); };
  async function stop() {
    clearInterval(timer); timer = undefined;
    (globalThis as any)[BRIDGE]?.setCapture?.('off');
    try { unsubscribe?.(); } catch {} unsubscribe = undefined;
    closeOverlay?.(); closeOverlay = undefined;
    ui?.setWidget('latency', undefined); requestRender = undefined;
    state.observer.dispose(); state.spans = []; ui = undefined;
    const old = writer; writer = undefined; await old?.close();
  }
  pi.on('session_start', async (_event, ctx) => {
    await stop();
    try { state.config = await loadConfig(settings); } catch { state.config = validateConfig(); ctx.ui.notify('Latency settings unavailable; using defaults.', 'warning'); }
    state.observer = createObserver({ config: state.config, notify });
    if (ctx.mode === 'tui') ui = ctx.ui;
    recorder();
    const bridge = (globalThis as any)[BRIDGE];
    state.gap = 'Core telemetry unavailable (stock hooks); origin unknown.';
    if (bridge?.version === 1 && typeof bridge.subscribe === 'function') {
      try {
        unsubscribe = bridge.subscribe((event: any) => {
          if (event?.origin !== 'foreground') return;
          if (event.kind === 'capture' && ['events', 'bodies'].includes(state.config.capture)) {
            writer?.enqueue({ kind: 'activity' }, event.payload, event.capability);
            return;
          }
          if (event.kind === 'transport' && event.data?.provenance === 'observed') {
            record('transport', event.data);
          }
          if (event.kind === 'phase') record('phase', { phase: event.data?.phase });
          // Only fixed labels and finite scalar measurements cross into rendering.
          if (event.kind === 'span' && ['prepare', 'auth', 'hook', 'sdk', 'connect', 'registration', 'fallback', 'http', 'codex'].includes(event.data?.phase)
            && Number.isFinite(event.data?.durationMs) && event.data.durationMs >= 0) {
            state.spans.push({ phase: event.data.phase, durationMs: event.data.durationMs });
            if (state.spans.length > 24) state.spans.shift();
          }
        });
        state.gap = 'Core bridge v1 present; server inference unavailable.';
      } catch { state.gap = 'Core bridge unavailable; stock observations remain active.'; }
    } else if (bridge) state.gap = 'Core bridge incompatible; stock observations remain active.';
    widget();
    if (ui) timer = setInterval(render, 250);
  });
  pi.on('session_shutdown', stop);
  // Session replacement is completed by a new session_start; shutdown is idempotent.
  pi.on('input', () => { /* read-only input boundary; turn_start owns requests */ });
  pi.on('turn_start', () => { if (state.observer.snapshot()) record('complete', { status: 'aborted' }); state.spans = []; state.observer.begin(); });
  pi.on('before_provider_request', () => { record('phase', { phase: 'preparing' }); });
  pi.on('before_provider_headers', () => { /* assembled headers are not parsed stream activity */ });
  pi.on('after_provider_response', event => {
    // Stock response boundary exposes numeric status, not wire timing/bytes or headers.
    record('transport', { provenance: 'observed', stage: 'headers', status: event.status });
    record('phase', { phase: 'waiting' });
  });
  pi.on('provider_stream_event', () => { const r = state.observer.snapshot(); if (r?.phase === 'preparing') record('phase', { phase: 'waiting' }); record('activity'); });
  pi.on('message_update', event => {
    const type = event.assistantMessageEvent.type;
    if (['text_delta', 'thinking_delta', 'toolcall_delta'].includes(type)) record('content', { channel: type === 'text_delta' ? 'text' : type === 'thinking_delta' ? 'reasoning' : 'tool' });
  });
  pi.on('message_end', event => {
    if (event.message.role !== 'assistant') return;
    const reason = event.message.stopReason;
    const r = record('complete', { status: reason === 'aborted' ? 'aborted' : reason === 'error' ? 'failed' : 'success', usage: event.message.usage });
    if (r?.summary && state.config.preset !== 'off') ui?.notify(`Latency: ${r.status} · ${seconds(r.elapsedMs)}`, 'info');
  });
  pi.on('agent_end', () => { if (state.observer.snapshot()) record('complete', { status: 'aborted' }); });
  async function inspect(ctx: any, history = false) {
    if (ctx.mode !== 'tui' || closeOverlay) return;
    const terminalUI = ctx.ui;
    await terminalUI.custom((tui: any, theme: any, _keys: any, done: any) => {
      const tick = setInterval(() => tui.requestRender(), 250);
      const view = component({ state, theme, truncate: truncateToWidth, visible: visibleWidth, wrap: wrapTextWithAnsi, tui, done, matchesKey, history,
        registerClose: (close: any) => { closeOverlay = close; } });
      const dispose = view.dispose;
      view.dispose = () => { clearInterval(tick); dispose(); };
      return view;
    }, { overlay: true, overlayOptions: { width: '100%', maxHeight: '60%' } });
  }
  pi.registerShortcut('ctrl+shift+l', { description: 'Latency inspector', handler: ctx => inspect(ctx) });
  pi.registerCommand('latency', {
    description: 'Latency presets, sections, history, capture, settings, inspector',
    handler: async (args, ctx) => {
      const [command, key, value] = args.trim().split(/\s+/);
      try {
        if (!command || command === 'inspect') return await inspect(ctx);
        if (command === 'history') return await inspect(ctx, true);
        if (['off', 'compact', 'expanded', 'timeline'].includes(command)) state.change({ preset: command });
        else if (command === 'sections' && SECTIONS.includes(key) && ['on', 'off'].includes(value)) state.change({ sections: { ...state.config.sections, [key]: value === 'on' } });
        else if (command === 'capture') {
          if (['events', 'bodies'].includes(key)) {
            const bridge = (globalThis as any)[BRIDGE];
            if (bridge?.capabilities?.rawCapture !== true || typeof bridge.setCapture !== 'function') {
              ctx.ui.notify('Raw capture refused: required sanitization telemetry unavailable; no raw files enabled.', 'warning'); return;
            }
            ctx.ui.notify('Warning: rich capture includes sensitive prompt/output/source. Only proven resolved-auth requests are captured; unknown/custom auth is refused.', 'warning');
          }
          if (!['off', 'metadata', 'events', 'bodies'].includes(key)) throw new Error();
          state.change({ capture: key });
        } else if (command === 'settings') {
          if (key === 'save') { await saveConfig(settings, state.config); ctx.ui.notify('Latency defaults saved.', 'info'); return; }
          if (!key) { ctx.ui.notify(JSON.stringify(state.config), 'info'); return; }
          if (!['quietMs', 'slowMs', 'historyLimit', 'traceBytes'].includes(key)) throw new Error();
          state.change({ [key]: Number(value) });
        } else throw new Error();
        ctx.ui.notify('Latency live settings updated; /latency settings save persists defaults.', 'info');
      } catch { ctx.ui.notify('Usage: /latency off|compact|expanded|timeline|inspect|history; sections timing|transport|provider|health on|off; capture off|metadata|events|bodies; settings [save|quietMs|slowMs|historyLimit|traceBytes value]', 'warning'); }
    },
  });
}
