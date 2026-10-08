import { createHash } from 'node:crypto';

export const NATURAL_MISSION_50_CORPUS_VERSION='natural-mission-50-corpus-v1';
const q=x=>`'${x}'`;
const read=(file,name,csv=false)=>`${q(`inputs/${file}.${csv?'csv':'json'}`)} ${csv?'CSV를':'JSON을'} ${q(name)}로 읽고`;
const save=(name,path='result.json')=>`${q(name)}를 ${q(`outputs/${path}`)} ${path.endsWith('.csv')?'CSV':'JSON'}으로 저장하고`;
const fields=(from,list,to)=>`${q(from)}에서 필드 ${list.map(q).join(', ')}만 추출해 ${q(to)}로 만들고`;
const filter=(from,field,value,to,op='인')=>`${q(from)}에서 ${q(field)}가 ${typeof value==='string'?q(value):value}${op} 행만 ${q(to)}로 걸러내고`;
const sort=(from,field,to,order='내림차순')=>`${q(from)}를 ${q(field)} ${order}으로 정렬해 ${q(to)}로 만들고`;
const derive=(from,field,expr,to)=>`${q(from)}에 ${q(field)} = ${expr}를 계산해 ${q(to)}로 만들고`;
const group=(from,key,field,alias,to,kind='합계')=>`${q(from)}를 ${q(key)}별로 ${q(field)} ${kind} ${q(alias)}을 계산해 ${q(to)}로 만들고`;
const norm=(from,list,to,opts='공백제거 소문자 빈값null')=>`${q(from)}의 필드 ${list.map(q).join(', ')}을 ${opts}로 정규화해 ${q(to)}로 만들고`;
const window=(from,partition,value,kind,as,to)=>`${q(from)}을 그룹 ${q(partition)}, 정렬 ${q(value)} 내림차순, 값 ${q(value)} 기준 ${kind} ${q(as)}를 계산해 ${q(to)}로 만들고`;
const stats=(from,field,to)=>`${q(from)}의 ${q(field)} 통계를 계산해 ${q(to)}로 만들고`;
const join=(a,b,ka,kb,to,type='내부')=>`${q(a)}과 ${q(b)}을 ${q(ka)}와 ${q(kb)} 기준으로 ${type} 조인해 ${q(to)}로 만들고`;
const count=(name,n)=>`${q(name)}의 행 수가 ${n}인지 검증해`;
const cases=[];
function add(title,category,clauses,outputs=['outputs/result.json']){const id=`N${String(cases.length+1).padStart(2,'0')}`;cases.push({id,title,category,requirementCount:clauses.length,clauses,command:clauses.join('; '),outputs});}

