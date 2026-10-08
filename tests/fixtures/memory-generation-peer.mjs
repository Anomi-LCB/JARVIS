import { join } from 'node:path';
import { SqliteMemoryStore } from '../../apps/growth-memory/src/db/sqlite-store.js';
import { GrowthRuntime } from '../../apps/growth-memory/src/growth-runtime.js';
const root=process.argv[2];
const store=new SqliteMemoryStore({dbPath:join(root,'memory.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
const runtime=new GrowthRuntime({memoryStore:store,auditRoot:root});
const captured=runtime.ingestor;
const scope={userId:'synthetic-owner',workspaceRoot:root,conversationId:null};
process.on('message',message=>{
  if(message.action==='query')process.send({id:message.id,matches:runtime.query('STALE_GENERATION_MARKER_472',{scope}).length,eventCount:captured.all().length,generation:runtime.memoryGeneration});
  if(message.action==='ingest'){
    const result=captured.ingest({eventId:'child-new-event',taskId:'child-task',eventType:'task.created',source:{module:'CORE',memoryScope:scope},payload:{rawText:'새 세대 자료'},learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{userProvided:true}});
    process.send({id:message.id,success:result.success,oldEventPresent:runtime.ingestor.events.has('post-event'),newEventPresent:runtime.ingestor.events.has('child-new-event')});
  }
  if(message.action==='drain')process.send({id:message.id,...runtime.drainPendingMemory()});
  if(message.action==='close'){store.close();process.disconnect();}
});
process.on('disconnect',()=>process.exit(0));process.send({ready:true,cachedPostEvent:captured.events.has('post-event')});
