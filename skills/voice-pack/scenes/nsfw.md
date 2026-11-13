# nsfw (adult content)

**When to use this doc.** Use this doc for adult content: flirting, teasing, sex scenes (adult-oriented scenes), adult audio works (音声: one character speaks a long passage to the listener, and the listener is the "you" in the scene), and ASMR with adult content. Adult characters only. If the content is adult-oriented, read this doc, and also read one other doc according to what the content looks like: one character talking to a person (or to the listener), follow `scenes/one-line.md`; a scene where several characters take turns, follow `scenes/a-scene.md`; narration addressed to the listener (the narrated parts of an adult audiobook), follow `scenes/narration.md`. That doc covers the steps of reading the pack, choosing the reference, dry run, dubbing and handing back; this doc only covers what adult content adds: what is heard at each point, how to annotate it, how strong, how long to pause, how to write breathy voice and whispering, and how to dub audio works and ASMR. Where the two docs disagree, follow this one. If the content is not adult-oriented, do not read this doc. For other scenes see the base part `SKILL.md`「Dubbing by scene」.

This doc is written against `models/scene3.md`; wherever it depends on that doc, the section name is given in parentheses. If an adapter that is plugged in has pointed dubbing at a different model, read that model's model notes (`models/`) first and follow them where they differ from what is written here.

## What "fit" means

The listener should feel a living person pressed close and speaking to them: breathing is audible, the voice is loose, soft and slow, there are many pauses, and loudness varies a lot; it is not a line being recited. The table below is what was measured in real recordings; it is the target for writing.

| What to hear | Measured in real recordings (median; the range in brackets is the 10th to 90th percentile) | For comparison: single lines in games | Done in which step |
|---|---|---|---|
| Much breath, loose voice | Voiced share of audible time only 0.55 (0.28–0.73); H1-H2 (higher means breathier) 14.3 dB for segments with fundamental frequency below 250 Hz, 11.9 dB for segments at 250–300 Hz; CPPS (lower means less like a clear voice) 7.59 dB (5.68–9.71) | Voiced share 0.60, 0.74; H1-H2 12.3, 11.8 dB; CPPS 9.02, 12.29 dB | Step 3 |
| Breathing is audible | 15.5 breaths per minute, the heavily panting works 17.9–25.9; two breaths within one passage 1.54 s apart (0.49–3.89); sharp inhales 2.7 per minute; a breath before speaking, 0.06 s, 90th percentile 0.43 s | 15.0, 6.3 per minute; before speaking 0.03, 0.01 s, 90th percentile 0.25, 0.18 s | Steps 3, 5 |
| Many pauses, long white space | Silences inside a passage 31.4 per minute, 0.30 s each (0.16–0.70); between phrases 0.55 s (0.25–1.10); between two passages 3.06 s (1.34–7.54), and in 23% of those, breath, breathy voice or mouth sounds are audible | 23.9, 19.3 per minute | Step 5 |
| Slow | 3.21 syllables per second (1.70–4.52), the works that are close-up and panting heavily 2.03–2.91; variation of speed within a line (90th percentile over 10th) 1.24 | 3.60, 4.56 syllables per second | Steps 3, 4 |
| Low, soft, big loudness differences | Fundamental frequency 250.5 Hz (191.6–413.5), about 3.5 to 6.5 semitones lower than game lines; within a passage the 90th percentile of loudness is 31.8 dB above the 10th; in the same track 20% of segments are more than 3 dB softer than the track's median | Fundamental frequency 324.8, 365.9 Hz; loudness span 29.3, 23.4 dB | Steps 3, 4 |

Measurement: long tracks of 14 adult audio works and ASMR works (only the part whose copy is complete; voice separated from sound effects and background music, only the voice measured: 1938 segments, about 196 minutes), 2026-11-12, measured by a program. The comparison is 3 single-line game works (everyday and adult lines mixed together); the two columns are the two batches. For the threshold-type items (voiced share, breaths, silences), the voice of the whole track was first aligned to the same loudness, and only the 879 segments with signal-to-noise ratio above 40 dB were counted. These numbers describe real recordings; how far a dub made by following this doc lands from them has not been measured.

