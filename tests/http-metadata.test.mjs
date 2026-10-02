import test from 'node:test';
import assert from 'node:assert/strict';
import { createObserver } from '../src/observer.mjs';
import { lines } from '../src/ui.mjs';
import { DEFAULTS } from '../src/config.mjs';

test('sanitized HTTP response metadata survives activity and history without retaining header containers', () => {
  const observer = createObserver();
  const id = observer.begin();
  const headers = { 'x-request-id': 'fixture-request', 'x-ratelimit-remaining-requests': '8', authorization: 'must-not-retain' };
  observer.event('transport', { provenance: 'observed', providerPath: 'openai-completions', stage: 'headers', status: 200, requestBytes: 42, headers }, id);
  headers['x-request-id'] = 'mutated';
  observer.event('transport', { provenance: 'observed', providerPath: 'openai-completions', stage: 'activity' }, id);
  const completed = observer.event('complete', { status: 'success' }, id);
  assert.deepEqual({ ...completed.transport.value.headers }, { 'x-request-id': 'fixture-request', 'x-ratelimit-remaining-requests': '8' });
  const rendered = lines({ config: DEFAULTS, current: completed, gap: '', health: {} }, true).join('\n');
  assert.match(rendered, /x-request-id=fixture-request/);
  assert.match(rendered, /status 200; request body bytes 42/);
  assert.ok(!JSON.stringify(completed).includes('must-not-retain'));
});