add('매출 할인·고객 결합·지역 순위와 고객 공개표','sales-intelligence',[
  read('sales','매출',true),norm('매출',['region'],'표준매출'),derive('표준매출','gross',"'qty' * 'price'",'총액'),derive('총액','net',"'gross' - 'discount'",'순액'),filter('순액','status','paid','결제'),read('customers','고객'),fields('고객',['id','name','team'],'고객키'),join('결제','고객키','customerId','id','상세'),group('상세','region','net','total','지역합'),sort('지역합','total','지역순위'),fields('지역순위',['region','total'],'출력'),save('출력'),window('상세','team','net','순위','rank','팀순위'),fields('팀순위',['id','team','net','rank'],'팀출력'),save('팀출력','teams.json'),count('출력',3)
],['outputs/result.json','outputs/teams.json']);
add('판매 수익률·월별 피벗·상위 판매와 분포 보고','sales-intelligence',[
 read('sales','원본',true),norm('원본',['region'],'정리'),derive('정리','gross',"'qty' * 'price'",'총액'),derive('총액','net',"'gross' - 'discount'",'순액'),derive('순액','unitNet',"'net' / 'qty'",'단가'),filter('단가','status','paid','결제'),sort('결제','net','금액순'),"'금액순'에서 0행부터 3행을 추출해 '상위'로 만들고",fields('상위',['id','net','unitNet'],'상위표'),save('상위표'),"'결제'를 행 'region', 열 'month', 값 'net'의 합계로 피벗해 '월표'로 만들고",save('월표','pivot.json'),stats('결제','net','분포'),save('분포','stats.json'),count('상위표',3)
],['outputs/result.json','outputs/pivot.json','outputs/stats.json']);
add('주문 품목 전개·품목별 총액·지역 통계','sales-intelligence',[
 read('orders','주문'),"'주문'의 'lines' 배열을 'line'으로 펼쳐 '품목'으로 만들고",derive('품목','total',"'line.qty' * 'line.price'",'품목금액'),filter('품목금액','total',40,'유효','이상인'),group('유효','line.sku','total','total','품목합'),sort('품목합','total','품목순'),save('품목순'),group('유효','region','total','total','지역합'),sort('지역합','total','지역순'),save('지역순','regions.json'),stats('유효','total','통계'),save('통계','stats.json'),count('품목순',3)
],['outputs/result.json','outputs/regions.json','outputs/stats.json']);
add('매출 대비 수량·고객별 평균·재집계','sales-intelligence',[
 read('sales','원장',true),filter('원장','status','paid','결제'),derive('결제','gross',"'qty' * 'price'",'총액'),derive('총액','net',"'gross' - 'discount'",'순액'),group('순액','customerId','net','average','고객평균','평균'),read('customers','고객'),fields('고객',['id','name','team'],'고객정보'),join('고객평균','고객정보','customerId','id','고객결합'),sort('고객결합','average','고객순'),fields('고객순',['customerId','team','average'],'보고'),save('보고'),group('순액','customerId','qty','quantity','수량'),sort('수량','quantity','수량순'),save('수량순','quantity.json'),count('보고',4)
],['outputs/result.json','outputs/quantity.json']);
add('다단 할인 영향 분석과 지역별 누적 매출','sales-intelligence',[
 read('sales','원본',true),norm('원본',['region'],'표준'),derive('표준','gross',"'qty' * 'price'",'총액'),derive('총액','net',"'gross' - 'discount'",'순액'),filter('순액','status','paid','결제'),window('결제','region','net','누적합','running','누적'),fields('누적',['id','region','net','running'],'누적표'),save('누적표'),filter('결제','discount',0,'할인','초과인'),group('할인','region','discount','discountTotal','할인합'),sort('할인합','discountTotal','할인순'),save('할인순','discount.json'),stats('할인','discount','할인분포'),save('할인분포','stats.json'),count('누적표',6)
],['outputs/result.json','outputs/discount.json','outputs/stats.json']);

