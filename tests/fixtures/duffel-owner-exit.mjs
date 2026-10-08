import {createDuffelBrokerProcess} from '../../scripts/duffel-broker-process.mjs';
const manager=createDuffelBrokerProcess();
try{
  const ready=await manager.start();
  process.send({type:'ready',...ready});
  process.once('message',message=>{if(message?.type==='exit-owner')process.exit(0);});
}catch{process.send({type:'failed'});process.exitCode=1;}
