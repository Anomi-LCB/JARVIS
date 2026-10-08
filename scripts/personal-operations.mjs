import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';

const args=process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log('JARVIS 개인 업무 원장\n사용법: node scripts/personal-operations.mjs <summary|tick|goal|commitment|resolve-commitment|resolve-followup|mandate|check-mandate|revoke-mandate> [--db 경로] [--input JSON파일]\nJSON 입력은 문서 docs/personal-operations-cli.md 참조. 자동 감시와 외부 실행은 설치되지 않습니다.');
} else {
  let store;
  try {
    const command=args.shift(); const opts={};
    while(args.length) { const key=args.shift();if(!['--db','--input'].includes(key)||!args.length||opts[key])throw new Error('invalid options');opts[key]=args.shift(); }
    const input=opts['--input']?JSON.parse(readFileSync(opts['--input'],'utf8').replace(/^\uFEFF/u,'')):{};
    const valid=['summary','tick','goal','commitment','resolve-commitment','resolve-followup','mandate','check-mandate','revoke-mandate'];
    if(!valid.includes(command))throw new Error('unknown command');
    store=new PersonalOperationsStore({dbPath:resolve(opts['--db']??resolve(homedir(),'.jarvis','personal-operations.sqlite'))});
    const calls={summary:()=>store.summary(),tick:()=>store.tick(input),goal:()=>store.createGoal(input),commitment:()=>store.createCommitment(input),'resolve-commitment':()=>store.resolveCommitment(input.id,input.state),'resolve-followup':()=>store.resolveFollowUp(input.id,input.state,input.resolution),mandate:()=>store.createMandate(input),'check-mandate':()=>store.evaluateMandate(input.id,input.request),'revoke-mandate':()=>store.revokeMandate(input.id)};
    console.log(JSON.stringify(calls[command](),null,2));
  } catch(error) { console.error(error.message);process.exitCode=1; }
  finally {store?.close();}
}
