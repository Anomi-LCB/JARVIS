import { execFileSync } from 'node:child_process';
import { mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root=process.cwd(),temp=mkdtempSync(join(tmpdir(),'jarvis-ops-live-'));
const output=resolve(root,'artifacts/personal-operations-20260913');mkdirSync(output,{recursive:true});
const checks=[];
let sequence=0;
const run=(command,input)=>{
 const args=['scripts/personal-operations.mjs',command,'--db',join(temp,'ops.sqlite')];
 if(input){const p=join(temp,`input-${sequence++}.json`);writeFileSync(p,JSON.stringify(input));args.push('--input',p);}
 return JSON.parse(execFileSync(process.execPath,args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
};
const check=(name,ok)=>{checks.push({name,passed:Boolean(ok)});if(!ok)throw new Error(name);};
try {
 const goal=run('goal',{title:'검증용 출장 준비'});
 const commitment=run('commitment',{goalId:goal.id,title:'검증용 취소 조건 확인',dueAt:'2026-09-01T00:00:00Z',sourceRef:'synthetic:audit'});
 const first=run('tick');check('fresh CLI detects overdue commitment',first.created===1);
 check('second CLI does not duplicate followup',run('tick').created===0);
 check('another process restores goal',run('summary').goals[0].id===goal.id);
 run('resolve-followup',{id:first.followUps[0].id,state:'done',resolution:'synthetic research completed; no booking'});
 check('followup is not commitment completion',run('summary').commitments[0].state==='open');
 run('resolve-commitment',{id:commitment.id,state:'done'});
 check('commitment closure persists',run('summary').commitments[0].state==='done');
 const mandate=run('mandate',{action:'travel.quote',target:'synthetic-provider',currency:'KRW',maxAmountMinor:100000,validFrom:'2026-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z'});
 const request={action:'travel.quote',target:'synthetic-provider',currency:'KRW',amountMinor:50000};
 const decision=run('check-mandate',{id:mandate.id,request});check('match grants no execution authority',decision.matches&&!decision.executionAuthority&&!decision.budgetReserved);
 check('changed transaction target denied',!run('check-mandate',{id:mandate.id,request:{...request,target:'different'}}).matches);
 run('revoke-mandate',{id:mandate.id});check('revocation persists across processes',!run('check-mandate',{id:mandate.id,request}).matches);
} finally {
 const sources=['packages/core/src/personal-operations/operations-store.js','scripts/personal-operations.mjs','tests/personal-operations.test.js'];
 const report={generatedAt:new Date().toISOString(),checks,passed:checks.filter(c=>c.passed).length,expected:8,allPassed:checks.length===8&&checks.every(c=>c.passed),externalActionsExecuted:0,liveUserDataTouched:false,scope:'isolated real CLI processes with durable SQLite',sources:sources.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}))};
 writeFileSync(join(output,'cli-audit.json'),JSON.stringify(report,null,2)+'\n');
 rmSync(temp,{recursive:true,force:true});console.log(JSON.stringify(report,null,2));
}
