const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseLocalDocument } = require('./documents.cjs');

const APP_NAME = 'chp';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const exeDir = path.dirname(process.execPath);
const portableRoot = app.isPackaged ? exeDir : path.resolve(__dirname, '..');
const dataRoot = path.join(portableRoot, 'data');
const userData = path.join(dataRoot, 'user-data');
const workspaceState = path.join(dataRoot, 'workspace.json');
const configPath = path.join(dataRoot, 'chp-local.json');
const chatPath = path.join(dataRoot, 'chats.json');
const tasksPath = path.join(dataRoot, 'tasks.json');

for (const p of [dataRoot, userData]) fs.mkdirSync(p, { recursive: true });
app.setName(APP_NAME);
app.setPath('userData', userData);
app.setPath('sessionData', path.join(dataRoot, 'session-data'));
app.setPath('logs', path.join(dataRoot, 'logs'));
app.setPath('crashDumps', path.join(dataRoot, 'crash-dumps'));

const defaults = {
  endpoint: 'http://127.0.0.1:11434/v1',
  model: '',
  provider: 'openai-compatible',
  temperature: 0.7,
  systemPrompt: 'You are chp, a fully local desktop AI assistant. Be useful, concise and careful with local files.',
};

const readJson = async (file, fallback) => {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
};
const writeJson = async (file, value) => {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
};
const ensureLoopbackUrl = (raw) => {
  const url = new URL(raw);
  if (!LOOPBACK.has(url.hostname)) throw new Error('chp only allows local model endpoints (localhost/127.0.0.1/::1).');
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported local endpoint protocol.');
  return url;
};
const within = (root, candidate) => {
  const r = path.resolve(root) + path.sep;
  const c = path.resolve(candidate);
  return c === path.resolve(root) || c.startsWith(r);
};
const safeJoin = (root, relative) => {
  const out = path.resolve(root, relative || '.');
  if (!within(root, out)) throw new Error('Path escapes workspace root.');
  return out;
};

let mainWindow;
let activeChatAbort = new Map();

function installNetworkGuard() {
  const filter = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] };
  session.defaultSession.webRequest.onBeforeRequest(filter, (details, cb) => {
    try {
      const u = new URL(details.url);
      if (LOOPBACK.has(u.hostname)) return cb({ cancel: false });
    } catch {}
    console.warn('[chp] blocked external network request:', details.url);
    cb({ cancel: true });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#0b0d10',
    title: 'chp',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0d10', symbolColor: '#e7e9ee', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (LOOPBACK.has(u.hostname)) shell.openExternal(url);
    } catch {}
    return { action: 'deny' };
  });
}

async function streamLocalChat(event, payload) {
  const cfg = { ...defaults, ...(await readJson(configPath, {})), ...(payload.config || {}) };
  const endpoint = ensureLoopbackUrl(cfg.endpoint);
  const requestId = payload.requestId || `${Date.now()}-${Math.random()}`;
  const controller = new AbortController();
  activeChatAbort.set(requestId, controller);
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const body = {
    model: cfg.model,
    messages: [{ role: 'system', content: cfg.systemPrompt }, ...messages],
    temperature: cfg.temperature,
    stream: true,
  };
  const url = new URL(endpoint.toString().replace(/\/$/, '') + '/chat/completions');
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`Local model HTTP ${resp.status}: ${await resp.text()}`);
    if (!resp.body) throw new Error('Local model returned no stream.');
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content ?? '';
          if (delta) event.sender.send('chat:delta', { requestId, delta });
        } catch {}
      }
    }
    event.sender.send('chat:done', { requestId });
  } catch (error) {
    event.sender.send('chat:error', { requestId, message: error?.message || String(error) });
  } finally {
    activeChatAbort.delete(requestId);
  }
}

