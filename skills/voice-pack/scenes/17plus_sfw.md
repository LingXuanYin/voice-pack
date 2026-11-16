# 17plus_sfw (17+ edge content)

**When to use this doc.** Use this doc for 17+ edge content with adult characters: flirting, teasing, whispering close to the ear, kissing, lulling someone to sleep, and ASMR (including audio works (音声): one character speaks a long passage to the listener, and the listener is the "you" in the scene). The tension stops at the threshold and does not go past it: this doc does not teach dubbing an explicit sex scene, and a passage that goes beyond the threshold is outside it. If the content is like this, read this doc, and also read one other doc according to what the content looks like: one character talking to a person (or to the listener), follow `scenes/one-line.md`; a scene where several characters take turns, follow `scenes/a-scene.md`; narration addressed to the listener (the narrated parts of an adult audiobook), follow `scenes/narration.md`. That doc covers the steps of reading the pack, choosing the reference, dry run, dubbing and handing back; this doc only covers what this content adds: what is heard at each point, how to annotate it, how strong, how long to pause, how to write breathy voice and whispering, and how to dub audio works and ASMR. Where the two docs disagree, follow this one. If the content is not like this, do not read this doc: the other three are enough. For other scenes see the base part `SKILL.md`「Dubbing by scene」.

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
   - A sound is described, never spelled. Where the text writes a sound out as words (`唉` a sigh, `嗯……` or `啊……` a moan, `嗯` with the lips closed a hum, `哈啊` a pant, `啊！` a gasp, `啾` or `mua` a kiss), the words are deleted and the cue for that sound is written at the same place (step 3's table): `唉，算了` becomes `[sighs][resigned, quiet]算了`, `啾，晚安` becomes `[kisses][smiling, warm]晚安` (the state cue after the sound: step 3). Written as words, the sound is spoken as those words: on a library voice `啾` was spoken as a syllable in 5 of 6 takes, `嗯` in 6 of 6, `啊` in 5 to 6 of 6 (`models/scene3.md`「Non-verbal sounds: which writing comes out (2026-11-16)」). A word the character says as a word stays: `嗯` as a yes, `啊` ending a clause (`好啊`), `哎` calling out. Do not put the sound's words in square brackets either (`[嗯啊地喘]`): words in a cue may be spoken aloud (`models/scene3.md`「What to write」).
   - Exception: when the whole work is read aloud (the narration of an adult audiobook), the narrated part is spoken as narration, following `scenes/narration.md`.
   - Replace stage directions with English cues, placed in front of the words they govern or at the place where they happen, with the writing in step 3's table: `（叹气）` (sighs) becomes `[sighs]`, `（喘息）` (panting) becomes `[panting]`, `（呻吟）` (moaning) becomes `[moaning]`, `（亲了一下）` (a kiss) becomes `[kisses]`, `（耳语）` (whispering) becomes `[whispering]` in front of the sentence or passage it governs. Delete those that describe body actions, positions or the scene (`（把他拉近）` "pulls him close", `（贴到耳边）` "puts her lips to his ear"); the way they land on the voice (panting, lowered, speaking close) is written as a cue in step 3.
   - Sound effects are not a human voice and do not go into the script for dubbing: delete stage directions such as bed, clothes, water and ambient sounds (`（床吱呀作响）` "the bed creaks"), and do not turn them into cues; sound effects are made separately, apart from the dubbed voice.
   - Ellipses and punctuation follow `models/scene3.md`「Punctuation」: put `……` between words; do not use `……` alone as a pant or a pause, and do not write `。……`, `。[pause]` or `[long pause]` (with these the next sentence gets lost in the measurements, `models/scene3.md`「Pause between lines」). For a pant write a cue; for a pause write `[pause …]` (step 5).
   - A comma every two or three characters makes the model speak in jerks (`models/scene3.md`「Breathy voice, whispering and gasping」). If the original breaks that way and incoherent speech is what is wanted, keep it; if it is not deliberate, do not add commas to make it "slow" or "breathless".

   Done when: the script has only the words the character says aloud, as written, and none of the description of actions, positions or the scene; no sound is written as words: every sound the text spelled is its cue at the same place, and its words are gone; every stage direction was replaced by an English cue or deleted; sound effects are not in the script; there is no `……` standing alone as a pause.

3. **Annotate what is heard at each point.** Mark the line the way a speech is marked up for the person giving it: what the feeling is at each point and where a sound happens. First, as in `models/scene3.md`「Where a cue is written and how far it reaches」 (the item "Set the state first, then write the cue."): lay out every clause and fix its state. Besides emotion, fix these in the state: how breathy, how loud (whispered, pressed down, normal), panting or not, fast or slow. Write a cue wherever the state changes, none left out: several in a sentence when it changes that often, and one after a sound, for the voice the character comes out of it with (after a kiss, `[smiling, warm]`). Write the cues in the way that doc's step for writing cues says (one-line step 3, a-scene step 4, narration step 3): start each line with the character name, write cues in English only, two or three words, not as sentences, and write only what can be heard with eyes closed (`models/scene3.md`「What to write」). Common cues for adult content:

   | What to hear | How to write it (examples of how to write; those not tested are marked so in the basis column) | Basis |
   |---|---|---|
   | The whole passage with a pressed-down voice, speaking close (the base tone of audio works and ASMR) | A direction cue at the start of each passage: `[whispering]` | On a library voice `[whispering]` came out in 4 of 6 and was 7.5 dB quieter; `<whisper>` around the sentence, and `[whispering]<whisper>…</whisper>` stacked, were not better there (`models/scene3.md`「Non-verbal sounds: which writing comes out (2026-11-16)」). It did not press the voice down on another Chinese-speaking voice on 2026-11-12, so it is not guaranteed |
   | A whispered sentence | `[whispering]` in front of this sentence | As above |
   | A bit more breath, still speaking | Write `[breathy, soft]` in the direction cue, together with the emotion of this spot | On a voice that speaks Chinese, more breath could not be measured (`models/scene3.md`「Breathy voice, whispering and gasping」); write it anyway |
   | Panting, incoherent speech | The state `[breathless, panting]` in front of this passage; where the breath is taken, `[shaky breath]`; where the character pants (the text may spell it `哈啊`), `[panting]` (step 2) | The state: for an ordinary line, 2 of 3 seeds showed a stretch of breathy voice (`models/scene3.md`「Breathy voice, whispering and gasping」). `[panting]`, in a line marked point by point on a library voice (a state cue before it and after it), came out in 15 of 18 takes over 3 lines; `[heavy breathing]` 16 of 18; alone in a bare line, 2 of 6 (`models/scene3.md`「Non-verbal sounds: which writing comes out (2026-11-16)」) |
   | Sudden sounds: a sigh, a breath in, a gasp, a closed-mouth hum | `[sighs]`, `[shaky breath]`, `[gasping]`, `[hums]`, written where it happens, one cue alone in its square brackets | On a library voice 5, 4, 5 and 5 of 6 came out (on `[hums]`, 3 of 6 takes on each voice had 「嗯」 spoken at that spot, once 「嗯哼嗯哼哼哼」, and one take ran over twice the expected length; on `[gasping]` 3 of 6 on the library voice had 「啊」, 「哎」 or 「你」 spoken); `[gasps]`, `[breath]`, `[deep breath]`, `[inhales]`, `[sighing]` and Chinese descriptions came out less often there (`models/scene3.md`「Non-verbal sounds: which writing comes out (2026-11-16)」) |
   | A moan, a kiss, however the text writes them | `[moaning]`, `[kisses]`, written where it happens In a line marked point by point on a library voice: `[moaning]` came out in 17 of 18 takes over 3 lines (alone in a bare line, 1 of 6; the judging hears an extra sound there, not which, and a transcription writes 「嗯」 or 「啊」 at that spot in 12 of 18); `[kisses]` in 5 of 18, and no writing of a kiss in more than 7 of 18 (the cue after it `[smiling, warm]` 7, the cue before it `[tender, soft voice]` 2, `[soft kiss]` 3), so most takes have no kiss; every writing with `啾` was spoken as a word in 4 to 6 of 6; `[moans]` spoke syllables that are not in the line in 2 of 6 on the model's own voice, so it is not used (`models/scene3.md`「Non-verbal sounds: which writing comes out (2026-11-16)」) |
   | A few words made softer, gentler | `<soft>…</soft>`; it does not bring out breathy voice, and for breathy voice write as above | On a voice that speaks Chinese, 2 of 3 seeds were the same as writing nothing (`models/scene3.md`「Breathy voice, whispering and gasping」) |
   | Slow down | Follow the entry "Speed follows the manner" of `models/scene3.md`「What to write」: where the manner of this spot itself slows, write the slowing together with the emotion in one direction cue (`[gentle, slowing down]`); do not add a speed cue only to set the tempo; to slow a whole sentence use the setup's speaking rate or `--speed` | `[slow, drawn out]` made all 3 seeds slower (`models/scene3.md`「Where a cue is written and how far it reaches」 (the item "Add a few more things when dubbing.")), but speed written into the cues to adjust the speech rate was heard with words dropped (`models/scene3.md`「Speed and pauses: conclusions from listening」); `<slow>` showed no measurable slowing |

   Write breathing where a person would take a breath: between sentences, in the middle of a long sentence where a breath is taken, and before speaking (write one `[shaky breath]` at the start of a passage, the breath that came out on a library voice; in real recordings there is often a breath before speaking, see the section above on what fit means). The heavier the panting, the denser the writing; in real recordings two breaths within one passage are a median of about 1.5 seconds apart. Do not write what cannot be heard: who is being spoken to, what the body is doing and why it is said this way do not go into square brackets; write how it lands on the voice (`[breathless, trembling]`, not `[被他抱紧，声音发抖]`, which means "held tight by him, voice shaking").

   **Example**:

   ```
   [沈砚][soft, amused]手抖什么，[breathless, trembling]我才刚靠过来，[shaky breath][whispering]你的耳朵就红成这样了？
   ```

   Done when: every clause has a state (including breathiness, volume, panting or not, speed), and there is a cue wherever the state changes; a breath in is written `[shaky breath]` where it happens; every sound is a cue at its place and none is written as words; the clause after a sound opens with its own cue; there are no onomatopoeic words or inaudible things in square brackets; every cue is at most 4 words.

4. **Intensity: go up one level at a time, following the content.** The stronger the cue, the more intensely it is acted (inference, `models/scene3.md`「Readings from the first-page audition」): set the strength by the content at this spot; do not write toward the weak side to be safe, and do not write the strongest from the very beginning. Examples of how to write, not tested: light (getting close, playful) `[soft, amused]`, `[hushed, breathy]`; medium (breathing gets disordered) `[breathless, trembling]`, adding `[shaky breath]` between sentences; strong (the peak: the breath so ragged the words come apart) `[gasping, desperate]`, adding `[gasping]` between sentences. The top of the range in this doc is panting until the speech is incoherent; it does not go on to shouting. For a sentence that was held down the whole time and comes up at the end, write it the way the deleted item in the second example of `models/scene3.md`「Good examples」 was written, and do not stack another word that pushes upward (inference, only for this one sentence).

   Take expressiveness (`--expressiveness`) in that doc's step on the `dub` parameters (one-line step 6, a-scene step 6, narration step 3), and take the value as in `models/scene3.md`「Expressiveness」›「How to choose the value」. Within a scene the value does not change; for a passage that gets stronger and stronger, split it at the places where the intensity changes level into several items of the `.json` script, each item with its own value, about 10 per level, and do not jump straight to the two ends. Expressiveness set to 95 or 100 showed no swallowed or run-together words on one voice (`models/scene3.md`「Breathy voice, whispering and gasping」), so there is no need to lower it for that reason.

   **Example**:

   ```json
   [
     { "text": "[沈砚][soft, amused]门我已经锁上了，[warm, low voice]过来，坐到我身边来。", "expressiveness": 70 },
     { "text": "[沈砚][breathless, trembling]别躲，[shaky breath][tender, soft voice]就亲一下，[kisses][smiling, warm]你看，脸都红透了。", "expressiveness": 80 },
     { "text": "[沈砚][panting][breathless, desperate]等……等一下，[gasping][breathless, shaky]我喘不过气了，[shaky breath][weak, trembling]你再这样亲下去，我……我站都站不稳了。", "expressiveness": 90 }
   ]
   ```

   Done when: the strength follows the content; the places where the level changes are split into several items, with the value moving about 10 per level; for a voice whose expressiveness is fixed, follow that doc's rule and do not give another value unless there is a reason.

5. **Pauses and white space.** One pause in one request can be at most about 0.75 seconds long (`models/scene3.md`「Pause between lines」). So:
   - A pause between phrases (median about 0.55 seconds in real recordings) is written in the request: after a comma `，[pause 0.6s]` (`models/scene3.md`「Where a cue is written and how far it reaches」 (the item "Add a few more things when dubbing.")).
   - White space between two passages (median about 3 seconds in real recordings): write a line with only a pause, `[pause 2s]` or `[pause 3s]`; if it is longer than a request can hold, `dub` cuts there and inserts silence of the same length when stitching. After the cut, the next request cannot hear what is before it and does not carry the earlier cues: at the start of the line after the pause, rewrite the name and the state of this moment as in step 3. Stitching inserts silence; in real recordings a little over a fifth of such white spaces have breath audible in them, and if you want that, write a sudden breath sound at the start of the line after the pause (`[shaky breath]` or `[sighs]`, whichever the moment is).
   - Where the acting should carry on in one breath, do not write a pause longer than 0.75 seconds: once it is cut, the two parts are no longer acted together.
   - A pause written as a square-bracket direction (`[沉默片刻]`, "silent for a moment") is not treated as a pause by `dub`; whether it pauses is up to the model (`models/scene3.md`「Pause between lines」); to pause, write `[pause …]`.
   - In a scene with several people merged, pauses follow `scenes/a-scene.md` step 2: one longer than the limit cuts the scene.

   **Example**:

   ```
   [沈砚][gentle, breathy]别动，[pause 0.6s][soft, low voice]让我再抱一会儿。
   [pause 2s]
   [沈砚][shaky breath][breathless, soft]刚才亲得那么急，[pause 0.6s][amused, hushed]现在才知道害羞？
   ```

   Done when: every white space longer than one breath point is written as `[pause …]` with its length; at every cut, the line after it rewrites the name and the state at its start; no square-bracket direction or `……` is used as a pause.

6. **Audio works and ASMR** (only when dubbing these two kinds).
   - **Audio works (音声)**: one character speaks a long passage to the listener, and the listener is the "you": it is speaking to someone, so dub it following `scenes/one-line.md`; it is long, so write it following "Splitting: do not split if it fits, otherwise split only at boundaries" in `scenes/narration.md`: one paragraph per line, a paragraph being one complete meaning; if it does not fit, `dub` cuts only at paragraph boundaries; write a direction cue at the start of each paragraph (after a cut as well). The base tone of speaking at the ear is written at the start of each paragraph (the first row of the table in step 3); for a sentence in the middle where the voice gets even closer, write `[whispering]` in front of it (step 3's table).
   - **ASMR**: slow, much white space, and whispering, breathing and mouth sounds (`[kisses]`, also where the text spells it `啾`, step 2; how often each comes out is in step 3's table) outnumber the words; write it like an audio work, and write more `[pause …]` and sudden sounds. Among mouth sounds and trigger sounds, those not made by the mouth (brush, tapping, water) are sound effects and do not go into the script (step 2).
   - Left and right ear, near and far: each line the model gives has one channel only, and `mix` only joins them in order, with no left and right and no near and far adjustment. Some adult audio works have large differences between the left and right channels; this doc cannot do that, and if it is wanted it is done separately after dubbing.

   **Example**:

   ```
   [沈砚][shaky breath][whispering]别睁眼，[pause 0.6s][whispering, tender]今天已经很累了吧，[soft, low voice]把头靠过来一点。
   [pause 2s]
   [沈砚][whispering, warm]乖，晚安吻给你，[kisses][smiling, whispering]我就在这儿陪着你。[hums][sleepy, soft]睡吧。
   ```

   Done when: an audio work is one paragraph per line, with a direction cue at the start of each paragraph; for ASMR, the white space and sudden sounds are written into the script; sound effects are not in the script; you did not promise the user left and right ear or near and far.

7. **Dry run, dub, hand back: as in that doc.** The dry run (`--dry-run`), dubbing, reading the report and joining into one file follow that doc's steps (one-line steps 6 to 8, a-scene steps 6 to 9, narration steps 6, 7). At the dry run, check three more things: the cues and angle-bracket tags are in place; `notes` has no `tag_pair_split` (a pair of tags cut into two requests); the cut points are where you wrote long pauses, and the start of the next block has the name and the state. In the note handed back, write the places to listen to as that doc says, and add: the sentences where you wrote whispering or breathy voice (whether the voice was pressed down was not measured accurately on the model); the seams where long white space was cut.

   **Example**:

   ```
   [voice:shenyan][沈砚][low, amused]还装睡？[shaky breath][soft, smug]睫毛一直在抖，我都看见了。
   [voice:linwan][林晚][gasping][flustered, breathless]你……你什么时候凑这么近的？[sighs][soft, resigned]真拿你没办法。
   [voice:shenyan][沈砚][whispering]从你说想我的时候。[kisses][smiling, warm]现在，换你跟我说晚安。
   ```

   Done when: in the `--dry-run` plan the cues and tags are in place, there is no `tag_pair_split`, and the cut points are the ones you want; after the real dub `dub` exits 0; the note handed back lists the places to listen to.

## Common pitfalls

- **Whispering was written, but the voice was not pressed down.** `[whispering]` pressed a library voice down in 4 of 6 takes, and on another Chinese-speaking voice it did not (`models/scene3.md`「Non-verbal sounds: which writing comes out (2026-11-16)」「Breathy voice, whispering and gasping」). Write it; wrapping the sentence in `<whisper>` as well did not help on the library voice. If the pack has a reference segment spoken with a pressed-down voice, pick it for this scene (step 1; inference, not tested). If the user says it was not pressed down, change the reference tag as that doc says and dub again.
- **Spelling a sound out.** `啾`, `嗯`, `啊……`, `哈啊` in the script are spoken as syllables (`models/scene3.md`「Non-verbal sounds: which writing comes out (2026-11-16)」), and a cue in front of them does not turn them into the sound. Delete the words and write the sound's cue at that place (step 2): `[kisses]`, `[hums]`, `[moaning]`, `[panting]`, not `[moans]`, which speaks syllables that are not in the line.
- **Using `<soft>` or `[breathy, soft]` as breathy voice.** Neither showed more breathy voice in the measurements (`models/scene3.md`「Breathy voice, whispering and gasping」). For panting write a sudden sound such as `[panting]` and the state `[breathless]`.
- **A comma every two or three characters.** The same words came out 1.7 to 2.2 times as long for the whole sentence, in jerks (`models/scene3.md`「Breathy voice, whispering and gasping」). For slow, follow the entry "Speed follows the manner" of `models/scene3.md`「What to write」 (the slowing goes with the emotion where the manner of this spot changes; to slow a whole sentence use the speaking rate or `--speed`); do not add commas.
- **Using `……` as a pant or a pause.** It loses the words after it (`models/scene3.md`「Pause between lines」). Write a cue for a pant; write `[pause …]` for a pause.
- **Writing onomatopoeic words, actions or the scene in a cue.** `[嗯嗯啊啊]` may be spoken aloud; `[靠在他肩上]` ("leaning on his shoulder") cannot be heard. Write the two or three words for how it lands on the voice (`[breathless, trembling]`).
- **Sound effects written into the script.** `（床吱呀作响）` ("the bed creaks") would become a cue handed to the model through `dub`. Delete it; make sound effects separately.
- **After a long white space is cut, the second half changes state.** The next request does not carry the earlier cues: at the start of the line after the pause, rewrite the name and the state (step 5).
- **Writing past the threshold.** The tension of this doc stops at the door: kissing, whispering at the ear, panting until the words come apart. A passage that goes further is not written with this doc, and shouting is not written in it.
- **Writing the strongest from the very beginning.** There is no room to go up later, and the whole passage has one tone. Follow step 4 and go up one level at a time.

## Model notes used

All are in `models/scene3.md`:

- 「Breathy voice, whispering and gasping」: what was measured for whispering, `<soft>` and breathy direction cues on a voice that speaks Chinese, the readings for panting, a comma every two or three characters, and that no swallowed words were measured with expressiveness at 95 or 100 or with a sentence-final ellipsis and whispering together (steps 3, 4, pitfalls).
- 「What to write」: write concrete, audible things, two or three words, in English, no onomatopoeic words; volume words may bring in breathy voice (steps 2, 3).
- 「Where a cue is written and how far it reaches」: fix the state of each clause (its item "Set the state first, then write the cue.") and the `，[pause 0.6s]` of its item "Add a few more things when dubbing." (steps 3, 5).
- 「Sudden sounds and pauses」, 「Paired tags」: breaths and sighs written where they happen; whispering and softening a few words (step 3).
- 「Non-verbal sounds: which writing comes out (2026-11-16)」: which cue for a sigh, a breath, panting, a gasp, a hum, a moan, a kiss and whispering came out on the model's own voice and on a library voice, alone and in a line marked point by point; that a sound written as words is spoken as words; and that the judging hears that a sound came out but not which (steps 2, 3, 6, 7, pitfalls).
- 「Pause between lines」, 「Punctuation」: one pause in one request is at most about 0.75 seconds; the ways of writing that lose the next sentence; ellipses go between words (steps 2, 5).
- "Speed follows the manner" (an entry of 「What to write」) and 「Speed and pauses: conclusions from listening」: when a speed word is written (together with the emotion, where the manner changes) and when it is not (to slow a whole sentence, the speaking rate or `--speed`) (steps 3, 5).
- 「Readings from the first-page audition」, 「Good examples」: the stronger the cue, the more intensely it is acted; how to write a sentence that comes up and is then held back (step 4).
- 「Expressiveness」: the control parameter, the higher the value the more drama; the order of the three layers, that a voice with a fixed value is by default not given another, and the choice of value and the step of about 10 are there (step 4).
- 「Reference segments」: the way of acting follows the reference (step 1, pitfalls).
