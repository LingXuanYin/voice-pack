# Call signatures of required capabilities

A voice pack is meant to circulate in the community for a long time and to be carried into different runtime environments. The models each environment can use differ, and they change. So a voice pack is not bound to a model: it only asks the runtime environment for the required capabilities (names and layers are in `capabilities.json`), and the runtime environment decides which model provides each one. The price is that the same pack may sound different in different environments. This file fixes the **call signature** of each capability: parameters, return value, errors. The process layer and the adapters implement it as written; do not write a separate version of each.

Each capability is written once, here. A module that uses it points to it with `@capability <capability name>` in its file header and does not copy the signature (in this skill's directory: `grep -rn "@capability " .`).

Which models each adapter maps the required capabilities to is written in the adapter's own directory (`../adapters/<name>/`). This file covers only the capabilities themselves, not models; for how to write an adapter and how it reports errors, see `../adapters/README.md`.

## General conventions

- A capability is a function: **one object parameter**, and you **`await` its return value** (a synchronous return is fine too). Field names of parameters and return values are snake_case, consistent with the parameter names `ref_audio` and `ref_text` (`modelChange` in a return value is the exception, see `../adapters/README.md`「When the model changes」).
- **Audio is always passed as bytes plus a MIME type**, written `{ bytes: Uint8Array, mimeType: 'audio/wav' }` (`protocol/lib/audio-clip.mjs`). URLs, Base64 strings and file paths are not accepted. A model that needs a URL gets the audio uploaded by the adapter itself; URLs never appear on the library's interface.
- **`model` is optional** in a return value: if the environment is willing to report which model it actually used, it reports it, and the library records it in the verification record and the fidelity report; if it does not report it, the model is treated as unknown. Fields such as `cost` belong to the runtime environment, not to the signature; the environment keeps them to itself.
  A return value of any capability may also carry **`modelChange`** (the model changed for this call). Its shape, why its field name does not follow snake_case, who reads it and what happens if it is written wrong are written only in `../adapters/README.md`「When the model changes」.
- An error a capability throws goes up unchanged (the library does not swallow it). The two kinds of error the library throws itself and how its `code` is formed are in `../protocol/README.md`「Errors」. The one exception is the "temporary service error" marked in the next item.
- **Mark transient service errors**: when a capability fails because the service had a momentary problem (upstream 5xx, gateway timeout, network error, timeout, ...), throw `VoicePackError` and write `true` in `details.transient` (put the HTTP status in `details.status` if there is one). A feature that calls a capability many times in one run (fidelity, dubbing, making a pack, transcription of a long recording) records this one failure, goes on with the rest, and the caller decides afterwards whether to redo it, instead of voiding the whole run. Do not mark errors that would fail again on a retry: missing capability, wrong parameters, 401, a returned shape that is wrong. An error that is not marked is thrown up unchanged by the library; the library never guesses from the HTTP status. How an adapter marks them is in `../adapters/README.md`「Error conventions」. The library does not retry for a capability: a retry of a billed call (creating a task, complete) may bill twice. The only exceptions are the cases in the table under 'Who uses it' in the header of `../lib/call-attempts.mjs`: transcription; picking the default segment and cue annotation (`audio-text-to-text` picks the default segment among several candidates and writes the cue annotation for a reference segment); and the trial synthesis and the audition line of making a pack (`voice-cloning`, `envForPackDub` in `../lib/make-pack-trial.mjs`; `dub` itself does not retry). In these cases, when making a pack, each segment (each item) is called at most 3 times, and only after a temporary error (why these numbers: see that file header; whether a failed call on a given environment is billed is written in that environment's adapter; an error in the blind listen is not retried here).
- **Mark a refusal tied only to this text**: when a capability refuses because of the text to be spoken (`text`) in this call, and a different text might succeed (too short or too long, a character the environment cannot handle, the provider's reaction to this sentence), throw `VoicePackError` and write `true` in `details.textRejected`; **do not mark `transient`** (sending the same text again gives the same result). The library records that segment as failed and makes the other segments as usual (dubbing, `lib/dub.mjs`). **Refusals found before the call** (the adapter's own checks: blank, too long, a character it cannot handle; the code is `capability_input_invalid`) are recorded for that line only and are not counted. **Refusals by the provider** (the code is not `capability_input_invalid`): when 3 lines in a row are refused and none has succeeded yet, dubbing stops (see the file header there; a platform saying one request cannot hold the text is not counted, see 'Does not fit in one request' under `voice-cloning` and `text-to-dialogue` below). An error without this mark goes up as before and stops the run. Errors that are the same for every line (reference, credentials, parameter shape, the description of the voice (`voice_prompt`)) are not marked: another line would get the same error, so the run must stop. How an adapter marks it is in `../adapters/README.md`「Error conventions」.
- **Mark an answer that did not end normally or is empty**: when a capability that listens to audio (`audio-text-to-text`) gets an answer that was cut off (`stopReason` is `length`), failed midway (`error`, `aborted`), or has no text, throw `VoicePackError` and write `true` in `details.unusable`, and write in `details.problem` which case it is (`stop_reason` or `text_missing`; for `stop_reason`, `details.stopReason` carries the original value). **Do not mark `transient`**: every ask costs money and may give the same result again, so this is not a "temporary service error". The library (`isUnusableAnswer` in `lib/capability-calls.mjs`) records that item as "voided" and does not retry or stop the whole run: cue annotation listens once per segment, and a segment whose answer did not end normally is recorded as `annotation_answer_unusable` (with problem, stopReason and model, `lib/segment-annotation.mjs`); an empty answer (`text_missing`) counts as a temporary error and is asked again under the retry rule; the default-segment pick is recorded as voided (`lib/default-pick.mjs`); for the blind listen, see the `audio-text-to-text` section below. An error without this mark goes up as usual. How an adapter marks it is in `../adapters/README.md`「Error conventions」 item 8.
- **Mark a result finished on the service side but not retrieved**: when the work of a capability is already done on the service side and already billed, but fetching the result failed (for example the generated audio cannot be downloaded, and the adapter already retried what it should retry), throw `VoicePackError`, write `true` in `details.unretrieved`, and write in `details.retrieve` one sentence for a person saying how to get the result back (which command, where to fetch it, with clues such as the task number; no URL, no credentials). **Do not mark `transient`**: calling the capability again would do the work again and bill again, so this is not "a later retry will work". The library (dubbing, `lib/dub.mjs`) records that segment as failed, lists it separately as "not retrieved", does not put it into the redo command, and tells the user how to retrieve it as `details.retrieve` says; the other segments are made as usual. An error without this mark goes as before (temporary errors are marked `transient`, others go up). How an adapter marks it is in `../adapters/README.md`「Error conventions」.
- When the environment lacks a capability, it does not pretend to have it: it just does not provide the key, and a feature that needs it throws `capability_missing` and names it.

## Synthesis

### `text-to-speech`

Reads the text aloud in the environment's default voice.

```js
await env.capabilities['text-to-speech']({
  text,                  // string, required: what to say; cues in square brackets are handed to the model unchanged, see "How to read it aloud" below
})
// -> { bytes: Uint8Array, mimeType: string, model?: string }
```

### `voice-cloning`

Synthesises a new line from reference audio, so that the voice sounds like the person in the reference. By default only one reference segment is used.

```js
await env.capabilities['voice-cloning']({
  text,                  // string, required: what to say; cues in square brackets are handed to the model unchanged, see "How to read it aloud" below
  ref_audio,             // {bytes, mimeType}, or an array of them (blend, see below). Required
  ref_text,              // string, or an array of strings matching ref_audio one to one. The original text spoken in the reference audio, optional
  enhancers,             // array of enhancers, optional, see "Enhancers" below
  expressiveness,        // integer, optional: 0 to 100, how much the voice moves (higher is more varied, lower is steadier). If not given, the environment uses its own default
  seed,                  // integer, optional: 0 to 2^53−1. The same seed with the same input should give the same result as far as possible. Accepted only if the environment declares seed-in-request (see seed-in-request under "How to read it aloud" below)
})
// -> { bytes: Uint8Array, mimeType: string, model?: string, enhancers_used?: string[] }
```

- An array for `ref_audio` means **blend**; use it only when the caller explicitly asks for a blend; given one segment, only that segment is used. How to blend (equal weights or weighted) is decided by the environment; the pack passes no weights.
- `ref_text` is the verbatim transcript of the reference audio. When a reference segment has a cue annotation (`annotatedText` in the manifest: the verbatim transcript with square-bracket cues added where the way of speaking changes, for example `[laughs]呵呵，[happy]太可爱了吧。`; the Chinese words here are an example of the transcript text), dubbing hands over the cue annotation, so the model knows how this reference was spoken (`lib/dub.mjs`). An environment that cannot use it may ignore it; for an environment that cannot accept square-bracket cues, the adapter decides what to do (for example strip the cues before handing it over).
- `enhancers`: optional; the enhancers in the pack that serve this capability, see "Enhancers" below. The return value may carry one extra item, `enhancers_used`.
- `expressiveness`: optional. What happens when it is not given, the validation and errors, and when `dub` passes it are all the same as `expressiveness` of `text-to-dialogue`. An environment whose model has no such knob ignores it and says so in the environment's own notes; no extra declaration is added for it.
- `seed`: optional. The library gives it only to an environment that declares `seed-in-request` (for an environment that does not, the key is absent from the call); once declared, the environment must accept it, and the way to write it and to report an out-of-range value are the same as `seed` of `text-to-dialogue`.
- The only case where the library retries for it is making a pack: for the held-out recording of the trial synthesis and the audition line, a temporary error (`details.transient`) is retried, at most 3 calls per item, and the extra calls are written into the "cost notice" (`envForPackDub` in `../lib/make-pack-trial.mjs`); `dub` does not retry. Whether a failed call is billed is written in the adapter's notes.
- **Minimum character count**: the environment may declare the minimum number of characters this capability needs per call (`limits.minChars` of the adapter, see `../adapters/README.md`). Based on it, the library merges segments before synthesis (`lib/dub.mjs` header, step 5b), records a segment that cannot be merged as failed, and does not call the capability; the adapter does not block short text itself, and the library does not send it in. When the provider says the text is too short, it is likewise marked `details.textRejected` (see "General conventions" above), the library records that segment as failed, and the other segments are made as usual.
- **Does not fit in one request**: when the platform says the text of this line plus the reference exceeds the length one request can speak, write it as in 'Does not fit in one request' of `text-to-dialogue`: throw `VoicePackError`, `details.problem` is `too_long_for_one_request`, `details.textRejected` is `true`, **do not mark `transient`** (sent again unchanged it still does not fit). For example, in an environment where one person speaking and a scene use the same model, both capabilities may report this.
  The library does not split automatically and does not resend: dubbing (`lib/dub.mjs`) records that segment as failed and makes the other segments as usual; this concerns only the length of that segment and is not counted in the "3 refusals by the provider in a row" number in "General conventions" above. The command line says to shorten it, or to split it into two requests (see the header "text was refused" in `../cli/commands/dub.mjs`).

### `voice-design`

Designs a voice that did not exist before from a text description, and reads an audition text with it. No reference audio.

```js
await env.capabilities['voice-design']({
  text,                  // string, required: the design audition text, read with the designed voice
  voice_prompt,          // string, required: a text description of the wanted voice (gender, age, pitch, accent, timbre, ...; how to write it: `../SKILL.md` section 2「Voice design」), not the instruction syntax of any one model
})
// -> { bytes: Uint8Array, mimeType: string, model?: string }
```

- `text` and `voice_prompt` are both non-empty strings. If one is missing, is not a string, or is only whitespace, throw `VoicePackError('capability_input_invalid', original message, { details: { capability: 'voice-design', field } })`; `details.field` is `text` or `voice_prompt`; there is no `problem`.
- The return value is audio of the designed voice reading this audition text. The designed voice is not stored on its own: to use this voice elsewhere, take this audio as the reference (`ref_audio` of `voice-cloning`).
- **The environment may limit these two parameters**: a maximum number of characters, characters it cannot handle. Each adapter writes its limits itself (for example in its mapping table); if nothing is written, there is no limit. When a limit is exceeded, the adapter must throw before anything that costs money or time (connecting to the service, creating a task), must not truncate, and must not silently change the characters the caller gave: `VoicePackError('capability_input_invalid', original message, { details: { capability: 'voice-design', field, problem, … } })`. `field` is `text` or `voice_prompt` (if both have a problem, report `text` first), and `problem` has two values:
  - `too_long`: the parameter exceeds the character limit. `details.length` is how many characters it has, `details.max` is the limit. The way of counting is the one the environment states (for example counting UTF-16 units, that is `String.length`, where an emoji counts as two, the same as the provider counts).
  - `unsupported_characters`: the parameter contains characters the environment cannot handle. `details.characters` is the distinct characters among them (an array, in order of first appearance, at most 10). For example some services cannot handle code points above U+FFFF (emoji, rare Chinese characters), and one such character makes the call wait until it times out. If both problems occur, report this one first: with those characters removed, it may no longer be too long.
- This is a matter between the caller and the environment, not a service failure: the two kinds above are not marked `transient`; asking again gives the same result. When the provider itself rejects the task because of this input (for example it exceeds its limit), a retry is just as useless, so it is also not marked `transient`, even if the HTTP status the provider returned looks like a temporary error (for example some services return HTTP 502 when the description is over the limit). A real temporary service error is marked `details.transient: true` as in "General conventions".
- What to do when credentials are rejected (401) is in `../adapters/README.md`「Error conventions」. The library does not retry for it: creating a task is billed, and a retry may bill twice.

### `text-to-dialogue`

A dialogue: several speakers take turns, each speaker with a reference recording. For one speaker, use `voice-cloning`.

```js
await env.capabilities['text-to-dialogue']({
  text,                  // string, one of text and turns: the whole dialogue. Before each speaker's lines write his number {N}, N counting from 0 (see below)
  turns,                 // array, one of text and turns: each turn of a scene [{ speaker, text }] (see "A scene" below)
  speakers,              // array, required, 2 to 16 items: item N is the reference of speaker N, shaped { ref_audio, ref_text } (see below)
  expressiveness,        // integer, optional: 0 to 100, how much the voice moves (higher is more varied, lower is steadier). If not given, the environment uses its own default
  seed,                  // integer, optional: 0 to 2^53−1. The same seed with the same input should give the same result as far as possible
})
// -> { bytes: Uint8Array, mimeType: string, model?: string }
```

- `ref_audio` of `speakers[N]` is `{bytes, mimeType}` (general convention: no URLs); `ref_text` is the verbatim transcript of that reference recording, optional, and if given it is handed to the environment together with the reference; as with `voice-cloning`, when a reference segment has a cue annotation, the cue annotation is what is handed over.
- **Speaker labels**: `{N}` is written before a speaker's lines, and the text after it belongs to him until the next marker. N is written as a canonical number (no leading zeros) and is less than the number of items in `speakers`. If the text has no marker at all, or a number is out of range, throw `VoicePackError('capability_input_invalid', original message, { details: { capability, field: 'text', problem, textRejected: true } })`, with `problem` being `no_speaker_marker` or `speaker_out_of_range`: it concerns only the text of this line, and another line may succeed. Characters other than the markers (text in square brackets or round brackets, markers the environment recognises itself) are handed to the environment unchanged.
- If `speakers` has fewer than 2 items, or more than the environment's limit, throw `capability_input_invalid`, `details.field` is `speakers`, `problem` is `too_few` or `too_many`, and there is no call. An environment that limits the number of references must declare the limit as the adapter's `limits.maxSpeakers` (`../adapters/README.md`「Shape of the return value」); dubbing then splits a scene before it goes over the limit. If the limit is only written in the notes and not declared, dubbing sends a scene with more speakers, this error carries no `textRejected`, and the whole dubbing stops.
- **A scene (`turns`)**: one of `text` and `turns`; one request per scene. Each turn is `{ speaker, text }`: `speaker` is an integer from 0 to the number of items in `speakers` minus 1 (it points to item N of `speakers`), and `text` is what this turn says (a non-empty string); the cues for this turn are written inside it at the place where they take effect (see "How to read it aloud" below).
  The turns follow one another in order, and one speaker may have several turns in a row. If both `turns` and `text` are given, or `turns` is not a non-empty array, a turn is not an object, or `speaker` is not an integer, throw `capability_input_invalid` (`field` names which item, for example `turns`, `turns[1].speaker`;
  when both are given `problem` is `text_and_turns`); a `speaker` out of range (`problem` is `speaker_out_of_range`) or a turn whose text is blank additionally carries `textRejected: true`: it concerns only the text of this scene.
- `expressiveness` may be left out: if not given, the environment uses its own default (dubbing passes it only when it has a value and does not make one up: a value from the caller, or one fixed by the voice's setup or the global value, see the header "setup" of `../lib/dub.mjs`). The scale is a percentage: an integer from 0 to 100, and 50 is the platform default, that is the official sampling; decimals are not accepted, and neither is the 0-to-1 notation; converting to the model's own parameter is done once, in the environment, and written in the environment's own notes. If it is given but is not an integer from 0 to 100, throw `capability_input_invalid` (`field` is `expressiveness`; when it is a finite number but not an integer from 0 to 100 (out of range, a decimal, the 0-to-1 notation) `problem` is `out_of_range`, and when it is not a number there is no `problem`); `seed` is the same (`field` is `seed`). A blank `text` likewise throws `capability_input_invalid` (`field` is `text`, `textRejected` is true). These are errors that are the same for every line or are the caller's doing, and they are not marked `transient`.
- There are no parameters for instructions, the name of an emotion, speech rate, timbre or language: "how to say it" is written in the text (see "How to read it aloud" below). For a single speaker, use `voice-cloning`.
- The return value is one piece of audio synthesised from the whole dialogue, one audio per request: there is no audio or timestamp for each turn. The length of the text and of the reference recordings is not limited here; whatever the platform does with them is what comes back, and errors go up as the next item says.
- **Does not fit in one request**: when the platform says the text of this scene plus the references exceed the length one request can speak, throw `VoicePackError`, `details.problem` is `too_long_for_one_request`, `details.textRejected` is `true`, **do not mark `transient`** (the same text and references sent again unchanged still do not fit, even if the HTTP status the platform returned looks like a temporary error).
  The library does not split automatically and does not resend (the upstream refused it and the error goes back to the caller as it is): dubbing (`lib/dub.mjs`) records that scene as failed and says which scene and what to do (add a chapter marker in the middle of that scene, or use `scene: false`, see `scene-in-request`). If the platform states its limit for this call, the adapter puts it into `details` (for example `maxFrames`, `maxMinutes`); the library only carries it along unchanged and does not read it. The limit changes with the length of the references and the text and with queueing; it is not a fixed number, so the signature does not state it.
- Upstream errors go up as in "General conventions" (temporary errors marked `transient`; refusals of this input not marked).
- The name is the common industry name for this kind of capability.

## Listening

### `audio-text-to-text`

Listens to one or several pieces of audio and answers according to a text instruction. The blind listen, picking the default segment and cue annotation all use it.

```js
await env.capabilities['audio-text-to-text']({
  parts,                 // Array<{ text: string } | { audio: {bytes, mimeType} }>, required: text and audio alternating in order
})
// -> { text: string, model?: string }
```

- `parts` is joined in order into one request: the text is the instruction to the model, and the audio is what it is to listen to. When there are two pieces of audio, they are treated as X and Y in the order they appear in `parts`, and **no role marker is passed separately** (an `{ audio }` item holds only audio).
- `text` is the original text of the model's answer, and the library parses it itself (the blind listen requires the answer to be a JSON object, see `parseBlindAnswer` in `lib/fidelity.mjs`).
- No parameters such as temperature or maximum length are given: the environment's own defaults are used; the more stable the answers for the same audio, the better.
- A temporary error (cannot connect, HTTP 5xx, gateway timeout, network error) is marked `details.transient: true` as in "General conventions"; an error the service reports explicitly is not marked. The adapter only has to mark correctly and does not retry itself; the library does the retrying, **and only for two uses, picking the default segment and cue annotation** (`lib/default-pick.mjs`, `lib/segment-annotation.mjs`): when making a pack, each ask is made at most 3 times (cue annotation listens 3 times per segment, and each listen has its own 3 tries), only after a temporary error, waiting 5 seconds and 15 seconds before the second and third tries, and only when all 3 fail is it recorded as "not heard" (the rule is written once, in `../lib/call-attempts.mjs`, shared by the command line and the app; the "cost notice" states the maximum number of extra listens). The blind listen (two pieces of audio) is not retried on error; it is recorded as "not heard" and redone afterwards (`lib/fidelity.mjs`). A complete call may already be billed, and whether a failed complete call is billed has not been measured: the caller that writes the cost writes it for the maximum number of tries, and what the user agrees to is the upper limit; if you switch to a service that bills for a failed complete call, say so in the adapter's notes.
- **The provider blocked the answer** (the provider's content filter cut off or replaced this answer, and in the place of the answer is a sentence from the provider itself, not the model's answer): throw `VoicePackError('provider_blocked', a sentence for a person, { details: { capability: 'audio-text-to-text', provider, reply, model? } })`. `provider` is the provider's name (lower case), and `reply` is the full original text of the provider's sentence in the answer (masked: strings shaped like tokens and signed addresses removed, no other characters changed). This is the adapter's job: it recognises the provider's own wording, which provider said what is written only in the adapter, and when you switch provider you add that provider's wording there; do not hand this sentence to the library as the `text` of the answer, because the library would treat it as "not JSON". Do not mark `transient`: asking again about the same recording is blocked again, so it is not a "temporary service error", and it must not be marked as retryable. The suggested wording of the sentence for a person is "the model's provider blocked the answer for this segment (probably because the line is an existing published text), this segment does not count", and reports and the command line use it directly. The library (`lib/fidelity.mjs`, `lib/default-pick.mjs`, `lib/segment-annotation.mjs`) **recognises only the code `provider_blocked`**: that blind listen, that default-segment pick, or that segment of cue annotation is recorded as "voided" (not as "not heard", and the redo will not redo it), and the number of blocked ones is counted (`blocked`), stating that it was blocked rather than "the answer was not in the fixed format", and it enters no ratio (reading rule, item 5). Other ways of writing it (a code the capability made up) are not recognised by the library and go up as usual.
- **An answer that did not end normally or is empty** (cut off, failed midway, no text): the adapter throws its own error code, `details.problem` is `stop_reason` or `text_missing`, and `details.unusable` is `true` (how to write it: see "General conventions"; not marked `transient`). The library (`blindListen` in `lib/fidelity.mjs`) turns that blind listen into `blind_answer_unusable` and records it as "voided", not as "not heard", the redo does not redo it, and it is not counted in any ratio; the blocked count (`blocked`) counts only `provider_blocked`, and this kind is not counted in it. Cue annotation listens once per segment, and a segment whose answer did not end normally is recorded as voided, with the reason `annotation_answer_unusable`, carrying problem, stopReason and model (`lib/segment-annotation.mjs`); an empty answer (`text_missing`) counts as a temporary error and is asked again under the retry rule; that default-segment pick is likewise voided (`lib/default-pick.mjs`). Except for an empty answer in cue annotation, none of these places retries or stops the whole run.

### `automatic-speech-recognition`

Transcribes a piece of speech into text. When making a pack it provides the verbatim transcript for original voice that has no text: a long recording is cut into segments first and each is transcribed (`lib/long-recording.mjs`), and when a clip handed to the make-a-pack flow has no text, the flow transcribes it itself (`lib/make-pack-transcribe.mjs`); for cue annotation the reference is cut into speech chunks and each chunk is transcribed once (`lib/point-measure.mjs`), and if a transcription fails only that segment gets no pause and speed marks.

```js
await env.capabilities['automatic-speech-recognition']({
  audio,                 // {bytes, mimeType}, required: the piece to transcribe
  language,              // string, optional: the language this recording is in (BCP 47, for example es, zh-CN). Bring it only if the caller knows it; if not, leave the key out
})
// -> { text: string, language?: string, model?: string }
```

- `text` is the recognised text with leading and trailing whitespace removed. If nothing was recognised (silence, pure music), it is an empty string, **not an error**.
- `language` (parameter): **bring it if the caller knows the language of the recording**. The library brings it in these places: "the language of the recording" on the make-a-pack page (`input.language` of `makePack`; the clip's own `language` overrides it) and the `language` option of `prepareLongRecording`. If it is not known, leave it out and the environment listens by itself. Only the primary language is looked at: `zh-CN`, `zh_TW` and `ZH` are all `zh`; `und` (BCP 47 "undetermined") means not known, the same as leaving it out.
- **If the environment cannot recognise the language, throw an error; do not hand back garbled text**, and do not ignore `language` and recognise in another language instead: throw `VoicePackError('capability_input_invalid', original message, { details: { capability: 'automatic-speech-recognition', field: 'language', problem: 'unsupported', language } })`, where `language` is the tag the caller brought (as it is, with whitespace at both ends removed); if the environment is willing it can add `supported`: the languages it recognises (an array), for a person to read and for the caller to choose another environment. This is a matter between the caller and the environment, not a service failure: not marked `transient`, asking again gives the same result; and it must be thrown before anything that costs money or time (connecting to the service, getting a token, converting the format). The library does not swallow this error (it is not a temporary service error), and making a pack stops on it: which environment's transcription to use is decided beforehand by the caller (the app's environment), see each environment's own notes. A `language` that is not a non-empty string (a number, an empty string) is also `capability_input_invalid`, `field` is `language`, and there is no `problem`.
- `language` (return) is optional: if the environment can report the language it reports it (BCP 47, for example `en`, `zh`); if it cannot, it leaves it out, and the library treats it as unknown and recognises it from the text itself.
- One transcription handles one piece: a long recording is cut into segments first (`../tools/silence-split.mjs`); do not hand in a recording of tens of minutes whole. The longest a single transcription may be is written in each adapter's own notes.
- The return value has **no timestamps**: cutting into segments does not rely on transcription timestamps. So a long recording is cut by energy with `../tools/silence-split.mjs` (in an environment with no `voice-activity-detection`), and after cutting, each segment is transcribed, so the text matches each segment.
- The environment is responsible for the audio format: it accepts what it can take directly and converts what it cannot (for example a service that accepts only 16 kHz, mono, 16-bit WAV: other formats are converted with the environment's `ffmpeg` runtime, and if the environment has no ffmpeg it throws `runtime_missing`).
- **The audio is empty or cannot be decoded** (the bytes handed in are empty; or while converting the format, ffmpeg says it is not audio, or the conversion produced no bytes at all): throw `VoicePackError('capability_input_invalid', original message, { details: { capability: 'automatic-speech-recognition', field: 'audio', problem } })`, with `problem` being `'empty'` (empty) or `'undecodable'` (cannot be decoded). A recording that can be decoded but has nobody speaking does not count: that returns an empty string (see above). This concerns this piece of audio itself: not marked `transient`, transcribing the same piece again gives the same result. The library does not treat these two `problem` values specially; like other errors they go up unchanged: making a pack stops as a whole (`lib/make-pack-transcribe.mjs`), and transcription of a long recording also stops (`lib/long-recording.mjs`).
- Credentials rejected (401): see `../adapters/README.md`「Error conventions」.
- **The provider blocked the transcription of this segment** (content filter): throw `provider_blocked`, written as in 'The provider blocked the answer' in the `audio-text-to-text` section (`details.capability` is `automatic-speech-recognition`), not marked `transient`. Making a pack records that segment as unusable (`transcription_blocked`, `lib/make-pack-transcribe.mjs`), does not retry, makes the other segments, and does not stop the whole run; the segment-by-segment transcription of a long recording (`transcribeAll` in `lib/long-recording.mjs`) is the same: that segment is dropped and written into the note of `transcription_blocked`.
- **A blocked answer may also be reported as a transient error**: for a service where asking again about the same segment sometimes passes, the adapter may report it as a temporary error, and then it must say it was blocked: `VoicePackError(the adapter's own code, a sentence for a person, { details: { capability: 'automatic-speech-recognition', transient: true, problem: 'provider_blocked', provider?, reply? } })`. The library recognises only `transient` and `problem`: `problem` being `'provider_blocked'` means it was blocked. `provider` and `reply` are written as for the code `provider_blocked` (the provider's name, lower case; the full original text of the provider's sentence, masked), and the adapter brings them if it can recognise them: when the answer is exactly the provider's sentence, both are there; when it only knows the provider stopped and not what it said (for example the platform returned only an HTTP 502 and the only thing in the original text is the reason it stopped), they may be left out (the platform's original text is still written in the error). The library asks again as the last item of this section (temporary error) says; if it has asked the full number of times and the error of the **last** try is still like this, that segment is recorded as blocked: making a pack records it as `transcription_blocked`, with `details` being `{ error, attempts }` (a summary of the last error, how many tries), and the hint follows the wording for blocked (supply the verbatim transcript, or switch to another transcription), and does not tell the person to "redo later"; a long recording likewise drops that segment, that segment in `report.segments` is `blocked`, carrying `attempts`, and is written into the note of `transcription_blocked`. If the last try was only a temporary error (without this `problem`), it is `transcription_failed` as before. If `problem` is not written, the library treats it only as a temporary error, and after the full number of tries records `transcription_failed` with the hint to redo later, and the user will think redoing is enough.
- **The answer did not end normally** (cut off, failed midway): a half text is not handed back. For errors other than temporary errors and `provider_blocked`, the library throws them up unchanged and making a pack stops as a whole (the money for separating the vocals, cutting into segments and transcribing the earlier segments is already spent). So when asking about the same segment again would probably succeed, report it as a temporary error (marked `transient`), and the library asks again as the next item says, and after the full number of tries that segment is recorded as `transcription_failed` and the other segments are made. For example, the adapter sets an output limit on transcription and the answer is cut off at the limit, while the limit is much wider than a normal verbatim transcript: hitting it means the answer of that call was abnormal, not that the recording has too many words. The limit must leave room for invisible output (some models cannot fully turn off thinking, and even a correct answer uses a few hundred more invisible tokens), otherwise normal answers will also be cut off and asked again for nothing. If asking again gives the same result (the recording really is longer than the output limit), do not mark it.
- A temporary error (cannot connect, connection dropped, no response at some step) is marked `details.transient: true` as in "General conventions"; an error the service reports explicitly is not marked. The adapter only has to mark correctly and does not retry itself; the library does the retrying: when making a pack, each segment is transcribed at most 3 times, only after a temporary error, waiting 5 seconds and 15 seconds before the second and third tries, and only when all 3 fail is the segment unusable (the rule is written once, in `../lib/call-attempts.mjs`, shared by the command line and the app; the "cost notice" states the maximum number of extra listens). Whether a failed transcription is billed is written in the adapter's notes (a service that bills for failed transcriptions especially must write it), so that the caller can state the cost truthfully.

## Evaluation

### `speaker-verification`

Decides whether two pieces of speech are the same person and gives a speaker similarity.

```js
await env.capabilities['speaker-verification']({
  audio_a,               // {bytes, mimeType}, required
  audio_b,               // {bytes, mimeType}, required
})
// -> { similarity: number, model?: string }
```

- `similarity` is a finite number (higher means more alike). Two calls must be comparable by size: within one evaluation the same model must be used (otherwise the fidelity ratio has no meaning, and the library throws `evaluation_model_mismatch`).
- It gives only the similarity, not a conclusion on "is it the same person": how to read the ratio of similarities and the results of the blind listen is in the header "how to read this report" of `lib/fidelity.mjs`.
- **A recording has no speech to embed a voiceprint from** (too short to embed, almost silent): throw `VoicePackError('capability_input_invalid', original message, { details: { capability: 'speaker-verification', field, problem: 'no_speech' } })`, where `field` is the side that could not be embedded, `'audio_a'` or `'audio_b'`; if neither can be embedded, report `'audio_a'`. This is a matter of that recording itself, not a broken environment: not marked `transient`, computing the same recording again gives the same result. Fidelity (`lib/fidelity.mjs`) recognises only this form: the speaker similarity of that item is recorded as "could not be measured", stating which recording, it enters no ratio, the other items are measured as usual, and the whole report is still produced (reading rule, item 9). Other forms (a code the capability made up, `field` not stated) are not recognised by the library and go up as usual. The same `capability_input_invalid` plus `details.problem` form is also used by the transcription capability (`undecodable`, `empty`, `unsupported`, see the transcription section).
- One fidelity evaluation computes pairwise over N real recordings (N(N-1)/2 calls); an implementation may cache embeddings by audio content to avoid repeated computation.

## Processing long recordings

Two capabilities used in turn when the make-a-pack flow (`lib/long-recording.mjs`) processes a long recording; both are optional: if one is missing, only that step is skipped, and the report says so.

### `audio-source-separation`

Splits mixed audio into stems such as vocals and accompaniment. When making a pack, the vocals in the recording are separated first, and then cut into segments.

```js
await env.capabilities['audio-source-separation']({
  audio,                 // {bytes, mimeType}, required: the mixed recording
})
// -> { vocals: {bytes, mimeType}, accompaniment?: {bytes, mimeType}, model?: string }
```

- `vocals` is always present, is the separated vocal stem, and is the only one the library uses. `accompaniment` and other stems are given if the environment is willing; the library does not use them.
- If the environment lacks this capability: the make-a-pack flow skips this step and writes in the report "no separation was done this time; the input should be clean vocals".
- It is a call that costs money and time; the library does not retry, and a failure goes up unchanged.

### `voice-activity-detection`

Finds which time ranges in the audio have someone speaking. When making a pack it is used to cut a long recording into segments.

```js
await env.capabilities['voice-activity-detection']({
  audio,                 // {bytes, mimeType}, required: the recording to detect in
})
// -> { speech: Array<{ start_sec: number, end_sec: number }>, model?: string }
```

- `speech` is ordered by time, with no overlap, each item `0 <= start_sec < end_sec`, and not beyond the length of the recording (an overshoot at the end of less than 0.05 seconds counts as rounding error); if there is no speech at all it is an empty array. The library checks it and throws `capability_result_invalid` if it is not valid, with `details.problem` being `speech_invalid` and `details.index` being the item with the problem (absent if the whole return is wrong); it does not guess and does not fall back to cutting by energy.
- It only says where someone is speaking; how long a segment to cut is decided by the library (`lib/long-recording.mjs` treats the ranges it gives as the "voiced ranges" in `../tools/silence-split.mjs`, and the merging, the length limit and the hard cut that follow are all the same).
- In an environment without this capability, the library uses `../tools/silence-split.mjs` to find silence by energy.

## Provided by only some environments

Some capabilities are not available in every environment and are used elsewhere, so the names are fixed here first:

- The remaining ones that have no written form yet (`text-to-audio`, `audio-watermarking`, `speech-to-speech`, `text-to-image`, `pronunciation-lexicon`): whoever uses one first defines it, and writes it here once defined. `voice-design` is already defined, in the "Synthesis" section above.

## Text capabilities

### `text-generation`

Generates text from a text prompt (a large language model). Polishing, translation and writing dubbing guidance use it. Dubbing (`dub`) does not use it: picking a reference does not let a model judge emotion (`lib/reference-pick.mjs`).

```js
await env.capabilities['text-generation']({
  prompt,                // string, required: the text prompt for the model (non-empty)
})
// -> { text: string, model?: string }
```

- `text` is the original text of the model's answer, parsed by the caller itself.
- **Input limit of one request**: how much input the model can take at once is declared by the environment's adapter (`limits.maxPromptTokens`, see `../adapters/README.md`). If declared, the caller splits into several sends by it (how to measure and why: see `../lib/input-batches.mjs`); if not declared, everything is sent at once. A request over the limit gets a 400 from the platform, which is an ordinary platform error and goes up under the rule below: so declare the limit, and do not rely on the platform to stop it.
- An answer that cannot be used (no text, or it did not end normally): throw `capability_result_invalid`, `details.capability` is `text-generation`, and `details.problem` says which case (`text_missing`, `stop_reason`); for one that did not end normally, `details.stopReason` carries the reason the platform reported (`length` means the answer was cut off, `error` and `aborted` mean it failed midway). When the answer is cut off (`stopReason` is `length`), the caller may split that batch in half and ask again (how: see `../lib/input-batches.mjs`). Other errors (401, wrong input, temporary service error) go up as before.

## How to read it aloud

### Cues in the text

The `text` of the synthesis capabilities (`text-to-speech`, `voice-cloning`, each turn of `text-to-dialogue`) may contain **cues**: "how to say it" written for the model in square brackets (`[sad and surprised]`, `[whispering]`, `[laughs]`; the syntax is the header "cue" in `tools/markup.mjs`), written where the way of speaking changes and in effect from there on; one sentence may contain several.

- The library hands them over unchanged and by position, without interpreting or changing them. Stage directions (`（耳语）`, `*笑*`; these are Chinese-script examples of a whispered stage direction and a laugh) have already been replaced by cues before the library hands them over, so the only cues an environment receives are square-bracket ones. `text` may also contain: angle-bracket tags (`<whisper>…</whisper>` written in a script, language tags, `<|name|>`; when `phoneme-markers` is declared, the phoneme tags that the pronunciation lexicon substitutes in), which the library does not recognise or change and hands over unchanged (how to write them: the header "angle-bracket tags" in `tools/markup.mjs`; in an environment that declares only `phoneme-in-text`, a whole sentence that uses a pinyin phoneme is converted into `<speak>`, and the tags are escaped accordingly, see `lib/dub.mjs` step 4); when several lines of the same chapter and the same voice are merged into one request, a newline (`\n`) separates the lines. What the model would read out and the service cannot accept is decided by the adapter, written in the adapter's notes.
- The environment hands them to the model in the form its model recognises: a model that recognises square-bracket cues gets them unchanged; for a model that would read the square brackets out loud, the adapter decides what to do (remove them, or translate them into the form the model recognises) and writes it in the adapter's notes.
- There is no separate parameter for "how to say it": instructions (`instructions`), the names of emotions and styles (`cues`) and continuation (`continues`) are no longer parameters, and the earlier declarations `style-instruction`, `style-cues`, `pause-in-text` and `cue-in-text` are gone too (capability vocabulary 2.0). The emotion, style and energy given by the caller and by the setup are combined by the library into one cue written at the start of the text (`lib/dub.mjs` step 7a), and the environment receives just text as well; the library does not send the instructions (`instructions`) to the model, the instructions of a setup are for the person who writes the script, and the caller can no longer give them. Dubbing guidance is not handed to the model: the person who writes the script writes the cues according to it.
- Speech rate is not in the cues and is not a parameter: the speech rate given by the caller and the setup is applied by the library as a speed change after synthesis (`lib/dub.mjs` step 7b); what cannot be applied (no ffmpeg) is recorded in `unit.speed` for whoever stitches to apply (see the header "speech rate and pauses" of `lib/dub.mjs`); slowing down or speeding up written in a script (`[slow]`, `<slow>…</slow>`) is a cue or an angle-bracket tag and is handed to the model unchanged.
- Pauses: lines of the same chapter and the same voice that fit are sent as one request (`lib/dub.mjs` step 5c, with newlines between lines), and a short pause between them is written in `text` in a measured form (punctuation and pauses written in square brackets, such as `[pause]`, not SSML; the writings and lengths are only in `PAUSE_WRITINGS` in `lib/pause-in-request.mjs`); a pause longer than the adapter's `limits.maxPauseInRequestMs` (the longest one pause in one request may be, see `adapters/README.md`) is split into two requests there, and the pause is recorded in `unit.pauseBeforeMs` and `unit.pauseAfterMs` for whoever stitches to insert silence (`lib/dub.mjs` step 5c). A scene as one request (step 5a) is the same: pauses not longer than this limit are written in the text of the turns, and longer ones split it. `[pause]` is a pause cue: for a model that would read the square brackets out loud, the adapter must translate it into a pause the model recognises and must not remove it. How dubbing is stitched is written once, in `references/dub-details.md`「Stitching details」.

### `phoneme-in-text`

Not a function but a **declaration**: the environment provides it to say that its synthesis capabilities (for example `voice-cloning`, and reading aloud without reference audio) recognise phonemes in text: `<phoneme alphabet="x-pinyin" ph="zeng1">曾</phoneme>` wrapped in `<speak>…</speak>` is read according to `ph`, and the tag itself is not read. Put `true` in `env.capabilities['phoneme-in-text']`.

- The library asks with `hasCapability(env, 'phoneme-in-text')`: if present, the pinyin phonemes in the pronunciation lexicon (the `<phoneme>` in `lexicon.pls`, the alphabet is `x-pinyin`, how to write it: `references/make-pack-details.md`「Pronunciation lexicon」) are written into the text to be spoken; if not, it is reported in `lexicon.unapplied` as before (`reason` is `phoneme`) and is not in the text.
- Alphabet name: the pack always writes `x-pinyin` (PLS section 2: an alphabet other than `ipa` must be a custom name starting with `x-`). The adapter translates it into its own service's form and states in its notes which alphabet name it recognises; an alphabet it does not recognise is not translated and the library reports it in `unapplied`.
- `ph` is pinyin with a tone number (`zeng1`, tones 1 to 5, 5 being the neutral tone): one syllable per Chinese character, separated by spaces, and the count equals the number of characters; in an environment that declared it, a lexicon entry that is not all Chinese characters, or that does not match, is not written and is reported in `unapplied` (`reason` is `phoneme_format`, and `problem` says whether it is `term`, `count` or `form`).
- An environment that has not declared it is as now: phonemes are not used and are reported in `unapplied` (`reason` is `phoneme`).
- If the environment also declares `phoneme-markers`, the library uses the phoneme tags and not this one (see below).

### `phoneme-markers`

Not a function but a **declaration**: the environment provides it to say that its synthesis capabilities (`voice-cloning`, `text-to-speech`, and the text of each turn of `text-to-dialogue`) recognise phoneme tags in text: `<|phoneme_start|>phonemes<|phoneme_end|>` replaces the original word, the original characters are not written, it is read according to the sounds in the tag, and the tag itself is not read. Put `true` in `env.capabilities['phoneme-markers']`.

- The library asks with `hasCapability(env, 'phoneme-markers')`: if present, the phonemes in the pronunciation lexicon (the `<phoneme>` in `lexicon.pls`) are written as phoneme tags that replace the original word; how to write it is in `references/make-pack-details.md`「Pronunciation lexicon」:
  - alphabet `x-pinyin`: one tag per pinyin syllable, several tags written next to each other; `银行` (`yin2 hang2`) is written as `<|phoneme_start|>yin2<|phoneme_end|><|phoneme_start|>hang2<|phoneme_end|>` (`银行` is the Chinese word "bank" used as the example, and the example only works in Chinese);
  - alphabet `x-arpabet`: CMU Arpabet, one tag per word, phonemes written as they are; `Zorbek` (`Z AO1 R B IH0 K`) is written as `<|phoneme_start|>Z AO1 R B IH0 K<|phoneme_end|>`;
  - alphabet `x-romaji`: Japanese, OpenJTalk-style romaji with pitch digits, one tag per lexicon entry; `橋が` (`ha0shi1ga0`) is written as `<|phoneme_start|>ha0shi1ga0<|phoneme_end|>` (`橋が` is a Japanese example).
- The writing in the pack is the writing in the tag, and the library does not convert it: pinyin in lower case, ü written as `v`, tones 1 to 5 (5 being the neutral tone); Arpabet in upper case, one space between phonemes, vowels with stress digits; romaji with a pitch digit after each letter group and no spaces. A model that wants another form has it translated by the adapter, which states this in its notes.
- Replacing with tags is one substitution, done in the same pass as aliases (`<alias>`) (longer entries first, and the characters that come out of the substitution are not looked up again in the lexicon), and it is done at planning time: the `spoken` of `dub --dry-run` and the text of each turn of a scene already contain the tags, and what is sent is the same. No escaping and no `<speak>` wrapper: other angle-bracket tags in the sentence still reach the model. The ones used are recorded in `lexicon.phonemes` and removed from `unapplied`; that segment has no separate `phonemes`.
- Entries with a wrong form (the number or form of pinyin syllables, the Arpabet phonemes or stress digits, romaji that is not letters plus digits, an entry that is not of that kind) are not written and are reported in `unapplied` (`reason` is `phoneme_format`, `problem` is `term`, `count` or `form`); other alphabets (for example `ipa`) are still `reason: phoneme`.
- If both this and `phoneme-in-text` are declared, this one is used. `plan.capabilities` contains `'phoneme-markers': true`; an environment that has not declared it has no such key, and is identical to before, character for character.
- The reason for declaring is written as "the model recognises this kind of tag in text and reads according to the sound marked". How far it recognises it (for example when the marked reading conflicts with a common word in the context, the model reads the common word as usual) is written in the model notes.
- The characters of the tag are part of the text sent: a service that bills by characters counts them too, and `limits.maxChars` counts them too.

### `seed-in-request`

Not a function but a **declaration**: the environment provides it to say that its `voice-cloning` accepts `seed` (the same seed with the same input should give the same result as far as possible; `text-to-dialogue` accepts it anyway). Put `true` in `env.capabilities['seed-in-request']`.

- The library asks with `hasCapability(env, 'seed-in-request')`: if present, dubbing gives every `voice-cloning` and `text-to-dialogue` request the same fixed `seed` (`DUB_SEED` in `lib/dub.mjs`), and the several pieces of a long text that was split use the same one; the one used for each segment is written in `units[i].seed` of `dub.json`, and `plan.capabilities` contains `'seed-in-request': true`. An environment that has not declared it has no `seed` in its requests and none in `dub.json`, and is identical to before, character for character.
- "Fixed" means it does not change with the script: dubbing the same segment again with the same input should come out as similar as possible. The exception is when the caller says explicitly that this segment should be dubbed again with a different take: a segment picked by `dub --only` that was dubbed successfully last time (`options.only` of the library plus `previousSeed`; which ones count: see the header "--only changes the seed" of `cli/commands/dub.mjs`), and the audition line when it is dubbed again with the same request when making a pack (`make-pack --card-line`); the seed becomes the last one plus 1 (`lib/dub.mjs` step 7 "seed"). So the seed received may be any integer from 0 to 2^53−1, not necessarily `DUB_SEED`. For why it exists and its rules on splitting, see `references/dub.md`「How long text is split」.
- The reason for declaring is written as "the model accepts this parameter, and the same seed with the same input should give the same result as far as possible". Whether the model accepts it, and whether the same seed makes the several pieces of a split text closer to each other, is written in the adapter and model notes.

### `scene-in-request`

Not a function but a **declaration**: the environment provides it to say that its `text-to-dialogue` accepts `turns` (see above), and that dubbing may put a continuous passage in the script in which several speakers take turns (a scene) into one request and one audio. Put `true` in `env.capabilities['scene-in-request']`.

- The library asks with `hasCapability(env, 'scene-in-request')` and **also requires `text-to-dialogue`** (if either is missing it is treated as not declared). Only when both are present, several packs are given, and the caller has not said `options.scene: false` does dubbing divide into scenes (`lib/dub.mjs` step 5a). In an environment that has not declared it, `planDub` and `dub.json` are identical to before, character for character, and `plan.capabilities` has no such key either.
- The rules of dividing into scenes (the cut points, which reference segment each speaker uses), what a scene looks like in `dub.json`, why each line has no audio of its own, what to do when it is too long, and how to fall back to one request per line: see `references/dub.md`「One request per scene」. How the adapter marks it when the platform says a scene does not fit: see 'Does not fit in one request' of `text-to-dialogue`.
- The reason for declaring is written as "the model recognises this form and finishes a scene in one request", and not as "we want to send fewer requests". Declaring changes the model and the method used for this scene (each speaker uses only one reference segment for the whole scene, the one picked by most of his lines, see `lib/scene-in-request.mjs`; how each turn is said depends on the cues in the text of that turn. When it is not declared, each line picks its reference by its own line. Picking a reference never looks at emotion, see `lib/reference-pick.mjs`), so whether to declare is decided by the adapter and the host, not by the library.

## Changing a voice and singing

### `voice-conversion`, `singing-voice-conversion`

Converts a piece of audio to another voice while the content and rhythm (for singing, the melody and lyrics) stay the same. The first is for speech and the second is for singing (the input should be a vocal stem, with no accompaniment).

```js
await env.capabilities['voice-conversion']({        // singing-voice-conversion has the same signature
  audio,                 // {bytes, mimeType}, required: the piece whose voice is to be changed
  ref_audio,             // {bytes, mimeType}, required: the reference of the target voice (a segment picked from the pack)
  ref_text,              // string, optional: the verbatim transcript of the reference audio; when the reference segment has a cue annotation, the cue annotation is handed over (with square-bracket cues, same as ref_text of voice-cloning); the adapter decides what to do if square brackets cannot be accepted (for example remove the cues); an environment that cannot use it may ignore it
  enhancers,             // array of enhancers, optional, see below
})
// -> { bytes: Uint8Array, mimeType: string, model?: string, enhancers_used?: string[] }
```

- What uses them is `lib/convert.mjs` (`convertAudio`). If one is missing, only the corresponding voice conversion reports `capability_missing`, and the other features work as usual.

## Enhancers

An enhancer is a file in the pack that is valid only for a certain model (fine-tuned weights, LoRA, an RVC or SVC model, a speaker embedding), and the pack does not depend on it. Dubbing (`voice-cloning`) and voice conversion hand to the capability the enhancers in the pack that **serve this capability** (the `capability` of the enhancer in the manifest):

```js
enhancers: [{ id, model, modelVersion, capability, referenceVersion, load }]   // load() -> Promise<Uint8Array>, read only when used (whether the files match the manifest was checked when entering the environment, and is not computed again here)
```

- The capability is provided by the environment, and only it knows which model it runs: if it recognises the enhancer's `model` (and `modelVersion`), it does `await load()` and uses it, and writes `enhancers_used: [ids of the enhancers used]` in the return value; if it does not recognise it, it ignores `enhancers`, generates as usual, and reports no error.
- If it reports an id that was not handed to it, or `enhancers_used` is not an array, the library throws `capability_result_invalid` (`details.problem` is `enhancers_used_invalid`) and does not guess.
- When none is used and the pack has enhancers, the library writes `enhancers.statement: 'enhancers_not_used'` in the return value, with which model the unused enhancers belong to and the pack's verification record, so that people know how much worse the result will be in the current environment (`lib/enhancers.mjs`).
