import {GoogleInboxSync} from './google-sync.js';
import {GoogleSyncEvidence} from './google-sync-evidence.js';
import {PersonalMandateBudget} from './mandate-budget.js';
import {PersonalSourceInbox} from './source-inbox.js';
import {GoogleCollectionDelegation} from './google-collection-delegation.js';
import {GoogleCollectionSync} from './google-collection-sync.js';

/** Production entry points share the same durable mandate and receipt checks. */
export function createManagedGoogleSync({store,client,clock,intervalMs,requireMandates=false}){
  const budget=new PersonalMandateBudget(store);
  const sync=new GoogleInboxSync({inbox:new PersonalSourceInbox(store),client,clock,intervalMs,evidence:new GoogleSyncEvidence({store,budget,requireMandates,connectionBinding:()=>client.authorizationBinding()})});
  if(typeof client.authorizationBinding==='function')sync.collectionDelegation=new GoogleCollectionDelegation({store,budget,currentBinding:()=>client.authorizationBinding(),readAccount:()=>client.account()});
  if(sync.collectionDelegation&&typeof client.collectionPage==='function')sync.collectionSync=new GoogleCollectionSync({inbox:sync.inbox,client,delegation:sync.collectionDelegation,budget,clock,control:()=>{
    const state=sync.status();if(['reauth-required','collection-paused','connection-required'].includes(state.status)||!client.configured())throw Error('A_GOOGLE_COLLECTION_PAUSED');
    return store.db.prepare('SELECT revision FROM personal_google_sync_generation WHERE id=1').get().revision;
  }});
  return sync;
}
