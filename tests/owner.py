#!/usr/bin/env python3
"""Actual owner source wrapper -> private Pi completed request -> exact rollback."""
import argparse, pathlib, shutil, os, json, subprocess, hashlib, pty, fcntl, termios, struct, select, time
p=argparse.ArgumentParser();p.add_argument('--artifact-root',required=True);p.add_argument('--pi-root',required=True);p.add_argument('--wrapper',default=os.environ.get('PROOF_OWNER_WRAPPER'));a=p.parse_args()
assert a.wrapper, 'Provide --wrapper or PROOF_OWNER_WRAPPER (actual owner source)'
r=pathlib.Path(a.artifact_root);r.mkdir(parents=True);repo=pathlib.Path(__file__).resolve().parents[1];wrapper=pathlib.Path(a.wrapper).resolve()
package=pathlib.Path(os.environ.get('PROOF_PACKAGE_ROOT',str(repo))).resolve()
private=r/'private-pi';shutil.copytree(a.pi_root,private)
def digest():return {str(f.relative_to(private)):hashlib.sha256(f.read_bytes()).hexdigest() for f in private.rglob('*') if f.is_file() and 'dist' in f.parts}
stock=digest();rows=[]
(r/'wrapper-identity.json').write_text(json.dumps({'path':str(wrapper),'sha256':hashlib.sha256(wrapper.read_bytes()).hexdigest()},indent=2))
for profile,mode in [(p,m) for p in ['personal','axon-work-computer'] for m in ['regular','fullscreen']]:
 d=r/(profile+'-'+mode);d.mkdir();home=d/'home';home.mkdir()
 env={**os.environ,'HOME':str(home),'PI_CODING_AGENT_DIR':str(home/'agent'),'TERM':'xterm-256color','PROOF_LOG':str(d/'provider.jsonl'),'PI_CHEZMOI_PROFILE':profile,'PI_ROOT':str(private),'PI_RESPONSE_VISIBILITY_HELPER':str(package/'bin/core.mjs')}
 def action(name):
  result=subprocess.run(['node',str(wrapper),name],env=env,text=True,capture_output=True)
  with (d/'wrapper.log').open('a') as f:f.write(name+'\n'+result.stdout+result.stderr)
  assert result.returncode==0,result.stderr
  return json.loads(result.stdout)
 proc=None;out=bytearray();master=None
 try:
  assert action('apply')['state']=='applied';action('check');assert digest()!=stock
  master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',30,100,0,0))
  proc=subprocess.Popen(['node',str(private/'dist/cli.js'),'--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-session','--tui-mode',mode,'-e',str(repo/'tests/fixtures/provider.ts'),'-e',str(package/'index.ts'),'--provider','visibility-proof','--model','scripted','--no-tools'],env=env,stdin=slave,stdout=slave,stderr=slave);os.close(slave)
  def wait(test):
   end=time.monotonic()+40
   while time.monotonic()<end:
    if select.select([master],[],[],.05)[0]:
     try:out.extend(os.read(master,65536))
     except OSError:pass
    if test():return
    assert proc.poll() is None,'Pi exited'
   raise AssertionError('Pi completion timeout')
  wait(lambda:b'v0.99.2' in out and b'scripted' in out);os.write(master,b'FAST owner wrapper completion\r')
  wait(lambda:(d/'provider.jsonl').exists() and any(json.loads(x)['event']=='completed' for x in (d/'provider.jsonl').read_text().splitlines()));wait(lambda:b'PROOF_COMPLETE' in out)
 finally:
  if proc:
   proc.terminate()
   try:proc.wait(timeout=5)
   except subprocess.TimeoutExpired:proc.kill();proc.wait()
  (d/'screen.ansi').write_bytes(out)
  if master is not None:os.close(master)
  assert action('rollback')['state']=='stock';action('check');assert digest()==stock
 rows.append({'case_id':'owner-'+profile+'-'+mode,'status':'passed','assertions':['actual-owner-wrapper-apply','private-Pi-provider-completed','rendered-PROOF_COMPLETE','byte-identical-rollback']})
(r/'outcomes.json').write_text(json.dumps(rows,indent=2))
