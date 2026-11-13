# Protocol core

The same content that every part (base part, role part) carries: the format description, the public key and the official address, the programs that read, write and verify voice packs (the core layer), and the steps and blank template for making a new pack. A pack that has only a role part contains only this layer, so what is here depends only on files in this directory.

## Directory layout

| Path | Contents |
|---|---|
| `lib/` | The core layer programs, `.mjs`, grouped as in "Programs in `lib/`" below. The header of each file states what it does and which `code`s it throws |
| `cli.mjs`, `cli/` | The command line of the core layer, see "Command line" |
| `FORMAT.md` | The format description (the only copy): a third party can read and write voice packs from it alone. Directory, paths, hashes, manifest, SKILL.md, pack ID, audio, share file, unpack limits, check, and which version complete takes are all in it |
| `SIGNATURES.md` | The official signature: the signature file format (minisign legacy mode), the trust list, the signature verification policy that the library entry points must choose (`signature_policy_missing`) and how each caller passes it, `--allow-unsigned` on the command line, the rules of mutual verification, the `keygen`, `sign`, `verify` commands |
| `RELEASES.md` | Official releases: the official address, the four kinds of files in the directory, the format of the version index, how to fetch a version, how an app maps to a version, immutability |
| `schema/` | The JSON Schema of the manifest |
| `trust.json` | The trust list: the official public keys (there may be several). The official address (`official_url`) is also here |
| `manifest-fields.json` | The protocol core's own version number (semantic version). `seal --part protocol --fields` reads it at release. The `manifest-fields.json` at the root of the base part works the same way, and also registers the runtimes |
| `new-pack/` | Making a new pack: `README.md` (the abstract specification: the flow, who may see what, how to write each field, what the duplicate check compares; there is no complete example role), `brief.md` (the task description for the pack-making agent in the clean room), `template/` (the blank template). The `clean-room` command of the base part puts them, together with the attributes the user stated, into one directory and hands it to a new session that cannot see the source pack |

### Programs in `lib/`