Also the same as in the other doc: no drift (after dozens of lines it is still the same person), and speak lines only (stage directions, actions, speaker names and sound effects are not spoken).

## Steps

1. **Decide which doc to follow.** If this passage is one character talking to a person (including audio works), follow `scenes/one-line.md`; several characters taking turns, follow `scenes/a-scene.md` (a pack that plays several characters: follow its "one person, several roles"); narration addressed to the listener, follow `scenes/narration.md`. Read that doc; read the pack, choose the setup and choose the reference as it says (one-line steps 1, 4; a-scene steps 1, 2, 5; narration steps 1, 4). When choosing the reference, look a second time at the pack's reference tags: if a segment was already spoken with a pressed-down voice and breathy ("whisper", "breathy" and the like), and this scene is spoken that way all the way through, pick it: the way of acting follows the reference (`models/scene3.md`「Reference segments」); whether a cue can press the voice down is in the measurements in step 3.

   Done when: you know which doc to follow and have read it; you can say which reference segment you use and why.

2. **Take only the words the character says aloud from the text; the description becomes state, cues and pauses.** The text the audience reads (the description of the process plus what the character says) is not the script for dubbing. From it take only what the character says aloud at this moment, and take those words as they are: do not polish, delete or add words (what you add is cues, tags and pauses). Follow that doc's step for revising the script (one-line step 2, a-scene step 3, narration step 2), except for its item on making the lines colloquial: the words are taken as written. In addition:
   - The description of actions, positions, the state of the body and the scene is not spoken. The way it lands on the voice (panting, lowered, speaking close, how intense) is written in steps 3 and 4 as states and cues; the time it takes is written in step 5 as pauses and white space. The table in 「What "fit" means」 is why: in a real recording it is a short stretch of words with breaths and white space between.
   - The text itself is not changed: the audience still reads the original. What is changed is only what goes into the model.
   - A sound that the text writes out as words (`嗯……`, `哈啊`, `啊！`: a moan, a pant, a gasp) is written as the English cue for that sound, at the same place: `[moans]`, `[gasps]`, `[panting]`, with the words of the vocabulary (`vocab/cues.json`; `（呻吟）` becomes `[moans]`). Words that are really said stay words, for example a `嗯` that means yes. Do not write onomatopoeic words in square brackets (`[嗯啊地喘]`): an onomatopoeic word in a cue may be spoken aloud (`models/scene3.md`「What to write」). This is not tested: when handing back (step 7), name these places and ask the user to listen.
   - Exception: when the whole work is read aloud (the narration of an adult audiobook), the narrated part is spoken as narration, following `scenes/narration.md`.
   - Replace stage directions with English cues, placed in front of the words they govern or at the place where they happen: `（喘息）` (panting) becomes `[panting]`, `（呻吟）` (moaning) becomes `[moans]`, `（耳语）` (whispering) becomes `<whisper>…</whisper>` if it governs one sentence, and `[whispering]` if it governs a passage (step 3). Delete those that describe body actions, positions or the scene (`（把他按在床上）` "pins him on the bed", `（贴到耳边）` "puts her lips to his ear"); the way they land on the voice (panting, lowered, speaking close) is written as a cue in step 3.
   - Sound effects are not a human voice and do not go into the script for dubbing: delete stage directions such as bed, clothes, water and ambient sounds (`（床吱呀作响）` "the bed creaks"), and do not turn them into cues; sound effects are made separately, apart from the dubbed voice.
   - Ellipses and punctuation follow `models/scene3.md`「Punctuation」: put `……` between words; do not use `……` alone as a pant or a pause, and do not write `。……`, `。[pause]` or `[long pause]` (with these the next sentence gets lost in the measurements, `models/scene3.md`「Pause between lines」). For a pant write a cue; for a pause write `[pause …]` (step 5).
   - A comma every two or three characters makes the model speak in jerks (`models/scene3.md`「Breathy voice, whispering and gasping」). If the original breaks that way and incoherent speech is what is wanted, keep it; if it is not deliberate, do not add commas to make it "slow" or "breathless".

   Done when: the script has only the words the character says aloud, as written, and none of the description of actions, positions or the scene; every sound the text wrote as words is an English cue in the same place, and those places are noted for the hand-back (step 7); every stage direction was replaced by an English cue or deleted; sound effects are not in the script; there is no `……` standing alone as a pause.

