import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { records as R, NATURAL_MISSION_50_FILE_CONTENTS as F } from './natural-mission-50-fixtures.mjs';

// Independent expected-value construction. No runtime, compiler or product operation is imported.
const clone=x=>JSON.parse(JSON.stringify(x));
const pick=(rows,keys)=>rows.map(row=>Object.fromEntries(keys.map(key=>[key,row[key]])));
const sorted=(rows,key,desc=true)=>[...rows].sort((a,b)=>a[key]===b[key]?0:(a[key]<b[key]?-1:1)*(desc?-1:1));
const unique=(rows,key)=>rows.filter((row,i)=>rows.findIndex(other=>other[key]===row[key])===i);
const group=(rows,key,field,alias,mode='sum')=>[...new Set(rows.map(row=>row[key]))].map(value=>{const groupRows=rows.filter(row=>row[key]===value);const vals=groupRows.map(row=>Number(row[field]));const total=mode==='count'?groupRows.length:mode==='max'?Math.max(...vals):mode==='avg'?vals.reduce((a,b)=>a+b,0)/vals.length:vals.reduce((a,b)=>a+b,0);return {[key]:value,[alias]:total};});
function statistics(values){const a=[...values].sort((a,b)=>a-b),n=a.length,sum=a.reduce((a,b)=>a+b,0),mean=sum/n,variance=a.reduce((sum,v)=>sum+(v-mean)**2,0)/n;const quantile=p=>{const index=(n-1)*p;return a[Math.floor(index)]+(a[Math.ceil(index)]-a[Math.floor(index)])*(index%1);};return {count:n,min:a[0],max:a.at(-1),sum,mean,median:quantile(.5),variance,stddev:Math.sqrt(variance),q1:quantile(.25),q3:quantile(.75)};}
function window(rows,part,field,kind,as){return [...new Set(rows.map(row=>row[part]))].flatMap(key=>{const a=sorted(rows.filter(row=>row[part]===key),field);return a.map((row,i)=>({...row,[as]:kind==='running'?a.slice(0,i+1).reduce((sum,r)=>sum+r[field],0):kind==='row'?i+1:kind==='dense'?[...new Set(a.slice(0,i+1).map(r=>r[field]))].length:a.findIndex(r=>r[field]===row[field])+1}));});}
const clean=R.customers.map(row=>({...row,name:row.name.trim().toLowerCase(),email:row.email.trim().toLowerCase()||null}));
const active=clean.filter(row=>row.active);
const sales=R.sales.map(row=>({...row,region:row.region.trim().toLowerCase(),gross:row.qty*row.price,net:row.qty*row.price-row.discount}));
const paid=sales.filter(row=>row.status==='paid');
const salesCustomer=paid.map(row=>({...row,name:R.customers.find(c=>c.id===row.customerId).name,team:R.customers.find(c=>c.id===row.customerId).team}));
const lines=R.orders.flatMap(order=>order.lines.map(line=>({...order,line,total:line.qty*line.price})));
const large=JSON.parse(F['inputs/large.json']);
const weighted=large.map(row=>({...row,weighted:row.value*row.weight}));
const hash=value=>createHash('sha256').update(value).digest('hex');
const tree=Object.entries(F).filter(([path])=>path.startsWith('inputs/tree/')).map(([path,text])=>({relativePath:path.slice('inputs/tree/'.length),extension:path.slice(path.lastIndexOf('.')),size:Buffer.byteLength(text),sha256:hash(text),text}));
const mask=(text,email=true,phone=true)=>{let s=text;if(email)s=s.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,'[REDACTED]');if(phone)s=s.replace(/010-\d{4}-\d{4}/g,'[REDACTED]');return s;};
const letters=(rows,template)=>rows.map((record,index)=>({index,record,text:template.replace(/\{\{([^}]+)\}\}/g,(_,key)=>String(record[key]))}));
const delta=(fields=['name','amount'])=>[...new Set([...R.before,...R.after].map(r=>r.id))].flatMap(id=>{const before=R.before.find(r=>r.id===id)??null,after=R.after.find(r=>r.id===id)??null,changedFields=before&&after?fields.filter(k=>before[k]!==after[k]):[];const status=!before?'added':!after?'removed':changedFields.length?'changed':'unchanged';return status==='unchanged'?[]:[{status,key:{id},before,after,changedFields}];});
const exact=value=>({kind:'exact',value});
const subset=value=>({kind:'subset',value});
const spec={};
function out(id,values){spec[id]=Object.fromEntries(Object.entries(values).map(([path,value])=>[`outputs/${path}`,value?.kind?value:exact(value)]));}
const stat=(rows,key)=>statistics(rows.map(row=>Number(row[key])));

