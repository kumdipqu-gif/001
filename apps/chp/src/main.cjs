const electron = require('electron');
const { app, BrowserWindow, dialog, ipcMain, shell } = electron;
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { parseLocalDocument } = require('./documents.cjs');
const { DEFAULTS, normalizeConfig, modelTurn, testConnection } = require('./model-gateway.cjs');
const { ProjectIndexer, PtyRuntime, McpRuntime, SkillRuntime, ArtifactRuntime, ComputerUseRuntime, safeJoin, readJson, writeJson } = require('./work-runtime.cjs');

const APP_NAME = 'chp';
const exeDir = path.dirname(process.execPath);
const portableRoot = app.isPackaged ? exeDir : path.resolve(__dirname, '..');
const dataRoot = path.join(portableRoot, 'data');
const userData = path.join(dataRoot, 'user-data');
const configPath = path.join(dataRoot, 'chp-api.json');
const bundledConfigPath = path.join(portableRoot, 'chp-api.json');
const workspaceState = path.join(dataRoot, 'workspace.json');
const projectsPath = path.join(dataRoot, 'projects.json');
const chatPath = path.join(dataRoot, 'chats.json');
const tasksPath = path.join(dataRoot, 'tasks.json');
const statePath = path.join(dataRoot, 'state.json');

for (const p of [dataRoot, userData, path.join(dataRoot,'session-data'), path.join(dataRoot,'logs'), path.join(dataRoot,'crash-dumps'), path.join(dataRoot,'runtime')]) fs.mkdirSync(p, { recursive: true });
app.setName(APP_NAME);
app.setPath('userData', userData);
app.setPath('sessionData', path.join(dataRoot, 'session-data'));
app.setPath('logs', path.join(dataRoot, 'logs'));
app.setPath('crashDumps', path.join(dataRoot, 'crash-dumps'));

const loadConfig = async () => {
  const fromData = await readJson(configPath, null);
  if (fromData) return normalizeConfig(fromData);
  const fromRoot = await readJson(bundledConfigPath, null);
  if (fromRoot) { const normalized = normalizeConfig(fromRoot); await writeJson(configPath, normalized); return normalized; }
  return normalizeConfig(DEFAULTS);
};
const saveConfig = async (cfg) => { const normalized = normalizeConfig(cfg); await writeJson(configPath, normalized); return normalized; };
const getCurrentWorkspace = async () => {
  const ws = await readJson(workspaceState, { root: '', id: '' });
  if (!ws.root) throw new Error('请先选择项目文件夹。');
  const root = path.resolve(ws.root);
  try { if (!(await fsp.stat(root)).isDirectory()) throw new Error(); } catch { throw new Error('当前项目文件夹不存在。'); }
  return { ...ws, root };
};
const projectId = (root) => crypto.createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16);
async function rememberProject(root) {
  const abs = path.resolve(root); const id = projectId(abs); const projects = await readJson(projectsPath, []);
  const next = [{ id, name: path.basename(abs) || abs, root: abs, lastOpenedAt: Date.now() }, ...projects.filter((p) => p.id !== id && path.resolve(p.root) !== abs)].slice(0, 100);
  await writeJson(projectsPath, next); await writeJson(workspaceState, { id, root: abs }); return next[0];
}

const indexer = new ProjectIndexer(dataRoot);
const skills = new SkillRuntime(dataRoot);
const artifacts = new ArtifactRuntime(dataRoot);
const mcp = new McpRuntime(dataRoot, portableRoot);
let mainWindow;
const send = (channel, payload) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload); };
const pty = new PtyRuntime(send);
const computer = new ComputerUseRuntime({ electron, dataRoot });
const activeRuns = new Map();