| Purpose | Files |
|---|---|
| Common foundation | `errors.mjs` (unified errors), `env.mjs` (getting things from the runtime environment), `bytes.mjs` (hex, Base64), `hash.mjs` (SHA-256), `version.mjs` (protocol version, semantic version), `names.mjs` (the three names that correspond to the protocol major version: the directory name of the base part, the prefix of the official release zip file name, the type identifier of the share file; 3.x and 2.x use the same names, see `FORMAT.md` sections 13 and 14), `limits.mjs` (unpack limits), `paths.mjs` (path form and checks), `fileset.mjs` (file set: `Map<path, Uint8Array>`) |
| Masking | `scrub.mjs` (masking before anything is reported: tokens, refresh tokens, API keys, passwords and signed URLs in the original text are removed; errors, model answers, and the standard error of programs and scripts all go through it; use `scrubbedCause` before an error goes into the cause of another error) |
| zip | `zip.mjs` (entry point, read and write), `zip-format.mjs`, `zip-structure.mjs`, `zip-read.mjs`, `zip-write.mjs` |
| Manifest | `schema.mjs` (validator for a subset of JSON Schema), `manifest.mjs` (read, write, check the manifest), `seal.mjs` (generate the manifest for a part) |
| Check | `check.mjs` (check a part: `checkPart` is the entry point at the trust boundary and must choose a signature verification policy; `selfCheckPart` is the library's internal self-check), `mutual.mjs` (mutual verification of the role part and the base part), `audio.mjs` (decide the audio format by content), `skill-md.mjs` (reading and checking SKILL.md, generating the skeleton of the role part), `guidance-sections.mjs` (the five subsections of the dubbing guidance; `guidanceForModel` decides the portion handed to the model, see `FORMAT.md` section 5) |
| Making packs and share files | `pack.mjs` (pack ID, making a role part), `share.mjs` (build, open, check a share file: `checkShareFile` and `inspectShareFile` likewise must choose a signature verification policy) |
| Preview card | `preview-card.mjs` (`buildPreviewCard`: the self-contained `index.html` in the share file, generated at packing time; what is on the page and how it is guaranteed not to go online or run scripts is written in one place only, its file header), `preview-audio.mjs` (the audition embedded in the card: WAV and MP3 are shortened by frames without re-encoding; the limit and the reason are in the file header), `voice-orb.mjs` (the card's picture, drawn from the pack ID), `spoken-words.mjs` (`spokenWords`: the words that are actually spoken from a line after the script markup is removed, which the card shows for the audition line; which kinds of markup it recognizes and how it tidies the punctuation is written only in its file header) |
| Script notation | `script-markup.mjs` (the regular expressions for cues, angle-bracket tags, stage directions and emphasis, written only here; the description of the notation is in the file headers of `tools/markup.mjs` and `lib/line-hints.mjs` in the base part, and they quote from here), `word-spacing.mjs` (whether to put a space when two pieces of text are joined, and whether to leave a space after a cue is removed; making packs and dubbing in the base part use it too) |
| Signature | `signature.mjs` (Ed25519 signing and verifying), `official.mjs` (turns the trust list into the signature verification hook used by checks: the base part and the protocol core accept only the official signature) |
| Official releases | `releases.mjs` (the official address, the file names of official versions, reading and writing the version index, reading published files; layout in `RELEASES.md`) |
| Complete | `base-choice.mjs` (pure decisions: whether a base part already in the environment can be used, and which version to pick from the official version index), `complete.mjs` (the flow of complete: first use one in the environment that is usable; only if there is none, read the version index, pick a version, fetch the official base part, put it into the pack, then check the whole pack; the rules and reasons are in `FORMAT.md`「Complete」. Reading the index, fetching the zip, and verifying the signature use `release-fetch.mjs` and are not rewritten here) |
| Other | `audio-clip.mjs` (audio clip: bytes plus a MIME type) |

## Module conventions

The library's programs (`protocol/lib/`, `lib/` and `tools/` at the root of the base part, and the `.mjs` files in the environment adapter layer `adapters/`) are all written by these rules.

1. **File format**: ESM `.mjs`, with `// SPDX-License-Identifier: Apache-2.0` on the first line of the file.
2. **No third-party libraries**: `import` may only point to relative paths; do not install packages.
3. **Use only the platform's built-in APIs; runs in browsers and Node**.
   - Allowed: `crypto.subtle` (hash, Ed25519), `TextEncoder`, `TextDecoder`, `CompressionStream`, `DecompressionStream` (only `deflate-raw`; browsers have no `brotli`), `URL`, `Blob`, `Intl`, `btoa`, `atob`.
   - Not allowed, because Node-specific: modules starting with `node:`, `Buffer`, `process`, `__dirname`, `require`.
   - Do not use new methods that are not present on both sides. Node 24.14 has no `Uint8Array.prototype.toHex`, `toBase64`, `Uint8Array.fromHex`, `fromBase64` (measured on 2026-10-14); use `lib/bytes.mjs` for hex and Base64.
4. **Node-specific things appear only in the command-line layer**: files named `cli.mjs` and the directory named `cli/`; also the adapter factory file `adapters/<name>/adapter.mjs` (it runs on the adapter owner's side and is loaded by the unified entry `cli/adapters.mjs` of the command-line layer; apps and browsers never load it; for the rules see `adapters/README.md`「Where Node-specific things go」). The library's programs do not touch the file system (input and output are `Uint8Array`, strings and plain objects, and files are read and written by the command-line layer), do not go online directly, do not start processes directly, and do not call models directly: all of these are requested from the injected runtime environment, see the next section.
5. **Do not `import` files outside the base part and do not copy AGPL-3.0-only code**: the base part is Apache-2.0. You may rewrite from the behavior, but not copy.
6. **Dependencies run one way**: the core layer (`protocol/lib/`) depends only on the core layer; `tools/` uses only the core layer; `lib/` may use the core layer and `tools/`, and may also read the JSON vocabularies in `vocab/` (data, not programs); `adapters/<name>/` uses only the core layer and its own directory.

These rules are checked on code only: each `.mjs` is cut into tokens and then checked, so words in comments and strings do not count; the templates in `protocol/new-pack/` are not bound by them.

## Runtime environment

The library does not bind to a model. To use a model, go online, or start a command-line tool, it asks the runtime environment injected by the caller. The environment is an object with three containers:

```js
const env = {
  capabilities: { 'text-to-speech': async (/* 签名见下 */) => { /* ... */ } },  // 所需能力
  fetch: (input, init) => Promise<Response>,                                      // 所有网络读取
  runtimes: { ffmpeg: async (/* 签名见下 */) => { /* ... */ } },                 // 命令行工具
};
```

| Container | Key | Value | Access | If missing |
|---|---|---|---|---|
| `capabilities` | A name in the capability vocabulary (`vocab/capabilities.json`) | The implementation of this capability | `requireCapability(env, name)` | Throws `capability_missing`; `details.capability` is the missing one |
| `fetch` | none | A function like the standard `fetch(input, init)`; all network reads, such as complete and verifying external resources, go through it | `requireFetch(env)` | Throws `fetch_missing` |
| `runtimes` | The name of a command-line tool, for example `ffmpeg` | The implementation that runs this tool | `requireRuntime(env, name)` | Throws `runtime_missing`; `details.runtime` is the missing one |

All three access functions are in `lib/env.mjs`.

- **Fetch only when used**: a feature takes a capability only at the moment it needs it, not all at once at startup. So when the environment lacks one, only the feature that uses it reports an error, and other features work as usual.
- **The environment may provide nothing**: giving `{}` for `capabilities` is a legal environment. If the environment sets an item to `undefined`, `null`, or `false`, that also counts as not having it. If the environment itself is not an object or has no `capabilities` container, it throws `environment_invalid`.
- **Call signatures are defined in one place**. The implementations of capabilities and runtimes are functions, and the library always `await`s their return values, so both synchronous and asynchronous implementations work. The parameters and return values of the required capabilities are written in `vocab/capability-signatures.md` (the first feature that uses a new capability adds its signature there); a module that uses it adds a line `@capability <capability name>` in the header JSDoc pointing there, and does not copy it again. The runtime signature is written in the header of the first module that calls it (`@runtime <name>`). To find where a capability is used: `grep -rn "@capability text-to-speech" .`. Parameter names use `ref_audio` and `ref_text` from the third level of the capability vocabulary; audio is always bytes plus a MIME type (`lib/audio-clip.mjs`), and URLs are not accepted. How `fetch` is used (timeout, retry, how to read the response) is written by the module that uses it in its own file header.
- **Adapter** (`adapters/<name>/`; all adapters together are called the environment adapter layer) assembles the environment in this shape: it maps the names in the capability vocabulary to concrete models usable in this environment. Where a model name may appear: see `README.md`「Rules」 of the base part. The adapter contract (how to write the factory, what it returns, how to report errors) is written only in `adapters/README.md`.

## Errors

The library (the code in `lib/`) throws only two kinds of error, divided by who made the mistake:

- **Mistakes in data**: something from user input, command-line arguments, files, the network, or a capability's return is wrong. Throw `VoicePackError` (`lib/errors.mjs`) with a string `code`; callers tell errors apart by `code`, not by `message`.
- **Mistakes by the programmer**: the caller's code used the interface wrongly: a parameter has the wrong type (a string was given where a `Uint8Array` is required), a value is not legal (a limit of 0), a precondition is not met (a manifest of the base part was passed to a function meant for the role part). Throw `TypeError`, with a `message` that names the parameter and what was received. This is a bug in the caller's code that has to be fixed in the code and is not reported to the user: the command line reports it as an internal error (`internal_error`). An illegal value also uses `TypeError`, not `RangeError` or `Error`; there is no third kind in `lib/`.

When you cannot tell which kind it is: if you swapped in other data from someone else, would the same call also hit this error? If yes, it is a data error. Foreign data must never make the library throw `TypeError`: the entry point checks first and reports the problem as a `VoicePackError`, or puts it in a report (entry points such as `checkPart` and `inspectShareFile` do not throw, and the problems are all in the report). Example: the description read by making a pack and `seal` is a file given by the author, and a wrong field type is `manifest_invalid`, not `TypeError`. The command line's own usage errors (unknown command, missing argument) are `UsageError` of `cli/runner.mjs`, exit code 2, and are not library errors.

The fields of `VoicePackError`:
- `code`: lowercase letters, digits, underscores, for example `capability_missing`, `member_too_large`.
- `message`: a description for people that names what went wrong: which capability is missing, which file, which hash does not match.
- `details`: machine-readable context, values that JSON can represent, for example `{ capability: 'speaker-verification' }`.
- `cause`: the underlying original error.
- To test, use `isVoicePackError(error, 'code')`, not `instanceof`: in a full pack the protocol core has two copies, the same process may load both, and each has its own class.

**Codes are not gathered into one enum**: whoever throws it defines it, and states the meaning and what goes in `details` in a comment at the place where it is thrown. Before adding one, run `grep -rn "'<code>'" .` to confirm nobody has used it.

The ones that already exist at this layer: `capability_missing`, `runtime_missing`, `fetch_missing`, `environment_invalid` (`lib/env.mjs`); `invalid_hex`, `invalid_base64` (`lib/bytes.mjs`); `command_load_failed` (`cli/runner.mjs`); the group for signing and verifying (`ed25519_unavailable`, `trust_list_empty`, `signature_invalid`, etc., `lib/signature.mjs`; the list is in `SIGNATURES.md`).

The `code`s for format and checks are in these places: the problems in the check report (`file_modified`, `audio_disguised`, `external_unverifiable`, etc.), the `signature_policy_missing` thrown when an entry point has not chosen a signature verification policy, and the `signature_unverifiable` when only `allowUnsigned` is chosen, are in the file header of `lib/check.mjs`; those of mutual verification (`protocol_incompatible`, `base_too_old`, `capability_unknown`, `capability_vocabulary_invalid`) are in `lib/mutual.mjs`; the official signature of the base part and the protocol core (`signature_missing`, and the various ones thrown by verification) are in `lib/official.mjs`; those of the manifest (`manifest_invalid`, `protocol_unsupported`, etc.) are in `lib/manifest.mjs`; those of paths (`path_unsafe`, `path_conflict`) are in `lib/paths.mjs`; those of zip (`zip_malformed`, `symlink_not_allowed`, `too_many_members`, etc.) are in `lib/zip-structure.mjs`, `zip-read.mjs`, `limits.mjs`; those of share files (`share_not_voicepack`, `share_layout_invalid`) are in `lib/share.mjs`; those of making packs (`pack_invalid`, `crypto_unavailable`, `random_invalid`) are in `lib/pack.mjs`; those of official releases (`official_url_invalid`, `index_invalid`, `release_conflict`, `published_unreadable`, etc.) are in `lib/releases.mjs`; those of complete (`base_version_unavailable`, `completed_pack_invalid`, `in_pack_base_unusable`, `complete_not_role_part`) are in `lib/complete.mjs`; the other `code`s thrown when complete reads an official version (`official_unpublished`, `release_invalid`, etc.) come as they are from `lib/release-fetch.mjs`, and complete only adds `details.stage` to them; those of the command line reading and writing the disk (`file_exists`, `file_unwritable`, `file_unreadable`) are in `cli/disk.mjs`; that of `seal` reading the description file (`fields_invalid`) is in `cli/commands/seal.mjs`.

## Command line

It also runs with only the protocol core: run `node protocol/cli.mjs <command> [arguments...]` in the root directory of this part. The `node cli.mjs <command>` at the root of the base part carries the flow layer's commands in addition to the core layer's commands. A full pack has two copies of the protocol core; use the one in the base part.

A command is `cli/commands/<name>.mjs`, and adding a command adds only a file. How to write a command, the context it receives, the exit codes, and how errors are reported are all written in the file header of `cli/runner.mjs` and not repeated here.

The commands of the core layer (the parameters, exit codes and output of each command are written in the file header of its own file, and you can also run `node protocol/cli.mjs help <command>`):

| Command | What it does |
|---|---|
| `seal` | Generates the manifest `manifest.json` for the directory of a part; generates the skeleton when a role part has no `SKILL.md`. It does not verify signatures and does no mutual verification (the part being sealed has no signature yet) |
| `pack` | Packs the directory of a part into a share file (`.voicepack.zip`). It checks first, including signature verification and mutual verification |
| `unpack` | Unpacks a share file into a pack directory. It checks first, including signature verification and mutual verification |
| `check` | Checks a share file or the directory of a part, including signature verification and mutual verification |
| `keygen`, `sign`, `verify` | Signing and verifying, see `SIGNATURES.md` |
| `complete` | Completes a pack that has only a role part: when there is no usable base part in the environment, it fetches the official base part, verifies the signature, puts it into `voice-pack/` in the pack, then checks the whole pack. For the rules see `FORMAT.md`「Complete」 |

`complete` differs from the ones above: it goes online (reads the official address, through the injected `env.fetch`), always verifies signatures, and has no `--allow-unsigned`; `--trust <trust list.json>` likewise is only for tests and third parties, and the official complete does not pass it. The part that reads and writes directories and finds a base part already in the environment is in `cli/completing.mjs`: it is first written into a temporary directory inside the pack directory and renamed to `voice-pack/` only in the last step, and a failure at any step leaves no half-built directory.

What `seal`, `pack`, `unpack`, `check` have in common: check first, and write only if it passes; if the directory has symbolic links, special files, or exceeds the unpack limits, it refuses. Each has its own rule for writing to disk: `pack` and `unpack` do not overwrite existing files and directories; the purpose of `seal` is to replace the `manifest.json` in the directory (together with the signature that becomes void once the manifest changes), so it overwrites that, leaves other files alone, and leaves an existing `SKILL.md` as it is; `check` writes nothing. They share these files in `cli/`: `disk.mjs` (reading and writing directories and files), `checking.mjs` (reading in, checking; `check`, `pack`, `unpack` hook up signature verification and mutual verification here), `report.mjs` (the text form of the check report). The rules of the format itself are in `FORMAT.md` and are not repeated here.

**`check`, `pack` and `unpack` verify signatures and run mutual verification by default**, with the same options (written in the `help` of each of the three commands):

- The base part and the protocol core must carry the official signature; the trust list is the `protocol/trust.json` that comes with **the protocol core that is currently running**, not the one carried by the pack being checked. `--trust <trust list.json>` swaps in another list (for tests and third parties).
- `--allow-unsigned` lets through only a part that has "no signature file", and the report states that it was not verified; one that has a signature file is still verified. For local development.
- The role part and the base part it carries are matched against each other: protocol major version, base part version, required capabilities. A pack with only a role part cannot do this, and the report states it.
- For the rules and reasons see `SIGNATURES.md`「Wiring into the check」「Mutual verification of the pack」 (two sections).

**Entry points in the library must be chosen the same way**: for `checkPart`, `checkShareFile`, `inspectShareFile`, which handle things from outside, the caller must explicitly give a signature verification function (`createSignatureVerifier(trust list)`), or explicitly write `allowUnsigned: true`; giving neither throws `signature_policy_missing`, before any input is read. Mutual verification is on by default at these entry points (only `mutual: false` turns it off). To check a part the library has just sealed itself, use `selfCheckPart`, which needs no policy. For how each caller passes it, see `SIGNATURES.md`「The caller must choose a signature verification policy」.
