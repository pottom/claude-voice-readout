// Shared parts of the voice readout: the user folder's paths, the
// reply-to-speech conversion, file locks and the queue. Node only, no
// dependencies, so the same code runs on Windows, macOS and Linux.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { userDir, readJson } from './config.mjs';

export { readJson };
// Everything the readout writes is in the user folder; the plugin folder is read-only.
export const dir = userDir();
export const work = path.join(dir, 'work');
export const queue = path.join(work, 'queue');
export const recent = path.join(work, 'recent');
export const isOn = () => fs.existsSync(path.join(dir, 'on'));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function log(msg, item = '') {
  const f = process.env.VOICE_READOUT_LOG;
  if (!f) return;
  try { fs.appendFileSync(f, `${new Date().toISOString().slice(11, 23)} ${msg} ${path.basename(item)}\n`); } catch {}
}

// ---- processes and locks -----------------------------------------------------
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// A pid written before the last boot, or longer ago than a speaker can live,
// belongs to a process that is gone: the number may already be someone
// else's. Pid files and locks are only trusted while they are fresh.
export const SPEAKER_MAX_MS = 70 * 60 * 1000;
export function freshFile(file) {
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st) return false;
  const boot = Date.now() - os.uptime() * 1000;
  return st.mtimeMs > boot && st.mtimeMs > Date.now() - SPEAKER_MAX_MS;
}

// A lock is a file holding the owner's pid; a dead owner's lock is taken over.
export function tryLock(file) {
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') return false;
    let owner = 0;
    try { owner = parseInt(fs.readFileSync(file, 'utf8'), 10); } catch {}
    const stale = owner ? (!freshFile(file) || !alive(owner)) : (Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0) > 10000);
    if (stale) {
      // Only the lock just judged stale goes, not one a third process took meanwhile.
      try { if (parseInt(fs.readFileSync(file, 'utf8'), 10) === owner || !owner) fs.unlinkSync(file); } catch {}
    }
    return false;
  }
}
export function unlock(file) {
  try { if (parseInt(fs.readFileSync(file, 'utf8'), 10) === process.pid) fs.unlinkSync(file); } catch {}
}
export async function lock(file, timeoutMs, stillWanted = () => true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!stillWanted()) return false;
    if (tryLock(file)) return true;
    await sleep(150);
  }
  return false;
}

// ---- reply text -> speech ---------------------------------------------------------
// Word characters and boundaries as .NET has them (Unicode letters, marks,
// digits, connectors); JavaScript's \w and \b are ASCII-only.
const W = '[\\p{L}\\p{M}\\p{Nd}\\p{Pc}]';
const NW = '[^\\p{L}\\p{M}\\p{Nd}\\p{Pc}]';
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
// Only for \w, \W, \b outside character classes; inside a class, spell the
// properties out.
const re = (src, flags = '') => new RegExp(src.replaceAll('\\w', W).replaceAll('\\W', NW).replaceAll('\\b', B), flags + 'u');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const VOWELS = 'aeiouáéíóöőúüű';
const pick = (list) => { const a = [].concat(list ?? []); return a[Math.floor(Math.random() * a.length)] ?? ''; };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const isLower = (c) => !!c && c === c.toLowerCase() && c !== c.toUpperCase();
const ieq = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

export const SAY_MAX_AGE_MS = 10 * 60 * 1000;   // an unsaid reply older than this is dropped

// "{A} {t}" with the topic's own article taken off ("Az átvétel" -> "átvétel"),
// so it is never said twice. {h} = how the user is addressed; without it the
// address and its comma go.
export function formatTopic(templates, topic, name = '', address = '') {
  topic = String(topic ?? '').trim().replace(re('^(?:a|az|egy)\\s+', 'i'), '');
  if (topic.length > 1 && isLower(topic[1])) topic = topic[0].toLowerCase() + topic.slice(1);
  const art = topic && VOWELS.includes(topic[0].toLowerCase()) ? 'az' : 'a';
  let s = pick(templates);
  if (!address) s = s.replace(/,\s*\{h\}/g, '').replace(/\{h\}[,!]?\s*/g, '');
  s = s.replaceAll('{A}', cap(art)).replaceAll('{a}', art).replaceAll('{t}', topic).replaceAll('{n}', name).replaceAll('{h}', address);
  return cap(s.replace(/\s{2,}/g, ' ').trim());
}

