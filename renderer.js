/* DeepSeek 桌宠 —— 渲染进程：动效、交互、拖拽进食 */
// 注意：不能用 const/let 声明 petAPI —— preload 已通过 contextBridge 把它暴露成全局，
// 再声明同名变量会报 "Identifier 'petAPI' has already been declared"，直接使用全局即可。

// ---------- DOM ----------
const stage = document.getElementById('stage');
const petPos = document.getElementById('pet-pos');
const pet = document.getElementById('pet');
const sprite = document.getElementById('sprite');
const spriteCanvas = document.getElementById('sprite-canvas');
const atlasCanvasCtx = spriteCanvas.getContext('2d');
const shadow = document.getElementById('shadow');
const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const particles = document.getElementById('particles');
const about = document.getElementById('about');
const skinsPanel = document.getElementById('skins');
const skinListEl = document.getElementById('skin-list');
const sitesManager = document.getElementById('sites-manager');

// ---------- 工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const truncate = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const domainOf = (url) => { try { return new URL(url).hostname; } catch (_) { return ''; } };

// 网站快捷入口图标：本站 favicon 失败 → 换 Google 图标服务 → 再失败显示 emoji 兜底
function setupFavicon(img, domain) {
  let tries = 0;
  img.addEventListener('error', () => {
    tries++;
    if (tries === 1 && domain) {
      img.src = 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(domain) + '&sz=64';
      return;
    }
    img.classList.add('error'); // 隐藏 img，露出底下的 emoji
  });
}

// ---------- 精灵生成：裁剪底部文字 + 去除白色背景 ----------
function removeWhiteBackground(id, w, h) {
  const d = id.data;
  const tol = 30;
  const bg = new Uint8Array(w * h);
  const q = new Int32Array(w * h);
  let head = 0, tail = 0;

  const isBg = (i) => {
    const o = i * 4;
    return d[o] >= 255 - tol && d[o + 1] >= 255 - tol && d[o + 2] >= 255 - tol;
  };

  // 入队时即标记，保证每个像素最多入队一次，队列不会溢出
  const tryPush = (i) => {
    if (!bg[i] && isBg(i)) {
      bg[i] = 1;
      q[tail++] = i;
    }
  };

  for (let x = 0; x < w; x++) { tryPush(x); tryPush((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { tryPush(y * w); tryPush(y * w + (w - 1)); }

  while (head < tail) {
    const i = q[head++];
    d[i * 4 + 3] = 0;
    const x = i % w;
    if (x > 0) tryPush(i - 1);
    if (x < w - 1) tryPush(i + 1);
    if (i >= w) tryPush(i - w);
    if (i < (h - 1) * w) tryPush(i + w);
  }

  // 羽化边缘：紧邻透明区域且偏白的像素降低不透明度，去除白边
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (bg[i]) continue;
      let touches = false;
      if (x > 0 && bg[i - 1]) touches = true;
      else if (x < w - 1 && bg[i + 1]) touches = true;
      else if (y > 0 && bg[i - w]) touches = true;
      else if (y < h - 1 && bg[i + w]) touches = true;
      if (!touches) continue;
      const o = i * 4;
      const lum = (d[o] + d[o + 1] + d[o + 2]) / 3;
      if (lum > 200) {
        const a = Math.max(0, Math.min(255, Math.round(((lum - 200) / 55) * 255)));
        d[o + 3] = Math.min(d[o + 3], a);
      }
    }
  }
}

function buildSprite(src, opts = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const srcW = img.naturalWidth;
        const srcH = img.naturalHeight;
        const keep = opts.crop || 1; // 默认皮肤裁掉底部 15%（含“去问你的豆包”文字），导入皮肤不裁剪
        const cropH = Math.floor(srcH * keep);
        const c = document.createElement('canvas');
        c.width = srcW;
        c.height = cropH;
        const ctx = c.getContext('2d', { willReadFrequently: true }); // getImageData 回读优化
        ctx.drawImage(img, 0, 0, srcW, cropH, 0, 0, srcW, cropH);
        if (opts.hue) {
          // 换色：保留明暗与饱和度，只替换色相（白底不受影响，稍后被 flood fill 去除）
          ctx.globalCompositeOperation = 'hue';
          ctx.fillStyle = opts.hue;
          ctx.fillRect(0, 0, srcW, cropH);
          ctx.globalCompositeOperation = 'source-over';
        }
        const id = ctx.getImageData(0, 0, srcW, cropH);
        removeWhiteBackground(id, srcW, cropH);
        ctx.putImageData(id, 0, 0);
        resolve({ url: c.toDataURL('image/png'), mask: buildMaskFromImageData(id, srcW, cropH) });
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error('皮肤图片加载失败'));
    img.src = src;
  });
}

// ---------- 图集动画引擎（Codex 兼容 1536x1872 图集） ----------
const ATLAS_COLS = 8, ATLAS_ROWS = 9, CELL_W = 192, CELL_H = 208;
const ATLAS_W = 1536, ATLAS_H = 1872;

