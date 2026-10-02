#!/usr/bin/env python3
"""Actual Pi PTY journeys; isolated homes, signal waits and retained ANSI/provider logs."""
import argparse, os, pty, subprocess, select, time, fcntl, termios, struct, json, pathlib, shutil, signal, traceback
p=argparse.ArgumentParser();p.add_argument('--artifact-root',required=True);p.add_argument('--pi-root',required=True);p.add_argument('--package-root',required=True);a=p.parse_args()
root=pathlib.Path(a.package_root).resolve(); artifacts=pathlib.Path(a.artifact_root);artifacts.mkdir(parents=True,exist_ok=True)
source=pathlib.Path(a.pi_root); assert json.loads((source/'package.json').read_text())['version']=='0.99.2'
private=artifacts/'private-pi';shutil.copytree(source,private,dirs_exist_ok=True)
results=[]
def journey(mode,enabled,patched=False,restart=False):
 name=f'{mode}-{enabled}-{patched}'+('-restart' if restart else ''); d=artifacts/name;d.mkdir(exist_ok=True)
 home=(artifacts/f'{mode}-{enabled}-{patched}'/'home') if restart else d/'home';home.mkdir(exist_ok=True)
 master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',30,100,0,0))
 env={**os.environ,'HOME':str(home),'PI_CODING_AGENT_DIR':str(home/'agent'),'TERM':'xterm-256color','PROOF_LOG':str(d/'provider.jsonl')}
 cmd=['node',str(private/'dist/cli.js'),'--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-session','--tui-mode',mode,'-e',str(root/'tests/fixtures/provider.ts'),'--provider','visibility-proof','--model','scripted','--no-tools']
 if enabled:
  installed=subprocess.run(['node',str(private/'dist/cli.js'),'install',str(root)],env=env,check=True,capture_output=True)
  (d/'install.log').write_bytes(installed.stdout+installed.stderr)
  settings=json.loads((home/'agent/settings.json').read_text());assert any((home/'agent'/entry).resolve()==root for entry in settings['packages']), 'installed package declaration missing'
  (d/'installed-settings.json').write_text(json.dumps(settings,indent=2))
  cmd.remove('--no-extensions')
 proc=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,env=env);os.close(slave);out=bytearray()
 def pump():
  if select.select([master],[],[],.05)[0]:
   try:out.extend(os.read(master,65536))
   except OSError:pass
 def wait(predicate,label):
  deadline=time.monotonic()+30
  while time.monotonic()<deadline:
   pump()
   if predicate():return
   if proc.poll() is not None:raise RuntimeError('Pi exited: '+label)
  raise RuntimeError('Timed out: '+label)
 def seen(s):return s.encode() in out
 def send(s):os.write(master,s.encode())
 def events():
  f=d/'provider.jsonl';return [json.loads(x) for x in f.read_text().splitlines()] if f.exists() else []
 def count(e):return sum(x['event']==e for x in events())
 def command(s,marker):
  before=len(out);send(s+'\r');wait(lambda:marker.encode() in out[before:],s)
  if marker=='Latency live settings updated':
   before=len(out);send('/latency settings save\r');wait(lambda:b'Latency defaults saved' in out[before:],'save acknowledgement')
 try:
  wait(lambda:seen('scripted') and seen('v0.99.2'), 'ready')
  send('FOLLOWUP negative control\r');wait(lambda:count('completed')==1,'negative control completion');wait(lambda:seen('INCOHERENT unknown cedar or violet DONE_FOLLOWUP'),'negative coherence control')
  out.clear()
  (d/'provider-negative-control.jsonl').write_text((d/'provider.jsonl').read_text())
  (d/'provider.jsonl').write_text('')
  if enabled:
   if restart:
    before=len(out);send('/latency settings\r');wait(lambda:b'"quietMs":1000' in out[before:],'persisted defaults loaded')
   command('/latency settings quietMs 1000','Latency live settings updated')
   command('/latency settings slowMs 1000','Latency live settings updated')
   assert (home/'.local/state/pi-response-visibility/settings.json').exists()
  send('SLOW cedar\r');wait(lambda:count('started')==1,'provider start')
  if enabled:
   command('/latency expanded','Latency live settings updated')
   send('\x1b[108;6u');wait(lambda:seen('Latency inspector'),'live inspector');send('t');send('\x1b')
  fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',24,40,0,0));os.kill(proc.pid,signal.SIGWINCH)
  wait(lambda:count('completed')==1,'slow completion')
  # A tall expanded widget can push the response out of a 24-row fullscreen viewport.
  # Restore room and require the actual rendered response, not only provider completion.
  fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',50,120,0,0));os.kill(proc.pid,signal.SIGWINCH)
  wait(lambda:seen('PROOF_COMPLETE'),'screen completion')
  send('SLOW violet\r');wait(lambda:count('started')==2,'abort start');send('\x1b');wait(lambda:count('abort')==1,'abort')
  send('FOLLOWUP recall cedar and violet\r');wait(lambda:count('completed')==2,'followup');wait(lambda:seen('COHERENT cedar violet DONE_FOLLOWUP'),'positive coherence rendered')
  answer=[e['answer'] for e in events() if e['event']=='answer'][-1]
  assert seen('COHERENT cedar violet') and answer=='COHERENT cedar violet DONE_FOLLOWUP'
  assert not any(s in answer for s in ['INCOHERENT','do not recall','unknown cedar'])
  before=len(out);send('FAST response\r');wait(lambda:count('completed')==3,'fast completion');wait(lambda:b'PROOF_COMPLETE' in out[before:],'fast response rendered')
  before=len(out);send('ERROR response\r');wait(lambda:count('completed')==4,'error completion');wait(lambda:b'SCRIPTED_FAILURE' in out[before:],'error rendered')
  if enabled:wait(lambda:b'Latency: failed' in out[before:],'failure summary')
  if enabled:
   command('/latency capture metadata','Latency live settings updated')
   send('/latency history\r');wait(lambda:seen('Latency history'),'history');send('\x1b')
   settings=json.loads((home/'.local/state/pi-response-visibility/settings.json').read_text());assert settings['quietMs']==1000
  results.append({'journey':name,'status':'passed','assertions':['readiness','completion','abort-followup-positive-negative','missing-context-negative-control','fast-response-rendered','error-rendered']+(['settings-persistence','inspector','resize','failure-summary'] if enabled else [])})
 except Exception as error:
  results.append({'journey':name,'status':'failed','error':str(error),'traceback':traceback.format_exc()});raise
 finally:
  proc.terminate()
  try:proc.wait(timeout=5)
  except subprocess.TimeoutExpired:proc.kill();proc.wait()
  pump();(d/'screen.ansi').write_bytes(out);os.close(master)
  if enabled:
   traces=home/'.local/state/pi-response-visibility/traces'
   files=list(traces.glob('*.jsonl'))
   assert files, 'No metadata trace persisted'
   assert traces.stat().st_mode & 0o777 == 0o700
   assert sum(f.stat().st_size for f in files)<=json.loads((home/'.local/state/pi-response-visibility/settings.json').read_text())['traceBytes']
   for f in files:
    assert f.stat().st_mode & 0o777 == 0o600
    data=f.read_text();assert 'cedar' not in data and 'violet' not in data and 'dummy' not in data
    for line in data.splitlines():assert 'capture' not in json.loads(line)
