import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {PersistentEvaluationBudget} from '../../packages/core/src/capabilities/persistent-evaluation-budget.js';
const [dbPath,mandateId,suiteSha256,requirementContractSha256,id]=process.argv.slice(2),store=new PersonalOperationsStore({dbPath});
try{const budget=new PersistentEvaluationBudget({store,mandateId,suiteSha256,requirementContractSha256});let outcome;
 try{budget.prepare(id);outcome='prepared';}catch(e){outcome=e.code??e.message;}
 console.log(JSON.stringify({pid:process.pid,outcome,status:budget.status()}));
}finally{store.close();}
