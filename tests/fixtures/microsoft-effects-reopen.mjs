import {readFile} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {PersonalSourceInbox} from '../../packages/core/src/personal-operations/source-inbox.js';
import {MicrosoftCollectionEffects} from '../../packages/core/src/personal-operations/microsoft-collection-effects.js';
const input=JSON.parse(await readFile(process.argv[2],'utf8'));
const sign=text=>createHmac('sha256','synthetic-only-effect-test-key').update(text).digest('hex');
const store=new PersonalOperationsStore({dbPath:input.dbPath});
try{
 const inbox=new PersonalSourceInbox(store),ledger=new MicrosoftCollectionEffects({store,inbox,signer:{keyId:'synthetic-test',sign,verify:(text,signature)=>sign(text)===signature}});
 const receipt=ledger.recover(input.binding,input.request);
 console.log(JSON.stringify({pid:process.pid,verified:inbox.verifyPage(receipt.page).status,rows:inbox.list().length,providerCalls:0}));
}finally{store.close();}