const ATLAS_STATES = {
  'idle':          { row: 0, frames: 6, durations: [280, 110, 110, 140, 140, 320] },
  'running-right': { row: 1, frames: 8, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  'running-left':  { row: 2, frames: 8, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  'waving':        { row: 3, frames: 4, durations: [140, 140, 140, 280] },
  'jumping':       { row: 4, frames: 5, durations: [140, 140, 140, 140, 280] },
  'failed':        { row: 5, frames: 8, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  'waiting':       { row: 6, frames: 6, durations: [150, 150, 150, 150, 150, 260] },
  'running':       { row: 7, frames: 6, durations: [120, 120, 120, 120, 120, 220] },
  'review':        { row: 8, frames: 6, durations: [150, 150, 150, 150, 150, 280] },
};

const atlas = {
  active: false,       // 当前皮肤是否为图集动画
  source: null,        // 完整图集离屏 canvas
  available: {},       // state -> 该行是否有内容
  frameCounts: {},     // state -> 该行实际帧数（自动检测）
  layout: null,        // 布局描述（多行帧/镜像/帧时长），来自 .layout.json
  mirrored: false,     // 当前帧是否水平镜像绘制
  state: 'idle',
  override: null,      // { state, until }
  frame: 0,
  nextAt: 0,
  dragDir: 1,          // 拖动方向：1 右 / -1 左
};

function probeImageSize(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function loadAtlas(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        if (img.naturalWidth !== ATLAS_W || img.naturalHeight !== ATLAS_H) {
          reject(new Error('非标准图集尺寸: ' + img.naturalWidth + 'x' + img.naturalHeight));
          return;
        }
        const c = document.createElement('canvas');
        c.width = ATLAS_W;
        c.height = ATLAS_H;
        const ctx = c.getContext('2d', { willReadFrequently: true }); // 行内容检测/帧蒙版会频繁 getImageData
        ctx.drawImage(img, 0, 0);
        // 检测每行是否有内容 + 每行实际帧数（有内容的列数，视频抽帧可能 4~8 帧不等）
        const id = ctx.getImageData(0, 0, ATLAS_W, ATLAS_H);
        const available = {};
        const frameCounts = {};
        for (const [name, st] of Object.entries(ATLAS_STATES)) {
          let has = false;
          let count = 0;
          for (let col = 0; col < ATLAS_COLS; col++) {
            const sx = col * CELL_W, sy = st.row * CELL_H;
            let colHas = false;
            for (let y = sy; y < sy + CELL_H && !colHas; y += 4) {
              for (let x = sx; x < sx + CELL_W; x += 4) {
                if (id.data[(y * ATLAS_W + x) * 4 + 3] > 8) { colHas = true; has = true; break; }
              }
            }
            if (colHas) count++;
          }
          available[name] = has;
          frameCounts[name] = count;
        }
        resolve({ source: c, available, frameCounts });
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('图集加载失败'));
    img.src = dataUrl;
  });
}

function setAtlasMode(on) {
  atlas.active = on;
  if (on) {
    sprite.style.display = 'none';
    spriteCanvas.style.display = 'block';
    atlasCanvasCtx.clearRect(0, 0, spriteCanvas.width, spriteCanvas.height);
  } else {
    sprite.style.display = 'block';
    spriteCanvas.style.display = 'none';
  }
}

// 播放一段临时状态（帧动画皮肤）
// 状态时序：帧数/帧时长（镜像状态取源状态的值；布局状态取布局值；否则自动检测/规格表兜底）
function stateTiming(state) {
  const L = (atlas.layout && atlas.layout.states) ? atlas.layout.states : null;
  const info = L ? L[state] : null;
  let fc = 8, DUR = 100;
  if (info && info.mirror) {
    const src = L[info.mirror];
    fc = src ? src.frames : 8;
    DUR = (src && src.dur) ? src.dur : 100;
  } else if (info) {
    fc = info.frames;
    DUR = info.dur || 100;
  } else if (atlas.frameCounts[state]) {
    fc = atlas.frameCounts[state];
  } else if (ATLAS_STATES[state]) {
    fc = ATLAS_STATES[state].frames;
  }
  return { fc: fc || 8, DUR: DUR || 100 };
}

function atlasPlay(state, ms) {
  if (!atlas.active || !atlas.source) return;
  const L = (atlas.layout && atlas.layout.states) ? atlas.layout.states : null;
  const avail = (name) => (L ? !!L[name] : !!atlas.available[name]);
  if (!avail(state)) {
    state = state === 'jumping' ? 'waving' : 'idle';
  }
  if (!avail(state)) return;
  atlas.override = { state, until: performance.now() + ms };
}

// ---------- 动作排队（不可打断）----------
// 正在播放的动作（覆盖动作或站立「动」窗口）必须播完，新动作先排队，播完后再执行，避免生硬跳变。
let pendingAction = null; // { state, ms }
let sleepState = 'waiting'; // 本次打盹使用的睡觉动画（可能为变体 waiting-2）

// 动作变体：同一动作有多套动画（如 jumping/jumping-2）时，每次随机挑一套
function variantOf(base) {
  if (!atlasHas(base)) return null;
  const v = base + '-2';
  return (atlasHas(v) && Math.random() < 0.5) ? v : base;
}

function playAction(state, ms) {
  if (!atlas.active || !atlas.source) return;
  const busy = !!atlas.override || (!standHolding && atlas.state === 'review' && !dragging);
  if (busy) {
    pendingAction = { state, ms };
    return;
  }
  atlasPlay(state, ms);
}

function drainPendingAction() {
  if (!pendingAction) return;
  const p = pendingAction;
  pendingAction = null;
  atlasPlay(p.state, p.ms);
}

// 图集皮肤是否拥有某状态动画（自定义布局优先）
function atlasHas(name) {
  if (!atlas.active || !atlas.source) return false;
  return (atlas.layout && atlas.layout.states) ? !!atlas.layout.states[name] : !!atlas.available[name];
}

// ---------- 打盹 ----------
// 长时间无交互自动入睡（图集皮肤且有睡觉动画时）：持续循环睡觉动画，
// 直到被点击/拖动/投喂唤醒；随机小动作抽到「打盹」也会进入睡眠。
let sleeping = false;
let lastInteraction = performance.now();
const SLEEP_AFTER_MS = 45 * 1000;

// ---------- 站立保持 ----------
// 默认站立形态大部分时间定格在一帧（自然站立），每隔 7~13 秒才播一段动作，播完回到定格。
let standHolding = true;
let standMoveUntil = 0;
let standNextMoveAt = 0;
const STAND_MOVE_MS = 3300;    // 每次「动」的持续时长（约 5 帧 @ 651ms 自然节奏）
const STAND_HOLD_FRAME = 0;    // 定格帧序号

// ---------- 动作过渡 ----------
// 状态切换/回定格时新旧画面交叉淡化，避免帧直接跳变显得生硬
let transFrom = 0, transUntil = 0;
let prevCanvas = null;
const TRANS_MS = 220;          // 状态切换过渡时长
const FRAME_BLEND_MS = 120;    // 同状态内逐帧融合时长
let transMaxAlpha = 0.5;       // 本次过渡的旧帧最大叠加透明度（上限防鬼影/闪烁）

function snapshotForTransition(t, ms = TRANS_MS, maxAlpha = 0.5) {
  if (!prevCanvas) {
    prevCanvas = document.createElement('canvas');
    prevCanvas.width = spriteCanvas.width;
    prevCanvas.height = spriteCanvas.height;
  }
  const pc = prevCanvas.getContext('2d');
  pc.clearRect(0, 0, prevCanvas.width, prevCanvas.height);
  pc.drawImage(spriteCanvas, 0, 0); // 快照当前画面
  transFrom = t;
  transUntil = t + ms;
  transMaxAlpha = maxAlpha;
}

function startSleeping() {
  if (sleeping) return;
  sleeping = true;
  atlas.override = null; // 立即入睡
  pendingAction = null;  // 入睡时丢弃排队的动作
  sleepState = variantOf('waiting') || 'waiting'; // 随机挑一套睡觉动画（睡觉/睡觉2）
  showBubble(pick(['Zzz… 💤', '呼……呼…… 😴', '（睡着了）💤']), Infinity);
  try { petAPI.log('打盹开始'); } catch (_) {}
}

function wakeUp(withBubble) {
  if (!sleeping) return;
  sleeping = false;
  hideBubble();
  if (atlas.active) {
    atlasPlay(variantOf('jumping') || 'jumping', 900); // 醒来先伸个懒腰（随机变体）
  }
  if (withBubble) {
    showBubble(pick(['呼啊～ 睡醒啦！ ☀️', '嗯？谁戳我～', '好困……再五分钟嘛～']), 1800);
  }
  try { petAPI.log('打盹唤醒'); } catch (_) {}
}

// ---------- 鼠标穿透：透明区域点击直达桌面 ----------
let currentMask = null;   // { mask: Uint8Array, w, h }，null = 无法判定则保持可点击
const atlasMasks = {};    // `${row}-${col}` -> mask
let mouseIgnored = false;
let lastMouse = null;

function buildMaskFromImageData(id, w, h, step = 6) {
  const mw = Math.ceil(w / step), mh = Math.ceil(h / step);
  const mask = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const px = Math.min(x * step, w - 1);
      const py = Math.min(y * step, h - 1);
      mask[y * mw + x] = id.data[(py * w + px) * 4 + 3] > 24 ? 1 : 0;
    }
  }
  return { mask, w: mw, h: mh };
}

function getAtlasFrameMask(row, col) {
  const key = row + '-' + col;
  let m = atlasMasks[key];
  if (!m) {
    const id = atlas.source.getContext('2d').getImageData(col * CELL_W, row * CELL_H, CELL_W, CELL_H);
    m = buildMaskFromImageData(id, CELL_W, CELL_H, 4);
    atlasMasks[key] = m;
  }
  return m;
}

