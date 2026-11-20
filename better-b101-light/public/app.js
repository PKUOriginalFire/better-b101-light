'use strict';

/* ============================ 状态 ============================ */
const S = {
  cfg: null,
  fixtures: [],
  groups: [],
  palette: [],
  sel: new Set(),
  anchor: null,
  dim: 100,
  fade: 0,
  delay: 0,
  col: { h: 30, s: 80, v: 100, w: 0, temp: 50, tempLock: false },
  effect: null,
  speed: 8,
  duration: 0,
  fxEndsAt: 0,
  connected: false,
  black: false,
  scenes: [],
  rgbFmt: 'pct',
  cues: [],
  cue: { cue: 0, running: false, nextAt: 0, count: 0 },
  show: null,
  auto: { ms: 300000, timer: null, data: null },
};

const GROUP_LABEL = {
  'Facelight L': '面光左', 'Facelight R': '面光右', 'Facelight': '面光',
  'Crosslight L': '耳光左', 'Crosslight R': '耳光右', 'Crosslight': '耳光',
  'Toplight Front': '顶光前', 'Toplight Rear': '顶光后', 'Toplight': '顶光',
  'All': '全部',
};

const FX = [
  { id: 'breathe', label: '呼吸' },
  { id: 'pulse', label: '心跳' },
  { id: 'strobe', label: '频闪' },
  { id: 'chase', label: '追逐' },
  { id: 'wave', label: '波浪' },
  { id: 'random', label: '随机' },
  { id: 'rainbow', label: '彩虹' },
  { id: 'colorcycle', label: '轮转' },
];

/* 每个效果的实现细节：周期、亮度范围、每帧下发的命令 */
const FX_INFO = {
  breathe: {
    t: '呼吸',
    d: '整组灯一起明暗起伏，像深呼吸一样平滑，没有硬切。',
    rows: [
      ['怎么动', '亮度按正弦曲线在 10% – 100% 之间来回，中间快、两头慢。'],
      ['周期', '周期 = 4 ÷ (v ÷ 8) 秒，夹在 0.6–8 秒：v=8 → 4 秒（亮 2 秒、暗 2 秒）；v=20 → 1.6 秒；v≤4 → 8 秒封顶。'],
      ['下发', '每帧把选中的灯按亮度分档合并，变成一条 <code>Fixture 21 Thru 33 At 60</code>。'],
    ],
  },
  pulse: {
    t: '心跳',
    d: '一下顶到最亮，再拖着尾巴暗下去，像一次心跳。',
    rows: [
      ['怎么动', '从 100% 起步，按 (1−t)^2.2 衰减到 0——开头掉得快，后面拖得长。'],
      ['周期', '跟呼吸同一套：v=8 → 4 秒一次；v=20 → 1.6 秒；v≤4 → 8 秒。'],
      ['下发', '每帧一条 <code>Fixture … At &lt;亮度&gt;</code>。'],
    ],
  },
  strobe: {
    t: '频闪',
    d: '全体同时亮灭的硬闪，不做渐变，适合打击点。',
    rows: [
      ['怎么动', '每个周期里 45% 的时间全亮（100%），55% 全灭（0%）。'],
      ['频率', '每秒闪 v 下：v=8 每秒 8 下，v=20 每秒 20 下，v=1 每秒 1 下。'],
      ['下发', '亮帧 <code>Fixture … At 100</code>，灭帧 <code>Fixture … At 0</code>。'],
    ],
  },
  chase: {
    t: '追逐',
    d: '一盏灯亮着沿选灯顺序跑，像跑马灯，前后各留一点余晖。',
    rows: [
      ['怎么动', '当前这盏 100%、左右相邻各 35%、其余 0；每帧往后挪一盏，跑完一轮空 3 帧再来。'],
      ['速度', '每秒挪 v 盏。13 台顶光、v=8 时一圈约 (13+3)÷8 ≈ 2 秒。'],
      ['下发', '每帧 2–3 条亮度命令（按 5% 分档合并）。'],
    ],
  },
  wave: {
    t: '波浪',
    d: '亮度像水波一样沿灯排依次起伏，波峰从第一台推到最后一台。',
    rows: [
      ['怎么动', '每台灯按 sin(2π(位置 + 时间)) 取 0–100%，相邻灯有固定相位差。'],
      ['周期', '一波固定 14 帧 = 14 ÷ v 秒：v=8 → 1.75 秒；v=20 → 0.7 秒；v=1 → 14 秒。'],
      ['下发', '按亮度分档合并成几条 <code>Fixture … At …</code>。'],
    ],
  },
  random: {
    t: '随机',
    d: '没有节奏可言的随机闪，适合热闹的段落。',
    rows: [
      ['怎么动', '每帧每台灯 35% 概率直接 100%，否则在 0–20% 里随机取值。'],
      ['速度', '每秒重新抽 v 次：v 越高越碎，越低越像零星点缀。'],
      ['下发', '分档合并后的 <code>Fixture … At …</code>。'],
    ],
  },
  rainbow: {
    t: '彩虹',
    d: '颜色沿灯排铺成一条彩虹，并整体缓慢转动。',
    rows: [
      ['参与', '只有 38 台彩色灯（1–6、15–20、21–33、34–46）；7–14 是色温灯，不参与。'],
      ['怎么动', '色相沿选灯顺序铺开 300°，整体每秒转 90°（4 秒转一圈）；量化成 6 个 60° 色段，同段合并成一条命令。'],
      ['与 v 的关系', '转色速度固定 90°/秒，跟 v 无关；v 只决定换帧的粗细。'],
      ['下发', '每段一条 <code>Fixture …</code> + 三条 <code>Attribute "COLORRGB1/2/3" At …</code>。'],
    ],
  },
  colorcycle: {
    t: '轮转',
    d: '整组灯同一个颜色，缓慢循环换色。',
    rows: [
      ['参与', '只作用 38 台彩色灯，色温灯保持原样不动。'],
      ['怎么动', '色相每秒转 40°，9 秒走完一圈：红 → 黄 → 绿 → 青 → 蓝 → 品 → 红。'],
      ['与 v 的关系', '转色速度固定 40°/秒，跟 v 无关。'],
      ['下发', '每帧一条 <code>Fixture …</code> + 三条颜色属性命令。'],
    ],
  },
};

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

/* ============================ 颜色 ============================ */
function hsv2rgb(h, s, v) {
  h = ((h % 360) + 360) % 360; s /= 100; v /= 100;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return { r: Math.round((r + m) * 100), g: Math.round((g + m) * 100), b: Math.round((b + m) * 100) };
}

function rgb2hsv(r, g, b) {
  r /= 100; g /= 100; b /= 100;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h: Math.round(h), s: Math.round((max ? d / max : 0) * 100), v: Math.round(max * 100) };
}

const toHex = ({ r, g, b }) => '#' + [r, g, b].map(x => Math.round(x * 2.55).toString(16).padStart(2, '0')).join('').toUpperCase();

const hex2 = pct => Math.round(Math.min(100, Math.max(0, pct)) * 2.55).toString(16).padStart(2, '0').toUpperCase();

