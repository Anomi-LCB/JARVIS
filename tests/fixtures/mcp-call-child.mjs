import {McpConnectionManager} from '../../packages/core/src/personal-operations/mcp-connections.js';
const [dbPath,id,requestId]=process.argv.slice(2),manager=new McpConnectionManager({storePath:dbPath});
try{const result=await manager.call(id,{tool:'sum',arguments:{a:2,b:3},expectedText:'5',requestId},()=>({allowed:true}));process.send?.({kind:'result',status:result.status,errorCode:result.errorCode});}
catch(error){process.send?.({kind:'error',code:error.code??error.message});}
finally{manager.close();process.disconnect?.();}
