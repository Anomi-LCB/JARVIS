import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,mkdir,symlink,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,parse} from 'node:path';
import {MacroStore,macroStorePhysicalPath} from '../packages/core/src/macro-store.js';
import {MacroSaveToolAdapter} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {verifyMacroPublicationCurrent} from '../apps/verification/src/macro-publication-verifier.js';
import {validateMacroPublicationResult} from '../packages/shared/src/macro-publication-contract.js';
import {createGoalContract} from '../packages/core/src/mission/goal-contract.js';
import {assessMissionRequirementCoverage,assessMissionGoalCompletionCoverage} from '../packages/core/src/mission/mission-requirement-coverage.js';
import {sanitizeMissionArguments} from '../packages/core/src/planning/mission-action-arguments.js';
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'jarvis-macro-contract-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new MacroStore({path:join(root,'macros.json')});return {root,store,adapter:new MacroSaveToolAdapter({store})};}
test('physical projection preserves the first character below a filesystem root without creating files',()=>{
 const root=parse(resolve(tmpdir())).root,path=join(root,'jarvis-uncreated-projection-8c61c4b0','macros.json');
 const expected=process.platform==='win32'?path.toLowerCase():path;
 assert.equal(macroStorePhysicalPath(path),expected);
});
test('macro Korean particle is not part of saved name; parser B cannot discard an unrecognized prefix',()=>{
 const parser=MacroStore.prototype;
 for(const [text,name] of [['파일 목록 확인을 일일목록으로 저장해줘','일일목록'],['보고서 생성을 보고서로 저장해줘','보고서'],['읽기를 청소로 기억해줘','청소'],['주간 연구로 저장: 출처를 읽고 문서로 정리해','주간 연구']])assert.equal(parser.parseSave.call(parser,text).name,name);
 assert.equal(parser.parseSave.call(parser,'외부 행동을 하고 @@@ 주간연구로 저장: 읽기'),null);
});
test('canonical SQL record order preserves original bytes and current verification',async t=>{
 const f=await fixture(t),args={rawText:'파일 목록 확인을 일일목록으로 저장해줘'},prepared=await f.adapter.preparePublication(args);
 prepared.record=Object.fromEntries(Object.entries(prepared.record).sort(([a],[b])=>a.localeCompare(b)));
 const result=await f.adapter.execute(args,{},{macroPublication:prepared});
 assert.equal(result.status,'success');validateMacroPublicationResult(prepared,result);
 assert.equal((await verifyMacroPublicationCurrent({executionResult:result,registeredPath:f.store.path})).passed,true);
});
test('G refuses missing registered control path and foreign or modified whole store',async t=>{
 const f=await fixture(t),result=await f.adapter.execute({rawText:'파일 목록 확인을 일일목록으로 저장해줘'});
 assert.equal((await verifyMacroPublicationCurrent({executionResult:result})).passed,false);
 assert.equal((await verifyMacroPublicationCurrent({executionResult:result,registeredPath:join(f.root,'foreign.json')})).passed,false);
 const original=await readFile(f.store.path);await writeFile(f.store.path,Buffer.concat([original,Buffer.from(' ')]));
 assert.equal((await verifyMacroPublicationCurrent({executionResult:result,registeredPath:f.store.path})).passed,false);
});
test('receipt cannot substitute a different macro or output after original preparation',async t=>{
 const f=await fixture(t),args={rawText:'파일 목록 확인을 일일목록으로 저장해줘'},prepared=await f.adapter.preparePublication(args),result=await f.adapter.execute(args,{},{macroPublication:prepared});
 for(const change of [r=>r.macroName='다른이름',r=>r.outputPaths.push(join(f.root,'other.json')),r=>r.macroPublication.record.command='changed',r=>r.macroObservation.sha256='0'.repeat(64)]){const changed=structuredClone(result);change(changed);assert.throws(()=>validateMacroPublicationResult(prepared,changed),/CONTRACT_MISMATCH/);}
});
test('macro model fields contain raw text only, never publication, path or authority',()=>{
 assert.deepEqual(sanitizeMissionArguments('macro.save',{rawText:'본문을 연구로 저장해줘',path:'private',macroPublication:{authority:true},grant:'all'}),{rawText:'본문을 연구로 저장해줘'});
});
test('whole-source macro binding does not accept altered raw request, multiple actions or planned completion',()=>{
 const objective='파일 목록 확인을 일일목록으로 저장해줘',goalContract=createGoalContract({objective,timeZone:'Asia/Seoul'}),action={actionId:'macro',taskId:'task',actualToolName:'macro.save',expectedToolName:'macro.save',status:'planned',requirementIds:goalContract.requirements.map(r=>r.requirementId),constraintRequirementIds:[],dependencies:[],arguments:{rawText:objective}},wave={actions:[action]},mission={objective,goalContract,waves:[wave],observations:[],constraints:[]};
 const assess=()=>assessMissionRequirementCoverage({mission,wave,action,dispatchToolName:'macro.save',dispatchArguments:action.arguments,allowedRoots:[resolve('workspace')],phase:'planning',profile:{toolName:'macro.save',mutatesSystem:true,externalTransfer:false,readOnly:false,executionClass:'local_reversible'}});
 assert.equal(assess().allowed,true);assert.equal(assessMissionGoalCompletionCoverage({mission}).allowed,false);
 action.arguments.rawText='메일 발송을 다른이름으로 저장해줘';assert.equal(assess().allowed,false);action.arguments.rawText=objective;
 wave.actions.push({...action,actionId:'another'});assert.equal(assess().allowed,false);
});
test('changing a parent junction after preparation cannot redirect the registered control store',async t=>{
 const f=await fixture(t),first=join(f.root,'first'),second=join(f.root,'second'),linked=join(f.root,'linked');
 await mkdir(first);await mkdir(second);await symlink(first,linked,process.platform==='win32'?'junction':'dir');
 f.store.path=join(linked,'macros.json');const args={rawText:'파일 목록 확인을 일일목록으로 저장해줘'},prepared=await f.adapter.preparePublication(args);
 await unlink(linked);await symlink(second,linked,process.platform==='win32'?'junction':'dir');
 const result=await f.adapter.execute(args,{},{macroPublication:prepared});assert.equal(result.status,'failed');assert.equal(result.uncertain,false);
 await assert.rejects(readFile(join(second,'macros.json')),{code:'ENOENT'});
});
