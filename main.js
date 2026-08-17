const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, screen, dialog, clipboard } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// ---------- 诊断日志 ----------
const LOG_FILE = path.join(__dirname, 'pet-log.txt');
const INDEX_URL = pathToFileURL(path.join(__dirname, 'index.html')).href;
const LOG_MAX_BYTES = 1024 * 1024; // 超过 1MB 自动轮转到 pet-log.old.txt，防止日志无限增长
function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      try { fs.renameSync(LOG_FILE, path.join(__dirname, 'pet-log.old.txt')); } catch (_) {}
    }
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (_) {}
  try { console.log('[pet]', msg); } catch (_) {}
}
log(`===== 启动 app dir = ${__dirname} =====`);

// 宠物立绘：启动时读成 data URL，避免 file:// 图片被 CSP 拦截 / 画布跨域污染
let petImageDataUrl = null;
try {
  const buf = fs.readFileSync(path.join(__dirname, 'assets', 'pet.jpg'));
  petImageDataUrl = 'data:image/jpeg;base64,' + buf.toString('base64');
  log(`pet.jpg 读取成功: ${buf.length} 字节 -> dataUrl ${petImageDataUrl.length} 字符`);
} catch (err) {
  log('pet.jpg 读取失败: ' + (err && err.stack ? err.stack : err));
  console.error('读取宠物图片失败:', err);
}

// ---------- 配置（皮肤 / 开机自启） ----------
const CONFIG_FILE = path.join(__dirname, 'pet-config.json');
const SKINS_DIR = path.join(__dirname, 'skins');
const MAX_SKIN_BYTES = 25 * 1024 * 1024;
const AUTOSTART_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTOSTART_NAME = 'DeepSeekPet';

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { return {}; }
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); } catch (e) { log('保存配置失败: ' + e); }
}
const config = loadConfig();

// ---------- 网站快捷入口（一级常用 / 二级更多，可自定义） ----------
const DEFAULT_SITES = {
  frequent: [
    { name: 'ChatGPT', url: 'https://chatgpt.com' },
    { name: '哔哩哔哩', url: 'https://www.bilibili.com' },
    { name: 'GitHub', url: 'https://github.com' },
    { name: '知乎', url: 'https://www.zhihu.com' },
  ],
  more: [
    { name: 'YouTube', url: 'https://www.youtube.com' },
    { name: '百度', url: 'https://www.baidu.com' },
    { name: '抖音', url: 'https://www.douyin.com' },
    { name: '微博', url: 'https://weibo.com' },
  ],
};