// 鼠标穿透轮询恢复：focusable:false 窗口在 Windows 上 setIgnoreMouseEvents 的
// forward:true 转发可能失效，一旦进入穿透状态就收不到 mousemove 恢复信号。
// 兜底：穿透期间每 120ms 向主进程要一次光标位置，自行重算是否可点击（保证宠物永远抓得住）。
let cursorPollTimer = null;
function ensureCursorPoll() {
  if (cursorPollTimer) return;
  cursorPollTimer = setInterval(async () => {
    if (!mouseIgnored) { clearInterval(cursorPollTimer); cursorPollTimer = null; return; }
    try {
      const pt = await petAPI.getCursorPoint();
      if (pt) {
        const cx = pt.x - window.screenX;
        const cy = pt.y - window.screenY;
        updateClickThrough(cx, cy);
      }
    } catch (_) {}
  }, 120);
}

function setMouseIgnore(ignore) {
  if (ignore === mouseIgnored) return;
  mouseIgnored = ignore;
  try { petAPI.setMouseIgnore(ignore); } catch (_) {}
  if (ignore) ensureCursorPoll();
}

function updateClickThrough(cx, cy) {
  const panelOpen = menuOpen || !skinsPanel.classList.contains('hidden') || !about.classList.contains('hidden') || !sitesManager.classList.contains('hidden');
  let clickable = dragging || panelOpen || !currentMask;
  if (!clickable) {
    const el = atlas.active ? spriteCanvas : sprite;
    const rect = el.getBoundingClientRect();
    if (cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom) {
      let mx = Math.floor(((cx - rect.left) / rect.width) * currentMask.w);
      const my = Math.floor(((cy - rect.top) / rect.height) * currentMask.h);
      if (mx >= 0 && mx < currentMask.w && my >= 0 && my < currentMask.h) {
        if (atlas.mirrored) mx = currentMask.w - 1 - mx; // 镜像帧的蒙版也要水平翻转
        clickable = currentMask.mask[my * currentMask.w + mx] === 1;
      }
    }
  }
  setMouseIgnore(!clickable);
}

document.addEventListener('mousemove', (e) => {
  lastMouse = { x: e.clientX, y: e.clientY };
  updateClickThrough(e.clientX, e.clientY);
});

// ---------- 动画状态 ----------
const anim = {
  tiltCur: 0,
  liftCur: 1,
  bounceY: 0,
  bounceV: 0,
  chompActive: false,
  chompStart: 0,
  chompDuration: 0,
  lastCrumb: 0,
  shakeActive: false,
  shakeStart: 0,
  idleAction: null,
};
let targetTilt = 0;
let targetLift = 1;
let nextIdleAt = 0;

function tick(now) {
  const t = now;
  const fy = Math.sin(t / 620) * 6;        // 上下漂浮
  const sw = Math.sin(t / 950) * 1.5;      // 左右摇摆
  const br = 1 + Math.sin(t / 720) * 0.018; // 呼吸

  anim.tiltCur += (targetTilt - anim.tiltCur) * 0.12;
  anim.liftCur += (targetLift - anim.liftCur) * 0.15;

  // 落地弹跳（弹簧）
  anim.bounceY += anim.bounceV;
  anim.bounceV += (0 - anim.bounceY) * 0.25 - anim.bounceV * 0.16;
  if (Math.abs(anim.bounceY) < 0.05 && Math.abs(anim.bounceV) < 0.05) {
    anim.bounceY = 0; anim.bounceV = 0;
  }

  // 咀嚼动画
  let chompScale = 1, chompRot = 0;
  if (anim.chompActive) {
    const phase = (t - anim.chompStart) / 1000;
    chompScale = 1 + 0.07 * Math.sin(phase * 22);
    chompRot = 2.2 * Math.sin(phase * 11);
    if (t - anim.lastCrumb > 220) { anim.lastCrumb = t; spawnParticle('crumb'); }
    if (phase > anim.chompDuration) { anim.chompActive = false; chompScale = 1; chompRot = 0; }
  }

  // 被戳的果冻抖动：阻尼正弦，柔软自然
  let shakeRot = 0, shakeSX = 1, shakeSY = 1;
  if (anim.shakeActive) {
    const dt = (t - anim.shakeStart) / 1000;
    const decay = Math.exp(-3.2 * dt);
    const wave = Math.sin(dt * 26);
    shakeRot = wave * 2.6 * decay;
    shakeSX = 1 + wave * 0.03 * decay;
    shakeSY = 1 - wave * 0.03 * decay;
    if (dt > 1.4) anim.shakeActive = false;
  }

  // 随机小动作：静态皮肤伸懒腰/轻跳，图集皮肤挥手/跳跃
  let idleBounce = 0, idleSX = 1, idleSY = 1;
  // 打盹判定：长时间无交互且皮肤有睡觉动画 → 持续入睡
  if (!sleeping && !dragging && !anim.chompActive && !atlas.override && t - lastInteraction > SLEEP_AFTER_MS && atlasHas('waiting')) {
    startSleeping();
  }
  if (!sleeping && !anim.idleAction && t >= nextIdleAt && !dragging && !anim.chompActive && !anim.shakeActive && !atlas.override) {
    nextIdleAt = t + 13000 + Math.random() * 16000;
    if (atlas.active) {
      // 时间触发动作池：休息/挥手/跳跃/打盹（站立是默认形态不进池）；抽到「打盹」就持续睡觉直到被点击唤醒
      const acts = ['idle', 'waving', 'jumping', 'waiting'].filter((a) => atlasHas(a));
      if (acts.length) {
        const act = acts[Math.floor(Math.random() * acts.length)];
        if (act === 'waiting') {
          startSleeping();
        } else {
          const actDur = { idle: 1800, waving: 1500, jumping: 1200 }[act] || 1500;
          atlasPlay(variantOf(act) || act, actDur); // 跳跃随机挑一套
        }
      }
    } else {
      anim.idleAction = { start: t, kind: Math.random() < 0.5 ? 'stretch' : 'hop' };
    }
  }
  if (anim.idleAction) {
    const a = anim.idleAction;
    const dt = (t - a.start) / 1000;
    if (a.kind === 'stretch') {
      const p = Math.sin(clamp(dt / 1.2, 0, 1) * Math.PI);
      idleSY = 1 + 0.05 * p;
      idleSX = 1 - 0.04 * p;
      if (dt > 1.2) anim.idleAction = null;
    } else {
      const p = Math.sin(clamp(dt / 0.8, 0, 1) * Math.PI);
      idleBounce = -6 * p;
      if (dt > 0.8) anim.idleAction = null;
    }
  }

  // 图集动画：状态选择 + 帧推进 + 绘制
  if (atlas.active && atlas.source) {
    const L = (atlas.layout && atlas.layout.states) ? atlas.layout.states : null;
    const stInfo = (name) => (L && L[name]) ? L[name] : null;
    const avail = (name) => (L ? !!stInfo(name) : !!atlas.available[name]);

    let want = avail('review') ? 'review' : 'idle'; // 默认形态：静止站立（无站立动画则回退休息）
    if (dragging) {
      want = (atlas.dragDir >= 0 ? 'running-right' : 'running-left');
    } else if (anim.chompActive) {
      want = 'running';
    } else if (atlas.override && t < atlas.override.until) {
      want = atlas.override.state;
    } else if (atlas.override) {
      atlas.override = null;
      drainPendingAction(); // 当前动作播完 → 播放排队的下一个
    } else if (sleeping && avail(sleepState)) {
      want = sleepState; // 睡觉循环（睡觉/睡觉2 变体），直到被唤醒
    }
    if (!avail(want)) want = 'idle';

    // 站立保持状态机：定格 ↔ 偶发动作
    const isStanding = (want === 'review') && !atlas.override && !sleeping && !dragging && !anim.chompActive;
    if (isStanding) {
      if (standHolding && standNextMoveAt === 0) {
        standNextMoveAt = t + 7000 + Math.random() * 6000; // 入场/回到站立：先定格再排期
      } else if (standHolding && t >= standNextMoveAt) {
        standHolding = false; // 开始动
        standMoveUntil = t + STAND_MOVE_MS;
        standNextMoveAt = 0;
      } else if (!standHolding && t >= standMoveUntil) {
        snapshotForTransition(t); // 回定格前快照，淡化过渡
        standHolding = true; // 动完回到定格
        standMoveUntil = 0;
        standNextMoveAt = t + 7000 + Math.random() * 6000;
        drainPendingAction(); // 动完 → 播放排队的下一个
      }
    } else {
      standHolding = true; // 离开站立：重置节奏，回来时重新从定格开始
      standMoveUntil = 0;
      standNextMoveAt = 0;
    }

    if (want !== atlas.state) {
      snapshotForTransition(t); // 切换前快照旧画面做交叉淡化
      atlas.state = want;
      atlas.frame = 0;
      // 用新状态的帧时长排下一帧（旧实现误用了切换前状态的 DUR，切换后第一帧节奏会错一拍）
      atlas.nextAt = t + stateTiming(atlas.state).DUR;
    } else if (isStanding && standHolding) {
      atlas.frame = STAND_HOLD_FRAME; // 定格：帧号锁死
      atlas.nextAt = t + 1e9;
    } else if (t >= atlas.nextAt) {
      snapshotForTransition(t, FRAME_BLEND_MS, 0.3); // 帧间融合：旧帧最大 30% 叠加，柔和且无鬼影
      const { fc, DUR } = stateTiming(atlas.state);
      atlas.frame = (atlas.frame + 1) % fc;
      atlas.nextAt = t + DUR;
    }

    // 计算帧所在行/列（支持多行布局与镜像状态）
    let row, col, mirrored = false;
    const curInfo = stInfo(atlas.state);
    if (curInfo && curInfo.mirror) {
      const srcInfo = stInfo(curInfo.mirror);
      const srcFc = srcInfo ? srcInfo.frames : 8;
      const fIdx = atlas.frame % srcFc;
      row = srcInfo.row + Math.floor(fIdx / ATLAS_COLS);
      col = fIdx % ATLAS_COLS;
      mirrored = true;
    } else if (curInfo) {
      row = curInfo.row + Math.floor(atlas.frame / ATLAS_COLS);
      col = atlas.frame % ATLAS_COLS;
    } else {
      const st = ATLAS_STATES[atlas.state];
      row = st.row;
      col = atlas.frame % st.frames;
    }
    atlas.mirrored = mirrored;

    atlasCanvasCtx.imageSmoothingEnabled = true;
    atlasCanvasCtx.clearRect(0, 0, spriteCanvas.width, spriteCanvas.height);
    // 2 倍分辨率渲染（384x416）：放大后线条更平滑细腻
    const W = spriteCanvas.width, H = spriteCanvas.height;
    atlasCanvasCtx.save();
    if (mirrored) {
      atlasCanvasCtx.translate(W, 0);
      atlasCanvasCtx.scale(-1, 1);
    }
    atlasCanvasCtx.drawImage(
      atlas.source, col * CELL_W, row * CELL_H, CELL_W, CELL_H,
      0, 0, W, H
    );
    atlasCanvasCtx.restore();
    // 交叉淡化：状态切换/帧间切换时，旧画面按「上限透明度 × 缓出曲线」叠在顶部，柔和且不闪
    if (t < transUntil && prevCanvas) {
      const span = Math.max(1, transUntil - transFrom);
      let p = clamp((t - transFrom) / span, 0, 1);
      p = p * p; // 缓出：尾部淡得更慢更自然
      atlasCanvasCtx.globalAlpha = transMaxAlpha * (1 - p);
      atlasCanvasCtx.drawImage(prevCanvas, 0, 0);
      atlasCanvasCtx.globalAlpha = 1;
    }
    currentMask = getAtlasFrameMask(row, col);
  }

  const scale = br * anim.liftCur * chompScale;
  const rot = sw + anim.tiltCur + chompRot + shakeRot;
  const sx = scale * shakeSX * idleSX;
  const sy = scale * shakeSY * idleSY;
  pet.style.transform = `translateY(${fy + anim.bounceY + idleBounce}px) rotate(${rot}deg) scale(${sx}, ${sy})`;

  const dist = (fy + anim.bounceY) / 6;
  // 阴影跟随人物：translateX(-50%) 使 left 即中心，对齐 pet-pos 水平中心（人物在盒内居中）
  shadow.style.left = (petPos.offsetLeft + petPos.offsetWidth / 2) + 'px';
  shadow.style.transform = `translateX(-50%) scale(${clamp(1 - dist * 0.3, 0.55, 1.2)}, 1)`;
  shadow.style.opacity = String(clamp(0.85 - dist * 0.35, 0.25, 0.9));

  requestAnimationFrame(tick);
}

