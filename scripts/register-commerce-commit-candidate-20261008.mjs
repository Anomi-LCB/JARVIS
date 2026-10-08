import {readFile,writeFile} from 'node:fs/promises';
const path='config/research-candidates.json',value=JSON.parse(await readFile(path,'utf8'));
if(!value.candidates.some(c=>c.id==='commerce-final-commit-boundary')){
 value.candidates.push({id:'commerce-final-commit-boundary',title:'거래 준비 이후 최종 발신 권한과 AP2 연결 경계',problem:'비Mission 주문의 최종 권한 재확인과 AP2 어댑터 확인 전달이 빠져 준비 이후 철회/변경을 발신 직전에 차단하지 못한다.',priority:1,sources:[{url:'https://ucp.dev/specification/overview/',checkedAt:'2026-10-08',revision:'공식 인증·결제·보안·권한 경계; 로컬 구현은 고정 SDK 버전 별도 유지'},{url:'https://github.com/google-agentic-commerce/AP2',checkedAt:'2026-10-08',revision:'공식 AP2 원본 재조회; 기존 고정 SDK 서명 및 UCP bridge 계약 비교'}],nextExperiment:'최종 발신 fence에 현재 위임/정책/견적/연결 상태를 연결하고 실제 로컬 TLS·SDK 서명·응답 손실/조회 전용 반례를 비교한다. 이어 목적별 자료범위/전송 경로를 점검한다. 실계정 거래는 별도 조건과 증거가 필요하다.'});
 await writeFile(path,JSON.stringify(value,null,2)+'\n');
}
