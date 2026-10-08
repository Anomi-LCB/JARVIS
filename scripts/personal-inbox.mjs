import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { PersonalSourceInbox, normalizeConnectorPage } from '../packages/core/src/personal-operations/source-inbox.js';
let store;
try {
  const [command,inputPath,...extra]=process.argv.slice(2);
  if(!command||command==='--help')console.log('node scripts/personal-inbox.mjs <list|ingest|connector-page|accept> [input.json]\nDB: JARVIS_PERSONAL_OPERATIONS_DB or ~/.jarvis/personal-operations.sqlite');
  else {
    if(!['list','ingest','connector-page','accept'].includes(command)||extra.length||(command==='list'?!!inputPath:!inputPath))throw new Error('Invalid arguments');
    store=new PersonalOperationsStore({dbPath:process.env.JARVIS_PERSONAL_OPERATIONS_DB??join(homedir(),'.jarvis','personal-operations.sqlite')});
    const inbox=new PersonalSourceInbox(store),input=inputPath?JSON.parse(readFileSync(inputPath,'utf8').replace(/^\uFEFF/u,'')):null;
    console.log(JSON.stringify(command==='list'?inbox.list():command==='connector-page'?inbox.ingest(normalizeConnectorPage(input)):inbox[command](input),null,2));
  }
} catch(error){console.error(error.message);process.exitCode=1;}
finally{store?.close();}
