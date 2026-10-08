import {DatabaseSync} from 'node:sqlite';
import {lstatSync,chmodSync} from 'node:fs';
import {resolve} from 'node:path';

// Core-owned intent, not evidence that the broker or provider revoked anything.
// No resume operation: the operator must provision a different client certificate.
export class DuffelLocalAccessStore {
  #db;
  constructor(path) {
    try {
      const file=resolve(path);
      try {const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error();}
      catch(error){if(error.code!=='ENOENT')throw error;}
      this.#db=new DatabaseSync(file);
      if(process.platform!=='win32')chmodSync(file,0o600);
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS duffel_local_access_holds(fingerprint TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN (\'pending\',\'confirmed\')))');
    }catch{this.#db?.close();throw new Error('A_DUFFEL_LOCAL_ACCESS_STORE_UNAVAILABLE');}
  }
  state(fingerprint) {
    try {
      const row=this.#db.prepare('SELECT state FROM duffel_local_access_holds WHERE fingerprint=?').get(fingerprint);
      if(row&&!['pending','confirmed'].includes(row.state))throw new Error();
      return row?.state??null;
    }catch{throw new Error('A_DUFFEL_LOCAL_ACCESS_STORE_UNAVAILABLE');}
  }
  hold(fingerprint) {
    try{this.#db.prepare("INSERT OR IGNORE INTO duffel_local_access_holds VALUES(?,'pending')").run(fingerprint);}
    catch{throw new Error('A_DUFFEL_LOCAL_ACCESS_STORE_UNAVAILABLE');}
  }
  confirm(fingerprint) {
    try{this.#db.prepare("UPDATE duffel_local_access_holds SET state='confirmed' WHERE fingerprint=?").run(fingerprint);}
    catch{throw new Error('A_DUFFEL_LOCAL_ACCESS_STORE_UNAVAILABLE');}
  }
  close(){this.#db.close();}
}