add('중복 연락처 정리·개인정보 마스킹·팀 우수고객','customer-quality',[
 read('customers','고객'),norm('고객',['name','email'],'정리'),"'정리'의 'email' 기준 중복을 제거해 '고유'로 만들고",filter('고유','active',true,'활성'),filter('활성','email',null,'연락가능','아닌'),sort('연락가능','score','점수순'),fields('점수순',['id','name','email','team','score'],'명단'),"'명단'의 필드 'email'을 이메일 마스킹해 '보호'로 만들고",save('보호'),window('연락가능','team','score','밀집순위','rank','순위'),fields('순위',['id','team','score','rank'],'팀표'),save('팀표','teams.json'),stats('연락가능','score','통계'),save('통계','stats.json'),count('보호',4)
],['outputs/result.json','outputs/teams.json','outputs/stats.json']);
add('고객 메모 익명화·회사명 통일·대량 인사 문서','customer-quality',[
 read('customers','고객'),norm('고객',['name'],'정리'),filter('정리','active',true,'활성'),"'활성'의 필드 'note'에서 '주식회사'를 '(주)'로 치환해 '회사정리'로 만들고","'회사정리'의 필드 'note'을 이메일 마스킹해 '메일보호'로 만들고","'메일보호'의 필드 'note'을 전화번호 마스킹해 '보호'로 만들고",sort('보호','score','점수순'),fields('점수순',['id','name','note'],'공개'),save('공개'),"'공개'에 템플릿 '안녕하세요 {{name}}님, 고객번호 {{id}}입니다.'을 적용해 '문서'로 만들고",save('문서','letters.json'),group('활성','team','score','average','팀평균','평균'),save('팀평균','teams.json'),count('공개',5)
],['outputs/result.json','outputs/letters.json','outputs/teams.json']);
add('활성 고객의 주문 결합·팀별 구매액·우선 응대','customer-quality',[
 read('customers','고객'),norm('고객',['name','email'],'정리'),filter('정리','active',true,'활성'),read('sales','판매'),filter('판매','status','paid','결제'),derive('결제','net',"'qty' * 'price' - 'discount'",'금액'),fields('활성',['id','name','team'],'키'),join('금액','키','customerId','id','결합'),group('결합','team','net','total','합계'),sort('합계','total','우선순'),fields('우선순',['team','total'],'팀표'),save('팀표'),sort('결합','net','주문순'),fields('주문순',['id','customerId','name','net'],'주문표'),save('주문표','orders.json'),count('팀표',2)
],['outputs/result.json','outputs/orders.json']);
add('연락처 누락 감사·전체 고객 점수순위·진단 통계','customer-quality',[
 read('customers','고객'),norm('고객',['name','email'],'정리'),filter('정리','email',null,'누락'),fields('누락',['id','name','email'],'누락표'),save('누락표'),filter('정리','email',null,'정상','아닌'),"'정상'의 'email' 기준 중복을 제거해 '고유'로 만들고",window('고유','team','score','순위','rank','순위'),fields('순위',['id','team','score','rank'],'순위표'),save('순위표','ranking.json'),stats('고유','score','분포'),save('분포','stats.json'),group('정리','team','score','maximum','팀최고','최댓값'),save('팀최고','maximum.json'),count('누락표',1)
],['outputs/result.json','outputs/ranking.json','outputs/stats.json','outputs/maximum.json']);
add('고객 세그먼트 계산·정렬·마스킹·안내문 결합','customer-quality',[
 read('customers','고객'),norm('고객',['name','email'],'정리'),derive('정리','gap',"100 - 'score'",'격차'),filter('격차','active',true,'활성'),window('활성','team','gap','행번호','position','응대'),fields('응대',['id','name','team','gap','position'],'응대표'),save('응대표'),group('활성','team','gap','gapTotal','팀격차'),sort('팀격차','gapTotal','팀순'),save('팀순','teams.json'),"'활성'의 필드 'note'을 이메일 마스킹해 '메일보호'로 만들고","'메일보호'의 필드 'note'을 전화번호 마스킹해 '전체보호'로 만들고",fields('전체보호',['id','note'],'공개메모'),save('공개메모','notes.json'),count('응대표',5)
],['outputs/result.json','outputs/teams.json','outputs/notes.json']);

add('재고 기준일 대사와 상태별 변동 개수','reconciliation',[read('before','이전'),read('after','현재'),"'이전'과 '현재'를 키 'id', 비교 필드 'name', 'amount'로 대사해 '차이'로 만들고",sort('차이','status','정렬','오름차순'),save('정렬'),"'차이'를 'status'별로 개수 'count'를 계산해 '상태집계'로 만들고",save('상태집계','summary.json')],['outputs/result.json','outputs/summary.json']);
add('증액 항목의 변경 전후 금액과 차액','reconciliation',[read('before','이전'),read('after','현재'),"'이전'과 '현재'를 키 'id', 비교 필드 'name', 'amount'로 대사해 '차이'로 만들고",filter('차이','status','changed','변경'),derive('변경','delta',"'after.amount' - 'before.amount'",'차액'),filter('차액','delta',0,'증액','초과인'),fields('증액',['key','before','after','delta'],'보고'),save('보고')]);
add('대사 제거 항목과 변경 항목을 별도 산출','reconciliation',[read('before','이전'),read('after','현재'),"'이전'과 '현재'를 키 'id', 비교 필드 'name', 'amount'로 대사해 '차이'로 만들고",filter('차이','status','removed','제거'),save('제거'),filter('차이','status','changed','변경'),save('변경','changed.json')],['outputs/result.json','outputs/changed.json']);
add('두 시점 결합 후 ID 중복 제거와 팀 합계','reconciliation',[read('before','이전'),read('after','현재'),"'현재'과 '이전'를 합쳐 '통합'으로 만들고","'통합'의 'id' 기준 중복을 제거해 '고유'로 만들고",group('고유','team','amount','total','합계'),sort('합계','total','순서'),fields('순서',['team','total'],'결과'),save('결과')]);
add('동일 항목을 제외한 대사 후 추가 레코드 검증','reconciliation',[read('before','이전'),read('after','현재'),"'이전'과 '현재'를 키 'id', 비교 필드 'amount'로 대사해 '차이'로 만들고",filter('차이','status','added','추가'),save('추가'),count('추가',1),"'차이'를 'status'별로 개수 'count'를 계산해 '현황'으로 만들고",save('현황','summary.json')],['outputs/result.json','outputs/summary.json']);

