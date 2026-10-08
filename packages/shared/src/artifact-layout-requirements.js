import {createHash} from 'node:crypto';
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed)=>{if(!plain(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw Error('artifact-layout-fields-invalid');};
const text=(value,max=6000)=>{if(typeof value!=='string'||value.length>max||value.includes('\0'))throw Error('artifact-layout-text-invalid');return value;};
export function normalizeLayoutRequirements(kind,value){
 if(kind==='document.paragraphs'){
  if(!Array.isArray(value)||!value.length||value.length>1000)throw Error('artifact-layout-paragraphs-invalid');
  return value.map(item=>text(item));
 }
 if(kind==='document.tables'){
  if(!Array.isArray(value)||value.length>100)throw Error('artifact-layout-tables-invalid');
  return value.map(table=>{
   if(!Array.isArray(table)||!table.length||table.length>1001||!Array.isArray(table[0])||!table[0].length||table[0].length>100)throw Error('artifact-layout-table-invalid');
   return table.map(row=>{if(!Array.isArray(row)||row.length!==table[0].length)throw Error('artifact-layout-table-width-invalid');return row.map(cell=>text(cell));});
  });
 }
 if(kind==='presentation.contentLayout'){
  if(!Array.isArray(value)||!value.length||value.length>40)throw Error('artifact-layout-slides-invalid');
  return value.map(slide=>{keys(slide,['title','bullets','notes']);
   if(!Array.isArray(slide.bullets)||slide.bullets.length>100)throw Error('artifact-layout-bullets-invalid');
   return {title:text(slide.title),bullets:slide.bullets.map(item=>text(item)),notes:text(slide.notes??'')};});
 }
 if(kind==='image.cardLayout'){
  keys(value,['title','label','subtitle','body','footer','accent']);
  if(!Array.isArray(value.body)||value.body.length>20)throw Error('artifact-layout-body-invalid');
  return {title:text(value.title,600),label:text(value.label,120),subtitle:text(value.subtitle,600),body:value.body.map(item=>text(item,6000)),footer:text(value.footer,600),accent:text(value.accent,7)};
 }
 throw Error('artifact-layout-kind-invalid');
}
export function layoutRequirementsSha256(kind,value){return createHash('sha256').update(JSON.stringify(normalizeLayoutRequirements(kind,value))).digest('hex');}
