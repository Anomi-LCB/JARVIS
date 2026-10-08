import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkbookBuffer} from '../apps/pc-agent/src/adapters/excel/xlsx-writer.js';
import {xlsxArchiveContentSha256} from '../packages/core/src/mission/xlsx-cell-evidence.js';

const make=value=>createWorkbookBuffer({sheetName:'Sheet1',columns:['amount'],rows:[[value]]});
test('workbook content identity survives ZIP timestamps and changes with actual sheet data',()=>{
 const original=make(7),dated=Buffer.from(original);
 for(let offset=0;offset<dated.length-46;offset++){
  const signature=dated.readUInt32LE(offset);
  if(signature===0x04034b50){dated.writeUInt16LE(0,offset+10);dated.writeUInt16LE(0,offset+12);}
  if(signature===0x02014b50){dated.writeUInt16LE(0,offset+12);dated.writeUInt16LE(0,offset+14);}
 }
 assert.equal(xlsxArchiveContentSha256(original),xlsxArchiveContentSha256(dated));
 assert.notEqual(xlsxArchiveContentSha256(original),xlsxArchiveContentSha256(make(999)));
});
test('a CRC-corrupt archive never becomes a workbook identity',()=>{
 const bytes=make(7),central=bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
 assert.ok(central>=0);bytes[central+16]^=1;
 assert.throws(()=>xlsxArchiveContentSha256(bytes));
});