// Table labels are looked up like PowerShell properties (any case), never
// the internal keys that start with an underscore.
function ruleFor(rules, label) {
  const key = Object.keys(rules).find((k) => !k.startsWith('_') && ieq(k, label));
  return key ? rules[key] : null;
}

// A session title without leading symbols and a "<WORD> <number> \u00B7 " prefix
// ("TICKET 604 \u00B7 Website" -> "Website"); _titlePrefix (a regex) replaces the latter.
const TITLE_PREFIX = '^\\s*\\p{Lu}{2,}\\s+\\d+\\s*\u00B7\\s*';
export function sessionTopic(title, rules = {}) {
  return title ? title.replace(/^[^\p{L}\p{Nd}]+/u, '').replace(re(rules._titlePrefix ?? TITLE_PREFIX, 'i'), '').trim() : '';
}

// The report marks in a heading (_marks: { "<symbol>": "question" | "blocked" | "info" }).
const marksOf = (rules) => rules._marks ?? {};
const reportOf = (rules) => rules._report ?? null;

// Markdown, links, emoji and symbols off one line; "#624" becomes "624".
function plain(s) {
  return s.replace(/^#{1,6}\s*/, '')
    .replace(/^([-*+]|\d+\.)\s+/, '')
    .replace(/^>\s*/, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*|__|~~|\*/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[\uD800-\uDFFF]/g, '')                              // emoji (surrogate pairs)
    .replace(/[\u2190-\u2BFF\uFE0F\u200D]/g, '')                  // arrows, symbols, dingbats
    .replace(/(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#(\d+)/g, '$1')   // #624, owner/repo#624
    .replace(/\s*\u00B7\s*/g, ', ')                               // middle dot
    .replace(/\s{2,}/g, ' ').replace(/^[ ,:]+|[ ,]+$/g, '');
}

// A reply split into what the readout needs: the sender line (h1), the
// report's mark and topic (a heading with one of _marks), the table rows, and
// the other lines. full: the reply carries the full-readout mark
// (_fullMark, an HTML comment such as <!-- read: all -->), so it is said to
// the end, with no budget. Without _fullMark there is no such mark.
const fullMarkOf = (rules) => (rules._fullMark ? re(`^['"\`]?<?!--\\s*(?:${rules._fullMark})\\s*-->?['"\`]?$`, 'i') : null);
export function parseReply(text, rules = {}) {
  const p = { sender: '', mark: '', headTopic: '', rows: [], before: [], after: [], full: false };
  const t = String(text ?? '').replace(/```[\s\S]*?```/g, ' ');
  const fullMark = fullMarkOf(rules);
  const marks = Object.keys(marksOf(rules));
  for (let s of t.split(/\r?\n/)) {
    s = s.trim();
    if (!s) continue;
    if (fullMark?.test(s)) { p.full = true; continue; }
    if (s.length > 2000) s = s.slice(0, 2000);
    let m = s.match(/^#\s+(.*)$/);
    if (m && !p.sender) { p.sender = sessionTopic(m[1].replace(/[\uD800-\uDFFF\uFE0F\u200D]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*/g, '').trim(), rules); continue; }
    m = s.match(/^#{2,6}\s+(.*)$/);
    const mark = m && marks.find((k) => m[1].includes(k));
    if (mark && !p.mark && !p.rows.length) { p.mark = mark; p.headTopic = plain(m[1]); continue; }
    if (/^\|?[\s:\-|]+\|[\s:\-|]*$/.test(s)) continue;            // table separator row
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(s)) continue;               // horizontal rule
    if (s.startsWith('|')) {
      const cells = s.replace(/^\|+|\|+$/g, '').split('|').map((c) => plain(c.trim())).filter(Boolean);
      if (cells.length === 2 && cells[0].length < 20) { p.rows.push({ label: cells[0], value: cells[1] }); continue; }
      if (cells.length) (p.rows.length ? p.after : p.before).push(cells.join(', '));
      continue;
    }
    const line = plain(s);
    if (line) (p.rows.length ? p.after : p.before).push(line);
  }
  return p;
}

// The session whose report the overview passes on ("# 📨 TICKET 583 · Topic"),
// or '' for its own news and for senders _ignoreSenders (a regex) matches.
export function forwardedFrom(sender, overviewTitles, rules = {}) {
  if (!sender || [].concat(overviewTitles ?? []).some((t) => ieq(sender, t))) return '';
  if (rules._ignoreSenders && re(rules._ignoreSenders, 'i').test(sender)) return '';
  return sender;
}

// The overview's names: its session title and any earlier one (overviewAliases),
// which reports may still carry as their sender.
export const overviewTitles = (voices) => [voices.overviewTitle, ...[].concat(voices.overviewAliases ?? [])].filter(Boolean);

const rowOf = (p, label) => (label ? p.rows.find((r) => ieq(r.label, label))?.value ?? '' : '');

// What kind of news: question, approval, blocked, done, info (a report), or
// plain (an answer in a conversation). asks: it ends on a question to the user.
// A reply is a report only by the user's own rules: a heading mark (_marks)
// or a table row whose label has a rule. _report says which row is for the
// user (ask), what "nothing" is (nothing), and what approval and done look like.
export function classify(p, rules) {
  const marks = marksOf(rules);
  const rep = reportOf(rules) ?? {};
  const report = !!p.mark || p.rows.some((r) => ruleFor(rules, r.label));
  const markKind = p.mark ? marks[p.mark] : '';
  const mine = rowOf(p, rep.ask);
  const waits = mine && !(rep.nothing && re(`^(?:${rep.nothing})\\b`, 'i').test(mine));
  const first = (s) => sentences(s).find((x) => x.includes('?')) ?? sentences(s)[0] ?? '';
  let kind;
  if (markKind === 'blocked') kind = 'blocked';
  else if (waits && rep.approval && re(rep.approval, 'i').test(first(mine))) kind = 'approval';
  else if (markKind === 'question' || (waits && mine.includes('?'))) kind = 'question';
  else if (report) kind = rep.done && re(rep.done, 'i').test(p.rows.map((r) => r.value).join(' ')) ? 'done' : 'info';
  else kind = 'plain';
  const tail = [...p.before, ...p.rows.map((r) => r.value), ...p.after].slice(-2).join(' ');
  const asks = kind === 'question' || kind === 'approval' || kind === 'blocked' || (!report && tail.includes('?'));
  return { kind, report, asks };
}

// Should this reply be spoken? Everything the user asked for in this turn is;
// a turn started by another session, a tool or an event speaks only with a
// report or a question for the user. The rest is the sessions' small talk.
// _backgroundNews changes that for the other turns: "all" speaks them all,
// "none" none of them; the default ("questions") is as above.
export function worthSaying(cls, source, background = 'questions') {
  if (source === 'user') return true;
  if (background === 'all') return true;
  if (background === 'none') return false;
  return cls.report || cls.asks;
}

// The pool voice whose `match` keywords (a string or a list, any case) appear
// in the session title, or -1.
export function matchVoice(pool, title) {
  const t = String(title ?? '').toLowerCase();
  if (!t) return -1;
  return pool.findIndex((v) => [].concat(v?.match ?? []).some((k) => k && t.includes(String(k).toLowerCase())));
}

// The least used voice for a new session, among the voices without `match`
// (all of them if every voice has one). used: the voice indexes taken.
export function leastUsed(pool, used) {
  const free = pool.map((v, i) => i).filter((i) => ![].concat(pool[i]?.match ?? []).length);
  const cand = free.length ? free : pool.map((v, i) => i);
  const count = (i) => used.filter((u) => u % pool.length === i).length;
  return cand.reduce((best, i) => (count(i) < count(best) ? i : best), cand[0]);
}

// Who started the turn: 'user' (typed, or a slash command) or 'auto'
// (another session, a background task, an app event). The app puts its
// reminders in front of the user's own text, so they are taken off first.
export function promptSource(promptText) {
  const rest = String(promptText ?? '').replace(/^(\s*<system-reminder>[\s\S]*?<\/system-reminder>)+\s*/, '');
  if (!rest.trim()) return 'auto';
  if (/^<command-message>/.test(rest)) return 'user';
  if (/^</.test(rest) || /^Background \(from the session that started/.test(rest)) return 'auto';
  return 'user';
}

const SENT = /(?<=[.!?])\s+(?=[\p{Lu}\p{Nd}])/u;
const sentences = (s) => String(s ?? '').split(SENT).map((x) => x.trim()).filter(Boolean);
const end = (s) => (/[.!?:;,]$/.test(s) ? s : `${s}.`);

function rowSpeech(rules, label, value) {
  const rule = ruleFor(rules, label);
  if (!rule) return `${label}: ${value}`;
  const rep = reportOf(rules) ?? {};
  const m = rep.nothing && value.match(re(`^(?:${rep.nothing})\\b[\\s,.;:]*(.*)$`, 'i'));
  if (m) return m[1] ? `${rule.empty ?? ''} ${cap(m[1])}`.trim() : rule.empty ?? '';
  for (const [w, v] of Object.entries(rules._words ?? {})) value = value.replace(re(`\\b${escapeRe(w)}\\b`, 'g'), () => v);
  if (rep.pr && ieq(label, rep.pr)) value = value.replace(/(\d+\s+\p{L}+):\s*(\p{L})/gu, (m, a, b) => `${a}, ${b.toLowerCase()}`);
  if (!rule.prefix) value = cap(value);
  return (rule.prefix ?? '') + value;
}

// The opening line, the way a colleague would start: from the kind of news,
// in the voice's own manner (_team.<name>, else _team._default). The first
// time a named voice speaks for a session it says who it is. Without _team
// (the plugin default) there is no opening line.
export function introFor(ctx, kind, topic) {
  const team = ctx.rules._team ?? {};
  const name = String(ctx.voice?.name ?? '');
  const set = (ctx.isOverview ? team._overview : team[name]) ?? team._default ?? {};
  const get = (k) => set[k] ?? team._default?.[k];
  const h = ctx.address ?? '';
  if (!ctx.isOverview && name && ctx.firstTime) {
    const hello = formatTopic(get(topic ? 'first' : 'first_notopic'), topic, name, h);
    const short = formatTopic(get('short')?.[kind] ?? '', '', name, h);
    return [hello, short].filter(Boolean).join(' ');
  }
  return formatTopic(get(topic ? kind : `${kind}_notopic`) ?? '', topic, name, h);
}

// Reply text -> what is said: the opening line (if the user has any), then a
// report's table rows or an answer's sentences, within the budget (_budget
// characters); what is left out is pointed to with _details, if set. The
// question for the user always stays, last. ctx.full (the user's own turn,
// when _fullForUserTurns is on) or the full-readout mark lifts the budget.
export function toSpeech(text, ctx) {
  const { rules } = ctx;
  const p = parseReply(text, rules);
  const cls = classify(p, rules);
  const topic = ctx.topicOverride ?? (ctx.topic || p.headTopic);
  const units = [];   // { text, prio, ask }
  const intro = introFor(ctx, cls.kind, topic);
  // The user is addressed once: the opening line has the name, the rest drops it.
  const h = ctx.address && intro.includes(ctx.address) ? escapeRe(ctx.address) : '';
  const unname = (t) => (h ? cap(t.replace(re(`^${h},\\s*`), '').replace(re(`,\\s*${h}(?=[\\s,.:;!?]|$)`, 'g'), '')) : t);
  const add = (t, prio, ask = false) => { if (t) units.push({ text: end(units.length ? unname(t) : t), prio, ask }); };
  add(intro, 0);
  let dropped = false;
  if (cls.report) {
    const rep = reportOf(rules) ?? {};
    const order = rep.order ?? {};
    for (const r of p.rows) {
      const said = rowSpeech(rules, r.label, r.value);
      sentences(said).forEach((s, i) => {
        const ask = !!rep.ask && ieq(r.label, rep.ask) && s.includes('?');
        add(s, ask ? 0 : (order[Object.keys(order).find((k) => ieq(k, r.label))] ?? 3) + (i ? 4 : 0), ask);
      });
    }
    if (p.before.length || p.after.length) dropped = true;
  } else {
    // A table that is not a report is read as "label: value", in place.
    // The question in the last two lines is the one for the user (classify).
    const lines = [...p.before, ...p.rows.map((r) => `${r.label}: ${r.value}`), ...p.after];
    const all = lines.flatMap(sentences);
    const tail = lines.slice(-2).flatMap(sentences).length;
    const lastAsk = all.findLastIndex((s) => s.includes('?'));
    all.forEach((s, i) => add(s, i === lastAsk && i >= all.length - tail ? 0 : 1 + i, i === lastAsk));
  }
  // Highest priority first, while it fits; the order of the text is kept.
  const whole = p.full || !!ctx.full;
  const budget = whole ? Infinity : Number(rules._budget) || 600;
  const keep = new Set();
  let used = 0;
  for (const u of [...units].sort((a, b) => a.prio - b.prio)) {
    if (u.prio === 0 || used + u.text.length <= budget) { keep.add(u); used += u.text.length + 1; } else dropped = true;
  }
  const out = units.filter((u) => keep.has(u));
  if (dropped && rules._details) {
    const ask = out.findLastIndex((u) => u.ask);
    out.splice(ask >= 0 ? ask : out.length, 0, { text: rules._details });
  }
  let r = out.map((u) => u.text).join(' ').replace(/\s{2,}/g, ' ').trim();
  // Pronunciation fixes: words the voice says wrong as written.
  // Longest first, so "PRs" wins over "PR".
  for (const [w, v] of Object.entries(rules._spoken ?? {}).sort((x, y) => y[0].length - x[0].length)) r = r.replace(re(`\\b${escapeRe(w)}\\b`, 'g'), () => v);
  const maxLen = whole ? 6000 : 4000;
  if (r.length > maxLen) r = r.slice(0, maxLen);
  return { speech: r, ...cls, sender: p.sender };
}

// ---- audio -------------------------------------------------------------------------
function wavData(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') return null;
  let off = 12, rate = 24000, align = 2, bits = 16;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const len = wav.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 24 <= wav.length) { rate = wav.readUInt32LE(off + 12); align = wav.readUInt16LE(off + 20); bits = wav.readUInt16LE(off + 22); }
    if (id === 'data') { const start = off + 8; return { off, start, len: Math.min(len, wav.length - start), rate, align, bits }; }
    off += 8 + len + (len % 2);
  }
  return null;
}

// A short, quiet beep as a 16-bit mono WAV: for trying the player without VoiceStudio.
// VoiceStudio's 'default' voice is not one voice: without a seed (or tags)
// OmniVoice picks a new speaker for every request. A fixed seed keeps it
// closer to one voice; only a clone profile keeps it exactly the same.
export const DEFAULT_SEED = 4242;
export const isDefaultVoice = (v) => !v || v === 'default';

export function toneWav({ ms = 600, hz = 660, rate = 24000, volume = 0.2 } = {}) {
  const n = Math.floor((rate * ms) / 1000);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(n * 2, 40);
  const fade = Math.floor(rate / 100);   // 10 ms in and out, no click
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / fade, (n - 1 - i) / fade);
    b.writeInt16LE(Math.round(32767 * volume * env * Math.sin((2 * Math.PI * hz * i) / rate)), 44 + i * 2);
  }
  return b;
}

export function wavSeconds(wav) {
  const d = wavData(wav);
  return d && d.rate > 0 && d.align > 0 ? d.len / (d.rate * d.align) : -1;
}

// Silence appended to a WAV: players report the end slightly before the sound
// has left the speaker, and some voices stop abruptly; without it the last
// syllable is cut. The tail is also the pause before the next speaker.
export const TAIL_MS = 1000;
export function addSilence(wav, ms = TAIL_MS) {
  const d = wavData(wav);
  if (!d || d.rate > 384000 || d.align > 32) return wav;
  const pad = Math.floor((d.rate * ms) / 1000) * d.align;
  const out = Buffer.alloc(d.start + d.len + pad);
  wav.copy(out, 0, 0, d.start + d.len);
  out.writeUInt32LE(d.len + pad, d.off + 4);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

// Speech or noise? The share of sign changes in loud 20 ms frames: speech
// stays around 0.03-0.1, hiss near 0.5. Returns the median, -1 if unreadable.
export function noiseScore(wav) {
  const d = wavData(wav);
  if (!d || d.bits !== 16) return -1;
  const n = Math.floor(d.len / 2), frame = 480, step = Math.max(2400, Math.floor(n / 300)), scores = [];
  for (let st = 0; st + frame < n; st += step) {
    let e = 0, c = 0, p = wav.readInt16LE(d.start + 2 * st);
    for (let i = 1; i < frame; i++) {
      const x = wav.readInt16LE(d.start + 2 * (st + i));
      e += x * x;
      if ((x >= 0) !== (p >= 0)) c++;
      p = x;
    }
    if (e / frame > 107374) scores.push(c / frame);   // louder than 1% of full scale
  }
  if (!scores.length) return 0;
  scores.sort((a, b) => a - b);
  return scores[Math.floor(scores.length / 2)];
}