3. **Annotate what is heard at each point.** First, as in `models/scene3.md`「Where a cue is written and how far it reaches」›「Set the state first, then write the cue.」: lay out every clause and fix its state. Besides emotion, fix these in the state: how breathy, how loud (whispered, pressed down, normal, shouted), panting or not, fast or slow. Write a cue where the state changes, in the way that doc's step for writing cues says (one-line step 3, a-scene step 4, narration step 3): start each line with the character name, write cues in English only, two or three words, not as sentences, and write only what can be heard with eyes closed (`models/scene3.md`「What to write」). Common cues for adult content:

   | What to hear | How to write it (examples of how to write; those not tested are marked so in the basis column) | Basis |
   |---|---|---|
   | The whole passage with a pressed-down voice, speaking close (the base tone of audio works and ASMR) | A direction cue at the start of each passage: `[whispering]`, `[hushed, intimate]` | `[whispering]` did not press the voice down on a voice that speaks Chinese (`models/scene3.md`「Breathy voice, whispering and gasping」); a word like `[quietly]` gave breathiness to an English sentence (`models/scene3.md`「What to write」, the item on volume) |
   | A whispered sentence | Wrap this sentence in `<whisper>…</whisper>`, and write the direction cue in front as usual | It worked on half an English sentence; it did not press the voice down on a voice that speaks Chinese (`models/scene3.md`「Paired tags」「Breathy voice, whispering and gasping」) |
   | A bit more breath, still speaking | Write `[breathy, soft]` in the direction cue, together with the emotion of this spot | On a voice that speaks Chinese, more breath could not be measured (`models/scene3.md`「Breathy voice, whispering and gasping」); write it anyway, and ask the user to listen when handing back |
   | Panting, incoherent speech | The state `[breathless, panting]` in front of this passage; where the breath is taken, write a sudden sound `[shaky breath]`, `[panting]` | For an ordinary line, 2 of 3 seeds showed a stretch of breathy voice (`models/scene3.md`「Breathy voice, whispering and gasping」) |
   | Sudden sounds: an inhale, a sharp inhale, a sigh, a moan | `[sharp inhale]`, `[gasps]`, `[sighs]`, `[soft moan]`, written where it happens, one cue alone in its square brackets | For `[sighs]` the pause before it got longer (measured); the others are not tested (`models/scene3.md`「Sudden sounds and pauses」) |
   | A few words made softer, gentler | `<soft>…</soft>`; it does not bring out breathy voice, and for breathy voice write as above | On a voice that speaks Chinese, 2 of 3 seeds were the same as writing nothing (`models/scene3.md`「Breathy voice, whispering and gasping」) |
   | A few words stressed hard, shouted | `<emphasis>…</emphasis>`, `<forceful>…</forceful>`; for a whole shouted sentence write the direction cue `[crying out, loud]` | `models/scene3.md`「Paired tags」 |
   | Slow down | Follow the entry "Speed follows the manner" of `models/scene3.md`「What to write」: where the manner of this spot itself slows, write the slowing together with the emotion in one direction cue (`[gentle, slowing down]`); do not add a speed cue only to set the tempo; to slow a whole sentence use the setup's speaking rate or `--speed` | `[slow, drawn out]` made all 3 seeds slower (`models/scene3.md`「Add a few more things when dubbing.」), but speed written into the cues to adjust the speech rate was heard with words dropped (`models/scene3.md`「Speed and pauses: conclusions from listening」); `<slow>` showed no measurable slowing |

   Write breathing where a person would take a breath: between sentences, in the middle of a long sentence where a breath is taken, and before speaking (write one `[soft inhale]` at the start of a passage; in real recordings there is often a breath before speaking, see the section above on what fit means). The heavier the panting, the denser the writing; in real recordings two breaths within one passage are a median of about 1.5 seconds apart. Do not write what cannot be heard: who is being spoken to, what the body is doing and why it is said this way do not go into square brackets; write how it lands on the voice (`[breathless, trembling]`, not `[被他抱紧，声音发抖]`, which means "held tight by him, voice shaking").

   **Example**:

   ```
   [沈砚][hushed, teasing]手抖什么，[breathless, trembling]才刚摸到我腰上，[shaky breath]<whisper>就把你烫成这样了？</whisper>
   ```

   Done when: every clause has a state (including breathiness, volume, panting or not, speed), and there is a cue wherever the state changes; breaths, sharp inhales and moans are written where they happen; there are no onomatopoeic words or inaudible things in square brackets; every cue is at most 4 words.

