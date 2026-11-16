# voice-readout

A Claude Code plugin that reads the closing message of each session aloud with a local voice: [VoiceStudio](https://voicestudio.sh) (OmniVoice model) or [Piper](https://github.com/OHF-voice/piper1-gpl), your choice. Several sessions speak one after another, never over each other. No cloud service, no account; Windows, macOS and Linux.

Out of the box it is plain: VoiceStudio's built-in voice reads the reply, in whatever language the reply is in, cut to about a minute. Replies to your own messages are read; turns you did not start (another session, a background task) are read only when they ask you something. Everything else is optional and set by you.

## Requirements

- Claude Code with plugin support
- Node.js 18+ on the `PATH`
- One voice engine:
  - **VoiceStudio** (the most natural voice, many voices, cloning; heavy, best with a GPU), running, with its OmniVoice TTS (the "Fast" model pack is enough). Download: [github.com/debpalash/VoiceStudio/releases/latest](https://github.com/debpalash/VoiceStudio/releases/latest). On macOS it needs Apple Silicon, where it is slow (about three times slower than the speech on an M1; long replies are read sentence by sentence).
  - **Piper** (fast even on the CPU, about 60 MB per voice, ready-made voices only): needs Python 3; the setup installs it into the readout folder.
- Linux only: a player (`paplay`, `pw-play`, `aplay` or `ffplay`). Windows and macOS use the system's own.

## Install

```
/plugin marketplace add <path or URL of this repository>
/plugin install voice-readout@voice-readout
```

Then, in a new session (or after `/reload-plugins`):

```
/voice-readout:setup
```

The setup skill checks the player, explains the two engines and lets you choose, helps you install VoiceStudio or Piper if it is missing (it never downloads or runs anything without your yes), and then asks a few questions, one at a time, each with a recommended default: one voice or a voice per session, how you want to be addressed (or not), how long a readout may be, whether background sessions are read, speed, output device, words the voice says wrong. What you skip stays at the default.

Turn it on and off with `/readout on`, `/readout off`, `/readout toggle`; `/readout status` shows the state. (If the name clashes: `/voice-readout:readout`.)

## Where things are

The plugin folder is read-only. Everything personal and every work file is in your readout folder: `~/.claude/voice-readout` (or `$CLAUDE_CONFIG_DIR/voice-readout`, or `VOICE_READOUT_DIR`). Without any files there, the plain defaults apply.

| File | What |
|---|---|
| `voices.json` | the voice or voices, language, speed, how you are addressed |
| `speech-rules.json` | length, pronunciation dictionary, optional openers; laid over the plugin's defaults |
| `style.txt` | the instructions added to each prompt while the readout is on (default: write so it reads well aloud) |
| `config.json` | machine settings |
| `on` | present while the readout is on |
| `work/` | queue, locks, the last ten takes (`work/recent/`) |

### `voices.json`

| Key | What | Default |
|---|---|---|
| `engine` | `voicestudio` or `piper` | `voicestudio` |
| `main.voice` | the voice for every session: a VoiceStudio profile id or `default`, or with Piper a Piper voice name such as `hu_HU-berta-medium` (`default` is sent with a fixed seed, but OmniVoice can still vary it from text to text; the setup pins the voice you heard as a profile) | `default` |
| `pool` | a voice per session: `[{ "voice", "name", "speed", "match" }]`; each new session takes the least used voice and keeps it; a voice with `match` keywords speaks for sessions whose title contains one of them | none |
| `overviewTitle`, `overview` | a session with this title always speaks with the `overview` voice | none |
| `language` | the language sent to VoiceStudio (`en`, `hu`, …) | VoiceStudio's default |
| `speed` | 0.25–4; also per voice | 1 |
| `address` | how openers address you | none |

### `speech-rules.json`

| Key | What | Default |
|---|---|---|
| `_budget` | characters read at most (about 15 per second) | 900 |
| `_details` | a sentence said when something was cut | none |
| `_spoken` | pronunciation fixes, `{ "written": "spoken" }` | a few generic tech terms |
| `_words` | word replacements inside report rows | none |
| `_fullForUserTurns` | read your own turns' replies in full | off |
| `_backgroundNews` | other turns: `questions` (asks or reports), `all`, `none` | `questions` |
| `_team` | openers: `_team.<voice name>` or `_team._default`, with `first` (the first time a voice speaks in a session) and `question`, `approval`, `blocked`, `done`, `info`, `plain`; `{h}` address, `{n}` voice name, `{t}` session title | none |
| `_titlePrefix` | regex taken off session titles | `<WORD> <number> · ` |
| `_marks`, `_report`, table-label rules, `_fullMark`, `_ignoreSenders` | report handling for a structured report format (see `scripts/lib.mjs`) | none |

### `config.json`

| Key | What | Default |
|---|---|---|
| `url` | VoiceStudio's address; local addresses only (`127.0.0.1`, `localhost`, `[::1]`) | found automatically |
| `voicestudioApp` | VoiceStudio's install folder, if it is not in the usual place | – |
| `outputDevice` | play on this output device (part of its name is enough) | the system default |
| `piperDir` | Piper's folder (`venv/`, `voices/`); keep the path short, Piper's eSpeak fails under long paths | `<readout folder>/piper` |
| `playerCommand` | your own player: `["cmd", "arg", "{file}", "{device}"]` | – |

VoiceStudio's address, first match wins: the `VOICESTUDIO_URL` environment variable, `config.json` `url`, `voices.json` `url`, the port in the installed app's own `resources/config/app.json` (Windows: `Program Files\VoiceStudio`, `%LOCALAPPDATA%\Programs\VoiceStudio`; macOS: `/Applications/VoiceStudio.app`, `~/Applications/VoiceStudio.app`; Linux: `/opt/VoiceStudio`), then `http://127.0.0.1:3900`.

`outputDevice` takes a waveOut device name on Windows (list: `node scripts/voicestudio.mjs devices`) and a `paplay`/`pw-play`/`aplay` device on Linux. **It is not implemented on macOS:** `afplay` cannot choose a device, so the default output plays unless a `playerCommand` says otherwise. The readout never changes the system's default device.

## Moving from the standalone install

An earlier standalone version of this readout put two hooks into `~/.claude/settings.json` (`voice-readout/hook.mjs` on `Stop`, `voice-readout/style.mjs` on `UserPromptSubmit`) and a command file under `~/.claude/commands/`. Its data (`voices.json`, `speech-rules.json`, `style.txt`, `answers.json`) is in the same folder the plugin reads, and its rules files keep working as they were: nothing has to be set up again.

While the old hooks are in `settings.json`, the plugin's hooks stay silent, so nothing is read twice; until then the old install speaks.

1. Install the plugin (above).
2. Take the old hooks off: run the old installer with `--remove` (without `--purge`, so the data stays), or delete the two hook entries from `settings.json` and the old command file by hand.
3. In a new session: `/readout on`.
4. Once it speaks, the old scripts in the readout folder (`hook.mjs`, `lib.mjs`, `speak.mjs`, `style.mjs`, `toggle.mjs`, `play.ps1`, `backup-*`) can go; the plugin does not use them.

## Development

```
node --test
```

The tests run in a sealed temp folder (`VOICE_READOUT_TEST_TMP`, default the system temp) with a fake VoiceStudio and a silent player; they never touch the real `~/.claude`. A beep without VoiceStudio: `node scripts/voicestudio.mjs tone [--device "<name>"]`.
