import {readFileSync} from 'node:fs';
import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {createManagedGoogleSync} from '../../packages/core/src/personal-operations/google-sync-service.js';
import {GoogleReadClient} from '../../packages/core/src/personal-operations/google-client.js';
const input=JSON.parse(readFileSync(process.argv[2])),now=new Date('2026-10-08T00:00:03Z'),store=new PersonalOperationsStore({dbPath:input.dbPath,clock:()=>now}),queries=[];
const client=new GoogleReadClient({credentials:{clientId:'synthetic',clientSecret:'synthetic',refreshToken:'synthetic'},fetchImpl:async target=>{
 const url=new URL(target);if(url.origin==='https://oauth2.googleapis.com')return Response.json({access_token:'synthetic-access',expires_in:3600});
 if(url.pathname.endsWith('/profile'))return Response.json({emailAddress:'isolated@example.test'});
 queries.push({path:url.pathname,pageToken:url.searchParams.get('pageToken'),syncToken:url.searchParams.get('syncToken')});return Response.json({items:[{id:'after-restart',summary:'재시작 후 자료'}],nextSyncToken:'after-restart-token'});
}});client.authorizationBinding=()=>({connectionId:'collection-connection',revision:'revision-1'});
try{const sync=createManagedGoogleSync({store,client,clock:()=>now,requireMandates:true}),result=await sync.collectionSync.run('google-calendar',{authorize:()=>true});console.log(JSON.stringify({status:result.status,verification:result.verification.status,queries,items:sync.inbox.list().length}));}
finally{store.close();}