4. **Intensity: go up one level at a time, following the content.** The stronger the cue, the more intensely it is acted (inference, `models/scene3.md`「Readings from the first-page audition」): set the strength by the content at this spot; do not write toward the weak side to be safe, and do not write the strongest from the very beginning. Examples of how to write, not tested: light (getting close, teasing) `[soft, teasing]`, `[hushed, breathy]`; medium (breathing gets disordered) `[breathless, trembling]`, adding `[shaky breath]` between sentences; strong (the peak, crying out) `[gasping, desperate]`, `[crying out]`, adding `[gasps]` between sentences. For a sentence that was held down the whole time and comes up at the end, write it the way the deleted item in the second example of `models/scene3.md`「Good examples」 was written, and do not stack another word that pushes upward (inference, only for this one sentence).

   Take expressiveness (`--expressiveness`) in that doc's step on the `dub` parameters (one-line step 6, a-scene step 6, narration step 3), and take the value as in `models/scene3.md`「Expressiveness」›「How to choose the value」. Within a scene the value does not change; for a passage that gets stronger and stronger, split it at the places where the intensity changes level into several items of the `.json` script, each item with its own value, about 10 per level, and do not jump straight to the two ends. Expressiveness set to 95 or 100 showed no swallowed or run-together words on one voice (`models/scene3.md`「Breathy voice, whispering and gasping」), so there is no need to lower it for that reason.

   **Example**:

   ```json
   [
     { "text": "[沈砚][soft, teasing]门我已经锁上了，过来，坐到我腿上来。", "expressiveness": 70 },
     { "text": "[沈砚][breathless, trembling][moans]别乱蹭，[shaky breath]腰都被你掐红了，手再往下摸哪儿呢？", "expressiveness": 80 },
     { "text": "[沈砚][gasping, desperate][panting]慢一点……[gasps]太深了，[crying out]真的要被你顶坏了！", "expressiveness": 90 }
   ]
   ```

   Done when: the strength follows the content; the places where the level changes are split into several items, with the value moving about 10 per level; for a voice whose expressiveness is fixed, follow that doc's rule and do not give another value unless there is a reason.

5. **Pauses and white space.** One pause in one request can be at most about 0.75 seconds long (`models/scene3.md`「Pause between lines」). So:
   - A pause between phrases (median about 0.55 seconds in real recordings) is written in the request: after a comma `，[pause 0.6s]` (`models/scene3.md`「Add a few more things when dubbing.」).
   - White space between two passages (median about 3 seconds in real recordings): write a line with only a pause, `[pause 2s]` or `[pause 3s]`; if it is longer than a request can hold, `dub` cuts there and inserts silence of the same length when stitching (`references/dub.md`「One request per passage」). After the cut, the next request cannot hear what is before it and does not carry the earlier cues: at the start of the line after the pause, rewrite the name and the state of this moment as in step 3. Stitching inserts silence; in real recordings a little over a fifth of such white spaces have breath audible in them, and if you want that, write a sudden breath sound at the start of the line after the pause (`[slow exhale]`, an example of how to write, not tested).
   - Where the acting should carry on in one breath, do not write a pause longer than 0.75 seconds: once it is cut, the two parts are no longer acted together.
   - A pause written as a square-bracket direction (`[沉默片刻]`, "silent for a moment") is not treated as a pause by `dub`; whether it pauses is up to the model (`models/scene3.md`「Pause between lines」); to pause, write `[pause …]`.
   - In a scene with several people merged, pauses follow `scenes/a-scene.md` step 2: one longer than the limit cuts the scene.

   **Example**:

   ```
   [沈砚][hushed, breathy]别躲，[pause 0.6s]把嘴张开，舌头伸出来让我含住。
   [pause 2s]
   [沈砚][breathless, soft][slow exhale][panting]怎么连换气都不会了，[pause 0.6s]腿分得再开一点。
   ```

   Done when: every white space longer than one breath point is written as `[pause …]` with its length; at every cut, the line after it rewrites the name and the state at its start; no square-bracket direction or `……` is used as a pause.

