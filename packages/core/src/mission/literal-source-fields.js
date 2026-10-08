const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
const fail=code=>{throw Object.assign(new Error(code),{code});};
function fieldBoundary(source){
  // Newline is a terminator only in an explicitly structured label:value
  // document. Ordinary wrapped prose must not turn "0원\n이 아니다" into 0.
  const lines=source.split(/\r?\n/u).filter(line=>line.trim());
  return lines.length&&lines.every(line=>/^[^:\r\n]{1,80}:\s*\S.*$/u.test(line))?'(?=[.!。\\r\\n]|$)':'(?=[.!。]|$)';
}
export function sourceQuoteMask(source){
  const pairs={"'":"'",'"':'"','“':'”','‘':'’','「':'」','『':'』'};const stack=[],mask=new Uint8Array(source.length);
  for(let i=0;i<source.length;i++){
    mask[i]=stack.length>0?1:0;
    if(source[i]==='\\'){if(i+1<source.length)mask[i+1]=mask[i];i++;continue;}
    if(stack.length&&source[i]===stack.at(-1))stack.pop();
    else if(Object.hasOwn(pairs,source[i]))stack.push(pairs[source[i]]);
  }
  return mask;
}
function correctedInteger(source,spec,quoted){
  if(typeof spec.unit!=='string'||!spec.unit.length||spec.unit.length>12||/[\r\n]/u.test(spec.unit))fail('A_SOURCE_FIELDS_INVALID');
  const label=escape(spec.label),unit=escape(spec.unit);
  const outside=m=>!quoted[m.index]&&(m.index===0||!/[가-힣A-Za-z0-9"'“‘]/u.test(source[m.index-1]));
  const standalone=m=>source.slice(0,m.index).split(/[.!。\n]/u).at(-1).trim()==='';
  // Every unquoted declaration or revision must be understood, not silently dropped.
  const references=[...source.matchAll(new RegExp(label+'\\s*(?:은|는|:|정정)','gu'))].filter(outside);
  const base=new RegExp(`${label}\\s*(?:은|는|:)\\s*([0-9]{1,200})\\s*${unit}(?:이다|입니다)?${fieldBoundary(source)}`,'u');
  const revision=new RegExp(`${label}\\s*정정\\s*:\\s*([0-9]{1,200})\\s*${unit}\\s*→\\s*([0-9]{1,200})\\s*${unit}${fieldBoundary(source)}`,'u');
  let value=null,start=null,end=null;
  for(const reference of references){
    if(!standalone(reference))fail('A_SOURCE_FIELDS_NOT_EXPLICIT');
    const tail=source.slice(reference.index),initial=base.exec(tail),change=revision.exec(tail);
    if(initial?.index===0){
      if(value!==null)fail('A_SOURCE_FIELDS_AMBIGUOUS');
      value=initial[1];start=reference.index;end=start+initial[0].length;
    }else if(change?.index===0){
      if(value===null||BigInt(change[1])!==BigInt(value))fail('A_SOURCE_FIELDS_CORRECTION_CONFLICT');
      value=change[2];end=reference.index+change[0].length;
    }else fail('A_SOURCE_FIELDS_NOT_EXPLICIT');
  }
  if(value===null)fail('A_SOURCE_FIELDS_NOT_EXPLICIT');
  const evidence=source.slice(start,end);
  if(evidence.length>400)fail('A_SOURCE_FIELDS_EVIDENCE_LIMIT');
  return {value,evidence};
}
function attributedInteger(source,spec,quoted){
  if(typeof spec.actor!=='string'||!spec.actor.trim()||spec.actor.length>80||/[\r\n]/u.test(spec.actor)
    ||typeof spec.unit!=='string'||!spec.unit.length||spec.unit.length>12||/[\r\n]/u.test(spec.unit))fail('A_SOURCE_FIELDS_INVALID');
  const head=`${escape(spec.actor)}\\s*주장\\s*:\\s*${escape(spec.label)}\\s*(?:은|는|:)`;
  const references=[...source.matchAll(new RegExp(head,'gu'))].filter(m=>!quoted[m.index]
    &&(m.index===0||!/[가-힣A-Za-z0-9"'“‘]/u.test(source[m.index-1])));
  if(references.length!==1)fail(references.length?'A_SOURCE_FIELDS_AMBIGUOUS':'A_SOURCE_FIELDS_NOT_EXPLICIT');
  const reference=references[0];
  if(source.slice(0,reference.index).split(/[.!。\n]/u).at(-1).trim()!=='')fail('A_SOURCE_FIELDS_NOT_EXPLICIT');
  const match=new RegExp(`^${head}\\s*([0-9]{1,200})\\s*${escape(spec.unit)}(?:이다|입니다)?${fieldBoundary(source)}`,'u').exec(source.slice(reference.index));
  if(!match)fail('A_SOURCE_FIELDS_NOT_EXPLICIT');
  return {value:match[1],evidence:match[0]};
}
/** Explicit caller-bound source fields only; no inferred labels, model, authority or real-world truth claim. */
export function extractLiteralSourceFields({source,questions,valueFormats,sourceFields}){
  if(!sourceFields||typeof sourceFields!=='object'||Array.isArray(sourceFields))fail('A_SOURCE_FIELDS_INVALID');
  const ids=Object.keys(questions);
  if(Object.keys(sourceFields).length!==ids.length||!ids.every(id=>Object.hasOwn(sourceFields,id)))fail('A_SOURCE_FIELDS_INCOMPLETE');
  const facts={},evidence={},quoted=sourceQuoteMask(source);
  for(const id of ids){
    const spec=sourceFields[id];
    if(!spec||typeof spec.label!=='string'||!spec.label.trim()||spec.label.length>80||/[\r\n]/u.test(spec.label))fail('A_SOURCE_FIELDS_INVALID');
    if(spec.kind==='corrected-integer'){
      if(valueFormats[id]!=='digits')fail('A_SOURCE_FIELDS_FORMAT_MISMATCH');
      const result=correctedInteger(source,spec,quoted);facts[id]=result.value;evidence[id]=result.evidence;continue;
    }
    if(spec.kind==='attributed-integer'){
      if(valueFormats[id]!=='digits')fail('A_SOURCE_FIELDS_FORMAT_MISMATCH');
      const result=attributedInteger(source,spec,quoted);facts[id]=result.value;evidence[id]=result.evidence;continue;
    }
    const label=escape(spec.label);let body,format;
    const references=[...source.matchAll(new RegExp(label+'\\s*(?:은|는|:)','gu'))]
      .filter(m=>(m.index===0||!/[가-힣A-Za-z0-9"'“‘]/u.test(source[m.index-1]))&&!quoted[m.index]);
    if(references.length!==1)fail(references.length?'A_SOURCE_FIELDS_AMBIGUOUS':'A_SOURCE_FIELDS_NOT_EXPLICIT');
    if(spec.kind==='integer'){
      if(typeof spec.unit!=='string'||spec.unit.length>12||/[\r\n]/u.test(spec.unit))fail('A_SOURCE_FIELDS_INVALID');
      format='digits';body=`${label}\\s*(?:은|는|:)\\s*([0-9]+)\\s*${escape(spec.unit)}(?:이다|입니다|이었다|였습니다)?`;
    }else if(spec.kind==='enum'){
      if(!Array.isArray(spec.choices)||!spec.choices.length||spec.choices.length>12||spec.choices.some(v=>typeof v!=='string'||!v.length||v.length>30||/[\r\n]/u.test(v)))fail('A_SOURCE_FIELDS_INVALID');
      format='source-phrase';body=`${label}\\s*(?:은|는|:)\\s*(${spec.choices.map(escape).join('|')})(?:이다|입니다|다)?`;
    }else if(spec.kind==='unknown-date'){
      format='iso-date-or-unknown';body=`${label}\\s*(?:은|는|:)\\s*(제시하지 않았다|미정|없음)(?:이다|입니다)?`;
    }else fail('A_SOURCE_FIELDS_INVALID');
    if(valueFormats[id]!==format)fail('A_SOURCE_FIELDS_FORMAT_MISMATCH');
    const regex=new RegExp(body+fieldBoundary(source),'gu');
    const matches=[...source.matchAll(regex)].filter(m=>{
      if(quoted[m.index]||(m.index>0&&/[가-힣A-Za-z0-9"'“‘]/u.test(source[m.index-1])))return false;
      const prefix=source.slice(0,m.index).split(/[.!。\n]/u).at(-1).trim();
      // Numeric and status declarations require a standalone field clause.
      // An unavailable date may follow explanatory prose but never a conditional/attributed clause.
      return spec.kind==='unknown-date'?!/만약|경우|가정|라면|주장|발언/u.test(prefix):prefix==='';
    });
    if(matches.length!==1)fail(matches.length?'A_SOURCE_FIELDS_AMBIGUOUS':'A_SOURCE_FIELDS_NOT_EXPLICIT');
    const match=matches[0];facts[id]=spec.kind==='unknown-date'?'미정':match[1];evidence[id]=match[0];
  }
  return {facts,evidence};
}
