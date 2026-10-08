import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runNaturalMission50Audit, caseEvidenceManifest } from '../scripts/natural-mission-50-audit.mjs';
import { verifyNaturalMission50RecordedCase } from '../scripts/natural-mission-50-reverify.mjs';
import { naturalMission50Cases, NATURAL_MISSION_50_CORPUS_SHA256 } from '../scripts/natural-mission-50-cases.mjs';
import { NATURAL_MISSION_50_FIXTURE_SHA256 } from '../scripts/natural-mission-50-fixtures.mjs';
import { NATURAL_MISSION_50_ORACLE_SHA256 } from '../scripts/natural-mission-50-oracle.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const save=(path,value)=>writeFile(path,`${JSON.stringify(value,null,2)}\n`);
let root,pristine,ordinal=0;
before(async()=>{root=await mkdtemp(join(tmpdir(),'jarvis-natural50-proof-'));pristine=join(root,'pristine');const result=await runNaturalMission50Audit(['--phase','final','--cases','N01','--root',pristine]);assert.equal(result.report.passed,1);});
after(async()=>{if(root&&resolve(root).startsWith(resolve(tmpdir())))await rm(root,{recursive:true,force:true});});
async function sample(){const target=join(root,`mutant-${++ordinal}`);await cp(pristine,target,{recursive:true});return {runRoot:target,caseRoot:join(target,'cases','N01')};}
async function refreshEnvelope(caseRoot){const manifest=await caseEvidenceManifest(caseRoot);await save(join(caseRoot,'case-evidence-manifest.json'),manifest);const result=await json(join(caseRoot,'result.json'));result.evidenceManifestSha256=manifest.sha256;result.missionResultSha256=hash(await readFile(join(caseRoot,'mission-result.json')));await save(join(caseRoot,'result.json'),result);const ledger=await json(join(caseRoot,'ledger-entry.json'));ledger.resultSha256=hash(await readFile(join(caseRoot,'result.json')));ledger.evidenceManifestSha256=manifest.sha256;delete ledger.sha256;ledger.sha256=hash(JSON.stringify(ledger));await save(join(caseRoot,'ledger-entry.json'),ledger);}

test('frozen 50 natural commands contain 426 requirements across 10 categories without prepared workflow references',()=>{assert.equal(naturalMission50Cases.length,50);assert.equal(new Set(naturalMission50Cases.map(c=>c.category)).size,10);assert.equal(naturalMission50Cases.reduce((n,c)=>n+c.requirementCount,0),426);assert.equal(naturalMission50Cases.filter(c=>c.requirementCount>=12).length,10);assert(naturalMission50Cases.every(c=>c.requirementCount>=3&&c.requirementCount<=20&&!/\.workflow\.json|shell\.execute|\bN\d{2}\b/.test(c.command)));assert.equal(NATURAL_MISSION_50_CORPUS_SHA256,'43e42a7996711e6faee9d57069c290673c0f8ad662f7d6fd721fc350b4f92019');assert.equal(NATURAL_MISSION_50_FIXTURE_SHA256,'dd2b5a566ce2daa3f8f90a7df7d20504d4419605798026138fccf20b1d4c79e2');assert.equal(NATURAL_MISSION_50_ORACLE_SHA256,'e8dcc367d977f4891ae1e6ea54025ae66fb28201c6f7d0ec81788eb6d5745331');});
test('real default planner Mission Core PC G case is independently reverified',async()=>{const result=await verifyNaturalMission50RecordedCase(pristine,'N01');assert.equal(result.passed,true,JSON.stringify(result));assert.equal(result.pathEvidence.nodeCount,16);});
test('changed natural command is rejected',async()=>{const x=await sample();await writeFile(join(x.caseRoot,'command.txt'),'다른 명령\n');const result=await verifyNaturalMission50RecordedCase(x.runRoot,'N01');assert.equal(result.passed,false);assert.equal(result.code,'COMMAND_BYTES_CHANGED');});
test('forged result success labels cannot replace the ledger',async()=>{const x=await sample(),path=join(x.caseRoot,'result.json'),result=await json(path);result.missionPass=false;await save(path,result);assert.equal((await verifyNaturalMission50RecordedCase(x.runRoot,'N01')).code,'RESULT_LEDGER_BINDING_INVALID');});
test('deleted raw G audit fails closed',async()=>{const x=await sample();await rm(join(x.caseRoot,'audit','verification.jsonl'));assert.equal((await verifyNaturalMission50RecordedCase(x.runRoot,'N01')).passed,false);});
test('changed fixture bytes cannot retain success',async()=>{const x=await sample();await writeFile(join(x.caseRoot,'inputs','sales.csv'),'id,qty,price\nfake,1,999\n');assert.equal((await verifyNaturalMission50RecordedCase(x.runRoot,'N01')).passed,false);});
test('ledger chain replacement is rejected',async()=>{const x=await sample(),path=join(x.caseRoot,'ledger-entry.json'),ledger=await json(path);ledger.previousHash='FORGED';await save(path,ledger);assert.equal((await verifyNaturalMission50RecordedCase(x.runRoot,'N01')).code,'CASE_LEDGER_INVALID');});
test('rehashed output forgery is rejected by semantic oracle',async()=>{const x=await sample();await writeFile(join(x.caseRoot,'outputs','result.json'),'[]\n');await refreshEnvelope(x.caseRoot);const result=await verifyNaturalMission50RecordedCase(x.runRoot,'N01');assert.equal(result.passed,false);assert.equal(result.code,'ORACLE_REPLAY_DISAGREES');});
test('rehashed empty action evidence is rejected by actual Mission binding',async()=>{const x=await sample(),path=join(x.caseRoot,'result.json'),result=await json(path);result.actionEvidence=[];await save(path,result);await refreshEnvelope(x.caseRoot);assert.equal((await verifyNaturalMission50RecordedCase(x.runRoot,'N01')).code,'RAW_MISSION_ACTIONS_MISMATCH');});
test('rehashed raw G report with a failed critical check cannot pass',async()=>{const x=await sample(),index=await json(join(x.caseRoot,'audit','verification-reports','report-index.json'));const item=index.items.find(r=>r.reportId.startsWith('ver_exec_'));const path=join(x.caseRoot,'audit','verification-reports',`${item.storageKey}.json`),report=await json(path);report.checks.find(c=>c.checkId==='workflow_node_receipts_complete').status='failed';await save(path,report);await refreshEnvelope(x.caseRoot);assert.equal((await verifyNaturalMission50RecordedCase(x.runRoot,'N01')).code,'RAW_G_REPORT_FAILED');});
