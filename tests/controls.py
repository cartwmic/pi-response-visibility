#!/usr/bin/env python3
"""Real Pi controls/lifecycle proof. Private passive scalar probes; no host changes."""
import argparse,pathlib,json,os,pty,fcntl,termios,struct,subprocess,select,time,shutil,traceback,signal
p=argparse.ArgumentParser();p.add_argument('--artifact-root',required=True);p.add_argument('--pi-root',required=True);a=p.parse_args()
r=pathlib.Path(a.artifact_root);r.mkdir(parents=True,exist_ok=True)
if (r/'outcomes.json').exists():raise SystemExit('Refusing to overwrite retained outcomes; choose a fresh artifact root')
repo=pathlib.Path(__file__).resolve().parents[1]
private=r/'private-pi';shutil.copytree(a.pi_root,private,dirs_exist_ok=True)
ext=r/'extension';shutil.copytree(repo/'src',ext/'src',dirs_exist_ok=True)
s=(repo/'index.ts').read_text()
s="import { appendFileSync } from 'node:fs';\n"+s
s=s.replace('export default function (pi: ExtensionAPI) {','''export default function (pi: ExtensionAPI) {
  const instance = ((globalThis as any).__controlsInstance = ((globalThis as any).__controlsInstance ?? 0) + 1);
  const g = globalThis as any;
  function contextProbe(ctx: any) { (g.__controlsContexts ??= []).push({instance,ref:new WeakRef(ctx)}); }
  function probe(event: string) { g.gc?.(); appendFileSync(process.env.PROBE_LOG!, JSON.stringify({event,instance,subscribers:g.__controlsSubscriptions,contexts:(g.__controlsContexts ?? []).filter((x:any)=>x.ref.deref()).map((x:any)=>x.instance),config:state.config,current:state.observer.snapshot(),history:state.observer.history(),ui:!!ui,timer:!!timer,writer:!!writer,subscription:!!unsubscribe,overlay:!!closeOverlay,health:writer?.stats()})+"\\n"); }
''')
s=s.replace("pi.on('session_start', async (_event, ctx) => {", "pi.on('session_start', async (_event, ctx) => { contextProbe(ctx);")
s=s.replace('async function inspect(ctx: any, history = false) {', 'async function inspect(ctx: any, history = false) { contextProbe(ctx);')
s=s.replace('handler: async (args, ctx) => {','handler: async (args, ctx) => { contextProbe(ctx);')
s=s.replace('requestRender?.();','probe("render"); requestRender?.();',1)
s=s.replace('await old?.close();','await old?.close(); probe("stopped");',1)
s=s.replace('if (ui) timer = setInterval(render, 250);','if (ui) timer = setInterval(render, 250); probe("started");')
s=s.replace("if (r?.summary && state.config.preset !== 'off')",'probe("completed"); if (r?.summary && state.config.preset !== \'off\')')
s=s.replace('ui?.notify(`Latency: ${r.status} · ${seconds(r.elapsedMs)}`, \'info\');','{ probe("summary"); ui?.notify(`Latency: ${r.status} · ${seconds(r.elapsedMs)}`, \'info\'); }')
(ext/'index.ts').write_text(s)
f=(repo/'tests/fixtures/provider.ts').read_text().replace("log('request',{messages:context.messages,tools:context.tools,payload:{test:true}});","log('request',{messages:context.messages,tools:context.tools,payload:{test:true},systemPrompt:context.systemPrompt,model:{id:model.id,provider:model.provider},defaults:{temperature:options.temperature,maxTokens:options.maxTokens,reasoning:options.reasoning,transport:options.transport,serviceTier:options.serviceTier,reasoningEffort:options.reasoningEffort,maxRetryDelayMs:options.maxRetryDelayMs}});")
f=f.replace('(slow?60:1)',"(text.includes('CONTROL_WAIT')?600:slow?60:1)")
(ext/'provider.ts').write_text(f)
subprocess.run(['node',str(repo/'bin/core.mjs'),'apply','--pi-root',str(private)],check=True)
bridge_path=private/'dist/core/response-visibility-bridge.mjs';bridge_original=bridge_path.read_text()
bridge_path.write_text(bridge_original.replace('const listeners = new Set();','const listeners = new Set(); globalThis.__controlsSubscriptions = 0;').replace('listeners.add(listener); return () => listeners.delete(listener);','listeners.add(listener); globalThis.__controlsSubscriptions = listeners.size; return () => { listeners.delete(listener); globalThis.__controlsSubscriptions = listeners.size; };'))
results=[]
def journey(mode,restart=False):
 d=r/(mode+('-restart' if restart else ''));d.mkdir(exist_ok=True)
 home=r/mode/'home';agent=home/'agent';agent.mkdir(parents=True,exist_ok=True)
 master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',45,160,0,0))
 proc=subprocess.Popen(['node','--expose-gc',str(private/'dist/cli.js'),'--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-session','--no-tools','--tui-mode',mode,'-e',str(ext/'provider.ts'),'-e',str(ext/'index.ts'),'--provider','visibility-proof','--model','scripted'],stdin=slave,stdout=slave,stderr=slave,env={**os.environ,'HOME':str(home),'PI_CODING_AGENT_DIR':str(agent),'TERM':'xterm-256color','PROOF_LOG':str(d/'provider.jsonl'),'PROBE_LOG':str(d/'probe.jsonl')});os.close(slave);out=bytearray();screens=[]
 def logs(name):
  path=d/name;return [json.loads(x) for x in path.read_text().splitlines()] if path.exists() else []
 def wait(pred,label):
  end=time.monotonic()+30
  while time.monotonic()<end:
   if select.select([master],[],[],.04)[0]:
    try:out.extend(os.read(master,65536))
    except OSError:pass
   if pred():return
   if proc.poll()!=None:raise RuntimeError('Pi exited '+label)
  raise RuntimeError('timeout '+label)
 def send(text):os.write(master,text.encode())
 def screen(label,start):
  path=d/(str(len(screens))+'-'+label+'.ansi');path.write_bytes(out[start:]);screens.append(str(path))
 def cmd(text,marker='Latency live settings updated'):
  start=len(out);before=len(logs('probe.jsonl'));send(text+'\r')
  if marker=='Latency live settings updated':
   parts=text.split();key=parts[1]
   def applied():
    c=probe()['config']
    if key in ['off','compact','expanded','timeline']:return c['preset']==key
    if key=='sections':return c['sections'][parts[2]]==(parts[3]=='on')
    if key=='capture':return c['capture']==parts[2]
    if key=='settings':return c[parts[2]]==int(parts[3])
    return False
   wait(lambda:len(logs('probe.jsonl'))>before and applied(),text)
  else:wait(lambda:marker.encode() in out[start:],text)
  screen(text.replace('/','').replace(' ','-'),start)
 def probe():return logs('probe.jsonl')[-1]
 def theme_saved():
  try:return json.loads((agent/'settings.json').read_text()).get('theme')=='dark'
  except (FileNotFoundError,json.JSONDecodeError):return False
 def turn(text,status='success',summary=False):
  count=sum(x['event']=='completed' for x in logs('probe.jsonl'));summaries=sum(x['event']=='summary' for x in logs('probe.jsonl'));start=len(out);send(text+'\r')
  wait(lambda:sum(x['event']=='completed' for x in logs('probe.jsonl'))==count+1,'turn '+text)
  wait(lambda:(b'SCRIPTED_FAILURE' if status=='failed' else b'PROOF_COMPLETE') in out[start:],'visible completion')
  wait(lambda:probe()['current'] is None,'idle after completion')
  if summary:wait(lambda:('Latency: '+status).encode() in out[start:],'summary '+status)
  else:assert sum(x['event']=='summary' for x in logs('probe.jsonl'))==summaries, 'new fast summary notification'
  completed=[x for x in logs('probe.jsonl') if x['event']=='completed'][-1];assert completed['history'][-1]['status']==status
  screen(text.replace(' ','-'),start)
 try:
  wait(lambda:b'v0.99.2' in out and b'scripted' in out and any(x['event']=='started' for x in logs('probe.jsonl')),'ready')
  if restart:
   expected=json.loads((home/'.local/state/pi-response-visibility/settings.json').read_text());assert probe()['config']==expected
   cmd('/latency settings','"historyLimit":2');turn('FAST restart');results.append({'mode':mode,'restart':True,'status':'passed','assertions':['saved-complete-config-loaded','completed-request-after-restart']});return
  turn('FAST baseline')
  send('SLOW CONTROL_WAIT\r');wait(lambda:probe()['current'] is not None,'live controls request')
  for preset in ['off','compact','expanded','timeline']:
   cmd('/latency '+preset);wait(lambda:probe()['config']['preset']==preset,'preset state')
  for section in ['timing','transport','provider','health']:
   for enabled in ['off','on']:
    cmd('/latency sections '+section+' '+enabled);wait(lambda:probe()['config']['sections'][section]==(enabled=='on'),'section state')
  for key,val in [('quietMs',1000),('slowMs',1000),('historyLimit',2),('traceBytes',8192)]:cmd('/latency settings '+key+' '+str(val));wait(lambda:probe()['config'][key]==val,'live setting')
  for capture in ['off','metadata']:cmd('/latency capture '+capture);wait(lambda:probe()['config']['capture']==capture,'capture setting')
  # Command and shortcut both open the actual overlay; every overlay key is driven.
  start=len(out);send('/latency inspect\r');wait(lambda:b'Latency inspector' in out[start:],'inspector');screen('inspector',start);wait(lambda:probe()['overlay'],'inspector registered')
  for key in ['p','t','r','v','h']:
   before=probe()['config'];send(key);wait(lambda:probe()['config']!=before,'inspector '+key)
  start=len(out);send('\x1b[A');wait(lambda:b'Latency history' in out[start:],'history arrow');send('\x1b[B');send('l');send('\x1b');wait(lambda:not probe()['overlay'],'overlay closed')
  # Restore known live configuration, independent of inspector mutations.
  cmd('/latency expanded')
  for section in ['timing','transport','provider','health']:cmd('/latency sections '+section+' on')
  start=len(out);send('\x1b[108;6u');wait(lambda:b'Latency inspector' in out[start:],'shortcut');screen('shortcut',start);wait(lambda:probe()['overlay'],'shortcut registered');send('\x1b');wait(lambda:not probe()['overlay'],'shortcut close');time.sleep(.3)
  # Actual Pi settings selector: theme selection, not a direct renderer call.
  start=len(out);send('/settings\r');wait(lambda:b'Type to search' in out[start:],'Pi settings');send('theme');wait(lambda:b'Theme' in out[start:],'theme setting');send('\r');wait(lambda:b'Select a theme' in out[start:],'theme submenu');send('\x1b[B');time.sleep(.2);send('\x1b[B');time.sleep(.2);send('\r');wait(theme_saved,'dark theme saved');screen('theme-selector',start)
  # Drain PTY output while native settings closes. Sleeping without reading can
  # leave the redraw blocked on a full PTY and feed the command to its search box.
  start=len(out);send('\x1b')
  drained=time.monotonic()
  wait(lambda:time.monotonic()-drained>.4,'native settings escape input settled')
  cmd('/latency compact')
  wait(lambda:probe()['current'] and probe()['current']['quiet'] is not None,'live quiet interval')
  assert probe()['current']['quiet']['absent']=='content progress'
  start=len(out);send('\x1b');wait(lambda:sum(x['event']=='abort' for x in logs('provider.jsonl'))==1,'controls request abort');wait(lambda:probe()['current'] is None,'controls abort idle');screen('live-controls-quiet-abort',start)
  fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',24,40,0,0));os.kill(proc.pid,signal.SIGWINCH)
  turn('SLOW cedar',summary=True)
  fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',45,160,0,0));os.kill(proc.pid,signal.SIGWINCH)
  start=len(out);send('SLOW violet\r');wait(lambda:probe()['current'] is not None,'abort active');send('\x1b');wait(lambda:sum(x['event']=='abort' for x in logs('provider.jsonl'))==2,'provider abort');wait(lambda:b'Latency: aborted' in out[start:],'abort summary');screen('abort',start)
  start=len(out);send('FOLLOWUP recall cedar and violet\r');wait(lambda:b'COHERENT cedar violet DONE_FOLLOWUP' in out[start:],'coherent followup');wait(lambda:probe()['current'] is None,'followup idle')
  turn('FAST controls');turn('ERROR controls','failed',True)
  assert probe()['health']['failures']==0, 'provider failure confused with recorder failure'
  assert any(x['event']=='completed' and x.get('reason')=='error' for x in logs('provider.jsonl'))
  assert all(len(x['history'])<=2 for x in logs('probe.jsonl') if x['config']['historyLimit']==2)
  start=len(out);send('/latency history\r');wait(lambda:b'Latency history 1/2' in out[start:],'bounded history screen');screen('bounded-history',start);wait(lambda:probe()['overlay'],'history registered');send('\x1b');wait(lambda:not probe()['overlay'],'history close');time.sleep(.2)
  cmd('/latency settings save','Latency defaults saved')
  # Reload: old extension must report a fully stopped state, then exactly one new owner.
  old=probe()['instance'];start=len(out);send('/reload\r');wait(lambda:any(x['event']=='started' and x['instance']>old for x in logs('probe.jsonl')),'reload start')
  stopped=[x for x in logs('probe.jsonl') if x['event']=='stopped' and x['instance']==old][-1]
  assert stopped['subscribers']==0
  assert stopped['current'] is None and not any(stopped[k] for k in ['ui','timer','writer','subscription','overlay'])
  new=probe()['instance'];assert probe()['subscribers']==1;assert new==old+1 and probe()['current'] is None and probe()['history']==[]
  turn('FAST reload');wait(lambda:old not in probe()['contexts'],'old ExtensionContexts collected');assert all(x['instance']==new for x in logs('probe.jsonl')[logs('probe.jsonl').index(stopped)+1:] if x['event']=='completed')
  # /new triggers session replacement and must clear request/history before next completion.
  starts=sum(x['event']=='started' for x in logs('probe.jsonl'));send('/new\r');wait(lambda:sum(x['event']=='started' for x in logs('probe.jsonl'))==starts+1,'new session');assert probe()['current'] is None and probe()['history']==[]
  turn('FAST new-session')
  requests=[x for x in logs('provider.jsonl') if x['event']=='request'];assert len(requests)==9, len(requests)
  assert all(x['model']==requests[0]['model'] and x.get('systemPrompt')==requests[0].get('systemPrompt') and x['defaults']==requests[0]['defaults'] and x.get('tools')==requests[0].get('tools') for x in requests)
  assert not any('/latency' in json.dumps(x['messages']) or '/settings' in json.dumps(x['messages']) for x in requests)
  assert not any(x['event']=='fixture-error' for x in logs('provider.jsonl'))
  results.append({'mode':mode,'status':'passed','requests':len(requests),'assertions':['all-presets-sections-live-settings','inspector-history-shortcut','narrow-completion','theme-selector','fast-no-summary','slow-error-abort-summary','provider-failure-not-recorder','coherent-abort-followup','bounded-history','reload-single-new-owner-old-resources-cleared','session-replacement-cleared','commands-excluded-from-context-model-defaults-unchanged']})
 finally:
  # SIGTERM does not promise extension shutdown; Pi's own /quit does.
  send('/quit\r')
  try:wait(lambda:proc.poll()!=None,'graceful shutdown')
  except Exception:
   proc.terminate()
   try:proc.wait(timeout=5)
   except subprocess.TimeoutExpired:proc.kill();proc.wait()
  (d/'screen.ansi').write_bytes(out);(d/'screens.json').write_text(json.dumps(screens,indent=2));os.close(master)
  stopped=[x for x in logs('probe.jsonl') if x['event']=='stopped'];assert stopped and stopped[-1]['subscribers']==0 and not any(stopped[-1][k] for k in ['ui','timer','writer','subscription','overlay'])
try:
 for mode in ['regular','fullscreen']:journey(mode);journey(mode,True)
except Exception as e:
 results.append({'status':'failed','error':str(e),'traceback':traceback.format_exc()});raise
finally:
 (r/'outcomes.json').write_text(json.dumps(results,indent=2));bridge_path.write_text(bridge_original);subprocess.run(['node',str(repo/'bin/core.mjs'),'rollback','--pi-root',str(private)],check=True)
