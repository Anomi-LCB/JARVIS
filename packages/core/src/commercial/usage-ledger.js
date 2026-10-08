import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const id=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9:_-]{1,200}$/.test(value))fail('C_ID_INVALID');return value;};
const amount=value=>{if(!Number.isSafeInteger(value)||value<0)fail('C_CREDITS_INVALID');return value;};
const digest=value=>createHash('sha256').update(value).digest('hex');

export function verifyPaddleSignature(raw,header,secret,now=Date.now()){
  if(!Buffer.isBuffer(raw)||raw.length>256*1024||typeof header!=='string'||header.length>1000||typeof secret!=='string'||secret.length<16)fail('C_WEBHOOK_SIGNATURE_INVALID');
  const parts=header.split(';').map(part=>part.trim().split('=')),timestamps=parts.filter(p=>p[0]==='ts'),signatures=parts.filter(p=>p[0]==='h1');
  if(timestamps.length!==1||!/^\d{1,12}$/.test(timestamps[0][1])||Math.abs(now/1000-Number(timestamps[0][1]))>5)fail('C_WEBHOOK_TIMESTAMP_INVALID');
  const expected=createHmac('sha256',secret).update(timestamps[0][1]+':').update(raw).digest();
  if(!signatures.some(([,value])=>/^[a-f0-9]{64}$/i.test(value??'')&&timingSafeEqual(expected,Buffer.from(value,'hex'))))fail('C_WEBHOOK_SIGNATURE_INVALID');
}

/** Internal billing kernel. Production callers must bind accountId to verified identity.
 * Never expose registerCheckout/settle or provider costs as browser-controlled operations.
 * Missing production auth, Paddle approval or model prices means no commercial activation.
 */
