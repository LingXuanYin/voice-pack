# Voice pack format

This file is the authoritative text of the voice pack format: a third party can read, write and check voice packs from it alone, without our programs. The programs in `protocol/lib/` implement it; where the two disagree, this file wins and the program is changed.

It applies to protocol version 3.0 (the `protocol` field of the manifest). Within one major version, minor versions only add and never remove: a reader ignores every field it does not recognise. Which major versions a reader accepts is up to the reader: the programs that go with this file read 1.x, 2.x and 3.x and no other major version. For how 2.0 differs from 1.x and how to read 1.x packs, see section 13; 3.0 is a new major version that is not compatible with 2.x, see section 14.

"Must" and "must not" in this file are hard requirements on both writer and reader; "may" is permission. Every number that comes from outside material, from a measurement that was run, or that is only an estimate is marked next to it with its source and grade.

## Terms

| Term | Meaning |
|---|---|
| voice pack | The unit used to exchange one character's voice. It consists of a role part and a base part, and each part can be distributed on its own |
| role part | The content that belongs to one character only: the reference set, and optionally held-out recordings, dubbing guidance, sample lines, scripts and so on |
| base part | The content that does not depend on any character: the general procedures, the protocol core, vocabularies, the environment adapter layer, the official small tools. The directory name follows the protocol major version: for 2.x and 3.x it is `voice-pack`, for 1.x it is `cohub-voice-studio` (sections 13 and 14) |
| protocol core | The subdirectory `protocol/` that every part carries: this file, the manifest schema, the public key, and the programs that read, write and check voice packs |
| full pack | A voice pack that contains both the role part and the base part |
| pack ID | The name of a voice pack that stays the same across versions; it is also its directory name |
| share file | A single zip file made from one or both parts of a voice pack |
| part | One of role part, base part, protocol core: each has its own manifest and manages its own directory |

## 1. Pack form and directory

