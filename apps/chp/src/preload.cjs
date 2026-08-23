const { contextBridge, ipcRenderer } = require('electron');
const listen=(channel,callback)=>{const listener=(_event,value)=>callback(value);ipcRenderer.on(channel,listener);return()=>ipcRenderer.removeListener(channel,listener)};
contextBridge.exposeInMainWorld('chp',{
  appInfo:()=>ipcRenderer.invoke('app:info'),
  config:{get:()=>ipcRenderer.invoke('config:get'),set:(v)=>ipcRenderer.invoke('config:set',v),test:(v)=>ipcRenderer.invoke('config:test',v),importFile:()=>ipcRenderer.invoke('config:import')},
  workspace:{choose:()=>ipcRenderer.invoke('workspace:choose'),get:()=>ipcRenderer.invoke('workspace:get'),list:()=>ipcRenderer.invoke('workspace:list'),switch:(id)=>ipcRenderer.invoke('workspace:switch',id),reveal:()=>ipcRenderer.invoke('workspace:reveal')},
  files:{list:(rel)=>ipcRenderer.invoke('files:list',rel),read:(rel)=>ipcRenderer.invoke('files:read',rel),pick:()=>ipcRenderer.invoke('files:pick'),write:(p)=>ipcRenderer.invoke('files:write',p),search:(q)=>ipcRenderer.invoke('files:search',q)},
  terminal:{run:(cmd)=>ipcRenderer.invoke('terminal:run',cmd)},
  pty:{start:(opts)=>ipcRenderer.invoke('pty:start',opts),write:(id,data)=>ipcRenderer.invoke('pty:write',id,data),resize:(id,c,r)=>ipcRenderer.invoke('pty:resize',id,c,r),kill:(id)=>ipcRenderer.invoke('pty:kill',id),list:()=>ipcRenderer.invoke('pty:list'),onData:(cb)=>listen('pty:data',cb),onExit:(cb)=>listen('pty:exit',cb)},
  index:{build:()=>ipcRenderer.invoke('index:build'),get:()=>ipcRenderer.invoke('index:get'),search:(q)=>ipcRenderer.invoke('index:search',q)},
  mcp:{servers:()=>ipcRenderer.invoke('mcp:servers'),save:(v)=>ipcRenderer.invoke('mcp:save',v),tools:(id)=>ipcRenderer.invoke('mcp:tools',id),call:(id,name,args)=>ipcRenderer.invoke('mcp:call',id,name,args),disconnect:(id)=>ipcRenderer.invoke('mcp:disconnect',id)},
  skills:{list:()=>ipcRenderer.invoke('skills:list'),get:(id)=>ipcRenderer.invoke('skills:get',id),save:(v)=>ipcRenderer.invoke('skills:save',v)},
  artifacts:{list:()=>ipcRenderer.invoke('artifacts:list'),read:(n)=>ipcRenderer.invoke('artifacts:read',n),create:(p)=>ipcRenderer.invoke('artifacts:create',p),reveal:(n)=>ipcRenderer.invoke('artifacts:reveal',n)},
  computer:{status:()=>ipcRenderer.invoke('computer:status'),enable:(v)=>ipcRenderer.invoke('computer:enable',v),capture:()=>ipcRenderer.invoke('computer:capture'),click:(p)=>ipcRenderer.invoke('computer:click',p),type:(t)=>ipcRenderer.invoke('computer:type',t),key:(k)=>ipcRenderer.invoke('computer:key',k),open:(u)=>ipcRenderer.invoke('computer:open',u)},
  chat:{start:(p)=>ipcRenderer.send('chat:start',p),cancel:(id)=>ipcRenderer.invoke('chat:cancel',id),runs:()=>ipcRenderer.invoke('chat:runs'),onDelta:(cb)=>listen('chat:delta',cb),onDone:(cb)=>listen('chat:done',cb),onError:(cb)=>listen('chat:error',cb),onTool:(cb)=>listen('chat:tool',cb),onUsage:(cb)=>listen('chat:usage',cb),getAll:()=>ipcRenderer.invoke('chats:get'),saveAll:(v)=>ipcRenderer.invoke('chats:set',v)},
  tasks:{get:()=>ipcRenderer.invoke('tasks:get'),set:(v)=>ipcRenderer.invoke('tasks:set',v)},
  state:{get:()=>ipcRenderer.invoke('state:get'),set:(v)=>ipcRenderer.invoke('state:set',v)},
});
