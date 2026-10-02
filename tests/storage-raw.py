#!/usr/bin/env python3
"""Real private Pi: supported HTTP raw oversize rejection and restart policy."""
import argparse,pathlib,json,shutil,threading,http.server,time,os,pty,fcntl,termios,struct,subprocess,select,traceback
p=argparse.ArgumentParser();p.add_argument('--artifact-root',required=True);p.add_argument('--pi-root',required=True);a=p.parse_args()
r=pathlib.Path(a.artifact_root);r.mkdir(parents=True);repo=pathlib.Path(__file__).resolve().parents[1]
private=r/'private-pi';shutil.copytree(a.pi_root,private)
ext=r/'extension';shutil.copytree(repo/'src',ext/'src')
s="import { appendFileSync } from 'node:fs';\n"+(repo/'index.ts').read_text()
s=s.replace('state.current = state.observer.snapshot(); state.health = writer?.stats();','state.current = state.observer.snapshot(); state.health = writer?.stats(); appendFileSync(process.env.PROBE_LOG!, JSON.stringify({config:state.config,health:state.health,history:state.observer.history().length})+"\\n");')
(ext/'index.ts').write_text(s)
key='dummy-storage-resolved-817';credential='dummy-storage-header-619';response='RAW_STORAGE_COMPLETE';requests=[]
class Backend(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));assert self.headers['Authorization']=='Bearer '+key;assert self.headers['X-Custom-Credential']==credential
  requests.append({'body':body,'credentialHeadersVerified':True,'completed':False})
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  for delta,finish in [({'role':'assistant','content':response},None),({},'stop')]:
   chunk={'id':'fixture','object':'chat.completion.chunk','created':1,'model':'scripted','choices':[{'index':0,'delta':delta,'finish_reason':finish}], 'diagnostic':(('OVERSIZE_MARKER'+('x'*(128*1024))) if finish is None else 'small')+key+credential,'headers':{'Authorization':key,'X-Custom-Credential':credential}}
   self.wfile.write(('data: '+json.dumps(chunk)+'\n\n').encode());self.wfile.flush()
  self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush();requests[-1]['completed']=True
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Backend);threading.Thread(target=server.serve_forever,daemon=True).start();results=[]
try:
 subprocess.run(['node',str(repo/'bin/core.mjs'),'apply','--pi-root',str(private)],check=True)
 for mode in ['events','bodies']:
  d=r/mode;home=d/'home';agent=home/'agent';agent.mkdir(parents=True)
  (agent/'models.json').write_text(json.dumps({'providers':{'storage-http':{'baseUrl':f'http://127.0.0.1:{server.server_port}/v1','api':'openai-completions','apiKey':key,'headers':{'X-Custom-Credential':credential},'models':[{'id':'scripted'}]}}}))
  root=home/'.local/state/pi-response-visibility';traces=root/'traces';prior=set()
  for restart in [False,True]:
   label='restart' if restart else 'initial';probe=d/(label+'-probe.jsonl');out=bytearray();master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,150,0,0))
   cmd=['node',str(private/'dist/cli.js'),'--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-session','--no-tools','--provider','storage-http','--model','scripted','-e',str(ext/'index.ts')]
   proc=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,env={**os.environ,'HOME':str(home),'PI_CODING_AGENT_DIR':str(agent),'TERM':'xterm-256color','PROBE_LOG':str(probe)});os.close(slave)
   def probes():return [json.loads(x) for x in probe.read_text().splitlines()] if probe.exists() else []
   def wait(pred):
    end=time.monotonic()+40
    while time.monotonic()<end:
     if select.select([master],[],[],.03)[0]:
      try:out.extend(os.read(master,65536))
      except OSError:pass
     if pred():return
     if proc.poll()!=None:raise RuntimeError('Pi exited')
    raise RuntimeError('PTY timeout')
   def command(text,marker,expected=None):
    start=len(out);os.write(master,(text+'\r').encode());wait(lambda: (probes()[-1]['config'].get(expected[0])==expected[1]) if expected else marker in out[start:]);time.sleep(.1)
   try:
    wait(lambda:b'v0.99.2' in out and b'scripted' in out and probes())
    initial=probes()[0];assert initial['history']==0,'history must be session-local'
    if not restart:
     assert initial['config']['historyLimit']==50 and initial['config']['traceBytes']==100*1024*1024
     command('/latency capture '+mode,b'Latency live settings updated')
     assert b'rich capture includes sensitive prompt/output/source' in out
     command('/latency settings historyLimit 2',b'Latency live settings updated',('historyLimit',2))
     command('/latency settings traceBytes 8192',b'Latency live settings updated',('traceBytes',8192))
     command('/latency settings save',b'Latency defaults saved')
    else:
     assert initial['config']['capture']==mode and initial['config']['historyLimit']==2 and initial['config']['traceBytes']==8192
     assert prior.issubset(set(traces.glob('*.jsonl'))),'retained files missing at restart'
    count=len(requests);os.write(master,b'RAW_STORAGE_PROMPT\r');wait(lambda:len(requests)==count+1 and requests[-1]['completed']);wait(lambda:response.encode() in out);wait(lambda:any(x['history']==1 and x['health']['dropped']>0 for x in probes()))
    assert b'Diagnostics dropped: capacity reached.' in out
    wait(lambda:traces.exists() and any(traces.glob('*.jsonl')));time.sleep(.6)
    files=list(traces.glob('*.jsonl'));text=''.join(f.read_text() for f in files);total=sum(f.stat().st_size for f in files)
    assert total<=8192 and traces.stat().st_mode&0o777==0o700
    assert all(f.stat().st_mode&0o777==0o600 for f in files)
    for marker in [key,credential,'Authorization','X-Custom-Credential','OVERSIZE_MARKER']:assert marker not in text and marker.encode() not in out
    assert all(x['health']['queued']<=128 and x['history']<=2 for x in probes())
    assert probes()[-1]['history']==1, 'completed request must reach observer history'
    prior=set(files)
    (d/(label+'-inspection.json')).write_text(json.dumps({'aggregateBytes':total,'directoryMode':'0700','files':[{'path':str(f),'bytes':f.stat().st_size,'mode':oct(f.stat().st_mode&0o777)} for f in files]},indent=2))
    results.append({'mode':mode,'restart':restart,'status':'passed','assertions':['oversize-rejected-visible-safe-warning','provider-completed-once','credential-and-header-absence','aggregate<=8192','private-modes','bounded-queue-history','session-local-history','saved-config-and-retained-traces' if restart else 'runtime-defaults-50-and-100MiB']})
   finally:
    proc.terminate()
    try:proc.wait(timeout=5)
    except subprocess.TimeoutExpired:proc.kill();proc.wait()
    (d/(label+'-screen.ansi')).write_bytes(out);os.close(master)
 assert len(requests)==4 and all(x['completed'] for x in requests)
except Exception as e:
 results.append({'status':'failed','error':str(e),'traceback':traceback.format_exc()});raise
finally:
 (r/'outcomes.json').write_text(json.dumps(results,indent=2));(r/'provider-captures.json').write_text(json.dumps(requests,indent=2));server.shutdown();subprocess.run(['node',str(repo/'bin/core.mjs'),'rollback','--pi-root',str(private)],check=True)
