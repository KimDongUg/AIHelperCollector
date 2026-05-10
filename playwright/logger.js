const fs = require('fs');
const path = require('path');

function saveErrorLog(logsDir, unitLabel, errorMsg) {
  const date = new Date();
  const dateStr = `${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}`;
  const timeStr = date.toTimeString().split(' ')[0];
  const logFile = path.join(logsDir, `error_${dateStr}.log`);
  const line = `[${timeStr}] ${unitLabel} — ${errorMsg}\n`;
  fs.appendFileSync(logFile, line, 'utf8');
}

module.exports = { saveErrorLog };