const IGNORED_DIRS = new Set(['.git','node_modules','.next','dist','build','coverage','.cache','.turbo','.idea','.vscode']);
async function listWorkspace(root, rel = '') {
  const dir = safeJoin(root, rel); const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries.filter((x)=>!IGNORED_DIRS.has(x.name)).map((x)=>({name:x.name,path:path.relative(root,path.join(dir,x.name)),type:x.isDirectory()?'dir':'file'})).sort((a,b)=>a.type===b.type?a.name.localeCompare(b.name):a.type==='dir'?-1:1);
}
async function readWorkspaceFile(root, rel) {
  const file = safeJoin(root, rel); const stat = await fsp.stat(file); if(!stat.isFile()) throw new Error('目标不是文件。'); const parsed = await parseLocalDocument(file); return {path:rel,kind:parsed.kind,content:parsed.content};
}
async function writeWorkspaceFile(root, rel, content) {
  const file=safeJoin(root,rel); await fsp.mkdir(path.dirname(file),{recursive:true}); await fsp.writeFile(file,String(content??''),'utf8'); return {path:rel,bytes:Buffer.byteLength(String(content??''))};
}
async function runCommand(root, command, timeoutMs=120000) {
  return new Promise((resolve)=>{
    const isWin=process.platform==='win32'; const child=spawn(isWin?'powershell.exe':'/bin/sh',isWin?['-NoLogo','-NoProfile','-NonInteractive','-Command',String(command)]:['-lc',String(command)],{cwd:root,env:{...process.env},windowsHide:true});
    let stdout='',stderr=''; const cap=8*1024*1024; let timedOut=false; const timer=setTimeout(()=>{timedOut=true;try{child.kill('SIGTERM')}catch{}},Math.max(1000,Math.min(Number(timeoutMs)||120000,10*60*1000)));
    child.stdout.on('data',(d)=>{if(stdout.length<cap) stdout+=d.toString()}); child.stderr.on('data',(d)=>{if(stderr.length<cap) stderr+=d.toString()});
    child.on('close',(code)=>{clearTimeout(timer);resolve({code,stdout,stderr,timedOut})}); child.on('error',(error)=>{clearTimeout(timer);resolve({code:-1,stdout,stderr:`${stderr}\n${error.message}`,timedOut})});
  });
}

