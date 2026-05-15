const XLSX = require('xlsx');
const path = require('path');

// 고정 선두 컬럼
const FIXED_COLS = [
  { key: 'dong',  header: '동' },
  { key: 'ho',    header: '호' },
  { key: 'phone', header: '휴대폰' },
];

function getYYYYMM() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function exportExcel(data, outputDir) {
  if (!data || !data.length) throw new Error('내보낼 데이터가 없습니다.');

  // 동적 컬럼: 고정 컬럼 이후 모든 키 수집 (첫 데이터 행 기준)
  const fixedKeys = new Set(FIXED_COLS.map(c => c.key));
  const dynamicKeys = [];
  const seen = new Set();
  for (const row of data) {
    for (const k of Object.keys(row)) {
      if (!fixedKeys.has(k) && !seen.has(k)) {
        dynamicKeys.push(k);
        seen.add(k);
      }
    }
  }

  const allHeaders = [
    ...FIXED_COLS.map(c => c.header),
    ...dynamicKeys,
  ];

  // 데이터 행 생성
  const sheetData = data.map(row => {
    const r = {};
    for (const col of FIXED_COLS) r[col.header] = row[col.key] || '';
    for (const key of dynamicKeys)  r[key]        = row[key]    || '';
    return r;
  });

  const ws = XLSX.utils.json_to_sheet(sheetData, { header: allHeaders });

  // 컬럼 너비
  ws['!cols'] = allHeaders.map(h => ({ wch: Math.max(h.length * 2, 10) }));

  // 헤더 행 스타일
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  for (let C = range.s.c; C <= range.e.c; C++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c: C })];
    if (cell) {
      cell.s = {
        font:      { bold: true, color: { rgb: 'FFFFFF' } },
        fill:      { fgColor: { rgb: '1565C0' } },
        alignment: { horizontal: 'center' },
      };
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '관리비');

  const filename = `관리비데이터_${getYYYYMM()}.xlsx`;
  const filePath = path.join(outputDir, filename);
  XLSX.writeFile(wb, filePath);
  return filePath;
}

module.exports = { exportExcel };
