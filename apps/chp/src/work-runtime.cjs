const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');

const safeName = (value, fallback = 'item') => String(value || fallback).replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').trim() || fallback;
const within = (root, target) => {
  const base = path.resolve(root);
  const candidate = path.resolve(target);
  return candidate === base || candidate.startsWith(`${base}${path.sep}`);
};
const safeJoin = (root, relative = '.') => {
  const out = path.resolve(root, relative);
  if (!within(root, out)) throw new Error('路径超出了当前项目目录。');
  return out;
};
const readJson = async (file, fallback) => {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
};
const writeJson = async (file, value) => {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, file);
};

class ProjectIndexer {
  constructor(dataRoot) {
    this.indexRoot = path.join(dataRoot, 'indexes');
    fs.mkdirSync(this.indexRoot, { recursive: true });
  }
  key(root) { return crypto.createHash('sha1').update(path.resolve(root)).digest('hex'); }
  async build(root) {
    const abs = path.resolve(root);
    const { rgPath } = require('@vscode/ripgrep');
    const args = ['--files', '--hidden', '--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!dist/**', '--glob', '!build/**', '--glob', '!.next/**'];
    const result = await this.#collect(rgPath, args, abs, 8 * 1024 * 1024);
    const files = result.stdout.split(/\r?\n/).filter(Boolean).slice(0, 100000);
    const extensions = {};
    let bytes = 0;
    const entries = [];
    for (const rel of files) {
      const file = safeJoin(abs, rel);
      try {
        const stat = await fsp.stat(file);
        if (!stat.isFile()) continue;
        const ext = path.extname(rel).toLowerCase() || '(none)';
        extensions[ext] = (extensions[ext] || 0) + 1;
        bytes += stat.size;
        entries.push({ path: rel, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {}
    }
    const snapshot = { root: abs, createdAt: Date.now(), count: entries.length, bytes, extensions, files: entries };
    await writeJson(path.join(this.indexRoot, `${this.key(abs)}.json`), snapshot);
    return { root: abs, createdAt: snapshot.createdAt, count: entries.length, bytes, extensions };
  }
  async get(root) {
    return readJson(path.join(this.indexRoot, `${this.key(root)}.json`), null);
  }
  async search(root, query, limit = 200) {
    const abs = path.resolve(root);
    const needle = String(query || '').trim();
    if (!needle) return [];
    const { rgPath } = require('@vscode/ripgrep');
    const args = ['--json', '--hidden', '--smart-case', '--max-count', '20', '--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!dist/**', '--glob', '!build/**', '--glob', '!.next/**', needle, '.'];
    const result = await this.#collect(rgPath, args, abs, 12 * 1024 * 1024, true);
    const out = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.type !== 'match') continue;
        const rel = row.data?.path?.text || '';
        const text = row.data?.lines?.text || '';
        out.push({ path: rel, line: row.data?.line_number || 0, preview: text.trim().slice(0, 500) });
        if (out.length >= limit) break;
      } catch {}
    }
    return out;
  }
  #collect(command, args, cwd, cap, allowNoMatch = false) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { if (stdout.length < cap) stdout += d.toString(); });
      child.stderr.on('data', (d) => { if (stderr.length < cap) stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0 || (allowNoMatch && code === 1)) resolve({ code, stdout, stderr });
        else reject(new Error(stderr || `ripgrep exited with ${code}`));
      });
    });
  }
}

