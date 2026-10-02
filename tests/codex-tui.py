#!/usr/bin/env python3
"""Reusable actual-Pi PTY completion driver; backend is owned by caller."""
import argparse,os,pty,fcntl,termios,struct,subprocess,select,time,pathlib
p=argparse.ArgumentParser();p.add_argument('--home',required=True);p.add_argument('--bootstrap',required=True);p.add_argument('--artifact',required=True);p.add_argument('--extension');p.add_argument('--mode',choices=['regular','fullscreen'],default='regular');a=p.parse_args()
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',35,120,0,0))
cmd=['node',a.bootstrap,'--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-session','--tui-mode',a.mode,'--no-tools','--provider','codex-proof','--model','scripted']
if a.extension:cmd+=['-e',a.extension]
proc=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,env={**os.environ,'HOME':a.home,'PI_CODING_AGENT_DIR':str(pathlib.Path(a.home)/'agent'),'TERM':'xterm-256color'});os.close(slave);out=bytearray()
def wait(predicate):
 end=time.monotonic()+35
 while time.monotonic()<end:
  if select.select([master],[],[],.05)[0]:
   try:out.extend(os.read(master,65536))
   except OSError:pass
  if predicate():return
  if proc.poll()!=None:raise RuntimeError('Pi exited before completion')
 raise RuntimeError('Pi PTY completion timeout')
try:
 wait(lambda:b'v0.99.2' in out and b'scripted' in out)
 os.write(master,b'fixture prompt\r');wait(lambda:b'CODEX_PROOF_COMPLETE' in out)
 if a.extension:
  os.write(master,b'\x1b[108;6u');wait(lambda:b'Latency inspector' in out)
  os.write(master,b'\x1b[B');wait(lambda:b'Observed Codex' in out)
 print('PASS actual Pi TUI completed Codex response'+(' and inspector' if a.extension else ''))
finally:
 proc.terminate()
 try:proc.wait(timeout=5)
 except subprocess.TimeoutExpired:proc.kill();proc.wait()
 pathlib.Path(a.artifact).write_bytes(out);os.close(master)