export class CommercialUsageLedger {
  constructor({db,webhookSecret,clock=()=>Date.now()}={}){
    if(!db?.prepare||!db?.exec)fail('C_PERSISTENT_STORE_REQUIRED');
    this.db=db;this.webhookSecret=webhookSecret;this.clock=clock;
    db.exec(`CREATE TABLE IF NOT EXISTS commercial_checkouts(transaction_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,price_id TEXT NOT NULL,currency TEXT NOT NULL,credits INTEGER NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS commercial_events(event_id TEXT PRIMARY KEY,content_hash TEXT NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commercial_grants(transaction_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,credits INTEGER NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS commercial_usage(request_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,transaction_id TEXT NOT NULL,request_hash TEXT NOT NULL,max_credits INTEGER NOT NULL,status TEXT NOT NULL,actual_credits INTEGER);`);
  }
  atomic(action){this.db.exec('BEGIN IMMEDIATE');try{const result=action();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  registerCheckout({transactionId,accountId,priceId,currency,credits,expiresAt}){
    id(transactionId);id(accountId);id(priceId);amount(credits);
    if(!credits||!['KRW','USD','EUR'].includes(currency)||!Number.isSafeInteger(expiresAt)||expiresAt<=this.clock())fail('C_CHECKOUT_INVALID');
    const args=[transactionId,accountId,priceId,currency,credits,expiresAt];
    const old=this.db.prepare('SELECT * FROM commercial_checkouts WHERE transaction_id=?').get(transactionId);
    if(old){if(JSON.stringify(Object.values(old))!==JSON.stringify(args))fail('C_CHECKOUT_CONFLICT');return {registered:true,replayed:true};}
    this.db.prepare('INSERT INTO commercial_checkouts VALUES(?,?,?,?,?,?)').run(...args);return {registered:true,replayed:false};
  }
  webhook(raw,signature){
    verifyPaddleSignature(raw,signature,this.webhookSecret,this.clock());
    let event;try{event=JSON.parse(raw.toString('utf8'));}catch{fail('C_WEBHOOK_JSON_INVALID');}
    id(event.event_id);const hash=digest(raw);
    return this.atomic(()=>{
      const old=this.db.prepare('SELECT * FROM commercial_events WHERE event_id=?').get(event.event_id);
      if(old){if(old.content_hash!==hash)fail('C_WEBHOOK_REPLAY_CONFLICT');return {status:old.status,replayed:true};}
      let status='unsupported-event';
      if(event.event_type==='transaction.completed'){
        const purchase=event.data,binding=this.db.prepare('SELECT * FROM commercial_checkouts WHERE transaction_id=?').get(id(purchase?.id));
        if(!binding)fail('C_CHECKOUT_BINDING_REQUIRED');
        if(purchase.status!=='completed'||purchase.currency_code!==binding.currency||purchase.items?.length!==1||purchase.items[0].price?.id!==binding.price_id||purchase.items[0].quantity!==1)fail('C_CHECKOUT_PROVIDER_MISMATCH');
        const grant=this.db.prepare('SELECT * FROM commercial_grants WHERE transaction_id=?').get(purchase.id);
        if(!grant)this.db.prepare('INSERT INTO commercial_grants VALUES(?,?,?,?)').run(purchase.id,binding.account_id,binding.credits,binding.expires_at);
        status='granted';
      }
      this.db.prepare('INSERT INTO commercial_events VALUES(?,?,?)').run(event.event_id,hash,status);
      return {status,replayed:false};
    });
  }
  summary(accountId){
    id(accountId);
    const row=this.db.prepare(`SELECT COALESCE(SUM(credits),0) total FROM commercial_grants WHERE account_id=? AND expires_at>?`).get(accountId,this.clock());
    const usage=this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN u.status='settled' THEN u.actual_credits ELSE 0 END),0) spent,
      COALESCE(SUM(CASE WHEN u.status IN ('reserved','running','uncertain') THEN u.max_credits ELSE 0 END),0) held
      FROM commercial_usage u JOIN commercial_grants g ON g.transaction_id=u.transaction_id WHERE u.account_id=? AND g.expires_at>?`).get(accountId,this.clock());
    return {included:row.total,used:usage.spent,reserved:usage.held,remaining:Math.max(0,row.total-usage.spent-usage.held),automaticOverage:false};
  }
  reserve({accountId,requestId,requestHash,maxCredits}){
    id(accountId);id(requestId);amount(maxCredits);
    if(!maxCredits||!/^[a-f0-9]{64}$/.test(requestHash??''))fail('C_RESERVATION_INVALID');
    return this.atomic(()=>{
      const prior=this.db.prepare('SELECT * FROM commercial_usage WHERE request_id=?').get(requestId);
      if(prior){if(prior.account_id!==accountId||prior.request_hash!==requestHash||prior.max_credits!==maxCredits)fail('C_REQUEST_CONFLICT');return {status:prior.status,replayed:true};}
      const grants=this.db.prepare('SELECT * FROM commercial_grants WHERE account_id=? AND expires_at>? ORDER BY expires_at').all(accountId,this.clock());
      const grant=grants.find(g=>{
        const consumed=this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN status='settled' THEN actual_credits WHEN status IN ('reserved','running','uncertain') THEN max_credits ELSE 0 END),0) total FROM commercial_usage WHERE transaction_id=?`).get(g.transaction_id);
        return g.credits-consumed.total>=maxCredits;
      });
      if(!grant)fail('C_USAGE_LIMIT_REACHED');
      this.db.prepare('INSERT INTO commercial_usage VALUES(?,?,?,?,?,?,NULL)').run(requestId,accountId,grant.transaction_id,requestHash,maxCredits,'reserved');
      return {status:'reserved',replayed:false};
    });
  }
  transition(accountId,requestId,{operation,actualCredits=null}){
    id(accountId);id(requestId);
    return this.atomic(()=>{
      const item=this.db.prepare('SELECT * FROM commercial_usage WHERE request_id=? AND account_id=?').get(requestId,accountId);
      if(!item)fail('C_RESERVATION_NOT_FOUND');
      if(operation==='begin'){
        if(item.status==='running')return {status:'running',dispatchAllowed:false};
        const grant=this.db.prepare('SELECT expires_at FROM commercial_grants WHERE transaction_id=?').get(item.transaction_id);
        if(item.status!=='reserved'||grant.expires_at<=this.clock())fail('C_DISPATCH_NOT_ALLOWED');
        this.db.prepare("UPDATE commercial_usage SET status='running' WHERE request_id=?").run(requestId);return {status:'running',dispatchAllowed:true};
      }
      if(operation==='cancel'){
        if(item.status==='settled'||item.status==='released')return {status:item.status};
        const status=item.status==='reserved'?'released':'uncertain';this.db.prepare('UPDATE commercial_usage SET status=? WHERE request_id=?').run(status,requestId);return {status};
      }
      if(operation==='settle'){
        amount(actualCredits);if(actualCredits>item.max_credits)fail('C_COST_ABOVE_RESERVED_LIMIT');
        if(item.status==='settled'){if(item.actual_credits!==actualCredits)fail('C_SETTLEMENT_CONFLICT');return {status:'settled'};}
        if(!['running','uncertain'].includes(item.status))fail('C_SETTLEMENT_NOT_ALLOWED');
        this.db.prepare("UPDATE commercial_usage SET status='settled',actual_credits=? WHERE request_id=?").run(actualCredits,requestId);return {status:'settled'};
      }
      fail('C_USAGE_OPERATION_INVALID');
    });
  }
}
