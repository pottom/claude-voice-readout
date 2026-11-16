import test from 'node:test';
import assert from 'node:assert/strict';
import { playerCommand, PLAY_PS1 } from '../scripts/player.mjs';

const only = (...names) => (cmd) => names.includes(cmd);

test('Windows: play.ps1 on the default device', () => {
  const c = playerCommand('a.wav', { platform: 'win32' });
  assert.equal(c.cmd, 'powershell.exe');
  assert.deepEqual(c.args, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PLAY_PS1, '-Path', 'a.wav']);
});

test('Windows: a named output device goes to play.ps1', () => {
  const c = playerCommand('a.wav', { platform: 'win32', outputDevice: 'Speakers (USB)' });
  assert.deepEqual(c.args.slice(-2), ['-Device', 'Speakers (USB)']);
  assert.equal(c.device, 'Speakers (USB)');
});

test('macOS: afplay; a device cannot be chosen and is reported ignored', () => {
  assert.deepEqual(playerCommand('a.wav', { platform: 'darwin' }), { cmd: 'afplay', args: ['a.wav'], device: '', deviceIgnored: false });
  assert.equal(playerCommand('a.wav', { platform: 'darwin', outputDevice: 'AirPods' }).deviceIgnored, true);
});

test('Linux: the first player found, in order', () => {
  assert.equal(playerCommand('a.wav', { platform: 'linux', has: only('paplay', 'aplay') }).cmd, 'paplay');
  assert.deepEqual(playerCommand('a.wav', { platform: 'linux', has: only('aplay') }).args, ['-q', 'a.wav']);
  assert.deepEqual(playerCommand('a.wav', { platform: 'linux', has: only('ffplay') }).args, ['-nodisp', '-autoexit', '-loglevel', 'quiet', 'a.wav']);
  assert.equal(playerCommand('a.wav', { platform: 'linux', has: only() }), null);
});

test('Linux: the device goes to each player its own way', () => {
  assert.deepEqual(playerCommand('a.wav', { platform: 'linux', outputDevice: 'sink1', has: only('paplay') }).args, ['--device=sink1', 'a.wav']);
  assert.deepEqual(playerCommand('a.wav', { platform: 'linux', outputDevice: 'sink1', has: only('pw-play') }).args, ['--target', 'sink1', 'a.wav']);
  assert.deepEqual(playerCommand('a.wav', { platform: 'linux', outputDevice: 'hw:1', has: only('aplay') }).args, ['-q', '-D', 'hw:1', 'a.wav']);
  const ff = playerCommand('a.wav', { platform: 'linux', outputDevice: 'x', has: only('ffplay') });
  assert.equal(ff.cmd, 'ffplay');
  assert.equal(ff.deviceIgnored, true);
});

test('Linux: with a device, a player that can take it wins over ffplay', () => {
  assert.equal(playerCommand('a.wav', { platform: 'linux', outputDevice: 'x', has: only('ffplay', 'aplay') }).cmd, 'aplay');
});

test('a playerCommand of your own wins on every platform', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const c = playerCommand('a.wav', { platform, outputDevice: 'Dev', playerCommand: ['sox', '{file}', '-t', 'coreaudio', '{device}'], has: only() });
    assert.deepEqual(c, { cmd: 'sox', args: ['a.wav', '-t', 'coreaudio', 'Dev'], device: 'Dev', deviceIgnored: false });
  }
  assert.deepEqual(playerCommand('a.wav', { platform: 'linux', playerCommand: ['mpv', '--really-quiet'] }).args, ['--really-quiet', 'a.wav']);
});
