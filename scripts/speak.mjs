// Background speaker: synthesize one queued reply with VoiceStudio, then wait
// for its turn and play it. Replies from all sessions play one after another,
// in the order they arrived (queue item names start with a tick count).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dir, work, queue, recent, readJson, log, alive, freshFile, lock, unlock, sleep, addSilence, noiseScore, wavSeconds, SAY_MAX_AGE_MS, DEFAULT_SEED, isDefaultVoice, TAIL_MS } from './lib.mjs';
import { loadSettings, resolveUrl } from './config.mjs';
import { startPlayer } from './player.mjs';

const itemFile = path.resolve(process.argv[2] ?? '');
const pidFile = `${itemFile}.pid`;
const playingFile = `${itemFile}.playing`;
const playLock = path.join(work, 'play.lock');
const settings = loadSettings(dir);
// Reply text only goes to a local address (resolveUrl never returns another).
const base = resolveUrl({ settings }).url;
let item, locked = false;

// The pid file names this speaker, and while it plays, the player too: that
// is what /readout off stops.
const writePids = (...pids) => fs.writeFileSync(pidFile, pids.filter(Boolean).join('\n'));
const wanted = () => fs.existsSync(itemFile);   // gone = queue cleared (/readout off)

async function synth(seed, text = item.text) {
  const req = { model: 'omnivoice', input: text, voice: item.voice, response_format: 'wav' };
  if (item.language) req.language = item.language;   // unset: VoiceStudio's own default
  if (item.instruct) req.instruct = item.instruct;
  if (Number(item.speed) >= 0.25 && Number(item.speed) <= 4) req.speed = Number(item.speed);
  if (seed != null) req.seed = seed; else if (item.seed != null) req.seed = Number(item.seed);
  else if (isDefaultVoice(item.voice) && !item.instruct) req.seed = DEFAULT_SEED;
  try {
    const r = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req),
      redirect: 'error',   // a redirect would carry the reply text off this machine
      signal: AbortSignal.timeout(300000),
    });
    if (r.ok) return Buffer.from(await r.arrayBuffer());
    log(`synth-http ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`, itemFile);
    return null;
  } catch (e) { log(`synth-error ${e.cause?.code || e.message}`, itemFile); return null; }
}

// The last ten takes are kept (audio and text) for when something sounds wrong.
// Diagnostics only: a failure here never stops the playback.
function saveRecent(wav, verdict, score) {
  try {
    fs.mkdirSync(recent, { recursive: true });
    const name = `${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').slice(0, 19)}-${verdict}-${crypto.randomBytes(3).toString('hex')}`;
    if (wav) fs.writeFileSync(path.join(recent, `${name}.wav`), wav);
    fs.writeFileSync(path.join(recent, `${name}.json`), JSON.stringify({ verdict, score, voice: item.voice, speaker: item.speaker, text: item.text }));
    const metas = fs.readdirSync(recent).filter((f) => f.endsWith('.json')).sort().reverse().slice(10);
    for (const f of metas) for (const g of [f, f.replace(/\.json$/, '.wav')]) fs.rmSync(path.join(recent, g), { force: true });
  } catch {}
}

// One synthesis, checked: a failed request or a noise take is tried once more
// (another seed for the noise); a second noise take is skipped, not played.
async function checkedAudio(text = item.text) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const wav = await synth(attempt > 1 ? crypto.randomInt(1, 1000000) : null, text);
    if (!wav) { log(`synth-failed try ${attempt}`, itemFile); saveRecent(null, 'failed', -1); await sleep(800); continue; }
    const score = noiseScore(wav);
    if (score > 0.25) { log(`noise ${score.toFixed(3)} try ${attempt}`, itemFile); saveRecent(wav, 'noise', score); continue; }
    saveRecent(wav, 'ok', score);
    return wav;
  }
  return null;
}

// An item whose speaker is gone (crashed, killed) must not hold up the queue.
function itemAlive(name) {
  const p = path.join(queue, `${name}.pid`);
  let owner = 0;
  try { owner = parseInt(fs.readFileSync(p, 'utf8'), 10); } catch {
    const st = fs.statSync(path.join(queue, name), { throwIfNoEntry: false });
    return !!st && st.mtimeMs > Date.now() - 2 * 60 * 1000;
  }
  if (!freshFile(p)) return false;                 // from before a reboot, or too old
  return Number.isNaN(owner) || alive(owner);      // unreadable but fresh: being written
}

async function waitMyTurn() {
  const deadline = Date.now() + 20 * 60 * 1000;
  const me = path.basename(itemFile);
  while (Date.now() < deadline) {
    if (!wanted()) return false;
    const head = fs.readdirSync(queue).filter((f) => f.endsWith('.json')).sort()[0];
    if (!head || head === me) return true;
    if (!itemAlive(head)) {
      log(`drop-dead ${head}`);
      for (const f of [head, `${head}.pid`]) fs.rmSync(path.join(queue, f), { force: true });
      continue;
    }
    await sleep(300);
  }
  return false;
}

function play(wav) {
  const file = `${itemFile}.wav`;
  fs.writeFileSync(file, wav);
  return new Promise((resolve) => {
    const child = startPlayer(file, { outputDevice: settings.outputDevice, playerCommand: settings.playerCommand });
    if (!child) { log('no-player', itemFile); return resolve(); }
    writePids(process.pid, child.pid);
    // A hung player must not hold the play lock: it gets the sound's length
    // plus half a minute.
    const d = wavSeconds(wav);
    const guard = setTimeout(() => { try { child.kill(); } catch {} }, ((d > 0 ? d : 600) + 30) * 1000);
    const done = () => { clearTimeout(guard); resolve(); };
    child.on('error', done);
    child.on('exit', done);
  }).finally(() => fs.rmSync(file, { force: true }));
}

async function main() {
  writePids(process.pid);
  item = readJson(itemFile);
  // The whole reply in one synthesis: a voice with no seams.
  const audio = await checkedAudio();
  if (!audio || !(await waitMyTurn())) return;
  locked = await lock(playLock, 20 * 60 * 1000, wanted);   // only one speaker plays at a time
  if (!locked || !wanted()) return;
  // News that waited too long is stale: the screen has moved on.
  if (item.at && Date.now() - item.at > SAY_MAX_AGE_MS) { log('too-old', itemFile); return; }
  fs.writeFileSync(playingFile, '');   // from here on a newer item does not replace this one
  log(`start ${item.speaker}`, itemFile);
  await play(addSilence(audio, TAIL_MS));
  log('end', itemFile);
}

main().catch(() => {}).finally(() => {
  for (const f of [itemFile, pidFile, playingFile]) fs.rmSync(f, { force: true });
  if (locked) unlock(playLock);
  process.exitCode = 0;
});
