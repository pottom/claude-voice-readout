import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Throwaway folders: under VOICE_READOUT_TEST_TMP when set, else the system temp.
export function tempDir(prefix = 'vr-test-') {
  const base = process.env.VOICE_READOUT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

// An environment that never sees the real ~/.claude: its own Claude config
// folder and readout folder.
export function isolatedEnv(root) {
  const claude = path.join(root, 'claude');
  const readout = path.join(claude, 'voice-readout');
  fs.mkdirSync(readout, { recursive: true });
  return { claude, readout, env: { ...process.env, CLAUDE_CONFIG_DIR: claude, VOICE_READOUT_DIR: readout, VOICE_READOUT_LOG: path.join(root, 'readout.log') } };
}
