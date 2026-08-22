const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { parseLocalDocument } = require('./documents.cjs');
const { DEFAULTS, normalizeConfig, modelTurn, testConnection } = require('./model-gateway.cjs');

const APP_NAME = 'chp';
const exeDir = path.dirname(process.execPath);
const portableRoot = app.isPackaged ? exeDir : path.resolve(__dirname, '..');
const dataRoot = path.join(portableRoot, 'data');
const userData = path.join(dataRoot, 'user-data');
const configPath = path.join(dataRoot, 'chp-api.json');
const bundledConfigPath = path.join(portableRoot, 'chp-api.json');
const workspaceState = path.join(dataRoot, 'workspace.json');
const chatPath = path.join(dataRoot, 'chats.json');
const tasksPath = path.join(dataRoot, 'tasks.json');
const artifactsRoot = path.join(dataRoot, 'artifacts');
const runtimeRoot = path.join(dataRoot, 'runtime');

for (const p of [dataRoot, userData, artifactsRoot, runtimeRoot, path.join(dataRoot, 'session-data'), path.join(dataRoot, 'logs'), path.join(dataRoot, 'crash-dumps')]) fs.mkdirSync(p, { recursive: true });
app.setName(APP_NAME);
app.setPath('userData', userData);
app.setPath('sessionData', path.join(dataRoot, 'session-data'));
app.setPath('logs', path.join(dataRoot, 'logs'));
app.setPath('crashDumps', path.join(dataRoot, 'crash-dumps'));

const readJson = async (file, fallback) => {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
};
const writeJson = async (file, value) => {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, file);
};
const loadConfig = async () => {
  const fromData = await readJson(configPath, null);
  if (fromData) return normalizeConfig(fromData);
  const fromRoot = await readJson(bundledConfigPath, null);
  if (fromRoot) {
    const normalized = normalizeConfig(fromRoot);
    await writeJson(configPath, normalized);
    return normalized;
  }
  return normalizeConfig(DEFAULTS);
};
const saveConfig = async (cfg) => {
  const normalized = normalizeConfig(cfg);
  await writeJson(configPath, normalized);
  return normalized;
};
const within = (root, candidate) => {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(`${base}${path.sep}`);
};
const safeJoin = (root, relative = '.') => {
  const out = path.resolve(root, relative);
  if (!within(root, out)) throw new Error('路径超出了当前项目目录。');
  return out;
};
const workspaceRoot = async () => {
  const { root } = await readJson(workspaceState, { root: '' });
  if (!root) throw new Error('请先选择项目文件夹。');
  return root;
};
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.cache', '.turbo', '.idea', '.vscode']);
const TEXT_EXTENSIONS = new Set(['.txt','.md','.markdown','.json','.jsonl','.js','.jsx','.ts','.tsx','.mjs','.cjs','.css','.scss','.html','.htm','.xml','.yaml','.yml','.toml','.ini','.py','.java','.kt','.go','.rs','.c','.h','.cpp','.hpp','.cs','.php','.rb','.sh','.ps1','.sql','.log','.csv','.tsv']);

async function listWorkspace(rel = '') {
  const root = await workspaceRoot();
  const dir = safeJoin(root, rel);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries
    .filter((x) => !IGNORED_DIRS.has(x.name))
    .map((x) => ({
      name: x.name,
      path: path.relative(root, path.join(dir, x.name)),
      type: x.isDirectory() ? 'dir' : 'file',
    }))
    .sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
}

async function readWorkspaceFile(rel) {
  const root = await workspaceRoot();
  const file = safeJoin(root, rel);
  const stat = await fsp.stat(file);
  if (!stat.isFile()) throw new Error('目标不是文件。');
  const parsed = await parseLocalDocument(file);
  return { path: rel, kind: parsed.kind, content: parsed.content };
}

async function writeWorkspaceFile(rel, content) {
  const root = await workspaceRoot();
  const file = safeJoin(root, rel);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, String(content ?? ''), 'utf8');
  return { path: rel, bytes: Buffer.byteLength(String(content ?? '')) };
}

async function searchWorkspace(query, limit = 200) {
  const root = await workspaceRoot();
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [];
  const results = [];
  const queue = [root];
  while (queue.length && results.length < limit) {
    const dir = queue.shift();
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      const rel = path.relative(root, full);
      if (rel.toLowerCase().includes(needle)) results.push({ path: rel, kind: 'name' });
      if (results.length >= limit) break;
      try {
        const stat = await fsp.stat(full);
        const ext = path.extname(full).toLowerCase();
        if (stat.size <= 1024 * 1024 && (TEXT_EXTENSIONS.has(ext) || ext === '')) {
          const text = await fsp.readFile(full, 'utf8');
          const idx = text.toLowerCase().indexOf(needle);
          if (idx >= 0) {
            results.push({
              path: rel,
              kind: 'content',
              preview: text.slice(Math.max(0, idx - 120), idx + needle.length + 220).replace(/\s+/g, ' '),
            });
          }
        }
      } catch {}
      if (results.length >= limit) break;
    }
  }
  return results.slice(0, limit);
}