// ---------- 气泡 ----------
let bubbleTimer = null;
function showBubble(text, duration) {
  bubbleText.textContent = text;
  bubble.classList.remove('hidden');
  bubble.classList.remove('pop');
  void bubble.offsetWidth;
  bubble.classList.add('pop');
  // 定位：宠物头顶上方；超出窗口则夹回窗口内，长文本不再被裁掉
  const petRect = pet.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;
  let top = petRect.top - stageRect.top - bh - 12;
  if (top < 3) top = 3;
  let left = petRect.left - stageRect.left + petRect.width / 2 - bw / 2;
  left = Math.min(Math.max(left, 3), Math.max(3, stage.offsetWidth - bw - 3));
  bubble.style.top = Math.round(top) + 'px';
  bubble.style.left = Math.round(left) + 'px';
  if (bubbleTimer) clearTimeout(bubbleTimer);
  if (duration !== Infinity) bubbleTimer = setTimeout(hideBubble, duration);
}
function hideBubble() {
  bubble.classList.add('hidden');
  if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
}

// ---------- 粒子 ----------
function spawnParticle(type) {
  const el = document.createElement('div');
  el.className = 'particle ' + type;
  el.style.left = (50 + (Math.random() * 40 - 20)) + '%';
  el.style.top = (55 + (Math.random() * 20 - 10)) + '%';
  const ang = Math.random() * Math.PI * 2;
  const dist = 30 + Math.random() * 50;
  el.style.setProperty('--dx', (Math.cos(ang) * dist) + 'px');
  el.style.setProperty('--dy', (Math.sin(ang) * dist - 30) + 'px');
  particles.appendChild(el);
  setTimeout(() => el.remove(), 900);
}
const spawnSparkles = (n) => { for (let i = 0; i < n; i++) spawnParticle('sparkle'); };
const spawnCrumbs = (n) => { for (let i = 0; i < n; i++) spawnParticle('crumb'); };

// ---------- 皮肤 ----------
const BUILTIN_SKINS = [
  // 只保留经典蓝；crop: 1 = 不裁剪，完整保留原图（包括底部文字）
  { id: 'classic', name: '经典蓝', color: '#3b82f6', hue: null, crop: 1 },
];
let skinsBase = null;
let importedSkins = [];
let currentSkinId = 'classic';
let skinChanging = false;
const importedAtlas = {}; // id -> 是否为图集动画皮肤

const DEMO_NAMES = {
  'demo-homelander': '示例·Homelander',
  'demo-dark-knight': '示例·暗夜骑士',
};

function displayName(id) {
  const b = BUILTIN_SKINS.find((s) => s.id === id);
  if (b) return b.name;
  const imp = importedSkins.find((s) => s.id === id);
  if (!imp) return '经典蓝';
  const base = imp.name;
  return DEMO_NAMES[base] || base;
}

