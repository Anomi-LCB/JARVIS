export function desktopPayloadWouldLoseContent(args) {
  const tooLong = (value, limits) => Object.entries(limits).some(([key,max]) => value?.[key] != null && String(value[key]).trim().length > max);
  const targetInvalid = value => tooLong(value,{processName:120,title:300,titleContains:300,className:200});
  const selectorInvalid = value => tooLong(value,{automationId:240,name:500,nameContains:500,className:200,controlType:80})
    || value?.index != null && (!Number.isInteger(Number(value.index)) || Number(value.index)<0 || Number(value.index)>100);
  if (targetInvalid(args.target)) return true;
  for (const operation of (Array.isArray(args.operations)?args.operations.slice(0,16):[])) {
    if (targetInvalid(operation?.target) || selectorInvalid(operation?.selector)
      || tooLong(operation,{op:40,filePath:500,keys:2000,text:500,targetLabel:300,templatePath:1000})
      || operation?.value != null && String(operation.value).length>8000
      || operation?.occurrence != null && (!Number.isInteger(Number(operation.occurrence)) || Number(operation.occurrence)<0 || Number(operation.occurrence)>20)) return true;
    if (operation?.arguments !== undefined && (!Array.isArray(operation.arguments) || operation.arguments.length>16
      || operation.arguments.some(arg => arg == null || !String(arg).trim() || String(arg).trim().length>500))) return true;
  }
  for (const check of (Array.isArray(args.verification)?args.verification.slice(0,12):[])) {
    if (targetInvalid(check?.target) || selectorInvalid(check?.selector) || tooLong(check,{type:60})
      || check?.expected != null && String(check.expected).length>8000) return true;
  }
  return false;
}

