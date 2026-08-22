const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  chats: [],
  activeChatId: null,
  workspace: { root: '' },
  tasks: [],
  config: null,
  editorPath: '',
  currentRequestId: null,
};

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
const basename = (p='') => p.replace(/[\\/]+$/,'').split(/[\\/]/).pop() || '';
const escapeHtml = (s='') => s.replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function switchView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'files') refreshFiles();
  if (name === 'tasks') renderTasks();
}

function currentChat() { return state.chats.find((x) => x.id === state.activeChatId); }
function ensureChat() {
  let chat = currentChat();
  if (!chat) {
    chat = { id: uid(), title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    state.chats.unshift(chat);
    state.activeChatId = chat.id;
  }
  return chat;
}
async function saveChats() { await window.chp.chat.saveAll(state.chats); renderChatList(); }

function renderChatList() {
  const q = $('#sidebarSearch').value.trim().toLowerCase();
  $('#chatList').innerHTML = state.chats
    .filter((c) => !q || c.title.toLowerCase().includes(q))
    .slice(0, 30)
    .map((c) => `<div class="chat-item ${c.id === state.activeChatId ? 'active':''}" data-chat-id="${c.id}"><span class="dot"></span><span>${escapeHtml(c.title)}</span></div>`)
    .join('');
  $$('#chatList .chat-item').forEach((el) => el.onclick = () => { state.activeChatId = el.dataset.chatId; renderChat(); renderChatList(); });
}

function renderChat() {
  const chat = currentChat();
  $('#chatTitle').textContent = chat?.title || '新对话';
  const messages = chat?.messages || [];
  $('#emptyState').style.display = messages.length ? 'none' : 'block';
  $('#messages').querySelectorAll('.message').forEach((el) => el.remove());
  for (const m of messages) {
    const div = document.createElement('div');
    div.className = `message ${m.role}${m.error ? ' error':''}`;
    div.textContent = m.content;
    $('#messages').appendChild(div);
  }
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

async function sendPrompt(text) {
  const prompt = text.trim();
  if (!prompt || state.currentRequestId) return;
  const chat = ensureChat();
  if (chat.messages.length === 0) chat.title = prompt.slice(0, 28) + (prompt.length > 28 ? '…' : '');
  chat.messages.push({ role: 'user', content: prompt });
  chat.messages.push({ role: 'assistant', content: '' });
  chat.updatedAt = Date.now();
  state.currentRequestId = uid();
  $('#send').textContent = '■';
  $('#prompt').value = '';
  autoSizePrompt();
  renderChat();
  renderChatList();
  await saveChats();
  const payloadMessages = chat.messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
  window.chp.chat.start({ requestId: state.currentRequestId, messages: payloadMessages });
}

function finishRequest(errorMessage='') {
  const chat = currentChat();
  const msg = chat?.messages.at(-1);
  if (errorMessage && msg?.role === 'assistant') {
    msg.content = msg.content || `本地模型连接失败：${errorMessage}\n\n请在“设置”中确认本机模型服务已启动，并且地址使用 localhost / 127.0.0.1。`;
    msg.error = true;
  }
  state.currentRequestId = null;
  $('#send').textContent = '➤';
  if (chat) { chat.updatedAt = Date.now(); saveChats(); }
  renderChat();
}

function autoSizePrompt() {
  const el = $('#prompt');
  el.style.height = 'auto';
  el.style.height = `${Math.min(180, Math.max(48, el.scrollHeight))}px`;
}

async function chooseWorkspace() {
  const ws = await window.chp.workspace.choose();
  if (ws) { state.workspace = ws; updateWorkspaceUI(); await refreshFiles(); }
}
function updateWorkspaceUI() {
  const root = state.workspace.root || '';
  $('#workspaceName').textContent = root ? basename(root) : '选择项目文件夹';
  $('#workspacePath').textContent = root || '未选择';
  $('#inspectorWorkspace').textContent = root ? basename(root) : '—';
  $('#projectSummary').textContent = root ? `当前项目：${root}。文件、命令、任务与 AI 上下文均在本机处理。` : '选择一个本地项目文件夹开始工作。';
}

async function refreshFiles() {
  if (!state.workspace.root) return;
  try {
    const files = await window.chp.files.list('');
    $('#fileCount').textContent = files.length;
    $('#fileList').innerHTML = files.map((f) => `<div class="file-row ${f.type}" data-file="${encodeURIComponent(f.path)}" data-type="${f.type}">${f.type === 'dir' ? '▰' : '·'} ${escapeHtml(f.name)}</div>`).join('');
    $$('#fileList .file-row').forEach((el) => el.onclick = async () => {
      if (el.dataset.type !== 'file') return;
      const rel = decodeURIComponent(el.dataset.file);
      try {
        const result = await window.chp.files.read(rel);
        state.editorPath = result.path;
        $('#editorPath').textContent = result.path;
        $('#editor').value = result.content;
      } catch (e) { $('#editorPath').textContent = e.message; }
    });
  } catch (e) { $('#fileList').innerHTML = `<div class="search-row">${escapeHtml(e.message)}</div>`; }
}

async function searchFiles() {
  const q = $('#fileSearch').value.trim();
  if (!q) return;
  $('#searchResults').innerHTML = '<div class="search-row">搜索中…</div>';
  try {
    const results = await window.chp.files.search(q);
    $('#searchResults').innerHTML = results.map((r) => `<div class="search-row" data-file="${encodeURIComponent(r.path)}"><strong>${escapeHtml(r.path)}</strong>${r.preview ? `<small>${escapeHtml(r.preview)}</small>`:''}</div>`).join('') || '<div class="search-row">没有结果</div>';
    $$('#searchResults .search-row[data-file]').forEach((el) => el.onclick = async () => {
      const rel = decodeURIComponent(el.dataset.file);
      const result = await window.chp.files.read(rel);
      state.editorPath = result.path;
      $('#editorPath').textContent = result.path;
      $('#editor').value = result.content;
    });
  } catch (e) { $('#searchResults').innerHTML = `<div class="search-row">${escapeHtml(e.message)}</div>`; }
}

async function runCommand() {
  const command = $('#commandInput').value.trim();
  if (!command) return;
  $('#terminalOutput').textContent = `> ${command}\n\n运行中…`;
  try {
    const result = await window.chp.terminal.run(command);
    $('#terminalOutput').textContent = `> ${command}\n\n${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}`:''}\n\n[exit ${result.code}]`;
  } catch (e) { $('#terminalOutput').textContent = e.message; }
}

function renderTasks() {
  $('#taskCount').textContent = state.tasks.length;
  $('#runningCount').textContent = state.tasks.filter((t) => !t.done).length;
  $('#taskBoard').innerHTML = state.tasks.map((t) => `<div class="task-card ${t.done ? 'done':''}" data-task="${t.id}"><h3>${escapeHtml(t.title)}</h3><p>${escapeHtml(t.note || '本地任务')}</p><div class="task-actions"><button data-toggle>${t.done ? '恢复':'完成'}</button><button data-delete>删除</button></div></div>`).join('') || '<div class="task-card"><h3>还没有任务</h3><p>创建一个任务，它会保存到 chp/data/tasks.json。</p></div>';
  $$('#taskBoard .task-card[data-task]').forEach((card) => {
    card.querySelector('[data-toggle]').onclick = async () => { const t = state.tasks.find((x) => x.id === card.dataset.task); t.done = !t.done; await window.chp.tasks.set(state.tasks); renderTasks(); };
    card.querySelector('[data-delete]').onclick = async () => { state.tasks = state.tasks.filter((x) => x.id !== card.dataset.task); await window.chp.tasks.set(state.tasks); renderTasks(); };
  });
}

async function addTask() {
  const title = prompt('任务名称');
  if (!title?.trim()) return;
  state.tasks.unshift({ id: uid(), title: title.trim(), note: '', done: false, createdAt: Date.now() });
  await window.chp.tasks.set(state.tasks); renderTasks();
}

async function loadSettings() {
  state.config = await window.chp.config.get();
  $('#settingEndpoint').value = state.config.endpoint || '';
  $('#settingModel').value = state.config.model || '';
  $('#settingTemperature').value = state.config.temperature ?? 0.7;
  $('#settingSystem').value = state.config.systemPrompt || '';
  $('#modelName').textContent = state.config.model || '未配置本地模型';
  $('#endpointName').textContent = state.config.endpoint || 'localhost only';
  $('#inspectorModel').textContent = state.config.model || '—';
}
async function saveSettings() {
  $('#settingsMessage').textContent = '';
  try {
    state.config = await window.chp.config.set({
      endpoint: $('#settingEndpoint').value.trim(),
      model: $('#settingModel').value.trim(),
      temperature: Number($('#settingTemperature').value || 0.7),
      systemPrompt: $('#settingSystem').value,
    });
    $('#settingsMessage').textContent = '已保存。外网地址会被拒绝。';
    await loadSettings();
  } catch (e) { $('#settingsMessage').style.color = '#ff8d8d'; $('#settingsMessage').textContent = e.message; }
}

function quickAction(action) {
  const map = {
    scan: '请分析当前项目目录结构，指出关键模块、潜在风险和优先建议。',
    review: '请对当前项目进行代码审查，优先找真实 bug、并发问题、状态污染、错误处理和安全风险。',
    plan: '基于当前项目，生成一个可执行的开发计划，按优先级和依赖关系排列。',
    docs: '请根据当前项目结构，帮我整理一份清晰的项目说明与使用文档。',
  };
  switchView('chat');
  $('#prompt').value = map[action] || '';
  autoSizePrompt();
  $('#prompt').focus();
}

async function init() {
  state.workspace = await window.chp.workspace.get();
  state.chats = await window.chp.chat.getAll();
  state.tasks = await window.chp.tasks.get();
  if (state.chats[0]) state.activeChatId = state.chats[0].id;
  updateWorkspaceUI();
  renderChatList();
  renderChat();
  renderTasks();
  await loadSettings();
  await refreshFiles();

  $$('[data-view]').forEach((b) => b.onclick = () => switchView(b.dataset.view));
  $('#openSettings').onclick = () => switchView('settings');
  $('#newChat').onclick = async () => { state.activeChatId = null; ensureChat(); await saveChats(); renderChat(); };
  $('#chooseWorkspace').onclick = chooseWorkspace;
  $('#refreshProject').onclick = refreshFiles;
  $('#sidebarSearch').oninput = renderChatList;
  $('#prompt').oninput = autoSizePrompt;
  $('#prompt').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt($('#prompt').value); } };
  $('#send').onclick = () => state.currentRequestId ? window.chp.chat.cancel(state.currentRequestId) : sendPrompt($('#prompt').value);
  $('#clearChat').onclick = async () => { const chat = currentChat(); if (chat) { chat.messages = []; await saveChats(); renderChat(); } };
  $$('.suggestions button').forEach((b) => b.onclick = () => sendPrompt(b.dataset.prompt));
  $$('.quick-grid button').forEach((b) => b.onclick = () => quickAction(b.dataset.action));
  $('#fileSearchBtn').onclick = searchFiles;
  $('#fileSearch').onkeydown = (e) => { if (e.key === 'Enter') searchFiles(); };
  $('#saveFile').onclick = async () => { if (!state.editorPath) return; await window.chp.files.write({ rel: state.editorPath, content: $('#editor').value }); $('#editorPath').textContent = `${state.editorPath} · 已保存`; };
  $('#runCommand').onclick = runCommand;
  $('#commandInput').onkeydown = (e) => { if (e.key === 'Enter') runCommand(); };
  $('#addTask').onclick = addTask;
  $('#saveSettings').onclick = saveSettings;
  $('#attachWorkspace').onclick = () => { if (!state.workspace.root) return chooseWorkspace(); $('#prompt').value += `\n\n请结合当前项目 ${state.workspace.root} 进行分析。`; autoSizePrompt(); };
  $('#insertFile').onclick = () => switchView('files');

  window.chp.chat.onDelta(({ requestId, delta }) => {
    if (requestId !== state.currentRequestId) return;
    const chat = currentChat(); const msg = chat?.messages.at(-1); if (msg?.role === 'assistant') { msg.content += delta; renderChat(); }
  });
  window.chp.chat.onDone(({ requestId }) => { if (requestId === state.currentRequestId) finishRequest(); });
  window.chp.chat.onError(({ requestId, message }) => { if (requestId === state.currentRequestId) finishRequest(message); });
}

init().catch((e) => { console.error(e); document.body.innerHTML = `<pre style="color:#fff;padding:30px">${escapeHtml(e.stack || e.message)}</pre>`; });
