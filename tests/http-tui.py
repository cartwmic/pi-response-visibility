#!/usr/bin/env python3
"""Built-in openai-completions, actual private Pi PTY, paired retry captures."""
import argparse,pathlib,json,shutil,threading,http.server,time,os,pty,fcntl,termios,struct,subprocess,select,re
p=argparse.ArgumentParser();p.add_argument('--artifact-root',required=True);p.add_argument('--pi-root',required=True);a=p.parse_args()
r=pathlib.Path(a.artifact_root);r.mkdir(parents=True,exist_ok=True);repo=pathlib.Path(__file__).resolve().parents[1]
private=r/'private-pi';shutil.copytree(a.pi_root,private,dirs_exist_ok=True)
records=[]
class Backend(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  body=self.rfile.read(int(self.headers['Content-Length']));records.append({'body':json.loads(body),'headers':dict(self.headers)})
  if len(records)==1:
   self.send_response(503);self.send_header('Content-Type','application/json');self.send_header('Retry-After','0');self.end_headers();self.wfile.write(b'{"error":{"message":"scripted retry"}}');return
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('x-request-id','fixture-request');self.send_header('x-ratelimit-remaining-requests','8');self.end_headers()
  time.sleep(2)
  for delta,finish in [({'role':'assistant','content':'HTTP_PROOF_COMPLETE'},None),({},'stop')]:
   chunk={'id':'fixture','object':'chat.completion.chunk','created':1,'model':'scripted','choices':[{'index':0,'delta':delta,'finish_reason':finish}]}
   self.wfile.write(('data: '+json.dumps(chunk)+'\n\n').encode());self.wfile.flush()
  self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Backend);threading.Thread(target=server.serve_forever,daemon=True).start()
results=[]
try:
 for patched in [False,True]:
  if patched:subprocess.run(['node',str(repo/'bin/core.mjs'),'apply','--pi-root',str(private)],check=True)
  for enabled in [False,True]:
   records.clear();d=r/f'{patched}-{enabled}';d.mkdir(exist_ok=True);home=d/'home';agent=home/'agent';agent.mkdir(parents=True,exist_ok=True)
   (agent/'models.json').write_text(json.dumps({'providers':{'http-proof':{'baseUrl':f'http://127.0.0.1:{server.server_port}/v1','api':'openai-completions','apiKey':'dummy-http-credential','models':[{'id':'scripted'}]}}}))
   master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',35,120,0,0))
   cmd=['node',str(private/'dist/cli.js'),'--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-session','--no-tools','--provider','http-proof','--model','scripted']
   if enabled:cmd+=['-e',str(repo/'index.ts')]
   proc=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,env={**os.environ,'HOME':str(home),'PI_CODING_AGENT_DIR':str(agent),'TERM':'xterm-256color'});os.close(slave);out=bytearray()
   def wait(predicate):
    end=time.monotonic()+35
    while time.monotonic()<end:
     if select.select([master],[],[],.05)[0]:
      try:out.extend(os.read(master,65536))
      except OSError:pass
     if predicate():return
     if proc.poll()!=None:raise RuntimeError('Pi exited')
    raise RuntimeError('PTY timeout')
   try:
    wait(lambda:b'v0.99.2' in out and b'scripted' in out)
    os.write(master,b'HTTP fixture prompt\r');wait(lambda:len(records)>=2)
    if enabled and patched:
     os.write(master,b'\x1b[108;6u');wait(lambda:b'Observed HTTP headers' in out)
     assert b'status 200' in out and b'request body bytes unavailable' not in out, 'Inspector lacks measured status/body bytes'
     wait(lambda:b'x-request-id=fixture-request' in out and b'x-ratelimit-remaining-requests=8' in out)
     os.write(master,b'\x1b')
    wait(lambda:b'HTTP_PROOF_COMPLETE' in out)
    # TUI rendered completion, not merely the backend accepting a request.
    time.sleep(.4)
    if enabled and patched:
     offset=len(out);os.write(master,b'\x1b[108;6u')
     wait(lambda:b'Latency inspector' in out[offset:]);os.write(master,b'\x1b[B')
     wait(lambda:b'Observed HTTP activity' in out[offset:] and re.search(rb'First parsed event [0-9]+\.[0-9]s',out[offset:]))
     assert b'dummy-http-credential' not in out, 'Credential reached inspector'
     os.write(master,b'\x1b')
    results.append({'patched':patched,'enabled':enabled,'status':'passed','attempts':len(records),'output':'HTTP_PROOF_COMPLETE','inspector':enabled and patched})
    (d/'captures.json').write_text(json.dumps(records,indent=2))
   finally:
    proc.terminate()
    try:proc.wait(timeout=5)
    except subprocess.TimeoutExpired:proc.kill();proc.wait()
    (d/'screen.ansi').write_bytes(out);os.close(master)
 for case in results:assert case['attempts']==2
 captures=[json.loads((r/f'{p}-{e}'/'captures.json').read_text()) for p in [False,True] for e in [False,True]]
 assert all(c==captures[0] for c in captures), 'Body/header captures changed'
 subprocess.run(['node',str(repo/'bin/core.mjs'),'apply','--pi-root',str(private)],check=True)
 subprocess.run(['node',str(repo/'bin/core.mjs'),'rollback','--pi-root',str(private)],check=True)
 subprocess.run(['node',str(repo/'bin/core.mjs'),'check','--pi-root',str(private)],check=True)
 (r/'outcomes.json').write_text(json.dumps({'status':'passed','cases':results,'paired_body_headers_output_retry':True},indent=2))
finally:server.shutdown()
