import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAuthorCommand,validateAuthorAnnotation} from '../scripts/semantic-author-validation.mjs';
const command="'자료.txt'를 읽어줘. '요약.md'에 핵심을 저장해줘. '원본.txt'는 삭제하지 말아줘.";
const requirements=[{text:"'자료.txt'를 읽어줘",action:'read',target:'자료.txt',polarity:'required'},
 {text:"'요약.md'에 핵심을 저장해줘",action:'save',target:'요약.md',polarity:'required'},
 {text:"'원본.txt'는 삭제하지 말아줘",action:'delete',target:'원본.txt',polarity:'prohibited'}];
test('author span validation preserves exact generated request and prohibitions',()=>{
 const result=validateAuthorAnnotation(command,requirements);
 assert.equal(result.length,3);for(const r of result)assert.equal(command.slice(r.sourceSpan.start,r.sourceSpan.end),r.text);
 assert.equal(result[2].polarity,'prohibited');
});
test('descriptions, invented targets, missing text and overlapping annotations are rejected, never repaired',()=>{
 assert.throws(()=>validateAuthorCommand('합성 연구자는 데이터 분석에 관한 새로운 논문을 발표했으며 과학적 내용에 대한 전문적인 분석을 제시했습니다.'),/REQUEST_REQUIRED/);
 assert.throws(()=>validateAuthorCommand("'원본.txt'를 열고 '요약.md'에 내용을 저장한 뒤 작업 목록을 모두 정리하세요."),/PROHIBITION_REQUIRED/);
 assert.doesNotThrow(()=>validateAuthorCommand("'원본.txt'를 여세요. '요약.md'에 내용을 저장하세요. '원본.txt'는 지우지 마세요."));
 assert.throws(()=>validateAuthorAnnotation(command,requirements.map(r=>({...r,polarity:'required'}))),/PROHIBITED_ANNOTATION_REQUIRED/);
 for(const changed of [[{...requirements[0],text:''},...requirements.slice(1)],
  [{...requirements[0],target:'추정 대상'},...requirements.slice(1)],
  [requirements[1],requirements[0],requirements[2]],
  [{...requirements[0],text:'자료를 읽고 요약해줘'},...requirements.slice(1)]])assert.throws(()=>validateAuthorAnnotation(command,changed));
});
test('observed author mistakes cannot become gold by satisfying exact spans',()=>{
 const command="'자료.txt'를 읽어 주세요. 변경 사항을 저장하지 말고 원본을 보존해 주세요. 바로 닫아 주세요.";
 const source=[{text:"'자료.txt'를 읽어 주세요",action:'read',target:'자료.txt',polarity:'required'},
  {text:'변경 사항을 저장하지 말고',action:'delete',target:'변경 사항',polarity:'prohibited'},
  {text:'바로 닫아 주세요.',action:'delete',target:'',polarity:'required'}];
 assert.throws(()=>validateAuthorAnnotation(command,source),/SAVE_PROHIBITION_LABELLED_DELETE/);
 assert.throws(()=>validateAuthorAnnotation(command,[source[0],{...source[1],action:'save'},source[2]]),/CLOSE_LABELLED_DELETE/);
 const reviewed=validateAuthorAnnotation(command,[source[0],{...source[1],action:'save'},{...source[2],action:'unsupported'}]);
 assert.equal(reviewed[1].action,'save');assert.equal(reviewed[2].action,'unsupported');
});
