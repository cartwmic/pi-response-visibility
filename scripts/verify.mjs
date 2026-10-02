#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readdirSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve,relative,dirname} from 'node:path';
import {createHash} from 'node:crypto';
const root=process.env.ARTIFACT_ROOT&&resolve(process.env.ARTIFACT_ROOT);
if(!root||!relative(process.cwd(),root).startsWith('..'))throw Error('ARTIFACT_ROOT must be outside checkout');
if(existsSync(join(root,'acceptance.json')))throw Error('Choose a fresh ARTIFACT_ROOT');
mkdirSync(root,{recursive:true});
const executions=[];
function run(id,cmd,args){const r=spawnSync(cmd,args,{encoding:'utf8',env:process.env,maxBuffer:32*1024*1024});const log=join(root,id+'.log');writeFileSync(log,(r.stdout||'')+(r.stderr||'')+(r.error?.message||''));const row={id,status:r.status===0?'passed':'failed',exitCode:r.status,signal:r.signal,log};executions.push(row);return row;}
function identities(dir){const sha256={};function walk(d,prefix=''){for(const e of readdirSync(d,{withFileTypes:true})){if(['.git','node_modules','__pycache__'].includes(e.name))continue;const p=join(d,e.name),key=join(prefix,e.name);if(e.isDirectory())walk(p,key);else if(e.isFile())sha256[key]=createHash('sha256').update(readFileSync(p)).digest('hex');}}walk(dir);return {path:dir,head:spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),dirty:spawnSync('git',['status','--porcelain'],{encoding:'utf8'}).stdout,sha256};}
const before=identities(process.cwd());writeFileSync(join(root,'source-hashes.json'),JSON.stringify(before,null,2));
run('check','npm',['run','check']);run('units','npm',['test']);run('package','npm',['pack','--dry-run','--json']);
const docs=[];for(const match of readFileSync('README.md','utf8').matchAll(/\]\(([^)]+)\)/g)){const target=match[1].split('#')[0];if(target&&!/^[a-z]+:/i.test(target))docs.push({target,exists:existsSync(target)});}
writeFileSync(join(root,'documentation.json'),JSON.stringify(docs,null,2));executions.push({id:'docs',status:docs.every(x=>x.exists)?'passed':'failed'});
const archive=run('archive','npm',['pack','--json','--pack-destination',root]);const extracted=join(root,'archive');
if(archive.status==='passed'){try{const packed=JSON.parse(readFileSync(archive.log,'utf8'));mkdirSync(extracted);run('extract','tar',['-xzf',join(root,packed[0].filename),'-C',extracted]);}catch(error){executions.push({id:'extract',status:'failed',reason:error.message});}}
const suites=['tui','providers','clocks','storage','storage-raw','controls','owner','install-source','install-archive'];
for(const suite of suites){
 if(!process.env.PI_PROOF_ROOT){executions.push({id:'macos-'+suite,status:'unavailable',reason:'PI_PROOF_ROOT required'});continue;}
 const install=suite.startsWith('install-');
 run('macos-'+suite,'python3',[`tests/${install?'install':suite}.py`,...(suite==='providers'?['--case','all']:[]),'--artifact-root',join(root,suite==='tui'?'macos':'macos-'+suite),'--pi-root',process.env.PI_PROOF_ROOT,...(install?['--package-root',suite==='install-source'?process.cwd():join(extracted,'package')]:[])]);
}
run('linux','sh',['tests/linux.sh']);
for(const suite of suites){try{const exitCode=Number(readFileSync(join(root,'linux-'+suite+'.exit'),'utf8').trim());executions.push({id:'linux-'+suite,status:exitCode===0?'passed':'failed',exitCode,log:join(root,'linux-'+suite+'.log')});}catch(error){executions.push({id:'linux-'+suite,status:'unavailable',reason:error.message});}}
const observations=[];
for(const platform of ['macos','linux'])for(const suite of suites){const file=join(root,suite==='tui'?platform:platform+'-'+suite,'outcomes.json');try{observations.push({platform,suite,evidence:file,outcomes:JSON.parse(readFileSync(file,'utf8'))});}catch(error){observations.push({platform,suite,evidence:file,status:'unavailable',reason:error.message});}}
const after=identities(process.cwd());writeFileSync(join(root,'source-hashes-after.json'),JSON.stringify(after,null,2));const stable=JSON.stringify(before.sha256)===JSON.stringify(after.sha256);
const required={'AC-1':['providers','clocks'],'AC-2':['controls'],'AC-3':['tui','providers','controls'],'AC-4':['storage','storage-raw','clocks'],'AC-5':['storage','storage-raw','providers'],'AC-6':['controls'],'AC-7':['clocks'],'AC-8':['tui','owner','install-source','install-archive']};
const minimum={tui:8,providers:4,clocks:3,storage:2,'storage-raw':4,controls:4,owner:4,'install-source':8,'install-archive':8};
function inspect(file,seen=new Set()){
 if(seen.has(file))return ['cyclic proof: '+file];seen.add(file);
 try{const value=JSON.parse(readFileSync(file,'utf8')),rows=Array.isArray(value)?value:value.cases||value.outcomes;
 if(value.status&&value.status!=='passed')return [file+': '+value.status];
 if(!rows?.length)return [file+': missing concrete cases'];
 const errors=[];for(const row of rows){if(row.status?row.status!=='passed':row.exit_code!==undefined?row.exit_code!==0:!(value.status==='passed'&&Array.isArray(value.outcomes)))errors.push(file+': failed or unasserted case '+JSON.stringify(row));if(row.evidence||row.proof)errors.push(...inspect((row.evidence||row.proof).startsWith('/evidence/')?join(root,(row.evidence||row.proof).slice('/evidence/'.length)):resolve(dirname(file),row.evidence||row.proof),seen));}return errors;
 }catch(error){return [file+': '+error.message];}
}
const criteria=Object.entries(required).map(([criterion_id,names])=>{const proof=observations.filter(o=>names.includes(o.suite)),blockers=[];
 for(const platform of ['macos','linux'])for(const suite of names){const o=proof.find(o=>o.platform===platform&&o.suite===suite),execution=executions.find(e=>e.id===platform+'-'+suite);if(!o||o.status==='unavailable'||execution?.status!=='passed')blockers.push(`${platform}/${suite}: missing or failed execution`);else{const rows=Array.isArray(o.outcomes)?o.outcomes:o.outcomes.cases||o.outcomes.outcomes;if(!rows||rows.length<minimum[suite])blockers.push(`${platform}/${suite}: expected ${minimum[suite]} cases`);blockers.push(...inspect(o.evidence));}}
 if(!stable)blockers.push('Source changed during proof');for(const e of executions.filter(e=>['check','units','package','docs','archive','extract'].includes(e.id)&&e.status!=='passed'))blockers.push(e.id+' failed');return {criterion_id,status:blockers.length?'blocked':'passed',proof:proof.map(o=>o.evidence),blockers};});
const acceptance={status:criteria.every(c=>c.status==='passed')?'passed':'incomplete',terminalAcceptance:false,stable,executions,observations,criteria};writeFileSync(join(root,'acceptance.json'),JSON.stringify(acceptance,null,2));console.log(JSON.stringify(criteria,null,2));process.exitCode=acceptance.status==='passed'?0:1;