6. **Audio works and ASMR** (only when dubbing these two kinds).
   - **Audio works (音声)**: one character speaks a long passage to the listener, and the listener is the "you": it is speaking to someone, so dub it following `scenes/one-line.md`; it is long, so write it following "Splitting: do not split if it fits, otherwise split only at boundaries" in `scenes/narration.md`: one paragraph per line, a paragraph being one complete meaning; if it does not fit, `dub` cuts only at paragraph boundaries; write a direction cue at the start of each paragraph (after a cut as well). The base tone of speaking at the ear is written at the start of each paragraph (the first row of the table in step 3); for a sentence in the middle where the voice gets even closer, use `<whisper>`.
   - **ASMR**: slow, much white space, and whispering, breathing and mouth sounds (`[soft kiss]`, `[lip smack]`, examples of how to write, not tested) outnumber the words; write it like an audio work, and write more `[pause …]` and sudden sounds. Among mouth sounds and trigger sounds, those not made by the mouth (brush, tapping, water) are sound effects and do not go into the script (step 2).
   - Left and right ear, near and far: each line the model gives has one channel only, and `mix` only joins them in order, with no left and right and no near and far adjustment (`references/dub.md`「Stitching」). Some adult audio works have large differences between the left and right channels; this doc cannot do that, and if it is wanted it is done separately after dubbing.

   **Example**:

   ```
   [沈砚][hushed, intimate][soft inhale]别睁眼，[pause 0.6s]手心刚贴上来，怎么就绷这么紧？
   [pause 2s]
   [沈砚][whispering][shaky breath]<whisper>已经硬得发烫了，我替你握住，好不好？</whisper>[breathless, soft]别忍着，喘出来给我听。
   ```

   Done when: an audio work is one paragraph per line, with a direction cue at the start of each paragraph; for ASMR, the white space and sudden sounds are written into the script; sound effects are not in the script; you did not promise the user left and right ear or near and far.

7. **Dry run, dub, hand back: as in that doc.** The dry run (`--dry-run`), dubbing, reading the report and joining into one file follow that doc's steps (one-line steps 6 to 8, a-scene steps 6 to 9, narration steps 6, 7). At the dry run, check three more things: the cues and angle-bracket tags are in place; `notes` has no `tag_pair_split` (a pair of tags cut into two requests); the cut points are where you wrote long pauses, and the start of the next block has the name and the state. In the note handed back, write the places to listen to as that doc says, and add: the sentences where you wrote whispering or breathy voice (whether the voice was pressed down was not measured accurately on the model); the positions where you wrote sudden sounds such as breaths and moans (whether they came out; the measurements include some that did not); the seams where long white space was cut.

   **Example**:

   ```
   [voice:shenyan][沈砚][low, commanding]手腕被我扣住了还敢扭？[soft inhale]看着我，说你现在想要什么。
   [voice:linwan][林晚][breathless, pleading][moans]别停，[shaky breath]手再重一点按住我……<whisper>把里面填满。</whisper>
   [voice:shenyan][沈砚][hushed, husky]这就受不了了？[sighs]抓紧床单，今晚没那么容易放过你。
   ```

   Done when: in the `--dry-run` plan the cues and tags are in place, there is no `tag_pair_split`, and the cut points are the ones you want; after the real dub `dub` exits 0; the note handed back lists the places to listen to.

