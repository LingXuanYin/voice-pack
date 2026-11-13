# Base part (voice-pack)

The part of a voice pack that does not depend on a character: the general flows, the protocol core, the vocabularies and the environment adapter layer (the layer where all adapters live). It is a standard Agent Skill directory: the directory name is the skill name `voice-pack`, and the entry point is `SKILL.md`. It can be placed on its own in a runtime environment, or as a subdirectory inside a full pack. The license is Apache-2.0, with the full text in `LICENSE`.

## Installation

The public repository is `LingXuanYin/voice-pack` (public), and `main` is in an installable state; each version is one commit and one tag `v<version>`, and what each version changed is in `CHANGELOG.md`. There are two ways to install, and both give the same skill directory:

- **Other agents** (Codex, Cursor and others; the installation is provided by `vercel-labs/skills`): `npx skills add LingXuanYin/voice-pack`. By default it installs into the current project; add `-g` to install into the user directory.
- **Claude Code**: in a session, `/plugin marketplace add LingXuanYin/voice-pack`, then `/plugin install voice-pack@voice-pack`; in a terminal it is `claude plugin marketplace add LingXuanYin/voice-pack` and `claude plugin install voice-pack@voice-pack`.

After installing, the agent reads `SKILL.md`, and the command-line entry point is `cli.mjs` in the skill directory (`node cli.mjs --help`). The requirements of the runtime environment are written in the `compatibility` of `SKILL.md`.

Both ways of installing take the files in the repository. For each version, the signed zip of the base part and the version index are at `https://lingxuanyin.github.io/voice-pack/releases/` (`official_url` in `protocol/trust.json`). The programs for completing (`complete`) and for exporting a full pack fetch the version they need from there according to the rules (`protocol/FORMAT.md` section 11), and verify the signature with the official public key; making a pack does not fetch the base part from there, and the manifest records the version of the base part that is running (or the one given by `--base-version`).

## Directory layout

