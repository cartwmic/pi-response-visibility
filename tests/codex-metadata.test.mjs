import test from 'node:test';
import assert from 'node:assert/strict';
import { selectMetadata } from '../src/trace.mjs';
import { createObserver } from '../src/observer.mjs';
import { observeCodex, foreground, begin, bridge } from '../src/core-bridge.mjs';
test('Codex numeric transport reaches capture; unavailable byte types are not invented',()=>{
  const observer=createObserver();observer.begin();
  const off=bridge.subscribe(e=>observer.event('transport',e.data));
  const adapter=observeCodex(foreground({apiKey:'dummy-resolved-secret',onPayload:x=>x}),{});
  adapter.bytes('🙂');
  let metadata=selectMetadata(observer.snapshot());
  assert.equal(metadata.transport.responseBytes,4);
  assert.equal(metadata.transport.providerPath,'openai-codex-responses');
  adapter.bytes({unknown:'dummy-resolved-secret'});
  assert.equal(observer.snapshot().transport.value.responseBytes,null);
  metadata=selectMetadata(observer.snapshot());assert.equal(metadata.transport.responseBytes,undefined);
  adapter.emit({stage:'close',transport:'websocket',closeCode:1009});
  assert.equal(selectMetadata(observer.snapshot()).transport.closeCode,1009);
  assert.ok(!JSON.stringify(metadata).includes('dummy-resolved-secret'));
  adapter.dispose();off();
});
test('Codex SDK handoff remains request-local, rich capture refuses and abort closes telemetry',()=>{
  const controller=new AbortController();
  const options=foreground({apiKey:'dummy-codex-key',onPayload:x=>x,signal:controller.signal});
  const preparation=begin(options);
  preparation.credentials({resolved:'dummy-resolved-oauth'});
  const prepared={...options};
  preparation.handoff(prepared,{api:'openai-codex-responses'});
  preparation.dispose();
  const events=[];const off=bridge.subscribe(e=>events.push(e));
  bridge.setCapture('bodies');
  try {
    const adapter=observeCodex(prepared,{});
    adapter.event({type:'response.output_text.delta',delta:'dummy-resolved-oauth'});
    assert.ok(events.length>0);
    assert.ok(events.every(e=>e.origin==='foreground' && e.requestId===preparation.id));
    assert.ok(events.every(e=>e.kind==='transport'));
    assert.ok(!JSON.stringify(events).includes('dummy-resolved-oauth'));
    const count=events.length;controller.abort();
    adapter.bytes('late activity');adapter.event({type:'response.completed'});
    assert.equal(events.length,count);
    adapter.dispose();
  } finally {off();bridge.setCapture('off');}
});