class PtyRuntime {
  constructor(send) { this.send = send; this.sessions = new Map(); }
  start({ cwd, cols = 120, rows = 30, shell, args = [] }) {
    const pty = require('node-pty');
    const id = crypto.randomUUID();
    const command = shell || (process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash'));
    const argv = args.length ? args : (process.platform === 'win32' ? ['-NoLogo'] : ['-l']);
    const term = pty.spawn(command, argv, { name: 'xterm-256color', cols, rows, cwd, env: { ...process.env, TERM: 'xterm-256color' } });
    const record = { id, cwd, command, term, startedAt: Date.now() };
    this.sessions.set(id, record);
    term.onData((data) => this.send('pty:data', { id, data }));
    term.onExit(({ exitCode, signal }) => { this.send('pty:exit', { id, exitCode, signal }); this.sessions.delete(id); });
    return { id, cwd, command };
  }
  write(id, data) { const s = this.sessions.get(id); if (!s) return false; s.term.write(String(data || '')); return true; }
  resize(id, cols, rows) { const s = this.sessions.get(id); if (!s) return false; s.term.resize(Math.max(20, cols|0), Math.max(5, rows|0)); return true; }
  kill(id) { const s = this.sessions.get(id); if (!s) return false; try { s.term.kill(); } catch {} this.sessions.delete(id); return true; }
  list() { return [...this.sessions.values()].map(({ id, cwd, command, startedAt }) => ({ id, cwd, command, startedAt })); }
  closeAll() { for (const id of [...this.sessions.keys()]) this.kill(id); }
}

class McpRuntime {
  constructor(dataRoot, portableRoot) {
    this.file = path.join(dataRoot, 'mcp-servers.json');
    this.portableRoot = portableRoot;
    this.clients = new Map();
  }
  async listServers() {
    const stored = await readJson(this.file, []);
    const githubBinary = path.join(this.portableRoot, 'resources', 'github-mcp-server.exe');
    if (process.platform === 'win32' && fs.existsSync(githubBinary) && !stored.some((s) => s.id === 'github')) {
      stored.unshift({ id: 'github', name: 'GitHub MCP', command: githubBinary, args: ['stdio'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' }, enabled: false, bundled: true });
      await writeJson(this.file, stored);
    }
    return stored;
  }
  async saveServers(servers) {
    const clean = (Array.isArray(servers) ? servers : []).map((s) => ({ id: String(s.id || crypto.randomUUID()), name: String(s.name || 'MCP Server'), command: String(s.command || ''), args: Array.isArray(s.args) ? s.args.map(String) : [], env: s.env && typeof s.env === 'object' ? s.env : {}, cwd: s.cwd ? String(s.cwd) : '', enabled: !!s.enabled, bundled: !!s.bundled }));
    await writeJson(this.file, clean);
    return clean;
  }
  async connect(serverId) {
    if (this.clients.has(serverId)) return this.clients.get(serverId);
    const server = (await this.listServers()).find((s) => s.id === serverId);
    if (!server) throw new Error(`未找到 MCP Server：${serverId}`);
    if (!server.command) throw new Error('MCP Server command 为空。');
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
    ]);
    const env = { ...process.env };
    for (const [k, v] of Object.entries(server.env || {})) if (v !== '') env[k] = String(v);
    const transport = new StdioClientTransport({ command: server.command, args: server.args || [], env, cwd: server.cwd || undefined, stderr: 'pipe' });
    const client = new Client({ name: 'chp', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    const record = { client, transport, server };
    this.clients.set(serverId, record);
    return record;
  }
  async listTools(serverId) {
    const { client } = await this.connect(serverId);
    const result = await client.listTools();
    return result.tools || [];
  }
  async callTool(serverId, name, args = {}) {
    const { client } = await this.connect(serverId);
    return client.callTool({ name, arguments: args || {} });
  }
  async disconnect(serverId) {
    const record = this.clients.get(serverId);
    if (!record) return false;
    try { await record.transport.close(); } catch {}
    this.clients.delete(serverId);
    return true;
  }
  async closeAll() { for (const id of [...this.clients.keys()]) await this.disconnect(id); }
}

class SkillRuntime {
  constructor(dataRoot) {
    this.root = path.join(dataRoot, 'skills');
    fs.mkdirSync(this.root, { recursive: true });
  }
  async ensureBuiltins() {
    const builtins = [
      ['code-review', 'Code Review', 'Review code for correctness, concurrency/state isolation, error handling, security, performance and maintainability. Prefer concrete findings with file paths and fixes.'],
      ['project-debug', 'Project Debug', 'Investigate failures from logs and source, reproduce when possible, identify root cause, implement the smallest robust fix, and verify with tests.'],
      ['document-studio', 'Document Studio', 'Analyze or create professional documents. Structure content clearly, preserve facts, and choose DOCX/PDF output when requested.'],
      ['spreadsheet-studio', 'Spreadsheet Studio', 'Analyze tabular data and create practical spreadsheets. Preserve types, add useful formulas, and keep outputs readable.'],
      ['presentation-studio', 'Presentation Studio', 'Create concise presentation structures with a clear narrative, strong slide titles, and speaker-ready content.'],
      ['frontend-design', 'Frontend Design', 'Create polished, accessible desktop/web interfaces with strong information hierarchy, responsive layouts and restrained visual systems.'],
    ];
    for (const [id, name, prompt] of builtins) {
      const dir = path.join(this.root, id); const file = path.join(dir, 'skill.json');
      if (!fs.existsSync(file)) { await fsp.mkdir(dir, { recursive: true }); await writeJson(file, { id, name, description: prompt.split('.')[0], systemPrompt: prompt, enabled: true, builtin: true }); }
    }
  }
  async list() {
    await this.ensureBuiltins();
    const out = [];
    for (const entry of await fsp.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skill = await readJson(path.join(this.root, entry.name, 'skill.json'), null);
      if (skill) out.push(skill);
    }
    return out.sort((a,b) => String(a.name).localeCompare(String(b.name)));
  }
  async get(id) {
    const skill = await readJson(path.join(this.root, safeName(id), 'skill.json'), null);
    if (!skill) throw new Error(`未找到 Skill：${id}`);
    return skill;
  }
  async save(skill) {
    const id = safeName(skill.id || skill.name || crypto.randomUUID()).toLowerCase();
    const value = { id, name: String(skill.name || id), description: String(skill.description || ''), systemPrompt: String(skill.systemPrompt || ''), enabled: skill.enabled !== false, builtin: !!skill.builtin };
    await fsp.mkdir(path.join(this.root, id), { recursive: true }); await writeJson(path.join(this.root, id, 'skill.json'), value); return value;
  }
}

class ArtifactRuntime {
  constructor(dataRoot) { this.root = path.join(dataRoot, 'artifacts'); fs.mkdirSync(this.root, { recursive: true }); }
  async list() {
    const out=[]; for (const entry of await fsp.readdir(this.root,{withFileTypes:true})) { if(!entry.isFile()) continue; const file=path.join(this.root,entry.name); const stat=await fsp.stat(file); out.push({name:entry.name,path:file,size:stat.size,updatedAt:stat.mtimeMs}); } return out.sort((a,b)=>b.updatedAt-a.updatedAt);
  }
  async read(name) { const file=safeJoin(this.root,name); return {name:path.basename(file),content:await fsp.readFile(file,'utf8')}; }
  async create({ name='artifact', format='md', content='', data=null, title='' }) {
    const ext=String(format||'md').toLowerCase().replace(/[^a-z0-9]/g,'') || 'md'; const base=safeName(name,'artifact'); const file=path.join(this.root,`${Date.now()}-${base}.${ext}`);
    if (['md','txt','json','html','csv'].includes(ext)) { const text=ext==='json'&&typeof data==='object'?JSON.stringify(data,null,2):String(content??''); await fsp.writeFile(file,text,'utf8'); return this.#meta(file); }
    if (ext==='docx') {
      const { Document, Packer, Paragraph, HeadingLevel } = require('docx');
      const lines=String(content||'').split(/\r?\n/); const children=lines.map((line)=>{ const m=line.match(/^(#{1,3})\s+(.*)$/); return new Paragraph(m?{text:m[2],heading:[HeadingLevel.HEADING_1,HeadingLevel.HEADING_2,HeadingLevel.HEADING_3][m[1].length-1]}:{text:line}); });
      const doc=new Document({sections:[{children}]}); await fsp.writeFile(file,await Packer.toBuffer(doc)); return this.#meta(file);
    }
    if (ext==='xlsx') {
      const ExcelJS=require('exceljs'); const wb=new ExcelJS.Workbook(); const ws=wb.addWorksheet(title||'Sheet1');
      const rows=Array.isArray(data)?data:[]; if(rows.length&&typeof rows[0]==='object'&&!Array.isArray(rows[0])) { const keys=Object.keys(rows[0]); ws.columns=keys.map(k=>({header:k,key:k,width:Math.min(40,Math.max(12,k.length+2))})); rows.forEach(r=>ws.addRow(r)); } else { String(content||'').split(/\r?\n/).forEach(line=>ws.addRow(line.split('\t'))); }
      ws.getRow(1).font={bold:true}; await wb.xlsx.writeFile(file); return this.#meta(file);
    }
    if (ext==='pptx') {
      const pptxgen=require('pptxgenjs'); const pptx=new pptxgen(); pptx.layout='LAYOUT_WIDE'; pptx.author='chp'; pptx.subject=title||base; pptx.title=title||base;
      const sections=String(content||'').split(/\n(?=#\s)/).filter(Boolean); const slides=sections.length?sections:[String(content||'')];
      for(const block of slides.slice(0,40)){ const lines=block.split(/\r?\n/).filter(Boolean); const heading=(lines.shift()||title||base).replace(/^#+\s*/,''); const slide=pptx.addSlide(); slide.background={color:'F7F7F5'}; slide.addText(heading,{x:0.7,y:0.55,w:11.8,h:0.55,fontFace:'Aptos Display',fontSize:26,bold:true,color:'111111',margin:0}); const body=lines.map(x=>x.replace(/^[-*]\s*/,'')); slide.addText(body.map(t=>({text:t,options:{bullet:{indent:18}}})),{x:0.9,y:1.5,w:11.2,h:5.3,fontFace:'Aptos',fontSize:16,color:'333333',breakLine:true,margin:0.04}); }
      await pptx.writeFile({fileName:file}); return this.#meta(file);
    }
    if (ext==='pdf') {
      const PDFDocument=require('pdfkit'); await new Promise((resolve,reject)=>{ const doc=new PDFDocument({margin:54}); const stream=fs.createWriteStream(file); doc.pipe(stream); doc.fontSize(22).text(title||base); doc.moveDown(); doc.fontSize(11).text(String(content||''),{lineGap:4}); doc.end(); stream.on('finish',resolve); stream.on('error',reject); }); return this.#meta(file);
    }
    throw new Error(`不支持的 Artifact 格式：${ext}`);
  }
  async #meta(file){ const stat=await fsp.stat(file); return {name:path.basename(file),path:file,size:stat.size,updatedAt:stat.mtimeMs}; }
}

class ComputerUseRuntime {
  constructor({ electron, dataRoot }) { this.electron=electron; this.root=path.join(dataRoot,'captures'); fs.mkdirSync(this.root,{recursive:true}); this.enabled=false; }
  setEnabled(value){ this.enabled=!!value; return this.enabled; }
  status(){ return {enabled:this.enabled,supported:process.platform==='win32'}; }
  #require(){ if(!this.enabled) throw new Error('Computer Use 未启用。请在界面中先开启。'); if(process.platform!=='win32') throw new Error('当前 Computer Use 自动化仅实现 Windows。'); }
  async capture(){
    this.#require(); const { desktopCapturer, screen }=this.electron; const display=screen.getPrimaryDisplay(); const size=display.size; const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.min(1920,size.width),height:Math.min(1080,size.height)},fetchWindowIcons:false}); const source=sources[0]; if(!source) throw new Error('无法捕获屏幕。'); const file=path.join(this.root,`${Date.now()}-screen.png`); await fsp.writeFile(file,source.thumbnail.toPNG()); return {path:file,width:source.thumbnail.getSize().width,height:source.thumbnail.getSize().height,dataUrl:source.thumbnail.toDataURL()};
  }
  async click(x,y,button='left'){ this.#require(); const flag=button==='right'?'0x0008,0x0010':'0x0002,0x0004'; const script=`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CHPWin { [DllImport("user32.dll")] public static extern bool SetCursorPos(int X,int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,uint e); }'; [CHPWin]::SetCursorPos(${Number(x)|0},${Number(y)|0}) | Out-Null; [CHPWin]::mouse_event(${flag.split(',')[0]},0,0,0,0); Start-Sleep -Milliseconds 70; [CHPWin]::mouse_event(${flag.split(',')[1]},0,0,0,0)`; await this.#ps(script); return {x:Number(x)|0,y:Number(y)|0,button}; }
  async type(text){ this.#require(); const value=String(text||''); this.electron.clipboard.writeText(value); await this.#ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')`); return {characters:value.length}; }
  async key(keys){ this.#require(); const encoded=Buffer.from(String(keys||''),'utf8').toString('base64'); const script=`Add-Type -AssemblyName System.Windows.Forms; $s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); [System.Windows.Forms.SendKeys]::SendWait($s)`; await this.#ps(script); return {keys:String(keys||'')}; }
  async openUrl(url){ this.#require(); const parsed=new URL(String(url)); if(!['http:','https:'].includes(parsed.protocol)) throw new Error('只允许 http/https URL。'); await this.electron.shell.openExternal(parsed.toString()); return {url:parsed.toString()}; }
  #ps(script){ return new Promise((resolve,reject)=>{ const p=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true}); let err=''; p.stderr.on('data',d=>err+=d); p.on('error',reject); p.on('close',c=>c===0?resolve():reject(new Error(err||`PowerShell exited ${c}`))); }); }
}

module.exports={ ProjectIndexer, PtyRuntime, McpRuntime, SkillRuntime, ArtifactRuntime, ComputerUseRuntime, safeJoin, within, readJson, writeJson };
