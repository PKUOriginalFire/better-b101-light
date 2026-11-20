#!/usr/bin/env node
'use strict';
/**
 * B101 灯光控制台 —— grandMA2 onPC 桥接服务
 * 零依赖，仅用 Node 内置模块。通过 Telnet (30000) 向控台发送命令。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const PORT = Number(process.env.PORT || (CFG.server && CFG.server.port) || 8801);
const HOST = process.env.HOST || '127.0.0.1';

let FIX = CFG.fixtures;
let BY_ID = new Map(FIX.map(f => [f.id, f]));
let RGBW = FIX.filter(f => f.model === 'rgbw').map(f => f.id);
let VARIO = FIX.filter(f => f.model !== 'rgbw').map(f => f.id);

const GMA = 'C:\\ProgramData\\MA Lighting Technologies\\grandma\\gma2_V_3.9.60';

function reindex() {
  BY_ID = new Map(FIX.map(f => [f.id, f]));
  RGBW = FIX.filter(f => f.model === 'rgbw').map(f => f.id);
  VARIO = FIX.filter(f => f.model !== 'rgbw').map(f => f.id);
}

/* 从控台导出的 XML 解析灯具 / 灯组 / 颜色预设 */
const attrOf = (tag, name) => { const m = new RegExp(name + '="([^"]*)"').exec(tag); return m ? m[1] : ''; };

function parseFixtures(xml) {
  const out = [];
  const re = /<Fixture\s+([^>]*)>([\s\S]*?)<\/Fixture>/g;
  let m;
  while ((m = re.exec(xml))) {
    const id = parseInt(attrOf(m[1], 'fixture_id'), 10);
    if (!id) continue;
    const body = m[2];
    const typeM = /<FixtureType\s+name="([^"]*)"/.exec(body);
    const type = typeM ? typeM[1] : '';
    const addrM = /<Address>(\d+)<\/Address>/.exec(body);
    const locM = /<Location\s+([^/>]*)\/>/.exec(body);
    let x = 0, y = 0, z = 0;
    if (locM) { x = +attrOf(locM[1], 'x'); y = +attrOf(locM[1], 'y'); z = +attrOf(locM[1], 'z'); }
    const isVario = /Vario|Tungsten|CTO|CTC|White/i.test(type) && !/RGBW/i.test(type);
    out.push({
      id, name: attrOf(m[1], 'name'), type, addr: addrM ? +addrM[1] : 0,
      model: isVario ? 'vario' : 'rgbw',
      x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, z: Math.round(z * 100) / 100,
    });
  }
  return out.sort((a, b) => a.id - b.id);
}

function parseGroups(xml) {
  const out = [];
  const re = /<Group\s+([^>]*)>([\s\S]*?)<\/Group>/g;
  let m;
  while ((m = re.exec(xml))) {
    const idx = parseInt(attrOf(m[1], 'index'), 10);
    const ids = [...m[2].matchAll(/fix_id="(\d+)"/g)].map(k => +k[1]);
    if (ids.length) out.push({ id: idx + 1, name: attrOf(m[1], 'name') || '组 ' + (idx + 1), fixtures: ids });
  }
  return out;
}

function parsePresets(xml) {
  const out = [];
  const re = /<Preset\s+([^>]*)>([\s\S]*?)<\/Preset>/g;
  let m;
  while ((m = re.exec(xml))) {
    const idx = parseInt(attrOf(m[1], 'index'), 10);
    const vals = {};
    for (const k of m[2].matchAll(/<PresetValue\s+Value="([^"]*)">\s*<ChannelType[^>]*attribute="(COLORRGB\d)"/g)) {
      vals[k[2]] = parseFloat(k[1]);
    }
    const v = a => Math.max(0, Math.min(255, Math.round(((vals[a] || 0) / 100) * 255)));
    const r = v('COLORRGB1'), g = v('COLORRGB2'), b = v('COLORRGB3');
    if (r + g + b === 0) continue;
    const hex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
    out.push({ name: attrOf(m[1], 'name') || '预设 ' + (idx + 1), hex, preset: '4.' + (idx + 1) });
  }
  return out;
}

async function resync() {
  link.sendMany([
    'Export Fixture 1 Thru 999 "fixtures"',
    'Export Group 1 Thru 999 "groups"',
    'Export Preset 4.1 Thru 4.999 "colorpresets"',
  ]);
  await new Promise(r => setTimeout(r, 2600));
  const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; } };
  const fx = parseFixtures(read(path.join(GMA, 'fixtures', 'fixtures.xml')));
  const groups = parseGroups(read(path.join(GMA, 'importexport', 'groups.xml')));
  const presets = parsePresets(read(path.join(GMA, 'importexport', 'colorpresets.xml')));
  if (!fx.length) throw new Error('没有读到灯具数据（控台导出失败？）');
  CFG.fixtures = fx;
  CFG.groups = groups;
  CFG.palette = presets.length ? presets : CFG.palette;
  FIX = fx;
  reindex();
  fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(CFG, null, 2), 'utf8');
  return { fixtures: fx.length, groups: groups.length, presets: presets.length };
}

/* ------------------------------------------------------------------ *
 * 与控台的 Telnet 连接
 * ------------------------------------------------------------------ */
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

class Ma2Link {
  constructor() {
    this.sock = null;
    this.buf = '';
    this.connected = false;
    this.queue = [];
    this.pump = null;
    this.pace = 8;             // 每条命令之间的最小间隔(ms)
    this.backoff = 800;
    this.listeners = new Set();
    this.recent = [];
    this.pendingLogin = false;
    this.cap = null;      // 临时抓取控台输出（读 cue 列表时用）
    this.quiet = false;   // 抓取期间不往日志面板里灌
  }

  emit(ev) {
    for (const fn of this.listeners) { try { fn(ev); } catch (_) {} }
  }

  log(kind, text) {
    if (this.quiet && (kind === 'out' || kind === 'cmd')) return;
    const line = { t: 'log', kind, text, at: Date.now() };
    this.recent.push(line);
    if (this.recent.length > 300) this.recent.shift();
    this.emit(line);
  }

