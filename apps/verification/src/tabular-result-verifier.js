// Independent postcondition checker. Does not import the F calculation engine.
export function verifyTabularProcedureResult({definition,rows,result}={}) {
 const reject=()=>({status:'failed',verifierId:'g-tabular-result-v1',checks:[{checkId:'source-result-correspondence',status:'failed'}]});
 try {
  if(!Array.isArray(rows)||!rows.length||rows.length>1000||!result?.success||!Array.isArray(result.resultRows))return reject();
  const normalized=s=>String(s).normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/[\s_\-./()[\]{}]+/gu,'');
  const keys=[...new Set(rows.flatMap(row=>Object.keys(row)))];
  const role=aliases=>keys.filter(key=>aliases.some(alias=>normalized(alias)===normalized(key)));
  const groups=role(definition.groupAliases),values=role(definition.valueAliases);
  if(groups.length!==1||values.length!==1||groups[0]===values[0]||result.groupColumn!==groups[0]||result.valueColumn!==values[0])return reject();
  const source=rows.map(row=>{
   if(!Object.hasOwn(row,groups[0])||!Object.hasOwn(row,values[0]))throw Error('missing');
   const raw=row[values[0]];
   if(typeof raw!=='number'&&(typeof raw!=='string'||! /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(raw.trim())))throw Error('value');
   const group=String(row[groups[0]]??'').normalize('NFC').trim(),value=Number(raw);
   if(!group||!Number.isFinite(value))throw Error('value');return {group,value};
  });
  const names=[...new Set(source.map(item=>item.group))];
  if(result.resultRows.length!==names.length)return reject();
  const observed=new Set();
  for(const actual of result.resultRows){
   if(observed.has(actual.group)||!names.includes(actual.group))return reject();observed.add(actual.group);
   const selected=source.filter(item=>item.group===actual.group);
   const total=selected.reduce((sum,item)=>sum+item.value,0);
   if(!Number.isFinite(total)||actual.count!==selected.length||!Number.isFinite(actual.total)
     ||actual.total!==Number(total.toFixed(8)))return reject();
  }
  return {status:'passed',verifierId:'g-tabular-result-v1',checks:[{checkId:'physical-column-uniqueness',status:'passed'},{checkId:'source-group-count-total',status:'passed'}]};
 }catch{return reject();}
}
