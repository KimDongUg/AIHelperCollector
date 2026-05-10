const XLSX = require('xlsx');
const path = require('path');

const COLUMNS = [
  { key: 'dong',              header: '동' },
  { key: 'ho',               header: '호' },
  { key: 'ownerName',        header: '소유주명' },
  { key: 'ownerPhone',       header: '소유주 연락처' },
  { key: 'residentName',     header: '입주자명' },
  { key: 'residentPhone',    header: '입주자 연락처' },
  { key: 'moveInDate',       header: '입주일' },
  { key: 'totalCharge',      header: '당월부과합계' },
  { key: 'prevUnpaid',       header: '전월미납금' },
  { key: 'electric',         header: '전기료' },
  { key: 'water',            header: '수도료' },
  { key: 'heat',             header: '난방비' },
  { key: 'generalMgmt',      header: '일반관리비' },
  { key: 'clean',            header: '청소비' },
  { key: 'repair',           header: '수선유지비' },
  { key: 'discount',         header: '할인금액' },
  { key: 'finalPay',         header: '최종납부금액' },
  { key: 'unpaid',           header: '미납여부' },
  { key: 'memo',             header: '메모' },
];

function getYYYYMM() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function exportExcel(data, outputDir) {
  const rows = data.map((item) => {
    const row = {};
    for (const col of COLUMNS) {
      row[col.header] = item[col.key] || '';
    }
    return row;
  });

  const ws = XLSX.utils.json_to_sheet(rows, {
    header: COLUMNS.map((c) => c.header),
  });

  // 컬럼 너비 설정
  ws['!cols'] = COLUMNS.map((c) => ({ wch: Math.max(c.header.length * 2, 12) }));

  // 헤더 스타일 (배경색)
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let C = range.s.c; C <= range.e.c; C++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c: C })];
    if (cell) {
      cell.s = {
        font: { bold: true, color: { rgb: 'FFFFFF' } },
        fill: { fgColor: { rgb: '1565C0' } },
        alignment: { horizontal: 'center' },
      };
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '관리비');

  const filename = `관리비데이터_${getYYYYMM()}.xlsx`;
  const filePath = require('path').join(outputDir, filename);
  XLSX.writeFile(wb, filePath);
  return filePath;
}

module.exports = { exportExcel };
