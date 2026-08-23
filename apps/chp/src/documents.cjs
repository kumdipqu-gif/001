const fs = require('node:fs/promises');
const path = require('node:path');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');
const AdmZip = require('adm-zip');

const TEXT_EXTENSIONS = new Set([
  '.txt','.md','.markdown','.json','.jsonl','.js','.jsx','.ts','.tsx','.mjs','.cjs','.css','.scss','.html','.htm','.xml','.yaml','.yml','.toml','.ini','.py','.java','.kt','.go','.rs','.c','.h','.cpp','.hpp','.cs','.php','.rb','.sh','.ps1','.sql','.log','.csv','.tsv',
]);

const xmlText = (xml) => xml
  .replace(/<a:br\s*\/>/g, '\n')
  .replace(/<\/a:p>/g, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/[ \t]+/g, ' ')
  .replace(/\n\s+/g, '\n')
  .trim();

async function parsePptx(file) {
  const zip = new AdmZip(file);
  const entries = zip.getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
    .sort((a,b) => Number(a.entryName.match(/slide(\d+)/i)?.[1] || 0) - Number(b.entryName.match(/slide(\d+)/i)?.[1] || 0));
  const parts = [];
  for (const [i, entry] of entries.entries()) {
    parts.push(`# Slide ${i + 1}\n${xmlText(entry.getData().toString('utf8'))}`);
  }
  return parts.join('\n\n');
}

async function parseSpreadsheet(file) {
  const workbook = XLSX.readFile(file, { cellDates: true, dense: false });
  const parts = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    parts.push(`# Sheet: ${sheetName}\n${XLSX.utils.sheet_to_csv(sheet, { blankrows: false })}`);
  }
  return parts.join('\n\n');
}

async function parseLocalDocument(file) {
  const ext = path.extname(file).toLowerCase();
  const stat = await fs.stat(file);
  if (stat.size > 25 * 1024 * 1024) throw new Error('文件超过 25MB，本地解析已拒绝。');

  if (TEXT_EXTENSIONS.has(ext) || ext === '') {
    return { kind: 'text', content: await fs.readFile(file, 'utf8') };
  }
  if (ext === '.pdf') {
    const result = await pdfParse(await fs.readFile(file));
    return { kind: 'pdf', content: result.text || '' };
  }
  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: file });
    return { kind: 'docx', content: result.value || '' };
  }
  if (['.xlsx','.xls','.xlsm','.xltx','.csv','.tsv'].includes(ext)) {
    return { kind: 'spreadsheet', content: await parseSpreadsheet(file) };
  }
  if (ext === '.pptx') {
    return { kind: 'pptx', content: await parsePptx(file) };
  }
  throw new Error(`暂不支持本地解析 ${ext || '该'} 文件。`);
}

module.exports = { parseLocalDocument };
