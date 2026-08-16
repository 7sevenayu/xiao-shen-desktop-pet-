const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ovAPI', {
  // 主进程通知：显示菜单（带光标位置/宠物范围/开关状态）
  onShowMenu: (cb) => ipcRenderer.on('show-menu', (_e, payload) => cb(payload)),
  // 点击了菜单项
  sendAction: (action) => ipcRenderer.send('menu-action', action),
  // 点击了菜单外任意处
  sendDismiss: () => ipcRenderer.send('menu-dismiss'),
});