/** 用户在某个进制下输入的单通道值 → 控台的 0–100 */
function chanPct(raw) {
  const t = String(raw).trim();
  if (S.rgbFmt === 'hex') {
    const n = parseInt(t.replace(/^#/, ''), 16);
    return Number.isFinite(n) ? Math.min(255, Math.max(0, n)) / 2.55 : 0;
  }
  const n = Number(t);
  if (!Number.isFinite(n)) return 0;
  return S.rgbFmt === '255' ? Math.min(255, Math.max(0, n)) / 2.55 : Math.min(100, Math.max(0, n));
}

/** 控台值 → 当前进制下显示的数字 */
function chanDisp(pct) {
  if (S.rgbFmt === 'hex') return hex2(pct);
  return S.rgbFmt === '255' ? Math.round(pct * 2.55) : Math.round(pct);
}

function curRGB() { return hsv2rgb(S.col.h, S.col.s, S.col.v); }

/** 色相 → 色温，让暖色灯也跟着整体色调走 */
function tempFromHue(h, s) {
  if (s < 12) return 50;
  if (h < 60 || h > 330) return 8;
  if (h < 90) return 25;
  if (h >= 170 && h <= 270) return 95;
  if (h > 270 && h <= 330) return 70;
  return 50;
}

/** 实际下发的色温：手动拖过就用手动值 */
function effTemp() {
  return S.col.tempLock ? S.col.temp : tempFromHue(S.col.h, S.col.s);
}

/* ============================ 通信 ============================ */
let sendTimer = null;

async function post(url, body) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) {
    flash('网络错误：' + e.message);
  }
}

function selectedIds() { return [...S.sel].sort((a, b) => a - b); }

function rgbPayload() {
  const c = curRGB();
  return {
    r: c.r, g: c.g, b: c.b,
    w: S.col.w,
    temp: effTemp(),
  };
}

function pushLook({ color = true, dim = true, throttle = 60 } = {}) {
  clearTimeout(sendTimer);
  sendTimer = setTimeout(() => {
    const ids = selectedIds();
    if (!ids.length) return flash('没有选中灯具');
    const body = { ids };
    if (dim) body.dim = S.dim;
    if (color) body.rgb = rgbPayload();
    if (dim || color) { body.fade = S.fade; body.delay = S.delay; }
    post('/api/look', body);
    paintLocal();
  }, throttle);
}

/* ============================ 舞台平面 ============================ */
function renderPlan() {
  const svg = $('#plot');
  const W = 640, H = 520, PAD = 46;
  const xs = S.fixtures.map(f => f.x ?? 0), ys = S.fixtures.map(f => f.y ?? 0);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const sx = x => PAD + (x - minX) / (maxX - minX || 1) * (W - PAD * 2);
  const sy = y => PAD + (maxY - y) / (maxY - minY || 1) * (H - PAD * 2);

  let out = `
    <defs>
      <filter id="glow" x="-80%" y="-80%" width="260%" height="260%">
        <feGaussianBlur stdDeviation="6" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <linearGradient id="stagefill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#191924" stop-opacity="0.55"/>
        <stop offset="100%" stop-color="#0e0e15" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect x="12" y="12" width="${W - 24}" height="${H - 24}" rx="10" fill="url(#stagefill)" stroke="#232331"/>`;

  // 区域分隔线：面光 / 耳光 / 顶光
  const bandY = (y0, y1, label) => {
    const a = sy(y0), b = sy(y1);
    return `<line x1="12" y1="${(a + b) / 2}" x2="${W - 12}" y2="${(a + b) / 2}"
      stroke="#1e1e2a" stroke-dasharray="3 8"/>
      <text x="${W - 22}" y="${(a + b) / 2 - 6}" fill="#3a3a48" font-size="9"
        text-anchor="end" letter-spacing="2">${label}</text>`;
  };
  out += bandY(minY, minY + (maxY - minY) * 0.28, '面光');
  out += bandY(minY + (maxY - minY) * 0.28, minY + (maxY - minY) * 0.62, '耳光');
  out += bandY(minY + (maxY - minY) * 0.62, maxY, '顶光');

  for (const f of S.fixtures) {
    const x = sx(f.x ?? 0), y = sy(f.y ?? 0);
    const on = S.sel.has(f.id);
    const st = f.state || { dim: 0 };
    const col = f.model === 'rgbw' ? (f.state ? f.state.css : '#2b2b38') : '#2b2b38';
    const fill = st.dim > 0 ? col : '#232331';
    const stroke = on ? '#f5a524' : '#333342';
    const sw = on ? 2.4 : 1;
    const shape = f.model === 'rgbw'
      ? `<rect x="${x - 11}" y="${y - 11}" width="22" height="22" rx="5" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" ${st.dim > 0 ? 'filter="url(#glow)"' : ''}/>`
      : `<circle cx="${x}" cy="${y}" r="11" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" ${st.dim > 0 ? 'filter="url(#glow)"' : ''}/>`;
    out += `<g class="lamp" data-id="${f.id}" style="cursor:pointer">${shape}
      <text x="${x}" y="${y + 3.6}" text-anchor="middle" font-size="9"
        fill="${st.dim > 0 ? '#0d0d12' : '#6d6d80'}" font-weight="600" pointer-events="none">${f.id}</text></g>`;
  }
  svg.innerHTML = out;
}

/* 实时预览：把服务端算出来的每台灯（亮度 + 颜色）画到平面图上 */
const LIVE = { on: false, at: 0 };

function rgbCss(r, g, b, w) {
  const add = (c, extra) => Math.round(Math.min(255, (Number(c) || 0) * 2.55 + (Number(extra) || 0) * 2.55));
  return `rgb(${add(r, w)},${add(g, w)},${add(b, w)})`;
}

function applyLive(values) {
  if (!values || !values.length) return;
  LIVE.on = true;
  LIVE.at = Date.now();
  const tag = $('#liveTag');
  if (tag) tag.classList.remove('hidden');
  const seen = new Set();
  for (const row of values) {
    const [id, dim, r, g, b, w, temp] = row;
    seen.add(id);
    const f = S.fixtures.find(x => x.id === id);
    if (!f) continue;
    const css = f.model === 'rgbw' ? rgbCss(r, g, b, w) : tempCss(temp);
    f.state = { dim, css };
  }
  for (const f of S.fixtures) if (!seen.has(f.id)) f.state = { dim: 0 };
  renderPlan();
}

function clearLive() {
  LIVE.on = false;
  const tag = $('#liveTag');
  if (tag) tag.classList.add('hidden');
  for (const f of S.fixtures) f.state = null;
  paintLocal();
}

function paintLocal() {
  const c = curRGB();
  for (const id of S.sel) {
    const f = S.fixtures.find(x => x.id === id);
    if (!f) continue;
    const dim = S.dim;
    let css;
    if (f.model === 'rgbw') css = `rgb(${c.r * 2.55},${c.g * 2.55},${c.b * 2.55})`;
    else css = tempCss(effTemp());
    f.state = { dim, css, opacity: 0.25 + 0.75 * dim / 100 };
  }
  renderPlan();
  updateSelPill();
}