ipcMain.handle('app:info', async () => ({
  appName: APP_NAME,
  portableRoot,
  dataRoot,
  version: app.getVersion(),
  offline: true,
}));
ipcMain.handle('config:get', async () => ({ ...defaults, ...(await readJson(configPath, {})) }));
ipcMain.handle('config:set', async (_e, cfg) => {
  if (cfg?.endpoint) ensureLoopbackUrl(cfg.endpoint);
  const next = { ...defaults, ...(await readJson(configPath, {})), ...cfg };
  await writeJson(configPath, next);
  return next;
});
ipcMain.handle('workspace:choose', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const root = result.filePaths[0];
  await writeJson(workspaceState, { root });
  return { root };
});
ipcMain.handle('workspace:get', async () => readJson(workspaceState, { root: '' }));
ipcMain.handle('files:list', async (_e, rel = '') => {
  const { root } = await readJson(workspaceState, { root: '' });
  if (!root) return [];
  const dir = safeJoin(root, rel);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries
    .filter((x) => !['.git', 'node_modules', '.next', 'dist', 'build'].includes(x.name))
    .map((x) => ({ name: x.name, path: path.relative(root, path.join(dir, x.name)), type: x.isDirectory() ? 'dir' : 'file' }))
    .sort((a,b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
});
ipcMain.handle('files:read', async (_e, rel) => {
  const { root } = await readJson(workspaceState, { root: '' });
  if (!root) throw new Error('No workspace selected.');
  const file = safeJoin(root, rel);
  const parsed = await parseLocalDocument(file);
  return { path: rel, kind: parsed.kind, content: parsed.content };
});
ipcMain.handle('files:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Documents', extensions: ['txt','md','pdf','docx','xlsx','xls','csv','tsv','pptx','json','js','ts','tsx','py','html','css','xml','yaml','yml'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled) return [];
  const documents = [];
  for (const file of result.filePaths.slice(0, 8)) {
    try {
      const parsed = await parseLocalDocument(file);
      documents.push({ name: path.basename(file), path: file, kind: parsed.kind, content: parsed.content.slice(0, 300000) });
    } catch (error) {
      documents.push({ name: path.basename(file), path: file, kind: 'error', content: error?.message || String(error) });
    }
  }
  return documents;
});
ipcMain.handle('files:write', async (_e, { rel, content }) => {
  const { root } = await readJson(workspaceState, { root: '' });
  if (!root) throw new Error('No workspace selected.');
  const file = safeJoin(root, rel);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, 'utf8');
  return true;
});
ipcMain.handle('files:search', async (_e, q) => {
  const { root } = await readJson(workspaceState, { root: '' });
  if (!root || !q?.trim()) return [];
  const needle = q.trim().toLowerCase();
  const out = [];
  const queue = [root];
  const ignored = new Set(['.git','node_modules','.next','dist','build','.cache']);
  while (queue.length && out.length < 250) {
    const dir = queue.shift();
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (ignored.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) queue.push(full);
      else {
        const rel = path.relative(root, full);
        if (rel.toLowerCase().includes(needle)) out.push({ path: rel, kind: 'name' });
        if (out.length >= 250) break;
        try {
          const stat = await fsp.stat(full);
          if (stat.size <= 512 * 1024) {
            const text = await fsp.readFile(full, 'utf8');
            const idx = text.toLowerCase().indexOf(needle);
            if (idx >= 0) out.push({ path: rel, kind: 'content', preview: text.slice(Math.max(0, idx - 80), idx + needle.length + 140).replace(/\s+/g, ' ') });
          }
        } catch {}
      }
    }
  }
  return out.slice(0, 250);
});
ipcMain.handle('terminal:run', async (_e, command) => {
  const { root } = await readJson(workspaceState, { root: '' });
  if (!root) throw new Error('No workspace selected.');
  return await new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', process.platform === 'win32' ? ['-NoProfile','-Command', command] : ['-lc', command], {
      cwd: root,
      env: { ...process.env },
      windowsHide: true,
    });
    let stdout = '', stderr = '';
    const cap = 2 * 1024 * 1024;
    child.stdout.on('data', (d) => { if (stdout.length < cap) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < cap) stderr += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
});
ipcMain.on('chat:start', (event, payload) => void streamLocalChat(event, payload));
ipcMain.handle('chat:cancel', async (_e, requestId) => { activeChatAbort.get(requestId)?.abort(); return true; });
ipcMain.handle('chats:get', async () => readJson(chatPath, []));
ipcMain.handle('chats:set', async (_e, chats) => { await writeJson(chatPath, chats); return true; });
ipcMain.handle('tasks:get', async () => readJson(tasksPath, []));
ipcMain.handle('tasks:set', async (_e, tasks) => { await writeJson(tasksPath, tasks); return true; });

app.whenReady().then(() => {
  installNetworkGuard();
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