// 归一化网站列表：只保留 {name, url} 且 url 必须是 http(s)
function normalizeSites(raw) {
  const clean = (list) => Array.isArray(list)
    ? list
        .map((s) => (s && typeof s === 'object' ? { name: String(s.name || '').trim(), url: String(s.url || '').trim() } : null))
        .filter((s) => s && s.name && /^https?:\/\//i.test(s.url))
    : [];
  const out = { frequent: clean(raw && raw.frequent), more: clean(raw && raw.more) };
  if (!out.frequent.length && !out.more.length) return JSON.parse(JSON.stringify(DEFAULT_SITES));
  return out;
}
if (!config.sites) config.sites = DEFAULT_SITES;
config.sites = normalizeSites(config.sites);

// ---------- 开机自启（注册表 HKCU\...\Run） ----------
function regRun(args) {
  return new Promise((resolve) => {
    try {
      const child = spawn('reg.exe', args, { stdio: 'ignore', windowsHide: true });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    } catch (_) { resolve(false); }
  });
}

function getAutoStart() {
  return new Promise((resolve) => {
    try {
      const child = spawn('reg.exe', ['query', AUTOSTART_KEY, '/v', AUTOSTART_NAME], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => { out += String(d); });
      child.on('error', () => resolve(null)); // 查询本身失败（reg 缺失/管道受限）→ null，调用方不做同步
      child.on('close', (code) => resolve(code === 0 && out.includes(AUTOSTART_NAME)));
    } catch (_) { resolve(null); }
  });
}

async function setAutoStart(enable) {
  let ok = false;
  if (enable) {
    const value = `"${process.execPath}" "${path.resolve(__dirname)}"`;
    ok = await regRun(['add', AUTOSTART_KEY, '/v', AUTOSTART_NAME, '/t', 'REG_SZ', '/d', value, '/f']);
  } else {
    ok = await regRun(['delete', AUTOSTART_KEY, '/v', AUTOSTART_NAME, '/f']);
  }
  if (!ok) return null; // 写入/删除失败：不把失败当“已关闭”，避免污染配置
  return getAutoStart();
}

// ---------- 皮肤（导入的 PNG 立绘） ----------
function getImportedSkins() {
  const list = [];
  try {
    if (!fs.existsSync(SKINS_DIR)) return list;
    for (const f of fs.readdirSync(SKINS_DIR)) {
      if (!/\.(png|jpe?g|webp|gif)$/i.test(f)) continue;
      try {
        const skinPath = path.join(SKINS_DIR, f);
        if (fs.statSync(skinPath).size > MAX_SKIN_BYTES) {
          log('跳过过大的皮肤: ' + f);
          continue;
        }
        const buf = fs.readFileSync(skinPath);
        const ext = path.extname(f).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
        // 布局描述（多行动画/镜像/每套帧时长）：<皮肤名>.layout.json
        let layout = null;
        try {
          const lp = path.join(SKINS_DIR, f.replace(/\.[^.]+$/, '') + '.layout.json');
          layout = JSON.parse(fs.readFileSync(lp, 'utf8'));
        } catch (_) {}
        list.push({
          id: 'imported:' + f,
          name: f.replace(/\.[^.]+$/, ''),
          dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64'),
          layout,
        });
      } catch (e) { log('读取皮肤失败 ' + f + ': ' + e); }
    }
  } catch (e) { log('扫描皮肤目录失败: ' + e); }
  return list;
}

const PET_W = 560; // 加宽：左侧是宠物，右侧留出菜单区（透明区点击穿透）
const PET_H = 330;

let win = null;
let tray = null;
let isQuitting = false;
let topmostOn = true; // 置顶开关状态（主进程镜像，托盘显示用）
let topmostWatcher = null; // 置顶守护子进程（置顶关期间每秒把宠物贴回壁纸层之上）
let watcherRestarts = 0; // 守护连续异常退出计数（自动重启保护）

// Window-drag state (cursor-follow based, all coordinates from screen API for consistency)
let drag = null;

function openDeepseek() {
  shell.openExternal('https://chat.deepseek.com/');
}

// 置顶原生兜底（Windows）：Electron 34 的 bug（#45024）——focusable:false 的窗口
// setAlwaysOnTop(false) 要等窗口被点击激活才生效，而本窗口永不激活，导致置顶关不掉。
// 用 user32 SetWindowPos 直接改原生窗口样式（不抢键盘焦点、不改变位置尺寸）：
//   开 → HWND_TOPMOST（悬浮在所有窗口之上）
//   关 → HWND_BOTTOM（先落到底部；随后由置顶守护进程每秒贴回壁纸层之上）
// 历史：WorkerW 挂靠方案在用户机器执行失败（14:44 三次 native=false，动态壁纸 Wallpaper
//      Engine 接管了桌面窗口结构）；HWND_BOTTOM 方案实测可见（13:32/13:36/13:45）。
function setTopmostNative(enable) {
  return new Promise((resolve) => {
    try {
      const handle = win.getNativeWindowHandle();
      const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : handle.readUInt32LE(0).toString();
      const ps = [
        '$h=[IntPtr]::new([Int64]' + hwnd + ')',
        '$sig=\'[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);\'',
        '$tp=Add-Type -MemberDefinition $sig -Name WinPos -Namespace NP -PassThru',
      ];
      if (enable) {
        // 开 → HWND_TOPMOST（悬浮在最上）
        ps.push('$ok=$tp::SetWindowPos($h,[IntPtr]::new([Int64]-1),0,0,0,0,19)');
      } else {
        // 关 → 直接用 EnumWindows 定位「最高的可见壁纸层窗口」并贴到它之下（壁纸之上、窗口之下）。
        // 注意：GetWindow([IntPtr]::Zero, FIRST/LAST) 在 Win11 恒返回 NULL（旧实现的 HWND_BOTTOM
        // 会把宠物钉到壁纸之下 → 桌宠“消失”），这里用 EnumWindows 遍历顶层窗口。
        ps.push(
          '$sig2=@\'',
          'using System;',
          'using System.Runtime.InteropServices;',
          'using System.Text;',
          'public class DesktopPin {',
          '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);',
          '  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
          '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
          '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
          '  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
          '  public static IntPtr FindWall() {',
          '    IntPtr wall = IntPtr.Zero;',
          '    EnumWindows((h, p) => {',
          '      if (wall != IntPtr.Zero) return true;',
          '      var sb = new StringBuilder(256); GetClassName(h, sb, 256);',
          '      var cls = sb.ToString();',
          '      if (cls == "Progman" || cls == "WorkerW") { if (IsWindowVisible(h)) wall = h; return true; }',
          '      uint pid = 0; GetWindowThreadProcessId(h, out pid);',
          '      if (pid != 0) { try { var pr = System.Diagnostics.Process.GetProcessById((int)pid); if (pr != null && pr.ProcessName.StartsWith("wallpaper", StringComparison.OrdinalIgnoreCase) && IsWindowVisible(h)) wall = h; } catch {} }',
          '      return true;',
          '    }, IntPtr.Zero);',
          '    return wall;',
          '  }',
          '}',
          "'@",
          '$null = Add-Type -TypeDefinition $sig2',
          '$wall = [DesktopPin]::FindWall()',
          '"wall=" + $wall',
          'if ($wall -ne [IntPtr]::Zero) {',
          '  $ok = $tp::SetWindowPos($h, $wall, 0, 0, 0, 0, 19)',
          '} else {',
          '  $ok = $tp::SetWindowPos($h, [IntPtr]::new([Int64]1), 0, 0, 0, 0, 19)',
          '}',
        );
      }
      ps.push('if($ok){exit 0}else{exit 1}');
      // 注意必须用换行连接：$sig2=@'...'@ here-string 要求 `@'` 在行尾、`'@` 在行首
      const script = ps.join('\n');
      // 不设 stdio:'ignore'：捕获 stdout/stderr，失败或诊断信息写进日志
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 }, (err, _stdout, stderr) => {
        if (err) {
          const detail = stderr ? ' stderr=' + String(stderr).trim().slice(0, 200) : '';
          log('原生置顶调用失败:' + detail + ' | ' + ((err && err.message) || err));
        } else if (!enable && _stdout) {
          const diag = String(_stdout).trim().split('\n').map((s) => s.trim()).filter(Boolean).join(' | ');
          if (diag) log('置顶关 贴壁纸层: ' + diag);
        }
        resolve(!err);
      });
    } catch (e) {
      log('原生置顶异常: ' + e);
      resolve(false);
    }
  });
}

// ---------- 置顶守护（Windows）----------
// Wallpaper Engine 会在窗口关闭/场景切换时重排 z 序，把壁纸层窗口插到宠物之上 → 宠物被盖住。
// 守护进程每秒把宠物重新贴到「壁纸层窗口之后」：壁纸之上、所有应用窗口之下。
// 壁纸层识别：窗口类 Progman/WorkerW，或进程名 wallpaper*（WE 渲染进程 wallpaper64/32）。
function killTopmostWatcher() {
  if (topmostWatcher) {
    try { topmostWatcher.kill(); } catch (_) {}
    topmostWatcher = null;
  }
}

