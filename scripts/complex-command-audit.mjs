import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { cases } from './complex-command-cases.mjs';
import { coreTaskRuntimeEnvFromEnv } from './core-service-runtime.mjs';

const flag = (name) => process.argv[process.argv.indexOf(name) + 1];
const ids = process.argv.includes('--cases') ? flag('--cases').split(',') : cases.map(c => c.id);
const runRoot = resolve(process.argv.includes('--root') ? flag('--root') : `artifacts/complex-command-audit/${new Date().toISOString().replace(/[:.]/g,'-')}`);
// Match productServiceDefinitions: live read-only browser, with explicit opt-out.
process.env.JARVIS_BROWSER_DRIVER ??= '1';
await mkdir(runRoot, { recursive: true });
console.log(`AUDIT_ROOT ${runRoot}`);
for (const c of cases.filter(c => ids.includes(c.id))) {
  const caseRoot = join(runRoot, c.id);
  const workspace = join(caseRoot, 'workspace');
  await mkdir(workspace, { recursive: true });
  for (const [name, content] of Object.entries(c.inputs ?? {})) {
    await mkdir(dirname(join(workspace, name)), { recursive: true });
    await writeFile(join(workspace, name), content, 'utf8');
  }
  const env = { ...process.env, JARVIS_LLM_PLANNER: '1', JARVIS_LLM_CONTENT: '1',
    JARVIS_LLM_PLANNER_TIMEOUT_MS:'45000', JARVIS_MISSION_TIMEOUT_MS:'60000',
    JARVIS_INTENT_CACHE_PATH: join(caseRoot,'intent-cache.jsonl'), JARVIS_PLAN_CACHE_PATH: join(caseRoot,'plan-cache.jsonl'),
    JARVIS_BACKUP_DIR: join(workspace,'.jarvis-backups') };
  Object.assign(process.env, {JARVIS_INTENT_CACHE_PATH:env.JARVIS_INTENT_CACHE_PATH,JARVIS_PLAN_CACHE_PATH:env.JARVIS_PLAN_CACHE_PATH,JARVIS_BACKUP_DIR:env.JARVIS_BACKUP_DIR});
  const runtime = createAgRuntime({ allowedRoots: [workspace], auditRoot: join(caseRoot,'audit'), cwd: () => workspace,
    env, taskEnv: coreTaskRuntimeEnvFromEnv(env), bridgeRealExecution: true, workerDaemonEnabled: false, workerDefaultTimeoutMs: 90000 });
  const owner = runtime.personalOwnerSession.activate({durationMinutes:30,requestedBy:'user-requested-20-command-audit'});
  const command = `${c.command}\n작업 범위는 ${workspace} 안으로 한정한다. 기존 사용자 자료를 읽거나 변경하지 말고 테스트 자료만 사용한다. 외부 전송, 결제, 앱 설치는 하지 않는다.`;
  const start = performance.now();
  console.log(`START ${c.id} ${c.title}`);
  let mission, error;
  try {
    mission = runtime.missionRuntime.createMission({ objective: command,
      successCriteria: [c.command], constraints: [`모든 파일 읽기/쓰기는 ${workspace} 내부`, '목록 조회만으로 문서 생성이나 내용 분석을 완료로 판단하지 않는다.'],
      budgets: {maxWaves:4,maxActions:10,maxPlannerCalls:5,maxConsecutiveFailures:2,maxActiveRuntimeMs:240000},
      authorization: {mode:'trusted_session',grants:['read_only','local_reversible','high_impact'],ownerSessionId:owner.session.sessionId} });
    await writeFile(join(caseRoot,'command.txt'), command, 'utf8');
    mission = await runtime.missionRuntime.runMission(mission.missionId);
  } catch (e) { error = {name:e.name,code:e.code,message:e.message}; }
  if (mission?.missionId) mission = runtime.missionRuntime.getMission(mission.missionId);
  const assertions = await verify(c, workspace);
  const artifacts = await inventory(workspace);
  const passed = assertions.length > 0 && assertions.every(a => a.pass);
  const responseText = JSON.stringify({reason:mission?.stopReason,gates:mission?.gates?.map(gate=>gate.question)});
  const missingReported = c.expectedMissing && /missing-budget\.csv/i.test(responseText) && /없|필요|제공|존재하지|찾을 수 없|not exist|cannot find|missing/i.test(responseText);
  const outcome = c.expectedMissing ? (assertions.every(a=>a.pass) && missingReported && ['WAITING_APPROVAL','BLOCKED','PAUSED'].includes(mission?.status) ? 'EXPECTED_STOP' : 'FAILED')
    : passed && mission?.status === 'COMPLETED' ? 'SUCCESS' : assertions.some(a => a.pass) ? 'PARTIAL' : 'FAILED';
  const tasks = [...runtime.coreFacade.tasks.values()].map(t => ({taskId:t.taskId,status:t.status,rawText:t.request?.rawText,
    intent:t.intent,plan:t.plan,execution:t.executionResult,verification:t.verification,error:t.error}));
  const result = {id:c.id,title:c.title,command:c.command,outcome,durationMs:Math.round(performance.now()-start),
    missionStatus:mission?.status,stopReason:mission?.stopReason,assertions,artifacts,error,mission,tasks};
  await writeFile(join(caseRoot,'result.json'), JSON.stringify(result, (key,value) => /^(token|rawToken|accessToken|authorizationToken|signingSecret|apiKey)$/i.test(key) ? '[redacted]' : value, 2));
  console.log(`RESULT ${c.id} ${outcome} ${result.missionStatus} ${result.durationMs}ms ${result.stopReason ?? ''}`);
  runtime.workerDaemon.stop();
}

