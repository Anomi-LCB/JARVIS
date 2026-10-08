const compact=text=>String(text).replace(/\s+/gu,'');
export function verifyCardLayout(card,layout,width,height){
 const fail=reason=>({passed:false,reason});
 if(layout?.version!==1||layout.complete!==true||!Array.isArray(layout.fields))return fail('card-layout-receipt-missing');
 const expected=new Map(['label','title','subtitle'].filter(role=>card[role])
  .map(role=>[role,String(card[role])]));
 const body=Array.isArray(card.body)?card.body:card.body?[card.body]:[];
 body.forEach((value,index)=>{if(value)expected.set(`body:${index}`,value);});
 if(card.footer)expected.set('footer',String(card.footer));
 const region=layout.contentBounds;
 if(!Array.isArray(region)||region.length!==4||region.some(v=>!Number.isFinite(v))
  ||region[0]<0||region[1]<0||region[2]>width||region[3]>height||region[0]>=region[2]||region[1]>=region[3])return fail('card-layout-region-invalid');
 if(layout.fields.length!==expected.size)return fail('card-layout-field-count-mismatch');
 let bottom=region[1];const seen=new Set();
 for(const [index,field] of layout.fields.entries()){
  if(field.role!==[...expected.keys()][index])return fail('card-layout-field-order-mismatch');
  if(!expected.has(field.role)||seen.has(field.role)||field.text!==expected.get(field.role)
   ||!Array.isArray(field.lines)||!field.lines.length||field.lines.some(line=>typeof line!=='string'||!line)
   ||compact(field.lines.join(''))!==compact(field.text)||!Array.isArray(field.bounds)||field.bounds.length!==field.lines.length
   ||!Number.isInteger(field.fontSize)||field.fontSize<(field.role==='footer'?18:field.role==='title'?24:field.role.startsWith('body:')?20:16))return fail('card-layout-text-incomplete');
  seen.add(field.role);
  for(const bounds of field.bounds){
   if(!Array.isArray(bounds)||bounds.length!==4||bounds.some(v=>!Number.isFinite(v))
    ||bounds[0]<region[0]||bounds[1]<bottom||bounds[2]>region[2]||bounds[3]>region[3]
    ||bounds[0]>=bounds[2]||bounds[1]>=bounds[3])return fail('card-layout-overflow-or-overlap');
   bottom=bounds[3];
  }
 }
 return {passed:true,requiredFieldCount:expected.size,scope:'producer-measured-text-and-bounds',pixelTextVerification:'not-evaluated'};
}
