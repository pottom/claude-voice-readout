---
name: setup
description: Set up the voice readout on this machine - install and check VoiceStudio, then a short guided interview that configures the readout the way the user wants (one voice or several, how they are addressed, length, speed). Writes only the user's own config files.
disable-model-invocation: true
---

# Voice readout setup

The plugin reads the closing message of each Claude Code session aloud with a local VoiceStudio voice. Out of the box it is plain: one built-in voice, no names, no openers, a length limit of about a minute. This skill gets VoiceStudio working and then interviews the user, so the readout ends up the way they want it. **Anything the user is not asked about stays at the plain default.**

Rules for the whole setup:

- Speak the user's language. **One question at a time**, each with a recommended default; wait for the answer.
- You do what can be done from this machine; from the user you need only decisions, their ears, and their hands (installing, clicking in an app).
- **Never download or run an installer without the user's explicit yes**, and never pipe a remote install script into a shell unless they ask for exactly that.
- You write only the user's readout folder, through `configure.mjs`. The plugin's hooks and `/readout` come from the plugin itself; `settings.json` is never touched.
- Scripts live in `${CLAUDE_PLUGIN_ROOT}/scripts/`. Write that path out in full in every command (the Bash tool does not know the variable). `voicestudio.mjs` and `configure.mjs` print JSON; read the result from it.

Below, `vs` stands for `node "${CLAUDE_PLUGIN_ROOT}/scripts/voicestudio.mjs"` and `configure` for `node "${CLAUDE_PLUGIN_ROOT}/scripts/configure.mjs"`.

## 0. Where things stand

Run `configure --status`.

- `"legacyInstallActive": true`: an earlier standalone install still has its own hooks in `settings.json`. While they are there the plugin stays silent (otherwise every reply would be read twice) and the old install speaks. Its data is in the same folder and the plugin reads it, so nothing has to be set up again. Removing the old hooks is the user's step (README, "Moving from the standalone install"); tell them in one sentence and carry on only if they want to.
- `"configured": true`: there is a setup already. Ask what they want to change and go through only that step; the earlier answers are in `answers.json` in the readout folder.

## 1. The machine

Node.js 18+ must be on the `PATH` (`node --version`); if it is not, ask the user to install it from nodejs.org and wait.

Play a short beep through the readout's player, no VoiceStudio needed: `vs tone`. Ask whether they heard it.

- **Windows:** the system player (PowerShell) is used; nothing else is needed.
- **macOS:** `afplay`, present on every Mac.
- **Linux:** one of `paplay`, `pw-play`, `aplay`, `ffplay` (looked for in that order). If none is there (`command -v paplay` …), ask the user to install one.

Done when the beep was heard.

## 2. VoiceStudio

Run `vs check`.

**Exit code 0:** VoiceStudio answers; the output has its version, the device (GPU or CPU) and the voice profiles. On CPU the readout is slower; say so in one sentence. Go to the sound check below.

