import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { PersonalMandateBudget } from '../packages/core/src/personal-operations/mandate-budget.js';
let store;
try {
  const [command,path,...extra]=process.argv.slice(2);
  if(!command||command==='--help')console.log('node scripts/personal-budget.mjs <configure|summary|reserve|get|begin|release|uncertain|settle> input.json\nJARVIS_PERSONAL_OPERATIONS_DB selects the local ledger. No external transaction is executed.');
  else {
    if(!['configure','summary','reserve','get','begin','release','uncertain','settle'].includes(command)||!path||extra.length)throw new Error('Invalid arguments');
    const input=JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/u,''));store=new PersonalOperationsStore({dbPath:process.env.JARVIS_PERSONAL_OPERATIONS_DB??join(homedir(),'.jarvis','personal-operations.sqlite')});
    const budget=new PersonalMandateBudget(store);const value=command==='summary'?budget.summary(input.mandateId):['get','begin','release','uncertain'].includes(command)?budget[command](input.id):budget[command](input);
    console.log(JSON.stringify(value,null,2));
  }
}catch(error){console.error(error.message);process.exitCode=1;}finally{store?.close();}
