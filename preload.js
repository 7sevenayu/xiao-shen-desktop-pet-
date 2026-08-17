const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  // 渲染进程诊断日志 -> 主进程 pet-log.txt
  log: (msg) => ipcRenderer.send('log', msg),
  // 主进程读取好的立绘 data URL
  getPetImage: () => ipcRenderer.invoke('get-pet-image'),
  // 配置
  getConfig: () => ipcRenderer.invoke('get-config'),
  // 桌面边界（渲染进程拖动钳制用）
  getBounds: () => ipcRenderer.invoke('get-bounds'),
  // 开机自启
  setAutoStart: (enable) => ipcRenderer.invoke('set-auto-start', enable),
  // 皮肤
  getSkins: () => ipcRenderer.invoke('get-skins'),
  setSkin: (id) => ipcRenderer.invoke('set-skin', id),
  importSkin: () => ipcRenderer.invoke('import-skin'),
  // 把拖入的 File 对象还原成真实磁盘路径
  getPathForFile: (file) => webUtils.getPathForFile(file),
  openDeepseek: () => ipcRenderer.invoke('open-deepseek'),
  launchDsh: () => ipcRenderer.invoke('launch-dsh'),
  // 打开任意网页（快捷入口）
  openWeb: (url) => ipcRenderer.invoke('open-web', url),
  // 网站快捷入口列表（一级常用 / 二级更多）
  getSites: () => ipcRenderer.invoke('get-sites'),
  setSites: (sites) => ipcRenderer.invoke('set-sites', sites),
  // 音乐控制：play-pause / next / prev（媒体键模拟）
  mediaControl: (action) => ipcRenderer.invoke('media-control', action),
  trashItems: (paths) => ipcRenderer.invoke('trash-items', paths),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('drag-move', { dx, dy }),
  dragEnd: () => ipcRenderer.send('drag-end'),
  // 打开剪贴板路径（文件夹/文件/网址）
  openClipboardPath: () => ipcRenderer.invoke('open-clipboard-path'),
  // 鼠标穿透开关（透明区域点击直达桌面）
  setMouseIgnore: (flag) => ipcRenderer.send('set-mouse-ignore', flag),
  // 光标屏幕位置（穿透轮询恢复用）
  getCursorPoint: () => ipcRenderer.invoke('get-cursor-point'),
  setTopmost: (flag) => ipcRenderer.invoke('set-topmost', flag),
  getTopmost: () => ipcRenderer.invoke('get-topmost'),
  // 菜单（窗口内方案）：打开/关闭时通知主进程切换焦点策略；接收失焦关闭通知
  menuOpened: () => ipcRenderer.send('menu-opened'),
  menuClosed: () => ipcRenderer.send('menu-closed'),
  onMenuDismiss: (cb) => ipcRenderer.on('menu-dismiss', () => cb()),
  // 隐藏桌宠（藏到托盘，不退出）
  hidePet: () => ipcRenderer.send('hide-pet'),
  quit: () => ipcRenderer.send('quit'),
});
