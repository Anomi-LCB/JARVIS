import {join} from 'node:path';
import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {PersonalSourceInbox} from '../../packages/core/src/personal-operations/source-inbox.js';
const [root,provider,phase]=process.argv.slice(2);
const store=new PersonalOperationsStore({dbPath:join(root,'inbox.sqlite')}),inbox=new PersonalSourceInbox(store);
const page={provider,account:'synthetic-account',scope:'synthetic-selected-read',observedAt:'2026-10-07T00:00:00Z',cursor:null,nextCursor:'next',items:[{id:'row-one',title:'합성 목록',start:null,withdrawn:false},{id:'row-two',title:'합성 삭제',start:null,withdrawn:true}]};
try{if(phase==='prepare')inbox.ingest(page);console.log(JSON.stringify({pid:process.pid,receipt:inbox.verifyPage(page)}));}finally{store.close();}