add('동점 포함 경쟁 순위와 팀별 상위 두 명','ranking-window',[read('customers','선수'),window('선수','team','score','순위','rank','경쟁순'),filter('경쟁순','rank',2,'상위','이하인'),fields('상위',['id','team','score','rank'],'결과'),save('결과')]);
add('밀집순위에서 2위 이내 고객 선택','ranking-window',[read('customers','고객'),window('고객','team','score','밀집순위','rank','순위'),filter('순위','rank',2,'상위','이하인'),fields('상위',['id','team','rank'],'결과'),save('결과')]);
add('부서별 누적 측정값과 전체 분산','ranking-window',[read('measures','측정'),window('측정','group','value','누적합','running','누적'),fields('누적',['id','group','value','running'],'보고'),save('보고'),stats('측정','value','통계'),save('통계','stats.json')],['outputs/result.json','outputs/stats.json']);
add('2000행 부하 데이터의 그룹별 랭킹과 상위값','ranking-window',[read('large','대량'),window('대량','group','value','행번호','rank','순위'),filter('순위','rank',3,'상위','이하인'),fields('상위',['id','group','value','rank'],'결과'),save('결과'),count('결과',12)]);
add('그룹별 계산 점수의 누적 합계와 전체 최댓값','ranking-window',[read('measures','원본'),derive('원본','square',"'value' * 'value'",'제곱'),window('제곱','group','square','누적합','running','누적'),fields('누적',['id','square','running'],'결과'),save('결과'),stats('제곱','square','통계'),save('통계','stats.json')],['outputs/result.json','outputs/stats.json']);

add('중앙값·사분위수와 평균 중심 편차','statistical-analysis',[read('measures','자료'),stats('자료','value','원통계'),save('원통계'),derive('자료','deviation',"'value' - 5.666666666666667",'편차'),stats('편차','deviation','편차통계'),save('편차통계','deviation.json')],['outputs/result.json','outputs/deviation.json']);
add('정렬 파일 생성·재조회·통계 교차 확인','statistical-analysis',[read('measures','측정'),filter('측정','value',4,'하한','이상인'),filter('하한','value',8,'구간','이하인'),sort('구간','value','정렬'),save('정렬','rows.json'),"'outputs/rows.json' JSON을 '재조회'로 읽고",stats('재조회','value','통계'),save('통계'),count('재조회',4)],['outputs/result.json','outputs/rows.json']);
add('대량 데이터 가중점수의 분포 및 그룹 평균','statistical-analysis',[read('large','대량'),derive('대량','weighted',"'value' * 'weight'",'가중'),stats('가중','weighted','통계'),save('통계'),group('가중','group','weighted','average','평균','평균'),sort('평균','average','순서'),save('순서','groups.json')],['outputs/result.json','outputs/groups.json']);
add('서로 다른 표본 합친 뒤 ID 중복 제거와 평균','statistical-analysis',[read('before','표본1'),read('after','표본2'),"'표본1'과 '표본2'를 합쳐 '모집단'으로 만들고","'모집단'의 'id' 기준 중복을 제거해 '유일표본'으로 만들고",stats('유일표본','amount','통계'),save('통계'),sort('유일표본','amount','순서'),save('순서','rows.json')],['outputs/result.json','outputs/rows.json']);
add('그룹 평균을 원본에 결합한 관측값별 잔차','statistical-analysis',[read('measures','측정'),group('측정','group','value','average','평균','평균'),join('측정','평균','group','group','결합'),derive('결합','residual',"'value' - 'average'",'잔차'),fields('잔차',['id','group','value','average','residual'],'결과'),save('결과')]);

