// Writes the user's readout configuration from the setup answers. Touches
// only the user folder (~/.claude/voice-readout, or VOICE_READOUT_DIR): the
// hooks and /readout come from the plugin, settings.json is never changed.
//   node configure.mjs --config <answers.json> [--check]   write (or show what would be written)
//   node configure.mjs --status                            where things are, on/off, made profiles
// Every answer is optional; with none, the plain plugin defaults apply.
// Output: JSON on stdout.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { userDir, readJson, isLocalUrl, loadSettings, resolveUrl, legacyInstallActive } from './config.mjs';
import { piperPaths, installedVoices } from './piper.mjs';

// The spoken style: only when the answers ask for something beyond the default.
export function styleText(c = {}) {
  if (!c.address && !c.tone && c.formal === undefined && !c.styleNotes) return null;
  const lines = ['The voice readout is on: your closing message is read aloud to the user, in whatever language you write it. Write it so it reads well aloud: short sentences, the main point first, little code, few paths and links. Keep tables short; their cells are read one after another.'];
  if (c.address) lines.push(`Address the user as ${c.address}.`);
  if (c.formal !== undefined) lines.push(c.formal ? 'Use the formal form of address, where the language has one.' : 'Use the informal form of address, where the language has one.');
  if (c.tone) lines.push(`Tone: ${c.tone}.`);
  if (c.styleNotes) lines.push(String(c.styleNotes));
  return lines.join('\n') + '\n';
}

// Voices: one voice for every session (main), or a pool of named voices, one
// per session, and optionally an overview session with its own voice.
export function voicesJson(c) {
  const v = (x) => x && ({ voice: x.voice, ...(x.name ? { name: x.name } : {}), ...(x.instruct ? { instruct: x.instruct } : {}), ...(x.seed !== undefined ? { seed: x.seed } : {}), ...(x.speed ? { speed: x.speed } : {}), ...(x.match ? { match: x.match } : {}) });
  return {
    _note: 'Who speaks with which voice. engine: voicestudio (default) or piper. voice = VoiceStudio profile id (or "default"), or with piper a Piper voice name (hu_HU-berta-medium); name = how the voice introduces itself. pool: every session keeps one pool voice for its life; overview: the session whose title is overviewTitle.',
    ...(c.engine === 'piper' ? { engine: 'piper' } : {}),
    ...(c.language ? { language: c.language } : {}),
    ...(c.address ? { address: c.address } : {}),
    ...(c.speed ? { speed: c.speed } : {}),
    main: v(c.main ?? { voice: 'default' }),
    pool: (c.pool ?? []).map(v),
    overviewTitle: c.overview?.title || '',
    ...(c.overview?.aliases?.length ? { overviewAliases: c.overview.aliases } : {}),
    ...(c.overview ? { overview: v(c.overview) } : {}),
    createdProfiles: c.createdProfiles || [],
  };
}

// The user's rules: what was there, plus the answers' dictionary, opening lines
// and length settings. The plugin's defaults are merged in at run time.
export function rulesJson(existing, c) {
  const out = { ...existing };
  if (c.spoken) out._spoken = { ...existing._spoken, ...c.spoken };
  const team = { ...existing._team };
  for (const p of c.pool ?? []) if (p.name && p.lines) team[p.name] = p.lines;
  if (c.overview?.lines) team._overview = c.overview.lines;
  if (c.teamDefault) team._default = c.teamDefault;
  if (Object.keys(team).length) out._team = team;
  if (c.budget) out._budget = c.budget;
  if (c.details !== undefined) out._details = c.details;
  if (c.fullForUserTurns !== undefined) out._fullForUserTurns = !!c.fullForUserTurns;
  if (c.backgroundNews !== undefined) out._backgroundNews = c.backgroundNews;
  return out;
}

// Machine settings: config.json keeps what is already there, the answers add theirs.
export function configJson(existing, c) {
  const out = { ...existing };
  for (const k of ['url', 'outputDevice', 'playerCommand', 'voicestudioApp', 'piperDir']) if (c[k] !== undefined) out[k] = c[k];
  return out;
}

