# Local sound playback

Automaton can play local audio assets independently of remote TTS. Configure
`sounds` in `etc/automaton.yaml` (see `etc/automaton.yaml.dist`). The defaults
apply even if the section is absent:

```yaml
sounds:
  directory: share/sounds
  timeout_ms: 60000
  players:
    mp3:
      - [mpg123, '-q', '-s', '-r', '44100', '--stereo', '-e', s16, '{file}']
      - [aplay, '-q', '-D', default, '-t', raw, '-f', S16_LE, '-r', '44100', '-c', '2', '-']
    wav:
      - [aplay, '-q', '-D', default, '{file}']
```

Use `await playSound('cue.mp3')` from `src/lib/sound.js` in a local automation.
Put the asset on the host that runs Automaton. Nothing plays automatically just
because a file is present. The directory can be absolute or relative to the
project root. Each file type maps to a list of command argument arrays. Put
`{file}` once in the first command's arguments; stdout feeds the next command,
without a shell. The call resolves after playback or rejects if it fails or
times out. Existing PC speaker beeps and TTS framing profiles are unchanged.

Install `mpg123` for MP3 and ALSA's `aplay` for both formats. If TCP TTS is
received by `aplay -`, run both processes as the same service user in the same
IPC namespace and route ALSA's `default` through a shared mixer such as `dmix`.
Do not use `hw:0,0` as the playback command's device; it bypasses mixing. This
allows overlapping playback, not automatic volume ducking. WAV intro/outro
filenames configured in TTS profiles still refer to files on the TTS server.
The MP3 default streams raw 44.1 kHz stereo PCM on little-endian Linux, so
`aplay` does not depend on a WAV header that the decoder cannot finalize on a pipe.

## Credits and redistribution

Red Alert plays its MP3 and optional pre-generated WAVs directly on the
Automaton host. See [Red Alert](../monitors/red-alert.md) for names and timing.
Only assets with suitable redistribution terms should be committed. For Piper
recordings, record the voice model, revision, and applicable notices before
bundling any generated WAVs. No Piper model or WAV set ships with this change.

The local-only sample used for playback testing was
[Greece EAS Alarm](https://pixabay.com/sound-effects/film-special-effects-greece-eas-alarm-greece-451404/)
by JeremayJimenez on Pixabay.
This download is not bundled or covered by Automaton's software license.

The [Pixabay Content License](https://pixabay.com/service/terms/#license)
allows commercial and non-commercial use subject to its terms, but prohibits
redistributing content as a standalone file. Treat a substantially unchanged
MP3 in a public repository or release as standalone redistribution. Credit
does not remove that restriction. Keep these downloads local unless you have
separate permission or a license that allows redistribution. For any shipped
third-party sound, document its creator, source, and redistribution license.
