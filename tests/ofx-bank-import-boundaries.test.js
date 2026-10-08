import test from 'node:test';import assert from 'node:assert/strict';import {importOfxBankStatement as parse,parseOfxPostedDate,parseOfxAmountMinor} from '../packages/shared/src/ofx-bank-statement-import.js';
const row=date=>`<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>${date}</DTPOSTED><TRNAMT>-1.00</TRNAMT><FITID>one</FITID></STMTTRN>`;
const file=(date,extra='')=>`<OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS><CURDEF>USD</CURDEF><BANKACCTFROM><BANKID>synthetic</BANKID><ACCTID>A</ACCTID></BANKACCTFROM><BANKTRANLIST>${row(date)}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1>${extra}</OFX>`;const options={currencyExponents:{USD:2}};
test('OFX invalid calendar dates and unsupported message sets are not silently imported',()=>{
 assert.throws(()=>parse(file('20260230'),options),{code:'FINANCIAL_OFX_DATE_INVALID'});
 assert.throws(()=>parse(file('20261001','<INVSTMTMSGSRSV1/>'),options),{code:'FINANCIAL_OFX_UNSUPPORTED'});
});

test('OFX preserves source timezone and validates leap calendar and clock bounds',()=>{
 assert.equal(parseOfxPostedDate('20260228120000.123[9:KST]').utc,'2026-02-28T03:00:00.123Z');
 assert.equal(parseOfxPostedDate('20240229').utc,'2024-02-29T00:00:00.000Z');
 for(const value of ['20260229','20261001240000','20261001126000','20261001120000[13:X]'])assert.throws(()=>parseOfxPostedDate(value),{code:'FINANCIAL_OFX_DATE_INVALID'});
 assert.throws(()=>parseOfxPostedDate('20261001120060'),{code:'FINANCIAL_OFX_LEAP_SECOND_UNSUPPORTED'});
});

test('OFX amount forms and original fields survive without float rounding',()=>{
 for(const [value,expected] of [['+1.20',120],[' 550. ',55000],['-1,25',-125],['1,000',100]])assert.equal(parseOfxAmountMinor(value,2),expected);
 for(const value of ['1,234.56','1.2.3','1e2'])assert.throws(()=>parseOfxAmountMinor(value,2),{code:'FINANCIAL_OFX_AMOUNT_INVALID'});
 const xml=file('20261001').replace('<BANKTRANLIST>','<BANKTRANLIST><DTSTART>20261001</DTSTART><DTEND>20261101</DTEND>').replace('</FITID>','</FITID><MEMO>synthetic &amp; text</MEMO>');
 const result=parse(xml,options);assert.equal(result.records[0].originalFields.find(x=>x.name==='MEMO').text,'synthetic & text');assert.equal(result.statements[0].range.DTEND.utc,'2026-11-01T00:00:00.000Z');
 assert.throws(()=>parse(xml.replace('<DTSTART>20261001','<DTSTART>20261201'),options),{code:'FINANCIAL_OFX_RANGE_INVALID'});
});
