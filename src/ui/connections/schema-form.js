import { escape } from '../workspace/model.js';
const unsafe = new Set(['__proto__','prototype','constructor']);
const fieldName = path => `field:${encodeURIComponent(JSON.stringify(path))}`;
export function schemaFields(schema) {
  const fields=[];
  const visit=(node,path,required,depth)=>{
    if(depth>6 || fields.length>48 || !node || typeof node !== 'object' || ['$ref','oneOf','anyOf','allOf','pattern'].some(key=>key in node))throw new Error('SCHEMA_FORM_UNSUPPORTED');
    if(node.type === 'object') {
      const properties=Object.entries(node.properties ?? {});
      if(!properties.length && path.length)throw new Error('SCHEMA_FORM_UNSUPPORTED');
      for(const [key,child] of properties){if(unsafe.has(key))throw new Error('SCHEMA_FORM_UNSUPPORTED');visit(child,[...path,key],required && (node.required ?? []).includes(key),depth+1);}
      return;
    }
    if(!['string','number','integer','boolean','null','array'].includes(node.type))throw new Error('SCHEMA_FORM_UNSUPPORTED');
    if(node.type === 'array' && (!node.items || !['string','number','integer','boolean'].includes(node.items.type)))throw new Error('SCHEMA_FORM_UNSUPPORTED');
    if(node.enum?.some(value=>value !== null && typeof value === 'object'))throw new Error('SCHEMA_FORM_UNSUPPORTED');
    fields.push({path,name:fieldName(path),schema:node,required});
  };
  if(schema?.type !== 'object')return {supported:false,fields:[]};
  try{visit(schema,[],true,0);return {supported:true,fields};}catch{return {supported:false,fields:[]};}
}
export function renderSchemaForm(schema, prefix) {
  const contract=schemaFields(schema);
  if(!contract.supported)return '<p>이 계약은 일반 입력창으로 표시할 수 없습니다. 고급 JSON 입력을 사용하고 서버 검사를 확인하세요.</p>';
  if(!contract.fields.length)return '<p>추가 입력이 필요하지 않은 도구입니다.</p>';
  return contract.fields.map((field,index)=>{
    const {schema:node,name,required,path}=field,id=`${prefix}-field-${index}`;
    const label=escape(node.title || path.join(' · '));
    const attr=`id="${escape(id)}" name="${escape(name)}"`;
    let input;
    if(node.enum)input=`<select ${attr}><option value="">선택해 주세요</option>${node.enum.map(value=>`<option value="${escape(JSON.stringify(value))}">${escape(String(value))}</option>`).join('')}</select>`;
    else if(node.type === 'boolean' || node.type === 'null')input=`<select ${attr}><option value="">선택해 주세요</option>${node.type === 'null' ? '<option value="null">값 없음</option>' : '<option value="true">예</option><option value="false">아니오</option>'}</select>`;
    else if(node.type === 'array')input=`<textarea ${attr} rows="3" placeholder="한 줄에 하나씩 입력하세요"></textarea>`;
    else if(['integer','number'].includes(node.type))input=`<input ${attr} type="number" step="${node.type === 'integer' ? '1' : 'any'}" ${Number.isFinite(node.minimum) ? `min="${node.minimum}"` : ''} ${Number.isFinite(node.maximum) ? `max="${node.maximum}"` : ''}>`;
    else input=`<input ${attr} type="text" ${Number.isInteger(node.maxLength) ? `maxlength="${node.maxLength}"` : ''}>`;
    return `<label for="${escape(id)}">${label}${required ? ' · 필수' : ' · 선택'}${input}${node.description ? `<small>${escape(node.description)}</small>` : ''}</label>`;
  }).join('');
}
export function parseSchemaForm(schema, entries) {
  const contract=schemaFields(schema);if(!contract.supported)throw new Error('SCHEMA_FORM_UNSUPPORTED');
  const values=new Map(entries),result={};
  const scalar=(value,node)=>{
    if(node.type === 'string')return value;
    if(node.type === 'boolean'){if(!['true','false'].includes(value))throw new Error('FORM_VALUE_INVALID');return value === 'true';}
    if(node.type === 'null'){if(value !== 'null')throw new Error('FORM_VALUE_INVALID');return null;}
    const n=Number(value);if(!value.trim() || !Number.isFinite(n) || node.type === 'integer' && !Number.isSafeInteger(n))throw new Error('FORM_NUMBER_INVALID');return n;
  };
  for(const field of contract.fields){
    const raw=values.get(field.name) ?? '';if(typeof raw !== 'string')throw new Error('FORM_VALUE_INVALID');
    if(raw === ''){if(field.required)throw new Error('FORM_REQUIRED');continue;}
    let value;
    if(field.schema.enum){try{value=JSON.parse(raw);}catch{throw new Error('FORM_ENUM_INVALID');}if(!field.schema.enum.some(item=>Object.is(item,value)))throw new Error('FORM_ENUM_INVALID');}
    else if(field.schema.type === 'array')value=raw.split(/\r?\n/).map(line=>scalar(line,field.schema.items));
    else value=scalar(raw,field.schema);
    let object=result;for(const key of field.path.slice(0,-1)){object[key]??={};object=object[key];}object[field.path.at(-1)]=value;
  }
  return result; // Core validates the authoritative contract and permission again.
}
