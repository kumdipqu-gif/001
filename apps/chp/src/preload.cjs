const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chp', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (value) => ipcRenderer.invoke('config:set', value),
  },
  workspace: {
    choose: () => ipcRenderer.invoke('workspace:choose'),
    get: () => ipcRenderer.invoke('workspace:get'),
  },
  files: {
    list: (rel) => ipcRenderer.invoke('files:list', rel),
    read: (rel) => ipcRenderer.invoke('files:read', rel),
    write: (payload) => ipcRenderer.invoke('files:write', payload),
    search: (query) => ipcRenderer.invoke('files:search', query),
  },
  terminal: {
    run: (command) => ipcRenderer.invoke('terminal:run', command),
  },
  chat: {
    start: (payload) => ipcRenderer.send('chat:start', payload),
    cancel: (requestId) => ipcRenderer.invoke('chat:cancel', requestId),
    onDelta: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('chat:delta', listener);
      return () => ipcRenderer.removeListener('chat:delta', listener);
    },
    onDone: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('chat:done', listener);
      return () => ipcRenderer.removeListener('chat:done', listener);
    },
    onError: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('chat:error', listener);
      return () => ipcRenderer.removeListener('chat:error', listener);
    },
    getAll: () => ipcRenderer.invoke('chats:get'),
    saveAll: (chats) => ipcRenderer.invoke('chats:set', chats),
  },
  tasks: {
    get: () => ipcRenderer.invoke('tasks:get'),
    set: (tasks) => ipcRenderer.invoke('tasks:set', tasks),
  },
});
