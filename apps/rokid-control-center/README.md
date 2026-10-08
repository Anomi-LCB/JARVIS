# Rokid Control Center

본인 소유의 Rokid Android 안경을 백업 우선 방식으로 관리하는 Windows용 로컬 제어센터입니다. 임의 셸 입력을 GUI에 노출하지 않고, 검증된 ADB 동작만 실행합니다.

## 현재 제공 범위

- 승인된 Rokid 장치 자동 탐지 및 Android/부트/보안/하드웨어 인벤토리
- 핵심 논리 백업과 접근 가능 전체 백업
- Rokid 핵심 APK, 전체 설정, 하드웨어 상태, 디버그 앱 데이터 보존
- SHA-256 파일 무결성 매니페스트와 불완전 항목 경고
- 물리 키, 밝기, 화면 꺼짐, 자동 회전, Wi-Fi, Bluetooth 제어
- 480×640 원본 프레임을 640×480 가로로 회전한 연속 화면 보기와 PC 마우스 탭·스와이프·길게 누르기
- 가로 회전 방향 전환과 480×640 세로 원본 보기
- 화면이 있는 앱 자동 구분, PC 화면에서 실행·조작, 백그라운드 서비스 관리
- System/Secure/Global 설정 194개 시각 탐색, 추천 세부 조정, 변경 전 자동 저장과 되돌리기
- 원시 설정 읽기, 화면 캡처, logcat, 감사 로그
- 부팅 슬롯·Verified Boot·VBMeta·암호화·SELinux 상태 표시

## 개발 실행

```powershell
pnpm --dir apps/rokid-control-center dev
```

브라우저에서 `http://127.0.0.1:4785`를 엽니다.

## Windows 실행 파일

```powershell
pnpm --dir apps/rokid-control-center build:windows
```

주 배포 파일은 `dist/RokidControlCenter.exe`입니다. Node 런타임, 로컬 제어 서버, ADB가 EXE 안에 포함되므로 이 파일 하나만 이동해 실행할 수 있습니다. 첫 실행 때 해시로 구분된 런타임이 `%LOCALAPPDATA%\RokidControlCenter\runtime`에 준비되며, 백업·업데이트 보관함·감사 로그는 `%LOCALAPPDATA%\RokidControlCenter\data`에 별도로 유지됩니다.

`dist/rokid-control-center/RokidControlCenter.exe`와 인접 폴더들은 압축을 풀지 않고 개발·진단할 수 있는 폴더형 휴대용 버전입니다.

## 안전 경계

- 서버는 `127.0.0.1`에서만 실행되며 변경 API는 세션 토큰과 동일 출처 검사를 요구합니다.
- 단일 EXE의 내장 payload는 SHA-256으로 버전을 식별하며, 경로 이탈을 차단하는 임시 폴더에 먼저 푼 뒤 필수 파일을 검증합니다.
- 모든 변경은 정의된 인자 배열로 `adb.exe`를 직접 실행하며 셸 문자열 결합을 사용하지 않습니다.
- 세부 설정 편집은 현재 존재하는 키와 안전 문자만 허용하며, 식별·연결·복구 관련 키는 읽기 전용입니다.
- 재시작·부트로더 진입·앱 중지·앱 비활성화는 확인 절차가 필요합니다.
- 화면 미러링은 장치 기본 캡처를 사용하므로 DRM/보안 화면은 검게 보일 수 있고 오디오는 전달하지 않습니다.
- 화면 프레임은 짧은 요청으로 자동 재연결하며, GUI가 열린 동안 로컬 서버 상태를 감시하고 필요 시 다시 시작합니다.
- 현재 장치 세션에는 루트 권한이 없으므로 원시 boot/vendor/system 파티션과 비디버그 앱의 개인 데이터는 백업되지 않습니다.
- 원본 OTA APK와 복구 이미지를 확보하기 전에는 제조사 업데이트 경로를 차단하거나 시스템 파티션을 쓰지 않습니다.

## 다음 단계

1. 장치별 원본 boot/init_boot/vendor_boot/vbmeta 이미지 확보와 실제 복구 훈련
2. 로컬 HTTPS 업데이트 매니페스트·패키지 저장소·A/B 롤백 서비스
3. 장치용 관리 에이전트와 상호 인증, 정책 기반 원격 관리
4. 펌웨어 빌드·서명·단계적 배포와 자동 건강검사
