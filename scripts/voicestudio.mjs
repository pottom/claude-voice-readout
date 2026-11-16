// VoiceStudio helper for the readout setup. Talks only to the local API.
//   node voicestudio.mjs check
//   node voicestudio.mjs say --text "..." [--voice <profile id|default>] [--instruct "..."] [--seed N] [--speed 1.0] [--language en] [--keep <file.wav>] [--device <name>]
//   node voicestudio.mjs make-voice --name <name> (--instruct "<tags>" [--seed N] | --from <file.wav> --text "...") [--text "..."] [--language en] [--new]
//     (a profile with the same name is reused unless --new; --from clones the
//     take a `say --keep` saved, with that say's --text: the voice is then
//     exactly the one heard. Without --from the sample is synthesized again,
//     which can sound different even with the same tags and seed)
//   node voicestudio.mjs delete-voice --id <profile id>
//   node voicestudio.mjs devices                 the output device names outputDevice can name
//   node voicestudio.mjs tone [--device <name>]  a short beep through the readout's player (no VoiceStudio needed)
// say and tone play on config.json's outputDevice unless --device is given.
// The API address, first match wins: VOICESTUDIO_URL, config.json url,
// voices.json url, the port in the installed VoiceStudio's app.json,
// http://127.0.0.1:3900 (see config.mjs resolveUrl).
// Output: one JSON line on stdout; exit code 0 = ok, 2 = VoiceStudio not reachable,
// 3 = a model licence is not accepted in VoiceStudio (licenceRequired names them), 1 = other error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSettings, resolveUrl, findVoicestudioApp } from './config.mjs';
import { playSync, playerCommand, listDevices } from './player.mjs';
import { toneWav, addSilence, DEFAULT_SEED, isDefaultVoice } from './lib.mjs';

const settings = loadSettings();
const where = resolveUrl({ settings });
const API = where.url;
const [cmd, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) opt[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') ? true : rest[++i];

// A voice's identity sample: spoken once, in the target language, then saved
// as a clone profile, so every later part of a reply clones this one sample
// instead of designing a new voice from the tags each time.
const SAMPLE = {
  hu: 'Jó napot kívánok. Átnéztem a mai teendőket, és minden a helyén van. Ha kérdésed van, szólj nyugodtan, szívesen segítek.',
  en: 'Good day. I have gone through today\'s tasks, and everything is in order. If you have a question, just ask, I am happy to help.',
};
const LANG_NAME = { hu: 'Hungarian', en: 'English' };

// Ends the command: prints the result and unwinds (process.exit with open
// fetch handles trips a libuv assertion on Windows).
class Done extends Error {}
function out(obj, code = 0) { console.log(JSON.stringify(obj)); process.exitCode = code; throw new Done(); }
async function call(p, init) {
  let r;
  try { r = await fetch(API + p, { ...init, redirect: 'error', signal: AbortSignal.timeout(init?.timeout ?? 10000) }); }
  catch (e) {
    // Not reachable: say where it was looked for and whether the app is installed.
    const app = findVoicestudioApp({ extra: settings.voicestudioApp });
    out({ ok: false, reachable: false, url: API, urlSource: where.source, installedApp: app?.dir ?? null, error: String(e.cause?.code || e.message) }, 2);
  }
  const body = Buffer.from(await r.arrayBuffer());
  if (!r.ok) {
    // A model whose licence was not accepted in VoiceStudio answers 403
    // model_licence_required: name the models, so the setup can say what to accept.
    let licence = null;
    try { const d = JSON.parse(body.toString('utf8')).detail; if (d?.code === 'model_licence_required') licence = (d.models || []).map((m) => m.repo_id); } catch {}
    if (licence) out({ ok: false, reachable: true, status: r.status, licenceRequired: licence, error: 'VoiceStudio: the licence of these models is not accepted; accept it in VoiceStudio\'s Model Catalogue' }, 3);
    out({ ok: false, reachable: true, status: r.status, error: body.toString('utf8').slice(0, 500) }, 1);
  }
  return { r, body };
}
const json = (b) => JSON.parse(b.toString('utf8'));
// An optional read: null when the endpoint is missing (older VoiceStudio) or fails.
async function probe(p) {
  try { const r = await fetch(API + p, { redirect: 'error', signal: AbortSignal.timeout(10000) }); return r.ok ? await r.json() : null; } catch { return null; }
}
// The OmniVoice parts whose licence VoiceStudio wants accepted before it
// synthesizes: the TTS models from /models, and the audio tokenizer, which
// /models does not list.
const OMNIVOICE_PARTS = ['eustlb/higgs-audio-v2-tokenizer'];
async function licencesMissing() {
  const models = (await probe('/models'))?.models;
  if (!Array.isArray(models)) return null;   // this VoiceStudio has no licence gate
  const repos = models.filter((m) => m.installed && (m.engines || []).includes('omnivoice')).map((m) => m.repo_id);
  const missing = [];
  for (const repo of [...repos, ...OMNIVOICE_PARTS]) {
    const a = await probe(`/models/licenses/acceptance/${encodeURIComponent(repo)}`);
    if (a?.required && !a.accepted) missing.push(repo);
  }
  return missing;
}

async function synth({ text, voice = 'default', instruct, seed, language, speed }) {
  const req = { model: 'omnivoice', input: text, voice, response_format: 'wav' };
  if (Number(speed) >= 0.25 && Number(speed) <= 4) req.speed = Number(speed);
  if (typeof language === 'string' && language) req.language = language;
  if (instruct) req.instruct = instruct;
  if (seed !== undefined) req.seed = Number(seed);
  else if (isDefaultVoice(voice) && !instruct) req.seed = DEFAULT_SEED;   // the same 'default' voice the readout uses
  const { body } = await call('/v1/audio/speech', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req), timeout: 300000,
  });
  return body;
}

