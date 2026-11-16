// /readout on | off | toggle (also: no argument) | status. Turning off stops
// playback and clears the queue.
import fs from 'node:fs';
import path from 'node:path';
import { dir, queue, isOn, freshFile } from './lib.mjs';
import { legacyInstallActive } from './config.mjs';

const flag = path.join(dir, 'on');
const arg = process.argv.slice(2).join(' ').trim().toLowerCase();

const want = arg === 'on' ? true : arg === 'off' ? false : arg === '' || arg === 'toggle' ? !isOn() : null;
// The old standalone install's hooks speak instead of the plugin's while they are there.
const legacy = () => (legacyInstallActive() ? ' (the old standalone install\'s hooks in settings.json are speaking instead; see "Moving from the standalone install" in the README)' : '');

if (want === null) {
  console.log(`Voice readout: ${isOn() ? 'ON' : 'OFF'}${isOn() ? legacy() : ''} (usage: /readout on | off | toggle | status)`);
} else if (want) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(flag, '');
  console.log(`Voice readout: ON${legacy()}`);
} else {
  fs.rmSync(flag, { force: true });
  let files = [];
  try { files = fs.readdirSync(queue); } catch {}
  // Each speaker's pid file names the speaker and, while it plays, its player.
  // A stale pid file (before the last boot, or too old) is only deleted: its
  // numbers may belong to unrelated processes by now.
  for (const f of files.filter((n) => n.endsWith('.pid'))) {
    if (!freshFile(path.join(queue, f))) continue;
    let pids = [];
    try { pids = fs.readFileSync(path.join(queue, f), 'utf8').split(/\s+/).map(Number).filter((n) => n > 0); } catch {}
    for (const pid of pids.reverse()) { try { process.kill(pid); } catch {} }
  }
  for (const f of files) fs.rmSync(path.join(queue, f), { force: true });
  console.log('Voice readout: OFF');
}