## Common pitfalls

- **Whispering was written, but the voice was not pressed down.** On a voice that speaks Chinese, `<whisper>` around a sentence, around half a sentence, around a whole line, and the direction cue `[whispering]` all gave the same voiced share as writing nothing (`models/scene3.md`「Breathy voice, whispering and gasping」). Write it anyway and ask the user to listen when handing back; if the pack has a reference segment spoken with a pressed-down voice, pick it for this scene (step 1; inference, not tested). If the user listens and says it was not pressed down, change the reference tag as that doc says and dub again.
- **Using `<soft>` or `[breathy, soft]` as breathy voice.** Neither showed more breathy voice in the measurements (`models/scene3.md`「Breathy voice, whispering and gasping」). For panting write a sudden sound such as `[panting]` and the state `[breathless]`.
- **A comma every two or three characters.** The same words came out 1.7 to 2.2 times as long for the whole sentence, in jerks (`models/scene3.md`「Breathy voice, whispering and gasping」). For slow, follow the entry "Speed follows the manner" of `models/scene3.md`「What to write」 (the slowing goes with the emotion where the manner of this spot changes; to slow a whole sentence use the speaking rate or `--speed`); do not add commas.
- **Using `……` as a pant or a pause.** It loses the words after it (`models/scene3.md`「Pause between lines」). Write a cue for a pant; write `[pause …]` for a pause.
- **Writing onomatopoeic words, actions or the scene in a cue.** `[嗯嗯啊啊]` may be spoken aloud; `[跨坐在他身上]` ("straddling him") cannot be heard. Write the two or three words for how it lands on the voice (`[breathless, trembling]`).
- **Sound effects written into the script.** `（床吱呀作响）` ("the bed creaks") would become a cue handed to the model through `dub`. Delete it; make sound effects separately.
- **After a long white space is cut, the second half changes state.** The next request does not carry the earlier cues: at the start of the line after the pause, rewrite the name and the state (step 5).
- **Writing the strongest from the very beginning.** There is no room to go up later, and the whole passage has one tone. Follow step 4 and go up one level at a time.

## Model notes used

All are in `models/scene3.md`:

- 「Breathy voice, whispering and gasping」: what was measured for whispering, `<soft>` and breathy direction cues on a voice that speaks Chinese, the readings for panting, a comma every two or three characters, and that no swallowed words were measured with expressiveness at 95 or 100 or with a sentence-final ellipsis and whispering together (steps 3, 4, pitfalls).
- 「What to write」: write concrete, audible things, two or three words, in English, no onomatopoeic words; volume words may bring in breathy voice (steps 2, 3).
- 「Where a cue is written and how far it reaches」, 「Set the state first, then write the cue.」: fix the state of each clause (step 3).
- 「Sudden sounds and pauses」, 「Paired tags」: breaths and sighs written where they happen; whispering, softening, stressing and forcing a few words (step 3).
- 「Pause between lines」, 「Punctuation」: one pause in one request is at most about 0.75 seconds; the ways of writing that lose the next sentence; ellipses go between words (steps 2, 5).
- 「Add a few more things when dubbing.」: `，[pause 0.6s]` (steps 3, 5).
- "Speed follows the manner" (an entry of 「What to write」) and 「Speed and pauses: conclusions from listening」: when a speed word is written (together with the emotion, where the manner changes) and when it is not (to slow a whole sentence, the speaking rate or `--speed`) (steps 3, 5).
- 「Readings from the first-page audition」, 「Good examples」: the stronger the cue, the more intensely it is acted; how to write a sentence that comes up and is then held back (step 4).
- 「Expressiveness」: the control parameter, the higher the value the more drama; the order of the three layers, that a voice with a fixed value is by default not given another, and the choice of value and the step of about 10 are there (step 4).
- 「Reference segments」: the way of acting follows the reference (step 1, pitfalls).
