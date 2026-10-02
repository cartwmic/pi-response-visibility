#!/usr/bin/env python3
"""Unpatched actual Pi: stock numeric HTTP status in inspector/history/default trace."""
import argparse, pathlib, json, shutil, threading, http.server, time, os, pty, fcntl, termios, struct, subprocess, select
p=argparse.ArgumentParser();p.add_argument('--artifact-root',required=True);p.add_argument('--pi-root',required=True);a=p.parse_args()
r=pathlib.Path(a.artifact_root);r.mkdir(parents=True,exist_ok=True);repo=pathlib.Path(__file__).resolve().parents[1]
private=r/'private-pi';shutil.copytree(a.pi_root,private,dirs_exist_ok=True)
subprocess.run(['node',str(repo/'bin/core.mjs'),'check','--pi-root',str(private)],check=True)
records=[]
class Backend(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  records.append({'body':json.loads(self.rfile.read(int(self.headers['Content-Length']))),'headers':dict(self.headers)})
  if len(records)==1:
   self.send_response(503);self.send_header('Content-Type','application/json');self.send_header('Retry-After','0');self.end_headers();self.wfile.write(b'{"error":{"message":"scripted retry"}}');return
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Authorization','dummy-response-secret');self.end_headers();time.sleep(2)
  for delta,finish in [({'role':'assistant','content':'STOCK_STATUS_COMPLETE'},None),({},'stop')]:
   chunk={'id':'fixture','object':'chat.completion.chunk','created':1,'model':'scripted','choices':[{'index':0,'delta':delta,'finish_reason':finish}]}
   self.wfile.write(('data: '+json.dumps(chunk)+'\n\n').encode());self.wfile.flush()
  self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Backend);threading.Thread(target=server.serve_forever,daemon=True).start();results=[];captures=[]
try:
 for mode in ['regular','fullscreen']:
  for enabled in [False,True]:
   records.clear();d=r/f'{mode}-{enabled}';d.mkdir(exist_ok=True);home=d/'home';agent=home/'agent';agent.mkdir(parents=True,exist_ok=True)
   (agent/'models.json').write_text(json.dumps({'providers':{'http-proof':{'baseUrl':f'http://127.0.0.1:{server.server_port}/v1','api':'openai-completions','apiKey':'dummy-http-credential','models':[{'id':'scripted'}]}}}))
   master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,140,0,0))
   cmd=['node',str(private/'dist/cli.js'),'--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-session','--no-tools','--tui-mode',mode,'--provider','http-proof','--model','scripted']
   if enabled:cmd+=['-e',str(repo/'index.ts')]
   proc=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,env={**os.environ,'HOME':str(home),'PI_CODING_AGENT_DIR':str(agent),'TERM':'xterm-256color'});os.close(slave);out=bytearray()
   def wait(predicate,label):
    end=time.monotonic()+30
    while time.monotonic()<end:
     if select.select([master],[],[],.04)[0]:
      try:out.extend(os.read(master,65536))
      except OSError:pass
     if predicate():return
     if proc.poll()!=None:raise RuntimeError('Pi exited: '+label)
    raise AssertionError('Timeout: '+label)
   try:
    wait(lambda:b'v0.99.2' in out and b'scripted' in out,'readiness');os.write(master,b'HTTP fixture prompt\r');wait(lambda:len(records)==2,'native retry')
    if enabled:
     start=len(out);os.write(master,b'\x1b[108;6u');wait(lambda:b'Latency inspector' in out[start:],'inspector')
     wait(lambda:b'status 200' in out[start:],'stock status in live inspector')
     assert b'request body bytes unavailable' in out[start:]
     os.write(master,b'\x1b')
    wait(lambda:b'STOCK_STATUS_COMPLETE' in out,'completed output')
    if enabled:
     traces=home/'.local/state/pi-response-visibility/traces'
     def completed():
      rows=[]
      for f in traces.glob('**/*.jsonl'):
       rows += [json.loads(x) for x in f.read_text().splitlines()]
      return [x for x in rows if x.get('kind')=='complete' and x.get('status')=='success']
     wait(lambda:bool(completed()),'default trace completion');row=completed()[-1];assert row['transport']['status']==200
     start=len(out);os.write(master,b'/latency history\r');wait(lambda:b'Latency history' in out[start:] and b'status 200' in out[start:],'completed history status');os.write(master,b'\x1b')
     assert b'dummy-http-credential' not in out and b'dummy-response-secret' not in out
     for f in traces.glob('**/*.jsonl'):
      assert 'dummy-http-credential' not in f.read_text() and 'dummy-response-secret' not in f.read_text()
    captures.append(list(records));assert len(records)==2
    (d/'captures.json').write_text(json.dumps(records,indent=2));results.append({'mode':mode,'enabled':enabled,'status':'passed','attempts':2,'output':'STOCK_STATUS_COMPLETE','stock_status_inspector_history_trace':enabled})
   finally:
    proc.terminate()
    try:proc.wait(timeout=5)
    except subprocess.TimeoutExpired:proc.kill();proc.wait()
    (d/'screen.ansi').write_bytes(out);os.close(master)
 assert all(c==captures[0] for c in captures),'request/retry changed'
 (r/'outcomes.json').write_text(json.dumps({'status':'passed','cases':results,'request_header_body_output_retry_equivalence':True},indent=2))
except Exception as error:
 (r/'outcomes.json').write_text(json.dumps({'status':'failed','cases':results,'error':str(error)},indent=2));raise
finally:server.shutdown()
