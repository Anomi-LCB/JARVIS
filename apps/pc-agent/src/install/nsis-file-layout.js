/** Exact reviewed payload paths only; package-folder leftovers are never implicitly distributed. */
export function renderNsisFileLayout({files,optionalFiles=[]}) {
 const optional=new Set(optionalFiles),names=[...files,...optionalFiles];
 if(new Set(names).size!==names.length)throw new Error('PC_INSTALL_DUPLICATE_PAYLOAD_PATH');
 for(const name of names){
  if(typeof name!=='string'||!/^[A-Za-z0-9_./-]+$/u.test(name)||name.startsWith('/')||name.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('PC_INSTALL_UNSAFE_PAYLOAD_PATH');
 }
 const lines=[];let lastDirectory=null;
 for(const name of names.sort()){
  const slash=name.lastIndexOf('/'),directory=slash<0?'':name.slice(0,slash).replaceAll('/','\\');
  if(directory!==lastDirectory){lines.push(`  SetOutPath "$INSTDIR${directory?'\\'+directory:''}"`);lastDirectory=directory;}
  lines.push(`  File ${optional.has(name)?'/nonfatal ':''}"${name.replaceAll('/','\\')}"`);
 }
 lines.push('  SetOutPath "$INSTDIR"');return lines;
}
