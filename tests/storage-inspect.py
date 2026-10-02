#!/usr/bin/env python3
"""Fail-closed export of retained real-Pi storage cases (no provider simulation)."""
import argparse, pathlib, json, hashlib, subprocess
p = argparse.ArgumentParser()
p.add_argument('--artifact-root', required=True)
a = p.parse_args()
r = pathlib.Path(a.artifact_root)
repo = pathlib.Path(__file__).resolve().parents[1]
def load(path):
    return json.loads((r / path).read_text())
rows = []
def row(name, criteria, evidence, assertions):
    for path in evidence:
        assert (r / path).is_file(), 'Missing evidence: ' + path
    rows.append(dict(case=name, status='passed', criterion_ids=criteria, evidence=evidence, assertions=assertions))
allowed = {'id','atMs','elapsedMs','events','contents','inputTokens','outputTokens','statusCode','dropped','kind','phase','status','provenance','origin','transport','usage'}
inspections = []
def inspect(directory, bound, forbidden, metadata=False):
    root = r / directory
    files = list(root.glob('*.jsonl'))
    assert files, 'No actual trace files: ' + directory
    assert root.stat().st_mode & 0o777 == 0o700
    total = sum(f.stat().st_size for f in files)
    assert total <= bound
    text = ''.join(f.read_text() for f in files)
    for marker in forbidden:
        assert marker not in text, 'Forbidden trace marker: ' + marker
    records = [json.loads(line) for line in text.splitlines()]
    if metadata:
        assert all(set(record) <= allowed for record in records), 'Non-metadata key'
        assert all('capture' not in record for record in records)
        for record in records:
            if 'usage' in record:
                usage=record['usage']
                assert set(usage)=={'provenance','value'} and usage['provenance']=='observed'
                value=usage['value']
                assert set(value)<={'input','output','cacheRead','cacheWrite','totalTokens','cost'}
                assert all(type(v) is int and v>=0 for k,v in value.items() if k!='cost')
                if 'cost' in value:
                    assert set(value['cost'])<={'input','output','cacheRead','cacheWrite','total'}
                    assert all(type(v) in (int,float) and 0<=v<float('inf') for v in value['cost'].values())
    for f in files:
        assert f.stat().st_mode & 0o777 == 0o600
    inspections.append(dict(directory=directory, aggregateBytes=total, bound=bound, directoryMode='0700', files=[dict(path=str(f.relative_to(r)), bytes=f.stat().st_size, mode='0600', sha256=hashlib.sha256(f.read_bytes()).hexdigest()) for f in files]))
    return text
busy = load('busy-inspected/outcomes.json')
assert len(busy) == 2 and all(x['status']=='passed' for x in busy)
for case in ['bounded','write-failure']:
    base = 'busy-inspected/' + case
    b = load(base + '/bounds-inspection.json')
    assert b['maxQueue'] <= 4 and b['maxHistory'] == 2 and b['maxTimeline'] <= 8
    assert b['recorderDropped'] > 0 and b['timelineDropped'] > 0
    assert b['providerRequests'] == b['providerCompletions'] == 5
    events = [json.loads(x) for x in (r / base / 'provider.jsonl').read_text().splitlines()]
    assert len([x for x in events if x['event']=='request']) == 5
    assert len([x for x in events if x['event']=='completed']) == 5
    assert not any(x['event']=='error' for x in events)
    screen = (r / base / 'screen.ansi').read_bytes()
    assert b'Diagnostics dropped: capacity reached.' in screen and b'STORAGE_OUTPUT_COMPLETE' in screen
    if case == 'write-failure':
        assert b['recordingFailures'] > 0
        assert b'Diagnostics unavailable: recording failed.' in screen
        assert (r / base / 'home/.local/state/pi-response-visibility/traces').is_file()
    else:
        text = inspect(base + '/home/.local/state/pi-response-visibility/traces', 1024, ['STORAGE_PROMPT_MARKER','STORAGE_OUTPUT_COMPLETE','STORAGE_EVENT_MARKER','DUMMY_STORAGE_CREDENTIAL','authorization'], True)
        assert any(json.loads(x).get('id') == 5 for x in text.splitlines()), 'UI-off recording missing'
    row(case, ['AC-3','AC-4','AC-5','AC-6'], [base+'/bounds-inspection.json',base+'/provider.jsonl',base+'/probe.jsonl',base+'/screen.ansi'], ['five requests completed without retry/error','queue<=4 history<=2 timeline<=8','positive recorder and timeline drop counts','visible safe warning', 'UI-off metadata persisted' if case=='bounded' else 'owned non-directory write failure did not fail provider'])
