import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalMandateBudget} from '../packages/core/src/personal-operations/mandate-budget.js';
import {GoogleSyncEvidence} from '../packages/core/src/personal-operations/google-sync-evidence.js';
let store;
try{const [command,path,...extra]=process.argv.slice(2);if(!command||command==='--help')console.log('node scripts/personal-google-mandate.mjs <status|configure input.json>\nCounts logical pages. Does not connect an account or grant external writes.');
else {if(!['status','configure'].includes(command)||extra.length||(command==='configure'&&!path))throw Error('Invalid arguments');store=new PersonalOperationsStore({dbPath:process.env.JARVIS_PERSONAL_OPERATIONS_DB??join(homedir(),'.jarvis','personal-operations.sqlite')});const evidence=new GoogleSyncEvidence({store,budget:new PersonalMandateBudget(store)});console.log(JSON.stringify(command==='status'?evidence.status():evidence.configure(JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/u,''))),null,2));}}
catch(error){console.error(error.message);process.exitCode=1;}finally{store?.close();}