  start() {
    const { host, port, user, password } = CFG.ma2;
    const sock = net.connect({ host, port });
    this.sock = sock;
    sock.setNoDelay(true);
    sock.setEncoding('utf8');

    sock.on('connect', () => {
      this.connected = true;
      this.backoff = 800;
      this.log('sys', `已连接 ${host}:${port}`);
      this.emit({ t: 'status', connected: true });
      this.pendingLogin = true;
      sock.write(`login ${user} ${password}\r\n`);
      setTimeout(() => { this.pendingLogin = false; this.drain(); }, 700);
    });

    sock.on('data', chunk => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const raw = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        this.onLine(raw);
      }
      if (this.buf.length > 8192) this.buf = '';
    });

    sock.on('error', err => {
      if (this.connected) this.log('err', String(err.message || err));
    });

    sock.on('close', () => {
      const was = this.connected;
      this.connected = false;
      this.sock = null;
      this.emit({ t: 'status', connected: false });
      if (was) this.log('sys', '连接断开，正在重连…');
      setTimeout(() => this.start(), this.backoff);
      this.backoff = Math.min(this.backoff * 1.6, 8000);
    });
  }

  onLine(raw) {
    let s = raw.replace(ANSI, '').replace(/\r/g, '');
    s = s.replace(/^\s*\[[^\]]*\]>\s*/, '').trim();
    if (!s) return;
    if (/^[MA:*\s]+$/.test(s)) return;                       // 启动时的 ASCII 横幅
    if (/^(Logged in|Please login)/i.test(s)) { this.log('sys', s); return; }
    if (/^Executing\s*:/i.test(s)) { this.log('cmd', s.replace(/^Executing\s*:\s*/i, '')); return; }
    if (/^Error/i.test(s)) { this.log('err', s); return; }
    if (this.cap) this.cap.push(s);
    if (!/^\[.*\]>$/.test(s)) this.log('out', s.slice(0, 300));
  }

  write(line) {
    if (!this.connected || !this.sock) return false;
    this.sock.write(line + '\r\n');
    return true;
  }

  /** 排队发送；返回是否入队 */
  send(line) {
    if (!line) return false;
    this.queue.push(line);
    if (this.queue.length > 90) this.queue.splice(60); // 丢弃积压，优先实时性
    this.drain();
    return true;
  }

  sendMany(lines) {
    for (const l of lines) this.queue.push(l);
    if (this.queue.length > 90) this.queue.splice(60);
    this.drain();
  }

  drain() {
    if (this.pump || !this.connected || !this.sock) return;
    this.pump = setTimeout(() => {
      this.pump = null;
      if (!this.connected || !this.sock) return;
      const line = this.queue.shift();
      if (line) this.write(line);
      if (this.queue.length) this.drain();
    }, this.pace);
  }

  get backlog() { return this.queue.length; }

  reconnect() {
    if (this.sock) { try { this.sock.destroy(); } catch (_) {} }
  }
}

/* ------------------------------------------------------------------ *
 * 命令生成
 * ------------------------------------------------------------------ */
function compress(ids) {
  const nums = [...new Set(ids)].sort((a, b) => a - b).filter(n => BY_ID.has(n));
  const parts = [];
  let i = 0;
  while (i < nums.length) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    if (j - i >= 2) parts.push(`${nums[i]} Thru ${nums[j]}`);
    else for (let k = i; k <= j; k++) parts.push(String(nums[k]));
    i = j + 1;
  }
  return parts.join(' + ');
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function timing(fade, delay) {
  let s = '';
  if (fade != null && fade !== '' && Number(fade) > 0) s += ` Fade ${Number(fade)}`;
  if (delay != null && delay !== '' && Number(delay) > 0) s += ` Delay ${Number(delay)}`;
  return s;
}

/** 亮度：一条命令搞定整组 */
function cmdIntensity(ids, dim, fade, delay) {
  const sel = compress(ids);
  if (!sel) return [];
  return [`Fixture ${sel} At ${clamp(dim, 0, 100)}${timing(fade, delay)}`];
}

/** 颜色：先选中，再逐属性赋值（Group/属性写在同一行会被控台忽略）
 *  注意：属性命令后面不能跟 Fade —— 控台会把它当成第二个属性值存进去。 */
