#!/usr/bin/env python3
"""Complete real private Pi requests in metadata/events/bodies modes with dummy auth."""
import argparse,pathlib,json,shutil,threading,http.server,time,os,pty,fcntl,termios,struct,subprocess,select
p=argparse.ArgumentParser();p.add_argument('--artifact-root',required=True);p.add_argument('--pi-root',required=True);a=p.parse_args()
r=pathlib.Path(a.artifact_root);r.mkdir(parents=True,exist_ok=True);repo=pathlib.Path(__file__).resolve().parents[1]
private=r/'private-pi';shutil.copytree(a.pi_root,private)
key='dummy-safe-resolved-key-747';credential='dummy-safe-header-929';prompt='SAFE_PROMPT_MARKER';response='SAFE_RESPONSE_MARKER'
requests=[]
class Backend(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));requests.append(body)
  assert self.headers['Authorization']=='Bearer '+key
  assert self.headers['X-Custom-Credential']==credential
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  for delta,finish in [({'role':'assistant','content':response},None),({},'stop')]:
   chunk={'id':'fixture','object':'chat.completion.chunk','created':1,'model':'scripted','choices':[{'index':0,'delta':delta,'finish_reason':finish}], 'diagnostic':key+' '+credential, 'headers':{'Authorization':key,'X-Custom-Credential':credential}}
   self.wfile.write(('data: '+json.dumps(chunk)+'\n\n').encode());self.wfile.flush()
  self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Backend);threading.Thread(target=server.serve_forever,daemon=True).start()
results=[]
try:
 subprocess.run(['node',str(repo/'bin/core.mjs'),'apply','--pi-root',str(private)],check=True)
 for mode,tui_mode in [(m,t) for m in ['metadata','events','bodies'] for t in ['regular','fullscreen']]:
  d=r/(mode+'-'+tui_mode);home=d/'home';agent=home/'agent';agent.mkdir(parents=True)
  (agent/'models.json').write_text(json.dumps({'providers':{'safe-proof':{'baseUrl':f'http://127.0.0.1:{server.server_port}/v1','api':'openai-completions','apiKey':key,'headers':{'X-Custom-Credential':credential},'models':[{'id':'scripted'}]}}}))
  master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',35,120,0,0))
  completion=d/'completion.jsonl';probe=d/'completion.ts'
  probe.write_text("import { appendFileSync } from 'node:fs';\nexport default function(pi:any) {\n pi.on('message_end', (e:any) => { if(e.message.role==='assistant') appendFileSync(process.env.SAFE_COMPLETION_LOG!, JSON.stringify({event:'message_end',stopReason:e.message.stopReason})+'\\n'); });\n pi.on('agent_end', () => appendFileSync(process.env.SAFE_COMPLETION_LOG!, JSON.stringify({event:'agent_end'})+'\\n'));\n}\n")
  cmd=['node',str(private/'dist/cli.js'),'--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-session','--tui-mode',tui_mode,'--no-tools','--provider','safe-proof','--model','scripted','-e',str(repo/'index.ts'),'-e',str(probe)]
  proc=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,env={**os.environ,'HOME':str(home),'PI_CODING_AGENT_DIR':str(agent),'TERM':'xterm-256color','SAFE_COMPLETION_LOG':str(completion)});os.close(slave);out=bytearray()
  def wait(predicate):
   end=time.monotonic()+30
   while time.monotonic()<end:
    if select.select([master],[],[],.05)[0]:
     try:out.extend(os.read(master,65536))
     except OSError:pass
    if predicate():return
    if proc.poll()!=None:raise RuntimeError('Pi exited')
   raise RuntimeError('PTY timeout')
  try:
   wait(lambda:b'v0.99.2' in out and b'scripted' in out)
   os.write(master,('/latency capture '+mode+'\r').encode());wait(lambda:b'Latency live settings updated' in out)
   if mode!='metadata':assert b'rich capture includes sensitive prompt/output/source' in out
   os.write(master,(prompt+'\r').encode());wait(lambda:response.encode() in out)
   def completed():
    if not completion.exists():return False
    events=[json.loads(line) for line in completion.read_text().splitlines()]
    return {'event':'message_end','stopReason':'stop'} in events and {'event':'agent_end'} in events
   wait(completed)
   traces=home/'.local/state/pi-response-visibility/traces'
   wait(lambda:traces.exists() and any(traces.glob('*.jsonl')))
   time.sleep(.5)
   text=''.join(f.read_text() for f in traces.glob('*.jsonl'))
   assert key not in text and credential not in text and 'X-Custom-Credential' not in text and 'Authorization' not in text
   assert key.encode() not in out and credential.encode() not in out
   assert (prompt in text)==(mode=='bodies'),(mode,text)
   assert (response in text)==(mode!='metadata'),(mode,text)
   assert all(f.stat().st_mode&0o777==0o600 for f in traces.glob('*.jsonl'))
   results.append({'mode':mode,'tui_mode':tui_mode,'status':'passed','completed':True,'safe_capture':True,'prompt_present':prompt in text,'response_present':response in text})
  finally:
   proc.terminate()
   try:proc.wait(timeout=5)
   except subprocess.TimeoutExpired:proc.kill();proc.wait()
   (d/'screen.ansi').write_bytes(out);os.close(master)
 (r/'provider-captures.json').write_text(json.dumps(requests,indent=2))
 assert key not in json.dumps(requests) and credential not in json.dumps(requests), 'Credential leaked into model context'
 assert len(requests)==6 and all(request==requests[0] for request in requests)
 subprocess.run(['node',str(repo/'bin/core.mjs'),'rollback','--pi-root',str(private)],check=True)
 (r/'outcomes.json').write_text(json.dumps({'status':'passed','cases':results,'same_request_bodies':True},indent=2))
finally:
 server.shutdown()
 subprocess.run(['node',str(repo/'bin/core.mjs'),'rollback','--pi-root',str(private)],check=True)