function tempCss(t) {
  const warm = [255, 168, 74], cool = [168, 205, 255];
  const k = t / 100;
  const c = warm.map((v, i) => Math.round(v + (cool[i] - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/* ============================ 选中 ============================ */
function setSel(ids, add = false) {
  if (!add) S.sel.clear();
  for (const id of ids) S.sel.add(id);
  updateSelPill();
  renderPlan();
  renderGroups();
}

function updateSelPill() {
  $('#selCount').textContent = S.sel.size;
  $('#selPill').classList.toggle('ghost', S.sel.size === 0);
}

/* ============================ 灯组 ============================ */
function renderGroups() {
  const box = $('#groups');
  const items = [{ id: null, label: '全部', fixtures: S.fixtures.map(f => f.id) }];
  for (const g of S.groups) {
    if (g.id === 14) continue; // 与 11 重复
    items.push({ id: g.id, label: GROUP_LABEL[g.name] || g.name, fixtures: g.fixtures });
  }
  box.innerHTML = items.map(it => {
    const on = S.sel.size === it.fixtures.length && it.fixtures.every(id => S.sel.has(id));
    return `<button class="chip ${on ? 'on' : ''}" data-group='${JSON.stringify(it.fixtures)}'>${it.label}</button>`;
  }).join('');
}

/* ============================ 色轮 ============================ */
const wheel = { canvas: null, ctx: null, size: 0, dragging: false };

function drawWheel() {
  const cv = wheel.canvas, ctx = wheel.ctx, n = wheel.size;
  const img = ctx.createImageData(n, n);
  const R = n / 2;
  const data = img.data;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = x - R + 0.5, dy = y - R + 0.5;
      const r = Math.hypot(dx, dy);
      const i = (y * n + x) * 4;
      if (r > R) { data[i + 3] = 0; continue; }
      const h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
      const s = Math.min(r / R, 1) * 100;
      const c = hsv2rgb(h, s, S.col.v);
      data[i] = c.r * 2.55; data[i + 1] = c.g * 2.55; data[i + 2] = c.b * 2.55;
      data[i + 3] = 255 * Math.min(1, (R - r) / 2 + 0.15);
    }
  }
  ctx.putImageData(img, 0, 0);
  drawMarker();
}

function drawMarker() {
  const ctx = wheel.ctx, n = wheel.size, R = n / 2;
  const rad = (S.col.s / 100) * (R - 6);
  const a = S.col.h * Math.PI / 180;
  const x = R + Math.cos(a) * rad, y = R + Math.sin(a) * rad;
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 9.5, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 2; ctx.stroke();
}

function initWheel() {
  const cv = $('#wheel');
  const dpr = window.devicePixelRatio || 1;
  const css = 200;
  wheel.size = Math.round(css * dpr);
  cv.width = wheel.size; cv.height = wheel.size;
  wheel.canvas = cv;
  wheel.ctx = cv.getContext('2d');
  drawWheel();

  const pick = e => {
    const rect = cv.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * wheel.size;
    const y = (e.clientY - rect.top) / rect.height * wheel.size;
    const R = wheel.size / 2;
    const dx = x - R, dy = y - R;
    const r = Math.min(Math.hypot(dx, dy), R - 2);
    let h = Math.atan2(dy, dx) * 180 / Math.PI;
    if (h < 0) h += 360;
    S.col.h = Math.round(h);
    S.col.s = Math.round(r / (R - 6) * 100);
    S.col.tempLock = false;
    syncColorUI();
    pushLook({ dim: false });
  };

  cv.addEventListener('pointerdown', e => { wheel.dragging = true; cv.setPointerCapture(e.pointerId); pick(e); });
  cv.addEventListener('pointermove', e => { if (wheel.dragging) pick(e); });
  cv.addEventListener('pointerup', () => { wheel.dragging = false; });
  cv.addEventListener('pointercancel', () => { wheel.dragging = false; });
}

/* ============================ 颜色 UI 同步 ============================ */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = v => (Math.round(v * 10) / 10).toString();

/** 写入控件值；正在输入的框不动，免得打断打字 */
function setVal(id, v) {
  const el = document.getElementById(id);
  if (!el || el === document.activeElement) return;
  el.value = v;
}

function syncColorUI() {
  const c = curRGB();
  setVal('h', S.col.h); setVal('hNum', S.col.h);
  setVal('s', S.col.s); setVal('sNum', S.col.s);
  setVal('v', S.col.v); setVal('vNum', S.col.v);
  const sv = pct => (S.rgbFmt === 'pct' ? Math.round(pct) : Math.round(pct * 2.55));
  setVal('cr', sv(c.r)); setVal('crNum', chanDisp(c.r));
  setVal('cg', sv(c.g)); setVal('cgNum', chanDisp(c.g));
  setVal('cb', sv(c.b)); setVal('cbNum', chanDisp(c.b));
  setVal('cw', S.col.w); setVal('cwNum', S.col.w);
  const t = effTemp();
  setVal('ct', t); setVal('ctNum', t);
  const hex = toHex(c);
  setVal('hexInput', hex);
  $('#swatch').style.background = hex;
  if (wheel.ctx) drawMarker();
}

/** 切换 RGB 输入的进制：百分制 / 0–255 / 十六进制 */
function applyRgbFmt(mode, silent = false) {
  S.rgbFmt = mode;
  $$('#rgbFmt button').forEach(b => b.classList.toggle('on', b.dataset.fmt === mode));
  const c = curRGB();
  for (const [sid, nid, pct] of [['cr', 'crNum', c.r], ['cg', 'cgNum', c.g], ['cb', 'cbNum', c.b]]) {
    const s = document.getElementById(sid), n = document.getElementById(nid);
    if (!s || !n) continue;
    if (mode === 'pct') {
      s.min = 0; s.max = 100; s.value = Math.round(pct);
      n.type = 'number'; n.min = 0; n.max = 100; n.value = Math.round(pct);
      n.removeAttribute('maxlength'); n.style.letterSpacing = '';
    } else if (mode === '255') {
      s.min = 0; s.max = 255; s.value = Math.round(pct * 2.55);
      n.type = 'number'; n.min = 0; n.max = 255; n.value = Math.round(pct * 2.55);
      n.removeAttribute('maxlength'); n.style.letterSpacing = '';
    } else {
      s.min = 0; s.max = 255; s.value = Math.round(pct * 2.55);
      n.type = 'text'; n.removeAttribute('min'); n.removeAttribute('max');
      n.maxLength = 2; n.value = hex2(pct); n.style.letterSpacing = '1px';
    }
    n.inputMode = mode === 'hex' ? 'text' : 'numeric';
  }
  if (!silent) localStorage.setItem(FMT_KEY, mode);
  syncColorUI();
}

/* ============================ 场景 / 存档 ============================ */
const SCENE_KEY = 'b101.scenes.v1';
const AUTO_KEY = 'b101.autosave.v1';
const FMT_KEY = 'b101.rgbFmt';
const AUTO_MS_KEY = 'b101.autosave.ms';
const AUTO_CHOICES = [0, 60000, 180000, 300000, 600000];

function snapshot() {
  return {
    ids: selectedIds(),
    dim: S.dim,
    col: { ...S.col },
    fade: S.fade,
    at: Date.now(),
  };
}

function loadScenes() {
  try { S.scenes = JSON.parse(localStorage.getItem(SCENE_KEY)) || []; } catch (_) { S.scenes = []; }
  while (S.scenes.length < 8) S.scenes.push(null);
  try { S.auto.data = JSON.parse(localStorage.getItem(AUTO_KEY)) || null; } catch (_) { S.auto.data = null; }
  const rawMs = localStorage.getItem(AUTO_MS_KEY);
  const ms = rawMs === null ? NaN : Number(rawMs);
  S.auto.ms = AUTO_CHOICES.includes(ms) ? ms : 300000;
  renderScenes();
  renderAutoSlot();
}

function renderScenes() {
  $('#scenes').innerHTML = S.scenes.map((sc, i) =>
    `<button class="scene ${sc ? 'filled' : ''}" data-i="${i}">${sc ? (sc.name || '场景 ' + (i + 1)) : (i + 1)}</button>`
  ).join('');
}

function saveScene(i, name) {
  const prev = S.scenes[i];
  const nm = String(name || '').trim() || (prev && prev.name) || `场景 ${i + 1}`;
  S.scenes[i] = { ...snapshot(), name: nm };
  localStorage.setItem(SCENE_KEY, JSON.stringify(S.scenes));
  renderScenes();
}

function saveAuto(name) {
  const prev = S.auto.data;
  const nm = String(name || '').trim() || (prev && prev.name) || '自动存档';
  S.auto.data = { ...snapshot(), name: nm };
  localStorage.setItem(AUTO_KEY, JSON.stringify(S.auto.data));
  renderAutoSlot();
}

function renderAutoSlot() {
  const el = $('#autoSlot');
  if (!el) return;
  const d = S.auto.data;
  if (!d || !d.ids) {
    el.classList.remove('filled');
    el.textContent = '自动存档 · 还没存过';
    return;
  }
  el.classList.add('filled');
  const t = new Date(d.at || Date.now());
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  el.innerHTML = `自动存档 · <b>${d.name || '自动存档'}</b> · ${hh}:${mm} · ${d.ids.length} 台 · ${Math.round(d.dim)}%　<span class="tiny">点击调用</span>`;
}

/** 把一份存档下发到控台并同步界面 */
function applyState(sc) {
  if (!sc || !Array.isArray(sc.ids)) return;
  S.sel = new Set(sc.ids);
  S.dim = Number.isFinite(sc.dim) ? sc.dim : 100;
  S.col = { h: 30, s: 80, v: 100, w: 0, temp: 50, tempLock: false, ...(sc.col || {}) };
  S.fade = Number.isFinite(sc.fade) ? sc.fade : 0;
  S.delay = 0;
  syncDimUI(); syncTimeUI(); syncColorUI();
  updateSelPill(); renderPlan(); renderGroups();
  if (sc.ids.length) {
    post('/api/look', { ids: sc.ids, dim: S.dim, rgb: rgbPayload(), fade: S.fade, delay: 0 });
  }
  paintLocal();
}

function recallScene(i) {
  const sc = S.scenes[i];
  if (!sc) return openSaveModal(i);
  applyState(sc);
}

/* ---- 保存弹窗 ---- */
let pendingSlot = null;
let scenePress = null;

function renderSlots() {
  const cells = [];
  for (let i = 0; i < 8; i++) {
    const sc = S.scenes[i];
    const sub = sc ? `${(sc.ids || []).length} 台 · ${Math.round(sc.dim)}%` : '空';
    cells.push(`<button class="slot ${pendingSlot === i ? 'on' : ''}" data-slot="${i}">${sc ? (sc.name || '场景 ' + (i + 1)) : '场景 ' + (i + 1)}<span>${sub}</span></button>`);
  }
  const a = S.auto.data;
  const asub = a && a.ids ? `${a.ids.length} 台 · ${Math.round(a.dim)}%` : '还没存过';
  cells.push(`<button class="slot ${pendingSlot === -1 ? 'on' : ''}" data-slot="-1">自动存档<span>${asub}</span></button>`);
  $('#slotGrid').innerHTML = cells.join('');
}

function openSaveModal(preset = null) {
  pendingSlot = preset;
  renderSlots();
  const c = curRGB();
  $('#saveInfo').textContent =
    `当前：${S.sel.size} 台 · ${Math.round(S.dim)}% · ${toHex(c)} · ${fmt(S.fade)}s`;
  $('#saveName').value = '';
  $('#saveModal').classList.remove('hidden');
  setTimeout(() => $('#saveName').focus(), 40);
}

function closeSaveModal() {
  $('#saveModal').classList.add('hidden');
  pendingSlot = null;
}

function confirmSave() {
  if (pendingSlot === null) return flash('先选一个位置');
  const name = $('#saveName').value;
  if (pendingSlot === -1) saveAuto(name);
  else saveScene(pendingSlot, name);
  const label = pendingSlot === -1 ? '自动存档' : '场景 ' + (pendingSlot + 1);
  closeSaveModal();
  $('#saveHint').textContent = `已存到${label}`;
  flash('已保存到' + label);
}

/** 自动保存间隔（毫秒，0 = 关闭） */
function setAutoSave(ms, silent = false) {
  S.auto.ms = ms;
  clearInterval(S.auto.timer);
  S.auto.timer = null;
  if (ms > 0) S.auto.timer = setInterval(() => saveAuto(), ms);
  localStorage.setItem(AUTO_MS_KEY, String(ms));
  const sel = $('#autoSave');
  if (sel) sel.value = String(Math.round(ms / 60000));
  if (!silent) flash(ms > 0 ? `自动保存：每 ${ms / 60000} 分钟` : '自动保存已关闭');
}

/* ============================ 提示 ============================ */
let flashTimer = null;
function flash(msg) {
  const el = $('#connText');
  const prev = el.textContent;
  el.textContent = msg;
  $('#connPill').classList.remove('on', 'off');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.textContent = prev; refreshPill(); }, 2600);
}

