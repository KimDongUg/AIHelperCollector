# AI Helper 수집기 — Claude 인수인계 메모

> 새 Claude Code 세션 시작 시 이 내용을 복사해서 붙여넣으세요.

---

## 현재 상태 (v5.10.1, 2026-05-21)

나는 세종푸르지오시티 2차 아파트 관리사무소 경리입니다.
D:\MyProject\AIHelperCollector 프로젝트는 XpERP ERP에서 관리비 부과 데이터를 자동 수집하는 Electron 앱입니다.

### 잘 되는 것 ✅
- 846세대 동호 목록 수집
- 관리비 데이터 세대별 수집 (부과항목계, 당월부과액 등)
- 수집 시간: 846세대 약 5~8분

### 아직 안 되는 것 ❌
- **입주자 이름 (name 컬럼)** — 엑셀에 빈값
- **휴대폰 번호 (phone 컬럼)** — 엑셀에 빈값
- 원인: 입주자현황 IBSheet의 컬럼 ID를 코드가 찾지 못함

### 다음 할 일
입주자현황 페이지에서 F12 콘솔로 IBSheet 컬럼 ID 확인 후 코드 수정 필요.

**콘솔에서 실행할 코드** (입주자현황 iframe 컨텍스트에서):
```javascript
const s=IBSheet[0];
const k=Object.keys(s.Rows).filter(k=>/^AR\d+$/.test(k))[0];
console.log(JSON.stringify(s.Rows[k]));
```

---

## 배포 방법
소스 수정 → `npm run build` → ZIP 복사+이름변경 → `gh release create` → AccHelper admin.html 업데이트

자세한 내용은 `CLAUDE.md` 파일 참조 (Claude Code가 자동으로 읽습니다).

---

## GitHub
- 앱 소스: https://github.com/KimDongUg/AIHelperCollector
- 포털 프론트: https://github.com/KimDongUg/AccHelper
