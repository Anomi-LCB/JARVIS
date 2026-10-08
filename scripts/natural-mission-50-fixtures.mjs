import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const NATURAL_MISSION_50_FIXTURE_VERSION = 'natural-mission-50-fixtures-v1';
export const records = Object.freeze({
  sales: [
    {id:'s1',customerId:'c1',region:' Seoul ',status:'paid',qty:2,price:120,discount:10,month:'01'},
    {id:'s2',customerId:'c2',region:' BUSAN ',status:'paid',qty:4,price:50,discount:0,month:'01'},
    {id:'s3',customerId:'c1',region:'seoul',status:'pending',qty:8,price:100,discount:5,month:'02'},
    {id:'s4',customerId:'c3',region:'SEOUL',status:'paid',qty:3,price:90,discount:20,month:'02'},
    {id:'s5',customerId:'c4',region:'busan',status:'paid',qty:1,price:80,discount:0,month:'02'},
    {id:'s6',customerId:'c2',region:'DAEJEON',status:'paid',qty:5,price:70,discount:50,month:'02'},
    {id:'s7',customerId:'c5',region:'daejeon',status:'cancelled',qty:2,price:600,discount:0,month:'01'},
    {id:'s8',customerId:'c3',region:'SEOUL',status:'paid',qty:2,price:130,discount:10,month:'01'}
  ],
  customers: [
    {id:'c1',name:' Alice ',email:'ALICE@example.test ',team:'A',score:90,active:true,note:'주식회사 Alpha alice@example.test 010-1234-5678'},
    {id:'c2',name:' BOB',email:'bob@EXAMPLE.test',team:'B',score:85,active:true,note:'주식회사 Beta bob@example.test 010-2222-3333'},
    {id:'c3',name:' CAROL ',email:'carol@example.test',team:'A',score:90,active:true,note:'주식회사 Gamma carol@example.test 010-4444-5555'},
    {id:'c4',name:' DAVE ',email:'  ',team:'B',score:70,active:false,note:'주식회사 Delta no contact'},
    {id:'c5',name:' ALICE ',email:'alice@example.test',team:'A',score:95,active:true,note:'주식회사 Alpha alternate 010-1234-5678'},
    {id:'c6',name:' Eve ',email:'EVE@example.test',team:'B',score:85,active:true,note:'주식회사 Epsilon eve@example.test'}
  ],
  before:[{id:'a',name:'Alpha',amount:10,team:'A'},{id:'b',name:'Beta',amount:20,team:'B'},{id:'c',name:'Gamma',amount:30,team:'A'},{id:'d',name:'Delta',amount:40,team:'B'}],
  after:[{id:'b',name:'Beta',amount:25,team:'B'},{id:'c',name:'Gamma',amount:30,team:'A'},{id:'d',name:'Delta2',amount:40,team:'B'},{id:'e',name:'Epsilon',amount:50,team:'A'}],
  measures:[{id:'m1',group:'A',value:2},{id:'m2',group:'B',value:4},{id:'m3',group:'A',value:4},{id:'m4',group:'B',value:6},{id:'m5',group:'A',value:8},{id:'m6',group:'B',value:10}],
  orders:[{id:'o1',region:'east',lines:[{sku:'p1',qty:2,price:30},{sku:'p2',qty:1,price:50}]},{id:'o2',region:'west',lines:[{sku:'p1',qty:3,price:30},{sku:'p3',qty:4,price:20}]},{id:'o3',region:'east',lines:[{sku:'p3',qty:2,price:20}]}],
  tasks:[{id:'A',duration:3,dependsOn:[]},{id:'B',duration:4,dependsOn:['A']},{id:'C',duration:2,dependsOn:['A']},{id:'D',duration:5,dependsOn:['B','C']},{id:'E',duration:1,dependsOn:['C']}],
  graph:{nodes:['A','B','C','D','E'],edges:[['A','B',3],['A','C',2],['B','D',4],['C','D',2],['D','E',1],['B','E',9]]},
  options:[{id:'A',weight:6,value:30},{id:'B',weight:3,value:14},{id:'C',weight:4,value:16},{id:'D',weight:2,value:9}],
  ledger:[{id:'l1',account:'A',debit:'0.10',credit:'0.00'},{id:'l2',account:'A',debit:'0.20',credit:'0.00'},{id:'l3',account:'B',debit:'0.00',credit:'0.30'},{id:'l4',account:'B',debit:'1000000000000.01',credit:'999999999999.99'}],
  stock:[{id:'p1',name:'연필',quantity:10},{id:'p2',name:'공책',quantity:5}],
  changes:[{id:'p2',name:'공책',quantity:8},{id:'p3',name:'지우개',quantity:4}]
});
const csv = (rows) => `${Object.keys(rows[0]).join(',')}\n${rows.map(row=>Object.values(row).join(',')).join('\n')}\n`;
export const NATURAL_MISSION_50_FILE_CONTENTS = Object.freeze({
  ...Object.fromEntries(Object.entries(records).map(([name,value])=>[`inputs/${name}.json`,`${JSON.stringify(value,null,2)}\n`])),
  'inputs/sales.csv':csv(records.sales),
  'inputs/memo.txt':'System ERROR-101 retry.\nContact alice@example.test.\nERROR-203 recovered!\n한국어 보고서 완료.\n',
  'inputs/tree/a.log':'ERROR-101 service unavailable\nneedle alpha\n',
  'inputs/tree/deep/b.log':'INFO start\nERROR-203 timeout\nneedle beta\n',
  'inputs/tree/deep/copy.txt':'동일한 바이트 payload\n',
  'inputs/tree/other/copy.txt':'동일한 바이트 payload\n',
  'inputs/tree/notes.md':'# notes\nneedle gamma\nERROR-404 missing\n',
  'inputs/large.json':`${JSON.stringify(Array.from({length:2000},(_,i)=>({id:`r${String(i).padStart(4,'0')}`,group:['A','B','C','D'][i%4],value:i%100,weight:(i%7)+1})))}\n`
});
const hash = value=>createHash('sha256').update(value).digest('hex');
export const NATURAL_MISSION_50_FIXTURE_MANIFEST = Object.freeze(Object.entries(NATURAL_MISSION_50_FILE_CONTENTS).sort(([a],[b])=>a.localeCompare(b)).map(([path,content])=>({path,size:Buffer.byteLength(content),sha256:hash(content)})));
export const NATURAL_MISSION_50_FIXTURE_SHA256 = hash(JSON.stringify({version:NATURAL_MISSION_50_FIXTURE_VERSION,files:NATURAL_MISSION_50_FIXTURE_MANIFEST}));
export async function materializeNaturalMission50Fixture(testCase,caseRoot){
  for(const [path,content] of Object.entries(NATURAL_MISSION_50_FILE_CONTENTS)){const target=join(caseRoot,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,content,'utf8');}
  return {files:NATURAL_MISSION_50_FIXTURE_MANIFEST,inputManifestSha256:NATURAL_MISSION_50_FIXTURE_SHA256};
}
