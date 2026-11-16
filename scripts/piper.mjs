// Piper: a small local TTS engine (github.com/OHF-voice/piper1-gpl) that runs
// on the CPU many times faster than real time. Optional, instead of
// VoiceStudio: voices.json "engine": "piper", main.voice = a Piper voice name
// such as "hu_HU-berta-medium". It runs only while it makes a take; nothing
// stays running in the background.
//
// Where it lives: config.json piperDir, else <readout folder>/piper, with
//   venv/        a Python virtual environment with the piper-tts package
//   voices/      <voice>.onnx and <voice>.onnx.json
// The folder's path must stay short: Piper's bundled eSpeak cannot find its
// data under a path of about 160 characters or more.
//
// Setup helper (JSON on stdout; exit code 0 = ok, 1 = error):
//   node piper.mjs check                          installed? which voices? path ok?
//   node piper.mjs install                        venv + pip install piper-tts (needs python3)
//   node piper.mjs download --voice <name>        a voice from huggingface.co/rhasspy/piper-voices
//   node piper.mjs say --voice <name> --text "..." [--speed 1.0] [--keep <file.wav>] [--device <name>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { userDir, loadSettings } from './config.mjs';

export const VOICES_URL = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
const ESPEAK_PATH_LIMIT = 160;

export function piperPaths(settings = {}, dir = userDir()) {
  const root = typeof settings.piperDir === 'string' && settings.piperDir ? path.resolve(settings.piperDir) : path.join(dir, 'piper');
  const win = process.platform === 'win32';
  return {
    root,
    python: path.join(root, 'venv', win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python'),
    exe: path.join(root, 'venv', win ? 'Scripts' : 'bin', win ? 'piper.exe' : 'piper'),
    voices: path.join(root, 'voices'),
  };
}

// Piper voice names: <lang>_<REGION>-<name>-<quality>, e.g. hu_HU-berta-medium.
export const isVoiceName = (v) => typeof v === 'string' && /^[a-z]{2,3}_[A-Z]{2}-[A-Za-z0-9_]+-(x_low|low|medium|high)$/.test(v);

export function voiceUrls(voice) {
  if (!isVoiceName(voice)) return null;
  const [locale, name, quality] = voice.split('-');
  const base = `${VOICES_URL}/${locale.split('_')[0]}/${locale}/${name}/${quality}/${voice}`;
  return { model: `${base}.onnx`, config: `${base}.onnx.json` };
}

export function installedVoices(paths) {
  try { return fs.readdirSync(paths.voices).filter((f) => f.endsWith('.onnx')).map((f) => f.slice(0, -5)).filter((v) => fs.existsSync(path.join(paths.voices, `${v}.onnx.json`))); } catch { return []; }
}

// Speed as in voices.json (1 = normal, higher = faster) becomes Piper's
// length scale (lower = faster).
export function lengthScale(speed) {
  const s = Number(speed) >= 0.25 && Number(speed) <= 4 ? Number(speed) : 1;
  return Math.round((1 / s) * 100) / 100;
}

// One take: the text in, a WAV out. null when Piper is missing or fails.
// `signal` stops Piper (the reply was replaced, or the readout turned off).
export function piperSynth(text, { voice, speed, settings = {}, dir = userDir(), signal } = {}) {
  const p = piperPaths(settings, dir);
  const model = path.join(p.voices, `${voice}.onnx`);
  if (!isVoiceName(voice) || !fs.existsSync(p.exe) || !fs.existsSync(model)) return Promise.resolve(null);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-readout-piper-'));
  const out = path.join(tmp, 'take.wav');
  return new Promise((resolve) => {
    const child = spawn(p.exe, ['-m', model, '-f', out, '--length-scale', String(lengthScale(speed))], { cwd: p.root, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    const stop = () => { try { child.kill(); } catch {} };
    signal?.addEventListener('abort', stop, { once: true });
    const guard = setTimeout(stop, 120000);
    child.on('error', () => resolve(null));
    child.on('exit', (code) => {
      clearTimeout(guard);
      signal?.removeEventListener('abort', stop);
      try { resolve(code === 0 && fs.existsSync(out) ? fs.readFileSync(out) : null); } catch { resolve(null); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(String(text));
  }).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
}

async function cli(args) {
  const { playSync } = await import('./player.mjs');
  const [cmd, ...rest] = args;
  const opt = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) opt[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') ? true : rest[++i];
  const settings = loadSettings();
  const p = piperPaths(settings);
  const out = (o, code = 0) => { console.log(JSON.stringify(o)); process.exitCode = code; };
  // The longest path Piper's eSpeak reads: <venv>/lib/pythonX.Y/site-packages/piper/espeak-ng-data/phontab.
  const espeakPath = path.join(p.root, 'venv', 'lib', 'python3.13', 'site-packages', 'piper', 'espeak-ng-data', 'phontab');
  const pathOk = espeakPath.length < ESPEAK_PATH_LIMIT;

  if (cmd === 'check') {
    return out({ ok: fs.existsSync(p.exe) && pathOk, installed: fs.existsSync(p.exe), dir: p.root, pathOk, voices: installedVoices(p) }, fs.existsSync(p.exe) && pathOk ? 0 : 1);
  }
  if (cmd === 'install') {
    if (!pathOk) return out({ ok: false, error: `the Piper folder's path is too long for eSpeak; set config.json piperDir to a shorter folder`, dir: p.root }, 1);
    const py = ['python3', 'python'].find((c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0);
    if (!py) return out({ ok: false, error: 'Python 3 is needed to install Piper (python.org)' }, 1);
    fs.mkdirSync(p.root, { recursive: true });
    const venv = spawnSync(py, ['-m', 'venv', path.join(p.root, 'venv')], { encoding: 'utf8' });
    if (venv.status !== 0) return out({ ok: false, error: (venv.stderr || 'venv failed').slice(-500) }, 1);
    const pip = spawnSync(p.python, ['-m', 'pip', 'install', '--quiet', 'piper-tts'], { encoding: 'utf8' });
    if (pip.status !== 0 || !fs.existsSync(p.exe)) return out({ ok: false, error: (pip.stderr || 'pip install failed').slice(-500) }, 1);
    return out({ ok: true, dir: p.root });
  }
  if (cmd === 'download') {
    const urls = voiceUrls(opt.voice);
    if (!urls) return out({ ok: false, error: '--voice must be a Piper voice name, such as hu_HU-berta-medium' }, 1);
    fs.mkdirSync(p.voices, { recursive: true });
    for (const [kind, url] of Object.entries(urls)) {
      const r = await fetch(url, { signal: AbortSignal.timeout(300000) });
      if (!r.ok) return out({ ok: false, error: `${kind}: HTTP ${r.status}`, url }, 1);
      fs.writeFileSync(path.join(p.voices, `${opt.voice}${kind === 'model' ? '.onnx' : '.onnx.json'}`), Buffer.from(await r.arrayBuffer()));
    }
    return out({ ok: true, voice: opt.voice, voices: installedVoices(p) });
  }
  if (cmd === 'say') {
    if (!opt.text || !opt.voice) return out({ ok: false, error: '--voice and --text are required' }, 1);
    const t0 = Date.now();
    const wav = await piperSynth(opt.text, { voice: opt.voice, speed: opt.speed, settings });
    const synthSeconds = (Date.now() - t0) / 1000;
    if (!wav) return out({ ok: false, error: 'Piper made no audio: check that Piper and this voice are installed (piper.mjs check)' }, 1);
    const { addSilence } = await import('./lib.mjs');
    if (typeof opt.keep === 'string') fs.writeFileSync(opt.keep, wav);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-readout-say-'));
    const file = path.join(tmp, 'say.wav');
    let played = false;
    try { fs.writeFileSync(file, addSilence(wav)); played = playSync(file, { outputDevice: typeof opt.device === 'string' ? opt.device : settings.outputDevice, playerCommand: settings.playerCommand }); }
    finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    return out({ ok: true, played, synthSeconds, bytes: wav.length });
  }
  out({ ok: false, error: 'usage: check | install | download --voice <name> | say --voice <name> --text "..."' }, 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  cli(process.argv.slice(2)).catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e.message || e) })); process.exitCode = 1; });
}