out('N01',{'result.json':pick(sorted(group(paid,'region','net','total'),'total'),['region','total']),'teams.json':pick(window(salesCustomer,'team','net','rank','rank'),['id','team','net','rank'])});
const unitNet=paid.map(row=>({...row,unitNet:row.net/row.qty}));
const pivot=[...new Set(paid.map(r=>r.region))].map(region=>({region,...Object.fromEntries([...new Set(paid.filter(r=>r.region===region).map(r=>r.month))].map(month=>[month,paid.filter(r=>r.region===region&&r.month===month).reduce((s,r)=>s+r.net,0)]))}));
out('N02',{'result.json':pick(sorted(unitNet,'net').slice(0,3),['id','net','unitNet']),'pivot.json':pivot,'stats.json':stat(paid,'net')});
const validLines=lines.filter(r=>r.total>=40),skuRows=validLines.map(r=>({...r,'line.sku':r.line.sku}));
out('N03',{'result.json':sorted(group(skuRows,'line.sku','total','total'),'total'),'regions.json':sorted(group(validLines,'region','total','total'),'total'),'stats.json':stat(validLines,'total')});
const avgCustomer=group(paid,'customerId','net','average','avg').map(r=>({...r,team:R.customers.find(c=>c.id===r.customerId).team}));
out('N04',{'result.json':pick(sorted(avgCustomer,'average'),['customerId','team','average']),'quantity.json':group(paid,'customerId','qty','quantity').sort((a,b)=>b.quantity-a.quantity)});
out('N05',{'result.json':pick(window(paid,'region','net','running','running'),['id','region','net','running']),'discount.json':sorted(group(paid.filter(r=>r.discount>0),'region','discount','discountTotal'),'discountTotal'),'stats.json':stat(paid.filter(r=>r.discount>0),'discount')});
const contactable=unique(clean,'email').filter(r=>r.active&&r.email!==null);
out('N06',{'result.json':pick(sorted(contactable,'score'),['id','name','email','team','score']).map(r=>({...r,email:'[REDACTED]'})),'teams.json':pick(window(contactable,'team','score','dense','rank'),['id','team','score','rank']),'stats.json':stat(contactable,'score')});
const protectedActive=sorted(active.map(r=>({...r,note:mask(r.note.replaceAll('주식회사','(주)'))})),'score');
const publicActive=pick(protectedActive,['id','name','note']);
out('N07',{'result.json':publicActive,'letters.json':letters(publicActive,'안녕하세요 {{name}}님, 고객번호 {{id}}입니다.'),'teams.json':group(active,'team','score','average','avg')});
const activeSales=salesCustomer.filter(r=>active.some(c=>c.id===r.customerId)).map(r=>({...r,name:clean.find(c=>c.id===r.customerId).name}));
out('N08',{'result.json':pick(sorted(group(activeSales,'team','net','total'),'total'),['team','total']),'orders.json':pick(sorted(activeSales,'net'),['id','customerId','name','net'])});
const proper=unique(clean.filter(r=>r.email!==null),'email');
out('N09',{'result.json':pick(clean.filter(r=>r.email===null),['id','name','email']),'ranking.json':pick(window(proper,'team','score','rank','rank'),['id','team','score','rank']),'stats.json':stat(proper,'score'),'maximum.json':group(clean,'team','score','maximum','max')});
const gap=active.map(r=>({...r,gap:100-r.score}));
out('N10',{'result.json':pick(window(gap,'team','gap','row','position'),['id','name','team','gap','position']),'teams.json':sorted(group(gap,'team','gap','gapTotal'),'gapTotal'),'notes.json':active.map(r=>({id:r.id,note:mask(r.note)}))});
out('N11',{'result.json':sorted(delta(),'status',false),'summary.json':group(delta(),'status',null,'count','count')});
out('N12',{'result.json':delta().filter(r=>r.status==='changed').map(r=>({...r,delta:r.after.amount-r.before.amount})).filter(r=>r.delta>0).map(r=>({key:r.key,before:r.before,after:r.after,delta:r.delta}))});
out('N13',{'result.json':delta().filter(r=>r.status==='removed'),'changed.json':delta().filter(r=>r.status==='changed')});
out('N14',{'result.json':pick(sorted(group(unique([...R.after,...R.before],'id'),'team','amount','total'),'total'),['team','total'])});
out('N15',{'result.json':delta(['amount']).filter(r=>r.status==='added'),'summary.json':group(delta(['amount']),'status',null,'count','count')});
out('N16',{'result.json':pick(window(R.customers,'team','score','rank','rank').filter(r=>r.rank<=2),['id','team','score','rank'])});
out('N17',{'result.json':pick(window(R.customers,'team','score','dense','rank').filter(r=>r.rank<=2),['id','team','rank'])});
out('N18',{'result.json':pick(window(R.measures,'group','value','running','running'),['id','group','value','running']),'stats.json':stat(R.measures,'value')});
out('N19',{'result.json':pick(window(large,'group','value','row','rank').filter(r=>r.rank<=3),['id','group','value','rank'])});
const square=R.measures.map(r=>({...r,square:r.value**2}));
out('N20',{'result.json':pick(window(square,'group','square','running','running'),['id','square','running']),'stats.json':stat(square,'square')});
out('N21',{'result.json':stat(R.measures,'value'),'deviation.json':stat(R.measures.map(r=>({...r,deviation:r.value-5.666666666666667})),'deviation')});
const interval=R.measures.filter(r=>r.value>=4&&r.value<=8);
out('N22',{'result.json':stat(interval,'value'),'rows.json':sorted(interval,'value')});
out('N23',{'result.json':stat(weighted,'weighted'),'groups.json':sorted(group(weighted,'group','weighted','average','avg'),'average')});
const merged=unique([...R.before,...R.after],'id');
out('N24',{'result.json':stat(merged,'amount'),'rows.json':sorted(merged,'amount')});
out('N25',{'result.json':R.measures.map(r=>{const a=R.measures.filter(x=>x.group===r.group);const average=a.reduce((s,x)=>s+x.value,0)/a.length;return {...r,average,residual:r.value-average};})});
out('N26',{'result.json':{order:['A','B','C','D','E'],items:['A','B','C','D','E'],count:5},'path.json':{found:true,path:['A','C','D','E'],items:['A','C','D','E'],distance:5,count:4},'critical.json':{path:['A','B','D'],items:['A','B','D'],duration:12,count:3,finishTimes:{A:3,B:7,C:5,D:12,E:6}}});
out('N27',{'result.json':{kind:'schedule',resources:2,duration:12},'risk.json':pick(sorted(R.tasks,'duration'),['id','duration'])});
const chosen=[R.options[0],R.options[2]];
out('N28',{'result.json':sorted(chosen,'value'),'stats.json':stat(chosen,'value')});
out('N29',{'result.json':pick(sorted(R.options.map(r=>({...r,density:r.value/r.weight})),'density'),['id','density']),'serial.json':{kind:'schedule',resources:1,duration:15}});
out('N30',{'result.json':{path:['A','B','D'],items:['A','B','D'],duration:12,count:3,finishTimes:{A:3,B:7,C:5,D:12,E:6}},'schedule.json':{kind:'schedule',resources:3,duration:12}});
out('N31',{'result.json':pick(sorted(tree,'relativePath',false),['relativePath','size','sha256']),'types.json':{kind:'unordered',rows:group(tree,'extension','size','bytes')}});
const matches=pattern=>tree.flatMap(row=>[...row.text.matchAll(pattern)].map(m=>({...row,match:m[0],index:m.index})));
const errors=matches(/ERROR-[0-9]+/g),needles=matches(/needle/g);
out('N32',{'result.json':pick(sorted(errors,'relativePath',false),['relativePath','match','index']),'types.json':group(errors,'extension',null,'count','count')});
out('N33',{'result.json':{kind:'duplicates',groups:[{sha256:hash(F['inputs/tree/deep/copy.txt']),size:Buffer.byteLength(F['inputs/tree/deep/copy.txt']),files:['deep/copy.txt','other/copy.txt']}]},'stats.json':stat(tree,'size')});
out('N34',{'result.json':pick(sorted(needles,'relativePath',false),['relativePath','match','index','sha256']),'types.json':sorted(group(needles,'extension',null,'count','count'),'count')});
out('N35',{'result.json':pick(sorted(unique(tree,'sha256'),'size').slice(0,3),['relativePath','size','sha256'])});
out('N36',{'result.json':R.customers.map(r=>({id:r.id,note:mask(r.note)}))});
const corrected=R.customers.map(r=>({...r,name:r.name.trim().toLowerCase(),note:r.note.replaceAll('주식회사','(주)')}));
out('N37',{'result.json':letters(corrected,'{{id}} | {{name}} | {{note}}')});
const memo=F['inputs/memo.txt'];
out('N38',{'result.json':{characters:[...memo].length,charactersNoWhitespace:[...memo.replace(/\s/g,'')].length,words:memo.trim().split(/\s+/).length,lines:memo.split(/\r?\n/).filter(Boolean).length,sentences:memo.split(/[.!?。！？]+/).filter(s=>s.trim()).length,bytes:Buffer.byteLength(memo),source:null},'errors.json':pick(sorted(errors,'relativePath',false),['relativePath','index'])});
out('N39',{'result.json':letters(active.map(r=>({...r,email:'[REDACTED]'})),'{{name}}: {{email}}')});
out('N40',{'result.json':clean.filter(r=>r.email!==null).map(r=>({id:r.id,name:r.name,email:'[REDACTED]'}))});
function ledger(rows){const minor=s=>{const [whole,frac='']=s.split('.');return BigInt(whole)*100n+BigInt(frac.padEnd(2,'0'));};const debit=rows.reduce((s,r)=>s+minor(r.debit),0n),credit=rows.reduce((s,r)=>s+minor(r.credit),0n);const entries=rows.map(r=>({...r,amountMinor:String(minor(r.debit)-minor(r.credit))}));return {entries,items:entries,count:rows.length,scale:2,debitMinor:String(debit),creditMinor:String(credit),balanceMinor:String(debit-credit),balanced:debit===credit};}
out('N41',{'result.json':ledger(R.ledger),'accounts.json':group(R.ledger,'account',null,'count','count')});
out('N42',{'result.json':ledger(R.ledger.filter(r=>r.account==='A')),'account-b.json':ledger(R.ledger.filter(r=>r.account==='B'))});
out('N43',{'result.json':{value:1.25,from:'m',to:'km',inputValue:1250},'temperature.json':{value:100,from:'f',to:'c',inputValue:212},'time.json':{value:150,from:'h',to:'min',inputValue:2.5}});
out('N44',{'result.csv':{kind:'csv',rows:pick(sorted(group(unitNet,'region','unitNet','average','avg'),'average'),['region','average'])}});
out('N45',{'result.json':['east','west'].map(region=>({region,amount:lines.filter(r=>r.region===region).reduce((s,r)=>s+r.total,0),quantity:lines.filter(r=>r.region===region).reduce((s,r)=>s+r.line.qty,0)}))});
out('N46',{'result.json':pick(sorted(group(paid,'region','net','total'),'total'),['region','total']),'sales.sqlite':{kind:'sqlite',table:'sales',rows:paid.map(({gross,...row})=>row)}});
const finalStock=[R.stock[0],...R.changes];
out('N47',{'result.json':finalStock,'stock.sqlite':{kind:'sqlite',table:'stock',rows:finalStock}});
out('N48',{'result.json':[],'stats.json':stat(R.after,'amount'),'snapshot.sqlite':{kind:'sqlite',table:'snapshot',rows:R.after}});
const publicCustomers=pick(active,['id','name','team','score']);
out('N49',{'result.json':publicCustomers,'result.csv':{kind:'csv',rows:publicCustomers},'customers.sqlite':{kind:'sqlite',table:'customers',rows:publicCustomers}});
out('N50',{'result.json':sorted(group(weighted,'group','weighted','average','avg'),'group',false),'maximum.json':group(weighted,'group','weighted','maximum','max'),'large.sqlite':{kind:'sqlite',table:'metrics',rows:weighted}});

