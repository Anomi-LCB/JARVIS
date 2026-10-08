import {readFileSync} from 'node:fs';
import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {PersonalMandateBudget} from '../../packages/core/src/personal-operations/mandate-budget.js';
import {GoogleCollectionDelegation} from '../../packages/core/src/personal-operations/google-collection-delegation.js';
const input=JSON.parse(readFileSync(process.argv[2])),store=new PersonalOperationsStore({dbPath:input.dbPath,clock:()=>new Date(input.now)});
let accountCalls=0;
const policy=new GoogleCollectionDelegation({store,budget:new PersonalMandateBudget(store),currentBinding:()=>input.binding,readAccount:async()=>{accountCalls++;throw Error('Unexpected provider read');}});
try{const result=policy.check(input.job);console.log(JSON.stringify({status:'scope-checked',...result,accountCalls}));}
catch{console.log(JSON.stringify({status:'denied',accountCalls,executionAuthority:false}));}
finally{store.close();}
