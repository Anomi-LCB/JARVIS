import { join } from 'node:path';
import { SqliteMemoryStore } from '../../apps/growth-memory/src/db/sqlite-store.js';
const root=process.argv[2];
const store=new SqliteMemoryStore({dbPath:join(root,'memory.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
process.on('message',message=>{
  if(message.action==='lock'){store.db.exec('BEGIN IMMEDIATE;');process.send({id:message.id,locked:true});}
  if(message.action==='release'){store.db.exec('ROLLBACK;');process.send({id:message.id,released:true});}
  if(message.action==='inspect'){process.send({id:message.id,postBackupCount:store.db.prepare("SELECT count(*) AS n FROM growth_reviews WHERE review_id='post-backup'").get().n,withdrawn:store.hasSourceRetraction('cross-process-source')});}
  if(message.action==='close'){store.close();process.disconnect();}
});
process.on('disconnect',()=>{process.exit(0);});
process.send({ready:true});