export const NATURAL_MISSION_50_ORACLE_VERSION='natural-mission-50-oracle-v2';
export const naturalMission50OracleContracts=Object.freeze(spec);
export const NATURAL_MISSION_50_ORACLE_SHA256=hash(JSON.stringify({version:NATURAL_MISSION_50_ORACLE_VERSION,contracts:spec}));
function equal(a,b,subsetMode=false){
 if(typeof b==='number')return typeof a==='number'&&Number.isFinite(a)&&Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(b));
 if(b===null||typeof b!=='object')return a===b;
 if(Array.isArray(b))return Array.isArray(a)&&a.length===b.length&&b.every((v,i)=>equal(a[i],v,subsetMode));
 return a&&typeof a==='object'&&!Array.isArray(a)&&(subsetMode||Object.keys(a).length===Object.keys(b).length)&&Object.entries(b).every(([k,v])=>Object.hasOwn(a,k)&&equal(a[k],v,subsetMode));
}
function validateSchedule(actual,contract){const items=actual.items??actual.schedule;if(!Array.isArray(items)||items.length!==R.tasks.length||new Set(items.map(r=>r.id)).size!==R.tasks.length)return false;for(const task of R.tasks){const row=items.find(r=>r.id===task.id);if(!row||!Number.isInteger(row.resource)||row.resource<0||row.resource>=contract.resources||row.start<0||row.end-row.start!==task.duration)return false;for(const dep of task.dependsOn){if(row.start<items.find(r=>r.id===dep).end)return false;}}for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){if(items[i].resource===items[j].resource&&Math.max(items[i].start,items[j].start)<Math.min(items[i].end,items[j].end))return false;}return Math.max(...items.map(r=>r.end))===contract.duration;}
function csvRows(text){const lines=text.trimEnd().split(/\r?\n/);const parse=line=>{const a=[];let value='',quoted=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){a.push(value);value='';}else value+=c;}a.push(value);return a;};const header=parse(lines.shift());return lines.map(line=>Object.fromEntries(parse(line).map((v,i)=>[header[i],v])));}
export async function verifyNaturalMission50Case(caseId,caseRoot){
 const contracts=spec[caseId];if(!contracts)throw new Error(`Unknown oracle ${caseId}`);const checks=[];
 for(const [path,contract] of Object.entries(contracts)){try{const bytes=await readFile(join(caseRoot,path));let passed=false;
  if(contract.kind==='sqlite'){if(bytes.subarray(0,16).toString('binary')!=='SQLite format 3\0')throw new Error('INVALID_SQLITE_HEADER');const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(caseRoot,path),{readOnly:true});try{const rows=db.prepare(`SELECT * FROM ${contract.table}`).all().map(row=>({...row}));const expected=contract.rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='boolean'?Number(v):v])));passed=db.prepare('PRAGMA integrity_check').get().integrity_check==='ok'&&equal(rows,expected);}finally{db.close();}}
  else if(contract.kind==='csv'){const rows=csvRows(bytes.toString('utf8'));passed=equal(rows,contract.rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,String(v)]))));}
  else {const actual=JSON.parse(bytes.toString('utf8'));if(contract.kind==='schedule')passed=validateSchedule(actual,contract);else if(contract.kind==='unordered')passed=Array.isArray(actual)&&actual.length===contract.rows.length&&contract.rows.every(expected=>actual.some(row=>equal(row,expected)));else if(contract.kind==='duplicates'){const groups=Array.isArray(actual)?actual:actual.groups;passed=Array.isArray(groups)&&groups.length===contract.groups.length&&contract.groups.every(expected=>groups.some(g=>g.sha256===expected.sha256&&g.size===expected.size&&g.files?.length===expected.files.length&&equal(g.files.map(f=>f.relativePath).sort(),[...expected.files].sort())&&g.files.every(f=>f.sha256===expected.sha256&&f.size===expected.size)));}else passed=equal(actual,contract.value,contract.kind==='subset');}
  checks.push({path,kind:contract.kind,passed,bytes:bytes.length,sha256:hash(bytes)});
 }catch(error){checks.push({path,kind:contract.kind,passed:false,error:error.code??error.message});}}
 return {caseId,oracleVersion:NATURAL_MISSION_50_ORACLE_VERSION,oracleContractsSha256:NATURAL_MISSION_50_ORACLE_SHA256,passed:checks.length>0&&checks.every(c=>c.passed),checks};
}