function skinName(id) {
  return displayName(id);
}

function renderSkinList() {
  skinListEl.innerHTML = '';
  const all = [
    ...BUILTIN_SKINS.map((s) => ({ id: s.id, name: s.name, color: s.color, animated: false })),
    ...importedSkins.map((s) => ({
      id: s.id,
      name: (DEMO_NAMES[s.name] || s.name) + (importedAtlas[s.id] ? ' 🎬' : ''),
      color: 'linear-gradient(135deg,#c084fc,#f472b6)',
      animated: !!importedAtlas[s.id],
    })),
  ];
  for (const s of all) {
    const div = document.createElement('div');
    div.className = 'skin-item' + (s.id === currentSkinId ? ' active' : '');
    div.dataset.skin = s.id;
    const swatch = document.createElement('span');
    swatch.className = 'skin-swatch';
    swatch.style.background = s.color;
    const label = document.createElement('span');
    label.textContent = s.name;
    div.appendChild(swatch);
    div.appendChild(label);
    if (s.id === currentSkinId) {
      const check = document.createElement('span');
      check.className = 'check';
      check.textContent = '✓';
      div.appendChild(check);
    }
    skinListEl.appendChild(div);
  }
}

async function applySkin(skinId, silent) {
  if (skinChanging) return;
  sleeping = false; // 换肤重置打盹状态
  pendingAction = null; // 换肤丢弃排队的动作
  hideBubble();
  lastInteraction = performance.now();
  skinChanging = true;
  currentSkinId = skinId;
  try {
    const builtin = BUILTIN_SKINS.find((s) => s.id === skinId);
    if (builtin) {
      // 内置色变皮肤：静态精灵（裁底 15% + 换色 + 去白底）
      setAtlasMode(false);
      const { url, mask } = await buildSprite(skinsBase, { crop: builtin.crop, hue: builtin.hue });
      sprite.src = url;
      currentMask = mask;
    } else {
      const imp = importedSkins.find((s) => s.id === skinId);
      if (!imp) {
        showBubble('这套皮肤找不到啦，切回经典蓝~', 1800);
        skinChanging = false;
        return applySkin('classic', silent);
      }
      // 探测是否为 Codex 1536x1872 图集 → 真帧动画皮肤
      const size = await probeImageSize(imp.dataUrl);
      if (size && size.w === ATLAS_W && size.h === ATLAS_H) {
        const loaded = await loadAtlas(imp.dataUrl);
        atlas.source = loaded.source;
        atlas.available = loaded.available;
        atlas.frameCounts = loaded.frameCounts || {};
        atlas.layout = imp.layout || null; // 布局描述（多行/镜像/帧时长）
        atlas.mirrored = false;
        atlas.state = 'idle';
        atlas.frame = 0;
        atlas.nextAt = performance.now() + 100;
        atlas.override = null;
        importedAtlas[skinId] = true;
        setAtlasMode(true);
        currentMask = getAtlasFrameMask(0, 0);
      } else {
        importedAtlas[skinId] = false;
        setAtlasMode(false);
        const { url, mask } = await buildSprite(imp.dataUrl, { crop: 1, hue: null });
        sprite.src = url;
        currentMask = mask;
      }
    }
    await petAPI.setSkin(skinId);
    renderSkinList();
    if (lastMouse) updateClickThrough(lastMouse.x, lastMouse.y);
    if (!silent) showBubble(`换上了「${skinName(skinId)}」~ 🎨`, 1600);
  } catch (e) {
    console.error(e);
    petAPI.log('换肤失败: ' + e);
    showBubble('换肤失败 😢', 2000);
  } finally {
    skinChanging = false;
  }
}

skinListEl.addEventListener('click', (e) => {
  const item = e.target.closest('.skin-item');
  if (!item) return;
  applySkin(item.dataset.skin);
});

skinsPanel.querySelector('.skin-import').addEventListener('click', async () => {
  showBubble('选择你的 PNG 立绘~ 📂', 1500);
  const skin = await petAPI.importSkin();
  if (!skin) return;
  // 同名皮肤覆盖导入：替换列表里的旧条目而不是追加，避免当前会话出现重复项
  const idx = importedSkins.findIndex((s) => s.id === skin.id);
  if (idx >= 0) importedSkins[idx] = skin;
  else importedSkins.push(skin);
  renderSkinList();
  await applySkin(skin.id);
});

skinsPanel.querySelector('.about-close').addEventListener('click', () => {
  skinsPanel.classList.add('hidden');
});

// ---------- 动作 ----------
function poke() {
  lastInteraction = performance.now();
  if (sleeping) { wakeUp(true); spawnSparkles(4); return; }
  if (atlas.active) {
    // 图集皮肤：随机挑一套跳跃（跳跃/跳跃2），当前有动作则排队
    playAction(variantOf('jumping') || 'jumping', 1500);
  } else {
    // 静态皮肤：果冻式轻微抖动，阻尼正弦衰减，柔和自然
    anim.shakeActive = true;
    anim.shakeStart = performance.now();
  }
  spawnSparkles(5);
  showBubble(pick(['诶嘿~', '别戳啦~', '干嘛呀~', '哼哼~', '有事嘛？', '(๑•̀ㅂ•́)و✧']), 1300);
}

function dance() {
  if (atlas.active) {
    playAction(variantOf('waving') || 'waving', 1100);
    setTimeout(() => playAction(variantOf('jumping') || 'jumping', 1200), 1100);
  } else {
    anim.bounceV = -9;
    setTimeout(() => { anim.bounceV = -7; }, 360);
  }
  spawnSparkles(14);
  showBubble(pick(['啦啦啦~', '今天也要元气满满！', '转圈圈~', '冲鸭！']), 1500);
}

async function openDeepseek() {
  spawnSparkles(8);
  showBubble('这就带你去 DeepSeek~ 🌐', 1800);
  await petAPI.openDeepseek();
}

async function launchDsh() {
  spawnSparkles(8);
  const status = await petAPI.launchDsh();
  if (status === 'opened') {
    showBubble('dsh 已经在运行啦，带你过去~ 🤖', 2200);
  } else {
    showBubble('启动 dsh 中~ 🤖', 1800);
  }
}

// 音乐控制（媒体键模拟）：播放/暂停、上一首、下一首
async function mediaControl(action, msg) {
  lastInteraction = performance.now();
  if (sleeping) wakeUp(false);
  const ok = await petAPI.mediaControl(action);
  showBubble(ok ? msg : '音乐控制失败 😢', 1600);
}

async function openClipboardPath() {
  spawnSparkles(4);
  const r = await petAPI.openClipboardPath();
  const msgs = {
    empty: '剪贴板里没有内容哦~',
    url: '已打开剪贴板里的网址~ 🌐',
    folder: '已打开该文件夹~ 📂',
    file: '已在资源管理器中定位该文件~ 📁',
    invalid: '剪贴板里没有有效路径 😢',
  };
  showBubble(msgs[r] || msgs.invalid, 2200);
}

let autoStart = true;
async function toggleAutoStart() {
  const res = await petAPI.setAutoStart(!autoStart);
  if (typeof res === 'boolean') autoStart = res; // null=操作失败，保持原状态显示
  syncMenuStates();
  showBubble(autoStart ? '开机自启已开启，下次开机我自动出现~ 🚀' : '开机自启已关闭', 1800);
}