```
voice-pack/
├── SKILL.md                entry point: flows are written by required capability and do not name models
├── README.md               this file
├── models/                 model notes: one file per model, the file name is the model name; they say only how to use the model itself and are not tied to a platform; when a flow or reference document needs one item from them, it writes the path and section name
├── scenes/                 scene sub-skills, one file per scene: one line in a dialogue (one-line.md), a scene with several people (a-scene.md), narration and long text (narration.md), and adult content (nsfw.md, read together with one of the first three); each says how to dub in that scene (script, cues, reference, what to say when handing back); which one to read for which situation is in the routing table at the start of SKILL.md
├── references/             references: a character's voice (character-voice.md), dubbing (dub.md, details in dub-details.md), making a pack (make-pack.md, details in make-pack-details.md and clean-room.md), script markup (markup.md); SKILL.md writes only the flow and points here
├── LICENSE                 full text of Apache-2.0
├── CHANGELOG.md            what each version changed (in Chinese and English), newest first; the top entry is the version in manifest-fields.json, and the release notes take this entry
├── manifest-fields.json    the fields of the base part's manifest other than the file list: the version number (version) and the registered runtime (ffmpeg, optional); seal --fields reads it at release
├── cli.mjs                 command-line entry point: the protocol core's commands + the flow layer's commands
├── cli/                    command-line layer: anything specific to Node may appear only here (these commands exist only when the base part is present)
│   ├── commands/           commands of the flow layer and the official small tools, one file per command: install (put into the environment), dub (dubbing), convert (voice changing and singing), make-pack (make a pack and issue a new version; with --source-pack given, it does a duplicate check against the source pack), clean-room (prepare input for the pack-making agent in a clean room), adapter (generate an adapter skeleton, check an adapter), and so on
│   ├── adapters.mjs        the single loading entry: the --adapter on the command line (an official one is given by name, others by directory or module file) all come in through here, the merge rules are written only in its file header; the skeleton generator also finds adapters through here; in the generic layers only it touches adapters/
│   ├── source-pack.mjs     reads a source pack (a directory or a share file, only for the duplicate check, with no signature verification, no network, and no sending its identifiers out), and writes the duplicate-check result as a few lines for people
│   ├── environment.mjs     the runtime environment given to the commands (the core layer's Node environment plus the machine's runtimes)
│   ├── node-runtimes.mjs   finds command-line tools such as ffmpeg on the machine's PATH and wraps them as the runtimes the library needs
│   ├── script-runtimes.mjs the runtimes needed by the scripts in a pack (node, python, etc.), run directly by the entry registered in the manifest
│   ├── pack-directory.mjs  opens a pack directory: reads the files in it on demand, does not follow symbolic links, hands it to lib/voice-pack.mjs
│   ├── audio-files.mjs     reads audio files: converts between suffix and MIME type, reads into bytes plus MIME type
│   ├── evaluation-set.mjs  how an evaluation set (the real recordings and synthesized recordings used to measure fidelity) is stored as files: make-pack writes it, fidelity reads it, and the format is written in one place only, in its file header
│   ├── fidelity-report.mjs writes the fidelity report as text for people: shared by fidelity and make-pack
│   ├── pick-text.mjs       which reference segment was used and why, written as text for people: shared by dub and convert
│   ├── dub-failures.mjs    which kind of failure a line that was not completed in the dub report is (too few characters, not retrieved, text rejected, a scene does not fit): the text output of dub and the hints of mix say what to do separately according to it
│   └── input.mjs           small functions that read input (files, standard input) and parse options
├── protocol/               protocol core: every pack carries one copy; details in protocol/README.md
│   ├── README.md           module conventions, runtime environment, errors, command line
│   ├── FORMAT.md           format specification
│   ├── schema/             JSON Schema of the manifest
│   ├── trust.json          the official public key and the official address
│   ├── new-pack/           making a new pack: the abstract specification, the task description for the pack-making agent in a clean room, a blank template (no complete example character)
│   ├── lib/                core layer programs
│   └── cli.mjs、cli/       the core layer's command line, which also runs when only the protocol core is present
├── vocab/                  vocabularies (JSON)
│   ├── capabilities.json   capability vocabulary, with a version number
│   ├── capability-signatures.md  call signatures of the required capabilities: parameters, return values, how audio is passed
│   ├── design.json         design vocabulary
│   ├── markup.json         script markup
│   ├── design-sample-lines.json  the tone and length of sample lines for a designed voice (one set each for zh and en, not to be copied into a pack as they are)
│   └── cues.json           synonyms of stage cues and of emotion and style tags (the notations recognized when reading stage cues)
├── lib/                    flow layer programs: dubbing and changing voice with a voice pack (which reference segment each line uses, the pronunciation lexicon, the dubbing guidance, enhancement parts, the scripts in a pack), making a pack (separating, cutting into segments and transcribing a long recording), measuring fidelity, the duplicate check, preparing input for the pack-making agent in a clean room; for the list see lib/README.md
├── tools/                  official small tools: script markup parsing, sentence splitting, audio quality checks, cutting a long recording into segments by energy, audio fingerprints (finding "the same recording" for the duplicate check), and so on; they only compute and use no model
└── adapters/               environment adapter layer: the layer where all adapters live. What an adapter is, how to write one and how errors are reported: the conventions are written only in adapters/README.md
    └── process/            process adapter (the only official adapter): turns capability calls into requests to the user's own program (Python, etc.), through standard input and output, one JSON per line; the process protocol is written only in adapters/process/README.md
        ├── adapter.mjs             the adapter's factory: what --adapter process --command "…" on the command line loads
        ├── adapter.json            how it looks on the command line: the parameter --command
        ├── wire.mjs                encoding of requests, parsing of responses (pure functions, run in both the browser and Node)
        ├── skeleton.mjs            the skeleton generated by adapter new --kind process (adapter.mjs plus program.py)
        └── cli/session.mjs         Node-specific: starts the program, waits for ready, matches responses by id, timeouts, shuts the program down when the command ends
```

Adapters for other runtime environments are not placed here but in their own directories, and are connected on the command line with `--adapter <directory>` (`adapters/README.md`「What an adapter is」).

## Rules

- **Model names appear only in the model notes (`models/`) and in platform adapters outside the base part**. Everywhere else in the base part (`SKILL.md`, `scenes/`, `references/`, `protocol/`, `vocab/`, `lib/`, `tools/`, `cli/`, `adapters/`) only the required-capability names from the capability vocabulary are used; to use one item from the model notes, write the path and section name of that note.
- **The generic layer names no adapter**: `protocol/`, `lib/`, `tools/` and `cli/` do not import files under `adapters/`, and the text does not mention anything specific to one adapter; adapters are used only through `cli/adapters.mjs`.
- For how libraries are written, the shape of the runtime environment and the unified errors, see `protocol/README.md`.
- Processing that needs a model (separation, watermarking, speaker similarity, transcription) is not put here and is requested from the runtime environment as a required capability. Model code and weights are not put here either.
- Every pack in a full pack carries a whole copy of the base part, so this directory holds no large files: each file is at most 256 KB.