function cmdColor(ids, rgb) {
  const { r, g, b, w } = rgb;
  const t = '';
  const out = [];
  const rgbw = ids.filter(id => BY_ID.get(id).model === 'rgbw');
  const vario = ids.filter(id => BY_ID.get(id).model !== 'rgbw');

  if (rgbw.length) {
    out.push(`Fixture ${compress(rgbw)}`);
    out.push(`Attribute "COLORRGB1" At ${clamp(r, 0, 100)}${t}`);
    out.push(`Attribute "COLORRGB2" At ${clamp(g, 0, 100)}${t}`);
    out.push(`Attribute "COLORRGB3" At ${clamp(b, 0, 100)}${t}`);
    if (w > 0) out.push(`Attribute "COLORRGB5" At ${clamp(w, 0, 100)}${t}`);
  }
  if (vario.length && rgb.temp != null) {
    // 0 = 最暖, 100 = 最冷：暖白(6) 与 冷白(7) 反向配比
    const cold = clamp(rgb.temp, 0, 100);
    out.push(`Fixture ${compress(vario)}`);
    out.push(`Attribute "COLORRGB6" At ${Math.round(100 - cold)}${t}`);
    out.push(`Attribute "COLORRGB7" At ${Math.round(cold)}${t}`);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 效果引擎（在服务端跑，浏览器卡顿也不影响节奏）
 * ------------------------------------------------------------------ */
class Effects {
  constructor(link) {
    this.link = link;
    this.timer = null;
    this.name = null;
    this.ids = [];
    this.rate = 8;
    this.t0 = 0;
    this.tick = 0;
    this.base = { dim: 100, rgb: { r: 100, g: 100, b: 100 } };
    this.duration = 0;      // 秒；0 = 一直跑到手动停
    this.endsAt = 0;
  }

  /** 到点收尾：停循环，并把灯恢复到效果开始前的静态亮度/颜色 */
  finish() {
    const ids = this.ids.slice();
    const base = this.base;
    const dur = this.duration;
    this.stop(false);
    this.duration = 0;
    this.endsAt = 0;
    const lines = [];
    if (ids.length) {
      lines.push(...cmdIntensity(ids, base.dim ?? 100, 0.6, 0));
      if (base.rgb) lines.push(...cmdColor(ids, {
        r: base.rgb.r ?? 0, g: base.rgb.g ?? 0, b: base.rgb.b ?? 0,
        w: base.rgb.w ?? 0, temp: base.rgb.temp ?? 50,
      }));
    }
    this.link.sendMany(lines);
    this.link.emit({ t: 'effect', name: null, ended: true, duration: dur });
  }

  stop(announce = true) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.name && announce) this.link.emit({ t: 'effect', name: null });
    this.name = null;
  }

  start(name, ids, speed, opts = {}) {
    this.stop(false);
    this.name = name;
    this.ids = ids.slice();
    this.rate = clamp(speed || 8, 1, 20);
    this.t0 = Date.now();
    this.tick = 0;
    this.base = {
      dim: opts.dim ?? 100,
      rgb: opts.rgb || { r: 100, g: 100, b: 100 },
    };
    this.duration = Math.max(0, Number(opts.duration) || 0);
    this.endsAt = this.duration ? Date.now() + this.duration * 1000 : 0;
    this.render();
    this.timer = setInterval(() => this.render(), Math.round(1000 / this.rate));
    this.link.emit({ t: 'effect', name, rate: this.rate, duration: this.duration, endsAt: this.endsAt });
  }

  /** 按数值分桶，把同值灯具合并成一条命令 */
  applyDim(values) {
    const buckets = new Map();
    for (const [id, v] of values) {
      const k = clamp(Math.round(v / 5) * 5, 0, 100);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(id);
    }
    const lines = [];
    for (const [v, ids] of buckets) lines.push(`Fixture ${compress(ids)} At ${v}`);
    return lines;
  }

  render() {
    if (!this.name) return;
    if (this.endsAt && Date.now() >= this.endsAt) { this.finish(); return; }
    if (this.link.backlog > 40) return;      // 控台跟不上就丢帧，保持节奏干净
    const now = Date.now();
    const t = (now - this.t0) / 1000;
    this.tick++;
    const ids = this.ids;
    const n = ids.length || 1;
    let lines = [];

    switch (this.name) {
      case 'breathe': {           // 呼吸：整体明暗起伏
        const v = 55 + 45 * Math.sin(t * 2 * Math.PI / this.period());
        lines = this.applyDim(ids.map(id => [id, v]));
        break;
      }
      case 'pulse': {             // 心跳：快起慢落
        const ph = (t / this.period()) % 1;
        const v = 100 * Math.pow(1 - ph, 2.2);
        lines = this.applyDim(ids.map(id => [id, v]));
        break;
      }
      case 'strobe': {            // 频闪
        const ph = (t * this.rateHz()) % 1;
        const v = ph < 0.45 ? 100 : 0;
        lines = [`Fixture ${compress(ids)} At ${v}`];
        break;
      }
      case 'chase': {             // 追光：一个亮点从头跑到尾
        const head = (this.tick % (n + 3));
        lines = this.applyDim(ids.map((id, i) => {
          const d = Math.abs(i - head);
          return [id, d === 0 ? 100 : d === 1 ? 35 : 0];
        }));
        break;
      }
      case 'wave': {              // 波浪：正弦相位沿灯排铺开
        const ph = (this.tick / 14) % 1;
        lines = this.applyDim(ids.map((id, i) => [id, 50 + 50 * Math.sin(2 * Math.PI * (i / n + ph))]));
        break;
      }
      case 'random': {            // 随机闪烁
        lines = this.applyDim(ids.map(id => [id, Math.random() < 0.35 ? 100 : Math.random() * 20]));
        break;
      }
      case 'rainbow': {           // 彩虹：色相沿灯排旋转
        lines = this.rainbow(ids, t);
        break;
      }
      case 'colorcycle': {        // 颜色轮转：整组同步换色
        const hue = (t * 40) % 360;
        const c = hsv2rgb(hue, 100, 100);
        lines = this.colorBlock(ids.filter(id => BY_ID.get(id).model === 'rgbw'), c);
        break;
      }
      default:
        this.stop();
        return;
    }
    this.link.sendMany(lines);
  }

  period() { return clamp(4 / (this.rate / 8), 0.6, 8); }
  rateHz() { return clamp(this.rate, 1, 20); }

  colorBlock(ids, c) {
    if (!ids.length) return [];
    const out = [`Fixture ${compress(ids)}`];
    out.push(`Attribute "COLORRGB1" At ${c.r}`);
    out.push(`Attribute "COLORRGB2" At ${c.g}`);
    out.push(`Attribute "COLORRGB3" At ${c.b}`);
    return out;
  }

  rainbow(ids, t) {
    const hues = 6;
    const spread = Math.floor((t * 90) % 360);
    const buckets = new Map();
    ids.forEach((id, i) => {
      if (BY_ID.get(id).model !== 'rgbw') return;
      const hue = (spread + (i / Math.max(ids.length - 1, 1)) * 300) % 360;
      const q = Math.round(hue / (360 / hues)) % hues;
      if (!buckets.has(q)) buckets.set(q, []);
      buckets.get(q).push(id);
    });
    const out = [];
    for (const [q, list] of buckets) out.push(...this.colorBlock(list, hsv2rgb(q * 360 / hues, 100, 100)));
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * 颜色工具
 * ------------------------------------------------------------------ */
function hsv2rgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  s = clamp(s, 0, 100) / 100;
  v = clamp(v, 0, 100) / 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return { r: Math.round((r + m) * 100), g: Math.round((g + m) * 100), b: Math.round((b + m) * 100) };
}

/* ------------------------------------------------------------------ *
 * Cue 列表 —— 在控台上建一条真正的 Sequence
 * 做法：生成整条 sequence 的 XML → 删掉旧 cue → Import 一次性导回。
 * 比逐条 Store 快得多，也不会把编程器里的残留值带进 cue。
 * ------------------------------------------------------------------ */
const CUE = Object.assign({ executor: '1.1', file: 'b101cues', label: 'B101' }, CFG.cue || {});
const CUE_FILE = path.join(ROOT, 'cues.json');
let CUES = [];
let cuesDirty = true;   // 本地列表和控台上的 sequence 是否可能不同步

function loadCues() {
  try {
    const d = JSON.parse(fs.readFileSync(CUE_FILE, 'utf8'));
    CUES = Array.isArray(d.cues) ? d.cues : [];
    if (d.executor) CUE.executor = d.executor;
    if (d.seq) CUE.seq = d.seq;
  } catch (_) { CUES = []; }
}
function saveCues() {
  fs.writeFileSync(CUE_FILE, JSON.stringify({ executor: CUE.executor, seq: CUE.seq || 0, cues: CUES }, null, 2), 'utf8');
}

const xmlEsc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 一条 cue 的 look → cue 里的通道值。look 可以是单个 {ids,dim,rgb}，也可以带 parts 数组（多组不同颜色） */
function lookChannels(look) {
  const out = [];
  const seen = new Set();
  const parts = Array.isArray(look.parts) && look.parts.length ? look.parts : [look];
  for (const p of parts) {
    const rgb = p.rgb || {};
    const dim = p.dim == null ? 100 : p.dim;
    for (const id of (p.ids || [])) {
      const f = BY_ID.get(Number(id));
      if (!f || seen.has(f.id)) continue;
      seen.add(f.id);
      out.push([f.id, 'DIM', clamp(dim, 0, 100)]);
      if (f.model === 'rgbw') {
        out.push([f.id, 'COLORRGB1', clamp(rgb.r ?? 0, 0, 100)]);
        out.push([f.id, 'COLORRGB2', clamp(rgb.g ?? 0, 0, 100)]);
        out.push([f.id, 'COLORRGB3', clamp(rgb.b ?? 0, 0, 100)]);
        if (Number(rgb.w) > 0) out.push([f.id, 'COLORRGB5', clamp(rgb.w, 0, 100)]);
      } else if (rgb.temp != null) {
        const cold = clamp(rgb.temp, 0, 100);
        out.push([f.id, 'COLORRGB6', Math.round(100 - cold)]);
        out.push([f.id, 'COLORRGB7', Math.round(cold)]);
      }
    }
  }
  return out;
}

function buildCueXml() {
  const parts = [];
  CUES.forEach((c, i) => {
    const n = i + 1;
    const rows = lookChannels(c.look || {}).map(([fid, attr, val]) =>
      '\t\t\t<CueData value_multipart_index="0" effect_multipart_index="0">\n' +
      `\t\t\t\t<Channel fixture_id="${fid}" attribute_name="${attr}" />\n` +
      `\t\t\t\t<Value>${val}</Value>\n` +
      '\t\t\t</CueData>').join('\n');
    let timing = '';
    if (Number(c.fade) > 0) timing += ` basic_fade="${Number(c.fade)}"`;
    if (Number(c.delay) > 0) timing += ` basic_delay="${Number(c.delay)}"`;
    const name = c.name ? ` name="${xmlEsc(c.name)}"` : '';
    const trig = ['Go', 'Time', 'Follow'].includes(c.trig) ? c.trig : 'Go';
    const trigT = trig === 'Go' ? 0 : Math.max(0, Number(c.trigTime) || 0);
    parts.push(
      `\t<Cue index="${n}">\n` +
      `\t\t<Number number="${n}" sub_number="0" />\n` +
      `\t\t<Trigger type="${trig}" data_f="${trigT}" />\n` +
      '\t\t<CueDatas>\n' + rows + '\n\t\t</CueDatas>\n' +
      `\t\t<CuePart index="0"${name}${timing}>\n` +
      '\t\t\t<CuePartPresetTiming>\n' +
      '\t\t\t\t<PresetTiming /><PresetTiming /><PresetTiming /><PresetTiming /><PresetTiming />\n' +
      '\t\t\t\t<PresetTiming /><PresetTiming /><PresetTiming /><PresetTiming /><PresetTiming />\n' +
      '\t\t\t</CuePartPresetTiming>\n' +
      '\t\t</CuePart>\n' +
      '\t</Cue>');
  });
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<MA xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xmlns="http://schemas.malighting.de/grandma2/xml/MA" major_vers="3" minor_vers="9" stream_vers="60">\n' +
    '\t<Info datetime="' + new Date().toISOString().slice(0, 19) + '" showfile="' + xmlEsc(CFG.show || '') + '" />\n' +
    parts.join('\n') + '\n</MA>\n';
}

/** 把整条 cue 列表写进控台
 *  注意：把 executor 上的 cue 全删光会连 executor 一起没了，所以不能先删后导。
 *  做法是「先确保有一个 sequence（空编程器 Store 一条空 cue）→ 整条覆盖导入 → 删掉多出来的尾巴」。
 */
async function pushCues() {
  const exec = CUE.executor;
  const file = path.join(GMA, 'importexport', CUE.file + '.xml');
  fs.writeFileSync(file, buildCueXml(), 'utf8');
  player.reset();
  cuesDirty = false;

  if (!CUES.length) {
    link.sendMany([`Delete Cue 0 Thru 999 Executor ${exec} /nc`]);
    await sleep(800);
    return { ok: true, cues: 0 };
  }

  link.sendMany(['Clear', 'Clear', `Store Cue 1 Executor ${exec}`]);
  await sleep(500);
  link.sendMany([`Import "${CUE.file}" At Cue 1 Executor ${exec} /nc`]);
  await sleep(1200);
  if (CUES.length < 999) {
    link.sendMany([`Delete Cue ${CUES.length + 1} Thru 999 Executor ${exec} /nc`]);
    await sleep(500);
  }
  return { ok: true, cues: CUES.length };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 从控台「读回来」：把当前 show 里那条 sequence 的 cue 全部读成我们的列表
 * 用 Export 写一份 XML（中文名只有 XML 能保真），再解析成 look。
 * ------------------------------------------------------------------ */
const IMPORT_DIR = path.join(GMA, 'importexport');
const READBACK = 'b101read';

function xmlUnesc(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** 抓一段控台输出：静音 + 只收进 cap，不进日志面板 */
async function grab(lines, wait) {
  const wasQuiet = link.quiet;
  link.quiet = true;
  link.cap = [];
  try {
    link.sendMany(lines);
    await sleep(wait);
    return link.cap.slice();
  } finally {
    link.cap = null;
    link.quiet = wasQuiet;
  }
}

async function listExecCues() {
  const out = await grab(['List Executor'], 700);
  const list = [];
  for (const r of out) {
    const m = r.match(/^Exec\s+([0-9.]+)\b.*?\bSequence=Seq\s+(\d+)/);
    if (m) list.push({ executor: m[1], seq: Number(m[2]) });
  }
  return list;
}

/** 某个 executor 上有几条 cue（用来发现「换了 show 但 executor 编号没变」） */
async function cueCount(exec) {
  const out = await grab([`List Cue Executor ${exec}`], 550);
  return out.filter(l => /^Cue\s+\d/.test(l)).length;
}

async function exportCueXml(exec) {
  const file = path.join(IMPORT_DIR, READBACK + '.xml');
  try { fs.unlinkSync(file); } catch (_) {}
  const wasQuiet = link.quiet;
  link.quiet = true;
  try {
    link.send(`Export Cue 1 Thru 999 Executor ${exec} "${READBACK}"`);
    for (let i = 0; i < 50; i++) {
      await sleep(120);
      try {
        const st = fs.statSync(file);
        if (st.size > 60) {
          await sleep(150);                       // 等它写完
          return fs.readFileSync(file, 'utf8');
        }
      } catch (_) {}
    }
    return null;
  } finally {
    link.quiet = wasQuiet;
  }
}

/** XML → [{name,trig,trigTime,fade,delay,vals}]，vals 是 fixture_id → {ATTR:value} */
function parseCueXml(xml) {
  const show = xmlUnesc((xml.match(/<Info[^>]*\bshowfile="([^"]*)"/) || [])[1] || '');
  const cues = [];
  const re = /<Cue\s+index="\d+"[^>]*>([\s\S]*?)<\/Cue>/g;
  let m;
  while ((m = re.exec(xml))) {
    const body = m[1];
    const name = xmlUnesc((body.match(/<CuePart[^>]*\bname="([^"]*)"/) || [])[1] || '');
    const fade = Number((body.match(/<CuePart[^>]*\bbasic_fade="([\d.]+)"/) || [])[1] || 0);
    const delay = Number((body.match(/<CuePart[^>]*\bbasic_delay="([\d.]+)"/) || [])[1] || 0);
    const t = body.match(/<Trigger[^>]*\btype="([^"]*)"[^>]*\bdata_f="([-\d.]+)"/);
    const trigRaw = t ? t[1] : 'Go';
    const trig = ['Go', 'Time', 'Follow'].includes(trigRaw) ? trigRaw : 'Go';
    const trigTime = t ? Math.abs(Number(t[2]) || 0) : 0;
    const vals = new Map();
    const cre = /<Channel\s+fixture_id="(\d+)"\s+attribute_name="([^"]+)"\s*\/>\s*<Value>([-\d.]+)<\/Value>/g;
    let c;
    while ((c = cre.exec(body))) {
      const id = Number(c[1]);
      if (!vals.has(id)) vals.set(id, {});
      vals.get(id)[c[2]] = Number(c[3]);
    }
    cues.push({ name, trig, trigTime, fade, delay, vals });
  }
  return { show, cues };
}

/** 控台按「跟踪」存值：这一条没写的灯，沿用上一条。这里补齐成绝对值。 */
function cueValsAt(list, i) {
  const out = new Map();
  for (let k = 0; k <= i; k++) for (const [id, v] of list[k].vals) out.set(id, v);
  return out;
}

/** fixture_id → 设备值 的表，折成我们的 look（按相同取值分组，减少 parts 数量） */
function valsToLook(map) {
  const groups = new Map();
  for (const f of CFG.fixtures) {
    const v = map.get(f.id) || {};
    const dim = clamp(Number(v.DIM) || 0, 0, 100);
    let r = 0, g = 0, b = 0, w = 0, temp = 50;
    if (f.model === 'rgbw') {
      r = clamp(Number(v.COLORRGB1) || 0, 0, 100);
      g = clamp(Number(v.COLORRGB2) || 0, 0, 100);
      b = clamp(Number(v.COLORRGB3) || 0, 0, 100);
      w = clamp(Number(v.COLORRGB5) || 0, 0, 100);
    } else {
      const cool = v.COLORRGB7 != null ? Number(v.COLORRGB7)
        : (v.COLORRGB6 != null ? 100 - Number(v.COLORRGB6) : 50);
      temp = clamp(cool, 0, 100);
    }
    const key = [dim, r, g, b, w, temp].join('|');
    if (!groups.has(key)) {
      groups.set(key, { dim, rgb: f.model === 'rgbw' ? { r, g, b, w } : { temp }, ids: [] });
    }
    groups.get(key).ids.push(f.id);
  }
  return { parts: [...groups.values()] };
}

/** 读控台当前 show 的 cue 列表；成功则替换本地列表并广播给网页 */
let cueBusy = false;
async function readShowCues(fromAuto) {
  if (cueBusy) return { ok: false, error: '正在读取，稍等一秒' };
  cueBusy = true;
  try { return await readCuesLocked(fromAuto); }
  finally { cueBusy = false; }
}

async function readCuesLocked(fromAuto) {
  if (!link.connected) return { ok: false, error: '控台没连上' };
  const execs = await listExecCues();
  if (!execs.length) {
    // 这个 show 里根本没有挂 sequence 的 executor：不要动本地列表，只报「没对齐」
    return { ok: true, empty: true, count: 0, executor: '', seq: 0, show: CFG.show || '' };
  }
  // 优先本应用一直在用的那个 executor；没 cue 就顺着往后试几个
  const order = [];
  const mine = execs.find(e => e.executor === CUE.executor);
  if (mine) order.push(mine);
  for (const e of execs) if (!order.includes(e)) order.push(e);

  let got = null;
  for (const cand of order.slice(0, 4)) {
    const xml = await exportCueXml(cand.executor);
    if (!xml) continue;
    const parsed = parseCueXml(xml);
    if (parsed.cues.length) { got = { ...parsed, ...cand }; break; }
  }
  if (!got) {
    return { ok: true, empty: true, count: 0, executor: '', seq: 0, show: CFG.show || '' };
  }
  const { show, cues } = got;
  CUES = cues.map((c, i) => ({
    name: c.name || `Cue ${i + 1}`,
    trig: c.trig,
    trigTime: c.trigTime,
    fade: c.fade,
    delay: c.delay,
    look: valsToLook(cueValsAt(cues, i)),
  }));
  CUE.executor = got.executor;
  CUE.seq = got.seq;
  if (show) CFG.show = show;
  cuesDirty = false;
  saveCues();
  player.reset();
  link.emit({
    t: 'cues', executor: CUE.executor, seq: CUE.seq, show: CFG.show || '',
    cues: CUES, state: player.state(), auto: !!fromAuto,
  });
  if (fromAuto) link.log('sys', `检测到 show 变化，已从 executor ${CUE.executor} 读取 ${CUES.length} 条 cue`);
  return { ok: true, count: CUES.length, cues: CUES, executor: CUE.executor, seq: CUE.seq || 0, show: CFG.show || '' };
}

/* ------------------------------------------------------------------ *
 * 演出文件：SaveShow 到控台，再在本地归档一份带时间戳的副本
 * ------------------------------------------------------------------ */
const SHOWS_DIR = 'C:\\ProgramData\\MA Lighting Technologies\\grandma\\gma2_V_3.9.60\\shows';
const EXPORT_DIR = path.join(ROOT, 'exports');

function showFileName(name) {
  const clean = String(name || CFG.show || 'b101_live').replace(/[^\w\-.]/g, '_').slice(0, 40);
  return clean || 'b101_live';
}

async function saveShow(name) {
  const clean = showFileName(name);
  const file = path.join(SHOWS_DIR, clean + '.show.gz');
  const before = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;

  link.send(`SaveShow "${clean}" /noconfirm`);

  const t0 = Date.now();
  let size = -1;
  let stable = 0;
  while (Date.now() - t0 < 60000) {
    await sleep(700);
    if (!fs.existsSync(file)) continue;
    const st = fs.statSync(file);
    if (st.mtimeMs <= before) continue;          // 还是旧文件
    if (st.size === size) stable += 1; else { size = st.size; stable = 0; }
    if (stable < 2) continue;                     // 停稳了才算写完

    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const archive = path.join(EXPORT_DIR, `${clean}_${stamp}.show.gz`);
    fs.copyFileSync(file, archive);
    return { ok: true, name: clean, file, archive, size: st.size, at: d.toISOString() };
  }
  return { ok: false, error: '控台 60 秒内没写出文件。看看控台上有没有弹窗挡着（比如「是否覆盖」）。' };
}

function openFolder(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const { spawn } = require('child_process');
    spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
  } catch (_) { /* 打不开就算了 */ }
}

function listArchives() {
  try {
    return fs.readdirSync(EXPORT_DIR)
      .filter(f => f.endsWith('.show.gz'))
      .map(f => { const st = fs.statSync(path.join(EXPORT_DIR, f)); return { name: f, size: st.size, at: st.mtimeMs }; })
      .sort((a, b) => b.at - a.at)
      .slice(0, 12);
  } catch (_) { return []; }
}

/** 播放状态：我们在本地跟一遍（控台的 Time/Follow 自己会走，这里只是同步显示） */
const player = {
  cue: 0,
  running: false,
  paused: false,
  pausedAt: 0,
  pausedTotal: 0,
  previewing: false,
  cueStartAt: 0,
  nextAt: 0,
  timer: null,
  state() {
    return {
      cue: this.cue,
      running: this.running,
      paused: this.paused,
      previewing: this.previewing,
      nextAt: Math.round(this.nextAt),
      count: CUES.length,
    };
  },
  emit() { link.emit({ t: 'cue', state: this.state() }); },
  /** 扣掉暂停时间后的播放时钟（毫秒） */
  etime() {
    const n = Date.now();
    return n - this.pausedTotal - (this.pausedAt ? n - this.pausedAt : 0);
  },
  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = 0;
  },
  reset() {
    this.clearTimer();
    this.running = false;
    this.paused = false;
    this.pausedAt = 0;
    this.pausedTotal = 0;
    this.previewing = false;
    this.cue = 0;
    this.cueStartAt = 0;
    this.emit();
  },
  /** 排下一步：Time 从本 cue 触发时刻起算；Follow 等本 cue 的 fade+delay 走完 */
  schedule() {
    this.clearTimer();
    if (this.paused) return;
    const cur = CUES[this.cue - 1];
    const nxt = CUES[this.cue];
    if (!cur || !nxt) return;
    const trig = nxt.trig || 'Go';
    if (trig === 'Go') return;
    let at;
    if (trig === 'Time') at = this.cueStartAt + Math.max(0, Number(nxt.trigTime) || 0) * 1000;
    else at = this.cueStartAt + ((Number(cur.fade) || 0) + (Number(cur.delay) || 0) + Math.max(0, Number(nxt.trigTime) || 0)) * 1000;
    this.nextAt = at;
    const wait = Math.max(0, at - this.etime());
    this.timer = setTimeout(() => {
      this.cue += 1;
      this.cueStartAt = this.etime();
      this.schedule();
      this.emit();
    }, wait);
  },
  fire(n, mode) {
    const exec = CUE.executor;
    const lines = [];
    if (!this.running) lines.push('Clear', 'Clear');
    if (mode === 'go' && this.running) lines.push(`Go Executor ${exec}`);
    else lines.push(`Goto Cue ${n} Executor ${exec}`);
    link.sendMany(lines);
    this.cue = n;
    this.running = true;
    this.paused = false;
    this.pausedAt = 0;
    this.pausedTotal = 0;
    this.cueStartAt = this.etime();
    this.schedule();
    this.emit();
    return { ok: true, cue: n };
  },
  go() {
    if (!CUES.length) return { ok: false, error: '还没有 cue' };
    const n = (!this.running || !this.cue) ? 1 : Math.min(this.cue + 1, CUES.length);
    return this.fire(n, 'go');
  },
  jump(n) {
    if (!CUES.length) return { ok: false, error: '还没有 cue' };
    const k = clamp(Number(n) || 1, 1, CUES.length);
    return this.fire(k, 'goto');
  },
  /** 从第 1 条开始，把整条 sequence 完整放一遍 */
  preview() {
    if (!CUES.length) return { ok: false, error: '还没有 cue' };
    this.previewing = true;
    return this.fire(1, 'goto');
  },
  /** 暂停 / 继续：控台的 Pause 是切换式的，发同一类命令切换 */
  togglePause() {
    if (!this.running || !this.cue) return { ok: false, error: '现在没在放 cue' };
    const exec = CUE.executor;
    if (!this.paused) {
      link.send(`Pause On Executor ${exec}`);
      this.paused = true;
      this.pausedAt = Date.now();
      this.clearTimer();
    } else {
      link.send(`Pause Off Executor ${exec}`);
      this.pausedTotal += Date.now() - this.pausedAt;
      this.pausedAt = 0;
      this.paused = false;
      this.schedule();
    }
    this.emit();
    return { ok: true, paused: this.paused };
  },
  off() {
    link.sendMany(['Clear', 'Clear', `Off Executor ${CUE.executor}`]);
    this.reset();
    return { ok: true };
  },
  back() {
    if (!CUES.length) return { ok: false, error: '还没有 cue' };
    const n = Math.max(1, (this.cue || 1) - 1);
    link.send(`GoBack Executor ${CUE.executor}`);
    this.cue = n;
    this.cueStartAt = this.etime();
    this.schedule();
    this.emit();
    return { ok: true, cue: n };
  },
};

