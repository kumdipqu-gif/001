const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  chats: [], activeChatId: null, workspace: { root: '' }, tasks: [], config: null,
  editorPath: '', currentRequestId: null, currentMode: 'chat', pendingDocuments: [], artifacts: [],
};
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
const basename = (p='') => p.replace(/[\\/]+$/,'').split(/[\\/]/).pop() || '';
const escapeHtml = (s='') => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function switchView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'files') refreshFiles();
  if (name === 'tasks') renderTasks();
  if (name === 'work') refreshArtifacts();
}
function currentChat() { return state.chats.find((x) => x.id === state.activeChatId); }
function ensureChat() {
  let chat = currentChat();
  if (!chat) {
    chat = { id: uid(), title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    state.chats.unshift(chat); state.activeChatId = chat.id;
  }
  return chat;
}
async function saveChats() { await window.chp.chat.saveAll(state.chats); renderChatList(); }
function renderChatList() {
  const q = ($('#sidebarSearch')?.value || '').trim().toLowerCase();
  $('#chatList').innerHTML = state.chats.filter((c) => !q || c.title.toLowerCase().includes(q)).slice(0,50)
    .map((c) => `<div class="chat-item ${c.id===state.activeChatId?'active':''}" data-chat-id="${c.id}"><span class="dot"></span><span>${escapeHtml(c.title)}</span></div>`).join('');
  $$('#chatList .chat-item').forEach((el) => el.onclick = () => { state.activeChatId = el.dataset.chatId; renderChat(); renderChatList(); });
}
function renderChat() {
  const chat = currentChat(); const messages = chat?.messages || [];
  $('#chatTitle').textContent = chat?.title || '新对话';
  $('#emptyState').style.display = messages.length ? 'none' : 'block';
  $('#messages').querySelectorAll('.message').forEach((el) => el.remove());
  for (const m of messages) {
    const div = document.createElement('div'); div.className = `message ${m.role}${m.error?' error':''}`; div.textContent = m.content || ''; $('#messages').appendChild(div);
  }
  $('#messages').scrollTop = $('#messages').scrollHeight;
}
function buildDocumentContext(documents) {
  return documents.map((doc) => `\n\n--- 附件开始: ${doc.name} (${doc.kind}) ---\n${doc.content}\n--- 附件结束: ${doc.name} ---`).join('');
}
function renderContextStrip() {
  const items = [];
  if (state.pendingDocuments.length) items.push(`附件 ${state.pendingDocuments.length}`);
  if (state.workspace.root) items.push(`工作区 ${basename(state.workspace.root)}`);
  $('#contextStrip').textContent = items.length ? items.join(' · ') : '';
}
async function pickDocuments() {
  const docs = await window.chp.files.pick(); if (!docs?.length) return;
  state.pendingDocuments = docs; $('#insertFile').textContent = `＋ 文件 (${docs.length})`; renderContextStrip(); $('#prompt').focus();
}
async function sendPrompt(text, mode='chat') {
  const prompt = String(text || '').trim(); if (!prompt || state.currentRequestId) return;
  const chat = ensureChat(); if (!chat.messages.length) chat.title = prompt.slice(0,32) + (prompt.length>32?'…':'');
  const docs = state.pendingDocuments;
  const visible = prompt + (docs.length ? `\n\n[已附加 ${docs.map((d)=>d.name).join('、')}]` : '');
  const modelContent = prompt + buildDocumentContext(docs);
  chat.messages.push({ role:'user', content:visible, modelContent });
  chat.messages.push({ role:'assistant', content:'' });
  chat.updatedAt = Date.now(); state.pendingDocuments = []; $('#insertFile').textContent='＋ 文件'; renderContextStrip();
  state.currentRequestId = uid(); state.currentMode = mode; $('#send').textContent='■'; $('#workStatus').textContent = mode==='work' ? 'RUNNING' : $('#workStatus').textContent;
  $('#prompt').value=''; autoSizePrompt(); renderChat(); await saveChats();
  if (mode === 'work') { $('#toolTimeline').innerHTML=''; switchView('work'); }
  const payloadMessages = chat.messages.slice(0,-1).map((m)=>({ role:m.role, content:m.modelContent || m.content }));
  window.chp.chat.start({ requestId:state.currentRequestId, mode, messages:payloadMessages });
}
function finishRequest(errorMessage='') {
  const chat=currentChat(); const msg=chat?.messages.at(-1);
  if (errorMessage && msg?.role==='assistant') { msg.content = msg.content || `请求失败：${errorMessage}`; msg.error=true; }
  if (state.currentMode==='work') $('#workStatus').textContent = errorMessage ? 'ERROR' : 'DONE';
  state.currentRequestId=null; state.currentMode='chat'; $('#send').textContent='➤';
  if (chat) { chat.updatedAt=Date.now(); saveChats(); } renderChat(); refreshArtifacts();
}
function autoSizePrompt(){const el=$('#prompt');el.style.height='auto';el.style.height=`${Math.min(180,Math.max(48,el.scrollHeight))}px`;}

async function chooseWorkspace(){const ws=await window.chp.workspace.choose();if(ws){state.workspace=ws;updateWorkspaceUI();await refreshFiles();}}
function updateWorkspaceUI(){const root=state.workspace.root||'';$('#workspaceName').textContent=root?basename(root):'选择项目文件夹';$('#workspacePath').textContent=root||'未选择';$('#inspectorWorkspace').textContent=root?basename(root):'—';$('#projectSummary').textContent=root?`当前项目：${root}。Agent 工具仅允许访问这个目录。`:'选择一个本地项目文件夹开始工作。';renderContextStrip();}
async function refreshFiles(){if(!state.workspace.root){$('#fileList').innerHTML='';$('#fileCount').textContent='0';return;}try{const files=await window.chp.files.list('');$('#fileCount').textContent=files.length;$('#fileList').innerHTML=files.map((f)=>`<div class="file-row ${f.type}" data-file="${encodeURIComponent(f.path)}" data-type="${f.type}">${f.type==='dir'?'▰':'·'} ${escapeHtml(f.name)}</div>`).join('');$$('#fileList .file-row').forEach((el)=>el.onclick=async()=>{if(el.dataset.type!=='file')return;const rel=decodeURIComponent(el.dataset.file);const r=await window.chp.files.read(rel);state.editorPath=r.path;$('#editorPath').textContent=`${r.path} · ${r.kind||'text'}`;$('#editor').value=r.content;});}catch(e){$('#fileList').innerHTML=`<div class="search-row">${escapeHtml(e.message)}</div>`;}}
async function searchFiles(){const q=$('#fileSearch').value.trim();if(!q)return;$('#searchResults').innerHTML='<div class="search-row">搜索中…</div>';try{const results=await window.chp.files.search(q);$('#searchResults').innerHTML=results.map((r)=>`<div class="search-row" data-file="${encodeURIComponent(r.path)}"><strong>${escapeHtml(r.path)}</strong>${r.preview?`<small>${escapeHtml(r.preview)}</small>`:''}</div>`).join('')||'<div class="search-row">没有结果</div>';$$('#searchResults [data-file]').forEach((el)=>el.onclick=async()=>{const rel=decodeURIComponent(el.dataset.file);const r=await window.chp.files.read(rel);state.editorPath=r.path;$('#editorPath').textContent=`${r.path} · ${r.kind||'text'}`;$('#editor').value=r.content;});}catch(e){$('#searchResults').innerHTML=`<div class="search-row">${escapeHtml(e.message)}</div>`;}}
async function runCommand(){const command=$('#commandInput').value.trim();if(!command)return;$('#terminalOutput').textContent=`> ${command}\n\n运行中…`;try{const r=await window.chp.terminal.run(command);$('#terminalOutput').textContent=`> ${command}\n\n${r.stdout}${r.stderr?`\n[stderr]\n${r.stderr}`:''}\n\n[exit ${r.code}${r.timedOut?' · timeout':''}]`;}catch(e){$('#terminalOutput').textContent=e.message;}}

function renderTasks(){ $('#taskCount').textContent=state.tasks.length; $('#taskBoard').innerHTML=state.tasks.map((t)=>`<div class="task-card ${t.done?'done':''}" data-task="${t.id}"><h3>${escapeHtml(t.title)}</h3><p>${escapeHtml(t.note||'本地任务')}</p><div class="task-actions"><button data-toggle>${t.done?'恢复':'完成'}</button><button data-delete>删除</button></div></div>`).join('')||'<div class="task-card"><h3>还没有任务</h3><p>任务保存在 chp/data/tasks.json。</p></div>'; $$('#taskBoard [data-task]').forEach((card)=>{card.querySelector('[data-toggle]').onclick=async()=>{const t=state.tasks.find((x)=>x.id===card.dataset.task);t.done=!t.done;await window.chp.tasks.set(state.tasks);renderTasks();};card.querySelector('[data-delete]').onclick=async()=>{state.tasks=state.tasks.filter((x)=>x.id!==card.dataset.task);await window.chp.tasks.set(state.tasks);renderTasks();};}); }
async function addTask(){const title=prompt('任务名称');if(!title?.trim())return;state.tasks.unshift({id:uid(),title:title.trim(),note:'',done:false,createdAt:Date.now()});await window.chp.tasks.set(state.tasks);renderTasks();}

async function refreshArtifacts(){try{state.artifacts=await window.chp.artifacts.list();$('#artifactCount').textContent=state.artifacts.length;$('#artifactList').innerHTML=state.artifacts.slice(0,20).map((a)=>`<button class="artifact-row" data-artifact="${encodeURIComponent(a.name)}"><strong>${escapeHtml(a.name)}</strong><small>${Math.round(a.size/1024)} KB</small></button>`).join('')||'<div class="tool-empty">暂无产物</div>';$$('[data-artifact]').forEach((el)=>el.onclick=async()=>{const r=await window.chp.artifacts.read(decodeURIComponent(el.dataset.artifact));switchView('files');state.editorPath='';$('#editorPath').textContent=r.name;$('#editor').value=r.content;});}catch{}}
function appendToolEvent(evt){const host=$('#toolTimeline');host.querySelector('.tool-empty')?.remove();const div=document.createElement('div');div.className=`tool-event ${evt.phase||''}`;const name=evt.tool?.name||'tool';const input=evt.tool?.input?JSON.stringify(evt.tool.input):'';div.innerHTML=`<strong>${escapeHtml(name)}</strong><span>${escapeHtml(evt.phase||'')}</span><small>${escapeHtml(input).slice(0,500)}</small>`;host.appendChild(div);host.scrollTop=host.scrollHeight;}

async function loadSettings(){state.config=await window.chp.config.get();$('#settingProtocol').value=state.config.protocol||'anthropic';$('#settingAuth').value=state.config.auth_scheme||'bearer';$('#settingEndpoint').value=state.config.base_url||'';$('#settingApiKey').value=state.config.api_key||'';$('#settingModel').value=state.config.model||'';$('#settingTemperature').value=state.config.temperature??0.7;$('#settingMaxTokens').value=state.config.max_tokens??8192;$('#settingSystem').value=state.config.system_prompt||'';$('#modelName').textContent=state.config.model||'未配置模型';$('#endpointName').textContent=state.config.base_url||'模型接入待配置';$('#inspectorModel').textContent=state.config.model||'—';$('#inspectorProtocol').textContent=(state.config.protocol||'—').toUpperCase();}
function settingsPayload(){return{protocol:$('#settingProtocol').value,auth_scheme:$('#settingAuth').value,base_url:$('#settingEndpoint').value.trim(),api_key:$('#settingApiKey').value,model:$('#settingModel').value.trim(),temperature:Number($('#settingTemperature').value||0.7),max_tokens:Number($('#settingMaxTokens').value||8192),system_prompt:$('#settingSystem').value};}
async function saveSettings(){const box=$('#settingsMessage');box.textContent='';try{state.config=await window.chp.config.set(settingsPayload());box.textContent='已保存到本地 chp/data/chp-api.json。';box.style.color='';await loadSettings();}catch(e){box.style.color='#ff8d8d';box.textContent=e.message;}}
async function testSettings(){const box=$('#settingsMessage');box.style.color='';box.textContent='正在测试模型接口…';try{const r=await window.chp.config.test(settingsPayload());box.textContent=`连接成功 · ${r.protocol} · ${r.model} · ${r.output||'OK'}`;}catch(e){box.style.color='#ff8d8d';box.textContent=`连接失败：${e.message}`;}}
async function importSettings(){const cfg=await window.chp.config.importFile();if(cfg){state.config=cfg;await loadSettings();$('#settingsMessage').textContent='已导入并保存 chp-api.json。';}}
function quickAction(action){const map={scan:'扫描当前项目结构，识别关键模块、构建方式、风险和最值得优先处理的问题。',review:'对当前项目做代码审查，优先找真实 bug、并发/状态污染、错误处理、安全和可维护性问题，并直接修复高置信问题。',plan:'结合当前项目生成一个可执行实施计划，按优先级、依赖关系和验证方式排列。',docs:'根据当前项目实际结构整理项目说明、运行方法、核心模块和维护注意事项，并生成 Artifact。'};$('#workPrompt').value=map[action]||'';switchView('work');$('#workPrompt').focus();}

async function init(){state.workspace=await window.chp.workspace.get();state.chats=await window.chp.chat.getAll();state.tasks=await window.chp.tasks.get();if(state.chats[0])state.activeChatId=state.chats[0].id;updateWorkspaceUI();renderChatList();renderChat();renderTasks();await loadSettings();await refreshFiles();await refreshArtifacts();
  $$('[data-view]').forEach((b)=>b.onclick=()=>switchView(b.dataset.view));$('#openSettings').onclick=()=>switchView('settings');$('#newChat').onclick=async()=>{state.activeChatId=null;ensureChat();await saveChats();renderChat();switchView('chat');};$('#chooseWorkspace').onclick=chooseWorkspace;$('#refreshProject').onclick=refreshFiles;$('#sidebarSearch').oninput=renderChatList;$('#prompt').oninput=autoSizePrompt;$('#prompt').onkeydown=(e)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendPrompt($('#prompt').value,'chat');}};$('#send').onclick=()=>state.currentRequestId?window.chp.chat.cancel(state.currentRequestId):sendPrompt($('#prompt').value,'chat');$('#clearChat').onclick=async()=>{const chat=currentChat();if(chat){chat.messages=[];await saveChats();renderChat();}};$$('.suggestions button').forEach((b)=>b.onclick=()=>sendPrompt(b.dataset.prompt,'chat'));$$('.quick-grid button').forEach((b)=>b.onclick=()=>quickAction(b.dataset.action));$('#fileSearchBtn').onclick=searchFiles;$('#fileSearch').onkeydown=(e)=>{if(e.key==='Enter')searchFiles();};$('#saveFile').onclick=async()=>{if(!state.editorPath)return;await window.chp.files.write({rel:state.editorPath,content:$('#editor').value});$('#editorPath').textContent=`${state.editorPath} · 已保存`;};$('#runCommand').onclick=runCommand;$('#commandInput').onkeydown=(e)=>{if(e.key==='Enter')runCommand();};$('#addTask').onclick=addTask;$('#saveSettings').onclick=saveSettings;$('#testSettings').onclick=testSettings;$('#importSettings').onclick=importSettings;$('#attachWorkspace').onclick=async()=>{if(!state.workspace.root)await chooseWorkspace();renderContextStrip();};$('#insertFile').onclick=pickDocuments;$('#runWork').onclick=()=>sendPrompt($('#workPrompt').value,'work');
  window.chp.chat.onDelta(({requestId,delta})=>{if(requestId!==state.currentRequestId)return;const msg=currentChat()?.messages.at(-1);if(msg?.role==='assistant'){msg.content+=delta;renderChat();}});window.chp.chat.onDone(({requestId})=>{if(requestId===state.currentRequestId)finishRequest();});window.chp.chat.onError(({requestId,message})=>{if(requestId===state.currentRequestId)finishRequest(message);});window.chp.chat.onTool((evt)=>{if(evt.requestId===state.currentRequestId)appendToolEvent(evt);});window.chp.chat.onUsage(({requestId,usage})=>{if(requestId===state.currentRequestId&&usage)$('#workStatus').title=JSON.stringify(usage);});
}
init().catch((e)=>{console.error(e);document.body.innerHTML=`<pre style="color:#fff;padding:30px">${escapeHtml(e.stack||e.message)}</pre>`;});
