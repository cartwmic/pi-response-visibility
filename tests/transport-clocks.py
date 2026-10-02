#!/usr/bin/env python3
"""Real Pi delayed connection, measured registration and lifecycle-only silence."""
import argparse,pathlib,os,pty,fcntl,termios,struct,subprocess,time,select,json
p=argparse.ArgumentParser();p.add_argument('--artifact-root',required=True);p.add_argument('--bootstrap',required=True);p.add_argument('--mode',required=True);a=p.parse_args()
d=pathlib.Path(a.artifact_root);repo=pathlib.Path(__file__).resolve().parents[1]
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',45,150,0,0))
proc=subprocess.Popen(['node',a.bootstrap,'--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-session','--no-tools','--tui-mode',a.mode,'-e',str(repo/'index.ts'),'--provider','codex-clock','--model','scripted'],stdin=slave,stdout=slave,stderr=slave,cwd=d/'home',env={**os.environ,'HOME':str(d/'home'),'PI_CODING_AGENT_DIR':str(d/'home/agent'),'TERM':'xterm-256color'});os.close(slave);out=bytearray()
def wait(pred,label):
 end=time.monotonic()+30
 while time.monotonic()<end:
  if select.select([master],[],[],.03)[0]:
   try:out.extend(os.read(master,65536))
   except OSError:pass
  if pred():return
  if proc.poll()!=None:raise RuntimeError('Pi exited '+label)
 raise RuntimeError('timeout '+label)
def command(s,marker):
 start=len(out);os.write(master,(s+'\r').encode());wait(lambda:marker.encode() in out[start:],s)
def traces():
 return [json.loads(line) for f in (d/'home/.local/state/pi-response-visibility/traces').glob('*.jsonl') for line in f.read_text().splitlines()]
try:
 wait(lambda:b'v0.99.2' in out or b'Trust project folder?' in out,'startup boundary')
 if b'Trust project folder?' in out:os.write(master,b'\x1b[B\x1b[B\r') # trust only this owned test session
 wait(lambda:b'v0.99.2' in out and b'scripted' in out,'ready')
 command('/latency settings quietMs 600','Latency live settings updated')
 command('/latency settings save','Latency defaults saved')
 command('/latency expanded','Latency live settings updated')
 os.write(master,b'connection clock fixture\r')
 wait(lambda:b'Quiet: connecting, no phase progress' in out,'connection warning')
 os.write(master,b'\x1b[108;6u');wait(lambda:b'Latency inspector' in out,'responsive inspector')
 os.write(master,b'\x1b')
 wait(lambda:b'Quiet: waiting, no content progress' in out,'lifecycle warning')
 wait(lambda:b'TRANSPORT_CLOCK_COMPLETE' in out,'completed visible response')
 wait(lambda:any(x.get('kind')=='complete' for x in traces()),'recorded completion')
 t=traces();complete=next(x for x in reversed(t) if x.get('kind')=='complete');assert complete['status']=='success'
 transports=[x['transport'] for x in t if x.get('kind')=='transport' and x.get('transport')]
 connections=[x for x in transports if x['stage']=='connection'];registrations=[x for x in transports if x['stage']=='registration']
 assert connections and any(x.get('durationMs',0)>=1300 for x in connections)
 assert registrations and all(x['transport']=='websocket' for x in registrations)
 assert complete['elapsedMs']>=4000 and complete['contents']>=9
 assert b'(no intervention)' in out and b'Local diagnostics:' in out
 assert b'hung' not in out.lower()
 (d/'assertions.json').write_text(json.dumps({'status':'passed','completion':complete,'connection':connections,'registration':registrations,'assertions':['delayed-native-connection','phase-aware-connecting-warning','actual-registration-observed','lifecycle-only-content-silence','inspector-responsive-during-connection','completed-visible-unchanged-backend-output']},indent=2))
finally:
 proc.terminate()
 try:proc.wait(timeout=5)
 except subprocess.TimeoutExpired:proc.kill();proc.wait()
 (d/'screen.ansi').write_bytes(out);os.close(master)
