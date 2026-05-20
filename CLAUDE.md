# AIHelperCollector — Claude Code 프로젝트 컨텍스트

## 프로젝트 개요
XpERP(이지스) ERP 시스템에서 아파트 관리비 부과 데이터를 자동 수집해 엑셀로 출력하는 Electron 앱.
- **대상 단지**: 세종푸르지오시티 2차 (846세대)
- **ERP URL**: https://ags4.xperp.co.kr/main.do
- **포털**: https://acchelper.kr (배포 다운로드 페이지)

## 기술 스택
- Electron 32 + Playwright (CDP 연결, Edge/Chrome remote debugging)
- IBSheet 그리드 컴포넌트 (한국 ERP 표준 그리드)
- GitHub: https://github.com/KimDongUg/AIHelperCollector
- 포털 프론트: https://github.com/KimDongUg/AccHelper

## 현재 버전: v5.10.1

## IBSheet 핵심 지식

### 가상 스크롤 우회
IBSheet는 DOM에 ~28행만 렌더링함 (scrollHeight ≈ clientHeight).
**해결**: `IBSheet[n].Rows["AR1"]~["AR847"]` 내부 객체 직접 접근.
```javascript
const sheet = window.IBSheet[0]; // 관리비조회 동호내역
const arKeys = Object.keys(sheet.Rows).filter(k => /^AR\d+$/.test(k));
// 각 키의 Rows["ARn"]["APT_NO_ROOM"] = "1 - 101" (동호 복합값)
```

### 동호내역 셀렉터
```
div#sheetDivA → table.IBMainTable → ... → table.IBSection → tr.IBDataRow
  td[class*="APT_NO_ROOM"]  →  innerText = "1 - 101"
```

### IBSheet 클릭 (중요!)
`element.click()` (isTrusted=false) → IBSheet SheetClick 무시됨.
**반드시** Playwright `locator.click()` 사용 (CDP 실제 이벤트, isTrusted=true).

### 30초 타임아웃 버그 (절대 하지 말 것)
```javascript
// ❌ 이렇게 하면 프레임 미매칭 시 30초 타임아웃 발생 → 2시간 수집
page.frameLocator(`iframe[src="${f.url()}"]`)

// ✅ 항상 SEL_FEE 상수 사용
page.frameLocator(SEL_FEE)  // 'iframe[src*="703m01"], ...'
```

## 수집 흐름
1. `readResidentData()` — 입주자현황 iframe (SEL_RESIDENT) → {name, phone} 맵
2. `readFeeUnitList()` — 관리비조회 #sheetDivA Rows → 846 동호 목록
3. 각 동호: `clickFeeUnit()` → Playwright click → `waitForAmt()` (변경 감지) → `collectFeeData()`

## 속도 최적화 (v5.10.0+)
- 고정 600ms 대기 제거 → `waitForAmt()`: #lbl_item_amt 값 변경 50ms 폴링
- 스크롤 대기 150ms → 60ms
- 세대당 ~370ms (이전 ~1050ms), 846세대 ~5분 (이전 ~15분)

## 현재 미해결 문제 (v5.10.1 기준)
**입주자 이름/휴대폰이 빈값**:
- `readResidentData()` IBSheet.Rows 컬럼 ID 통계 탐색 실패
- 원인: 입주자현황 IBSheet의 동/호/이름/전화 컬럼 ID를 모름
- **필요한 작업**: 사용자가 F12 콘솔에서 컬럼 ID 확인 후 제공
  ```javascript
  // 입주자현황 iframe 컨텍스트에서 실행
  const s = IBSheet[0];
  const k = Object.keys(s.Rows).filter(k => /^AR\d+$/.test(k))[0];
  console.log(JSON.stringify(s.Rows[k]));
  ```
  결과 JSON의 컬럼명을 확인해 `readResidentData()` 코드에 하드코딩 필요.

## 배포 프로세스 (매번 동일)
```bash
# 1. 소스 수정 + package.json 버전 업 + index.html 버전 텍스트 수정
# 2. git add / commit / push → main

# 3. 빌드
npm run build
# → dist/AI Helper 수집기-X.Y.Z-win.zip 생성

# 4. ZIP 이름 변환
cp "dist/AI Helper 수집기-X.Y.Z-win.zip" "dist/AIHelperCollector-vX.Y.Z-win.zip"

# 5. GitHub Release
gh release create vX.Y.Z "dist/AIHelperCollector-vX.Y.Z-win.zip" --title "vX.Y.Z - 설명"

# 6. AccHelper 포털 admin.html 업데이트 (KimDongUg/AccHelper 저장소 131~133줄)
# 이전 버전 URL/텍스트 → 새 버전으로 sed 치환 후 GitHub API PUT
```

## 버전 규칙
- patch (x.y.Z): 버그 수정, 텍스트 변경
- minor (x.Y.0): 기능 개선, 셀렉터 추가
- major (X.0.0): 아키텍처 전면 변경

## acchelper.kr 관리자 접속
- 이메일: you721224@naver.com
- 비밀번호: admin1234
- company_id: 1
- API: POST https://acchelper.kr/api/auth/login

## 주요 파일
- `playwright/collector.js` — 핵심 수집 로직 (IBSheet 접근, 클릭, 데이터 추출)
- `electron/main.js` — Electron IPC 핸들러
- `electron/renderer/` — UI (index.html, renderer.js)
- `playwright/exportExcel.js` — 엑셀 출력