function refreshPill() {
  const pill = $('#connPill');
  pill.classList.toggle('on', S.connected);
  pill.classList.toggle('off', !S.connected);
  $('#connText').textContent = S.connected ? '控台已连接' : '控台未连接';
}

/* ============================ 数值设定 ============================ */
function syncDimUI() {
  setVal('dimNum', fmt(S.dim));
  paintFader();
}

function paintFader() {
  const fill = document.getElementById('dimFill');
  const knob = document.getElementById('dimKnob');
  const box = document.getElementById('dimFader');
  if (!fill || !knob) return;
  const p = clamp(S.dim, 0, 100);
  fill.style.width = p + '%';
  knob.style.left = `calc(${p}% - 6px)`;
  if (box) box.setAttribute('aria-valuenow', Math.round(p));
}

function initFader() {
  const box = document.getElementById('dimFader');
  if (!box) return;
  let dragging = false;
  const apply = e => {
    const r = box.getBoundingClientRect();
    const ratio = (e.clientX - r.left) / r.width;
    setDim(Math.round(clamp(ratio, 0, 1) * 100));
  };
  box.addEventListener('pointerdown', e => { dragging = true; box.setPointerCapture(e.pointerId); apply(e); });
  box.addEventListener('pointermove', e => { if (dragging) apply(e); });
  box.addEventListener('pointerup', () => { dragging = false; });
  box.addEventListener('pointercancel', () => { dragging = false; });
  box.addEventListener('wheel', e => {
    e.preventDefault();
    setDim(clamp(S.dim + (e.deltaY < 0 ? 2 : -2), 0, 100));
  }, { passive: false });
}

function syncTimeUI() {
  setVal('fade', Math.round(S.fade * 10));
  setVal('fadeNum', fmt(S.fade));
  setVal('delay', Math.round(S.delay * 10));
  setVal('delayNum', fmt(S.delay));
}

function setDim(v, send = true) {
  const n = Number(v);
  S.dim = clamp(Number.isFinite(n) ? n : 0, 0, 100);
  syncDimUI();
  if (send) pushLook({ color: false });
}

function setFade(v, apply = false) {
  const n = Number(v);
  S.fade = clamp(Number.isFinite(n) ? n : 0, 0, 120);
  syncTimeUI();
  if (apply) pushLook({ color: false });
}

function setDelay(v) {
  const n = Number(v);
  S.delay = clamp(Number.isFinite(n) ? n : 0, 0, 120);
  syncTimeUI();
}

function setSpeed(v) {
  const n = Number(v);
  S.speed = clamp(Number.isFinite(n) ? n : 8, 1, 20);
  setVal('speed', S.speed);
  setVal('speedNum', S.speed);
  if (S.effect) post('/api/effect', effectBody(S.effect));
}

/** 持续时长（秒）：0 = 一直跑。改值只影响下一次；正在跑的效果不受影响 */
function setDuration(v, silent) {
  const n = Number(v);
  S.duration = clamp(Number.isFinite(n) ? n : 0, 0, 600);
  setVal('durNum', S.duration);
  $$('#durPresets button').forEach(b => b.classList.toggle('on', Number(b.dataset.dur) === S.duration));
  try { localStorage.setItem('b101.duration', String(S.duration)); } catch (e) { /* 忽略 */ }
  if (!silent) flash(S.duration ? `效果持续 ${S.duration} 秒` : '效果不限时，手动停');
}

