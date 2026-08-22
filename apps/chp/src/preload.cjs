const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('chp', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (value) => ipcRenderer.invoke('config:set', value),
    test: (value) => ipcRenderer.invoke('config:test', value),
    importFile: () => ipcRenderer.invoke('config:import'),
  },
  workspace: {
    choose: () => ipcRenderer.invoke('workspace:choose'),
    get: () => ipcRenderer.invoke('workspace:get'),
  },
  files: {
    list: (rel) => ipcRenderer.invoke('files:list', rel),
    read: (rel) => ipcRenderer.invoke('files:read', rel),
    pick: () => ipcRenderer.invoke('files:pick'),
    write: (payload) => ipcRenderer.invoke('files:write', payload),
    search: (query) => ipcRenderer.invoke('files:search', query),
  },
  terminal: { run: (command) => ipcRenderer.invoke('terminal:run', command) },
  artifacts: {
    list: () => ipcRenderer.invoke('artifacts:list'),
    read: (name) => ipcRenderer.invoke('artifacts:read', name),
    create: (payload) => ipcRenderer.invoke('artifacts:create', payload),
  },
  chat: {
    start: (payload) => ipcRenderer.send('chat:start', payload),
    cancel: (requestId) => ipcRenderer.invoke('chat:cancel', requestId),
    onDelta: (callback) => listen('chat:delta', callback),
    onDone: (callback) => listen('chat:done', callback),
    onError: (callback) => listen('chat:error', callback),
    onTool: (callback) => listen('chat:tool', callback),
    onUsage: (callback) => listen('chat:usage', callback),
    getAll: () => ipcRenderer.invoke('chats:get'),
    saveAll: (chats) => ipcRenderer.invoke('chats:set', chats),
  },
  tasks: {
    get: () => ipcRenderer.invoke('tasks:get'),
    set: (tasks) => ipcRenderer.invoke('tasks:set', tasks),
  },
});
