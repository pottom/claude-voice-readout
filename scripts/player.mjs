// Playing a WAV file with what the system has: SoundPlayer (PowerShell) on
// Windows, afplay on macOS, the first player found on Linux. An output device
// can be named (outputDevice): Windows plays through it with waveOut, Linux
// passes it to the player; afplay cannot choose a device, so on macOS the
// default output is used (or a playerCommand of your own). The system's
// default device is never changed.
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pluginRoot } from './config.mjs';

export const PLAY_PS1 = path.join(pluginRoot, 'scripts', 'play.ps1');

// Linux players in order of preference, with how each takes a device.
export const LINUX_PLAYERS = [
  { cmd: 'paplay', args: [], device: (d) => [`--device=${d}`] },
  { cmd: 'pw-play', args: [], device: (d) => ['--target', d] },
  { cmd: 'aplay', args: ['-q'], device: (d) => ['-D', d] },
  { cmd: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'quiet'], device: null },
];

export function commandExists(cmd) {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
}

// What to run for one file: { cmd, args, device, deviceIgnored } or null if
// there is no player. Pure apart from `has`, so it can be tested per platform.
export function playerCommand(file, { platform = process.platform, outputDevice = '', playerCommand: custom = null, has = commandExists } = {}) {
  const dev = String(outputDevice ?? '').trim();
  if (custom?.length) {
    const args = custom.slice(1).map((a) => a.replaceAll('{file}', file).replaceAll('{device}', dev));
    if (!custom.slice(1).some((a) => a.includes('{file}'))) args.push(file);
    return { cmd: custom[0], args, device: custom.some((a) => a.includes('{device}')) ? dev : '', deviceIgnored: false };
  }
  if (platform === 'win32') {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PLAY_PS1, '-Path', file];
    if (dev) args.push('-Device', dev);
    return { cmd: 'powershell.exe', args, device: dev, deviceIgnored: false };
  }
  if (platform === 'darwin') return { cmd: 'afplay', args: [file], device: '', deviceIgnored: !!dev };
  // With a device named, a player that can take it comes first.
  const order = dev ? [...LINUX_PLAYERS.filter((p) => p.device), ...LINUX_PLAYERS.filter((p) => !p.device)] : LINUX_PLAYERS;
  for (const p of order) {
    if (!has(p.cmd)) continue;
    const devArgs = dev && p.device ? p.device(dev) : [];
    return { cmd: p.cmd, args: [...p.args, ...devArgs, file], device: devArgs.length ? dev : '', deviceIgnored: !!dev && !devArgs.length };
  }
  return null;
}

// Starts the player; returns the child process, or null if there is none.
export function startPlayer(file, opts = {}) {
  const c = playerCommand(file, opts);
  if (!c) return null;
  return spawn(c.cmd, c.args, { stdio: 'ignore', windowsHide: true });
}

// Plays and waits; true if the player ran and exited 0.
export function playSync(file, opts = {}) {
  const c = playerCommand(file, opts);
  if (!c) return false;
  return spawnSync(c.cmd, c.args, { stdio: 'ignore', windowsHide: true }).status === 0;
}

// The output devices a name can be chosen from (Windows: waveOut names,
// Linux: PulseAudio/PipeWire sinks). null where there is no way to list them.
export function listDevices(platform = process.platform) {
  if (platform === 'win32') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PLAY_PS1, '-List'], { encoding: 'utf8', windowsHide: true });
    return r.status === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : null;
  }
  if (platform === 'linux' && commandExists('pactl')) {
    const r = spawnSync('pactl', ['list', 'short', 'sinks'], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.split(/\r?\n/).map((l) => l.split('\t')[1]).filter(Boolean) : null;
  }
  return null;
}