/** 起效果时发给控台的参数：正在跑就带上剩余时长，避免调速度时把倒计时重置 */
function effectBody(name) {
  const running = S.effect === name && S.fxEndsAt;
  const dur = running ? Math.max(0, (S.fxEndsAt - Date.now()) / 1000) : S.duration;
  return {
    name, ids: selectedIds(), speed: S.speed, dim: S.dim, rgb: rgbPayload(),
    duration: Math.round(dur * 10) / 10,
  };
}

function setTemp(v) {
  const n = Number(v);
  S.col.temp = clamp(Number.isFinite(n) ? n : 50, 0, 100);
  S.col.tempLock = true;
  syncColorUI();
  pushLook({ dim: false });
}

/** 改 R/G/B 任一通道：反推 HSV，再整体下发 */
function setFromChannel(ch, v, send = true) {
  const c = { ...curRGB(), [ch]: clamp(Number(v) || 0, 0, 100) };
  const n = rgb2hsv(c.r, c.g, c.b);
  S.col.h = n.h; S.col.s = n.s; S.col.v = n.v;
  S.col.tempLock = false;
  syncColorUI();
  drawWheel();
  if (send) pushLook({ dim: false });
}

/** 数字框：回车或失焦时提交 */
function onNum(id, fn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', () => fn(el.value));
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    if (e.key === 'Escape') { el.blur(); }
  });
  el.addEventListener('focus', () => el.select());
}

/* ============================ 事件绑定 ============================ */
function bind() {
  // 平面点选
  $('#plot').addEventListener('pointerdown', e => {
    const g = e.target.closest('.lamp');
    if (!g) {
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey) setSel([]);
      return;
    }
    const id = Number(g.dataset.id);
    if (e.shiftKey && S.anchor != null) {
      const a = Math.min(S.anchor, id), b = Math.max(S.anchor, id);
      const ids = S.fixtures.filter(f => f.id >= a && f.id <= b).map(f => f.id);
      setSel(ids, true);
    } else if (e.ctrlKey || e.metaKey) {
      S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id);
      S.anchor = id;
      updateSelPill(); renderPlan(); renderGroups();
    } else {
      S.anchor = id;
      setSel([id]);
    }
  });

  // 灯组
  $('#groups').addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    setSel(JSON.parse(b.dataset.group));
  });

  $('#btnAll').onclick = () => setSel(S.fixtures.map(f => f.id));
  $('#btnNone').onclick = () => setSel([]);

  $('#btnBlack').onclick = async () => {
    S.black = !S.black;
    $('#btnBlack').classList.toggle('on', S.black);
    await post('/api/blackout', { on: S.black });
  };

  $('#btnClear').onclick = async () => {
    await post('/api/stop', {});
    await post('/api/clear', {});
    S.effect = null;
    renderFx();
  };

  // 亮度
  initFader();
  $$('[data-dim]').forEach(b => b.onclick = () => setDim(b.dataset.dim));

  // 时长 / 延时
  const fadeEl = $('#fade');
  fadeEl.addEventListener('input', () => setFade(Number(fadeEl.value) / 10));
  $$('#fadePresets button').forEach(b => b.onclick = () => setFade(b.dataset.fade, true));
  const delayEl = $('#delay');
  delayEl.addEventListener('input', () => setDelay(Number(delayEl.value) / 10));
  $$('#delayPresets button').forEach(b => b.onclick = () => setDelay(b.dataset.delay));

  // 手输数字
  onNum('dimNum', v => setDim(v));
  onNum('fadeNum', v => setFade(v));
  onNum('delayNum', v => setDelay(v));
  onNum('hNum', v => { S.col.h = clamp(v, 0, 360); S.col.tempLock = false; syncColorUI(); drawWheel(); pushLook({ dim: false }); });
  onNum('sNum', v => { S.col.s = clamp(v, 0, 100); S.col.tempLock = false; syncColorUI(); drawWheel(); pushLook({ dim: false }); });
  onNum('vNum', v => { S.col.v = clamp(v, 0, 100); syncColorUI(); drawWheel(); pushLook({ dim: false }); });
  onNum('crNum', v => setFromChannel('r', chanPct(v)));
  onNum('cgNum', v => setFromChannel('g', chanPct(v)));
  onNum('cbNum', v => setFromChannel('b', chanPct(v)));
  onNum('cwNum', v => { S.col.w = clamp(v, 0, 100); syncColorUI(); pushLook({ dim: false }); });
  onNum('ctNum', v => setTemp(v));

  // 效果
  $('#fxgrid').addEventListener('click', e => {
    const info = e.target.closest('.fxmore');
    if (info) { e.stopPropagation(); openFxInfo(info.dataset.info); return; }
    const b = e.target.closest('.fxbtn');
    if (!b) return;
    const name = b.dataset.fx;
    if (S.effect === name) {
      S.effect = null; S.fxEndsAt = 0; post('/api/stop', {}); renderFx(); return;
    }
    S.effect = name;
    S.fxEndsAt = S.duration ? Date.now() + S.duration * 1000 : 0;
    post('/api/effect', effectBody(name));
    renderFx();
  });
  $('#btnStopFx').onclick = () => { S.effect = null; S.fxEndsAt = 0; post('/api/stop', {}); renderFx(); };
  $('#speed').addEventListener('input', e => setSpeed(e.target.value));
  onNum('speedNum', v => setSpeed(v));
  $$('#durPresets button').forEach(b => b.onclick = () => setDuration(b.dataset.dur));
  onNum('durNum', v => setDuration(v, true));

  // 颜色滑块
  const bindCol = (id, fn) => {
    $(id).addEventListener('input', e => { fn(Number(e.target.value)); syncColorUI(); pushLook({ dim: false }); });
  };
  bindCol('#h', v => { S.col.h = v; S.col.tempLock = false; });
  bindCol('#s', v => { S.col.s = v; S.col.tempLock = false; });
  bindCol('#v', v => { S.col.v = v; drawWheel(); });
  bindCol('#cw', v => S.col.w = v);
  const chPct = v => (S.rgbFmt === 'pct' ? v : v / 2.55);
  bindCol('#cr', v => setFromChannel('r', chPct(v), false));
  bindCol('#cg', v => setFromChannel('g', chPct(v), false));
  bindCol('#cb', v => setFromChannel('b', chPct(v), false));
  $('#ct').addEventListener('input', e => setTemp(Number(e.target.value)));

  // RGB 进制切换
  $('#rgbFmt').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) applyRgbFmt(b.dataset.fmt);
  });

  // 十六进制整体输入
  const hexEl = $('#hexInput');
  hexEl.addEventListener('change', () => {
    let s = hexEl.value.trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map(ch => ch + ch).join('');
    if (!/^[0-9a-f]{6}$/i.test(s)) { syncColorUI(); return flash('格式：RRGGBB'); }
    const v = parseInt(s, 16);
    const n = rgb2hsv(((v >> 16) & 255) / 2.55, ((v >> 8) & 255) / 2.55, (v & 255) / 2.55);
    S.col.h = n.h; S.col.s = n.s; S.col.v = n.v; S.col.tempLock = false;
    syncColorUI(); drawWheel(); pushLook({ dim: false });
  });
  hexEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); hexEl.blur(); } });
  hexEl.addEventListener('focus', () => hexEl.select());

  // 色板
  $('#palette').addEventListener('click', e => {
    const b = e.target.closest('.col');
    if (!b) return;
    const rgb = JSON.parse(b.dataset.rgb);
    S.col = { ...S.col, h: rgb.h, s: rgb.s, v: rgb.v, tempLock: false };
    $$('#palette .col').forEach(x => x.classList.remove('cur'));
    b.classList.add('cur');
    syncColorUI(); drawWheel();
    pushLook({ dim: false });
  });

  // 场景：点=调用，长按=打开保存弹窗并预选该槽
  $('#scenes').addEventListener('pointerdown', e => {
    const b = e.target.closest('.scene');
    if (!b) return;
    const i = Number(b.dataset.i);
    scenePress = { i, long: false, timer: 0 };
    scenePress.timer = setTimeout(() => {
      if (!scenePress) return;
      scenePress.long = true;
      openSaveModal(i);
    }, 650);
  });

  document.addEventListener('pointerup', () => {
    if (!scenePress) return;
    const p = scenePress;
    scenePress = null;
    clearTimeout(p.timer);
    if (!p.long) recallScene(p.i);
  });
  document.addEventListener('pointercancel', () => {
    if (scenePress) { clearTimeout(scenePress.timer); scenePress = null; }
  });

  // 保存弹窗
  $('#btnSave').onclick = () => openSaveModal(null);
  $('#saveCancel').onclick = closeSaveModal;
  $('#saveOk').onclick = confirmSave;
  $('#saveModal').addEventListener('pointerdown', e => { if (e.target.id === 'saveModal') closeSaveModal(); });

  // 效果详情
  $('#fxClose').onclick = closeFxInfo;
  $('#fxModal').addEventListener('pointerdown', e => { if (e.target.id === 'fxModal') closeFxInfo(); });
  $('#slotGrid').addEventListener('click', e => {
    const b = e.target.closest('.slot');
    if (!b) return;
    pendingSlot = Number(b.dataset.slot);
    renderSlots();
  });
  $('#saveName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); confirmSave(); } });

  // 自动保存
  $('#autoSave').addEventListener('change', e => setAutoSave(Number(e.target.value) * 60000));
  $('#autoSlot').onclick = () => { if (S.auto.data && S.auto.data.ids) applyState(S.auto.data); else openSaveModal(-1); };

  // 命令行
  const send = () => {
    const v = $('#cmdInput').value.trim();
    if (!v) return;
    post('/api/cmd', { line: v });
    $('#cmdInput').value = '';
  };
  $('#btnSend').onclick = send;
  $('#cmdInput').addEventListener('keydown', e => { if (e.key === 'Enter') send(); });

  $('#btnLog').onclick = () => $('#log').classList.toggle('hidden');
  $('#btnGroupEdit').onclick = async () => {
    flash('正在读取控台…');
    const r = await post('/api/resync', {});
    if (r && r.ok) {
      const cfg = await (await fetch('/api/config')).json();
      S.fixtures = cfg.fixtures; S.groups = cfg.groups;
      renderPlan(); renderGroups();
      flash(`已同步：${r.fixtures} 台灯 / ${r.groups} 组`);
    } else {
      flash('同步失败');
    }
  };

  // 键盘
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#saveModal').classList.contains('hidden')) { closeSaveModal(); return; }
    if (e.key === 'Escape' && !$('#fxModal').classList.contains('hidden')) { closeFxInfo(); return; }
    if (e.key === 'Escape' && !$('#showModal').classList.contains('hidden')) { closeShowModal(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); openSaveModal(null); return; }
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Escape') setSel([]);
    if (e.key === 'a' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setSel(S.fixtures.map(f => f.id)); }
  });
}

