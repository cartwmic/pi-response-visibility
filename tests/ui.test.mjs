import test from 'node:test';
import assert from 'node:assert/strict';
import { lines, component } from '../src/ui.mjs';
import { createObserver } from '../src/observer.mjs';
import { validateConfig } from '../src/config.mjs';
const plainTheme = { colors: { userMessageBg: 'panel' }, style: text => text, fg: (_token, text) => text };
test('compact view, truthful detail and live inspector controls', () => {
  const state = { config: validateConfig(), observer: createObserver(), gap: 'Core telemetry unavailable', health: {} };
  state.observer.begin(); state.current = state.observer.snapshot();
  assert.equal(lines(state).length, 1);
  assert.match(lines(state, true).join('\n'), /not wire dispatch/);
  let closed = false, rendered = 0;
  state.change = patch => { state.config = validateConfig({ ...state.config, ...patch }); };
  const view = component({ state, theme: plainTheme, truncate: (s, n) => s.slice(0, n), tui: { requestRender() { rendered++; } }, done() { closed = true; }, matchesKey: (a, b) => a === b });
  view.handleInput('p'); assert.equal(state.config.preset, 'expanded');
  view.handleInput('t'); assert.equal(state.config.sections.timing, false);
  assert.ok(view.render(20).every(line => line.length <= 20));
  view.handleInput('escape'); assert.ok(closed); assert.equal(rendered, 2);
});
test('inspector arrows enter history, live key returns, and measured spans stay out of old records', () => {
  const observer = createObserver(); observer.begin(); observer.event('complete', { status: 'success' });
  observer.begin();
  const state = { config: validateConfig(), observer, spans: [{ phase: 'prepare', durationMs: 42 }], gap: 'bridge', health: {} };
  const view = component({ state, theme: plainTheme, truncate: s => s,
    tui: { requestRender() {} }, done() {}, matchesKey: (a, b) => a === b });
  assert.match(view.render(200).join('\n'), /Observed foreground prepare/);
  view.handleInput('up');
  assert.match(view.render(200)[0], /Latency history 1\/1/);
  assert.doesNotMatch(view.render(200).join('\n'), /Observed foreground prepare/);
  view.handleInput('l'); assert.match(view.render(200)[0], /Latency inspector/);
});
test('final reported usage is shown in history, missing usage stays unavailable', () => {
  const observer = createObserver(); observer.begin();
  observer.event('complete', { status: 'success', usage: { input: 12, output: 3, totalTokens: 15, cost: { total: 0.004 }, secret: 'never-display' } });
  const state = { config: validateConfig(), observer, gap: '', health: {} };
  const view = component({ state, history: true, theme: plainTheme, truncate: s => s,
    tui: { requestRender() {} }, done() {}, matchesKey: (a, b) => a === b });
  const rendered = view.render(200).join('\n');
  assert.match(rendered, /Final reported usage: input 12; output 3; total tokens 15/);
  assert.match(rendered, /Reported cost total: 0.004/);
  assert.doesNotMatch(rendered, /never-display/);
  observer.begin(); observer.event('complete', { status: 'success' });
  assert.match(view.render(200).join('\n'), /Final reported usage: unavailable/);
});
test('live observer thresholds and history bounds update without losing the current request', () => {
  let clock = 0;
  const observer = createObserver({ clock: () => clock }); observer.begin();
  observer.configure({ quietMs: 10, historyLimit: 1 }); clock = 20;
  assert.equal(observer.snapshot().quiet.phase, 'preparing');
  observer.event('complete', {status:'success'}); observer.begin(); observer.event('complete', {status:'success'});
  assert.equal(observer.history().length, 1);
});
test('all persistent presets protect conversation space and collapse when idle', () => {
  let clock = 0;
  const observer = createObserver({ clock: () => clock, config: { quietMs: 10 } });
  observer.begin(); observer.event('phase', { phase: 'waiting' });
  for (let i = 0; i < 40; i++) { clock++; observer.event('activity'); }
  const current = observer.snapshot();
  for (const preset of ['compact', 'expanded', 'timeline']) {
    const state = { config: validateConfig({ preset }), current, observer, health: {}, gap: 'stock' };
    assert.ok(lines(state).length <= 2, preset + ' persistent line budget');
    assert.equal(lines({ ...state, current: null }).length, 1, preset + ' idle collapse');
    assert.ok(lines(state, true).length > 2, 'detail remains available on demand');
  }
  assert.deepEqual(lines({ config: validateConfig({ preset: 'off' }), current }), []);
});
test('inspector fills an opaque rectangle and scrolls detail within the terminal height', () => {
  const observer = createObserver(); observer.begin();
  for (let i = 0; i < 40; i++) observer.event('activity');
  const state = { config: validateConfig({ preset: 'timeline' }), observer, gap: 'stock', health: {}, change() {} };
  const tui = { terminal: { rows: 20 }, requestRender() {} };
  const theme = { get colors() { throw new Error('Do not resolve guessed terminal RGB colors'); }, style: (s, spec) => { assert.equal(spec.bg, 'userMessageBg'); assert.equal(spec.fg, 'text'); return s; }, fg: (_k, s) => s };
  const view = component({ state, theme, truncate: (s, n) => s.slice(0, n), visible: s => s.length,
    wrap: (s, n) => Array.from({ length: Math.ceil(s.length / n) }, (_, i) => s.slice(i * n, (i + 1) * n)),
    tui, done() {}, matchesKey: (a, b) => a === b });
  const first = view.render(50);
  assert.ok(first.length <= Math.floor(tui.terminal.rows * .6), 'bounded overlay height');
  assert.ok(first.every(s => s.length === 50), 'all rows painted to full width');
  assert.match(first[0], /Latency inspector/);
  view.handleInput('end'); const last = view.render(50);
  assert.notDeepEqual(last, first, 'scroll reaches otherwise clipped timeline');
  assert.match(last.join('\n'), /activity · preparing/);
  view.handleInput('home'); assert.deepEqual(view.render(50), first);
  view.handleInput('pageDown'); assert.notDeepEqual(view.render(50), first);
  tui.terminal.rows = 10;
  assert.ok(view.render(28).length <= 6, 'resize recalculates the viewport');
  view.dispose();
});