const TOOL_DEFS = [
  {name:'workspace_tree',description:'List files and folders in the active local project.',input_schema:{type:'object',properties:{path:{type:'string'}}}},
  {name:'read_file',description:'Read a source file or supported document from the active local project.',input_schema:{type:'object',properties:{path:{type:'string'}},required:['path']}},
  {name:'write_file',description:'Create or overwrite a UTF-8 text file inside the active local project.',input_schema:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content']}},
  {name:'search_project',description:'Fast ripgrep content search in the active local project.',input_schema:{type:'object',properties:{query:{type:'string'},limit:{type:'number'}},required:['query']}},
  {name:'index_project',description:'Build a local file index and project statistics snapshot.',input_schema:{type:'object',properties:{}}},
  {name:'run_command',description:'Run a command inside the active project and return stdout/stderr.',input_schema:{type:'object',properties:{command:{type:'string'},timeout_ms:{type:'number'}},required:['command']}},
  {name:'skill_list',description:'List locally installed chp Skills.',input_schema:{type:'object',properties:{}}},
  {name:'skill_read',description:'Read one local chp Skill instruction.',input_schema:{type:'object',properties:{id:{type:'string'}},required:['id']}},
  {name:'artifact_generate',description:'Generate a local artifact. Formats: md, txt, json, html, csv, docx, xlsx, pptx, pdf.',input_schema:{type:'object',properties:{name:{type:'string'},format:{type:'string'},title:{type:'string'},content:{type:'string'},data:{}},required:['name','format']}},
  {name:'mcp_servers',description:'List configured MCP servers.',input_schema:{type:'object',properties:{}}},
  {name:'mcp_tools',description:'Connect to one MCP server and list its tools.',input_schema:{type:'object',properties:{server_id:{type:'string'}},required:['server_id']}},
  {name:'mcp_call',description:'Call a tool on a configured MCP server.',input_schema:{type:'object',properties:{server_id:{type:'string'},tool:{type:'string'},arguments:{type:'object'}},required:['server_id','tool']}},
  {name:'computer_capture',description:'Capture the primary screen when Computer Use has been explicitly enabled.',input_schema:{type:'object',properties:{}}},
  {name:'computer_click',description:'Click screen coordinates when Computer Use is enabled.',input_schema:{type:'object',properties:{x:{type:'number'},y:{type:'number'},button:{type:'string'}},required:['x','y']}},
  {name:'computer_type',description:'Type or paste text into the focused application when Computer Use is enabled.',input_schema:{type:'object',properties:{text:{type:'string'}},required:['text']}},
  {name:'computer_key',description:'Send a Windows SendKeys sequence when Computer Use is enabled.',input_schema:{type:'object',properties:{keys:{type:'string'}},required:['keys']}},
  {name:'computer_open_url',description:'Open an http/https URL in the system browser when Computer Use is enabled.',input_schema:{type:'object',properties:{url:{type:'string'}},required:['url']}},
];

async function executeTool(call, context) {
  const input=call.input||{}; const root=context.workspaceRoot;
  if(call.name==='workspace_tree') return listWorkspace(root,input.path||'');
  if(call.name==='read_file') return readWorkspaceFile(root,input.path||'');
  if(call.name==='write_file') return writeWorkspaceFile(root,input.path||'',input.content||'');
  if(call.name==='search_project') return indexer.search(root,input.query||'',Math.min(500,Number(input.limit)||200));
  if(call.name==='index_project') return indexer.build(root);
  if(call.name==='run_command') return runCommand(root,input.command||'',input.timeout_ms||120000);
  if(call.name==='skill_list') return skills.list();
  if(call.name==='skill_read') return skills.get(input.id);
  if(call.name==='artifact_generate') return artifacts.create(input);
  if(call.name==='mcp_servers') return (await mcp.listServers()).map(({env,...s})=>({...s,envKeys:Object.keys(env||{})}));
  if(call.name==='mcp_tools') return mcp.listTools(input.server_id);
  if(call.name==='mcp_call') return mcp.callTool(input.server_id,input.tool,input.arguments||{});
  if(call.name==='computer_capture') { const result=await computer.capture(); return {...result,__imageDataUrl:result.dataUrl,dataUrl:undefined}; }
  if(call.name==='computer_click') return computer.click(input.x,input.y,input.button||'left');
  if(call.name==='computer_type') return computer.type(input.text||'');
  if(call.name==='computer_key') return computer.key(input.keys||'');
  if(call.name==='computer_open_url') return computer.openUrl(input.url||'');
  throw new Error(`未知工具：${call.name}`);
}

async function skillContext() {
  const enabled=(await skills.list()).filter((s)=>s.enabled!==false); if(!enabled.length) return '';
  return `\n\nLocal Skills available:\n${enabled.map((s)=>`- ${s.id}: ${s.description||s.name}`).join('\n')}\nUse skill_read when a task matches a Skill.`;
}

async function startConversation(event,payload) {
  const requestId=payload.requestId||crypto.randomUUID(); const mode=payload.mode==='work'?'work':'chat'; const controller=new AbortController();
  let workspaceRoot=''; if(mode==='work'){ const selectedRoot=payload.workspaceRoot?path.resolve(payload.workspaceRoot):(await getCurrentWorkspace()).root; workspaceRoot=selectedRoot; const stat=await fsp.stat(workspaceRoot); if(!stat.isDirectory()) throw new Error('工作区不存在。'); }
  activeRuns.set(requestId,{controller,workspaceRoot,startedAt:Date.now()});
  try{
    const baseConfig=await loadConfig(); const config={...baseConfig,system_prompt:`${baseConfig.system_prompt||''}${mode==='work'?await skillContext():''}`}; const messages=Array.isArray(payload.messages)?structuredClone(payload.messages):[];
    if(mode==='work') messages.unshift({role:'user',content:`Current local workspace: ${workspaceRoot}\nAll file and command tools are scoped to this captured workspace for the full run. Inspect before editing. Do not access paths outside it.`});
    const tools=mode==='work'?TOOL_DEFS:[]; let finalText='',usage=null,toolRounds=0;
    while(toolRounds<20){
      const turn=await modelTurn({config,messages,tools,signal:controller.signal,onDelta:(delta)=>{finalText+=delta;if(!event.sender.isDestroyed())event.sender.send('chat:delta',{requestId,delta})},onUsage:(value)=>{usage=value;if(!event.sender.isDestroyed())event.sender.send('chat:usage',{requestId,usage:value})}});
      if(!turn.toolCalls?.length) break; toolRounds+=1; messages.push({role:'assistant',content:turn.text||'',toolCalls:turn.toolCalls});
      for(const call of turn.toolCalls){
        if(!event.sender.isDestroyed())event.sender.send('chat:tool',{requestId,phase:'start',tool:{id:call.id,name:call.name,input:call.input}});
        try{
          const result=await executeTool(call,{workspaceRoot,requestId}); const imageDataUrl=result?.__imageDataUrl; const clean=imageDataUrl?Object.fromEntries(Object.entries(result).filter(([k])=>k!=='__imageDataUrl')):result; const content=JSON.stringify(clean,null,2).slice(0,180000); messages.push({role:'tool',toolCallId:call.id,content});
          if(imageDataUrl) messages.push({role:'user',content:[{type:'text',text:'Current primary-screen capture from Computer Use.'},{type:'image',dataUrl:imageDataUrl}]});
          if(!event.sender.isDestroyed())event.sender.send('chat:tool',{requestId,phase:'done',tool:{id:call.id,name:call.name},result:clean});
        }catch(error){ const message=error?.message||String(error); messages.push({role:'tool',toolCallId:call.id,content:message,isError:true}); if(!event.sender.isDestroyed())event.sender.send('chat:tool',{requestId,phase:'error',tool:{id:call.id,name:call.name},error:message}); }
      }
    }
    if(toolRounds>=20) throw new Error('Work Agent 达到单次任务最大工具轮次 20。');
    if(!event.sender.isDestroyed())event.sender.send('chat:done',{requestId,usage,text:finalText});
  }catch(error){ const cancelled=error?.name==='AbortError'; if(!event.sender.isDestroyed())event.sender.send(cancelled?'chat:done':'chat:error',{requestId,cancelled,message:error?.message||String(error)}); }
  finally{activeRuns.delete(requestId)}
}

function createWindow(){
  mainWindow=new BrowserWindow({width:1540,height:980,minWidth:1100,minHeight:720,backgroundColor:'#0b0d10',title:APP_NAME,icon:path.join(portableRoot,'resources','chp.ico'),autoHideMenuBar:true,titleBarStyle:'hidden',titleBarOverlay:{color:'#0b0d10',symbolColor:'#e7e9ee',height:40},webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:false,webSecurity:true}});
  mainWindow.loadFile(path.join(__dirname,'renderer','index.html')); mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'})); mainWindow.webContents.on('will-navigate',(e,url)=>{if(!url.startsWith('file://'))e.preventDefault()});
}

