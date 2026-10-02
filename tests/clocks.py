#!/usr/bin/env python3
"""Real Pi clock proof. Trace assertions require independent scripted progress/completion."""
import argparse,pathlib,json,os,pty,fcntl,termios,struct,subprocess,select,time,shutil,traceback,re
p=argparse.ArgumentParser();p.add_argument('--artifact-root',required=True);p.add_argument('--pi-root',required=True);a=p.parse_args()
r=pathlib.Path(a.artifact_root);r.mkdir(parents=True,exist_ok=True);repo=pathlib.Path(__file__).resolve().parents[1]
if (r/'outcomes.json').exists():raise SystemExit('Choose a fresh artifact root; retained outcomes cannot be overwritten')
private=r/'private-pi';shutil.copytree(a.pi_root,private,dirs_exist_ok=True)
# Passive render-boundary probe in an artifact-only extension copy. Drive real Pi,
# retain what the renderer receives and emits, never replace the observer clock.
ext=r/'extension';shutil.copytree(repo/'src',ext/'src',dirs_exist_ok=True)
s=(repo/'index.ts').read_text()
s="import { appendFileSync } from 'node:fs';\n"+s
s=s.replace('requestRender?.();', 'appendFileSync(process.env.CLOCK_RENDER_LOG!, JSON.stringify({at:performance.now(),config:state.config,current:state.observer.snapshot(),lines:lines(state),details:lines(state,true),health:state.health})+"\\n"); requestRender?.();',1)
(ext/'index.ts').write_text(s)
subprocess.run(['node',str(repo/'bin/core.mjs'),'apply','--pi-root',str(private)],check=True)
results=[]
try:
 for mode in ['regular','fullscreen']:
  d=r/mode;d.mkdir(exist_ok=True);home=d/'home';agent=home/'agent';agent.mkdir(parents=True,exist_ok=True)
  master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',45,150,0,0))
  proc=subprocess.Popen(['node',str(private/'dist/cli.js'),'--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-session','--no-tools','--tui-mode',mode,'-e',str(repo/'tests/fixtures/clocks.ts'),'-e',str(ext/'index.ts'),'--provider','clock-proof','--model','scripted'],stdin=slave,stdout=slave,stderr=slave,cwd=home,env={**os.environ,'HOME':str(home),'PI_CODING_AGENT_DIR':str(agent),'TERM':'xterm-256color','PROOF_LOG':str(d/'provider.jsonl'),'CLOCK_RENDER_LOG':str(d/'render.jsonl')});os.close(slave);out=bytearray()
  def events():
   f=d/'provider.jsonl';return [json.loads(x) for x in f.read_text().splitlines()] if f.exists() else []
  def wait(pred,label,timeout=30):
   end=time.monotonic()+timeout
   while time.monotonic()<end:
    if select.select([master],[],[],.03)[0]:
     try:out.extend(os.read(master,65536))
     except OSError:pass
    if pred():return
    if proc.poll()!=None:raise RuntimeError('Pi exited '+label)
   raise RuntimeError('timeout '+label)
  def command(cmd,marker='Latency live settings updated'):
   start=len(out);os.write(master,(cmd+'\r').encode());wait(lambda:marker.encode() in out[start:],cmd)
   if marker=='Latency live settings updated':
    start=len(out);os.write(master,b'/latency settings save\r');wait(lambda:b'Latency defaults saved' in out[start:],'saved acknowledgement')
  def renders():
   f=d/'render.jsonl';return [json.loads(x) for x in f.read_text().splitlines()] if f.exists() else []
  def traces():
   return [json.loads(line) for f in (home/'.local/state/pi-response-visibility/traces').glob('*.jsonl') for line in f.read_text().splitlines()]
  try:
   wait(lambda:b'v0.99.2' in out or b'Trust project folder?' in out,'startup boundary')
   if b'Trust project folder?' in out:os.write(master,b'\x1b[B\x1b[B\r') # trust only this owned test session
   wait(lambda:b'v0.99.2' in out and b'scripted' in out,'ready')
   command('/latency settings','"quietMs":30000');assert b'"slowMs":30000' in out
   command('/latency settings quietMs 600');command('/latency expanded')
   os.write(master,b'clock fixture\r')
   wait(lambda:b'Quiet: preparing, no phase progress' in out,'local warning')
   wait(lambda:b'Quiet: waiting, no content progress' in out,'heartbeat warning')
   os.write(master,b'\x1b[108;6u');wait(lambda:b'Latency inspector' in out,'inspector')
   wait(lambda:b'activity age' in out and b'Local diagnostics:' in out,'health and clocks')
   # Input responsiveness is observed during an independently progressing request.
   start=time.monotonic();os.write(master,b'h');wait(lambda:renders()[-1]['config']['sections']['health'] is False,'inspector key processed');responsive=time.monotonic()-start
   assert responsive<1, 'Local inspector input took >=1s during provider wait'
   wait(lambda:len(events())>=12,'provider progress during inspector')
   os.write(master,b'h');wait(lambda:renders()[-1]['config']['sections']['health'] is True,'health restored');os.write(master,b'\x1b')
   wait(lambda:any(e['event']=='completed' for e in events()),'provider completion')
   wait(lambda:b'CLOCK_PROOF_COMPLETE' in out,'rendered completion');wait(lambda:any(x.get('kind')=='complete' for x in traces()),'persisted completion')
   t=sorted(traces(),key=lambda x:x.get('elapsedMs',0));complete=[x for x in t if x.get('kind')=='complete'][-1];assert complete['status']=='success'
   activity=[x for x in t if x.get('kind')=='activity'];content=[x for x in t if x.get('kind')=='content']
   assert len(activity)>=15 and len(content)>=25
   heartbeats=[x for x in activity if x['contents']==0]
   assert heartbeats[-1]['elapsedMs']-heartbeats[0]['elapsedMs']>=1300
   assert all(content[i+1]['elapsedMs']-content[i]['elapsedMs']<600 for i in range(23))
   assert all(x['contents']==i+1 for i,x in enumerate(content))
   assert any(x['current'] and x['current']['contents']>0 and x['current']['activityAgeMs']['provenance']=='observed' and x['current']['contentAgeMs']['provenance']=='observed' and 'Activity ' in '\n'.join(x['lines']) and '; content ' in '\n'.join(x['lines']) for x in renders()), 'separate measured ages reach the compact summary during content'
   e=events();assert [sum(x['event']==k+'-delta' for x in e) for k in ['thinking','text','toolcall']]==[8,8,8]
   hook_duration=next(x['at'] for x in e if x['event']=='hook-end')-next(x['at'] for x in e if x['event']=='hook-start')
   assert hook_duration>=1250
   assert abs(next(x['elapsedMs'] for x in content)- (next(x['at'] for x in e if x['event']=='thinking-delta')-next(x['at'] for x in e if x['event']=='hook-start')))<350
   assert complete['elapsedMs']>=6500
   assert not re.search(rb'\b(hang|hung)\b',out.lower()) and b'(no intervention)' in out
   assert any('Observed foreground sdk: 1.3s' in '\n'.join(x['details']) and 'Observed foreground prepare:' in '\n'.join(x['details']) and 'Observed foreground auth:' in '\n'.join(x['details']) for x in renders()), 'span detail retained for the scrollable inspector'
   # UI-off recording is proven by a second independently completed request.
   command('/latency off');before=len(out);os.write(master,b'clock off fixture\r')
   wait(lambda:sum(e['event']=='completed' for e in events())==2,'off provider completion')
   wait(lambda:b'CLOCK_PROOF_COMPLETE' in out[before:],'off rendered completion')
   wait(lambda:sum(x.get('kind')=='complete' for x in traces())==2,'off persisted completion')
   assert b'Quiet:' not in out[before:] and b'Latency: success' not in out[before:]
   # Third completed request: assert actual render-boundary data, not command ack.
   os.write(master,b'clock display fixture\r')
   wait(lambda:sum(e['event']=='request' for e in events())==3,'display request')
   for preset in ['compact','expanded','timeline']:
    command('/latency '+preset)
    wait(lambda:any(x['config']['preset']==preset and x['current'] for x in renders()),'render '+preset)
    if preset=='timeline':wait(lambda:any(x['config']['preset']==preset and x['current'] and x['current']['timeline'] for x in renders()),'timeline progress')
    row=next(x for x in reversed(renders()) if x['config']['preset']==preset and x['current'] and (preset!='timeline' or x['current']['timeline']))
    text='\n'.join(row['lines'])
    if preset=='compact':assert 'Parsed events' not in text and 'Local diagnostics:' not in text
    assert len(row['lines'])<=2, 'persistent diagnostics must not crowd the response'
    if preset=='timeline' and not row['current']['quiet']:assert any(' · preparing' in line or ' · waiting' in line or ' · receiving' in line for line in row['lines'][1:])
    assert 'Parsed events' in '\n'.join(row['details']) and 'Local diagnostics:' in '\n'.join(row['details']), 'full detail remains available to the inspector'
   command('/latency expanded')
   markers={'timing':'Parsed events','transport':'Prepared payload / assembled headers','provider':'Provider: parsed activity','health':'Local diagnostics:'}
   for section,marker in markers.items():
    for enabled in ['off','on']:
     command('/latency sections '+section+' '+enabled)
     wait(lambda:renders()[-1]['config']['sections'][section]==(enabled=='on'),'render section '+section)
     assert (marker in '\n'.join(renders()[-1]['details']))==(enabled=='on')
   wait(lambda:sum(e['event']=='completed' for e in events())==3,'display provider completion')
   wait(lambda:sum(x.get('kind')=='complete' for x in traces())==3,'display recorded completion')
   # Lifecycle-only activity must not reset content silence; active deltas must.
   rows=[x['current'] for x in renders() if x['current'] and x['current']['id']==1]
   silent=[x for x in rows if x['quiet'] and x['quiet']['absent']=='content progress']
   assert silent and any(x['activityAgeMs']['provenance']=='observed' and x['activityAgeMs']['value']<250 and x['quiet']['ageMs']>=600 for x in silent)
   active=[x for x in rows if 1<=x['contents']<=24]
   assert active and all(x['quiet'] is None and x['contentAgeMs']['value']<600 for x in active)
   channel_assertions={}
   for channel,lo,hi in [('reasoning',1,8),('text',9,16),('tool-arguments',17,24)]:
    channel_rows=[x for x in active if lo<=x['contents']<=hi]
    # Rendering can coalesce deltas; the independent trace must contain every one.
    assert channel_rows and {x['contents'] for x in content if lo<=x['contents']<=hi}==set(range(lo,hi+1)), channel
    assert all(x['contentAgeMs']['provenance']=='observed' and x['contentAgeMs']['value']<600 and x['quiet'] is None for x in channel_rows),channel
    channel_assertions[channel]={'delta_count':8,'rendered_counts':sorted({x['contents'] for x in channel_rows}),'max_content_age_ms':max(x['contentAgeMs']['value'] for x in channel_rows)}
   (d/'clock-assertions.json').write_text(json.dumps({'hook_duration_ms':hook_duration,'heartbeat_duration_ms':heartbeats[-1]['elapsedMs']-heartbeats[0]['elapsedMs'],'independent_channels':channel_assertions,'silent_render_samples':len(silent),'active_render_samples':len(active),'completed_requests':3},indent=2))
   results.append({'case':mode,'status':'passed','completion':complete,'provider_progress_wait_during_inspector_seconds':responsive,'assertions':['default-30000','measured-hook-delay','preparing-warning','heartbeat-content-silence','separate-activity-age','reasoning-text-tool-content-reset','completed-provider-and-screen','measured-foreground-spans','passive-no-hang','ui-off-independent-recording','rendered-compact-expanded-timeline','each-section-rendered-hide-show','lifecycle-age-independent-of-content','active-deltas-no-quiet-with-clock-proof']})
  finally:
   proc.terminate()
   try:proc.wait(timeout=5)
   except subprocess.TimeoutExpired:proc.kill();proc.wait()
   (d/'screen.ansi').write_bytes(out);os.close(master)
 subprocess.run(['node',str(repo/'tests/transport-clocks.mjs')],check=True,env={**os.environ,'CLOCK_ARTIFACT_ROOT':str(r/'transport'),'PI_TEST_ROOT':str(a.pi_root)})
 results.append({'case':'native-transport','status':'passed','proof':'transport/outcomes.json'})
except Exception as e:
 results.append({'status':'failed','error':str(e),'traceback':traceback.format_exc()});raise
finally:
 (r/'outcomes.json').write_text(json.dumps(results,indent=2));subprocess.run(['node',str(repo/'bin/core.mjs'),'rollback','--pi-root',str(private)],check=True)
