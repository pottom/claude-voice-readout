---
description: Turn the voice readout on or off, or show its state
argument-hint: "[on|off|toggle|status]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/toggle.mjs" $ARGUMENTS`

The line above is the readout's new state. Say it in one short sentence, in the user's language; write nothing else and call no tools.