add('의존 작업 위상순서·최단 경로·마감 임계 경로','graph-planning',[read('graph','그래프'),"'그래프'의 그래프를 위상 정렬해 '순서'로 만들고",save('순서'),"'그래프'의 그래프에서 'A'부터 'E'까지 최단 경로를 계산해 '경로'로 만들고",save('경로','path.json'),read('tasks','작업'),"'작업'의 임계 경로를 계산해 '임계'로 만들고",save('임계','critical.json')],['outputs/result.json','outputs/path.json','outputs/critical.json']);
add('두 자원 일정과 작업 길이순 위험표','graph-planning',[read('tasks','작업'),"'작업'을 자원 2개로 일정 계산해 '일정'으로 만들고",save('일정'),sort('작업','duration','기간순'),fields('기간순',['id','duration'],'위험표'),save('위험표','risk.json'),count('일정',5)],['outputs/result.json','outputs/risk.json']);
add('예산 제한 최대가치 선택과 선택집합 통계','graph-planning',[read('options','후보'),"'후보'에서 용량 10으로 최대가치 선택해 '선택'으로 만들고",sort('선택','value','가치순'),save('가치순'),stats('선택','value','통계'),save('통계','stats.json')],['outputs/result.json','outputs/stats.json']);
add('최적 선택 가치밀도와 자원별 편성 결과','graph-planning',[read('options','후보'),derive('후보','density',"'value' / 'weight'",'밀도'),sort('밀도','density','밀도순'),fields('밀도순',['id','density'],'선택표'),save('선택표'),read('tasks','작업'),"'작업'을 자원 1개로 일정 계산해 '직렬'으로 만들고",save('직렬','serial.json')],['outputs/result.json','outputs/serial.json']);
add('임계 경로와 병렬 일정의 작업 수 교차검증','graph-planning',[read('tasks','작업'),"'작업'의 임계 경로를 계산해 '임계'로 만들고",save('임계'),"'작업'을 자원 3개로 일정 계산해 '병렬'으로 만들고",save('병렬','schedule.json'),count('병렬',5)],['outputs/result.json','outputs/schedule.json']);

add('디렉터리 해시 인벤토리와 확장자별 바이트','file-forensics',["'inputs/tree' 폴더의 파일을 재귀 해시 목록으로 조사해 '파일'로 만들고",fields('파일',['relativePath','size','sha256'],'증거'),sort('증거','relativePath','정렬','오름차순'),save('정렬'),group('파일','extension','size','bytes','유형'),save('유형','types.json')],['outputs/result.json','outputs/types.json']);
add('정규식 오류번호 추출과 파일별 발생횟수','file-forensics',["'inputs/tree' 폴더에서 정규식 'ERROR-[0-9]+'를 재귀 검색해 '오류'로 만들고",fields('오류',['relativePath','match','index'],'증거'),sort('증거','relativePath','정렬','오름차순'),save('정렬'),"'오류'를 'extension'별로 개수 'count'를 계산해 '유형'으로 만들고",save('유형','types.json')],['outputs/result.json','outputs/types.json']);
add('내용 중복 그룹과 전체 파일의 바이트 통계','file-forensics',["'inputs/tree' 폴더의 내용 중복을 찾아 '중복'으로 만들고",save('중복'),"'inputs/tree' 폴더의 파일을 재귀 해시 목록으로 조사해 '전체'로 만들고",stats('전체','size','통계'),save('통계','stats.json')],['outputs/result.json','outputs/stats.json']);
add('리터럴 검색 증거와 검색된 파일 확장자 순위','file-forensics',["'inputs/tree' 폴더에서 문자열 'needle'를 재귀 검색해 '검색'으로 만들고",fields('검색',['relativePath','match','index','sha256'],'증거'),sort('증거','relativePath','정렬','오름차순'),save('정렬'),"'검색'를 'extension'별로 개수 'count'를 계산해 '유형'으로 만들고",sort('유형','count','순위'),save('순위','types.json')],['outputs/result.json','outputs/types.json']);
add('해시 중복 제외 파일 크기 상위 목록','file-forensics',["'inputs/tree' 폴더의 파일을 재귀 해시 목록으로 조사해 '파일'로 만들고","'파일'의 'sha256' 기준 중복을 제거해 '고유'로 만들고",sort('고유','size','크기순'),"'크기순'에서 0행부터 3행을 추출해 '상위'로 만들고",fields('상위',['relativePath','size','sha256'],'결과'),save('결과')]);