// The same player and device the readout uses (player.mjs).
const playOpts = () => ({ outputDevice: typeof opt.device === 'string' ? opt.device : settings.outputDevice, playerCommand: settings.playerCommand });
const play = (file) => playSync(file, playOpts());

function playTemp(wav) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-readout-say-'));
  const file = path.join(tmp, 'say.wav');
  try { fs.writeFileSync(file, wav); return play(file); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

try {
if (cmd === 'devices') {
  out({ ok: true, platform: process.platform, devices: listDevices(), outputDevice: settings.outputDevice || null });
} else if (cmd === 'tone') {
  const c = playerCommand('x.wav', playOpts());
  out({ ok: true, played: playTemp(toneWav()), player: c?.cmd ?? null, device: c?.device || null, deviceIgnored: !!c?.deviceIgnored });
} else if (cmd === 'check') {
  const health = json((await call('/health')).body);
  const model = json((await call('/model/status')).body);
  const profiles = json((await call('/profiles')).body).map((p) => ({ id: p.id, name: p.name, kind: p.kind, language: p.language }));
  const licenceRequired = (await licencesMissing()) || [];
  const ok = health.status === 'ok' && !licenceRequired.length;
  out({ ok, reachable: true, url: API, urlSource: where.source, version: health.version, device: health.device, modelLoaded: !!model.loaded, licenceRequired, profiles }, ok ? 0 : licenceRequired.length ? 3 : 1);
} else if (cmd === 'say') {
  if (!opt.text) out({ ok: false, error: '--text is required' }, 1);
  const t0 = Date.now();
  const wav = await synth(opt);
  const seconds = (Date.now() - t0) / 1000;
  // --keep <file.wav>: the take is kept, so make-voice --from can clone exactly what was heard.
  if (typeof opt.keep === 'string') fs.writeFileSync(opt.keep, wav);
  const played = playTemp(addSilence(wav));   // the same tail the readout plays, or the last syllable is cut
  out({ ok: true, played, synthSeconds: seconds, bytes: wav.length, kept: typeof opt.keep === 'string' ? opt.keep : null });
} else if (cmd === 'make-voice') {
  if (!opt.name || !(opt.instruct || typeof opt.from === 'string')) out({ ok: false, error: '--name and --instruct (or --from) are required' }, 1);
  if (typeof opt.from === 'string' && !(typeof opt.text === 'string' && opt.text.trim())) out({ ok: false, error: '--from needs --text: what the clip says' }, 1);
  // A rerun of the setup reuses a voice it made before instead of a duplicate.
  const existing = json((await call('/profiles')).body).find((p) => p.name === opt.name);
  if (existing && !opt.new) out({ ok: true, id: existing.id, name: existing.name, reused: true });
  const language = typeof opt.language === 'string' ? opt.language : 'en';
  const text = typeof opt.text === 'string' && opt.text.trim() ? opt.text : (SAMPLE[language] || SAMPLE.en);
  // --from <file.wav>: the take kept by `say --keep` (with its --text): the same
  // tags and seed synthesized again can sound different from what was heard.
  const wav = typeof opt.from === 'string' ? fs.readFileSync(opt.from) : await synth({ text, voice: 'default', instruct: opt.instruct, seed: opt.seed ?? DEFAULT_SEED, language });
  const fd = new FormData();
  fd.set('name', opt.name);
  fd.set('kind', 'clone');
  fd.set('language', LANG_NAME[language] || 'Auto');
  fd.set('ref_text', text);
  fd.set('ref_audio', new Blob([wav], { type: 'audio/wav' }), 'sample.wav');
  const prof = json((await call('/profiles', { method: 'POST', body: fd, timeout: 120000 })).body);
  out({ ok: true, id: prof.id, name: prof.name });
} else if (cmd === 'delete-voice') {
  if (!opt.id) out({ ok: false, error: '--id is required' }, 1);
  await call(`/profiles/${encodeURIComponent(opt.id)}`);   // a missing profile ends here with ok:false
  await call(`/profiles/${encodeURIComponent(opt.id)}`, { method: 'DELETE' });
  out({ ok: true, deleted: opt.id });
} else {
  out({ ok: false, error: 'usage: check | say | make-voice | delete-voice | devices | tone' }, 1);
}
} catch (e) { if (!(e instanceof Done)) { console.log(JSON.stringify({ ok: false, error: String(e.message || e) })); process.exitCode = 1; } }
