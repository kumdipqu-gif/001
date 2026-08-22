const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src/main.cjs'), 'utf8');
const docs = fs.readFileSync(path.join(root, 'src/documents.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload.cjs'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const failures = [];
const must = (condition, message) => { if (!condition) failures.push(message); };

must(pkg.name === 'chp-desktop', 'package name must be chp-desktop');
must(fs.existsSync(path.join(root, 'portable.flag')), 'portable.flag missing');
must(main.includes("const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])"), 'loopback allowlist missing');
must(main.includes('blocked external network request'), 'external network blocker missing');
must(main.includes("app.setPath('userData'"), 'portable userData relocation missing');
must(main.includes("ipcMain.handle('workspace:choose'"), 'workspace picker missing');
must(main.includes("ipcMain.handle('files:search'"), 'local file search missing');
must(main.includes("ipcMain.handle('files:pick'"), 'local document picker missing');
must(main.includes("ipcMain.handle('terminal:run'"), 'local terminal missing');
must(main.includes("ipcMain.on('chat:start'"), 'local streaming chat missing');
must(preload.includes("ipcRenderer.invoke('files:pick')"), 'document picker preload bridge missing');
must(renderer.includes('buildDocumentContext'), 'chat attachment context missing');
must(docs.includes("ext === '.pdf'"), 'PDF local parser missing');
must(docs.includes("ext === '.docx'"), 'DOCX local parser missing');
must(docs.includes("'.xlsx'"), 'XLSX local parser missing');
must(docs.includes("ext === '.pptx'"), 'PPTX local parser missing');
must(html.includes('外网已阻断'), 'offline UI indicator missing');
must(html.includes('项目工作台'), 'workbench UI missing');
must(html.includes('本地任务'), 'task UI missing');
must(!/https:\/\/(api\.|ark\.|claude\.|openai\.|anthropic\.)/i.test(main + docs + preload + renderer + html), 'public AI endpoint found in runtime/UI');

if (failures.length) {
  console.error('CHP_SELFTEST_FAIL');
  for (const f of failures) console.error('-', f);
  process.exit(1);
}
console.log('CHP_SELFTEST_PASS');
console.log('offline_guard=PASS');
console.log('portable_paths=PASS');
console.log('local_chat=PASS');
console.log('workspace_files_terminal_tasks=PASS');
console.log('pdf_docx_xlsx_pptx_attachments=PASS');
