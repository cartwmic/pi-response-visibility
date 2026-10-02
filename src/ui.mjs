// Rendering receives only bounded, sanitized observer state; never conversation text.
export const seconds = n => `${(n / 1000).toFixed(1)}s`;
const age = field => field?.provenance === 'observed' ? seconds(field.value) : 'unavailable';
export function lines(state, detail = false) {
  const { config: c, current: r, gap, health } = state;
  const out = [`Latency · ${r ? `${r.phase} · ${seconds(r.elapsedMs)}` : 'idle'} · capture ${c.capture}`];
  if (r?.quiet) out.push(`Quiet: ${r.quiet.phase}, no ${r.quiet.absent} for ${seconds(r.quiet.ageMs)} (no intervention)`);
  // Persistent chrome never grows with telemetry or timeline length.
  if (!detail) {
    if (c.preset === 'off') return [];
    if (!r) return ['Latency · idle · /latency history'];
    if (r.quiet || c.preset === 'compact') return out;
    if (c.preset === 'timeline') {
      const latest = r.timeline.at(-1);
      if (latest) out.push(`${seconds(latest.atMs)} ${latest.kind} · ${latest.phase} · /latency inspect`);
    } else {
      const summary = [];
      if (c.sections.timing) summary.push(`Activity ${age(r.activityAgeMs)}; content ${age(r.contentAgeMs)}`);
      if (c.sections.transport) summary.push(`HTTP status ${r.transport?.value?.status ?? 'unavailable'}`);
      if (c.sections.provider) summary.push(`Usage ${r.usage?.value?.totalTokens ?? 'unavailable'}`);
      if (c.sections.health) summary.push(`queued ${health?.queued ?? 0}; dropped ${health?.dropped ?? 0}; failures ${health?.failures ?? 0}`);
      if (summary.length) out.push(summary.join(' · '));
    }
    return out;
  }
  if (c.sections.timing) out.push(r ? `Parsed events ${r.events}; content updates ${r.contents}; activity age ${age(r.activityAgeMs)}; content age ${age(r.contentAgeMs)}` : 'Timing: no active request', r ? `First parsed event ${age(r.firstEventMs)}; first content ${age(r.firstContentMs)}` : 'Timing: no active request');
  if (c.sections.transport) {
    out.push('Prepared payload / assembled headers are local observations, not wire dispatch.');
    const transport = r?.transport?.value;
    out.push(transport ? `Observed ${transport.providerPath === 'openai-codex-responses' ? 'Codex' : 'HTTP'} ${transport.stage}; attempt ${transport.attempt ?? 'unavailable'}; status ${transport.status ?? 'unavailable'}; request body bytes ${transport.requestBytes ?? 'unavailable'}` : 'Transport timing and server inference: unavailable');
    if (transport?.headers && Object.keys(transport.headers).length) out.push(`Response metadata: ${Object.entries(transport.headers).map(([name, value]) => `${name}=${value}`).join('; ')}`);
    if (transport) out.push(transport.providerPath === 'openai-codex-responses' ? `Received payload bytes ${transport.responseBytes ?? 'unavailable'}; connection reuse ${transport.reused ?? 'unavailable'}; close code ${transport.closeCode ?? 'unavailable'}; server timing unavailable` : 'Response wire bytes / socket / server timing: unavailable');
  }
  if (c.sections.provider) {
    out.push('Provider: parsed activity only; content from normalized message updates.', gap);
    const usage = r?.usage?.provenance === 'observed' ? r.usage.value : null;
    const fields = [['input', 'input'], ['output', 'output'], ['totalTokens', 'total tokens'], ['cacheRead', 'cache read'], ['cacheWrite', 'cache write']];
    out.push(usage ? `Final reported usage: ${fields.filter(([key]) => usage[key] !== undefined).map(([key, label]) => `${label} ${usage[key]}`).join('; ') || 'tokens unavailable'}` : 'Final reported usage: unavailable');
    if (usage?.cost?.total !== undefined) out.push(`Reported cost total: ${usage.cost.total}`);
    for (const span of (state.spans ?? []).slice(-8)) out.push(`Observed foreground ${span.phase}: ${seconds(span.durationMs)} (not server inference)`);
  }
  if (c.sections.health) out.push(`Local diagnostics: queued ${health?.queued ?? 0}, dropped ${health?.dropped ?? 0}, failures ${health?.failures ?? 0}`);
  if (r && (detail || c.preset === 'timeline')) out.push(...r.timeline.map(e => `${seconds(e.atMs)} ${e.kind} · ${e.phase}`));
  return out;
}
export function component({ state, theme, truncate, visible = s => s.length, wrap = s => [s], tui, done, matchesKey, history = false, registerClose }) {
  let index = 0, browsing = history, scroll = 0, pageSize = 1, maxScroll = 0;
  registerClose?.(() => done());
  return {
    invalidate() {},
    render(width) {
      const records = state.observer.history();
      index = Math.min(index, Math.max(0, records.length - 1));
      const selected = browsing ? records[Math.max(0, records.length - 1 - index)] : state.observer.snapshot();
      const view = { ...state, current: selected, spans: browsing ? [] : state.spans };
      const height = Math.max(1, Math.min(24, Math.floor((tui.terminal?.rows ?? 30) * .6)));
      const inner = Math.max(1, width - 4);
      const title = browsing ? `Latency history ${records.length ? index + 1 : 0}/${records.length}` : 'Latency inspector';
      const details = lines(view, true).flatMap(line => wrap(line, inner));
      pageSize = Math.max(1, height - 4);
      maxScroll = Math.max(0, details.length - pageSize);
      scroll = Math.max(0, Math.min(scroll, maxScroll));
      const paint = text => {
        const clipped = truncate(text, width);
        const padded = clipped + ' '.repeat(Math.max(0, width - visible(clipped)));
        return theme.style(padded, { fg: 'text', bg: 'userMessageBg' });
      };
      const row = text => { const clipped = truncate(text, inner); return `│ ${clipped}${' '.repeat(Math.max(0, inner - visible(clipped)))} │`; };
      const body = details.slice(scroll, scroll + pageSize);
      while (body.length < pageSize) body.push('');
      return [`┌ ${title} ${'─'.repeat(Math.max(0, width - visible(title) - 5))}┐`,
        row('Esc close · ↑↓ history · l live · p preset · t/r/v/h'),
        ...body.map(row),
        row(`Details ${scroll + 1}–${Math.min(scroll + pageSize, details.length)}/${details.length} · j/k PgUp/Dn Home/End`),
        `└${'─'.repeat(Math.max(0, width - 2))}┘`].slice(0, height).map(paint);
    },
    handleInput(data) {
      if (matchesKey(data, 'escape')) return done();
      if (matchesKey(data, 'up')) { browsing = true; index = Math.min(index + 1, Math.max(0, state.observer.history().length - 1)); scroll = 0; }
      if (matchesKey(data, 'down')) { browsing = true; index = Math.max(0, index - 1); scroll = 0; }
      if (data === 'l') { browsing = false; scroll = 0; }
      if (data === 'j') scroll = Math.min(maxScroll, scroll + 1);
      if (data === 'k') scroll = Math.max(0, scroll - 1);
      if (matchesKey(data, 'pageDown')) scroll = Math.min(maxScroll, scroll + pageSize);
      if (matchesKey(data, 'pageUp')) scroll = Math.max(0, scroll - pageSize);
      if (matchesKey(data, 'home')) scroll = 0;
      if (matchesKey(data, 'end')) scroll = maxScroll;
      if (data === 'p') { const modes = ['off', 'compact', 'expanded', 'timeline']; state.change({ preset: modes[(modes.indexOf(state.config.preset) + 1) % 4] }); }
      const section = { t: 'timing', r: 'transport', v: 'provider', h: 'health' }[data];
      if (section) state.change({ sections: { ...state.config.sections, [section]: !state.config.sections[section] } });
      tui.requestRender();
    },
    dispose() { registerClose?.(undefined); },
  };
}