async function eatFiles(files) {
  const paths = files.map((f) => petAPI.getPathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  lastInteraction = performance.now();
  if (sleeping) wakeUp(false); // 睡着了也能投喂，先叫醒
  pendingAction = null; // 投喂是新意图，丢弃排队的动作
  const names = files.map((f) => f.name);
  const label = names.length > 1 ? `${names.length} 个文件` : `「${truncate(names[0], 12)}」`;
  showBubble(`啊呜~ 吃掉 ${label} 🍽️`, 1600);
  anim.chompActive = true;
  anim.chompStart = performance.now();
  anim.chompDuration = 1.4;
  await sleep(1500);
  const results = await petAPI.trashItems(paths);
  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  spawnCrumbs(6);
  if (fail === 0) {
    showBubble(`已经丢进回收站啦 🗑️✨`, 2200);
  } else {
    atlasPlay('failed', 2600); // 图集皮肤：沮丧动画
    showBubble(`吃掉了 ${ok} 个，${fail} 个没吃下 😢`, 2600);
  }
}

// ---------- 菜单（窗口内：菜单渲染在桌宠窗口左侧透明区，不遮挡浏览器，不暂停视频） ----------
let menuOpen = false;
const menu = document.getElementById('menu');
const autostartState = document.getElementById('autostart-state');

// 菜单里的「开/关」状态显示跟随实际状态
function syncMenuStates() {
  if (autostartState) autostartState.textContent = autoStart ? '开' : '关';
}

// 窗口内定位菜单：优先放人物左侧（右撇子，右侧留给屏幕边缘操作），放不下再右侧/上下
function showMenu(x, y) {
  menu.classList.remove('hidden');
  const mw = menu.offsetWidth || 200;
  const mh = menu.offsetHeight || 260;
  const pr = pet.getBoundingClientRect();
  const petLeft = pr.left, petTop = pr.top, petW = pr.width, petH = pr.height;
  const maxX = stage.offsetWidth - mw - 4, maxY = stage.offsetHeight - mh - 4;
  const overlaps = (L, T) => !(L + mw < petLeft || L > petLeft + petW || T + mh < petTop || T > petTop + petH);
  let mx = clamp(x, 4, maxX);
  let my = clamp(y, 4, maxY);
  if (overlaps(mx, my)) {
    const candTop = clamp(y - mh / 2, 4, maxY);
    const candLeft = clamp(petLeft - mw - 10, 4, maxX);    // 人物左侧（优先）
    const candRight = clamp(petLeft + petW + 10, 4, maxX); // 人物右侧（兜底）
    if (!overlaps(candLeft, candTop)) { mx = candLeft; my = candTop; }
    else if (!overlaps(candRight, candTop)) { mx = candRight; my = candTop; }
  }
  menu.style.left = Math.round(mx) + 'px';
  menu.style.top = Math.round(my) + 'px';
}

// 关闭菜单：通知主进程恢复“永不抢焦点”
function hideMenu() {
  if (menu.classList.contains('hidden')) return;
  menu.classList.add('hidden');
  menuOpen = false;
  try { petAPI.menuClosed(); } catch (_) {}
}

// 隐藏桌宠：说句再见再藏到托盘（托盘图标可唤回）
function hidePet() {
  hideMenu();
  showBubble('我藏起来啦，想我的时候点托盘图标~ 🙈', 1300);
  spawnSparkles(4);
  setTimeout(() => { try { petAPI.hidePet(); } catch (_) {} }, 700); // 让气泡说完再消失
}

// 执行菜单动作
function runMenuAction(action) {
  switch (action) {
    case 'deepseek': openDeepseek(); break;
    case 'dsh': launchDsh(); break;
    case 'clipboard': openClipboardPath(); break;
    case 'media-play-pause': mediaControl('play-pause', '⏯ 已发送（先播放音乐才能控制哦）'); break;
    case 'media-prev': mediaControl('prev', '⏮ 已发送上一首'); break;
    case 'media-next': mediaControl('next', '⏭ 已发送下一首'); break;
    case 'skin': renderSkinList(); skinsPanel.classList.remove('hidden'); setMouseIgnore(false); break;
    case 'autostart': toggleAutoStart(); break;
    case 'dance': dance(); break;
    case 'about': about.classList.remove('hidden'); setMouseIgnore(false); break;
    case 'hide': hidePet(); break;
    case 'quit': petAPI.quit(); break;
  }
}

menu.addEventListener('click', (e) => {
  const item = e.target.closest('.menu-item, .mini-btn, .web-btn, .site-more-item');
  if (!item) return;
  const action = item.dataset.action;
  if (action === 'sites-more') { toggleSitesMore(); return; } // 展开/收起二级菜单，不关闭菜单
  if (action === 'sites-more-back') { toggleSitesMore(true); return; } // 返回上一级
  if (action === 'sites-manage') { hideMenu(); openSitesManager(); return; }
  hideMenu();
  if (action === 'open-web') {
    try { petAPI.openWeb(item.dataset.url); } catch (_) {}
    return;
  }
  runMenuAction(action);
});

// ---------- 网站快捷入口（一级常用网格 / 二级更多列表，可自定义） ----------
let sites = { frequent: [], more: [] };

// 渲染右键菜单里的快捷入口区（一级网格 + 二级列表 + 计数）
function renderSitesMenu() {
  const grid = document.getElementById('sites-grid');
  const frequent = sites.frequent || [];
  if (frequent.length) {
    grid.innerHTML = frequent.map((s) => {
      const domain = domainOf(s.url);
      return '<button class="web-btn" data-action="open-web" data-url="' + esc(s.url) + '" data-domain="' + esc(domain) + '" title="' + esc(s.name) + '">' +
        '<span class="web-ico-wrap"><img class="web-ico" alt="" loading="lazy" src="https://' + esc(domain) + '/favicon.ico"><span class="web-emoji">🌐</span></span>' +
        '<span class="web-name">' + esc(s.name) + '</span></button>';
    }).join('');
  } else {
    grid.innerHTML = '<div style="grid-column:1/-1;padding:4px 2px 6px;font-size:11px;color:#8aa0bd;text-align:center;">还没有常用网站，点下方「管理网站」添加~</div>';
  }
  grid.querySelectorAll('.web-ico').forEach((img) => setupFavicon(img, img.dataset.domain));

  const more = sites.more || [];
  const countEl = document.getElementById('sites-more-count');
  countEl.textContent = more.length;
  const box = document.getElementById('sites-more-box');
  box.innerHTML = '<div class="sites-more-back" data-action="sites-more-back">← 返回上一级</div>' +
    more.map((s) => {
      const domain = domainOf(s.url);
      return '<div class="site-more-item" data-action="open-web" data-url="' + esc(s.url) + '" title="' + esc(s.url) + '">' +
        '<span class="web-ico-wrap"><img class="web-ico" alt="" loading="lazy" src="https://' + esc(domain) + '/favicon.ico"><span class="web-emoji">🌐</span></span>' +
        '<span>' + esc(s.name) + '</span></div>';
    }).join('');
  box.querySelectorAll('.web-ico').forEach((img) => setupFavicon(img, img.dataset.domain));
}

// 二级菜单展开/收起（forceClose=true 时强制收起）
function toggleSitesMore(forceClose) {
  const box = document.getElementById('sites-more-box');
  const toggle = document.getElementById('sites-more-toggle');
  const opening = forceClose ? false : box.classList.contains('hidden');
  box.classList.toggle('hidden', !opening);
  toggle.classList.toggle('open', opening);
}

// 管理面板（打开时窗口临时可聚焦：输入框才能打字，点外面失焦自动关闭）
function openSitesManager() {
  renderSitesManager();
  sitesManager.classList.remove('hidden');
  setMouseIgnore(false);
  try { petAPI.menuOpened(); } catch (_) {} // 临时可聚焦（复用菜单的焦点策略）
}
function closeSitesManager() {
  sitesManager.classList.add('hidden');
  document.getElementById('sm-name').value = '';
  document.getElementById('sm-url').value = '';
  try { petAPI.menuClosed(); } catch (_) {} // 恢复“永不抢焦点”
}
function renderSitesManager() {
  const box = document.getElementById('sites-list');
  let html = '';
  const groups = [['frequent', '⭐ 常用（一级）'], ['more', '📂 更多（二级）']];
  for (const [key, title] of groups) {
    const list = sites[key] || [];
    html += '<div class="sm-group-title">' + title + '（' + list.length + '）</div>';
    if (!list.length) { html += '<div style="padding:4px 10px;color:#8aa0bd;font-size:11px;">（空）</div>'; continue; }
    list.forEach((s, i) => {
      const domain = domainOf(s.url);
      html += '<div class="site-row" data-level="' + key + '" data-idx="' + i + '">' +
        '<span class="web-ico-wrap"><img class="web-ico" alt="" loading="lazy" src="https://' + esc(domain) + '/favicon.ico" data-domain="' + esc(domain) + '"><span class="web-emoji">🌐</span></span>' +
        '<div class="sr-info"><div class="sr-name">' + esc(s.name) + '</div><div class="sr-url">' + esc(s.url) + '</div></div>' +
        '<div class="sr-actions">' +
        '<button class="sr-btn" data-act="up" title="上移"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button class="sr-btn" data-act="down" title="下移"' + (i === list.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button class="sr-btn" data-act="move" title="移到另一级">⇄</button>' +
        '<button class="sr-btn del" data-act="del" title="删除">✕</button>' +
        '</div></div>';
    });
  }
  box.innerHTML = html;
  box.querySelectorAll('.web-ico').forEach((img) => setupFavicon(img, img.dataset.domain));
}

// 管理面板操作：上移/下移/移到另一级/删除
document.getElementById('sites-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.sr-btn');
  if (!btn || btn.disabled) return;
  const row = btn.closest('.site-row');
  const level = row.dataset.level;
  const idx = Number(row.dataset.idx);
  const list = sites[level];
  const act = btn.dataset.act;
  if (act === 'up' && idx > 0) { [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]]; }
  else if (act === 'down' && idx < list.length - 1) { [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]]; }
  else if (act === 'del') { list.splice(idx, 1); }
  else if (act === 'move') {
    const target = level === 'frequent' ? 'more' : 'frequent';
    sites[target].push(list.splice(idx, 1)[0]);
  }
  sites = await petAPI.setSites(sites);
  renderSitesManager();
  renderSitesMenu();
});

