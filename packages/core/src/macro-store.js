import {readFileSync,writeFileSync,mkdirSync,lstatSync,fstatSync,openSync,closeSync,fsyncSync,renameSync,unlinkSync,realpathSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
export function macroStorePhysicalPath(path){
  let cursor=resolve(path),suffix=[];
  while(true){try{cursor=resolve(realpathSync(cursor),...suffix);break;}
    catch(error){if(error.code!=='ENOENT'||dirname(cursor)===cursor)throw error;suffix.unshift(basename(cursor));cursor=dirname(cursor);}}
  return process.platform==='win32'?cursor.toLowerCase():cursor;
}
function lockBinding(path){const full=resolve(path);return sha(process.platform==='win32'?full.toLowerCase():full);}
function readMacroLock(path,binding){
  const before=lstatSync(path);
  if(!before.isFile()||before.isSymbolicLink()||before.size>4096)throw Error('MACRO_LOCK_UNVERIFIED');
  const bytes=readFileSync(path),after=lstatSync(path);
  if(!sameFile(before,after)||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('MACRO_LOCK_CHANGED');
  const owner=JSON.parse(bytes.toString('utf8'));
  if(owner.version!=='jarvis-macro-lock-v1'||owner.binding!==binding||!Number.isInteger(owner.pid)||owner.pid<1
    ||typeof owner.nonce!=='string'||!/^[a-f0-9-]{36}$/u.test(owner.nonce))throw Error('MACRO_LOCK_UNVERIFIED');
  return {stat:after,owner,sha256:sha(bytes)};
}
function ownerEnded(pid){
  try{process.kill(pid,0);return false;}
  catch(error){if(error.code==='ESRCH')return true;throw Error('MACRO_LOCK_OWNER_UNVERIFIED');}
}
function removeOwned(path,identity){try{if(sameFile(lstatSync(path),identity))unlinkSync(path);}catch{}}
function createMacroLock(path,binding){
  const fd=openSync(path,'wx'),identity=fstatSync(fd);
  try{writeFileSync(fd,JSON.stringify({version:'jarvis-macro-lock-v1',binding,pid:process.pid,nonce:randomUUID(),createdAt:new Date().toISOString()}));fsyncSync(fd);return fd;}
  catch(error){closeSync(fd);removeOwned(path,identity);throw error;}
}
function acquireMacroLock(storePath,assertAccess){
  const path=storePath+'.lock',binding=lockBinding(storePath);
  try{return createMacroLock(path,binding);}catch(error){if(error.code!=='EEXIST')throw error;}
  const observed=readMacroLock(path,binding);
  if(!ownerEnded(observed.owner.pid))throw Error('MACRO_LOCK_OWNER_ACTIVE');
  const recoveryPath=path+'.recovery',recovery=openSync(recoveryPath,'wx'),identity=fstatSync(recovery);
  try{
    assertAccess();const current=readMacroLock(path,binding);
    if(!sameFile(current.stat,observed.stat)||current.sha256!==observed.sha256||!ownerEnded(current.owner.pid))throw Error('MACRO_LOCK_CHANGED');
    unlinkSync(path);
    return createMacroLock(path,binding);
  }finally{closeSync(recovery);removeOwned(recoveryPath,identity);}
}

// 여러 프로세스(Core·PC-Agent)가 같은 파일을 봐야 하므로 cwd에 의존하지 않는 절대 경로를 쓴다.
function defaultMacroPath() {
  if (process.env.JARVIS_MACRO_PATH) return process.env.JARVIS_MACRO_PATH;
  if (process.env.JARVIS_BRIDGE_STATE_DIR) return join(process.env.JARVIS_BRIDGE_STATE_DIR, 'macros.json');
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.';
  return join(home, '.jarvis', 'macros.json');
}

// 명시적 매크로: 사용자가 이름 붙여 저장한 작업. 자연어로 저장·실행을 인식한다.
// 저장 예: "다운로드 정리를 주간청소로 저장해줘", "이 작업 주간정리로 기억해"
// 실행 예: "주간청소", "주간청소 해줘", "주간정리 실행"
export class MacroStore {
  constructor({ path = null } = {}) {
    this.path = path ?? defaultMacroPath();
    this.macros = this.load();
  }

  snapshot() {
    try{
      const stat=lstatSync(this.path);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)throw Error('MACRO_STORE_UNSAFE');
      const bytes=readFileSync(this.path),after=lstatSync(this.path);
      if(stat.dev!==after.dev||stat.ino!==after.ino||stat.size!==after.size||stat.mtimeMs!==after.mtimeMs)throw Error('MACRO_STORE_CHANGED');
      const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('MACRO_STORE_INVALID');
      const macros=Object.create(null);
      for(const [key,value] of Object.entries(parsed)){
        if(!value||typeof value.name!=='string'||typeof value.command!=='string'||!value.name.trim()||!value.command.trim())throw Error('MACRO_STORE_INVALID');
        macros[key]=value;
      }
      return {macros,identity:{dev:stat.dev,ino:stat.ino,sha256:createHash('sha256').update(bytes).digest('hex')}};
    }catch(error){if(error.code==='ENOENT')return {macros:Object.create(null),identity:null};throw error;}
  }

  load() {
    try{return this.snapshot().macros;}catch(error){this.lastError=error.code??error.message;return Object.create(null);}
  }

  normalizeName(name) {
    return String(name ?? '').trim().replace(/["'']/g, '').toLowerCase();
  }

  prepareSave(name,command) {
    const key=this.normalizeName(name);
    if(!key||typeof command!=='string'||!command.trim())throw Error('MACRO_REQUEST_INVALID');
    const before=this.snapshot(),record={name:String(name).trim().replace(/["'']/g,''),command:command.trim(),createdAt:new Date().toISOString()};
    const next=Object.assign(Object.create(null),before.macros,{[key]:record});
    const bytes=Buffer.from(JSON.stringify(next,null,2));
    if(bytes.length>2*1024*1024)throw Error('MACRO_STORE_TOO_LARGE');
    return {version:'jarvis-macro-publication-v1',path:resolve(this.path),physicalPath:macroStorePhysicalPath(this.path),key,record,
      beforeIdentity:before.identity,expectedSha256:sha(bytes),expectedSize:bytes.length};
  }

  inspectPublication(prepared) {
    if(prepared?.version!=='jarvis-macro-publication-v1'||prepared.path!==resolve(this.path)||prepared.physicalPath!==macroStorePhysicalPath(this.path))throw Error('MACRO_PUBLICATION_INVALID');
    const current=this.snapshot();
    if(current.identity?.sha256!==prepared.expectedSha256
      ||!isDeepStrictEqual(current.macros[prepared.key],prepared.record))throw Error('MACRO_PUBLICATION_UNVERIFIED');
    return {path:resolve(this.path),sha256:current.identity.sha256,record:structuredClone(current.macros[prepared.key])};
  }

  save(name, command, {assertAccess=()=>{},prepared=null}={}) {
    const key = this.normalizeName(name);
    if (!key || typeof command!=='string'||!command.trim()) return false;
    this.lastSavePublished=false;
    let lock=null,lockIdentity=null,stage=null,stageIdentity=null;const lockPath=this.path+'.lock';
    try{
      assertAccess();mkdirSync(dirname(this.path),{recursive:true});
      lock=acquireMacroLock(this.path,assertAccess);lockIdentity=fstatSync(lock);const before=this.snapshot();
      const next=Object.assign(Object.create(null),before.macros);
      if(prepared&&(prepared.version!=='jarvis-macro-publication-v1'||prepared.path!==resolve(this.path)||prepared.physicalPath!==macroStorePhysicalPath(this.path)
        ||prepared.key!==key||prepared.record?.name!==String(name).trim().replace(/["'']/g,'')
        ||prepared.record?.command!==command.trim()||typeof prepared.record?.createdAt!=='string'
        ||!Number.isFinite(Date.parse(prepared.record.createdAt))
        ||JSON.stringify(before.identity)!==JSON.stringify(prepared.beforeIdentity)))throw Error('MACRO_PUBLICATION_CHANGED');
      next[key]=prepared?{name:prepared.record.name,command:prepared.record.command,createdAt:prepared.record.createdAt}:{name:String(name).trim().replace(/["'']/g,''),command:command.trim(),createdAt:new Date().toISOString()};
      const bytes=Buffer.from(JSON.stringify(next,null,2));
      if(prepared&&(sha(bytes)!==prepared.expectedSha256||bytes.length!==prepared.expectedSize))throw Error('MACRO_PUBLICATION_CHANGED');
      if(bytes.length>2*1024*1024)throw Error('MACRO_STORE_TOO_LARGE');
      assertAccess();stage=this.path+'.'+randomUUID()+'.tmp';
      const fd=openSync(stage,'wx');stageIdentity=fstatSync(fd);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
      const stat=lstatSync(stage);stageIdentity={dev:stat.dev,ino:stat.ino};
      assertAccess();
      if(prepared&&prepared.physicalPath!==macroStorePhysicalPath(this.path))throw Error('MACRO_PUBLICATION_CHANGED');
      if(JSON.stringify(this.snapshot().identity)!==JSON.stringify(before.identity))throw Error('MACRO_STORE_CHANGED');
      const currentStage=lstatSync(stage);
      if(currentStage.dev!==stat.dev||currentStage.ino!==stat.ino||!currentStage.isFile()
        ||!readFileSync(stage).equals(bytes))throw Error('MACRO_STAGE_CHANGED');
      renameSync(stage,this.path);stage=null;this.lastSavePublished=true;
      const saved=this.snapshot();
      if(saved.identity.sha256!==createHash('sha256').update(bytes).digest('hex')||saved.macros[key]?.command!==command.trim())throw Error('MACRO_SAVE_UNVERIFIED');
      this.macros=saved.macros;this.lastError=null;return true;
    }catch(error){this.lastError=error.code??error.message;return false;}
    finally{
      if(stage&&stageIdentity){try{const s=lstatSync(stage);if(s.dev===stageIdentity.dev&&s.ino===stageIdentity.ino)unlinkSync(stage);}catch{}}
      if(lock!==null){closeSync(lock);try{const s=lstatSync(lockPath);if(s.dev===lockIdentity.dev&&s.ino===lockIdentity.ino)unlinkSync(lockPath);}catch{}}
    }
  }

  list() {
    return Object.values(this.macros).map((m) => m.name);
  }

  // 이름이 "저장 위치"처럼 보이면 매크로 이름이 아니다("D드라이브로 저장", "다운로드 폴더로 저장").
  looksLikeDestination(name) {
    return /드라이브|폴더|디렉[터토]리|경로|바탕화면|다운로드|문서함|desktop|downloads|documents|^[A-Za-z]:?$|여기|거기/i.test(String(name ?? ''));
  }

  // "다운로드 정리를 '주간청소'로 저장/기억해줘" 형태에서 {name, command}를 뽑는다.
  parseSave(rawText) {
    const text = String(rawText ?? '').trim();
    if (!/(저장|기억)/.test(text)) return null;
    // 형태 A: <명령>을(를)/<공백> <이름>(으)로 저장/기억  (이름은 공백 없는 한 토큰)
    let m = text.match(/^(.+?)[\s을를]+['"]?([가-힣A-Za-z0-9_]{1,20}?)['"]?\s*(?:으로|로)\s*(?:저장|기억)(?:\s*해\s*줘|해|하기|할래|하자|할게)?\s*$/);
    if (m && m[1].trim() && m[2].trim() && !this.looksLikeDestination(m[2])) return { command: m[1].trim(), name: m[2].trim() };
    // 형태 B: <이름>(으)로 저장: <명령>
    m = text.match(/^['"]?([가-힣A-Za-z0-9_ ]{1,20}?)['"]?\s*(?:으로|로)\s*(?:저장|기억)\s*[:：]\s*(.+)$/);
    if (m && m[1].trim() && m[2].trim() && !this.looksLikeDestination(m[1])) return { command: m[2].trim(), name: m[1].trim() };
    return null;
  }

  // 실행 요청이면 저장된 명령을 돌려준다. "주간청소", "주간청소 해줘/실행/불러와" 등.
  resolveRun(rawText) {
    const stripped = String(rawText ?? '').trim().replace(/\s*(해\s*줘|해|실행(해\s*줘)?|불러와|돌려\s*줘?|시작|줘)\s*$/u, '').trim();
    for (const candidate of [rawText.trim(), stripped]) {
      const key = this.normalizeName(candidate);
      if (key && Object.hasOwn(this.macros,key)) return this.macros[key];
    }
    return null;
  }
}
