# Official small tools

Small tools that only compute and use no model. In the agent environment, dubbing, making a pack, and the app all use them.

| Tool | File | Command | Authoritative source for rules and notes |
|---|---|---|---|
| Script markup parsing | `markup.mjs` | `markup` | File header: syntax, shape of the output |
| Sentence splitting | `sentences.mjs` | `sentences` | File header: rules and trade-offs |
| Audio decoding | `audio-decode.mjs`, `wav.mjs` | via `quality` | `audio-decode.mjs` file header: how it decodes, the signature of the ffmpeg runtime; `wav.mjs` file header: how far WAV is decoded, and `wavInfo` for when you only want to know the length and format (it reads only the file header, not the sample values) |
| Audio quality check | `audio-quality.mjs` | `quality` | File header: what is measured, the thresholds and their basis, the shape of the verdict |
| Split a long recording into segments by energy | `silence-split.mjs` | none (library function) | File header: how it splits, options, shape of the return value |
| Loudness normalization (with a look-ahead limiter) | `loudness-normalize.mjs` | none (library function; used by the make-pack flow) | File header: target and peak ceiling, how the gain is chosen, how the limiter works and the basis for its parameters, status, the scale to leave when writing a 16-bit WAV |
| Audio fingerprint | `audio-fingerprint.mjs` | none (library function; used by the duplicate check, via `../lib/duplicate-check.mjs`) | File header: the method (landmark hashing plus voting on position differences), what it resists and what it does not (speed change, pitch change, reversal), the shape of the return value, the basis for each number |

Rules are written once, in the authoritative source, and not repeated here. Command usage: `node cli.mjs help`, `node cli.mjs <command> --help`; the command implementations are in `../cli/commands/`.

## How tools are written

- `.mjs`, written as described in `../protocol/README.md`「Module conventions」: only the platform's own APIs, so they run in both the browser and Node.
- They do not read the required capability (`env.capabilities`): nothing here uses a model.
- They may use `../protocol/lib/` (the core layer).
- Among the platform APIs used is `Intl.Segmenter` (sentence splitting): it exists only from Chrome 87, Firefox 125, Safari 14.1. Without it, sentence splitting throws `segmenter_missing` (there is no fallback: cutting hard on punctuation would break abbreviations and decimals).

## Runtime

The only command-line tool the small tools ask the runtime environment for is **ffmpeg**, and it is optional:

- It is used for audio other than WAV (mp3, flac, ogg, m4a, webm, opus, ...), and for WAV encodings the tool cannot decode itself (8-bit, ADPCM, ...). WAV with 16-, 24-, and 32-bit integer PCM and 32-bit float is decoded by the tool itself and does not need it.
- If the environment does not have it, the core layer's `runtime_missing` is thrown (`details.runtime` is `ffmpeg`); only the features that use it report an error, and the rest work as usual.
- The signature is in `@runtime ffmpeg` in the file header of `audio-decode.mjs` (the method: a runtime is registered in the file header of the first module that calls it; run `grep -rn "@runtime" .` in the root of the base part to find them all; the registration and the calls must stay consistent).
- On the command line, ffmpeg is looked up on the machine's `PATH` (`../cli/node-runtimes.mjs`), and `../cli/environment.mjs` connects it into the command's runtime environment.

The base part's manifest registers this item in `runtimes` (`ffmpeg`, optional): the registered content is in `manifest-fields.json` at the root; for how to write it see `../protocol/FORMAT.md` 4.3.

## Standard cases for script markup

`cases/markup.json` is the standard set of cases for script markup parsing, and **every implementation is checked against it**: the base part's `markup.mjs` is one; if an app that embeds this library carries its own parser (for example, parsing the script in the browser), that is another. Two implementations of one contract: if one result differs, one side is wrong. Decide which is right first, then change both together; do not write the other side wrong to accommodate one side.

- Verification: every implementation runs this whole set of cases, and the results equal `expected`; compare the outputs of the two implementations one by one on 20,000 random scripts, which covers combinations the standard cases did not think of (the program for the random comparison is not shipped with the base part).
- Adding a case: add an entry `{ name, input, options?, expected }` to `cases/markup.json`; in `expected`, omit fields equal to the default (the defaults are in `defaults` at the start of the file); case names must not repeat; write invisible characters as `\uXXXX`. If the syntax changes, change the `markup.mjs` file header first, then the two implementations and the cases.
- `vocab/markup.json` is the vocabulary of script markup (for now only `pause` and `voice`; a chapter heading is not a square-bracket markup and is not in the vocabulary); every word in the vocabulary must work in every parser, and when a new word is added to the vocabulary, every parser must implement it. Any square bracket outside the vocabulary is a cue and stays in the text as it is.

## Tests

The tests for these small tools are not shipped with the base part. Apart from one place, all audio in the tests is generated on the spot, and there are no audio files. The exception is the audio fingerprint test: it needs recordings of real people speaking to show that "another sentence by the same person does not count as reuse", and it uses a few recordings from public corpora (600 KB in total). The sections that use a real ffmpeg are skipped, with an explanation, on machines that do not have ffmpeg.