// 添加网站
document.getElementById('sm-add-btn').addEventListener('click', async () => {
  const name = document.getElementById('sm-name').value.trim();
  let url = document.getElementById('sm-url').value.trim();
  const level = document.getElementById('sm-level').value;
  if (!name || !url) { showBubble('名称和网址都要填哦~', 1600); return; }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (!/^https?:\/\/.+\..+/i.test(url)) { showBubble('网址格式不对哦~', 1600); return; }
  sites[level].push({ name, url });
  sites = await petAPI.setSites(sites);
  document.getElementById('sm-name').value = '';
  document.getElementById('sm-url').value = '';
  renderSitesManager();
  renderSitesMenu();
  showBubble('已添加「' + truncate(name, 10) + '」~ ✅', 1600);
});

// 管理面板：「← 返回」/「完成」都关闭面板（返回上一级）
sitesManager.querySelector('.sm-back').addEventListener('click', () => closeSitesManager());
sitesManager.querySelector('.about-close').addEventListener('click', () => closeSitesManager());

// 主进程检测到窗口失焦（点桌面/其他窗口）时发来关闭指令
try { petAPI.onMenuDismiss(() => hideMenu()); } catch (_) {}

document.getElementById('about').querySelector('.about-close').addEventListener('click', () => {
  about.classList.add('hidden');
});

// ---------- 交互 ----------
let dragging = false, moved = false, downX = 0, downY = 0, clickTimer = null;
let dragStartScreen = null, pendingDrag = null, dragRaf = 0, dragLogCount = 0;
let lastScreen = null; // 上一个事件的光标屏幕位置（用于方向判定）
let desktopBounds = null; // 主进程下发的桌面边界（日志用）

function isOverPetSprite(cx, cy) {
  // 浏览器自身的命中检测：窗口外的“幽灵按下”（残留指针捕获）命中不到任何元素
  const hit = document.elementFromPoint(cx, cy);
  if (hit !== sprite && hit !== spriteCanvas && hit !== pet) return false;
  if (!currentMask) return true; // 无法判定时保持旧行为
  const el = atlas.active ? spriteCanvas : sprite;
  const rect = el.getBoundingClientRect();
  if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) return false;
  let mx = Math.floor(((cx - rect.left) / rect.width) * currentMask.w);
  const my = Math.floor(((cy - rect.top) / rect.height) * currentMask.h);
  if (mx < 0 || mx >= currentMask.w || my < 0 || my >= currentMask.h) return false;
  if (atlas.mirrored) mx = currentMask.w - 1 - mx; // 镜像帧的蒙版也要水平翻转
  return currentMask.mask[my * currentMask.w + mx] === 1;
}

pet.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  // 菜单/面板打开时：点任何地方（含宠物）只关闭它们，不触发拖动/戳戳
  if (menuOpen || !skinsPanel.classList.contains('hidden') || !about.classList.contains('hidden') || !sitesManager.classList.contains('hidden')) {
    hideMenu();
    skinsPanel.classList.add('hidden');
    about.classList.add('hidden');
    closeSitesManager();
    return;
  }
  // 精确校验：按下点必须命中宠物元素且落在角色可见身体上
  if (!isOverPetSprite(e.clientX, e.clientY)) {
    petAPI.log('忽略非身体按下 client=(' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ')');
    return;
  }
  lastInteraction = performance.now();
  if (sleeping) wakeUp(false); // 拖/点都先把人叫醒（戳戳随后会说话）
  pendingAction = null; // 拖拽是新意图，丢弃排队的动作
  dragging = true;
  moved = false;
  downX = e.clientX; downY = e.clientY;
  dragStartScreen = { x: e.screenX, y: e.screenY };
  lastScreen = { x: e.screenX, y: e.screenY };
  dragLogCount = 0;
  targetLift = 1.06;
  setMouseIgnore(false); // 拖动期间窗口必须可点击
  try { pet.setPointerCapture(e.pointerId); } catch (_) {}
  petAPI.dragStart();
  petAPI.log('drag-start screen=(' + e.screenX + ',' + e.screenY + ') viewport=' + window.innerWidth + 'x' + window.innerHeight + ' win=(' + window.screenX + ',' + window.screenY + ')');
});

function flushDragMove() {
  dragRaf = 0;
  if (!dragging || !pendingDrag) return;
  const d = pendingDrag;
  pendingDrag = null;
  petAPI.dragMove(Math.round(d.dx), Math.round(d.dy));
}

window.addEventListener('pointermove', (e) => {
  if (!dragging || !dragStartScreen) return;
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 3) moved = true;
  // 方向判定：用屏幕坐标增量（movementX 在这台机器上不可靠）
  if (lastScreen) {
    if (e.screenX > lastScreen.x + 1) atlas.dragDir = 1;
    else if (e.screenX < lastScreen.x - 1) atlas.dragDir = -1;
    lastScreen = { x: e.screenX, y: e.screenY };
  }
  // 屏幕坐标绝对位移（相对按下点）：不受窗口自身移动影响，无反馈环
  pendingDrag = { dx: e.screenX - dragStartScreen.x, dy: e.screenY - dragStartScreen.y };
  if (++dragLogCount % 15 === 0) {
    petAPI.log('drag-move screen=(' + Math.round(e.screenX) + ',' + Math.round(e.screenY) + ') dx=' + Math.round(pendingDrag.dx) + ' dy=' + Math.round(pendingDrag.dy));
  }
  if (!dragRaf) dragRaf = requestAnimationFrame(flushDragMove);
});

