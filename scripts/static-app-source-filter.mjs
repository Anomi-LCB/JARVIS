/** Native build caches are not web-console source and may contain open locks. */
export function staticAppSourceFilter(source){
 const parts=String(source).split(/[\\/]/u);
 if(parts.some(p=>['.gradle','.jarvis-gradle-includes','.cxx'].includes(p)))return false;
 const android=parts.lastIndexOf('android');
 return android<0||!parts.slice(android+1).includes('build');
}
