import { readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeConnectorPage } from './source-inbox.js';

/** Watches only the local import spool; no remote credentials or network calls. */
export class PersonalImportWorker {
  constructor({inbox,directory,intervalMs=30000}) {
    this.inbox=inbox;this.directory=directory;this.intervalMs=intervalMs;this.timer=null;this.pending=null;
    this.state={running:false,lastCheckedAt:null,processedFiles:0,failedFiles:0,error:null,remoteSyncEnabled:false};
    inbox.store.db.exec('CREATE TABLE IF NOT EXISTS personal_import_files(digest TEXT PRIMARY KEY,processed_at TEXT NOT NULL)');
  }
  status(){return {...this.state};}
  start(){if(this.timer)return;this.state.running=true;this.timer=setInterval(()=>{void this.run();},this.intervalMs);this.timer.unref();void this.run();}
  async stop(){clearInterval(this.timer);this.timer=null;this.state.running=false;await this.pending;}
  run(){if(this.pending)return this.pending;this.pending=this.scan().finally(()=>{this.pending=null;});return this.pending;}
  async scan(){
    let processed=0,failed=0;this.state.error=null;
    try {
      const entries=await readdir(this.directory,{withFileTypes:true});
      for(const entry of entries.filter(x=>x.isFile()&&x.name.endsWith('.json')).sort((a,b)=>a.name.localeCompare(b.name))){
        if(processed+failed>=100)break;
        try {
          const path=join(this.directory,entry.name),info=await lstat(path);
          if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw new Error('A_IMPORT_FILE_INVALID');
          const body=await readFile(path,'utf8'),digest=createHash('sha256').update(body).digest('hex'),db=this.inbox.store.db;
          if(db.prepare('SELECT 1 FROM personal_import_files WHERE digest=?').get(digest))continue;
          this.inbox.ingest(normalizeConnectorPage(JSON.parse(body.replace(/^\uFEFF/u,''))));
          db.prepare('INSERT OR IGNORE INTO personal_import_files VALUES(?,?)').run(digest,new Date().toISOString());processed++;
        } catch(error){failed++;this.state.error=String(error.message).startsWith('A_')?error.message:'A_IMPORT_READ_FAILED';}
      }
    } catch(error){if(error.code!=='ENOENT'){failed++;this.state.error='A_IMPORT_DIRECTORY_UNAVAILABLE';}}
    this.state.lastCheckedAt=new Date().toISOString();this.state.processedFiles+=processed;this.state.failedFiles=failed;
    return this.status();
  }
}
