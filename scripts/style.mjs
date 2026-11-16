// UserPromptSubmit hook: while the readout is on, add the spoken style
// (style.txt in the user folder, else the plugin's default) to the prompt context.
import { dir, isOn } from './lib.mjs';
import { loadStyle, legacyInstallActive } from './config.mjs';

if (isOn() && !legacyInstallActive()) {
  try { process.stdout.write(loadStyle(dir)); } catch {}
}
