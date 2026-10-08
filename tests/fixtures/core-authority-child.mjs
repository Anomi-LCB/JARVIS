import { PersonalOperationsStore } from '../../packages/core/src/personal-operations/operations-store.js';
import { SqliteMissionStore } from '../../packages/core/src/mission/sqlite-mission-store.js';
import { MissionExecutionAuthority } from '../../packages/core/src/mission/mission-execution-authority.js';

const operations=new PersonalOperationsStore({dbPath:process.argv[2]});
const store=new SqliteMissionStore({operationsStore:operations});
const authority=new MissionExecutionAuthority({store,ownerId:`test-process:${process.pid}`,ttlMs:30_000});
process.send({type:'ready',pid:process.pid});
process.on('message',message=>{
  try {
    if(message.type==='claim')process.send({type:'claimed',lease:authority.activate({expectedToken:message.expectedToken})});
    if(message.type==='release')process.send({type:'released',result:authority.release()});
    if(message.type==='close'){authority.stopHeartbeat();operations.close();process.disconnect();}
  }catch(error){process.send({type:'denied',code:error.code??error.message});}
});
