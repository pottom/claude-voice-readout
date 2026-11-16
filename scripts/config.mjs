// Where things are and what the user configured. The plugin's own folder is
// read-only (it moves on every update); everything personal and every work
// file lives in the user folder, ~/.claude/voice-readout by default, the same
// folder the old voice-readout-setup install used, so its data keeps working.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { V1_RULES, isV1Rules } from './compat-v1.mjs';

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultsDir = path.join(pluginRoot, 'defaults');
export const DEFAULT_URL = 'http://127.0.0.1:3900';

export const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const readJsonOr = (f, fallback) => { try { return readJson(f); } catch { return fallback; } };
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

// The Claude Code config folder: CLAUDE_CONFIG_DIR if set, else ~/.claude.
export function claudeHome(env = process.env, home = os.homedir()) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude');
}

// The user folder: VOICE_READOUT_DIR if set, else <claude home>/voice-readout.
export function userDir(env = process.env, home = os.homedir()) {
  return env.VOICE_READOUT_DIR ? path.resolve(env.VOICE_READOUT_DIR) : path.join(claudeHome(env, home), 'voice-readout');
}

// Speech rules: the plugin's defaults, with the user's file over them. The
// user's pronunciations and words (_spoken, _words) are added to the shipped
// ones, each voice's opening lines (_team.<name>) to the default set, kind by
// kind; any other key the user sets replaces the default.
export function mergeRules(defaults, user) {
  const out = { ...defaults, ...user };
  for (const k of ['_spoken', '_words']) out[k] = { ...defaults[k], ...user[k] };
  const team = { ...defaults._team };
  for (const [name, lines] of Object.entries(user._team ?? {})) {
    team[name] = isObj(team[name]) && isObj(lines) ? { ...team[name], ...lines } : lines;
  }
  out._team = team;
  return out;
}

export function loadRules(dir = userDir()) {
  let user = readJsonOr(path.join(dir, 'speech-rules.json'), {});
  // A rules file from the earlier standalone installer gets its report settings back.
  if (isV1Rules(user)) user = { ...V1_RULES, ...user };
  return mergeRules(readJson(path.join(defaultsDir, 'speech-rules.json')), user);
}

// Voices: the user's voices.json, else the neutral default (VoiceStudio's
// built-in voice, no name, nobody addressed by name).
export function loadVoices(dir = userDir()) {
  const defaults = readJson(path.join(defaultsDir, 'voices.json'));
  const user = readJsonOr(path.join(dir, 'voices.json'), null);
  return user ? { ...defaults, ...user } : defaults;
}

// The spoken style added to every prompt while the readout is on.
export function loadStyle(dir = userDir()) {
  for (const f of [path.join(dir, 'style.txt'), path.join(defaultsDir, 'style.txt')]) {
    try { return fs.readFileSync(f, 'utf8'); } catch {}
  }
  return '';
}

// Machine settings (config.json in the user folder):
//   url            VoiceStudio API address (local only)
//   outputDevice   play on this output device instead of the default one
//   playerCommand  ["cmd", "arg", ..., "{file}"]: a player of your own
//   voicestudioApp where VoiceStudio is installed, if not in the usual place
// voices.json's url (the old install's key) still counts when config.json has none.
export function loadSettings(dir = userDir()) {
  const c = readJsonOr(path.join(dir, 'config.json'), {});
  const v = readJsonOr(path.join(dir, 'voices.json'), {});
  return {
    url: c.url ?? v.url ?? null,
    outputDevice: typeof c.outputDevice === 'string' ? c.outputDevice.trim() : '',
    playerCommand: Array.isArray(c.playerCommand) && c.playerCommand.length && c.playerCommand.every((x) => typeof x === 'string') ? c.playerCommand : null,
    voicestudioApp: c.voicestudioApp ?? null,
    piperDir: typeof c.piperDir === 'string' && c.piperDir ? c.piperDir : null,
  };
}

// Reply text only ever goes to this machine.
export const isLocalUrl = (u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/i.test(String(u ?? ''));

// VoiceStudio's own config (resources/config/app.json) names its backend port.
// The usual install places per OS; voicestudioApp in config.json adds one.
export function voicestudioAppDirs(platform = process.platform, env = process.env, home = os.homedir(), extra = null) {
  const dirs = [];
  if (extra) dirs.push(extra);
  if (platform === 'win32') {
    if (env.ProgramFiles) dirs.push(path.win32.join(env.ProgramFiles, 'VoiceStudio'));
    if (env.LOCALAPPDATA) dirs.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'VoiceStudio'));
  } else if (platform === 'darwin') {
    dirs.push('/Applications/VoiceStudio.app', path.posix.join(home, 'Applications', 'VoiceStudio.app'));
  } else {
    dirs.push('/opt/VoiceStudio', '/usr/lib/voicestudio', path.posix.join(home, 'Applications', 'VoiceStudio'));
  }
  return dirs;
}

// app.json inside an install: <app>/resources/config (Windows, Linux) or
// <app>.app/Contents/Resources/config (macOS); a path to app.json itself works too.
function appJsonCandidates(dir, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (/app\.json$/i.test(dir)) return [dir];
  return platform === 'darwin'
    ? [p.join(dir, 'Contents', 'Resources', 'config', 'app.json'), p.join(dir, 'resources', 'config', 'app.json')]
    : [p.join(dir, 'resources', 'config', 'app.json')];
}

export function findVoicestudioApp({ platform = process.platform, env = process.env, home = os.homedir(), extra = null, read = readJsonOr } = {}) {
  for (const dir of voicestudioAppDirs(platform, env, home, extra)) {
    for (const f of appJsonCandidates(dir, platform)) {
      const j = read(f, null);
      if (j) return { dir, appJson: f, port: Number(j?.ports?.backend) || null };
    }
  }
  return null;
}

// The VoiceStudio address, first match wins: VOICESTUDIO_URL, config.json
// url, voices.json url, the port in the installed app's app.json, the
// default. A non-local address is never used.
export function resolveUrl({ env = process.env, settings = loadSettings(), platform = process.platform, home = os.homedir(), read } = {}) {
  const pick = (url, source) => (isLocalUrl(url) ? { url: String(url).replace(/\/+$/, ''), source } : null);
  const fromEnv = env.VOICESTUDIO_URL && pick(env.VOICESTUDIO_URL, 'env');
  if (fromEnv) return fromEnv;
  const fromConfig = settings.url && pick(settings.url, 'config');
  if (fromConfig) return fromConfig;
  const app = findVoicestudioApp({ platform, env, home, extra: settings.voicestudioApp, read });
  if (app?.port) return { url: `http://127.0.0.1:${app.port}`, source: 'app', app: app.dir };
  return { url: DEFAULT_URL, source: 'default' };
}

// The old voice-readout-setup install wires its own hooks into settings.json.
// While those are there, the plugin's hooks stay quiet, so a reply is not
// read twice.
export function legacyInstallActive(env = process.env, home = os.homedir()) {
  try {
    const s = fs.readFileSync(path.join(claudeHome(env, home), 'settings.json'), 'utf8');
    return /voice-readout[\\/]+(hook|style)\.(mjs|ps1)/.test(s);
  } catch { return false; }
}