**Exit code 3 (licence not accepted):** VoiceStudio answers but refuses to synthesize until the licence of the models in `licenceRequired` is accepted (OmniVoice's weights are non-commercial, and its audio tokenizer has its own terms). Accepting a licence is the user's decision and their click: never call VoiceStudio's licence endpoints yourself. Name the models and their licence in one or two sentences, ask the user to open VoiceStudio's **Model Catalogue**, review and accept them there, then `check` again. If they decline, the readout cannot speak with OmniVoice; stop here.

**Exit code 2 (not reachable):** the output's `installedApp` says whether the app was found where it is normally installed (Windows: `Program Files\VoiceStudio` or `%LOCALAPPDATA%\Programs\VoiceStudio`; macOS: `/Applications/VoiceStudio.app` or `~/Applications/VoiceStudio.app`; Linux: `/opt/VoiceStudio`).

- **Installed but not running:** ask the user to start it, then `check` again.
- **Not installed:** help them install it.
  1. Detect the OS and CPU (`process.platform`, `process.arch`; on macOS, Apple Silicon or Intel). On an Intel Mac VoiceStudio runs its interface but cannot synthesize locally: say so, and stop here unless they have another machine for the voice.
  2. Point them to the official source. VoiceStudio's own app takes its updates from the GitHub releases of `debpalash/VoiceStudio`, and its project site is `voicestudio.sh`. Before sending the user anywhere, open the project page and confirm it is still the official one (the README links the site and the releases); if anything looks different, tell the user what you found and let them decide. The download page: https://github.com/debpalash/VoiceStudio/releases/latest
  3. Explain the steps for their OS, and let **them** download and run the installer:
     - Windows: the `.exe` installer from the latest release; run it, then start VoiceStudio.
     - macOS: the `.dmg` for Apple Silicon; open it, drag VoiceStudio into Applications, start it. If macOS says the app "is damaged", that is Gatekeeper blocking it; VoiceStudio's own macOS install guide has the fix.
     - Linux: the `.AppImage` or the `.deb` from the latest release.
  4. First launch: VoiceStudio offers model packs. The **Fast** pack is enough: it contains the VoiceStudio TTS (OmniVoice) the readout uses, and Whisper base, which is only needed to transcribe a reference clip when the user wants their own or a cloned voice. On Apple Silicon the Fast pack is about 2.7 GB. It is their disk and their download: ask before they start it. If the pack names differ in their version, the one that includes OmniVoice is the one needed.
  5. Make sure the local server runs (the app starts it; leave the app open), then `check` again. Repeat until it passes.
- **Runs at another address:** the readout looks for the address in this order: the `VOICESTUDIO_URL` environment variable, the `url` answer, the port in the installed app's own `config/app.json`, then `http://127.0.0.1:3900` (`urlSource` says which one was used). If the app is installed somewhere unusual, the `voicestudioApp` answer names its folder; if it listens on another port, the `url` answer (local addresses only).

**Sound check:** `vs say --text "<sentence>" --keep "<temp>/sound-check.wav"` (in the user's language; two or three natural sentences, so the take is also a good clone sample). The first call loads the model and can take half a minute. Ask whether they heard it.

VoiceStudio's `default` voice is not one fixed voice: OmniVoice picks the speaker per request, and the readout's fixed seed only keeps it close, a new text can still sound like someone else. So the voice the user heard is pinned at once: `vs make-voice --name "Readout · voice" --from "<temp>/sound-check.wav" --text "<the same sentence>"`, add the id to `createdProfiles`, and from here on speak with `--voice <that id>` (also for the spoken questions). If they later dislike it, the voice question below replaces it.

Done when they heard the voice.

## 3. The interview

Collect the answers in an `answers.json` in the user's temp folder (never in the plugin folder). Every key is optional; leave out what was not asked or what keeps the default. The shape is at the end.

**Ask aloud.** The voice works from the sound check on, so the interview is spoken: before each question, say it with `vs say`, then write it on the screen as usual (the screen stays the record; the user answers there). This way the user hears the readout while shaping it, and every answer is heard at once:

- Speak with the answers so far: `--voice` (the chosen voice: the profile pinned at the sound check until another is picked), `--speed`, `--language`, `--device`. After the user picks a voice or a speed, the next question already uses it; after `address` (and `formal`), the spoken question addresses them that way.
- Keep the spoken line to the question and its recommendation, one or two short sentences, in the user's language. Synthesis can be slower than the speech itself (on a Mac often about three times), so a long line keeps the user waiting; lists of options, ids and paths stay on the screen only.
- Auditions (speeds, voice candidates) are played as their step says; they replace the spoken question for that step.
- If the user says they do not want it spoken, or `say` fails, carry on in writing and do not try again.

Ask these, one at a time, each with your recommendation. Skip what the user waves off.

1. **One voice, or a voice per session?** Recommended: one voice. One voice: go to 1a. A voice per session: go to "Several voices".
   - 1a. **Which voice?** The voice from the sound check, pinned as a profile (recommended to start; never plain `default`, which changes from reply to reply), one of the existing profiles from `check`, a new one designed from tags ("Designing a voice"), or their own voice ("Own voice"). Answer: `main.voice`.
2. **Address:** should the readout use a name for them, and which? Recommended: no name. Answer: `address`; if they want the informal or formal form, `formal`.
3. **Language and tone:** the voice speaks whatever language the reply is in. If they want a fixed language for the voice (`language`, such as `en` or `hu`) or a tone for the replies (`tone`, in their words), note it; the default is neither.
4. **Length:** how long may a readout be? Recommended: about a minute (`budget` 900 characters). Longer, shorter, or the whole reply when they asked the question themselves (`fullForUserTurns: true`). When something is cut, should the voice say so (`details`, a short sentence in their language such as "More on the screen.")? Default: silent.
5. **Background sessions:** a turn the user did not start (another session, a background task) is read only when it asks them something or reports. Recommended: that (`backgroundNews: "questions"`). Alternatives: read everything (`"all"`) or nothing (`"none"`).
6. **Speed:** play the same sentence at 1.0 and at their preferred alternative (`say --speed`) and let them choose. Default 1.0. With several voices the speed is per voice (a speed that suits one voice can sound breathless or dragging on another).
7. **Output device:** the default output (recommended), or a named device such as headphones? `vs devices` lists names on Windows and Linux; try one with `vs tone --device "<name>"` (part of the name is enough). Answer: `outputDevice`. On macOS `afplay` cannot choose a device, so the default output plays unless they set a `playerCommand` (README). The system's default device is never changed.
8. **Pronunciation:** words the voice says wrong (product names, abbreviations)? Play them; if one is wrong, write a phonetic spelling into `spoken`. VoiceStudio's transcription (`/v1/audio/transcriptions`) can check it: synthesize, transcribe, compare.

### Several voices

1. **How do sessions get a voice?** Recommended: each new session takes the least used voice of a pool and keeps it. Alternatively, by keyword in the session title (for example every session whose title contains "website" speaks with one voice): such a voice gets `match` keywords and is used only for those sessions. Both can be mixed.
2. **Audition, voice by voice.** Say first which voice comes (its tags, such as "elderly male, moderate pitch") and what it will say, then play it and keep the take: `vs say --instruct "<tags>" --seed <N> --text "<sentence>" --keep "<temp>/candidate-<N>.wav"`. Use the same short sentence for every candidate. If they want several at once, number them ("One.", "Two.") with a pause, and ask for the number. A voice they do not like drops out; bring another (other tags or seed).
3. **Save the chosen voice from the take they heard:** `vs make-voice --name "Readout · <name>" --from "<temp>/candidate-<N>.wav" --text "<the same sentence>"`. The same tags and seed synthesized again can sound different, so always clone the take. Play the profile back once and ask whether it is the same voice. Add the profile id to `createdProfiles`.
4. **Name and personality (optional):** should the voices have names and introduce themselves? Recommended: no. If yes, the user says what character fits the voice they heard; suggest a few names that suit it and let them pick. Write `name`, and an intro line in their language, such as `"first": ["Hi {h}, I'm {n}, I'm working on {t}."]`, plus optional openers per kind of news (`question`, `approval`, `blocked`, `done`, `info`) in `lines`. `{h}` is the address, `{n}` the voice's name, `{t}` the session title. Without lines a named voice says nothing extra.
5. **An overview session (optional):** a session with a fixed title that always speaks with its own voice (`overview.title`, `overview.voice`).

Four or five voices are plenty. Mix female and male candidates, for example `female, young adult, moderate pitch`, `female, middle-aged, low pitch`, `male, young adult, low pitch`, `male, middle-aged, moderate pitch`, `male, elderly, moderate pitch`.

### Designing a voice

`vs make-voice --name "Readout · <name>" --instruct "<tags>" [--seed N] [--text "<sentence>"] [--from <take.wav>]`. The tags come from OmniVoice's fixed set: `male`/`female`; `child`, `teenager`, `young adult`, `middle-aged`, `elderly`; `very low pitch`, `low pitch`, `moderate pitch`, `high pitch`, `very high pitch`. A profile with the same name is reused (`"reused": true`); a reused profile belongs to the user and does not go into `createdProfiles`. Delete a failed try with `vs delete-voice --id <id>`.

### Own voice (optional)

1. The user records a 10 to 20 second clip of their own (or a consenting person's) voice: one speaker, a quiet room, no music, natural sentences, saved as WAV.
2. Transcribe it with VoiceStudio's transcription (`/v1/audio/transcriptions`, Whisper base from the Fast pack) and let the user correct the text.
3. `vs make-voice --name "Readout · own voice" --from "<clip.wav>" --text "<the corrected transcript>"`, then play a sentence with the new profile and ask whether it sounds right.

### Answers

```json
{
  "main": { "voice": "default" },
  "address": "Sam",
  "formal": false,
  "language": "en",
  "tone": "friendly, to the point",
  "speed": 1.0,
  "budget": 900,
  "details": "More on the screen.",
  "fullForUserTurns": false,
  "backgroundNews": "questions",
  "outputDevice": "Headphones",
  "spoken": { "Kubectl": "cube control" },
  "pool": [
    { "name": "Anna", "voice": "<profile id>", "speed": 1.1, "match": ["website"],
      "lines": { "first": ["Hi {h}, I'm {n}, I'm working on {t}."], "question": ["{h}, a question about {t}."] } }
  ],
  "overview": { "title": "Overview", "voice": "<profile id>" },
  "createdProfiles": ["<every profile id made during this setup>"]
}
```

`url`, `voicestudioApp` and `playerCommand` are only for unusual machines (README). On a rerun, `"style": "keep"` keeps a hand-tuned `style.txt`.

## 4. Save

1. `configure --config <answers.json> --check` shows what would be written to the readout folder (`voices.json`, `speech-rules.json`, `config.json`, and `style.txt` only if address, tone or form of address were chosen). Summarize it in two sentences and ask: **save it?** Existing files are put aside first.
2. After the yes, the same without `--check`. If the output has `previousBackup`, say where it is.

Done when the output says `"configured": true`.

## 5. Try it

Ask the user to type `/readout on` (or `/voice-readout:readout on` if the short name is taken) and then ask a short question. The reply should be read aloud. If the plugin was installed in this session, the hooks load in a new session or after `/reload-plugins`.

If nothing is heard: `vs check` (is VoiceStudio running?), `configure --status` (is it on, are the old hooks speaking instead?). For a log, the user sets `VOICE_READOUT_LOG` to a file path in the shell that starts Claude Code; each playback's start and end go there, and `no-player` means no player was found (Linux, step 1). The last ten takes, audio and text, stay in `work/recent/` in the readout folder.

Done when the user heard a reply.

## Removing

The plugin is disabled or removed in `/plugin`. The readout folder (voices, dictionary, style) stays; deleting it is the user's choice. `configure --status` lists the profiles made during setup (`createdProfiles`); ask whether to delete them (`vs delete-voice --id`). VoiceStudio itself stays.