async function verify(c, workspace) {
  const checks=[];
  for (const [file, ...needles] of c.expectedMissing ? [] : c.checks) {
    let content='';
    try { content = c.zip ? zipText(join(workspace,file)) : await readFile(join(workspace,file),'utf8'); } catch {}
    checks.push({check:`파일 ${file} 존재 및 비어 있지 않음`,pass:content.length>0});
    for (const needle of needles) checks.push({check:`${file}: ${String(needle)}`,pass:needle instanceof RegExp ? needle.test(content) : /^\d+$/.test(needle) ? content.replace(/(?<=\d),(?=\d)/g,'').includes(needle) : content.includes(needle)});
    if(c.slides) { const xml=zipText(join(workspace,file),'names'); checks.push({check:`슬라이드 ${c.slides}개`,pass:xml.split(/\r?\n/).filter(n=>/^ppt\/slides\/slide\d+\.xml$/.test(n)).length===c.slides}); }
  }
  for(const [file,needle] of c.absent??[]) { const content=await readFile(join(workspace,file),'utf8').catch(()=>'');checks.push({check:`${file}: ${needle} 제외`,pass:content.length>0&&!content.includes(needle)}); }
  for(const file of c.missing??[]) checks.push({check:`이동 후 원본 ${file} 없음`,pass:!await stat(join(workspace,file)).then(()=>true,()=>false)});
  if(c.lines) {const content=await readFile(join(workspace,c.lines.file),'utf8').catch(()=>''); checks.push({check:'중복 없는 4개 이름',pass:new Set(content.trim().split(/\r?\n/)).size===c.lines.count&&content.trim().split(/\r?\n/).length===c.lines.count});}
  if(c.json) {let value;try {value=JSON.parse((await readFile(join(workspace,c.json.file),'utf8')).replace(/^\uFEFF/,''));}catch{}checks.push({check:'JSON 미완료 항목 C,A 순서',pass:Array.isArray(value)&&JSON.stringify(value.map(v=>v.name))===JSON.stringify(c.json.names)&&value.every(v=>v.done===false)});}
  if(['03','04','05','06','10','17','19','20'].includes(c.id)) for(const [file,expected] of Object.entries(c.inputs??{})) checks.push({check:`원본 ${file} 바이트 보존`,pass:await readFile(join(workspace,file),'utf8').then(actual=>actual===expected,()=>false)});
  if(c.id==='01') for(const [file,expected] of [['alpha.txt','프로젝트 시작 승인 완료'],['beta.txt','담당자: 김하늘, 마감: 2026-09-10']]) checks.push({check:`${file} 정확한 본문`,pass:await readFile(join(workspace,file),'utf8').then(actual=>actual.trim()===expected,()=>false)});
  if(c.id==='05') checks.push({check:'가나다순 정렬',pass:await readFile(join(workspace,'unique.txt'),'utf8').then(actual=>actual.trim().split(/\r?\n/).join(',')==='민준,서연,지우,하준',()=>false)});
  if(c.expectedMissing) checks.push({check:'없는 근거로 결과를 만들어내지 않음',pass:!await stat(join(workspace,'verified-total.txt')).then(()=>true,()=>false)});
  return checks;
}
function zipText(file, mode='text') {
  const script = `import zipfile,sys,xml.etree.ElementTree as E\nsys.stdout.reconfigure(encoding='utf-8')\nwith zipfile.ZipFile(sys.argv[1]) as z:\n if sys.argv[2]=='names': print('\\n'.join(z.namelist()))\n else:\n  for n in z.namelist():\n   if n.endswith('.xml'):\n    try:\n     r=E.fromstring(z.read(n));print(' '.join(r.itertext()));print(' '.join(v for el in r.iter() for v in el.attrib.values()))\n    except: pass`;
  const r=spawnSync('python',['-c',script,file,mode],{encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});
  return r.status===0?r.stdout:'';
}
async function inventory(root, sub='') {
  const output=[];
  for(const entry of await readdir(join(root,sub),{withFileTypes:true})) {
    const name=join(sub,entry.name);
    if(entry.isDirectory()) {if(entry.name!=='.jarvis-backups')output.push(...await inventory(root,name));}
    else {const data=await readFile(join(root,name));output.push({path:name,size:data.length,sha256:createHash('sha256').update(data).digest('hex')});}
  }
  return output;
}