function startTopmostWatcher() {
  killTopmostWatcher();
  if (!win || process.platform !== 'win32') return;
  try {
    const handle = win.getNativeWindowHandle();
    const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : handle.readUInt32LE(0).toString();
    const script = [
      "$sig=@'",
      'using System;',
      'using System.Collections.Generic;',
      'using System.Runtime.InteropServices;',
      'using System.Text;',
      'public class PetWatch {',
      '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int X, int Y, int cx, int cy, uint f);',
      '  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);',
      '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
      '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);',
      '  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
      '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
      '  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
      '  public static List<IntPtr> TopLevel() { var l = new List<IntPtr>(); EnumWindows((h, p) => { l.Add(h); return true; }, IntPtr.Zero); return l; }',
      '  // 壁纸层判定：可见的 Progman/WorkerW，或进程名 wallpaper*（Wallpaper Engine）的可见窗口',
      '  public static bool IsWallpaper(IntPtr h) {',
      '    var sb = new StringBuilder(256); GetClassName(h, sb, 256);',
      '    var cls = sb.ToString();',
      '    if (cls == "Progman" || cls == "WorkerW") return IsWindowVisible(h);',
      '    uint p = 0; GetWindowThreadProcessId(h, out p);',
      '    if (p != 0) { try { var pr = System.Diagnostics.Process.GetProcessById((int)p); if (pr != null && pr.ProcessName.StartsWith("wallpaper", StringComparison.OrdinalIgnoreCase)) return IsWindowVisible(h); } catch {} }',
      '    return false;',
      '  }',
      '}',
      "'@",
      '$null = Add-Type -TypeDefinition $sig',
      // hwnd 必须内联进脚本：PowerShell 的 -Command 会把尾部参数拼进命令文本，$args[0] 恒为空，
      // 曾导致 IsWindow(0)=false → 守护启动即退出（pet-log 里“置顶守护意外退出”连刷的根因）
      '$pet = [IntPtr]::new([Int64]' + hwnd + ')',
      'while ([PetWatch]::IsWindow($pet)) {',
      // 用 EnumWindows 找「最高的可见壁纸层窗口」：GetWindow(Zero, FIRST/LAST) 在 Win11 上
      // 恒返回 NULL，旧实现永远落到 HWND_BOTTOM，把宠物钉到壁纸之下 → 桌宠“消失”的根因
      '  $wall = [IntPtr]::Zero',
      '  foreach ($h in [PetWatch]::TopLevel()) { if ([PetWatch]::IsWallpaper($h)) { $wall = $h; break } }',
      '  if ($wall -ne [IntPtr]::Zero) {',
      '    $null = [PetWatch]::SetWindowPos($pet, $wall, 0, 0, 0, 0, 19)',
      '  } else {',
      '    $null = [PetWatch]::SetWindowPos($pet, [IntPtr]::new([Int64]1), 0, 0, 0, 0, 19)',
      '  }',
      '  Start-Sleep -Seconds 1',
      '}',
    ].join('\n');
    topmostWatcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
    const child = topmostWatcher;
    topmostWatcher.on('exit', (code) => {
      // 只有“当前守护就是我”时才处理：被 killTopmostWatcher 主动终止或已被新守护接管的
      // 过期退出事件直接忽略，避免误清空新守护引用 / 重复拉起第二只守护（竞态 bug）
      if (topmostWatcher !== child) return;
      topmostWatcher = null;
      // 守护意外退出（被杀软误杀/崩溃/脚本错误等）：置顶仍为关时 3 秒后自动重启，最多连续 3 次
      if (!topmostOn && !isQuitting && win) {
        if (watcherRestarts >= 3) {
          log('置顶守护连续退出超过3次，停止自动重启（重新切换置顶可恢复）');
          return;
        }
        watcherRestarts++;
        log('置顶守护意外退出(code=' + code + ')，3秒后自动重启（第' + watcherRestarts + '次）');
        setTimeout(() => {
          if (!topmostOn && !isQuitting && win) startTopmostWatcher();
        }, 3000);
      }
    });
    topmostWatcher.on('error', (err) => { log('置顶守护启动失败: ' + err); topmostWatcher = null; });
    topmostWatcher.unref();
    // 存活超过 5 秒视为健康，清零连续退出计数
    setTimeout(() => { if (topmostWatcher === child) watcherRestarts = 0; }, 5000);
    log('置顶守护启动（每秒贴回壁纸层之上, pid=' + (child.pid || '?') + '）');
  } catch (e) {
    log('置顶守护启动失败: ' + e);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: PET_W,
    height: PET_H,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false, // 永不夺取键盘焦点，回车/按键始终属于用户当前应用
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  // 关闭后台节流：被菜单捕获层盖住时，宠物动画照常播放
  win.webContents.setBackgroundThrottling(false);
  // 本窗口只承载本地 UI。若允许导航到远端页面，preload 暴露的桌宠能力会随页面保留。
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== INDEX_URL) {
      event.preventDefault();
      log('已阻止窗口导航: ' + url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    log('已阻止窗口打开新页面: ' + url);
    return { action: 'deny' };
  });
  win.loadFile('index.html');

  // 收集渲染进程的报错信息到日志
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    log(`[renderer console ${level}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('preload-error', (_e, p, error) => {
    log(`[preload-error] ${p}: ${error}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log(`[did-fail-load] ${code} ${desc} ${url}`);
  });
  let rendererCrashes = 0; // 60 秒内渲染进程崩溃计数（自动恢复保护）
  win.webContents.on('render-process-gone', (_e, details) => {
    log(`[render-process-gone] ${JSON.stringify(details)}`);
    // 渲染进程崩溃/被杀后自动恢复，避免桌宠变成“死窗”；1 分钟内最多自动恢复 3 次防死循环
    if (isQuitting) return;
    if (++rendererCrashes > 3) {
      log('渲染进程 1 分钟内崩溃超过 3 次，停止自动恢复');
      return;
    }
    setTimeout(() => {
      rendererCrashes = Math.max(0, rendererCrashes - 1);
      if (isQuitting || !win) return;
      log('渲染进程自动恢复：重新加载页面');
      try { win.webContents.reload(); } catch (e) { log('渲染进程自动恢复失败: ' + e); }
    }, 800);
  });
  setInterval(() => { rendererCrashes = 0; }, 60000);

  const { workArea } = screen.getPrimaryDisplay();
  win.setPosition(
    workArea.x + workArea.width - PET_W - 60,
    workArea.y + workArea.height - PET_H - 40
  );

  win.on('close', (e) => {
    if (!isQuitting) {
      // 关闭窗口时隐藏到托盘而不是退出
      e.preventDefault();
      win.hide();
    }
  });
  win.on('blur', () => onMenuWindowBlur());
  win.on('closed', () => {
    win = null;
    if (!isQuitting) {
      // 窗口被意外销毁（如 explorer 重启等极端情况）：自动重建，回到置顶悬浮
      log('窗口意外销毁，自动重建');
      topmostOn = true;
      createWindow();
    }
  });
}