async function runCommand(command, timeoutMs = 120000) {
  const root = await workspaceRoot();
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = spawn(isWin ? 'powershell.exe' : '/bin/sh', isWin ? ['-NoLogo','-NoProfile','-NonInteractive','-Command', String(command)] : ['-lc', String(command)], {
      cwd: root,
      env: { ...process.env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const cap = 4 * 1024 * 1024;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
    }, Math.max(1000, Math.min(timeoutMs, 10 * 60 * 1000)));
    child.stdout.on('data', (d) => { if (stdout.length < cap) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < cap) stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}`, timedOut });
    });
  });
}

async function createArtifact({ name, content, extension = 'md' }) {
  const safeName = String(name || 'artifact').replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').trim() || 'artifact';
  const ext = String(extension || 'md').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'md';
  const fileName = `${Date.now()}-${safeName}.${ext}`;
  const file = path.join(artifactsRoot, fileName);
  await fsp.writeFile(file, String(content ?? ''), 'utf8');
  return { name: fileName, path: file, size: Buffer.byteLength(String(content ?? '')) };
}

async function listArtifacts() {
  const entries = await fsp.readdir(artifactsRoot, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(artifactsRoot, entry.name);
    const stat = await fsp.stat(file);
    out.push({ name: entry.name, path: file, size: stat.size, updatedAt: stat.mtimeMs });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

const TOOL_DEFS = [
  { name: 'list_files', description: 'List files and folders in the selected local workspace.', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Relative directory path, blank for project root.' } } } },
  { name: 'search_files', description: 'Search local workspace file names and text content.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'read_file', description: 'Read a local workspace document or source file.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Create or overwrite a text file inside the selected workspace.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path','content'] } },
  { name: 'run_command', description: 'Run a command inside the selected workspace and return stdout/stderr.', input_schema: { type: 'object', properties: { command: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['command'] } },
  { name: 'create_artifact', description: 'Save a work result into chp portable data/artifacts.', input_schema: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' }, extension: { type: 'string' } }, required: ['name','content'] } },
];

async function executeTool(call) {
  const input = call.input || {};
  if (call.name === 'list_files') return listWorkspace(input.path || '');
  if (call.name === 'search_files') return searchWorkspace(input.query || '');
  if (call.name === 'read_file') return readWorkspaceFile(input.path || '');
  if (call.name === 'write_file') return writeWorkspaceFile(input.path || '', input.content || '');
  if (call.name === 'run_command') return runCommand(input.command || '', input.timeout_ms || 120000);
  if (call.name === 'create_artifact') return createArtifact(input);
  throw new Error(`未知工具：${call.name}`);
}

let mainWindow;
const activeRuns = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1060,
    minHeight: 700,
    backgroundColor: '#0b0d10',
    title: APP_NAME,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0d10', symbolColor: '#e7e9ee', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
}

async function startConversation(event, payload) {
  const requestId = payload.requestId || crypto.randomUUID();
  const mode = payload.mode === 'work' ? 'work' : 'chat';
  const controller = new AbortController();
  activeRuns.set(requestId, controller);
  try {
    const config = await loadConfig();
    const messages = Array.isArray(payload.messages) ? [...payload.messages] : [];
    if (mode === 'work') {
      const { root } = await readJson(workspaceState, { root: '' });
      if (!root) throw new Error('工作模式需要先选择一个本地项目文件夹。');
      messages.unshift({ role: 'user', content: `当前本地工作区：${root}\n你可以调用工具读取、搜索、写入文件并运行命令。禁止访问工作区之外的路径。` });
    }
    const tools = mode === 'work' ? TOOL_DEFS : [];
    let finalText = '';
    let usage = null;
    let toolRounds = 0;
    while (toolRounds < 12) {
      const turn = await modelTurn({
        config,
        messages,
        tools,
        signal: controller.signal,
        onDelta: (delta) => {
          finalText += delta;
          if (!event.sender.isDestroyed()) event.sender.send('chat:delta', { requestId, delta });
        },
        onUsage: (value) => {
          usage = value;
          if (!event.sender.isDestroyed()) event.sender.send('chat:usage', { requestId, usage: value });
        },
      });
      if (!turn.toolCalls?.length) break;
      toolRounds += 1;
      messages.push({ role: 'assistant', content: turn.text || '', toolCalls: turn.toolCalls });
      for (const call of turn.toolCalls) {
        if (!event.sender.isDestroyed()) event.sender.send('chat:tool', { requestId, phase: 'start', tool: { id: call.id, name: call.name, input: call.input } });
        try {
          const result = await executeTool(call);
          const content = JSON.stringify(result, null, 2).slice(0, 120000);
          messages.push({ role: 'tool', toolCallId: call.id, content });
          if (!event.sender.isDestroyed()) event.sender.send('chat:tool', { requestId, phase: 'done', tool: { id: call.id, name: call.name }, result });
        } catch (error) {
          const message = error?.message || String(error);
          messages.push({ role: 'tool', toolCallId: call.id, content: message, isError: true });
          if (!event.sender.isDestroyed()) event.sender.send('chat:tool', { requestId, phase: 'error', tool: { id: call.id, name: call.name }, error: message });
        }
      }
    }
    if (toolRounds >= 12) throw new Error('工作 Agent 已达到单次任务最大工具轮次 12，请把任务拆小后继续。');
    if (!event.sender.isDestroyed()) event.sender.send('chat:done', { requestId, usage, text: finalText });
  } catch (error) {
    const cancelled = error?.name === 'AbortError';
    if (!event.sender.isDestroyed()) event.sender.send(cancelled ? 'chat:done' : 'chat:error', { requestId, cancelled, message: error?.message || String(error) });
  } finally {
    activeRuns.delete(requestId);
  }
}

ipcMain.handle('app:info', async () => ({
  appName: APP_NAME,
  portable: true,
  portableRoot,
  dataRoot,
  version: app.getVersion(),
  cloudAccountRequired: false,
  modelNetworking: true,
}));
ipcMain.handle('config:get', async () => loadConfig());
ipcMain.handle('config:set', async (_e, cfg) => saveConfig(cfg));
ipcMain.handle('config:test', async (_e, cfg) => testConnection(cfg || await loadConfig()));
ipcMain.handle('config:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'chp API 配置', extensions: ['json'] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  const raw = JSON.parse(await fsp.readFile(result.filePaths[0], 'utf8'));
  return saveConfig(raw);
});
ipcMain.handle('workspace:choose', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const root = result.filePaths[0];
  await writeJson(workspaceState, { root });
  return { root };
});
ipcMain.handle('workspace:get', async () => readJson(workspaceState, { root: '' }));
ipcMain.handle('files:list', async (_e, rel = '') => listWorkspace(rel));
ipcMain.handle('files:read', async (_e, rel) => readWorkspaceFile(rel));
ipcMain.handle('files:write', async (_e, payload) => writeWorkspaceFile(payload.rel, payload.content));
ipcMain.handle('files:search', async (_e, q) => searchWorkspace(q));
ipcMain.handle('files:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '文档与代码', extensions: ['txt','md','pdf','docx','xlsx','xls','xlsm','csv','tsv','pptx','json','js','jsx','ts','tsx','py','html','css','xml','yaml','yml','toml','ini','log'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (result.canceled) return [];
  const documents = [];
  for (const file of result.filePaths.slice(0, 12)) {
    try {
      const parsed = await parseLocalDocument(file);
      documents.push({ name: path.basename(file), path: file, kind: parsed.kind, content: parsed.content.slice(0, 350000) });
    } catch (error) {
      documents.push({ name: path.basename(file), path: file, kind: 'error', content: error?.message || String(error) });
    }
  }
  return documents;
});
ipcMain.handle('terminal:run', async (_e, command) => runCommand(command));
ipcMain.handle('artifacts:list', async () => listArtifacts());
ipcMain.handle('artifacts:read', async (_e, fileName) => {
  const file = safeJoin(artifactsRoot, fileName);
  return { name: fileName, content: await fsp.readFile(file, 'utf8') };
});
ipcMain.handle('artifacts:create', async (_e, payload) => createArtifact(payload));
ipcMain.on('chat:start', (event, payload) => void startConversation(event, payload));
ipcMain.handle('chat:cancel', async (_e, requestId) => { activeRuns.get(requestId)?.abort(); return true; });
ipcMain.handle('chats:get', async () => readJson(chatPath, []));
ipcMain.handle('chats:set', async (_e, chats) => { await writeJson(chatPath, Array.isArray(chats) ? chats : []); return true; });
ipcMain.handle('tasks:get', async () => readJson(tasksPath, []));
ipcMain.handle('tasks:set', async (_e, tasks) => { await writeJson(tasksPath, Array.isArray(tasks) ? tasks : []); return true; });

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