Both parts are standard Agent Skill directories (specification: <https://agentskills.io/specification>), and the entry point of each is `SKILL.md`.

The diagram and directory names below are for 3.x, and are the same as for 2.x; in a 1.x pack only the directory name of the base part differs (section 13).

```
<pack ID>/                       full pack: the role part is at the root
├── SKILL.md                     entry point of the whole pack: description of the role part and the dubbing guidance
├── manifest.json                manifest of the role part
├── <the role part's own files...>   reference audio, held-out recordings, scripts...
├── protocol/                    protocol core, with its own manifest.json and signature
└── voice-pack/                  base part (a pack with only the role part has no such directory)
    ├── SKILL.md
    ├── manifest.json            manifest of the base part
    ├── manifest.json.minisig    signature of the base part's manifest
    ├── <the base part's own files...>
    └── protocol/                protocol core (yet another copy of the same content as above)
```

- Full pack: the directory is the pack ID. Pack with only the role part: the same directory, without `voice-pack/`. Pack with only the base part: the directory is `voice-pack/`, and the structure inside it is the same as that part of the diagram above.
- Every part must carry `protocol/`. A full pack therefore has two copies of the protocol core; use the one in the base part.
- Each manifest governs the directory it sits in, and lists every file in it except itself and its signature. A subdirectory that has a manifest of its own is left to that manifest, and this manifest does not list it. So: the role part's manifest does not list the files in `protocol/` and `voice-pack/`; the base part's manifest does not list the files in its `protocol/`; the protocol core's manifest lists all the files in its directory.
- The role part's own files (for example `reference/`, `holdout/`, `scripts/`) may be named freely, as long as they pass the rules of the "Paths" section and are listed in the manifest.
- To use it in an agent environment: put the pack directory into the project's `.agents/skills/` (read by Codex, Gemini CLI, Cursor, OpenCode and others), and copy it again into `.claude/skills/` (read by Claude Code).

## 2. Paths

Paths in a manifest and member names in a share file are written the same way and go through the same checks.

**How a path is written**

- Always use `/` as the separator, relative to the directory it belongs to (a path in a manifest is relative to the directory of the manifest; a member name in a share file is relative to the root of the zip). It does not start with `/` and does not end with `/`.
- A path is case-sensitive and is compared as Unicode code points exactly as written, with no normalisation: a path in a manifest must match the file name in the pack character by character.
- Sort by UTF-8 byte order (equal to code point order, independent of the system language). Do not sort by JavaScript's default UTF-16 code unit order: that reverses the order of high characters in the basic plane (U+E000 and above) and characters in supplementary planes (for example emoji).

**Forms that must not appear** (each has its reason next to it; the check reports `path_unsafe`, and `details.reason` is the name in brackets below)

| Form | Reason |
|---|---|
| Empty path, or not a string (`empty`, `not_string`) | Meaningless |
| Lone surrogate code unit (`invalid_unicode`) | It turns into some other character when encoded as UTF-8 |
| Control characters, DEL and C1 control characters (U+007F–U+009F), line separator and paragraph separator (U+2028, U+2029), writing-direction control characters (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069), byte order mark U+FEFF (`control_char`) | The displayed name differs from the real name |
| Backslash `\` (`backslash`) | Windows treats it as a directory separator and Linux treats it as an ordinary character: the same name means different things on the two |
| Colon `:` (`colon`) | Windows drive letters (`C:`) and NTFS alternate data streams (`a.txt:s`) |
| Starts with `/` (`absolute`) | Absolute path |
| An empty segment, for example `a//b` (`empty_segment`) | The location it resolves to is uncertain |
| A `.` segment (`dot_segment`) | Same as above |
| A `..` segment (`parent_segment`) | Jumps out of the directory it is in |
| A segment that ends with a dot or a space (`trailing_dot_or_space`) | Windows silently strips them, so the name written differs from the name read back |
| A segment that is a Windows reserved device name: `CON`, `PRN`, `AUX`, `NUL`, `CONIN$`, `CONOUT$`, `COM0`–`COM9`, `LPT0`–`LPT9`, and `COM¹`–`COM³`, `LPT¹`–`LPT³` (which treat the superscript digits `¹` `²` `³` as digits); with or without an extension, in any case (`reserved_name`) | On Windows, opening it opens the device. Basis: the original text of Microsoft Learn "Naming Files, Paths, and Namespaces" (retrieved and checked 2026-10-14): a reserved name is also reserved "when followed immediately by an extension; for example, `NUL.txt` is the same as `NUL`", and the superscript digits are "reserved in every directory"; `COM0`, `LPT0`, `CONIN$` and `CONOUT$` are not on that page's list, but they are device names too, so they are blocked as well |
| A segment longer than 255 UTF-8 bytes (`segment_too_long`) | The per-segment limit of common file systems |
| A whole path longer than 1024 UTF-8 bytes (`path_too_long`) | Fits the path length limits of the various systems, with room to spare |

**Conflict** (the check reports `path_conflict`): in one file list (or one zip), each of the three cases below is an error, because they would overwrite each other when extracted to disk.

- Exactly the same name;
- Equal when compared as "NFC-normalised, then lowercased" (names that differ in case or in Unicode form land on the same file on Windows and macOS);
- One path is a file and another path treats it as a directory (`a` and `a/b`).

In a manifest, the file list and the external resources are checked for conflicts together.

**Member names are never used as file system paths.** To write a member to disk, the reader builds the path itself: the target directory plus a relative path that passed the checks above, and after building it confirms that it is still inside the target directory. Our `unpack` does exactly this (`writeDirectory` in `protocol/cli/disk.mjs`).

## 3. Hashes

- The algorithm is SHA-256, written as 64 lowercase hexadecimal digits.
- It is computed over the original bytes of the file: no newline conversion (CRLF and LF make two different files), no decoding and re-encoding, no regard for what format the file is.
- A hash in a manifest is always computed over the extracted original bytes, not over the compressed bytes in the zip. The same file, written into different zips (stored, or deflate produced by different compressors), gets the same hash.
- The same bytes give the same hash on any system and any runtime; that is the definition of SHA-256.
- When you put a voice pack into a git repository, make git not convert newlines: add a `.gitattributes` in the pack directory containing `* -text` (or `* binary`). Git on Windows may by default turn LF into CRLF at checkout; once the bytes change, the hashes no longer match and the check reports that a file has been modified. A share file is a zip and is not affected.

## 4. Manifest (`manifest.json`)

The root of each part's directory has a `manifest.json`, which lists every file of that part and its SHA-256. The three kinds of manifest are told apart by the `part` field (`role`, `base`, `protocol`). The structure's schema is `protocol/schema/manifest.schema.json` (a subset of JSON Schema 2020-12); what follows is the plain-language version of it, and where the two disagree, the schema wins. Rules the schema cannot express are in the "Semantic rules" section.

### 4.1 How the manifest is written

- The file is UTF-8 JSON, without a byte order mark, and no larger than 1 MiB (see "Unpacking limits").
- A reader accepts any valid JSON layout. Our writer always writes: two-space indentation, LF newlines, one newline at the end, and keys in the order of `KEY_ORDER` in `protocol/lib/seal.mjs` (not the order in the tables below); keys not in `KEY_ORDER` (unrecognised ones, fields added later) go last, in lexicographic order (compared by UTF-16 code unit; when all key names are ASCII, that is ASCII order). The same content produces the same bytes, because the signature is made over these bytes.
- The order of objects in arrays and of keys has no effect on meaning; the order of the lists (`files`, `externals`) is constrained, see "Semantic rules".
- String length is counted in Unicode code points.

### 4.2 Fields common to the three manifests

| Field | Type | Description |
|---|---|---|
| `protocol` | string | Protocol version "major.minor", for example `"1.0"`. The version of the protocol this manifest was written for |
| `part` | string | One of `role`, `base`, `protocol` |
| `version` | string | The version number of this part, a semantic version (semver.org 2.0.0), at most 128 characters |
| `files` | array | Every file in this part's directory except the manifest and the signature: `{ path, size, sha256 }`, at most 65534 entries. For `path` see "Paths"; `size` is the number of bytes (a non-negative integer); for `sha256` see "Hashes" |

The protocol core's manifest has only these four fields defined in 1.0. The base part's manifest has, besides these four, an optional `runtimes`, see "Manifest of the base part".

### 4.3 Manifest of the base part

Besides the four common fields, a manifest with `part` set to `base` has one optional field:

| Field | Required | Description |
|---|---|---|
| `runtimes` | optional | Registers the command-line tools that this part's programs ask the runtime environment for: `{ runtime, optional, purpose }`, at most 32 entries. `runtime` is the name of the runtime (how to write it: see below), and one name is registered only once; `optional` is a boolean and must be written explicitly: `true` means that if the environment does not have it, only the functions that use it report an error and the others work as usual, `false` means this part cannot do without it as a whole; `purpose` is what it is used for, 1–200 characters |

**Runtime** is one concept with one way of writing: a command-line tool provided by the runtime environment, whose name is taken from a key of the `runtimes` container of the injected runtime environment (`protocol/README.md`「Runtime environment」), for example `ffmpeg`, `node`. How the name is written: it starts with a lowercase letter, followed by lowercase letters, digits, dots, underscores, plus signs and hyphens, at most 32 characters. A script in the role part uses `runtime` to say "which runtime runs this script", and the base part uses `runtimes` to say "which tools I ask the environment for"; the names in the two places are the same set and are written the same way (the schema defines it in one place only: `$defs.runtimeName`). Registration is only a public declaration, and the check does not require the runtime to actually exist in the environment; when it is missing, the function that uses it reports `runtime_missing` at the time of use.

The official base part currently registers one entry: `ffmpeg`, with `optional` set to `true`, used to decode audio other than WAV, to change speed after synthesis (speaking rate, target duration), and to take the audio track out of a video (the original wording is the `purpose` in the `manifest-fields.json` mentioned below). The registered content and the version number are kept in `manifest-fields.json` at the root of the base part (the manifest's fields other than the file list, committed into the repository), and at release time `seal --part base --fields manifest-fields.json` writes them into the manifest; the protocol core's version number is handled the same way, kept in `protocol/manifest-fields.json` (which has only `version`). The version number of an official release is written in these two files: at release time it decides which version is released, and a version number that has already been released and is released again with different content is refused (`RELEASES.md`). The registration must be consistent with the code: a runtime that the code registers with `@runtime <name>` must be in the manifest; one registered in the manifest must be used by something in the code.

### 4.4 Manifest of the role part

Besides the four common fields in 4.2, a manifest with `part` set to `role` has the following (one marked "required" that is missing makes the manifest invalid):

| Field | Required | Description |
|---|---|---|
| `id` | required | The pack ID, see "Pack ID" |
| `name` | required | Display name, 1–100 characters |
| `changelog` | required | The change notes for this version, 1–4000 characters |
| `madeWith` | required | `{ baseVersion }`: the version of the base part used when this pack was made (like the version number after "Made with"). It does not record which pack this pack came from |
| `requires` | required | `{ protocolMajor, baseMin }`: the protocol major version required of the base part (an integer), and the minimum version of the base part (semver). `baseMin` is written as a version in the major version whose protocol major version at release time is `protocolMajor` (if `protocolMajor` is 3, write a 3.x version; a 3.0.0 pre-release also counts, for example 3.0.0-beta.25): completion picks only within the major version of `baseMin`, and only among those whose protocol major version matches (section 11, "Which version to fetch"); if the major version is written wrongly, a pack with only the role part cannot be completed |
| `features` | required | The required capabilities of each feature: the key is the feature name and the value is `{ capabilities: [capability name...] }`, with capability names taken from the base part's capability vocabulary (`vocab/capabilities.json`). At most 64 features, and at most 64 capabilities per feature. When the environment lacks a capability, only the features that use it report an error |
| `reference` | required | The reference set: `{ defaultSegment, languageDefaults?, segments }`. `segments` has at least 1 and at most 500 segments; `defaultSegment` is the `id` of one of them; `languageDefaults` is the default segment of each other language, written as described below under "Default segment" |
| `holdout` | optional | Held-out recordings: used only to measure fidelity, never as references. How a segment is written is below; at most 500 segments |
| `externals` | optional | External resources: not stored in the pack but placed at a URL and checked with SHA-256: `{ path, url, size, sha256 }`, at most 1000 entries. `url` must be `https://`, at most 2048 characters. An external resource is referenced by its path, on the same footing as a file inside the pack |
| `scripts` | optional | Scripts: `{ entry, runtime, feature? }`, which register the entry point and the runtime and declare no permissions. `entry` must be a file inside the pack (not an external resource); `runtime` is the name of the runtime, written as in "Manifest of the base part"; at most 100 entries. `feature` says which feature it belongs to: only a script with it written runs automatically with that feature; one without it belongs to no feature and is not run automatically (the pack's dubbing guidance may teach an agent to use it manually; the convention is in the file header of `lib/pack-script.mjs`). This is not a problem, and the check still passes; the text output of the `check` command names such scripts |
| `enhancers` | optional | Enhancers: files that are valid only for one model and give higher fidelity on that model: `{ id, path, model, modelVersion, capability, referenceVersion }`. `referenceVersion` is the version of the reference set (semver) that was used to make it. The pack does not depend on enhancers. At most 100 entries |
| `direction` | optional | The structured part of the dubbing guidance: `{ description?, tags? }`: a one-sentence voice description (at most 500 characters) and voice tags (each 1–64 characters, at most 32, no duplicates) |
| `sampleLines` | optional | Sample lines: they say what this voice usually says and how it says it; an array of strings, each one a line. At most 50, each 1–500 characters (counted in code points), and each must not consist only of whitespace or invisible characters ("Semantic rules" item 11); writing the same line twice is not an error. A line may carry stage cues, for example （耳语） (whisper) or *笑* (laughs), written and read the same way as the base part's stage cues (file header of `lib/line-hints.mjs`, vocabulary `vocab/cues.json`; the two examples are Chinese because they are examples of Chinese lines); the format only stores the string and does not parse it, so there is no separate tag field. The field is named `sampleLines`, not `samples`: in the data of some voice communities `samples` means the URL of an audition audio |
| `cardLine` | optional | Audition line: the one line, with its recording, shown with the pack, for example on the preview card ("Share file"): `{ audio, text, seed?, expressiveness? }`. `text` is the line, written like one entry of `sampleLines`: 1–500 characters (counted in code points), must not consist only of whitespace or invisible characters ("Semantic rules" item 11), may carry stage cues, and the format only stores the string and does not parse it. `audio` is its recording, and must be a file in the file list (not an external resource: the card embeds it, "Semantic rules" item 4), carrying a size and a hash like any other file in the pack. The recording is dubbed with this pack's own voice (by the base part's make-pack program; how it is dubbed is in its `lib/make-pack-card-line.mjs`). `seed` is optional: the seed handed to the synthesis capability when this line was dubbed, an integer from 0 to 2^53−1, present only when the environment takes a seed (leave it out if it does not). The same seed with the same request was measured to give the same clip in one set of runs and different clips in another (`models/scene3.md`「Sampling: `seed`」). When the make-pack program re-dubs this line with the same request it uses a different seed (the previous version's plus 1), and must record which one the previous version used; the format only stores this number, and neither dubbing nor the preview card reads it. It is not a reference and not a held-out recording: dubbing, voice conversion, measuring fidelity and picking the default segment do not read it. `expressiveness` is optional: the expressiveness taken separately for dubbing this line (present only if it was stated explicitly when the pack was made), an integer from 0 to 100 (for the scale see `vocab/capability-signatures.md`); only this line uses this value and everything else stays as before; a new version that keeps this line is not reported as `expressiveness_changed` because of it. Whether the card shows it or the default segment is decided by the program that generates the card (the index.html of "Share file"). What the card shows is the words read aloud from `text` after the script markup is removed (cues in square brackets, tags in angle brackets, stage directions in parentheses); the rule is in the protocol core's `lib/spoken-words.mjs`; the manifest still stores it as written |
| `setups` | optional | Several setups: write the fixed values of "how it is said" for dubbing into the pack (fixed into the voice). An array, each entry one setup: `{ name, labels?, referenceTag?, speed?, instructions?, expressiveness?, default? }`, at most 500 setups. `name` is the name, 1–100 characters, and must not repeat within one pack ("Semantic rules" item 13); `labels` are fixed labels `{ language?, emotion?, style?, energy? }`: `language` is a language tag (written as the `language` of a reference segment), `emotion` and `style` are labels of 1–64 characters (names taken from `vocab/cues.json`), and `energy` is one of `low`, `medium`, `high`; these are not the same set as the reference tag (`tag`) of a reference segment; `referenceTag` is the default reference of this setup, written as the reference tag of one reference segment in the reference set (1–64 characters, which must match, "Semantic rules" item 17), only a default and not binding, and dubbing may replace it with another tag (how it is used is in the base part's dubbing); `speed` is a multiplier of the speaking rate, a positive number (1 is unchanged, 0.85 slows down, 1.15 speeds up), and dubbing changes the speed by it after synthesis (the "slow down" and "speed up" written in a script are cues handed to the model, which is not the same thing); `expressiveness` is the expressiveness fixed by this setup: if the caller gives none when dubbing and this line uses this setup, it is used (it overrides the top-level `expressiveness`, see the next row) (for the scale see `vocab/capability-signatures.md`; the order in which values are taken and how they are handed to the model are specified in the "Setup" part of the file header of `lib/dub.mjs`); `instructions` is a note for the person writing the script, describing the concrete features of an accent or dialect, 1–4000 characters (the format governs only this much; dubbing does not send it to the model, see the base part's `references/make-pack.md`「Several setups (writing fixed values into the voice)」); the one with `default: true` is used when dubbing without naming a setup, at most one (item 14). There are two ways to change the values of a setup: save in place and delete the setups of the current version, with the version number unchanged (the base part's `references/make-pack.md`「Several setups (writing fixed values into the voice)」), touching only that one directory; or publish a new version of the pack. Packs already sent out and copies elsewhere do not change with it; to change them too, publish a new version. Which setup is used when dubbing is a parameter of dubbing (name one; without a name the one with `default` is used; the caller may also state that this time no setup is used at all, and not even the one with `default` is applied), and is not written into the manifest. How dubbing uses setups is specified only in the "Setup" part of the file header of `lib/dub.mjs`. Every 3.x base part recognises this field, and bases before 3.x do not read 3.x packs (section 14), so a pack with `setups` has no extra requirement on `requires.baseMin` (write it as in the `requires` row above) |
| `expressiveness` | optional | The expressiveness of this voice (a global value): an integer from 0 to 100 (for the scale see `vocab/capability-signatures.md`). It is the value of the whole voice, not a setup: it is not in `setups`, and dubbing uses it even when it uses no setup. When dubbing it ranks after the setup's `expressiveness`: it is used only if neither the caller's nor the used setup's is given, and if there is still none, nothing is passed. If it is not written, the pack has no global value. Changing it means publishing a new version of the pack (a pack does not change once it is published, see section 6); a new version that does not give it keeps the previous version's, and making a pack may state explicitly that it is to be removed |
| `verification` | optional | Verification records: `{ environment, model, date, fidelity: { ratio?, measuredBy? } }`: in which environment, with which model, on which day (`YYYY-MM-DD`) it was measured, and the fidelity ratio (a non-negative number). `measuredBy` is the evaluation model used to measure this ratio: `{ speakerVerification?, blindListening? }`, the model name used for speaker verification and for blind listening respectively, each 1–200 characters (short text like `model`); if you do not know which model it was, leave that key out, and if you know neither, leave out `measuredBy`. At most 100 entries |
| `designSource` | optional | Design source: for a designed voice, records the description, the model used and the lines used to audition during design: `{ description?, model?, modelVersion?, date?, auditionLines? }`. `auditionLines` is the design audition text: an array of strings, each one the original text of one audition, at most 10 items, each 1–4000 characters (counted in code points, like `description`), and each must not consist only of whitespace or invisible characters ("Semantic rules" item 12) |

**Reference segments and held-out recordings** are written as follows (for each entry of `reference.segments` and `holdout`; a held-out recording has only `id`, `audio`, `text`, `language`, `synthetic`, and no `tag` or `annotatedText`: it is not used as a reference, so it needs no switching):

| Field | Description |
|---|---|
| `id` | The name: lowercase letters, digits, hyphens, underscores, starting with a letter or digit, at most 64 characters |
| `audio` | The path of the audio file: a file inside the pack, or the path of an external resource |
| `text` | Verbatim transcript, 1–2000 characters. The text of a reference segment must not consist only of whitespace or invisible characters ("Semantic rules" item 10): every reference audio must have its matching text |
| `annotatedText` | Optional, cue annotation: the whole sentence of `text` with cues in square brackets added where the way of speaking changes, for example `[normal]啊，瞧瞧这是谁？[laughs]呵呵，[happy]太可爱了吧。` (the spoken words are Chinese, an example of a Chinese line). The words other than the cues are the same as `text`. 1–4000 characters, must not consist only of whitespace or invisible characters ("Semantic rules" item 10); if there is no cue annotation, do not write this key. When dubbing it is handed to the model together with the reference (when the model or platform does not take the text of a reference, the adapter decides what to do), and if it is absent `text` is handed over. Who writes it: making a pack (what the material gave is used as given; where it gave none, a model that can listen to audio annotates it; how it is written is in the base part's `lib/segment-annotation.mjs`); written only on reference segments, not on held-out recordings |
| `language` | Required, the language of this segment: a language tag, 2 to 3 letters, optionally followed by several groups of "hyphen + 2 to 8 letters or digits" (`$defs.languageTag` in the schema), at most 35 characters, for example `en`, `zh-CN`, `zh-Hans-CN`; underscores are not accepted (`zh_CN` reports `manifest_invalid`). Languages are compared in their normalised form (NFKC, lowercase), so `zh-CN` and `zh-cn` are the same language (`languageKey` in `protocol/lib/manifest.mjs`; it also treats an underscore as a hyphen, which is useful only for a language that comes in from outside the manifest, for example the language of a line given by the caller when dubbing) |
| `tag` | Required for a reference segment, the reference tag: a short name for this reference, used only to switch among the several references of one pack, for example "平常" (normal), "愤怒" (angry), "少年" (young), "苍老" (aged) (different emotions, different ages... are all written as this one tag; the examples are Chinese tags, to show that a tag may be in any language). Free text, Chinese or English both fine, 1–64 characters (counted in code points), must not consist only of whitespace or invisible characters ("Semantic rules" item 10). Compared character by character, so a different case means two different tags; two references in the same language must not have the same tag, but different languages may (item 16). A synthetic segment (`synthetic`) carries a tag all the same and can be referenced by a setup all the same. Who writes it: making a pack (what the material gave is used as given; where it gave none, the model that can listen to audio, when it gives this segment a cue annotation, also comes up with a name along the way, and where that is not possible the segment's `id` is used; a name that clashes within the same language gets a number added; when publishing a new version the author may change the tags of the previous version's references. How it is written is in the base part's `lib/make-pack-tags.mjs`) |
| `synthetic` | Optional, boolean. `true` means this segment is synthetic (for example regenerated from one clean reference of this person), not recorded by this person; if absent or `false` it is a real recording. Who writes it: making a pack (what the material marked; when publishing a new version, the previous version's segments keep their original marks). Who reads it: picking held-out recordings (a synthetic one is not used as a held-out recording and is not counted in the number of segments for "enough to hold out"), the human baseline (it does not enter the baseline), the number of real-recording segments in a report (it is not counted). It has no effect on serving as a reference or as the default segment: it is picked like a real recording. The segments of a designed voice are not marked; their source is recorded in `designSource` |

**Default segment**: A character can speak several languages, each language has its own default segment, and when dubbing, a line uses the segment of its own language (how one is picked by the line's language is specified in the file header of the base part's `lib/reference-pick.mjs`).

- `defaultSegment` is the default segment of the primary language: its `language` is this pack's primary language. It is used when the pack has no segment in the line's language, or when the line's language cannot be told.
- `languageDefaults` is the default segment of each other language: an array of segment `id`s, at most 500 entries, order does not matter. Each entry must be a segment in the reference set ("Semantic rules" item 6); languages are compared in normalised form (same as the `language` row of reference segments above), each language has at most one segment, and it must not be the same language as `defaultSegment` (item 15). `zh-CN` and `zh-TW` are two languages and may each have one.
- For a language that the reference set has but neither `defaultSegment` nor `languageDefaults` mentions, its default segment is the first segment of that language in the reference set. So a pack with only one language, and a pack that does not write `languageDefaults`, can still be read as before: leaving the key out means "every other language uses its first segment", with no migration needed.
- The base part's make-pack program writes one segment for each language (the primary language's goes in `defaultSegment`, the others go in `languageDefaults`; with only one language the key is not written); how it picks is in the file header of its `lib/pack-material.mjs`.

How the names (`id`, feature names, capability names) are written: feature names and the various `id`s are "lowercase letters, digits, hyphens, underscores"; capability names are lowercase letters, digits and hyphens, starting with a letter, at most 64 characters.

### 4.5 Semantic rules

After the schema passes, the rules below must also hold, otherwise the manifest is invalid (the check reports `manifest_invalid`, and `details.reason` is the name in brackets):

1. `files` and `externals` are each sorted by the UTF-8 byte order of the path (`files_unsorted`, `externals_unsorted`).
2. Every path passes the rules of the "Paths" section (`path_unsafe`); the file list and the external resources together have no conflict (`path_conflict`).
3. The manifest does not list itself or its signature (`listed_self`); it does not list files in a directory that is left to a sub-part (`listed_delegated`).
4. The paths of reference audio, held-out recordings and enhancers must be a file in the file list or an external resource; the script entry and the audition line's audio (`cardLine.audio`) must be a file in the file list (`reference_unresolved`).
5. The `id`s of reference segments and held-out recordings do not repeat (including between the two); the `id`s of enhancers do not repeat (`duplicate_id`).
6. `defaultSegment` and every entry of `languageDefaults` must be a segment in the reference set; held-out recordings do not count (`default_segment_unknown`; for an entry of `languageDefaults`, `details.pointer` is `/reference/languageDefaults/<index>`, with the index starting at 0).
7. An audio file cannot be both a reference and a held-out recording (`holdout_is_reference`).
8. A script's `feature` (if written) must be a feature that exists in `features` (`feature_unknown`).
9. In the base part's `runtimes`, the same runtime is registered only once (`duplicate_runtime`).
10. The `text` of a reference segment must not consist only of whitespace or invisible characters (spaces, newlines, zero-width spaces, control characters..., `text_blank`; the empty string is handled by the schema's `minLength`). If `annotatedText` is written, the same holds for it (the same reason, with `details.pointer` being `/reference/segments/<index>/annotatedText`); the reference tag `tag` is the same (`details.pointer` is `/reference/segments/<index>/tag`). Add that the schema requires the reference set to have at least 1 segment and every segment to have `audio`, and rule 4 requires that `audio` resolve to something; together these are the "content" item in validation: at least one reference audio and its matching text. This item is decided and reported only here in the manifest, and mutual verification does not check it a second time.
11. Each entry of the sample lines (`sampleLines`) likewise must not consist only of whitespace or invisible characters: the same judgement as rule 10, the reason is also `text_blank`, and `details.pointer` is `/sampleLines/<index>` (index starting at 0). The same holds for the audition line's text (`cardLine.text`), with `details.pointer` being `/cardLine/text`. The number of entries and the length of each are handled by the schema (the empty string is handled by `minLength`). An entry with only a stage cue (for example "（耳语）", a Chinese example meaning "(whisper)") has visible characters and is not counted as empty: the format does not judge whether a line "has any words".
12. Each item of the audition text in the design source (`designSource.auditionLines`) likewise must not consist only of whitespace or invisible characters: the same judgement as rule 10, the reason is also `text_blank`, and `details.pointer` is `/designSource/auditionLines/<index>` (index starting at 0). The number of items and the length of each are handled by the schema (the empty string is handled by `minLength`).
13. The `name` of a setup (`setups`) does not repeat within one pack (`duplicate_setup`, `details.pointer` is `/setups/<index>/name`, the index being that of the setup that appears later, starting at 0).
14. At most one setup carries `default: true` (`duplicate_default_setup`, `details.pointer` is `/setups/<index>/default` of the setup that appears later). Whether `speed` is a positive number, whether `expressiveness` (of a setup, of the manifest's top level, in `cardLine`) is an integer from 0 to 100, and whether `labels` is written correctly are handled by the schema.
15. Each language has at most one default segment (4.4, "Default segment"): if the language of an entry in `languageDefaults` is the same as that of `defaultSegment` or of an earlier entry (compared in normalised form), the manifest is invalid (`duplicate_language_default`, `details.pointer` is `/reference/languageDefaults/<index>` of the entry that appears later, `details.language` is its language, and `details.other` is the pointer of the place that mentioned this language first).
16. Within the same language (compared in normalised form), two references cannot have the same reference tag (compared character by character, so `Angry` and `angry` are two): `duplicate_reference_tag`, `details.pointer` is `/reference/segments/<index>/tag` of the segment that appears later, `details.other` is the pointer of the segment that had this tag first, and `details.id`, `details.language`, `details.tag` are those of the segment that appears later. Different languages may have the same tag.
17. A setup's `referenceTag` (if written) must be the reference tag of some reference segment in the reference set (compared character by character; a held-out recording has no tag): `reference_tag_unknown`, `details.pointer` is `/setups/<index>/referenceTag` of this setup, `details.name` is the setup's name, `details.referenceTag` is the tag written, and `details.tags` is the tags of the reference set listed by language, `[{ language, tags: [tag...] }]`: languages are grouped by their normalised form and shown as written where this language first appears in the reference set; both languages and tags follow the order in the reference set (the same tag is listed once). Whenever a program that reads packs reports "does not match this pack's tags", it lists them in this form (dubbing and voice conversion in the base part do the same).

There are two more cases that cannot be read: not valid UTF-8 JSON, a byte order mark, or abnormally deep nesting (`manifest_not_json`); and a protocol major version that this version does not recognise (`protocol_unsupported`; in that case other fields are not guessed at).

### 4.6 Version

- The protocol version has two parts, "major.minor". Within the same major version it is compatible: minor versions only add and never remove, and when a reader meets a minor version newer than its own, it ignores the fields it does not recognise. Different major versions are not read.
- The base part, the protocol core and the role part each use a semantic version number. `requires` says which protocol major version and which minimum version of the base part the role part requires.
- A base part lower than what the role part requires, or an incompatible protocol major version, falls under "mutual verification"; see the end of the "Check" section.

### 4.7 Signature

The manifests of the base part and the protocol core are signed officially with Ed25519, and the signature file sits next to the manifest, named `manifest.json.minisig`. The signature file is not listed in the manifest and does not count as an "extra file"; the role part's manifest has no official signature (the author's identity is left to community accounts). For the format, the trust list and the commands see `SIGNATURES.md`.

## 5. SKILL.md

The root of every part (base part, role part) has a `SKILL.md`, which must conform to the Agent Skills specification (<https://agentskills.io/specification>, retrieved and checked 2026-10-14). The protocol core is not a skill and has no `SKILL.md`.

**frontmatter**: it starts with YAML wrapped in `---`, may have only these 6 fields, and nothing else is accepted:

| Field | Requirement |
|---|---|
| `name` | Required. 1–64 characters, only lowercase letters, digits and hyphens, not starting or ending with a hyphen, no two consecutive hyphens. Must equal the directory name: the pack ID for the role part, `voice-pack` for the base part |
| `description` | Required. 1–1024 characters |
| `license` | Optional |
| `compatibility` | Optional. 1–500 characters |
| `metadata` | Optional. A mapping from string to string |
| `allowed-tools` | Optional. A space-separated string |

The version number, the required capabilities and the requirements on the base part are all written in the manifest, not in the frontmatter.

**YAML syntax that can be read**: we do not bring in a YAML library, and read only a subset that is enough: at the top level "field name: value"; a value may be a plain scalar, a single- or double-quoted scalar (may span lines), or a block scalar (`|` and `>` with `-` or `+`); a mapping such as `metadata` accepts only one level of indentation; a `#` on a whole line or at the end of a line is a comment. All scalars are read as strings, with no type inference; a plain scalar that YAML would read as a number, boolean, null or date (for example `version: 1.0`) is required to be quoted, because the specification wants a string and different YAML implementations read it differently. Flow-style `{…}`, `[…]`, block sequences, anchors, aliases, tags and nested mappings are explicitly rejected. Advice to third parties: write every value in the frontmatter as a double-quoted string, which is the most robust. The reason for each rejection is written in the file header of `protocol/lib/skill-md.mjs`.

**SKILL.md of the role part** must make clear: whose voice this is, what it can be used for, which version of the base part it needs, how to complete it when there is none, and how to make a new pack from it; the body is the dubbing guidance. The skeleton generated at packing time (`buildRoleSkillMd`) has these sections:

1. An opening paragraph: whose pack this is, and that it is to be used together with the base part;
2. "这是谁的声音" (Whose voice this is): the name, the pack ID, the version, how many segments the reference set has, the default reference segment (if the manifest has `languageDefaults`, followed by the default segment of each other language); when the manifest has sample lines, one more line: how many there are, and that they are in the manifest's `sampleLines`;
3. "能拿来做什么" (What it can be used for): a table of the required capabilities of each feature, and the key points for putting it into an environment, dubbing, and writing scripts (writing scripts: write emotion and style as cues in square brackets, pointing to the step in the base part's `references/dub.md` that covers cues); when reference segments carry reference tags, one more item: list the tags by language, say clearly which segment is used when none is named (if a setup has written `referenceTag`, first the one written by the chosen setup, then the default segment of this line's language), and how to switch the reference (the exception described in the paragraph "The skeleton does not write base-part command-line commands and options" below); when the pack has enhancers, scripts or a voice conversion feature, a few more items;
4. "需要哪个版本的基础部分" (Which version of the base part it needs): the protocol major version, the minimum version, the version used when the pack was made;
5. "没有基础部分时怎么补全" (Completing the pack when the base part is missing): when to complete, which command to run, what each step does, and several common errors;
6. "怎么做新包" (How to make a new pack): the new pack uses a new pack ID; first use the base part's command to generate the clean room input, and hand it to a new session or sub-agent that cannot see this pack to write the text (the current agent, which has read this pack, does not write it), then hand this pack to the make-pack command as the source pack, make the pack and run the duplicate check; the agent that makes the pack gets only the abstract specification in the protocol core and does not read this pack's role content;
7. "配音指引" (dubbing guidance): the body written by the author; it may describe tone, rhythm, emotion, catchphrases, how to speak in different scenes, writing only the effect wanted and not the instruction syntax of any one model. It may be divided into five subsections, see "The five subsections of the dubbing guidance" below.

Sections 5 and 6 describe steps that have been made to work: completion uses `node protocol/cli.mjs complete .` (the rules are in this file's "Completing a pack" section); the procedure for making a new pack, who can see what, how each field is written, and what the duplicate check compares are authoritatively in `new-pack/README.md` (and the blank template and task description next to it). The skeleton has no placeholders left to fill in: only the "配音指引" section, before the author writes it, is a hint paragraph (the English skeleton puts nothing there, see "Language of the skeleton" below). The frontmatter `name` equals the pack ID, `description` has one Chinese and one English paragraph in the Chinese skeleton and only one English paragraph in the English skeleton, and `compatibility` states the required base part version and the required capabilities.

**The skeleton does not write base-part command-line commands and options** (the ones for putting into an environment, dubbing, voice conversion, making a pack, the clean room): the command line belongs to the base part, and once it changes an option, the usage written in the protocol core is wrong, and the protocol core would have to be released with a new version too. The skeleton (and the share file's `README.md`) only points to the base part's `SKILL.md`: how the commands are written and what options they have is written in one place only, there. The protocol core's own commands (`seal`, `pack`, `unpack`, `check`, `complete`, `keygen`, `sign`, `verify`, see `README.md`「Command line」) are not subject to this rule and are written out as they are. No file of the protocol core contains options that exist only in the base part's command line, with one exception: dubbing's `--reference-tag`. The skeleton lists this pack's reference tags by language, and the agent reading the skeleton must know what to do with these tags (use them to switch the reference; a cue in a script does not switch the reference); pointing only to the base part's `SKILL.md` cannot make this clear, and it would think that writing a cue switches the reference; this option appeared together with the reference tag in 3.0 (section 14), and if the base part changes it, the protocol core must change with it, so it is written only in this one place in the skeleton (`protocol/lib/skill-md.mjs`) and in this paragraph.

**Language of the skeleton**: the skeleton has two ways of being written, Chinese (the default) and English, chosen by the caller according to the author's language: `textLanguage` of `buildRoleSkillMd` and `packRolePart` (`'zh'` or `'en'`; any other value throws `TypeError`), and `--text-language` of the `seal` command line; if not given it is Chinese. An app may pass the interface language the author used when making the pack (the default text written into the pack is all written in the author's language). The two versions have the same layout: the same sections, the same steps, the same commands, file names and error codes, and only the language of the headings and the explanations differs; the frontmatter of the English skeleton is also English only. The correspondence of section headings is as follows. Programs and people reading the skeleton must not look for content by the words of a section heading (an English pack has no Chinese headings); what to look for is the line described below.

| 中文骨架 | 英文骨架 |
|---|---|
| 这是谁的声音 | Whose voice this is |
| 能拿来做什么 | What it can be used for |
| 需要哪个版本的基础部分 | Which version of the base part it needs |
| 没有基础部分时怎么补全 | Completing the pack when the base part is missing |
| 怎么做新包 | How to make a new pack |
| 配音指引 | `## 配音指引`, not translated, the same in both skeletons |

**The line "## 配音指引" is a protocol marker; write it as is in every language, do not translate**, like a JSON key name. Reading back the guidance the author wrote relies on it: `extractGuidance` (`protocol/lib/skill-md.mjs`) and the rule in the base part that reads the guidance when dubbing both recognise this whole line, and take everything after it up to the end of the file. The base parts already released (from 1.0.0) recognise only this line; if an English pack used another heading, they would not find the guidance when reading an English pack, a new pack would have to require a higher minimum base part version, and versions already sent out cannot be recalled. Written as an untranslated marker, the guidance read back is the same for a pack in any language and a base part of any version, with no protocol change and no need to set a higher minimum version for English packs. Two points follow:

- The English skeleton, when it needs to say "what the last section is", writes it above this line (that paragraph names this line, says it is not translated, and says that what follows is the author's guidance): written below it, it would be read back as guidance. That paragraph must not put itself on a line of its own that looks like this line.
- When the author has not written guidance: the Chinese skeleton puts a hint paragraph below this line (`GUIDANCE_HINT`; the program that reads the guidance treats it as not written and gives `null`); the English skeleton puts nothing below it (an English hint paragraph would not be recognised by 1.0.0 and would be taken as guidance the author wrote). The words of `GUIDANCE_HINT` must not be changed, because older versions would no longer recognise it.

For Chinese and English packs, the guidance read back by base part 1.0.0 (already released), by the current reading, and by the path that reads guidance when dubbing is exactly the same, and a pack with no guidance reads back `null`.

**The five subsections of the dubbing guidance**: the guidance (the body under `## 配音指引`) may be divided into five subsections; as far as the format is concerned all five are optional (which ones making a pack requires is in the base part's `references/make-pack.md`), and the subsection names follow the rule of "## 配音指引": they are not translated and are written as they are in every language:

- `### 这个人是谁` (who this person is): identity, personality, what they care about, toward different people, when emotions run high (5 items);
- `### 音色` (voice): what this voice sounds like;
- `### 演法` (how to perform): how to speak: throat position, tight or loose, breathy, hoarse, speaking rate, pauses, laughing and sighing (7 items);
- `### 台词` (lines): what to say and how to word it: self-reference, sentence endings, catchphrases, word choice, dialect (5 items);
- `### 换语言时怎么说` (what to say when switching language): the name, self-reference and catchphrases in other languages (3 items).

Each feature may be followed by its source (an original sentence or a narrated passage from the material); one without a source, inferred from the type of character, is marked as inference; an item of "这个人是谁" or "换语言时怎么说" that has no basis is written as `缺` (missing). Old guidance without these five subsections stays valid as before. Reading back (`extractGuidance`) still gives the whole passage and does not split it into subsections; the check (`check`) does not report an error for missing subsections.

What is handed to the dubbing model is decided by `guidanceForModel(guidance)` in `protocol/lib/guidance-sections.mjs` (an app that still hands over guidance has, in its own bundled adapter, a line-for-line identical mirror, in that adapter's `limits.mjs`: it is outside the base part, is not released with the base part, and is not the protocol core's `lib/limits.mjs` (unpacking limits); that app and adapter use that copy, the same input gives the same result, and a comparison test on their side pins it). If the guidance contains any one of the five subsections ("### 这个人是谁", "### 音色", "### 演法", "### 台词", "### 换语言时怎么说"), it is the new style: only the body of the "### 演法" subsection is handed over (up to the next `##` or `###` heading); if there is no 演法 subsection, or it is empty, no guidance at all is handed over. If none of the five subsections is present, it is the old style: the whole passage is handed over as before. The four subsections other than 演法 are for the person writing the script and are not "how to speak" for the model. The base part's dubbing (`lib/dub.mjs`) does not hand over guidance: the person writing the script writes the 演法 into the script as cues (`references/dub.md`); this rule governs programs that still hand over guidance.

## 6. Pack ID

The form is `<short English name>-<8 random characters>`, for example `mira-k3x9q2vd`.

- Follow Agent Skills' restrictions on `name`: only lowercase letters, digits and hyphens, at most 64 characters, not starting or ending with a hyphen, no two consecutive hyphens (so the short English name is at most 55 characters).
- The short English name is given by the author; if nothing is left after cleaning up, use `vp`. The way of cleaning up: Unicode compatibility decomposition (NFKD), lowercase, replace each run of characters that are not letters or digits with a single hyphen, and strip hyphens from the start and end.
- The 8 random characters are lowercase letters and digits (36 characters), generated by the platform's `crypto.getRandomValues`. Bytes of 252 and above are discarded and drawn again (252 is the largest multiple of 36 that does not exceed 256), so that the first few characters do not appear a little more often.
- Generated when the pack is made, and not changed afterwards. Kept when a new version is published. An improvement to the same character keeps it; when a new pack is made from a pack, a new one is used.
- Uniqueness is not guaranteed by the format: 8 random characters give 36^8 ≈ 2.8×10^12 possibilities, so the probability that two independently generated packs collide is negligible; the community server has accounts and publishing rules on top of that.

## 7. Audio

For the audio in the reference set, the held-out recordings and the audition line, the format is judged by content, not only by extension.

**Allowed formats**

| Format | Extension | Content requirement |
|---|---|---|
| wav | `.wav` | RIFF/WAVE, with a `fmt ` chunk and a `data` chunk (PCM, floating point and others, any encoding) |
| mp3 | `.mp3` | MPEG audio layers 1, 2 and 3, with a valid frame header and with the next frame connecting (may carry an ID3v2 header and an ID3v1 trailer) |
| flac | `.flac` | Starts with `fLaC` and carries STREAMINFO |
| ogg | `.ogg`, `.opus` | Ogg container, the first page passes page verification, and the content is Opus or Vorbis |
| m4a | `.m4a` | MP4 container with `moov`, and every track is audio (AAC and ALAC are both fine; one with a video track does not count) |

These are the formats that reference sets and held-out recordings actually use. The rest (AIFF, raw AAC streams, WMA, AMR, WebM...) are not accepted: each additional format accepted means one more parser that has to be written correctly in the check. This trade-off is a judgement, not a measured conclusion; playback has not been tested one by one in browsers.

**How the judgement is made**: only the first few hundred bytes of the file are looked at (for M4A, the headers of the top-level boxes), and the structure of the container is recognised, not only the magic number in the first four bytes. Random data, an executable renamed with another extension, and text that happens to form a magic number cannot pass. It does not decode, so what is recognised is only "looks like this kind of audio", with no guarantee that it plays. The recognition rules were verified against real encoder output: with ffmpeg 8.1 we generated wav, mp3 (with and without Xing and ID3), flac, ogg (Vorbis and Opus), and m4a (AAC, ALAC, with and without faststart), and all were recognised; raw ADTS AAC streams and MP4 with a video track are correctly not recognised.

**What the check reports**:

- The extension says audio but the content is not (or is another kind of audio); the content is audio but the extension is not an audio one: `audio_disguised`.
- The extension is a recognised audio format but is not in the table above: `audio_format_not_allowed`.
- A file that the manifest marks as audio (the `audio` of a reference segment, a held-out recording, the audition line) must also have an extension from the table above.

This check is done on every file a part governs, not only those in the reference set.

## 8. Share file

### 8.1 File name and layout

The file name is `<name>.voicepack.zip`, and the result is always a valid single path segment (it passes the rules of the "Paths" section). Characters in the name that the file system does not allow (`/ \ : * ? " < > |`, control characters and so on, the same set as `control_char` in the "Paths" section) are replaced with hyphens, and consecutive ones become one; whitespace, dots and hyphens at the start and end are removed; the name part is at most 100 UTF-8 bytes, without cutting a character in half; if what comes before the first dot is a Windows reserved device name, a hyphen is added after it (`con.voicepack.zip` is a device on Windows); if nothing is left, use the pack ID, and failing that, `voicepack`. The file name is only for people and file managers to look at, and a reader does not use it to tell the type.

The content is an ordinary zip, with these at the root, in this order:

1. `mimetype`: the type identifier, the first entry, not compressed;
2. The pack directory: for a full pack or a pack with only the role part, the directory name is the pack ID; for a pack with only the base part, the directory name is the base part's directory name (`voice-pack` for 2.x and 3.x, `cohub-voice-studio` for 1.x);
3. `index.html`: the preview card, which may be absent;
4. `README.md`: the explanation for people and agents.

The root may have only these: one pack directory, plus the three files `mimetype`, `index.html` and `README.md`; any other file or directory is not accepted. `README.md` is required. The name of the pack directory must equal the pack ID (role part) or the base part directory name of this protocol version (base part, the table in section 13). The protocol core is not shared separately.

`README.md` and `index.html` are generated at packing time, are not listed in any manifest, and do not count as files in the pack directory. `README.md` is an introduction with one Chinese and one English copy, how to open the preview card, how to import it in the app, and how to use it in an agent environment; the person packing may replace it with their own. `index.html` is the preview card, and its content is decided by the program that generates it (the official generating program is `lib/preview-card.mjs`; what is on the card and how it is kept self-contained are written in one place only, its file header); a reader treats it only as an opaque file, does not execute it, and does not use it for any validation.

### 8.2 Media type

The first entry is called `mimetype`, and its content is the type identifier for this file's protocol major version (US-ASCII, no newline, no leading or trailing whitespace, no byte order mark), not compressed, with no extra field in the local header:

| Protocol major version | Type identifier | Bytes |
|---|---|---|
| 2, 3 | `application/vnd.voice-pack+zip` | 30 |
| 1 | `application/vnd.cohub.voicepack+zip` | 35 |

So the start of the file is fixed (the table below takes 2.x and 3.x as the example; for 1.x only the last row and the total length differ):

| Offset | Content |
|---|---|
| 0 | `50 4B 03 04` (the zip local header signature) |
| 8 | `00 00` (compression method 0: stored) |
| 26 | `08 00` (file name length 8) |
| 28 | `00 00` (extra field length 0) |
| 30 | `mimetype` |
| 38 | `application/vnd.voice-pack+zip` (1.x: `application/vnd.cohub.voicepack+zip`) |

Reading the first 73 bytes is enough to recognise that this is a voice pack, and whether it uses the 1.x type identifier or the one shared by 2.x and 3.x (2.x and 3.x cannot be told apart from this; look at `protocol` in the manifest, section 14, "Telling versions apart"), without decompressing and without reading the zip's directory (`isShareFile`, `detectShareMime`): the type identifier of 2.x and 3.x is short and the first 68 bytes are enough, and reading 73 bytes recognises both. The type identifier must match the pack's protocol version (sections 13 and 14).

The approach follows EPUB. Basis (the original text of W3C EPUB 3.3, retrieved and checked 2026-10-14): section 4.3.3 requires `mimetype` to be the first file in the zip, with the content `application/epub+zip` (US-ASCII, no leading or trailing whitespace, not starting with U+FEFF), which must not be compressed or encrypted and must carry no extra field in the zip header; appendix I.2 states that the magic number is `PK 0x03 0x04` at offset 0, `mimetype` at offset 30, and `application/epub+zip` at offset 38. Our offsets are the same as its.

"First entry" is counted by its position in the file, not by the order in the zip's central directory: the order in the central directory may differ from the actual order in the file, and the two ways of reading give different "first entries"; the first few dozen bytes recognise only the actual position in the file.

The type names `application/vnd.voice-pack+zip` and `application/vnd.cohub.voicepack+zip`: `+zip` is a structured syntax suffix, and RFC 6839 section 3.6 (checked against the original text) states that it may be used after any media type whose "representation is consistent with `application/zip`". Neither of these two types is registered with IANA, and they serve only as the share file's type identifier, not as media types for the wider internet.

### 8.3 How a zip is written

The zip written by our writer (`protocol/lib/zip-write.mjs`):

- All entries are stored (not compressed);
- Entries are written in the given order: `mimetype`, then the files in the pack directory in UTF-8 byte order of the path, then `index.html` (if there is one), and finally `README.md`;
- Fixed fields: timestamp 1980-01-01 00:00:00, creator Unix, version 2.0, permissions 0644, file names in UTF-8 with the UTF-8 flag set, no extra fields or comments, no data descriptors, no directory entries, no zip64;
- The same input writes the same bytes: the same in Node, Bun and the browser (because the bytes are decided by the input alone).

**Why not compress** (the reasons for choosing stored over deflate):

1. The compressed bytes depend on the runtime's zlib and differ between runtimes, so there is no way to make "same content, same zip bytes" hold in the browser, Node and Bun. Direct measurement (2026-10-14): for the same 42,000-byte input, Node 24.14.0's `CompressionStream('deflate-raw')` produces 628 bytes and Bun 1.4.0 produces 680 bytes, and the two differ in bytes. A stored entry does not depend on the runtime. The hashes in the manifest are computed over the original bytes, so compression or not does not affect validation; what it affects is the bytes of the zip file itself, and at release time the base part's zip is signed and its bytes are compared with the files already released (`SIGNATURES.md`), so they must be stable.
2. The bulk of a pack is audio: mp3, ogg/opus, flac and m4a are already compressed and compressing again saves nothing; how much deflate saves on wav depends on the content, it has not been tested with real human voices, and the estimate is ten to twenty percent (estimate, not measured).
3. The extra size from not compressing the text part is limited. Direct measurement (2026-10-14, the base part after the official small tools and the signature module were merged): the base part's 78 files total 602,796 bytes, 247,823 bytes after compressing each with `node:zlib` deflate (level 6), so not compressing adds 354,973 bytes (58.9%); a full pack with 3 audio segments (126 files, 955,679 bytes in total, containing two copies of the protocol core and one base part) is 394,933 bytes after compressing each, and not compressing adds 560,746 bytes, about 0.56 MB. Relative to a pack with dozens of audio segments (several MB), that is a small number.
4. Writing does not depend on the platform's compression API, so older browsers can pack too.

The cost is that the zip is somewhat larger than a compressed one: downloading a base part is about 350 KB more. If compression is wanted later, a deterministic deflate has to be implemented ourselves to keep the bytes identical, and it is not worth it now.

### 8.4 How a zip is read

A reader accepts zips made by other tools and does not require them to be written by us: entries may be stored or deflate (compression methods 0 and 8), and may carry data descriptors. Rejected, and named:

- zip64 (65535 or more entries, or a file over 4 GiB), multi-volume, encrypted, other compression methods;
- Structurally self-contradictory zips: the local header and the central directory disagree on the name, compression method, CRC or size; the data areas of entries overlap (one piece of compressed data shared by several hundred entries is the way a zip bomb is written); there are extra bytes before the first entry; the end record disagrees with the position of the central directory or with the number of entries;
- The extracted size exceeds what the header declares, or the CRC-32 does not match;
- A name that is not valid UTF-8 (whether or not the UTF-8 flag is set, one that decodes as UTF-8 is accepted); a name that fails the check of the "Paths" section; a name conflict.

The declared size cannot be trusted: a deflate entry is counted as it is extracted, and stops at once when it exceeds the size declared in the header, without finishing the extraction. The reason for each rejection is written in the file headers of `protocol/lib/zip-structure.mjs` and `zip-read.mjs`. Directory entries (names ending in `/`) are ignored, but their names are still checked. A reader must not splice a member name into a path directly.

**Symbolic links**: the high 16 bits of an entry's external attributes (the external file attributes in the central directory) are the Unix `st_mode`, and `st_mode & 0o170000 == 0o120000` is a symbolic link. We verified this convention for real by making a zip with a symbolic link using bsdtar 3.8.8: the high 16 bits of the entry `link.txt` are `0o120666`. The "creator" byte is not looked at: in a zip written by another system the high 16 bits may also be a Unix mode, and a symbolic link, when seen, is rejected. Device files, pipes and the like are also rejected. When reading a directory to pack it, a symbolic link (including a Windows directory junction) likewise reports an error and is not followed.

## 9. Unpacking limits

| Item | Limit | Who exceeds it is rejected |
|---|---|---|
| Number of members | 1024 | The number of members in the zip (judged as soon as the end record is read, without reading further); when checking a directory, the number of files in the directory |
| One member | 256 MiB (268,435,456 bytes) | Judged by the size declared in the header; a deflate entry is cut off again by the actual byte count during extraction |
| Total size | 512 MiB (536,870,912 bytes) | The sizes of all members added together; a zip file that is itself larger than "the total limit plus the header allowance for each member" is not read either |
| JSON | 1 MiB (1,048,576 bytes) | A member that is to be parsed as JSON, currently the manifest; judged before reading |

A pack over a limit is not hashed: the number of members, the size of one member and the total size are the first step of the check, and if one is exceeded it stops, and the report has only this item.

**Where the numbers come from and why**

- The starting point is the safe unpacking of upstream VoiceStudio (debpalash/VoiceStudio): in `backend/core/safe_archive.py`, `MAX_MEMBERS = 64`, `MAX_MEMBER_BYTES = 256 * 1024 * 1024`, `MAX_TOTAL_BYTES = 512 * 1024 * 1024`, `MAX_JSON_BYTES = 1024 * 1024` (the original text retrieved and checked through the GitHub API on 2026-10-14; upstream is AGPL-3.0, and we only referred to the values and did not copy code). The three items for one member, the total and JSON follow upstream.
- The number of members was relaxed from 64 to 1024. Upstream's 64 is the size of a single voice file (`.omnivoice`, `.ovsvoice`), and a full pack has many more files. Direct measurement (2026-10-14, on the base part after the official small tools and the signature module were merged, making a full pack with our command line): the base part's 78 files (including its own manifest and the protocol core's two manifests, of which the protocol core is 42), the role part's own protocol core of 42 files, plus the role part's `SKILL.md` and manifest, make the fixed part of a full pack 122 files; after an official signed release, 3 more (`.minisig`). That is, upstream's 64 cannot even hold a full pack without any audio. Add reference audio, held-out recordings and scripts, and a pack with 3 audio segments and 1 script is 126 files.
- The reason for taking 1024 is an estimate, not a measurement: the fixed part is about 125 (122 plus 3 signatures), the limit is more than 8 times that, leaving nearly 900 files for the role part, far more than an actual pack (a heavy pack, with a reference set of 200 segments and 50 held-out recordings, is only about 380 files); the base part will also gain files later (functions of the procedure layer), and this margin is enough for that: one added outside `protocol/` takes one member in a full pack, and one added inside `protocol/` takes two (a full pack has two copies of the protocol core). The number of members is judged when the end record is read, so relaxing the limit does not slow down the rejection of bad packs.
- The manifest schema allows reference segments and held-out recordings up to 500 each; that is the manifest's own parsing safety limit; if both are filled, the number of members exceeds 1024 and is rejected, and the report names too many members. To support that scale, the schema's limit and this one must be relaxed together.
- The reference implementation reads the whole zip into memory and the extracted members take another copy, so the peak is about twice the zip size; the 512 MiB total limit is upstream's value, and no separate evaluation was made for browser memory.

## 10. Check

To check one part (role part, base part, protocol core, or a full pack), a reader must do all of the following in this order, check everything that can be checked, and report everything in one go; only when the "Unpacking limits" step is exceeded does it stop first. The result of a check is a list of problems, each carrying a `code` (naming which kind of problem it is), an explanation, which part has the problem, and machine-readable details; all the `code`s and the shapes of the details are written in the file header of `protocol/lib/check.mjs` (those of mutual verification in the file header of `protocol/lib/mutual.mjs`, those of signature verification in the file headers of `protocol/lib/official.mjs` and `protocol/lib/signature.mjs`).

1. **Unpacking limit check**: the number of members, the size of one member, the total size.
2. **Path check**: the path of every member passes the rules of the "Paths" section, with no conflict.
3. **Check each part separately**, starting from the part that was passed in and going down through the sub-parts it carries (the role part carries `protocol/` and an optional `voice-pack/`, the base part carries `protocol/`), each part looking only at its own directory.
   1. The manifest exists, can be read, and is valid ("Manifest" section), and its kind and location match (`part_mismatch`); a missing `protocol/` that must be carried is reported as `part_missing`.
   2. **Files against the manifest**: listed in the manifest but not in the pack (`file_missing`); listed but with a size or SHA-256 that does not match (`file_modified`, size compared first and then hash, and `details.reason` is `size` or `sha256`); in the pack but not listed in the manifest (`file_extra`; directories left to sub-parts, the manifest itself and its signature do not count).
   3. **SKILL.md check**: the base part and the role part must have one, and it must conform ("SKILL.md" section, `skill_md_missing`, `skill_md_invalid`).
   4. **Audio check**: for every file this part governs, the extension and content match ("Audio" section).
   5. **External resources** (role part): see below.
   6. **Signature check**: record whether this part has a signature file; if the caller gave a signature verification hook (`verifySignature`), verify, see below.
4. **Mutual verification check** (done unless the caller wrote `mutual: false`): pair the role part with the base part it carries, see below.

**External resources**: each is fetched through the injected network reader (`env.fetch`), and its size and SHA-256 are checked, one by one, in the order in the manifest.

- Failing to fetch and a mismatch both report errors: the server answered but not with success (`external_fetch_failed`, with the status code in the details); the size or hash fetched differs from the manifest (`external_hash_mismatch`); reading stops when the bytes read exceed the size written in the manifest, and nothing is read if the size declared in the response header already exceeds it.
- With no network (the environment provides no `fetch`) or a network error when fetching, say "external resources cannot be verified" (`external_unverifiable`, `details.reason` is `offline` or `network`). A pack with external resources does not pass validation while offline: it must not be let through quietly.
- External resources in a manifest can only be `https://`. Network policy such as URLs not pointing into the internal network is the injected `fetch`'s business, and the check itself does not handle it.
- The make-pack procedure by default puts resources into the pack, and uses an external URL only when the author explicitly chose it.

**Signature and mutual verification**: the check itself does not implement signature verification and does not judge "whether this is an official version": the judgement is left to the signature verification hook passed in by the caller (`verifySignature`; `createSignatureVerifier(trust list)` in `lib/official.mjs` builds one). The entry points that handle things coming from outside (`checkPart`, `checkShareFile`, `inspectShareFile` in the library) **require the caller to explicitly choose a signature policy**: give a signature verification hook, or explicitly write `allowUnsigned: true` (lets through only a part with no signature file, for local development and tests); giving neither throws `signature_policy_missing`, before any input is read, so that if some place forgets to pass it, a non-official base part or protocol core is not quietly let in. Mutual verification is done by default at these entry points, and is skipped only when `mutual: false` is written. When the library internally checks something it has just made (the self-check of the role part when making a pack, `seal`'s check of the part being sealed), it does not verify signatures and does not do mutual verification, and goes through another entry point, `selfCheckPart`, which needs no policy. The command lines `check`, `pack` and `unpack` always have both on; for usage see `README.md`「Command line」; how each entry point is chosen, the combinations of options, and how each caller (an app that embeds the library, completion, a server that receives share files) passes them are in `SIGNATURES.md`「Wiring into the check」.

- **Signature verification**: next to the manifests of the base part and the protocol core (a full pack has two copies) there must be a `manifest.json.minisig`, signed by a public key in the trust list, and what is signed is the bytes of that manifest; anything not officially signed is rejected. The role part is not verified (the author's identity is left to community accounts). The result is recorded in the report's `signatures`, one entry per part: `verified` is `true` (verified), `false` (verified and failed), `null` (not verified); when not verified, `skipped` gives the reason (`role`: the role part is not verified; `unsigned`: there is no signature file and the caller chose to let it through); for one that was verified, which key signed it is recorded (`keyId`). Problems that fail include `signature_missing`, `signature_invalid`, `signature_untrusted_key` and others. How the trust list comes about, the commands and all the `code`s are in `SIGNATURES.md`.
- **Mutual verification of the pack**: pair the role part with the base part it carries. A pack with only the role part and no base part cannot do it, and the report's `mutual` is `{ checked: false, reason }` with the reason given (`no_base`: there is no base part; `no_role`: what was passed in is a base part or a protocol core; `not_reached`: the manifest could not be read or the unpacking limit was exceeded, and the check did not get to this step; `not_requested`: the caller wrote `mutual: false`). When done it is `{ checked: true }`. Three things are checked, each with its own `code`:
  1. Protocol major version compatible: the role part's `requires.protocolMajor` equals the base part's protocol major version, and the minor version does not matter (`protocol_incompatible`).
  2. The base part is new enough: the base part's version is not lower than `requires.baseMin`, compared in semantic version order, where a pre-release is lower than the corresponding release and build metadata does not take part (`base_too_old`).
  3. Required capabilities: the required capabilities of every feature are all in the base part's capability vocabulary `vocab/capabilities.json` (`capability_unknown`, each missing capability reported once, with all the features that need it listed); a vocabulary that cannot be read reports `capability_vocabulary_invalid`. If the vocabulary file itself is missing or modified, that is the `file_missing` or `file_modified` of the hash step, not repeated here, and content with no manifest backing it is not used for the comparison.

  The "content" item (at least one reference audio and its matching text) is the manifest's own rule, see "Semantic rules" item 10, and is not here. The "integrity" item (every file agrees with the hash in the manifest) is done by each part separately in step 3 above.

**What the check does not do**: it does not verify the author's identity (left to community accounts); it does not check the content of scripts (the runtime environment fully trusts scripts, with no isolation and no permission limits, and safety rests on community review); it does not decode audio and does not guarantee it plays; it does not judge whether a pack "sounds good" (fidelity is another matter).

## 11. Completing a pack

When a pack with only the role part enters an environment that has no usable base part, it must first be completed and become a full pack (the term "complete"). The procedure for completing is in the base part and is not format; but "which version completion fetches" interprets `requires` in the manifest, and a third party doing completion must fetch the same version as here, so the rule and its reasons are written here. The program is in `protocol/lib/complete.mjs` (procedure) and `protocol/lib/base-choice.mjs` (judgement), and the command is `node protocol/cli.mjs complete <pack directory>` (`README.md`「Command line」).

**Availability**: a base part already in the environment is usable only if all three conditions hold; if there is a usable one, use it directly, do not complete, do not go online, and do not write a single byte.

1. Official version: the signatures next to the base part's manifest and the protocol core's manifest inside it (two manifests) were both signed by a public key in the trust list;
2. Protocol compatible: the protocol major version equals the role part's `requires.protocolMajor`;
3. Version sufficient: the version is not lower than the role part's `requires.baseMin`, compared in semantic version order.

To judge the one already in the environment, only the signatures of these two manifests are verified, and the hashes are not recomputed file by file: each part is checked only once, when it enters the environment, and is not rechecked after it has come in. The version and protocol version written in the manifest are compared only after the signature has been verified. The locations are searched in this order: the pack's own `voice-pack/` (if usable, it is a full pack and nothing is done; if not usable, report an error and do not overwrite), the `voice-pack/` in the same skill directory as the pack, the project's `.agents/skills/voice-pack/`, the project's `.claude/skills/voice-pack/`; the first usable one is used.

**Which version to fetch**: in the version index at the official address (`RELEASES.md`), among the versions that satisfy all four conditions below, the one with the highest version number:

- Not lower than `requires.baseMin`;
- In the same major version as `requires.baseMin`, that is, the semantic version `^baseMin`; for a major version of 0 the range is tighter (`^0.2.3` goes only up to `0.2.x`, and `^0.0.3` is only `0.0.3` itself);
- The major version of the `protocol` of this entry in the index equals `requires.protocolMajor`;
- Not a pre-release; when `baseMin` itself is a pre-release, pre-releases of the same "major.minor.patch" are the exception (`^1.2.3-beta.2` allows `1.2.3-beta.4` and does not allow `1.2.4-beta.2`).

For how ranges are written and the details of 0.x and pre-releases, follow node-semver's "Caret Ranges" (<https://github.com/npm/node-semver#caret-ranges-123-025-004>, retrieved and checked 2026-10-15).

Reasons:

- **Take the highest, not exactly equal to `baseMin`, and not the latest regardless of major version**. `baseMin` means "compatible upward from the version used when the pack was made". Semantic versioning specifies that a backward-compatible fix only increases the patch number, adding backward-compatible functionality only increases the minor number, and only an incompatible change increases the major number (https://semver.org/ items 6, 7 and 8, retrieved and checked 2026-10-15). So everything upward within the same major version is compatible, a new version carries fixes, and there is no reason to download an old one on purpose; only a change of major version may be incompatible, and a pack made for 1.x should not get 2.0.0.
- **The protocol major version is known from `protocol` in the index, so there is no need to download first and then find it incompatible**. If what the index says does not match the base part's manifest in the zip, it is checked after download, and a mismatch reports an error (`RELEASES.md`「How to fetch a version」).
- **Pre-release versions are not fetched automatically**: semantic versioning says a pre-release indicates the version is unstable and might not satisfy the intended compatibility requirements (same source, item 9); a version that has not finished being released should not be quietly used.

**No matching version**: report "the required version does not exist" (`base_version_unavailable`), stating what is required (`baseMin`, the protocol major version, the range), which versions exist at the official address, and why each was not chosen (lower than the minimum version, not in the range of `^baseMin`, pre-release, incompatible protocol major version); no other version is substituted. If no version has ever been released at the official address (the version index is 404), report `official_unpublished`.

**Steps**: first use a usable one in the environment; only if there is none read the version index (read with the `cb` parameter, verify the signature first and only then trust it; for a while right after a release takes effect, the index read and its signature may not match, see `RELEASES.md`「Caching」), pick one version by the rules above, fetch only the zip of this one version and its signature, check the size and SHA-256, verify the signature, and check the contents (reading the index, fetching the zip, and the checking and signature verification steps are the same code as the app's export of a full pack, in `protocol/lib/release-fetch.mjs`); after putting it into the pack's `voice-pack/`, run the check and mutual verification again on the whole pack ("Check" section), and only if it passes is completion successful. One exception: when the version index's signature was made by a key outside the trust list (the official keys were changed, and the list in the pack has only the old public key), do not trust the index and do not pick a version, but fetch `requires.baseMin` itself, reading its zip and signature directly, with the other checks as usual (the rule and reasons are in `RELEASES.md`「A lost or leaked private key」).

**No fallback**: if any step fails, report an error naming which step; do not substitute another version, do not skip signature verification, and do not leave half a `voice-pack/` behind (the command first writes everything in a temporary directory inside the pack directory, and renames only at the last step). When several packs in the same environment need different base part versions, each pack is completed into its own `voice-pack/`, and the shared copy in the environment is never changed. The `code` of each step and the shapes of the details are written in the file headers of `protocol/lib/complete.mjs` and `protocol/lib/release-fetch.mjs`.

## 12. What this format does not cover

- **Command line**: the commands that generate manifests, pack, unpack and check; their usage is in `README.md`「Command line」 section, not in the format.
- **The procedure for completing a pack**, **dubbing with a pack**, **making a new pack**: these are procedures in the base part, not format. The rule for which version completion fetches is in the "Completing a pack" section; the steps for completion, dubbing with a pack and making a new pack are already written into the three sections of the role part's `SKILL.md`「没有基础部分时怎么补全」「能拿来做什么」「怎么做新包」 (in English: Completing the pack when the base part is missing, What it can be used for, How to make a new pack); the specification for making a new pack (clean room, how fields are written, what the duplicate check compares) is in `new-pack/README.md`.
- **Official releases and signatures**: see `SIGNATURES.md`. Where official releases are put, what they are called and which versions exist: see `RELEASES.md`.
- **Capability vocabulary, design vocabulary, stage cue vocabulary, script markup**: these are the base part's vocabularies (`capabilities.json`, `design.json`, `cues.json`, `markup.json` in `vocab/`). The manifest cites the names in the first three: the capability names in `features`, `direction.tags`, and the emotion and style in a setup's `labels`. The format itself does not specify the content of the vocabularies.

## 13. What protocol version 2.0 changed, and how to read 1.x packs

2.0 changes only names, and the rest of the format (manifest fields, paths, hashes, signatures, how a zip is written, the order of the check) was not changed by a single word. The names of 1.0 carried the product name; the protocol is public, and 2.0 switched to the protocol's own names. Which protocol major version uses which set of names is written in one place, in a table in `protocol/lib/names.mjs`, and everywhere else in the programs asks it.

| Name | 1.x | 2.0 |
|---|---|---|
| The base part's directory name (section 1, 8.1), also the `name` of the base part's `SKILL.md` (section 5) | `cohub-voice-studio` | `voice-pack` |
| The file name of the officially released zip (`RELEASES.md`) | `cohub-voice-studio-<version>.voicepack.zip` | `voice-pack-<version>.voicepack.zip` |
| The type identifier of the share file (8.2) | `application/vnd.cohub.voicepack+zip` | `application/vnd.voice-pack+zip` |

The `protocol` in the manifest is written `"2.0"`; the `requires.protocolMajor` of a 2.0 role part is written 2.

**What a program writes**: which set of names a pack uses is decided by the protocol version in its manifest, and the three names are used as a set, never mixed. A 2.x program writes 2.0 for newly made packs and newly packed share files; this version writes 3.0 (section 14, "What a program writes"). Things that already have a manifest (the pack command packing an already sealed directory, official releases) take their names by the manifest's own protocol version, and the same content is packed into the same bytes.

**What a program reads**: a 2.x program recognises major versions 1 and 2 and reads no other major version (`protocol_unsupported`, with `supported` in the details); this version recognises 1, 2 and 3 (at the start of the file; `PROTOCOL_NAMES` in `protocol/lib/names.mjs`). A 1.x pack is read with the 1.x names: the results of check, signature verification, mutual verification, completion, unpacking and installing are the same as with a 1.0 program. The names must match the protocol version; if they do not, the check fails and reports `protocol_name_mismatch`; `details.item` says which item it is, `details.expected` is what this protocol version should use, and `details.actual` is what is actually there:

- `base_directory`: the role part holds the base part directory name of another protocol version (in a 2.0 pack it is called `cohub-voice-studio`, or in a 1.x pack it is called `voice-pack`), or the directory name corresponding to the protocol version of the embedded base part itself does not match the directory it is in; the pack directory name of a share file likewise;
- `media_type`: the type identifier of the share file does not match the pack's protocol version.

This way, a half-new, half-old pack is not taken as a good pack just because both sets of names are recognised.

**Complete**: when a 1.x pack with only the role part (`requires.protocolMajor` is 1) is completed, it fetches a 1.x base part: file name `cohub-voice-studio-<version>.voicepack.zip`, put into `cohub-voice-studio/`; a 2.0 pack fetches `voice-pack-<version>.voicepack.zip`, put into `voice-pack/`. In the same version index, 1.0.x and 2.0.0 may coexist, and the file name of each entry is built by that entry's own `protocol`; when the index fails verification and it falls back to fetching the minimum version directly (`RELEASES.md`「A lost or leaked private key」), the file name is built by the protocol major version the pack requires.

**A 1.0 program reading a 2.0 pack**: a 1.0 program that has already been sent out does not change, and it rejects a 2.0 pack and does not guess its way through reading it. The measured result (2026-10-20) of checking a 2.0 pack with the already released 1.0.9 (base part) program:

- Share file: `share_not_voicepack`, saying that the content of `mimetype` should be `application/vnd.cohub.voicepack+zip` (it recognises only the 1.x type identifier);
- Pack directory: `protocol_unsupported`, saying the manifest was written for protocol 2.0 and only major version 1 is recognised.

To read a 2.0 pack, first update the base part to a version after 2.0.

## 14. Protocol version 3.0: a new major version not compatible with 2.x

3.0 is a new major version: the fields, vocabularies and commands in the format may be changed and may be removed, old packs are not migrated, and no compatibility is written for the 2.x format. Which part of the format changed is changed in that part's own section, and is not listed separately here. The three names of section 13 did not change: 3.x is the same as 2.x, the base part's directory is called `voice-pack`, the officially released zip is called `voice-pack-<version>.voicepack.zip`, and the type identifier is `application/vnd.voice-pack+zip`.

**What a program writes**: the packs newly made, the share files newly packed, and the versions newly released by this version of the program write 3.0; the role part's `requires.protocolMajor` is written 3.

**Telling versions apart**: the names are the same, so the directory name and type identifier alone cannot tell 2.x from 3.x; look at `protocol` in the manifest.

**New packs and the 2.x base part**: the protocol major versions do not match, and a 2.x base part is not usable for a 3.x pack (the "Protocol compatible" item in section 11; in the check, the mutual verification's `protocol_incompatible`). Completion fetches only versions whose protocol major version is 3.

**2.x packs**: they work as before. A full pack uses the base part it brings; for one with only the role part, completion picks only within the major version it requires (section 11), and even when 3.x exists at the official address it still fetches 2.x.

**Version index**: the way it is written has not changed; the index's own `protocol` is still written `"2.0"`, 3.x and 2.x versions are listed in the same index, and the `protocol` of each entry is written as that version's own protocol version (why it is not written 3.0 is in `RELEASES.md`「Official releases: official address, file layout, version index」).

**Reference segments are written differently**: in 3.0, reference segments and held-out recordings write the language on the segment's own `language`, and a reference segment has in addition a required reference tag `tag` (4.4); the `tags` of 2.x (language, plus emotion, style and energy) was removed. The protocol core of this version can still read the manifests of 1.x and 2.x, and when checking: for a role part whose manifest's protocol major version is less than 3, segments are checked in the old way (`tags` required, `tags.language` required, emotion, style and energy optional), and the `tag` and `annotatedText` on segments, which exist only from 3.0, are treated as unrecognised fields and are not checked (the `tag` and `annotatedText` halves of item 10, and items 16 and 17); fields other than segments are all checked by the 3.0 rules. The new program writes no compatibility for the 2.x format, so when this version checks the manifests of 1.x and 2.x, its conclusion is not necessarily the same as that of 1.x and 2.x programs: if a field that exists only from 3.0 is written wrongly, this version reports it and old programs ignore it; for rules that 3.0 removed (for example those on scene tags), this version does not check them. The "same as with a 1.0 program" that section 13 "What a program reads" speaks of is a 2.x program reading a 1.x pack. The base part's programs (making a pack, dubbing, voice conversion) read only the 3.x way of writing and not the old one.

**A 2.x program reading a 3.0 pack**: rejected, and no guessing at reading. The measured result (2026-11-05) of reading what this version writes with the already released 2.7.0 (base part) program: the manifest reports `protocol_unsupported`, saying the manifest was written for protocol 3.0 and only major versions 1.x and 2.x are recognised; the protocol 3.0 version index likewise reports `protocol_unsupported`. To read a 3.0 pack, first change the base part to 3.x.