// 显示宠物：先 restore（Win+D 会把窗口最小化，show() 无法解除，必须 restore）
// 置顶开启时抬到最前；置顶关闭（桌面层）时保持原层级，不抬升
function showPet() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  try { win.webContents.setBackgroundThrottling(false); } catch (_) {} // 恢复动画
  if (topmostOn) win.moveTop();
}

// 隐藏宠物：藏到托盘不退出（动画同时暂停省 CPU），托盘「显示桌宠」/ 双击托盘图标唤回
function hidePet() {
  if (!win) return;
  try { win.webContents.setBackgroundThrottling(true); } catch (_) {} // 隐藏时暂停动画
  win.hide();
  log('桌宠已隐藏（托盘可唤回）');
}

ipcMain.on('hide-pet', () => hidePet());

// ---------- 音乐控制（媒体键模拟）----------
// VK_MEDIA_PLAY_PAUSE=0xB3 / VK_MEDIA_NEXT_TRACK=0xB0 / VK_MEDIA_PREV_TRACK=0xB1
// 系统会把媒体键路由到当前媒体会话，Spotify/网易云/QQ音乐/foobar 等播放器普遍响应。
function sendMediaKey(vk) {
  return new Promise((resolve) => {
    try {
      const hex = vk.toString(16);
      const ps = [
        '$sig=\'[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);\'',
        '$t=Add-Type -MemberDefinition $sig -Name MK -Namespace NM -PassThru',
        '$t::keybd_event(0x' + hex + ',0,0,[UIntPtr]::Zero)',
        '$t::keybd_event(0x' + hex + ',0,2,[UIntPtr]::Zero)',
        'exit 0',
      ].join('; ');
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 10000 }, (err) => resolve(!err));
    } catch (e) {
      resolve(false);
    }
  });
}

ipcMain.handle('media-control', async (event, action) => {
  if (!isTrustedSender(event)) return false;
  const keys = { 'play-pause': 0xB3, 'next': 0xB0, 'prev': 0xB1 };
  const vk = keys[action];
  if (!vk) return false;
  const ok = await sendMediaKey(vk);
  log('音乐控制 -> ' + action + ' (ok=' + ok + ')');
  return ok;
});

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '显示桌宠', click: showPet },
    { label: '🙈 隐藏桌宠', click: hidePet },
    { type: 'separator' },
    { label: '🌐 打开 DeepSeek 网页版', click: () => openDeepseek() },
    { type: 'separator' },
    { label: '🎵 播放/暂停', click: () => { sendMediaKey(0xB3); } },
    { label: '⏮ 上一首', click: () => { sendMediaKey(0xB1); } },
    { label: '⏭ 下一首', click: () => { sendMediaKey(0xB0); } },
    { type: 'separator' },
    {
      label: '🚀 开机自启', type: 'checkbox', checked: !!config.autoStart,
      click: async (item) => {
        const ok = await setAutoStart(!!item.checked);
        if (typeof ok === 'boolean') { config.autoStart = ok; saveConfig(config); }
        if (tray) tray.setContextMenu(buildTrayMenu());
        log('开机自启 -> ' + (ok === null ? '操作失败' : ok ? '开' : '关'));
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]);
}

function createTray() {
  const icon = nativeImage
    .createFromPath(path.join(__dirname, 'assets', 'pet.jpg'))
    .resize({ width: 32, height: 32 });
  tray = new Tray(icon);
  tray.setToolTip('DeepSeek 桌宠 · 小深');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', showPet);
}

// ---------- IPC ----------
// 仅接受主窗口本地页面的消息。即便未来误加了第二个窗口，也不能调用桌宠的本机能力。
function isTrustedSender(event) {
  return !!win && event.sender === win.webContents && event.senderFrame && event.senderFrame.url === INDEX_URL;
}

ipcMain.on('log', (event, msg) => {
  if (isTrustedSender(event)) log('[renderer] ' + String(msg).slice(0, 4000));
});

ipcMain.handle('get-pet-image', () => petImageDataUrl);

ipcMain.handle('get-config', () => config);

ipcMain.handle('get-bounds', () => desktopBounds);

ipcMain.handle('set-skin', (event, skinId) => {
  if (!isTrustedSender(event)) return false;
  config.skin = String(skinId);
  saveConfig(config);
  log('皮肤切换 -> ' + config.skin);
  return true;
});

ipcMain.handle('get-skins', () => ({
  base: petImageDataUrl,
  imported: getImportedSkins(),
  current: config.skin || 'classic',
}));

ipcMain.handle('set-auto-start', async (event, enable) => {
  if (!isTrustedSender(event)) return null;
  const ok = await setAutoStart(!!enable);
  if (typeof ok === 'boolean') { config.autoStart = ok; saveConfig(config); }
  if (tray) tray.setContextMenu(buildTrayMenu());
  log('开机自启 -> ' + (ok === null ? '操作失败' : ok ? '开' : '关'));
  return ok;
});

