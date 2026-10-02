#!/usr/bin/env python3
"""Running Pi storage proof; private-source instrumentation records actual bounded objects."""
import argparse,pathlib,json,os,pty,fcntl,termios,struct,subprocess,select,time,shutil,traceback
p=argparse.ArgumentParser();p.add_argument('--artifact-root',required=True);p.add_argument('--pi-root',required=True);a=p.parse_args()
r=pathlib.Path(a.artifact_root);r.mkdir(parents=True,exist_ok=True);repo=pathlib.Path(__file__).resolve().parents[1]
private=r/'private-pi';shutil.copytree(a.pi_root,private,dirs_exist_ok=True)
ext=r/'extension';shutil.copytree(repo/'src',ext/'src',dirs_exist_ok=True)
s=(repo/'index.ts').read_text();s="import { appendFileSync } from 'node:fs';\n"+s
# Test-only bound injection and passive scalar inspection, never installed on host.
s=s.replace('config: state.config, notify });','config: state.config, notify, queueLimit: 4 });',1)
s=s.replace('state.observer = createObserver({ config: state.config, notify });','state.observer = createObserver({ config: state.config, notify, timelineLimit: 8 });')
s=s.replace('state.current = state.observer.snapshot(); state.health = writer?.stats();','state.current = state.observer.snapshot(); state.health = writer?.stats(); appendFileSync(process.env.PROBE_LOG!, JSON.stringify({health:state.health,history:state.observer.history().map((x:any)=>({status:x.status,timeline:x.timeline.length,dropped:x.timelineDropped})),current:state.current?{timeline:state.current.timeline.length,dropped:state.current.timelineDropped}:null})+"\\n");')
(ext/'index.ts').write_text(s)
subprocess.run(['node',str(repo/'bin/core.mjs'),'apply','--pi-root',str(private)],check=True)
results=[]
try:
 for case in ['bounded','write-failure']:
  d=r/case;d.mkdir(exist_ok=True);home=d/'home';agent=home/'agent';agent.mkdir(parents=True,exist_ok=True)
  root=home/'.local/state/pi-response-visibility';root.mkdir(parents=True,exist_ok=True)
  (root/'settings.json').write_text(json.dumps({'historyLimit':2,'traceBytes':1024}))
  if case=='write-failure':(root/'traces').write_text('owned non-directory write fault')
  master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',45,150,0,0))
  proc=subprocess.Popen(['node',str(private/'dist/cli.js'),'--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-session','--no-tools','-e',str(repo/'tests/fixtures/storage.ts'),'-e',str(ext/'index.ts'),'--provider','storage-proof','--model','scripted'],stdin=slave,stdout=slave,stderr=slave,env={**os.environ,'HOME':str(home),'PI_CODING_AGENT_DIR':str(agent),'TERM':'xterm-256color','PROOF_LOG':str(d/'provider.jsonl'),'PROBE_LOG':str(d/'probe.jsonl')});os.close(slave);out=bytearray()
  def readlog(name):
   f=d/name;return [json.loads(x) for x in f.read_text().splitlines()] if f.exists() else []
  def wait(pred,label):
   end=time.monotonic()+30
   while time.monotonic()<end:
    if select.select([master],[],[],.03)[0]:
     try:out.extend(os.read(master,65536))
     except OSError:pass
    if pred():return
    if proc.poll()!=None:raise RuntimeError('Pi exited '+label)
   raise RuntimeError('timeout '+label)
  try:
   wait(lambda:b'v0.99.2' in out and b'scripted' in out,'ready')
   for i in range(4):
    start=len(out);os.write(master,b'STORAGE_PROMPT_MARKER\r');wait(lambda:sum(x['event']=='completed' for x in readlog('provider.jsonl'))==i+1,'provider completion');wait(lambda:b'STORAGE_OUTPUT_COMPLETE' in out[start:],'visible response');time.sleep(.4)
   wait(lambda:any(len(x['history'])==2 for x in readlog('probe.jsonl')),'history')
   start=len(out);os.write(master,b'/latency off\r');wait(lambda:b'Latency live settings updated' in out[start:],'UI off')
   start=len(out);os.write(master,b'STORAGE_PROMPT_MARKER\r');wait(lambda:sum(x['event']=='completed' for x in readlog('provider.jsonl'))==5,'UI off completion');wait(lambda:b'STORAGE_OUTPUT_COMPLETE' in out[start:],'UI off visible response');time.sleep(.6)
   assert sum(x['event']=='request' for x in readlog('provider.jsonl'))==5
   probes=readlog('probe.jsonl');assert all(len(x['history'])<=2 and x['health']['queued']<=4 for x in probes)
   assert all(h['timeline']<=8 for x in probes for h in x['history']);assert any(h['dropped']>0 for x in probes for h in x['history'])
   assert all(x['current'] is None or x['current']['timeline']<=8 for x in probes)
   assert any(x['health']['dropped']>0 for x in probes), 'actual recorder overflow required'
   assert not any(x['event']=='error' for x in readlog('provider.jsonl'))
   assert all(h['status']=='success' for x in probes for h in x['history'])
   (d/'bounds-inspection.json').write_text(json.dumps({'maxQueue':max(x['health']['queued'] for x in probes),'maxHistory':max(len(x['history']) for x in probes),'maxTimeline':max([h['timeline'] for x in probes for h in x['history']]+[x['current']['timeline'] for x in probes if x['current']]),'recorderDropped':max(x['health']['dropped'] for x in probes),'recordingFailures':max(x['health']['failures'] for x in probes),'timelineDropped':max(h['dropped'] for x in probes for h in x['history']),'providerRequests':5,'providerCompletions':5},indent=2))
   assert b'Diagnostics dropped: capacity reached.' in out
   if case=='write-failure':
    assert b'Diagnostics unavailable: recording failed.' in out;assert any(x['health']['failures']>0 for x in probes)
   else:
    files=list((root/'traces').glob('*.jsonl'));assert files
    total=sum(f.stat().st_size for f in files);assert total<=1024
    assert (root/'traces').stat().st_mode&0o777==0o700
    for f in files:assert f.stat().st_mode&0o777==0o600
    text=''.join(f.read_text() for f in files)
    assert any(json.loads(line).get('id')==5 for line in text.splitlines()), 'UI off metadata missing'
    for marker in ['STORAGE_PROMPT_MARKER','STORAGE_OUTPUT_COMPLETE','STORAGE_EVENT_MARKER','DUMMY_STORAGE_CREDENTIAL','authorization','capture']:assert marker not in text
    (d/'file-inspection.json').write_text(json.dumps({'aggregateBytes':total,'directoryMode':oct((root/'traces').stat().st_mode&0o777),'files':[{'path':str(f),'bytes':f.stat().st_size,'mode':oct(f.stat().st_mode&0o777)} for f in files]},indent=2))
   results.append({'case':case,'status':'passed','completed':5,'assertions':['safe-visible-drop-warning','queue<=4','history<=2','timeline<=8','timeline-incomplete-marker','no-provider-retry-or-failure']})
  finally:
   proc.terminate()
   try:proc.wait(timeout=5)
   except subprocess.TimeoutExpired:proc.kill();proc.wait()
   (d/'screen.ansi').write_bytes(out);os.close(master)
except Exception as e:
 results.append({'status':'failed','error':str(e),'traceback':traceback.format_exc()});raise
finally:
 (r/'outcomes.json').write_text(json.dumps(results,indent=2));subprocess.run(['node',str(repo/'bin/core.mjs'),'rollback','--pi-root',str(private)],check=True)
