// Synthetic OAuth helper for process-boundary tests. Never opens Google or uses a real account.
const [url,mode]=process.argv.slice(2);
if(mode!=='missing'){
 let raw='';for await(const part of process.stdin)raw+=part;
 const handoff=JSON.parse(raw);
 const response=await fetch(url,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${handoff.ticket}`,'content-type':'application/json'},body:JSON.stringify({providerAccountId:'synthetic@example.test',credentials:{clientId:'synthetic.apps.googleusercontent.com',clientSecret:'synthetic-client-secret',refreshToken:'synthetic-refresh-secret'}})});
 if(response.status!==202)process.exitCode=2;
}