ipcMain.handle('import-skin', async (event) => {
  if (!isTrustedSender(event)) return null;
  const res = await dialog.showOpenDialog(win, {
    title: '选择立绘图片（PNG 透明图效果最佳）',
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
  const src = res.filePaths[0];
  try {
    const sourceSize = fs.statSync(src).size;
    if (sourceSize > MAX_SKIN_BYTES) {
      log('导入皮肤失败：文件过大 ' + sourceSize + 'B');
      return null;
    }
    if (!fs.existsSync(SKINS_DIR)) fs.mkdirSync(SKINS_DIR, { recursive: true });
    const parsed = path.parse(path.basename(src));
    let name = parsed.base;
    let serial = 2;
    while (fs.existsSync(path.join(SKINS_DIR, name)) && path.resolve(src) !== path.resolve(path.join(SKINS_DIR, name))) {
      name = parsed.name + ' (' + serial++ + ')' + parsed.ext;
    }
    const destination = path.join(SKINS_DIR, name);
    if (path.resolve(src) !== path.resolve(destination)) fs.copyFileSync(src, destination);
    const buf = fs.readFileSync(destination);
    const ext = path.extname(name).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    const skin = { id: 'imported:' + name, name: name.replace(/\.[^.]+$/, ''), dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') };
    // 同名布局描述（多行动画/镜像/帧时长）：<皮肤名>.layout.json，与 getImportedSkins 保持一致
    try {
      const lp = path.join(SKINS_DIR, name.replace(/\.[^.]+$/, '') + '.layout.json');
      if (fs.existsSync(lp)) skin.layout = JSON.parse(fs.readFileSync(lp, 'utf8'));
    } catch (_) {}
    log('导入皮肤成功: ' + name);
    return skin;
  } catch (e) {
    log('导入皮肤失败: ' + e);
    return null;
  }
});

ipcMain.handle('open-deepseek', (event) => {
  if (!isTrustedSender(event)) return false;
  openDeepseek();
  return true;
});

// 打开任意网页（右键菜单快捷入口），只放行 http/https
ipcMain.handle('open-web', (event, url) => {
  if (!isTrustedSender(event)) return false;
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return false;
  try { shell.openExternal(u); return true; } catch (e) { log('打开网页失败: ' + u + ' -> ' + e); return false; }
});

// 网站列表读写（一级常用 / 二级更多）
ipcMain.handle('get-sites', () => config.sites);

ipcMain.handle('set-sites', (event, sites) => {
  if (!isTrustedSender(event)) return config.sites;
  config.sites = normalizeSites(sites);
  saveConfig(config);
  log('网站列表已更新: frequent=' + config.sites.frequent.length + ' more=' + config.sites.more.length);
  return config.sites;
});

ipcMain.handle('trash-items', async (event, paths) => {
  if (!isTrustedSender(event) || !Array.isArray(paths)) return [];
  const results = [];
  for (const p of paths.slice(0, 100)) {
    try {
      const itemPath = path.resolve(String(p));
      if (!path.isAbsolute(String(p)) || !fs.existsSync(itemPath)) throw new Error('无效的文件路径');
      await shell.trashItem(itemPath);
      results.push({ ok: true, path: itemPath });
    } catch (err) {
      results.push({ ok: false, path: p, error: String((err && err.message) || err) });
    }
  }
  return results;
});

// 拖动：渲染进程发「相对起点的 client 位移」+ 主进程按起点窗口位置累加，
// client 坐标是 CSS 像素（DIP），与 getPosition 同一坐标系，彻底避免 DPI 漂移
let dragMoveCount = 0;
let dragPausedWatcher = false; // 拖动期间是否暂停了置顶守护
ipcMain.on('drag-start', (event) => {
  if (!isTrustedSender(event)) return;
  if (!win) return;
  // 拖动前先把窗口尺寸钉回标准值（防御：某种原因曾把它放大）
  const [w, h] = win.getSize();
  win.setSize(PET_W, PET_H);
  const [wx, wy] = win.getPosition();
  drag = { wx, wy };
  dragMoveCount = 0;
  // 拖动期间暂停置顶守护：守护每秒对窗口做一次 SetWindowPos（改 z 序），与拖动的
  // 窗口移动并发会打断指针捕获/拖动（用户报告：反复切换置顶后无法拖动）
  dragPausedWatcher = !!topmostWatcher;
  if (topmostWatcher) killTopmostWatcher();
  // 诊断：只在异常时打日志（尺寸/缩放不是标准值），正常拖动不再刷屏
  let zoom = '?';
  try { zoom = String(win.webContents.getZoomFactor()); } catch (_) {}
  if (w !== PET_W || h !== PET_H || zoom !== '1') {
    log('[drag] start 异常尺寸 win=(' + wx + ',' + wy + ') size=' + JSON.stringify([w, h]) + ' zoom=' + zoom + ' -> 已钉回 ' + PET_W + 'x' + PET_H);
  }
});

ipcMain.on('drag-move', (event, p) => {
  if (!isTrustedSender(event)) return;
  if (!win || !drag || !p || p.dx == null || p.dy == null) return;
  const { x: nx, y: ny } = clampPetPosition(Math.round(drag.wx + p.dx), Math.round(drag.wy + p.dy));
  // setBounds 同时锁定位置与尺寸：无论什么原因导致的窗口变大都会被立即纠正
  win.setBounds({ x: nx, y: ny, width: PET_W, height: PET_H });
  if (++dragMoveCount % 15 === 0) {
    log('[drag] move dx=' + Math.round(p.dx) + ' dy=' + Math.round(p.dy) + ' -> win=(' + nx + ',' + ny + ')');
  }
});

ipcMain.on('drag-end', (event) => {
  if (!isTrustedSender(event)) return;
  drag = null;
  // 拖动结束：若之前暂停了守护且置顶仍为关，恢复守护把宠物贴回桌面层
  if (dragPausedWatcher) {
    dragPausedWatcher = false;
    if (!topmostOn && !isQuitting && win) startTopmostWatcher();
  }
});

// 菜单（窗口内菜单方案）：打开菜单时窗口临时可聚焦，点菜单外任意处 → 窗口失焦 → 关闭菜单。
// 没有全屏覆盖窗口，浏览器永远不会被遮挡，网页视频不会暂停
let menuOpenInMain = false;

ipcMain.on('menu-opened', (event) => {
  if (!isTrustedSender(event)) return;
  menuOpenInMain = true;
  if (!win) return;
  win.setFocusable(true);  // 临时可聚焦，让“点外面”能触发失焦
  win.focus();
  log('菜单打开（窗口已临时可聚焦）');
});

ipcMain.on('menu-closed', (event) => {
  if (!isTrustedSender(event)) return;
  if (menuOpenInMain) log('菜单关闭');
  menuOpenInMain = false;
  if (win) win.setFocusable(false); // 恢复“永不抢焦点”
});

// 菜单打开期间窗口失焦 = 点了菜单外 → 通知宠物关闭菜单
function onMenuWindowBlur() {
  if (menuOpenInMain && win) {
    log('窗口失焦，关闭菜单');
    menuOpenInMain = false;
    win.setFocusable(false);
    win.webContents.send('menu-dismiss');
  }
}

// 打开剪贴板路径：文件夹直接打开，文件在资源管理器中定位，网址用浏览器打开
ipcMain.handle('open-clipboard-path', async (event) => {
  if (!isTrustedSender(event)) return 'invalid';
  const text = (clipboard.readText() || '').trim();
  if (!text) return 'empty';
  let p = text.replace(/^["']|["']$/g, '');
  if (/^https?:\/\//i.test(p)) {
    shell.openExternal(p);
    return 'url';
  }
  try {
    const stats = await fs.promises.stat(p);
    if (stats.isDirectory()) {
      shell.openPath(p);
      return 'folder';
    }
    shell.showItemInFolder(p);
    return 'file';
  } catch (e) {
    log('打开剪贴板路径失败: ' + p + ' -> ' + e);
    return 'invalid';
  }
});

// 鼠标穿透：透明区域点击直达桌面，只有宠物身体/面板可点（forward 保持 mousemove 可达，以便恢复）
ipcMain.on('set-mouse-ignore', (event, flag) => {
  if (!isTrustedSender(event)) return;
  if (win) win.setIgnoreMouseEvents(!!flag, { forward: true });
});

// 光标屏幕位置：渲染进程在穿透状态下轮询此接口自行恢复可点击（forward 转发失效的兜底）
ipcMain.handle('get-cursor-point', () => {
  try { const p = screen.getCursorScreenPoint(); return { x: p.x, y: p.y }; } catch (_) { return null; }
});

// 置顶切换串行化：快速反复切换时，多个 setTopmostFromMain 的异步原生调用会交错，
// 导致 topmostOn 与窗口真实层级/守护状态脱节。用队列让每次切换完整跑完再处理下一次。
let topmostQueue = Promise.resolve();
function setTopmostFromMain(enable) {
  const task = async () => {
    if (!win) return false;
    topmostOn = enable;
    // 先走 Electron API（更新内部状态；mac/Linux 直接生效）
    win.setAlwaysOnTop(enable, 'floating');
    if (enable) win.moveTop(); // 开启时立即抬升，保证回到最前
    // Windows 再用原生调用兜底（修复 #45024）：开→TOPMOST；关→落底桌面层（HWND_BOTTOM）
    let nativeOk = true;
    if (process.platform === 'win32') {
      nativeOk = await setTopmostNative(enable);
      if (enable) {
        killTopmostWatcher(); // 悬浮模式不需要守护
      } else {
        startTopmostWatcher(); // 即使一次性调用失败，守护也能在1秒内把宠物贴回壁纸层
      }
    }
    log('置顶开关 -> ' + (enable ? '开' : '关') + ' (native=' + nativeOk + ')');
    return topmostOn;
  };
  const run = topmostQueue.then(task, task);
  topmostQueue = run.then(() => {}, () => {});
  return run;
}

ipcMain.handle('set-topmost', async (event, flag) => {
  if (!isTrustedSender(event)) return false;
  await setTopmostFromMain(!!flag);
  // 返回主进程镜像状态而非 win.isAlwaysOnTop()：
  // Electron #45024 下 focusable:false 窗口的内部标志可能滞后于真实层级，导致 UI 状态与实际不符
  return topmostOn;
});

ipcMain.handle('get-topmost', () => topmostOn);

ipcMain.on('quit', (event) => {
  if (!isTrustedSender(event)) return;
  isQuitting = true;
  app.quit();
});

// ---------- App lifecycle ----------
// 单实例锁：避免重复启动产生多只宠物互相干扰（拖动错乱、日志串扰）
const clampNum = (v, a, b) => Math.max(a, Math.min(b, v));
let desktopBounds = { x: 0, y: 0, right: 1920, bottom: 1080 };      // 工作区（不含任务栏）

// 不把多显示器当成一个大矩形：错位屏幕之间可能是不可见的空洞。
function clampPetPosition(x, y) {
  let area;
  try {
    area = screen.getDisplayNearestPoint({ x: x + Math.floor(PET_W / 2), y: y + Math.floor(PET_H / 2) }).workArea;
  } catch (_) {
    area = { x: desktopBounds.x, y: desktopBounds.y, width: desktopBounds.right - desktopBounds.x, height: desktopBounds.bottom - desktopBounds.y };
  }
  return {
    x: clampNum(x, area.x, Math.max(area.x, area.x + area.width - PET_W)),
    y: clampNum(y, area.y - 60, Math.max(area.y - 60, area.y + area.height - PET_H + 44)),
  };
}

function computeDesktopBounds() {
  try {
    const ds = screen.getAllDisplays();
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const d of ds) {
      const b = d.workArea;
      x1 = Math.min(x1, b.x);
      y1 = Math.min(y1, b.y);
      x2 = Math.max(x2, b.x + b.width);
      y2 = Math.max(y2, b.y + b.height);
    }
    if (x1 !== Infinity) desktopBounds = { x: x1, y: y1, right: x2, bottom: y2 };
    log('桌面边界: (' + desktopBounds.x + ',' + desktopBounds.y + ') ~ (' + desktopBounds.right + ',' + desktopBounds.bottom + ')');
  } catch (e) {
    log('computeDesktopBounds 失败: ' + e);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log('检测到已有桌宠在运行，本实例退出');
  // 必须用 app.exit(0)：app.quit() 在 ready 之前调用不会真正终止进程，
  // 实测会在后台留下一个无窗口无托盘的幽灵进程（白占内存、干扰排查）
  app.exit(0);
} else {
  app.on('second-instance', () => {
    log('重复启动被拦截，聚焦现有桌宠窗口');
    showPet();
  });

  app.whenReady().then(async () => {
    log('app ready');
    computeDesktopBounds();

    // 开机自启：默认开启（首次运行自动写入启动项），之后每次启动保持同步
    if (typeof config.autoStart !== 'boolean') {
      config.autoStart = true;
      saveConfig(config);
    }
    setAutoStart(config.autoStart).then((ok) => {
      if (typeof ok === 'boolean' && ok !== config.autoStart) {
        config.autoStart = ok;
        saveConfig(config);
      }
      log('开机自启状态: ' + (ok === null ? '查询失败(未同步)' : ok ? '开' : '关'));
    });

    createWindow();
    createTray();

    if (SELFTEST) runSelfTest();
  });

  app.on('will-quit', () => { killTopmostWatcher(); });

  app.on('window-all-closed', () => {
    // Windows 下保持托盘常驻，除非显式退出
  });
}

// ---------- 自检模式（npm run selftest / electron . --selftest）----------
// 不碰真实副作用（不开网页、不发媒体键、不删文件、不改注册表），
// 只在真实窗口上验证核心链路并把 PASS/FAIL 写进 pet-log.txt，最后自动退出。
const SELFTEST = process.argv.includes('--selftest');

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

async function runSelfTest() {
  // 看门狗：任何一步卡死（渲染进程挂起/加载失败等）都强制结束，绝不让自检无限等待
  const watchdog = setTimeout(() => {
    log('[selftest] 看门狗超时（60s）强制退出');
    try { fs.writeFileSync(path.join(__dirname, 'selftest-watchdog.txt'), 'timeout at ' + new Date().toISOString()); } catch (_) {}
    killTopmostWatcher();
    isQuitting = true;
    app.exit(3);
  }, 60000);
  const results = [];
  const report = (name, ok, detail) => {
    results.push({ name, ok, detail: String(detail || '') });
    log('[selftest] ' + (ok ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' | ' + detail : ''));
  };
  const originalSkin = config.skin;
  const originalPos = win.getPosition();
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const closeEnough = (a, b) => Math.abs(a - b) <= 1; // DIP↔像素换算会有 ±1px 取整

  try {
    // 等待页面加载 + 渲染进程初始化
    if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
    await delay(3000);

    // 1. 渲染进程初始化完成标记
    const ready = await win.webContents.executeJavaScript('!!window.__petReady');
    report('renderer-init', ready === true);

    // 2. 当前皮肤应为图集动画（小深视频.png）
    const atlasInfo = await win.webContents.executeJavaScript(
      'JSON.stringify({active: atlas.active, state: atlas.state, hasSource: !!atlas.source, cw: spriteCanvas.width, ch: spriteCanvas.height})'
    );
    let atlasOk = false;
    try { const a = JSON.parse(atlasInfo); atlasOk = a.active && a.hasSource && a.cw === 384 && a.ch === 416; } catch (_) {}
    report('atlas-active', atlasOk, atlasInfo);

    // 3. 皮肤切换往返：图集 -> classic（静态）-> 图集
    await win.webContents.executeJavaScript('applySkin("classic", true)');
    await delay(1500);
    const classicState = await win.webContents.executeJavaScript(
      'JSON.stringify({active: atlas.active, spriteNaturalW: sprite.naturalWidth})'
    );
    let classicOk = false;
    try { const c = JSON.parse(classicState); classicOk = !c.active && c.spriteNaturalW > 0; } catch (_) {}
    report('skin-switch-classic', classicOk, classicState);

    await win.webContents.executeJavaScript('applySkin("imported:小深视频.png", true)');
    await delay(1500);
    const backState = await win.webContents.executeJavaScript(
      'JSON.stringify({active: atlas.active, hasSource: !!atlas.source})'
    );
    let backOk = false;
    try { const b = JSON.parse(backState); backOk = b.active && b.hasSource; } catch (_) {}
    report('skin-switch-atlas-back', backOk, backState);

    // 4. 拖动 IPC 往返：drag-start -> drag-move(40,30) -> drag-end，窗口应移动且主进程 drag 状态被清空
    const [wx0, wy0] = win.getPosition();
    await win.webContents.executeJavaScript('petAPI.dragStart(); petAPI.dragMove(40, 30); petAPI.dragEnd(); true');
    await delay(300);
    const [wx1, wy1] = win.getPosition();
    const { x: expX, y: expY } = clampPetPosition(wx0 + 40, wy0 + 30);
    report('drag-ipc', closeEnough(wx1, expX) && closeEnough(wy1, expY) && drag === null,
      'from=(' + wx0 + ',' + wy0 + ') to=(' + wx1 + ',' + wy1 + ') expect=(' + expX + ',' + expY + ') dragState=' + JSON.stringify(drag));

    // 5. 置顶往返：开 -> 关（守护必须存活）-> 开（守护被终止）
    await setTopmostFromMain(true);
    await delay(600);
    const onOk = topmostOn === true;
    await setTopmostFromMain(false);
    await delay(3000); // 给守护启动时间；旧 bug 下守护 1 秒内即退出
    const watcherPid = topmostWatcher ? topmostWatcher.pid : null;
    const watcherAlive = watcherPid ? isPidAlive(watcherPid) : false;
    report('topmost-watcher-alive', onOk && watcherAlive, 'on=' + onOk + ' watcherPid=' + (watcherPid || 'null') + ' alive=' + watcherAlive);
    await setTopmostFromMain(true);
    await delay(600);
    report('topmost-back-on', topmostOn === true && !topmostWatcher, 'topmostOn=' + topmostOn + ' watcherCleared=' + !topmostWatcher);

    // 5b. 回归：反复切换置顶后，拖动是否仍然有效（用户报告：置顶重复后无法拖动）
    for (let i = 0; i < 8; i++) {
      await setTopmostFromMain(false);
      await delay(200);
      await setTopmostFromMain(true);
      await delay(200);
    }
    await delay(500);
    const [cx0, cy0] = win.getPosition();
    const boundsBefore = win.getBounds();
    await win.webContents.executeJavaScript('petAPI.dragStart(); petAPI.dragMove(60, 40); petAPI.dragEnd(); true');
    await delay(400);
    const [cx1, cy1] = win.getPosition();
    const { x: cexpX, y: cexpY } = clampPetPosition(cx0 + 60, cy0 + 40);
    report('drag-after-topmost-cycling', closeEnough(cx1, cexpX) && closeEnough(cy1, cexpY) && drag === null,
      'from=(' + cx0 + ',' + cy0 + ') to=(' + cx1 + ',' + cy1 + ') expect=(' + cexpX + ',' + cexpY + ') boundsBefore=' + JSON.stringify(boundsBefore) + ' dragState=' + JSON.stringify(drag));

    // 5c. 置顶关（守护运行中）拖动：窗口应移动，且守护周期内位置不被钉回
    await setTopmostFromMain(false);
    await delay(900); // 让守护跑起来
    const [wx2, wy2] = win.getPosition();
    await win.webContents.executeJavaScript('petAPI.dragStart(); petAPI.dragMove(-50, -35); petAPI.dragEnd(); true');
    await delay(400);
    const [wx3, wy3] = win.getPosition();
    await delay(2600); // 等守护跑 2 个周期，看是否被钉回
    const [wx4, wy4] = win.getPosition();
    const { x: wex, y: wey } = clampPetPosition(wx2 - 50, wy2 - 35);
    report('drag-while-watcher-running', closeEnough(wx3, wex) && closeEnough(wy3, wey) && closeEnough(wx4, wx3) && closeEnough(wy4, wy3),
      'from=(' + wx2 + ',' + wy2 + ') after=(' + wx3 + ',' + wy3 + ') after2s=(' + wx4 + ',' + wy4 + ') expect=(' + wex + ',' + wey + ')');
    await setTopmostFromMain(true);
    await delay(400);

    // 5d. 置顶关（守护运行中）：宠物 z 序应位于壁纸层之上（可见，不再“消失”）
    await setTopmostFromMain(false);
    await delay(2000); // 等守护完成一次贴回
    const pHandle = win.getNativeWindowHandle();
    const pPetHwnd = pHandle.length >= 8 ? pHandle.readBigUInt64LE(0).toString() : pHandle.readUInt32LE(0).toString();
    const probe = [
      '$sig=@\'',
      'using System;',
      'using System.Runtime.InteropServices;',
      'using System.Text;',
      'public class Probe {',
      '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);',
      '  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
      '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
      '  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
      '  public static string Run(IntPtr pet) {',
      '    var sb = new StringBuilder(256);',
      '    int petIdx = -1, wallIdx = -1, idx = 0;',
      '    EnumWindows((h, p) => {',
      '      if (h == pet) petIdx = idx;',
      '      GetClassName(h, sb, 256);',
      '      var cls = sb.ToString();',
      '      if ((cls == "Progman" || cls == "WorkerW") && IsWindowVisible(h) && wallIdx < 0) wallIdx = idx;',
      '      idx++; return true;',
      '    }, IntPtr.Zero);',
      '    return "petIdx=" + petIdx + " wallIdx=" + wallIdx + " above=" + (petIdx >= 0 && (wallIdx < 0 || petIdx < wallIdx));',
      '  }',
      '}',
      "'@",
      '$null = Add-Type -TypeDefinition $sig',
      '$pet=[IntPtr]::new([Int64]' + pPetHwnd + ')',
      '[Probe]::Run($pet)',
    ].join('\n');
    const probeOut = await new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probe], { windowsHide: true, timeout: 15000 }, (err, stdout) => resolve(String(stdout || '').trim()));
    });
    report('pet-above-wallpaper', /above=True/i.test(probeOut), probeOut || 'no-output');
    await setTopmostFromMain(true);
    await delay(400);

    // 6. 网站列表归一化（校验/防注入逻辑）：非法 url 会被过滤，空列表回退到默认站点（全部 http/https）
    const sitesOut = normalizeSites(config.sites);
    const badSites = normalizeSites({ frequent: [{ name: 'X', url: 'javascript:alert(1)' }], more: [] });
    const badClean = JSON.stringify(badSites).indexOf('javascript:') === -1 &&
      badSites.frequent.every((s) => /^https?:\/\//i.test(s.url));
    report('sites-normalize', sitesOut.frequent.length > 0 && badClean,
      'frequent=' + sitesOut.frequent.length + ' more=' + sitesOut.more.length + ' badFallback=' + badSites.frequent.length);

    // 7. 截图（衬棋盘格背景便于观察透明渲染），供人工/视觉核查
    await win.webContents.executeJavaScript(
      'document.body.style.background = "repeating-conic-gradient(#dde3ec 0% 25%, #c3cddc 0% 50%) 0 0 / 24px 24px"; true'
    );
    await delay(400);
    const shot = await win.webContents.capturePage();
    const shotPath = path.join(__dirname, 'selftest.png');
    fs.writeFileSync(shotPath, shot.toPNG());
    await win.webContents.executeJavaScript('document.body.style.background = "transparent"; true');
    report('screenshot', fs.existsSync(shotPath) && fs.statSync(shotPath).size > 1000, shotPath + ' (' + fs.statSync(shotPath).size + 'B)');

    // 8. 隐藏/唤回往返：隐藏后窗口不可见，showPet 唤回后可见
    hidePet();
    await delay(500);
    const hiddenOk = !win.isVisible();
    showPet();
    await delay(500);
    const shownOk = win.isVisible();
    report('hide-show-roundtrip', hiddenOk && shownOk, 'hidden=' + hiddenOk + ' shown=' + shownOk);
  } catch (e) {
    report('selftest-exception', false, (e && e.stack) || String(e));
  }

  // 收尾：恢复皮肤/窗口位置/置顶，写出结果，退出
  try {
    config.skin = originalSkin || config.skin;
    saveConfig(config);
    if (win) {
      win.setPosition(originalPos[0], originalPos[1]);
      await setTopmostFromMain(true); // 原生恢复到最上（app.exit 不触发 will-quit）
    }
  } catch (_) {}
  killTopmostWatcher();
  clearTimeout(watchdog);
  const failed = results.filter((r) => !r.ok).length;
  log('[selftest] 完成：共 ' + results.length + ' 项，失败 ' + failed + ' 项');
  setTimeout(() => { isQuitting = true; app.exit(failed > 0 ? 2 : 0); }, 600);
}