add('민감 메모의 이메일·전화번호 동시 마스킹','document-privacy',[read('customers','고객'),"'고객'의 필드 'note'을 이메일 마스킹해 '메일보호'로 만들고","'메일보호'의 필드 'note'을 전화번호 마스킹해 '완전보호'로 만들고",fields('완전보호',['id','note'],'공개'),save('공개')]);
add('회사명 치환과 고객명 정규화 후 안내문 생성','document-privacy',[read('customers','고객'),norm('고객',['name'],'정리'),"'정리'의 필드 'note'에서 '주식회사'를 '(주)'로 치환해 '교정'으로 만들고","'교정'에 템플릿 '{{id}} | {{name}} | {{note}}'을 적용해 '문서'로 만들고",save('문서')]);
add('문서 통계·오류 검색·파일 증거 동시 생성','document-privacy',["'inputs/memo.txt' 텍스트를 '메모'로 읽고","'메모'의 텍스트 통계를 계산해 '통계'로 만들고",save('통계'),"'inputs/tree' 폴더에서 문자열 'ERROR'를 재귀 검색해 '오류'로 만들고",fields('오류',['relativePath','index'],'목록'),sort('목록','relativePath','정렬','오름차순'),save('정렬','errors.json')],['outputs/result.json','outputs/errors.json']);
add('비활성 고객 제외 후 익명 이메일 연락 안내문','document-privacy',[read('customers','고객'),filter('고객','active',true,'활성'),norm('활성',['name','email'],'정리'),"'정리'의 필드 'email'을 이메일 마스킹해 '보호'로 만들고","'보호'에 템플릿 '{{name}}: {{email}}'을 적용해 '안내'로 만들고",save('안내')]);
add('정규화 후 빈값 감사와 민감정보 없는 연락처','document-privacy',[read('customers','고객'),norm('고객',['name','email'],'정리'),filter('정리','email',null,'정상','아닌'),"'정상'의 필드 'email'을 이메일 마스킹해 '익명'으로 만들고",fields('익명',['id','name','email'],'결과'),save('결과')]);

add('초대형 소수 원장과 계정별 거래 건수','exact-finance',[read('ledger','분개'),"'분개'를 소수 2자리 원장으로 계산해 '잔액'으로 만들고",save('잔액'),"'분개'를 'account'별로 개수 'count'를 계산해 '계정'으로 만들고",save('계정','accounts.json')],['outputs/result.json','outputs/accounts.json']);
add('계정 A 원장·계정 B 원장·전체 잔액 교차 보고','exact-finance',[read('ledger','분개'),filter('분개','account','A','A계정'),"'A계정'를 소수 2자리 원장으로 계산해 'A잔액'으로 만들고",save('A잔액'),filter('분개','account','B','B계정'),"'B계정'를 소수 2자리 원장으로 계산해 'B잔액'으로 만들고",save('B잔액','account-b.json')],['outputs/result.json','outputs/account-b.json']);
add('길이·온도·시간 단위 변환 패키지','exact-finance',["1250 'm'를 'km'로 변환해 '거리'로 만들고",save('거리'),"212 'f'를 'c'로 변환해 '온도'로 만들고",save('온도','temperature.json'),"2.5 'h'를 'min'로 변환해 '시간'으로 만들고",save('시간','time.json')],['outputs/result.json','outputs/temperature.json','outputs/time.json']);
add('금액 순이익·단가·지역 평균과 CSV 보고','exact-finance',[read('sales','매출'),filter('매출','status','paid','결제'),derive('결제','net',"'qty' * 'price' - 'discount'",'금액'),derive('금액','unitNet',"'net' / 'qty'",'단가'),norm('단가',['region'],'지역정리'),group('지역정리','region','unitNet','average','평균','평균'),sort('평균','average','순위'),fields('순위',['region','average'],'결과'),save('결과','result.csv')],['outputs/result.csv']);
add('품목 전개 후 가중 총액과 수량 대사','exact-finance',[read('orders','주문'),"'주문'의 'lines' 배열을 'line'으로 펼쳐 '행'으로 만들고",derive('행','amount',"'line.qty' * 'line.price'",'금액'),group('금액','region','amount','amount','총액'),group('금액','region','line.qty','quantity','수량'),join('총액','수량','region','region','대조'),fields('대조',['region','amount','quantity'],'보고'),save('보고')]);

