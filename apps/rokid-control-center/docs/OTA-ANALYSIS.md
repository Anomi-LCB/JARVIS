# Rokid RG-glasses OTA 분석 기록

분석 대상은 연결된 사용자 소유 기기에서 백업한 `com.rokid.glass.ota` APK 2.9.2(버전 코드 2920)입니다. 분석 과정에서는 제조사 서버에 요청하거나 기기 설정을 변경하지 않았습니다.

## 확인된 구조

- 앱은 `android.uid.system` 공유 UID를 사용하는 persistent 시스템 앱입니다.
- 실제 기기의 확인 주소는 `https://ota.rokid.com/v1/extended/ota/check`입니다.
- 확인 요청은 JSON `POST`이며 현재 시스템 버전을 전송합니다.
- Authorization은 기기 속성의 key/device type/device id/service/version/time과 secret을 조합한 MD5 서명 형식입니다. 제어센터는 secret을 읽거나 저장하지 않습니다.
- 성공 응답은 `code`, `imageUrl`, `version`, `checksum`, `changelog`, `isForceUpdate`를 사용합니다.
- 패키지는 Range GET으로 `/sdcard/update.zip`에 다운로드되고 응답 checksum과 파일 MD5를 비교합니다.
- ZIP의 `payload.bin`과 `payload_properties.txt`를 찾아 Android A/B UpdateEngine의 `applyPayload()`에 전달합니다.
- 업데이트 완료 후 재부팅이 필요하며 성공 시 `update.zip`을 삭제합니다.

## 관찰된 제어 표면

- 확인: `android.intent.customize.action.JUDGE_BEFORE_CHECK`
- 로컬 ZIP 적용 진입: `android.intent.customize.action.JUDGE_BEFORE_UPDATE`
- 일반 명령: `com.rokid.glass.ota.NORMAL_CMD_ACTION`
- 상태 데이터: `com.rokid.glass.ota.DATA_CMD_ACTION`
- 로컬/외부 제어용 명령에는 시작·중지·상태 확인·무시·재부팅이 포함됩니다.

동적 브로드캐스트 수신기는 기기 OS 버전에서 별도 권한 보호가 확인되지 않았습니다. 제어센터에서는 이를 임의 명령 통로로 공개하지 않고, 백업·패키지 검증·복구 게이트가 있는 고정 동작으로만 사용할 예정입니다.

## 자체 서버 전환 전략

단기적으로는 기존 시스템 OTA 앱을 패치하지 않고, 검증된 로컬 A/B 업데이트 ZIP을 제어센터가 제공하고 기존 OTA 명령 표면을 통해 적용하는 방식이 가장 복구 가능성이 높습니다. OTA APK 자체를 수정하면 플랫폼 서명과 system UID가 깨질 수 있으므로 원본 플랫폼 키 또는 커스텀 시스템 이미지가 준비되기 전에는 교체하지 않습니다.

적용 단계는 다음 게이트를 모두 통과해야 합니다.

1. 핵심 논리 백업과 전체 APK 백업
2. 원본 boot/init_boot/vendor_boot/vbmeta 이미지 확보
3. fastboot 또는 복구 이미지로 실제 복원 훈련
4. 업데이트 ZIP의 payload 구조·해시·서명 호환성 확인
5. A/B 비활성 슬롯 적용과 부팅 건강검사
6. 실패 시 슬롯 롤백 및 로컬 서버 배포 중단

현재 GUI는 1단계를 수행하고 업데이트 패키지 금고에서 4단계의 구조·해시 매니페스트를 준비합니다. 실제 배포와 적용은 2·3단계 완료 전까지 잠겨 있습니다.
