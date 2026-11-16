// Claude Code Stop hook: when the readout is on, queue the final reply for the
// background speaker. Never blocks the session, never fails it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { dir, work, queue, isOn, readJson, lock, unlock, toSpeech, parseReply, classify, worthSaying, promptSource, forwardedFrom, overviewTitles, sessionTopic, matchVoice, leastUsed, SPEAKER_MAX_MS, SAY_MAX_AGE_MS } from './lib.mjs';
import { pluginRoot, loadRules, loadVoices, legacyInstallActive } from './config.mjs';

const saidFile = path.join(work, 'said.json');
const FORWARD_WINDOW_MS = 15 * 60 * 1000;   // a forwarded report this soon after the original is not said again

async function main() {
  // The old settings.json install speaks for itself; not twice.
  if (!isOn() || legacyInstallActive()) return;
  let raw = '';
  for await (const c of process.stdin) raw += c;
  const input = JSON.parse(raw);
  if (input.stop_hook_active) return;

  let text = input.last_assistant_message;
  if (text && typeof text !== 'string') text = (text.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (!text) text = lastReplyFromTranscript(input.transcript_path);
  if (!text) return;
  // Bounded work: the reply may echo untrusted text. Only the first 4000
  // characters are spoken anyway.
  if (text.length > 20000) text = text.slice(0, 20000);

  const rules = loadRules(dir);
  const voices = loadVoices(dir);
  // Who is speaking: the session's title in the app ("TICKET 604 · Topic" -> "Topic").
  const topic = sessionTopic(sessionTitle(input.transcript_path), rules);
  const isOverview = !!topic && overviewTitles(voices).some((t) => topic.toLowerCase() === String(t).toLowerCase());

  // Only what is the user's: an answer to their own message, a report, a
  // question. A turn another session or an event started stays quiet otherwise.
  const parsed = parseReply(text, rules);
  const cls = classify(parsed, rules);
  const source = promptSource(lastPrompt(input.transcript_path));
  if (!worthSaying(cls, source, rules._backgroundNews)) return;

  fs.mkdirSync(queue, { recursive: true });
  cleanup();
  // The overview forwarding another session's report: that session has said
  // it already, unless it was long ago (or never: a cloud session).
  const forwardOf = isOverview ? forwardedFrom(parsed.sender, overviewTitles(voices), rules) : '';
  if (forwardOf && saidRecently(forwardOf)) return;

  const pick = isOverview ? { voice: voices.overview, first: false } : await poolVoice(voices, input.session_id, topic);
  const address = voices.address || readAddress();
  const ctx = { rules, voices, voice: pick.voice, firstTime: pick.first, isOverview, topic: isOverview ? '' : topic, address, topicOverride: forwardOf || undefined, full: source === 'user' && !!rules._fullForUserTurns };
  const { speech, kind } = toSpeech(text, ctx);
  if (!speech) return;

  const item = {
    text: speech, voice: pick.voice?.voice, instruct: pick.voice?.instruct ?? null, seed: pick.voice?.seed ?? null, speed: pick.voice?.speed ?? voices.speed ?? null,
    engine: voices.engine === 'piper' ? 'piper' : 'voicestudio',
    language: voices.language || null, speaker: topic, kind,
    session: input.session_id ?? null, at: Date.now(),
  };
  const name = `${(BigInt(Date.now()) * 10000n + 621355968000000000n).toString().padStart(19, '0')}-${crypto.randomBytes(4).toString('hex')}.json`;
  const file = path.join(queue, name);
  fs.writeFileSync(file, JSON.stringify(item));
  supersede(item.session, name);
  if (topic && !isOverview) markSaid(topic);
  spawn(process.execPath, [path.join(pluginRoot, 'scripts', 'speak.mjs'), file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// A session's newer news replaces its older one that has not started playing.
// The older speaker sees its item gone and stops.
function supersede(session, newest) {
  if (!session) return;
  for (const f of fs.readdirSync(queue).filter((n) => n.endsWith('.json') && n < newest)) {
    const full = path.join(queue, f);
    if (fs.existsSync(`${full}.playing`)) continue;
    try { if (readJson(full).session === session) fs.rmSync(full, { force: true }); } catch {}
  }
}

const topicKey = (t) => String(t).trim().toLowerCase();
function saidRecently(topic) {
  try { return Date.now() - (readJson(saidFile)[topicKey(topic)] ?? 0) < FORWARD_WINDOW_MS; } catch { return false; }
}
function markSaid(topic) {
  let said = {};
  try { said = readJson(saidFile); } catch {}
  const now = Date.now();
  for (const [k, v] of Object.entries(said)) if (now - v > Math.max(FORWARD_WINDOW_MS, SAY_MAX_AGE_MS)) delete said[k];
  said[topicKey(topic)] = now;
  try { const tmp = `${saidFile}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(said)); fs.renameSync(tmp, saidFile); } catch {}
}

function readAddress() {
  try { return String(readJson(path.join(dir, 'answers.json')).address ?? ''); } catch { return ''; }
}

// The text of the user turn that started this reply (all its text blocks):
// what tells a user's own message from another session's or an event's.
function lastPrompt(p) {
  if (!p || !fs.existsSync(p)) return '';
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).slice(-2000);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"type":"user"')) continue;
    let e; try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e.type !== 'user' || e.isMeta) continue;
    const c = e.message?.content;
    if (Array.isArray(c) && c.some((x) => x.type === 'tool_result')) continue;
    const s = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '';
    if (s) return s;
  }
  return '';
}

function lastReplyFromTranscript(p) {
  if (!p || !fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).slice(-300);
  for (let i = lines.length - 1; i >= 0; i--) {
    let e; try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e.type !== 'assistant') continue;
    const texts = (e.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text);
    if (texts.length) return texts.join('\n');
  }
  return null;
}

function sessionTitle(p) {
  if (!p || !fs.existsSync(p)) return null;
  const hits = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.includes('"customTitle":'));
  const m = hits.at(-1)?.match(/"customTitle":"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch { return null; }
}

// Leftovers of crashed speakers; the voice map and locks stay.
function cleanup() {
  const old = Date.now() - SPEAKER_MAX_MS - 10 * 60 * 1000;   // longer than any speaker lives
  for (const d of [work, queue]) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (!f.isFile() || f.name === 'voice-map.json' || f.name.endsWith('.lock')) continue;
      const full = path.join(d, f.name);
      try { if (fs.statSync(full).mtimeMs < old) fs.unlinkSync(full); } catch {}
    }
  }
}

// The voice: the overview has its own; a session whose title has one of a
// pool voice's `match` keywords gets that voice; every other session keeps one
// pool voice for its life, the least used one (of the voices without `match`)
// among the sessions of the last day. The map also remembers whether the
// voice has introduced itself already.
async function poolVoice(voices, sessionId, topic) {
  const pool = [].concat(voices.pool ?? []);
  if (!sessionId || pool.length === 0) return { voice: pool[0] ?? voices.main ?? voices.overview ?? { voice: 'default' }, first: true };
  const mapFile = path.join(work, 'voice-map.json');
  const lockFile = path.join(work, 'voice-map.lock');
  if (!(await lock(lockFile, 5000))) return { voice: pool[0], first: true };   // no lock: leave the map alone
  try {
    const map = {};
    try {
      const day = Date.now() - 24 * 3600 * 1000;
      for (const [k, v] of Object.entries(readJson(mapFile))) if (Date.parse(v.seen) > day) map[k] = v;
    } catch {}
    let idx, first = true;
    const matched = matchVoice(pool, topic);
    const prev = map[sessionId];
    if (matched >= 0) { idx = matched; first = !(prev && Number(prev.idx) === matched && prev.intro); }
    else if (prev) { idx = Number(prev.idx) % pool.length; first = !prev.intro; }
    else idx = leastUsed(pool, Object.values(map).map((v) => Number(v.idx)));
    map[sessionId] = { idx, intro: true, seen: new Date().toISOString() };
    const tmp = `${mapFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, mapFile);
    return { voice: pool[idx], first };
  } finally { unlock(lockFile); }
}

main().catch(() => {}).finally(() => { process.exitCode = 0; });