raw = load('raw-final/outcomes.json')
assert len(raw)==4 and all(x['status']=='passed' for x in raw)
provider = load('raw-final/provider-captures.json')
assert len(provider)==4 and all(x['completed'] and x['credentialHeadersVerified'] for x in provider)
for mode in ['events','bodies']:
    base='raw-final/'+mode
    inspect(base+'/home/.local/state/pi-response-visibility/traces',8192,['dummy-storage-resolved-817','dummy-storage-header-619','Authorization','X-Custom-Credential','OVERSIZE_MARKER'])
    for stage in ['initial','restart']:
        probes=[json.loads(x) for x in (r/base/(stage+'-probe.jsonl')).read_text().splitlines()]
        assert probes and probes[0]['history']==0
        if stage=='initial':
            assert probes[0]['config']['historyLimit']==50 and probes[0]['config']['traceBytes']==100*1024*1024
        else:
            assert probes[0]['config']['historyLimit']==2 and probes[0]['config']['traceBytes']==8192 and probes[0]['config']['capture']==mode
        assert any(x['health']['dropped']>0 for x in probes)
        assert all(x['history']<=2 and x['health']['queued']<=128 for x in probes)
        screen=(r/base/(stage+'-screen.ansi')).read_bytes()
        assert b'RAW_STORAGE_COMPLETE' in screen and b'Diagnostics dropped: capacity reached.' in screen
        for marker in [b'dummy-storage-resolved-817',b'dummy-storage-header-619',b'Authorization',b'X-Custom-Credential',b'OVERSIZE_MARKER']:
            assert marker not in screen
        row(mode+'-'+stage,['AC-3','AC-4','AC-5','AC-6'],[base+'/'+stage+'-probe.jsonl',base+'/'+stage+'-inspection.json',base+'/'+stage+'-screen.ansi','raw-final/provider-captures.json'],['128KiB provider event rejected before capture','completed provider and visible response','credential/header absence','private storage aggregate<=8192','defaults 50/100MiB' if stage=='initial' else 'saved policy and retained traces; history resets'])
privacy=load('privacy-final/outcomes.json')
assert privacy['status']=='passed' and privacy['same_request_bodies']
requests=load('privacy-final/provider-captures.json')
cases=privacy['cases']
assert len(cases)==6 and len(requests)==6 and all(x==requests[0] for x in requests)
assert {(x['mode'],x['tui_mode']) for x in cases} == {(m,t) for m in ['metadata','events','bodies'] for t in ['regular','fullscreen']}
for case in cases:
    assert case['status']=='passed' and case['completed'] and case['safe_capture']
    mode=case['mode']
    base='privacy-final/'+mode+'-'+case['tui_mode']
    text=inspect(base+'/home/.local/state/pi-response-visibility/traces',100*1024*1024,['dummy-safe-resolved-key-747','dummy-safe-header-929','Authorization','X-Custom-Credential'],mode=='metadata')
    assert ('SAFE_PROMPT_MARKER' in text)==(mode=='bodies')
    assert ('SAFE_RESPONSE_MARKER' in text)==(mode!='metadata')
    screen=(r/base/'screen.ansi').read_bytes()
    assert b'SAFE_RESPONSE_MARKER' in screen
    assert b'dummy-safe-resolved-key-747' not in screen and b'dummy-safe-header-929' not in screen
    if mode!='metadata': assert b'rich capture includes sensitive prompt/output/source' in screen
    row('privacy-'+mode+'-'+case['tui_mode'],['AC-3','AC-5'],['privacy-final/outcomes.json','privacy-final/provider-captures.json',base+'/screen.ansi'],['completed same request body across modes','metadata numeric/enum allowlist excludes all body fields' if mode=='metadata' else 'explicit warned capture with allowed output marker','prompt only in bodies','resolved key and custom credential headers absent'])
(r/'actual-file-inspection.json').write_text(json.dumps(inspections,indent=2))
(r/'matrix.json').write_text(json.dumps({'task':'proof-storage','status':'passed','platform':'macOS real Pi 0.99.2 PTY','cases':rows,'limits':['No Linux storage rerun in this slice','No actual tool execution in these fixtures; metadata uses a closed body-free field allowlist','Write fault is owned non-directory destination, not chmod permission denial','AC-6 selective summaries and other recovery behavior belong to other slices; these rows certify storage/history only']},indent=2))
files=[*repo.glob('src/*.mjs'),repo/'index.ts',repo/'tests/storage.py',repo/'tests/storage-raw.py',repo/'tests/safe-capture-tui.py',repo/'tests/storage-inspect.py',repo/'tests/fixtures/storage.ts']
(r/'source-identities.json').write_text(json.dumps({'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),'git_status':subprocess.check_output(['git','status','--porcelain'],cwd=repo,text=True),'files':{str(f.relative_to(repo)):hashlib.sha256(f.read_bytes()).hexdigest() for f in files}},indent=2))
print(json.dumps({'status':'passed','cases':len(rows),'inspectedDirectories':len(inspections)}))