/* 预览帧：把 cue 的 look 摊到每台灯上，并按这条 cue 的 fade 从上一条线性过渡 */
const EMPTY_LOOK = { ids: [], dim: 0, rgb: {} };

function lookVal(look, f) {
  const parts = Array.isArray(look.parts) && look.parts.length ? look.parts : [look];
  let p = null;
  for (const q of parts) if ((q.ids || []).map(Number).includes(f.id)) { p = q; break; }
  if (!p) return { dim: 0, r: 0, g: 0, b: 0, w: 0, temp: 50 };
  const rgb = p.rgb || {};
  return {
    dim: clamp(p.dim == null ? 100 : Number(p.dim), 0, 100),
    r: clamp(Number(rgb.r) || 0, 0, 100),
    g: clamp(Number(rgb.g) || 0, 0, 100),
    b: clamp(Number(rgb.b) || 0, 0, 100),
    w: clamp(Number(rgb.w) || 0, 0, 100),
    temp: clamp(rgb.temp == null ? 50 : Number(rgb.temp), 0, 100),
  };
}

function liveFrame() {
  if (!player.running || !player.cue) return null;
  const cur = CUES[player.cue - 1];
  if (!cur) return null;
  const prev = player.cue > 1 ? CUES[player.cue - 2] : EMPTY_LOOK;
  const fade = Math.max(0, Number(cur.fade) || 0) * 1000;
  const delay = Math.max(0, Number(cur.delay) || 0) * 1000;
  const k = fade <= 0 ? 1 : clamp((player.etime() - player.cueStartAt - delay) / fade, 0, 1);
  const mix = (a, b) => a + (b - a) * k;
  return CFG.fixtures.map(f => {
    const a = lookVal(prev.look || prev, f);
    const b = lookVal(cur.look || cur, f);
    return [
      f.id,
      Math.round(mix(a.dim, b.dim)),
      Math.round(mix(a.r, b.r)),
      Math.round(mix(a.g, b.g)),
      Math.round(mix(a.b, b.b)),
      Math.round(mix(a.w, b.w)),
      Math.round(mix(a.temp, b.temp)),
    ];
  });
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */
const link = new Ma2Link();
const fx = new Effects(link);

/* 预览帧推送：12 帧/秒，网页左侧舞台平面靠它实时变色 */
setInterval(() => {
  if (!player.running) return;
  const values = liveFrame();
  if (values) link.emit({ t: 'live', cue: player.cue, values });
}, 120);

/* 换 show 自动对齐：对比「哪个 executor 挂着哪条 sequence」，变了就重读一遍 cue 列表。
   全程静音执行，不会往日志面板里刷 List/Export 的输出。 */
let lastExecSig = '';
async function watchShow() {
  if (!link.connected || cueBusy) return;
  cueBusy = true;
  try {
    const execs = await listExecCues();
    const sig0 = execs.map(e => `${e.executor}:${e.seq}`).join(',');
    if (!sig0) return;
    const pref = execs.find(e => e.executor === CUE.executor) || execs[0];
    const cnt = await cueCount(pref.executor);
    const sig = `${sig0}#${cnt}`;
    if (sig === lastExecSig) return;
    lastExecSig = sig;
    await readCuesLocked(true);
  } catch (_) {
  } finally {
    cueBusy = false;
  }
}
setTimeout(watchShow, 6000);
setInterval(watchShow, 12000);

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); } });
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/config') {
    return json(res, 200, { ...CFG, meta: { rgbw: RGBW.length, vario: VARIO.length } });
  }

  if (url.pathname === '/api/status') {
    return json(res, 200, {
      connected: link.connected,
      backlog: link.backlog,
      effect: fx.name,
      show: CFG.show || '',
    });
  }

  if (url.pathname === '/api/log') {
    return json(res, 200, { recent: link.recent.slice(-150) });
  }

  if (url.pathname === '/api/cues' && req.method === 'GET') {
    return json(res, 200, {
      executor: CUE.executor, seq: CUE.seq || 0, show: CFG.show || '',
      cues: CUES, state: player.state(),
    });
  }

  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    const send = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    send({ t: 'status', connected: link.connected });
    send({ t: 'effect', name: fx.name });
    send({ t: 'cue', state: player.state() });
    for (const l of link.recent.slice(-40)) send(l);
    link.listeners.add(send);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(keepAlive); link.listeners.delete(send); });
    return;
  }

  if (url.pathname === '/api/show' && req.method === 'GET') {
    return json(res, 200, {
      name: showFileName(),
      showsDir: SHOWS_DIR,
      exportDir: EXPORT_DIR,
      archives: listArchives(),
    });
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) && body.ids.length ? body.ids.map(Number) : FIX.map(f => f.id);

    switch (url.pathname) {
      case '/api/look': {
        const lines = [];
        if (body.dim != null) lines.push(...cmdIntensity(ids, body.dim, body.fade, body.delay));
        if (body.rgb) {
          lines.push(...cmdColor(ids, {
            r: body.rgb.r ?? 0, g: body.rgb.g ?? 0, b: body.rgb.b ?? 0, w: body.rgb.w ?? 0,
            temp: body.rgb.temp ?? 0, fade: body.fade, delay: body.delay,
          }));
        }
        if (body.preset) {
          const rgbw = ids.filter(id => BY_ID.get(id).model === 'rgbw');
          if (rgbw.length) lines.push(`Fixture ${compress(rgbw)} At Preset ${body.preset}${timing(body.fade, body.delay)}`);
        }
        link.sendMany(lines);
        return json(res, 200, { ok: true, lines });
      }
      case '/api/effect': {
        fx.start(String(body.name || ''), ids, Number(body.speed || 8), {
          dim: body.dim ?? 100,
          rgb: body.rgb || { r: 100, g: 100, b: 100 },
          duration: body.duration ?? 0,
        });
        return json(res, 200, { ok: true, name: fx.name, duration: fx.duration });
      }
      case '/api/stop':
        fx.stop();
        return json(res, 200, { ok: true });
      case '/api/blackout':
        link.send(body.on === false ? 'Blackout Off' : 'Blackout On');
        return json(res, 200, { ok: true });
      case '/api/clear':
        fx.stop();
        link.sendMany(['Clear', 'Clear', 'Clear']);
        return json(res, 200, { ok: true });
      case '/api/cues': {
        const op = String(body.op || 'list');
        const idx = Number.isInteger(body.index) ? body.index : -1;
        if (op === 'go') { const r = player.go(); return json(res, 200, { ok: r.ok, error: r.error, state: player.state() }); }
        if (op === 'jump') { const r = player.jump(body.index); return json(res, 200, { ok: r.ok, error: r.error, state: player.state() }); }
        if (op === 'off') { player.off(); return json(res, 200, { ok: true, state: player.state() }); }
        if (op === 'back') { const r = player.back(); return json(res, 200, { ok: r.ok, state: player.state() }); }
        if (op === 'preview') {
          if (cuesDirty && CUES.length) await pushCues();
          const r = player.preview();
          return json(res, 200, { ok: r.ok, error: r.error, state: player.state() });
        }
        if (op === 'pause') { const r = player.togglePause(); return json(res, 200, { ok: r.ok, error: r.error, paused: r.paused, state: player.state() }); }
        if (op === 'read') {
          const r = await readShowCues(false);
          return json(res, 200, { ...r, state: player.state() });
        }

        if (op === 'add') {
          const c = body.cue || {};
          const cue = {
            name: String(c.name || '').slice(0, 40),
            trig: ['Go', 'Time', 'Follow'].includes(c.trig) ? c.trig : 'Go',
            trigTime: Math.max(0, Number(c.trigTime) || 0),
            fade: Math.max(0, Number(c.fade) || 0),
            delay: Math.max(0, Number(c.delay) || 0),
            look: (c.look && Array.isArray(c.look.parts))
              ? { parts: c.look.parts.map(p => ({
                  ids: (p.ids || []).map(Number),
                  dim: Number(p.dim ?? 100),
                  rgb: p.rgb || { r: 100, g: 100, b: 100 },
                })) }
              : {
                  ids: Array.isArray(c.look?.ids) ? c.look.ids.map(Number) : (c.ids || []).map(Number),
                  dim: Number(c.look?.dim ?? c.dim ?? 100),
                  rgb: c.look?.rgb || c.rgb || { r: 100, g: 100, b: 100 },
                },
          };
          if (idx >= 0 && idx < CUES.length) CUES.splice(idx + 1, 0, cue); else CUES.push(cue);
        } else if (op === 'update') {
          if (idx < 0 || idx >= CUES.length) return json(res, 400, { ok: false, error: '没有这条 cue' });
          const p = body.patch || {};
          const c = CUES[idx];
          if (p.name != null) c.name = String(p.name).slice(0, 40);
          if (p.trig != null && ['Go', 'Time', 'Follow'].includes(p.trig)) c.trig = p.trig;
          if (p.trigTime != null) c.trigTime = Math.max(0, Number(p.trigTime) || 0);
          if (p.fade != null) c.fade = Math.max(0, Number(p.fade) || 0);
          if (p.delay != null) c.delay = Math.max(0, Number(p.delay) || 0);
          if (p.look) c.look = p.look;
        } else if (op === 'delete') {
          if (idx < 0 || idx >= CUES.length) return json(res, 400, { ok: false, error: '没有这条 cue' });
          CUES.splice(idx, 1);
        } else if (op === 'move') {
          const j = idx + (Number(body.dir) > 0 ? 1 : -1);
          if (idx < 0 || idx >= CUES.length || j < 0 || j >= CUES.length) return json(res, 200, { ok: true, cues: CUES });
          [CUES[idx], CUES[j]] = [CUES[j], CUES[idx]];
        } else if (op === 'clear') {
          CUES = [];
        } else if (op === 'push') {
          const r = await pushCues();
          saveCues();
          return json(res, 200, { ok: true, ...r, state: player.state() });
        } else if (op !== 'list') {
          return json(res, 400, { ok: false, error: '未知操作 ' + op });
        }

        player.reset();
        saveCues();
        await pushCues();
        return json(res, 200, { ok: true, cues: CUES, state: player.state() });
      }
      case '/api/show/save': {
        try { return json(res, 200, await saveShow(body.name)); }
        catch (e) { return json(res, 500, { ok: false, error: e.message }); }
      }
      case '/api/show/open': {
        const dir = body.which === 'shows' ? SHOWS_DIR : EXPORT_DIR;
        openFolder(dir);
        return json(res, 200, { ok: true, dir });
      }
      case '/api/cmd':
        if (body.line) link.sendMany(String(body.line).split(/\s*;\s*/).filter(Boolean));
        return json(res, 200, { ok: true });
      case '/api/reconnect':
        link.reconnect();
        return json(res, 200, { ok: true });
      case '/api/resync':
        try { return json(res, 200, { ok: true, ...(await resync()) }); }
        catch (e) { return json(res, 500, { ok: false, error: e.message }); }
      default:
        return json(res, 404, { error: 'not found' });
    }
  }

  // 静态文件
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(ROOT, 'public', path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(path.join(ROOT, 'public'))) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`B101 灯光控制台  →  http://${HOST}:${PORT}`);
  console.log(`控台 ${CFG.ma2.host}:${CFG.ma2.port}   灯具 ${FIX.length} 台（RGBW ${RGBW.length} / 色温 ${VARIO.length}） 灯组 ${CFG.groups.length} 个`);
  loadCues();
  console.log(`Cue 列表 ${CUES.length} 条   executor ${CUE.executor}`);
  link.start();
  if (process.env.NO_OPEN !== '1') openBrowser(`http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
});

/** 服务起来之后再开浏览器，免得手快打开是「无法访问」 */
function openBrowser(url) {
  try {
    const { spawn } = require('child_process');
    const opts = { detached: true, stdio: 'ignore' };
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], opts).unref();
    else if (process.platform === 'darwin') spawn('open', [url], opts).unref();
    else spawn('xdg-open', [url], opts).unref();
  } catch (_) { /* 打不开就算了，地址已经打印出来了 */ }
}