ipcMain.handle('app:info',async()=>({appName:APP_NAME,portable:true,portableRoot,dataRoot,version:app.getVersion(),cloudAccountRequired:false,modelNetworking:true,features:['chat','work-agent','files','indexer','pty','mcp','skills','artifacts','computer-use','tasks']}));
ipcMain.handle('config:get',async()=>loadConfig()); ipcMain.handle('config:set',async(_e,cfg)=>saveConfig(cfg)); ipcMain.handle('config:test',async(_e,cfg)=>testConnection(cfg||await loadConfig()));
ipcMain.handle('config:import',async()=>{const r=await dialog.showOpenDialog(mainWindow,{properties:['openFile'],filters:[{name:'chp API 配置',extensions:['json']}]});if(r.canceled||!r.filePaths[0])return null;return saveConfig(JSON.parse(await fsp.readFile(r.filePaths[0],'utf8')))});
ipcMain.handle('workspace:choose',async()=>{const r=await dialog.showOpenDialog(mainWindow,{properties:['openDirectory','createDirectory']});if(r.canceled||!r.filePaths[0])return null;return rememberProject(r.filePaths[0])});
ipcMain.handle('workspace:get',async()=>readJson(workspaceState,{root:'',id:''})); ipcMain.handle('workspace:list',async()=>readJson(projectsPath,[]));
ipcMain.handle('workspace:switch',async(_e,id)=>{const p=(await readJson(projectsPath,[])).find((x)=>x.id===id);if(!p)throw new Error('项目不存在。');await writeJson(workspaceState,{id:p.id,root:p.root});return p});
ipcMain.handle('workspace:reveal',async()=>{const {root}=await getCurrentWorkspace();shell.showItemInFolder(root);return true});
ipcMain.handle('files:list',async(_e,rel='')=>{const {root}=await getCurrentWorkspace();return listWorkspace(root,rel)});
ipcMain.handle('files:read',async(_e,rel)=>{const {root}=await getCurrentWorkspace();return readWorkspaceFile(root,rel)});
ipcMain.handle('files:write',async(_e,p)=>{const {root}=await getCurrentWorkspace();return writeWorkspaceFile(root,p.rel,p.content)});
ipcMain.handle('files:search',async(_e,q)=>{const {root}=await getCurrentWorkspace();return indexer.search(root,q,250)});
ipcMain.handle('files:pick',async()=>{const r=await dialog.showOpenDialog(mainWindow,{properties:['openFile','multiSelections'],filters:[{name:'文档、代码与数据',extensions:['txt','md','pdf','docx','xlsx','xls','xlsm','csv','tsv','pptx','json','js','jsx','ts','tsx','py','html','css','xml','yaml','yml','toml','ini','log']},{name:'全部文件',extensions:['*']}]});if(r.canceled)return[];const docs=[];for(const file of r.filePaths.slice(0,16)){try{const parsed=await parseLocalDocument(file);docs.push({name:path.basename(file),path:file,kind:parsed.kind,content:parsed.content.slice(0,400000)})}catch(error){docs.push({name:path.basename(file),path:file,kind:'error',content:error?.message||String(error)})}}return docs});
ipcMain.handle('terminal:run',async(_e,command)=>{const {root}=await getCurrentWorkspace();return runCommand(root,command)});
ipcMain.handle('pty:start',async(_e,opts={})=>{const {root}=await getCurrentWorkspace();return pty.start({...opts,cwd:root})}); ipcMain.handle('pty:write',async(_e,id,data)=>pty.write(id,data)); ipcMain.handle('pty:resize',async(_e,id,c,r)=>pty.resize(id,c,r)); ipcMain.handle('pty:kill',async(_e,id)=>pty.kill(id)); ipcMain.handle('pty:list',async()=>pty.list());
ipcMain.handle('index:build',async()=>{const {root}=await getCurrentWorkspace();return indexer.build(root)}); ipcMain.handle('index:get',async()=>{const {root}=await getCurrentWorkspace();return indexer.get(root)}); ipcMain.handle('index:search',async(_e,q)=>{const {root}=await getCurrentWorkspace();return indexer.search(root,q,500)});
ipcMain.handle('mcp:servers',async()=>mcp.listServers()); ipcMain.handle('mcp:save',async(_e,v)=>mcp.saveServers(v)); ipcMain.handle('mcp:tools',async(_e,id)=>mcp.listTools(id)); ipcMain.handle('mcp:call',async(_e,id,name,args)=>mcp.callTool(id,name,args)); ipcMain.handle('mcp:disconnect',async(_e,id)=>mcp.disconnect(id));
ipcMain.handle('skills:list',async()=>skills.list()); ipcMain.handle('skills:get',async(_e,id)=>skills.get(id)); ipcMain.handle('skills:save',async(_e,s)=>skills.save(s));
ipcMain.handle('artifacts:list',async()=>artifacts.list()); ipcMain.handle('artifacts:create',async(_e,p)=>artifacts.create(p)); ipcMain.handle('artifacts:read',async(_e,n)=>artifacts.read(n)); ipcMain.handle('artifacts:reveal',async(_e,n)=>{shell.showItemInFolder(safeJoin(path.join(dataRoot,'artifacts'),n));return true});
ipcMain.handle('computer:status',async()=>computer.status()); ipcMain.handle('computer:enable',async(_e,v)=>computer.setEnabled(v)); ipcMain.handle('computer:capture',async()=>computer.capture()); ipcMain.handle('computer:click',async(_e,p)=>computer.click(p.x,p.y,p.button)); ipcMain.handle('computer:type',async(_e,t)=>computer.type(t)); ipcMain.handle('computer:key',async(_e,k)=>computer.key(k)); ipcMain.handle('computer:open',async(_e,u)=>computer.openUrl(u));
ipcMain.on('chat:start',(event,payload)=>void startConversation(event,payload)); ipcMain.handle('chat:cancel',async(_e,id)=>{activeRuns.get(id)?.controller.abort();return true}); ipcMain.handle('chat:runs',async()=>[...activeRuns.entries()].map(([id,r])=>({id,workspaceRoot:r.workspaceRoot,startedAt:r.startedAt})));
ipcMain.handle('chats:get',async()=>readJson(chatPath,[])); ipcMain.handle('chats:set',async(_e,v)=>{await writeJson(chatPath,Array.isArray(v)?v:[]);return true}); ipcMain.handle('tasks:get',async()=>readJson(tasksPath,[])); ipcMain.handle('tasks:set',async(_e,v)=>{await writeJson(tasksPath,Array.isArray(v)?v:[]);return true}); ipcMain.handle('state:get',async()=>readJson(statePath,{})); ipcMain.handle('state:set',async(_e,v)=>{await writeJson(statePath,v&&typeof v==='object'?v:{});return true});

app.whenReady().then(async()=>{await skills.ensureBuiltins();await mcp.listServers();createWindow()});
app.on('before-quit',()=>{pty.closeAll();void mcp.closeAll()}); app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()}); app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow()});