try:
 for mode in ['regular','fullscreen']:
  for enabled in [False,True]:journey(mode,enabled)
 def normalized(value):
  if isinstance(value,dict):return {k:normalized(v) for k,v in value.items() if k not in ['timestamp']}
  if isinstance(value,list):return [normalized(v) for v in value]
  return value
 for mode in ['regular','fullscreen']:
  captures=[]
  for enabled in [False,True]:
   events=[json.loads(x) for x in (artifacts/f'{mode}-{enabled}-False'/'provider.jsonl').read_text().splitlines()]
   captures.append(normalized(events))
  assert captures[0]==captures[1], 'Enabled/disabled provider capture differs'
 subprocess.run(['node',str(root/'bin/core.mjs'),'apply','--pi-root',str(private)],check=True)
 for mode in ['regular','fullscreen']:
  journey(mode,True,True)
  journey(mode,True,True,restart=True)
 subprocess.run(['node',str(root/'bin/core.mjs'),'rollback','--pi-root',str(private)],check=True)
 subprocess.run(['node',str(root/'bin/core.mjs'),'check','--pi-root',str(private)],check=True)
finally:
 subprocess.run(['node',str(root/'bin/core.mjs'),'rollback','--pi-root',str(private)],check=True)
 (artifacts/'outcomes.json').write_text(json.dumps(results,indent=2))
