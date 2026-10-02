#!/usr/bin/env python3
"""Named provider outer-path selector. All evidence is retained, failures fail closed."""
import argparse, hashlib, json, os, pathlib, subprocess
p = argparse.ArgumentParser()
p.add_argument('--case', choices=['all', 'http', 'codex', 'custom', 'safe-capture', 'owner'], default='all')
p.add_argument('--artifact-root', required=True)
p.add_argument('--pi-root', required=True)
a = p.parse_args()
repo = pathlib.Path(__file__).resolve().parents[1]
r = pathlib.Path(a.artifact_root).resolve(); r.mkdir(parents=True, exist_ok=True)
identities = {}
for folder in ['tests', 'src', 'bin']:
 for f in (repo / folder).rglob('*'):
  if f.is_file() and '__pycache__' not in str(f): identities[str(f.relative_to(repo))] = hashlib.sha256(f.read_bytes()).hexdigest()
for name in ['index.ts', 'package.json']:
 identities[name] = hashlib.sha256((repo/name).read_bytes()).hexdigest()
head = os.environ.get('PROOF_SOURCE_HEAD') or subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
status = os.environ.get('PROOF_SOURCE_STATUS')
if status is None: status = subprocess.check_output(['git','status','--porcelain'],text=True)
(r/'source-identities.json').write_text(json.dumps({'repo':str(repo),'head':head,'status':status,'sha256':identities},indent=2))
commands = {
 'http': ['python3','tests/http-tui.py','--artifact-root',str(r/'http'),'--pi-root',a.pi_root],
 'codex': ['node','--test','tests/codex.test.mjs'],
 'custom': ['python3','tests/tui.py','--case','providers','--artifact-root',str(r/'custom'),'--pi-root',a.pi_root],
 'safe-capture': ['python3','tests/safe-capture-tui.py','--artifact-root',str(r/'safe-capture'),'--pi-root',a.pi_root],
 'owner': ['python3','tests/owner.py','--artifact-root',str(r/'owner'),'--pi-root',a.pi_root],
}
results=[]
for case in commands:
 if a.case not in ['all',case]: continue
 if case == 'owner' and a.case == 'all' and not os.environ.get('PROOF_OWNER_WRAPPER'): continue
 env={**os.environ,'PI_TEST_ROOT':a.pi_root,'CODEX_ARTIFACT_ROOT':str(r/'codex')}
 with (r/(case+'.log')).open('w') as log:
  outcome=subprocess.run(commands[case],env=env,stdout=log,stderr=subprocess.STDOUT)
 results.append({'case_id':'providers-'+case,'exit_code':outcome.returncode,'evidence':str(r/case/'outcomes.json')})
 (r/'outcomes.json').write_text(json.dumps(results,indent=2))
 if outcome.returncode: raise SystemExit(outcome.returncode)