function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; }
  pendingDrag = null;
  targetLift = 1;
  // 关键：显式释放指针捕获，避免残留捕获导致后续“幽灵拖动”
  try { pet.releasePointerCapture(e.pointerId); } catch (_) {}
  try { petAPI.dragEnd(); } catch (_) {} // 通知主进程清空拖动状态（此前一直漏发，主进程 drag 状态残留）
  if (moved) petAPI.log('drag-end win=(' + Math.round(window.screenX) + ',' + Math.round(window.screenY) + ')');
  anim.bounceV = -4; // 轻轻落地弹一下
  if (lastMouse) updateClickThrough(lastMouse.x, lastMouse.y);
  if (!moved) {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; } // 交给双击
    clickTimer = setTimeout(() => { poke(); clickTimer = null; }, 260);
  }
}

window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

pet.addEventListener('dblclick', () => openDeepseek());

// 悬停时身体朝光标倾斜
let lastWaveAt = 0; // 悬停打招呼冷却
stage.addEventListener('mousemove', (e) => {
  const cx = e.clientX - stage.offsetWidth / 2;
  targetTilt = clamp(cx / 140, -8, 8);
  // 鼠标动作：悬停在宠物身上 → 打招呼（20 秒冷却；睡觉/拖动/咀嚼/已有动作时不触发）
  const t = performance.now();
  if (!sleeping && !dragging && !anim.chompActive && t - lastWaveAt > 20000 && atlasHas('waving') && isOverPetSprite(e.clientX, e.clientY)) {
    lastWaveAt = t;
    playAction('waving', 1200); // 播放中则排队，播完再挥手
  }
});
stage.addEventListener('mouseleave', () => { targetTilt = 0; });

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  lastInteraction = performance.now();
  if (sleeping) wakeUp(false); // 右键叫醒但不出气泡（菜单动作自己会说话）
  renderSitesMenu();            // 刷新快捷入口（一级/二级）与计数
  document.getElementById('sites-more-box').classList.add('hidden');
  document.getElementById('sites-more-toggle').classList.remove('open');
  showMenu(e.clientX, e.clientY); // 窗口内坐标，菜单定位到人物左侧
  menuOpen = true;
  syncMenuStates();
  try { petAPI.menuOpened(); } catch (_) {} // 临时可聚焦：点窗口外触发失焦 → 关闭菜单
});

// 点菜单/面板外的空白处关闭（菜单：点任意非菜单区域即取消）
stage.addEventListener('mousedown', (e) => {
  if (menuOpen && !e.target.closest('#menu')) hideMenu();
  if (!skinsPanel.classList.contains('hidden') && !e.target.closest('#skins')) skinsPanel.classList.add('hidden');
  if (!about.classList.contains('hidden') && !e.target.closest('#about')) about.classList.add('hidden');
  if (!sitesManager.classList.contains('hidden') && !e.target.closest('#sites-manager')) closeSitesManager();
});
window.addEventListener('blur', () => {
  hideMenu();
  about.classList.add('hidden');
  skinsPanel.classList.add('hidden');
  closeSitesManager();
});

// 菜单打开时窗口临时可聚焦：光标移出窗口会触发 blur（由主进程兜底），这里再兜一层
document.addEventListener('mouseleave', () => {
  hideMenu();
  about.classList.add('hidden');
  skinsPanel.classList.add('hidden');
  closeSitesManager();
});

// ---------- 拖文件进食（垃圾桶） ----------
let dropHintShown = false; // 悬停期间提示气泡只弹一次
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  stage.classList.add('dropping');
  if (!anim.chompActive && !dropHintShown) {
    dropHintShown = true;
    showBubble('快丢进来，我帮你吃掉~ 🗑️', Infinity);
  }
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) {
    stage.classList.remove('dropping');
    dropHintShown = false;
    hideBubble();
  }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('dropping');
  dropHintShown = false;
  const files = Array.from(e.dataTransfer.files || []);
  if (files.length) eatFiles(files);
  else hideBubble();
});

// ---------- 随机闲聊 ----------
const tips = [
  '双击我可以打开 DeepSeek 网页版~',
  '把文件拖到我身上，我帮你丢进回收站~ 🗑️',
  '右键我可以看到功能菜单~',
  '我是小深，你的专属桌宠~ 💙',
  '需要启动 dsh？右键菜单里有哦~',
];
function scheduleTip() {
  setTimeout(() => {
    if (!dragging && !anim.chompActive && !sleeping) showBubble(pick(tips), 3200);
    scheduleTip();
  }, 28000 + Math.random() * 26000);
}

// ---------- 启动 ----------
(async function init() {
  try { petAPI.log('renderer init 开始, petAPI 可用'); } catch (e) { console.error('petAPI 不可用', e); }
  // 诊断：如果图片仍然加载失败，用气泡把原因显示出来
  sprite.addEventListener('error', () => {
    const src = String(sprite.src || '');
    showBubble('图片加载失败 😢 ' + (src.startsWith('data:') ? '[' + src.length + '字节 data URL]' : src), 6000);
    try { petAPI.log('sprite error, src=' + (src.startsWith('data:') ? 'dataUrl(' + src.length + ')' : src)); } catch (_) {}
  });

  // 读取皮肤数据与配置
  try {
    const skins = await petAPI.getSkins();
    skinsBase = skins.base;
    importedSkins = skins.imported || [];
    currentSkinId = skins.current || 'classic';
    const cfg = await petAPI.getConfig();
    autoStart = !!cfg.autoStart;
    desktopBounds = await petAPI.getBounds();
    try { sites = await petAPI.getSites(); } catch (_) {}
    renderSitesMenu(); // 快捷入口（一级网格 / 二级列表 / 计数）
    petAPI.log('皮肤/配置加载完成, current=' + currentSkinId + ', autoStart=' + autoStart + ', bounds=' + JSON.stringify(desktopBounds));
    syncMenuStates(); // 菜单里的开/关显示与真实状态一致
  } catch (err) {
    petAPI.log('读取皮肤/配置异常: ' + err);
    console.error(err);
  }

  if (!skinsBase) {
    showBubble('立绘没加载出来 😢');
    return;
  }

  // 探测导入皮肤中哪些是图集动画（用于皮肤列表的 🎬 标记）
  for (const imp of importedSkins) {
    try {
      const size = await probeImageSize(imp.dataUrl);
      importedAtlas[imp.id] = !!(size && size.w === ATLAS_W && size.h === ATLAS_H);
    } catch (_) { importedAtlas[imp.id] = false; }
  }

  // 应用当前皮肤（图集皮肤会切到真帧动画模式）
  try {
    petAPI.log('应用皮肤开始... skin=' + currentSkinId);
    await applySkin(currentSkinId, true);
    petAPI.log('应用皮肤完成: ' + currentSkinId + ' atlas=' + atlas.active);
  } catch (err) {
    petAPI.log('应用皮肤异常: ' + err);
    console.error(err);
    sprite.src = skinsBase;
    currentMask = null;      // 无法判定透明区域时保持窗口可点击
    setMouseIgnore(false);
  }

  nextIdleAt = performance.now() + 12000;
  requestAnimationFrame(tick);
  scheduleTip();
  showBubble('你好呀，我是小深~ 💙', 2600);
  window.__petReady = true; // 自检模式（--selftest）的初始化完成标记
})();