let fxCountdown = null;

function renderFx() {
  $$('#fxgrid .fxbtn').forEach(b => b.classList.toggle('on', b.dataset.fx === S.effect));
  const pill = $('#fxPill');
  pill.classList.toggle('hidden', !S.effect);
  if (fxCountdown) { clearInterval(fxCountdown); fxCountdown = null; }
  if (!S.effect) return;

  const label = FX.find(f => f.id === S.effect)?.label || S.effect;
  const paint = () => {
    if (!S.fxEndsAt) { $('#fxText').textContent = '效果：' + label; return; }
    const left = Math.max(0, (S.fxEndsAt - Date.now()) / 1000);
    $('#fxText').textContent = `效果：${label} · 还剩 ${left.toFixed(1)}s`;
  };
  paint();
  if (S.fxEndsAt) fxCountdown = setInterval(paint, 100);
}

function openFxInfo(id) {
  const info = FX_INFO[id];
  if (!info) return;
  $('#fxTitle').textContent = info.t + ' · 怎么做的';
  $('#fxBody').innerHTML =
    `<p class="fxvar">下面用 <b>v</b> 表示「速度」滑块上的值（1–20，单位：每秒刷新几次）。</p>` +
    `<p class="fxsum">${info.d}</p>` +
    info.rows.map(([k, v]) => `<div class="fxrow"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('') +
    `<p class="fxnote">效果在服务端跑：按「速度 v」每秒刷新 1–20 次，每帧把选中的灯重新发一遍；控台命令积压超过 40 条时自动丢帧保节奏。效果运行时亮度由曲线自己决定，推上面的亮度推子不会改变它。设了「持续」的话，到点会自动停并把灯恢复成开始效果前的亮度与颜色（亮度带 0.6 秒淡出）；点「停止」是立刻停，灯停在最后一帧，不恢复。</p>`;
  $('#fxModal').classList.remove('hidden');
}

function closeFxInfo() {
  $('#fxModal').classList.add('hidden');
}

/* ============================ Cue 演出 ============================ */
const cueEsc = s => String(s == null ? '' : s)
  .replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

async function fetchCues() {
  try {
    const r = await (await fetch('/api/cues')).json();
    S.cues = r.cues || [];
    S.cue = r.state || { cue: 0, running: false, nextAt: 0, count: S.cues.length };
    S.cueSrc = { executor: r.executor || '', seq: r.seq || 0, show: r.show || '' };
    renderCues();
  } catch (_) { /* 控台没连上也不影响界面 */ }
}

/** 右下角那行小字：这批 cue 是从控台哪个 executor 读来的，还是本地写的 */
function renderCueSrc() {
  const el = $('#cueSrc');
  if (!el) return;
  const s = S.cueSrc || {};
  const ex = $('#cueExec');
  if (ex) ex.textContent = s.executor || '1.1';
  if (s.executor) {
    el.textContent = `控台 ${s.executor} · Seq ${s.seq || '?'}${s.show ? ' · ' + s.show : ''} · ${S.cues.length} 条`;
    el.classList.add('console');
    el.title = '这些 cue 是从控台当前载入的 show 里读出来的';
  } else if (s.stale) {
    el.textContent = `未对齐 · 控台上没有 cue`;
    el.classList.remove('console');
    el.title = '控台当前载入的 show 里找不到挂 cue 的 executor';
  } else {
    el.textContent = `本地列表 · ${S.cues.length} 条`;
    el.classList.remove('console');
    el.title = '本地列表，还没有和控台上的 sequence 对齐';
  }
}

function renderCues() {
  const box = $('#cueList');
  if (!box) return;
  box.innerHTML = S.cues.map((c, i) => {
    const trig = c.trig || 'Go';
    const go = trig === 'Go';
    const on = S.cue && S.cue.running && S.cue.cue === i + 1;
    return `<div class="cue-row${on ? ' on' : ''}" data-i="${i}">
      <span class="cn">${i + 1}</span>
      <input class="cname" data-k="name" value="${cueEsc(c.name)}" placeholder="未命名" maxlength="40" autocomplete="off">
      <select class="ctrig" data-k="trig">
        <option value="Go"${go ? ' selected' : ''}>Go</option>
        <option value="Time"${trig === 'Time' ? ' selected' : ''}>Time</option>
        <option value="Follow"${trig === 'Follow' ? ' selected' : ''}>Follow</option>
      </select>
      <input class="cnumin" data-k="trigTime" type="number" min="0" step="0.1" value="${Number(c.trigTime) || 0}"${go ? ' disabled' : ''} title="Trig Time：Time 从这一条被触发起算；Follow 等上一条 fade+delay 走完再算">
      <input class="cnumin" data-k="fade" type="number" min="0" step="0.1" value="${Number(c.fade) || 0}" title="时长：这条 cue 的亮度过渡时间（秒）">
      <input class="cnumin" data-k="delay" type="number" min="0" step="0.1" value="${Number(c.delay) || 0}" title="延时：触发后先等多久再开始变（秒）">
      <div class="cbtns">
        <button class="cbtn" data-act="up" title="上移">↑</button>
        <button class="cbtn" data-act="down" title="下移">↓</button>
        <button class="cbtn danger" data-act="del" title="删除">✕</button>
      </div>
    </div>`;
  }).join('');
  $('#cueEmpty').classList.toggle('hidden', S.cues.length > 0);
  renderCueSrc();
  renderCueState();
}

function paintCueRows() {
  $$('#cueList .cue-row').forEach(r => {
    const i = Number(r.dataset.i);
    r.classList.toggle('on', !!(S.cue && S.cue.running && S.cue.cue === i + 1));
  });
  renderCueState();
}

function renderCueState() {
  const el = $('#cueState');
  if (!el) return;
  const st = S.cue || {};
  const pb = $('#cuePause');
  if (!st.running || !st.cue) {
    el.textContent = '未运行';
    el.classList.remove('live');
    if (pb) { pb.textContent = '暂停'; pb.classList.remove('on'); }
    return;
  }
  if (pb) {
    pb.textContent = st.paused ? '继续' : '暂停';
    pb.classList.toggle('on', !!st.paused);
  }
  const cur = S.cues[st.cue - 1];
  const nxt = S.cues[st.cue];
  let extra = '';
  if (st.paused) {
    extra = ' · 已暂停';
  } else if (nxt) {
    if (st.nextAt) {
      const left = Math.max(0, (st.nextAt - Date.now()) / 1000);
      extra = ` · 下一条 ${left.toFixed(1)}s`;
    } else {
      extra = ' · 下一条等 GO';
    }
  } else {
    extra = ' · 最后一条';
  }
  el.textContent = `${st.paused ? '❚❚' : '▶'} Cue ${st.cue}${cur && cur.name ? ' ' + cur.name : ''}${extra}`;
  el.classList.add('live');
}

async function cueAction(body) {
  const r = await post('/api/cues', body);
  if (!r) return null;
  if (r.error) flash(r.error);
  if (r.cues) S.cues = r.cues;
  if (r.state) S.cue = r.state;
  renderCues();
  return r;
}

/** 把手上这组灯记成一条新 cue */
function recordCue() {
  const ids = selectedIds();
  if (!ids.length) return flash('先选灯');
  const c = curRGB();
  const n = S.cues.length + 1;
  flash(`正在记第 ${n} 条…`);
  cueAction({
    op: 'add',
    cue: {
      name: '', trig: 'Go', trigTime: 0, fade: S.fade, delay: S.delay,
      look: { parts: [{ ids, dim: S.dim, rgb: { r: c.r, g: c.g, b: c.b, w: S.col.w, temp: effTemp() } }] },
    },
  }).then(r => { if (r && r.ok) flash(`第 ${n} 条已写进控台`); });
}

function bindCues() {
  // 标签页
  $('#dockTabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    const tab = b.dataset.tab;
    $$('#dockTabs button').forEach(x => x.classList.toggle('on', x === b));
    $('#cuePane').classList.toggle('hidden', tab !== 'cue');
    $('#snapPane').classList.toggle('hidden', tab !== 'snap');
    $('#cueBar').classList.toggle('hidden', tab !== 'cue');
    $('#snapBar').classList.toggle('hidden', tab !== 'snap');
  });

  $('#cueGo').addEventListener('click', () => cueAction({ op: 'go' }));
  $('#cueBack').addEventListener('click', () => cueAction({ op: 'back' }));
  $('#cueStop').addEventListener('click', async () => {
    await cueAction({ op: 'off' });
    clearLive();
    flash('已停止，灯回黑场');
  });
  $('#cueRec').addEventListener('click', recordCue);
  $('#cuePush').addEventListener('click', async () => {
    flash('正在把 cue 列表写进控台…');
    const r = await cueAction({ op: 'push' });
    if (r && r.ok) flash(`已同步 ${r.cues} 条 cue`);
  });
  $('#cuePreview').addEventListener('click', async () => {
    if (!S.cues.length) return flash('列表是空的，先记录几条 cue');
    const total = S.cues.reduce((a, c) => a + (Number(c.fade) || 0) + (Number(c.delay) || 0), 0);
    flash(`完整预览：${S.cues.length} 条 cue，约 ${total.toFixed(0)} 秒，舞台上会实时跟着走`);
    const r = await cueAction({ op: 'preview' });
    if (r && r.ok) { LIVE.on = true; }
  });
  $('#cuePause').addEventListener('click', async () => {
    const r = await cueAction({ op: 'pause' });
    if (r && r.ok) {
      $('#cuePause').textContent = r.paused ? '继续' : '暂停';
      $('#cuePause').classList.toggle('on', !!r.paused);
      if (r.paused) flash('已暂停：控台停在这一帧，MA3D 也停在同画面');
      else flash('继续播放');
    }
  });
  $('#cueRead').addEventListener('click', async () => {
    flash('正在从控台读 cue 列表…');
    const r = await cueAction({ op: 'read' });
    if (!r) return;
    if (!r.ok) return flash(r.error || '读取失败');
    if (r.empty) {
      S.cueSrc = { executor: '', seq: 0, show: r.show || '', stale: true };
      renderCueSrc();
      return flash('控台当前 show 里没有挂 cue 的 executor（列表还是原来那批，没对齐）');
    }
    S.cueSrc = { executor: r.executor, seq: r.seq || 0, show: r.show || '' };
    renderCues();
    flash(`已读取 ${r.count} 条 cue · executor ${r.executor} · ${r.show || '未命名 show'}`);
  });

  // 行内编辑（change：回车 / 失焦才提交，不会边打边发）
  $('#cueList').addEventListener('change', e => {
    const row = e.target.closest('.cue-row');
    if (!row) return;
    const k = e.target.dataset.k;
    if (!k) return;
    const i = Number(row.dataset.i);
    const patch = {};
    if (k === 'name') patch.name = e.target.value;
    else if (k === 'trig') patch.trig = e.target.value;
    else patch[k] = Number(e.target.value) || 0;
    cueAction({ op: 'update', index: i, patch });
  });

  // 行内按钮
  $('#cueList').addEventListener('click', e => {
    const b = e.target.closest('.cbtn');
    if (!b) return;
    const row = b.closest('.cue-row');
    const i = Number(row.dataset.i);
    const act = b.dataset.act;
    if (act === 'del') {
      if (!confirm(`删掉第 ${i + 1} 条？`)) return;
      cueAction({ op: 'delete', index: i });
    } else {
      cueAction({ op: 'move', index: i, dir: act === 'up' ? -1 : 1 });
    }
  });

  // 双击序号 = 跳到这一条
  $('#cueList').addEventListener('dblclick', e => {
    const cn = e.target.closest('.cn');
    if (!cn) return;
    const row = cn.closest('.cue-row');
    cueAction({ op: 'jump', index: Number(row.dataset.i) });
  });

  // 倒计时
  setInterval(renderCueState, 100);
}

/* ============================ 演出文件 ============================ */
const SHOWNAME_KEY = 'b101.showname';

async function refreshShowInfo() {
  try {
    const d = await (await fetch('/api/show')).json();
    S.show = d;
    const box = $('#showBody');
    if (!box) return;
    const pad = n => String(n).padStart(2, '0');
    const mb = n => (n / 1048576).toFixed(1) + ' MB';
    const rows = (d.archives || []).slice(0, 6).map(a => {
      const t = new Date(a.at);
      return `<div class="fxrow"><span class="k">${t.getMonth() + 1}/${t.getDate()} ${pad(t.getHours())}:${pad(t.getMinutes())}</span>` +
        `<span class="v"><code>${cueEsc(a.name)}</code> · ${mb(a.size)}</span></div>`;
    }).join('');
    box.innerHTML =
      `<p class="fxsum">控台上的文件：<code>${cueEsc(d.name)}.show.gz</code></p>` +
      (rows || '<div class="fxrow"><span class="k">还没存过</span><span class="v">点「保存并归档」，控台存一次、这里留一份</span></div>');
    $('#showNameInput').value = d.name || 'b101_live';
  } catch (_) { /* 网络不好就不刷了 */ }
}

function openShowModal() {
  const saved = localStorage.getItem(SHOWNAME_KEY);
  if (saved) $('#showNameInput').value = saved;
  $('#showModal').classList.remove('hidden');
  refreshShowInfo();
}

function closeShowModal() {
  $('#showModal').classList.add('hidden');
}

async function doSaveShow() {
  const name = ($('#showNameInput').value || '').trim() || 'b101_live';
  localStorage.setItem(SHOWNAME_KEY, name);
  const btn = $('#showSaveNow');
  btn.disabled = true;
  btn.textContent = '正在存…';
  const r = await post('/api/show/save', { name });
  btn.disabled = false;
  btn.textContent = '保存并归档';
  if (r && r.ok) {
    flash(`已存 ${r.name}.show.gz（${(r.size / 1048576).toFixed(1)} MB），副本在 exports`);
    refreshShowInfo();
  } else if (r) {
    flash(r.error || '保存失败');
  }
}

function bindShow() {
  $('#btnShow').addEventListener('click', openShowModal);
  $('#showClose').addEventListener('click', closeShowModal);
  $('#showSaveNow').addEventListener('click', doSaveShow);
  $('#showModal').addEventListener('click', e => { if (e.target.id === 'showModal') closeShowModal(); });
  $('#showNameInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSaveShow(); } });
  $('#showOpenArchive').addEventListener('click', () => post('/api/show/open', { which: 'archive' }));
  $('#showOpenShows').addEventListener('click', () => post('/api/show/open', { which: 'shows' }));
}

/* ============================ SSE ============================ */
function connectSSE() {
  const es = new EventSource('/api/events');
  es.onmessage = ev => {
    const d = JSON.parse(ev.data);
    if (d.t === 'status') { S.connected = d.connected; refreshPill(); }
    else if (d.t === 'cue') {
      S.cue = d.state || S.cue;
      paintCueRows();
    }
    else if (d.t === 'cues') {
      // 控台换了 show，服务端自动重新读过 cue 列表
      S.cues = d.cues || [];
      S.cue = d.state || S.cue;
      S.cueSrc = { executor: d.executor || '', seq: d.seq || 0, show: d.show || '' };
      renderCues();
      if (d.auto) flash(`控台的 show 变了，已重新对齐 ${S.cues.length} 条 cue${d.show ? ' · ' + d.show : ''}`);
    }
    else if (d.t === 'live') {
      LIVE.on = true;
      applyLive(d.values);
    }
    else if (d.t === 'effect') {
      S.effect = d.name;
      S.fxEndsAt = d.endsAt || 0;
      renderFx();
      if (d.ended) flash('效果到点，已恢复原来的亮度与颜色');
    }
    else if (d.t === 'log') addLog(d);
  };
  es.onerror = () => { S.connected = false; refreshPill(); };
}

function addLog(d) {
  const box = $('#log');
  if (box.classList.contains('hidden')) return;
  const div = document.createElement('div');
  div.className = d.kind;
  div.textContent = d.text;
  box.appendChild(div);
  while (box.childElementCount > 200) box.firstElementChild.remove();
  box.scrollTop = box.scrollHeight;
}

/* ============================ 启动 ============================ */
async function boot() {
  const cfg = await (await fetch('/api/config')).json();
  S.cfg = cfg;
  S.fixtures = cfg.fixtures;
  S.groups = cfg.groups;
  S.palette = cfg.palette || [];
  $('#showName').textContent = `grandMA2 onPC · ${cfg.ma2.host} · ${cfg.fixtures.length} 台灯`;

  // 色板：控台预设 + 剧目常用色
  const extra = [
    { name: '橙', h: 26, s: 100, v: 100 },
    { name: '金', h: 44, s: 100, v: 100 },
    { name: '粉', h: 8, s: 62, v: 95 },
    { name: '暖白', h: 36, s: 18, v: 100 },
    { name: '冷白', h: 210, s: 12, v: 100 },
  ];
  const CN = { red: '红', green: '绿', blue: '蓝', cyan: '青', magenta: '品红', violet: '紫', White: '白', 'Light orange': '浅橙' };
  const seen = new Set();
  const all = [];
  for (const p of S.palette) {
    const m = /^#?([0-9a-f]{6})$/i.exec(p.hex || '');
    if (!m) continue;
    const v = parseInt(m[1], 16);
    // 十六进制是 0–255，内部统一用控台的 0–100
    const n = rgb2hsv(((v >> 16) & 255) / 2.55, ((v >> 8) & 255) / 2.55, (v & 255) / 2.55);
    if (n.v < 3) continue;
    const key = `${n.h}-${n.s}-${n.v}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push({ name: CN[p.name] || p.name, h: n.h, s: n.s, v: n.v, preset: p.preset });
  }
  for (const e of extra) all.push(e);

  $('#palette').innerHTML = all.map(c =>
    `<div class="col" data-rgb='${JSON.stringify({ h: c.h, s: c.s, v: c.v })}' style="background:${toHex(hsv2rgb(c.h, c.s, c.v))}"><span>${c.name}</span></div>`
  ).join('');

  $('#fxgrid').innerHTML = FX.map(f =>
    `<div class="fxbtn" data-fx="${f.id}">${f.label}<i class="fxmore" data-info="${f.id}" title="这个效果怎么做的">…</i></div>`
  ).join('');

  renderPlan();
  renderGroups();
  loadScenes();
  const savedFmt = localStorage.getItem(FMT_KEY);
  applyRgbFmt(savedFmt === '255' || savedFmt === 'hex' ? savedFmt : 'pct', true);
  initWheel();
  syncColorUI();
  syncDimUI();
  syncTimeUI();
  setVal('speed', S.speed);
  setVal('speedNum', S.speed);
  const savedDur = Number(localStorage.getItem('b101.duration'));
  setDuration(Number.isFinite(savedDur) ? savedDur : 0, true);
  bind();
  bindCues();
  bindShow();
  setAutoSave(S.auto.ms, true);
  renderFx();
  connectSSE();
  refreshPill();
  fetchCues();

  // 默认全选
  setSel(S.fixtures.map(f => f.id));
}

boot();