export function validate(c) {
  // Every reply's text goes to this address, so it must stay on this machine.
  if (c.url && !isLocalUrl(c.url)) throw new Error('config: url must be a local address (127.0.0.1, localhost or [::1])');
  if (c.engine !== undefined && !['voicestudio', 'piper'].includes(c.engine)) throw new Error('config: engine is voicestudio or piper');
  if (c.pool !== undefined && !Array.isArray(c.pool)) throw new Error('config: pool must be a list');
  if ((c.pool ?? []).some((p) => !p?.voice)) throw new Error('config: every pool voice needs a voice id');
  if (c.backgroundNews !== undefined && !['questions', 'all', 'none'].includes(c.backgroundNews)) throw new Error('config: backgroundNews is questions, all or none');
  if (c.playerCommand !== undefined && !(Array.isArray(c.playerCommand) && c.playerCommand.every((x) => typeof x === 'string'))) throw new Error('config: playerCommand must be an array of strings');
}

function main(args) {
  const flag = (n) => args.includes(n);
  const value = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const dir = userDir();
  const readOr = (f, d) => { try { return readJson(path.join(dir, f)); } catch { return d; } };

  if (flag('--status')) {
    const settings = loadSettings(dir);
    console.log(JSON.stringify({
      readoutDir: dir, on: fs.existsSync(path.join(dir, 'on')), configured: fs.existsSync(path.join(dir, 'voices.json')),
      // The engine is the user's choice (setup step 2): voicestudio until they pick piper.
      engine: readOr('voices.json', {}).engine === 'piper' ? 'piper' : 'voicestudio',
      engineChosen: readOr('voices.json', null) !== null,
      piper: (() => { const p = piperPaths(settings, dir); return { installed: fs.existsSync(p.exe), dir: p.root, voices: installedVoices(p) }; })(),
      voicestudio: resolveUrl({ settings }), outputDevice: settings.outputDevice || null,
      createdProfiles: readOr('voices.json', {}).createdProfiles ?? [], legacyInstallActive: legacyInstallActive(),
    }, null, 2));
    return;
  }

  const configPath = value('--config');
  if (!configPath) { console.error('usage: node configure.mjs --config <answers.json> [--check] | --status'); process.exitCode = 1; return; }
  const c = readJson(configPath);
  validate(c);
  const style = c.style === 'keep' ? null : styleText(c);
  const files = {
    'voices.json': JSON.stringify(voicesJson(c), null, 2) + '\n',
    'speech-rules.json': JSON.stringify(rulesJson(readOr('speech-rules.json', {}), c), null, 2) + '\n',
    'config.json': JSON.stringify(configJson(readOr('config.json', {}), c), null, 2) + '\n',
    ...(style ? { 'style.txt': style } : {}),
  };
  if (flag('--check')) {
    console.log(JSON.stringify({ readoutDir: dir, files }, null, 2));
    console.log('Check only: nothing written.');
    return;
  }
  // The earlier files are kept aside before they are overwritten.
  fs.mkdirSync(dir, { recursive: true });
  const previous = [...Object.keys(files), 'answers.json'].filter((f) => fs.existsSync(path.join(dir, f)));
  let backup = null;
  if (previous.length) {
    backup = path.join(dir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(backup);
    for (const f of previous) fs.copyFileSync(path.join(dir, f), path.join(backup, f));
  }
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
  // The answers stay beside the config: a rerun with them rebuilds it.
  fs.writeFileSync(path.join(dir, 'answers.json'), JSON.stringify(c, null, 2) + '\n');
  console.log(JSON.stringify({ configured: true, readoutDir: dir, previousBackup: backup, legacyInstallActive: legacyInstallActive() }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { main(process.argv.slice(2)); } catch (e) { console.log(JSON.stringify({ configured: false, error: String(e.message || e) })); process.exitCode = 1; }
}