add('SQLite 거래 저장·재조회·지역 집계','sqlite-persistence',[read('sales','매출'),filter('매출','status','paid','결제'),derive('결제','net',"'qty' * 'price' - 'discount'",'금액'),norm('금액',['region'],'표준'),"'표준'을 'outputs/sales.sqlite' SQLite의 'sales' 테이블에 교체 저장해 'DB'로 만들고","'DB'의 'sales' 테이블을 '조회'로 읽고",group('조회','region','net','total','지역합'),sort('지역합','total','순위'),fields('순위',['region','total'],'결과'),save('결과')],['outputs/result.json','outputs/sales.sqlite']);
add('SQLite 재고 업서트와 행 수·수량 확인','sqlite-persistence',[read('stock','기본'),"'기본'을 'outputs/stock.sqlite' SQLite의 'stock' 테이블에 교체 저장해 'DB'로 만들고",read('changes','변경'),"'변경'을 'outputs/stock.sqlite' SQLite의 'stock' 테이블에 키 'id'로 갱신 저장해 'DB2'로 만들고","'DB2'의 'stock' 테이블을 '현재'로 읽고",sort('현재','id','순서','오름차순'),save('순서'),count('순서',3)],['outputs/result.json','outputs/stock.sqlite']);
add('SQLite 저장 후 원본 대사로 영속성 검증','sqlite-persistence',[read('after','원본'),"'원본'을 'outputs/snapshot.sqlite' SQLite의 'snapshot' 테이블에 교체 저장해 'DB'로 만들고","'DB'의 'snapshot' 테이블을 '재조회'로 읽고","'원본'과 '재조회'를 키 'id', 비교 필드 'name', 'amount'로 대사해 '차이'로 만들고",save('차이'),count('차이',0),stats('재조회','amount','통계'),save('통계','stats.json')],['outputs/result.json','outputs/stats.json','outputs/snapshot.sqlite']);
add('SQLite 정규화 고객 명단의 JSON·CSV 일치','sqlite-persistence',[read('customers','고객'),norm('고객',['name','email'],'정리'),filter('정리','active',true,'활성'),fields('활성',['id','name','team','score'],'명단'),"'명단'을 'outputs/customers.sqlite' SQLite의 'customers' 테이블에 교체 저장해 'DB'로 만들고","'DB'의 'customers' 테이블을 '조회'로 읽고",sort('조회','id','순서','오름차순'),save('순서'),save('순서','result.csv')],['outputs/result.json','outputs/result.csv','outputs/customers.sqlite']);
add('2000행 SQLite 왕복과 가중 평균·최댓값','sqlite-persistence',[read('large','대량'),derive('대량','weighted',"'value' * 'weight'",'가중'),"'가중'을 'outputs/large.sqlite' SQLite의 'metrics' 테이블에 교체 저장해 'DB'로 만들고","'DB'의 'metrics' 테이블을 '조회'로 읽고",group('조회','group','weighted','average','평균','평균'),sort('평균','group','정렬','오름차순'),save('정렬'),group('조회','group','weighted','maximum','최대','최댓값'),save('최대','maximum.json'),count('조회',2000)],['outputs/result.json','outputs/maximum.json','outputs/large.sqlite']);

export const naturalMission50Cases=Object.freeze(cases.map(item=>Object.freeze({...item,clauses:Object.freeze(item.clauses),outputs:Object.freeze(item.outputs)})));
export const NATURAL_MISSION_50_CORPUS_SHA256=createHash('sha256').update(JSON.stringify({version:NATURAL_MISSION_50_CORPUS_VERSION,cases:naturalMission50Cases})).digest('hex');
export function materializeNaturalMission50Command(testCase){return testCase.command;}
