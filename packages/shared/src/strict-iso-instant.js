/** An explicit, known-offset instant. Never repairs a calendar date or 24:00.
 * Returns null for invalid/unknown time; caller chooses its domain error.
 * No timezone inference or execution authority is supplied by this parser. */
export function normalizeStrictIsoInstant(value,{requireSeconds=true}={}){
 if(typeof value!=='string')return null;
 const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
 if(!m||(requireSeconds&&m[6]===undefined))return null;
 const [year,month,day,hour,minute,second]=m.slice(1,7).map(v=>Number(v??0));
 const leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 if(month<1||month>12||day<1||day>days[month-1]||hour>23||minute>59||second>59)return null;
 const offset=m[8];
 if(offset!=='Z'&&(Number(offset.slice(1,3))>23||Number(offset.slice(4))>59||offset==='-00:00'))return null;
 const epoch=Date.parse(value);if(!Number.isFinite(epoch))return null;
 const normalized=new Date(epoch).toISOString();
 // Other stores compare canonical four-digit UTC strings chronologically.
 return /^\d{4}-/u.test(normalized)?normalized:null;
}
