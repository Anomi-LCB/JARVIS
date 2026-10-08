import {createHash} from 'node:crypto';
const volatileKeys=new Set(['observedAt','evaluatedAt','checkedAt']);
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().filter(key=>!volatileKeys.has(key)).map(key=>[key,stable(value[key])])):value;
export function dependencyImpactDigest(value){return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');}
