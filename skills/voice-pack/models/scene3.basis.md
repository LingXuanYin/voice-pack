# Basis for scene3.md

Text moved out of `scene3.md`, word for word. In the doc, `[^bN]` marks the place each entry stood; putting an entry back in place of its anchor gives the doc as it was before. `at:` is the section the anchor is in.

## b1

at: scene3

```text
, read on 2026-11-04; the recommendation quoted for `drama_value` in "Expressiveness" was read again on 2026-11-08
```

## b2

at: scene3

```text
, a local copy read on 2026-11-03; the cue-writing styles (section "Cues") were checked against the model page again on 2026-11-06, and the technical report was read again on 2026-11-08
```

## b3

at: scene3

```text
, read on 2026-11-08
```

## b4

at: scene3

```text
, the version read on 2026-11-02 (commit `d953ab70`); the model-side code was checked once more on 2026-11-05, and entries that say so refer to that check
```

## b5

at: scene3

```text
 (2026-11-09, two real recordings, 5 of 6 passes said "clearly acting", 1 said "slightly put on")
```

## b6

at: scene3 > What it accepts and what it does not

```text
 Source: platform statement; for the 16 segments see "Limits of one request".
```

## b7

at: scene3 > What it accepts and what it does not

```text
 Source: platform statement.
```

## b8

at: scene3 > What it accepts and what it does not

```text
 Source: platform statement.
```

## b9

at: scene3 > What it accepts and what it does not

```text
 (platform statement: in a built-in voice)
```

## b10

at: scene3 > What it accepts and what it does not

```text
 (platform statement: clone prior generated audio)
```

## b11

at: scene3 > What it accepts and what it does not

```text
 Done once on 2026-11-06: a generated passage (11.3 seconds) was used as the reference to dub the audition line, and it produced sound as usual. How well it was acted and how close it is to the designed voice: nobody listened to it, and the effect is not tested.
```

## b12

at: scene3 > Cues

```text
 (vendor documentation: you can mix them freely in the same line)
```

## b13

at: scene3 > Cues

```text
 Source: requirement, raised on 2026-11-06 by the author of the "Good examples" below, in the words "what I said is not whether it was tested" and "use the model's abilities 'fully!!!'".
```

## b14

at: scene3 > Cues > Put the character name first

```text
 Readings: 2026-11-12, 3 designed voices (two female, one male), 3 versions each, the acted passage dubbed from the audition (expressiveness 80), 30 takes per version, 270 clips per group, measured by program (Praat, median fundamental frequency, compared with the reference; two other ways of reading checked it, no octave jump): with the name only on the line, 19 clips 3 or more semitones low, 6 clips 5 or more semitones low (at most 21 semitones low); with the name on both sides, 3 and 0; with the name on neither, 3 and 0. Each group is those 270 clips, in two batches of 135, and the two batches go the same way. Once the acted passage is dubbed low, it is the only reference of the formal pack: dub the audition line with it, and changing the take, the expressiveness or the reference text, or removing the cue, all stay low (one pack, 28 of 30 times), and so does writing the name on both sides (5 of 5 times). Nobody has listened to whether it is still the same person. Source: measured; that the two sides match is a requirement, raised on 2026-11-10 in the words "The annotation must be symmetric. The character name must also be marked".

Source: requirement, raised on 2026-11-10 by the author of the "Good examples" below, in the words "all scene3 synthesis must start with [character name] first" and "this requirement must go in the skill". The same day one person listened to the cross-language dubbing of four characters (an English reference speaking Chinese) and compared with and without the name; in the words "much better" (one round); it has not been compared separately for dubbing in a single language.

Source: requirement, decided on 2026-11-20, in the words "名字需要尽可能写完整名字（通用的大家都认识的）而不是用户或者agent自己起的那个" (in English: the name should be written as complete as possible, the commonly known one, not one the user or the agent made up). The same decision asks that the line and its reference carry the same name, and that an original character, which has no commonly known name, use the name its creator gave. A requirement decided on 2026-11-21, after a listening round, asks for the same when a scene of several people is dubbed as one request, in the words "听过了，合并的也补" (in English: listened to it, the merged ones too). Lines of one voice that are merged into one request are checked one by one in the same way; that part is an inference from the scene case, not in the words quoted above.
```

## b15

at: scene3 > Cues > Where a cue is written and how far it reaches

```text
 Source: vendor documentation (Put a direction in square brackets before the words it applies to); platform statement (Square-bracket cues act where placed).
```

## b16

at: scene3 > Cues > Where a cue is written and how far it reaches

```text
 Source: launch blog (Add new direction where the mood changes, and the read changes there; New direction partway through changes the read from that point); "Good examples" below.
```

## b17

at: scene3 > Cues > Where a cue is written and how far it reaches

```text
 Source: launch blog (same as the previous entry); Halloween blog (To take the same line further, direct its two halves separately); previous report (rather than relying on lengthy global prompts, we inject descriptive instructions at specific word or phrase positions); requirement, raised by the author of the "Good examples" below (the words are under 「What to write」). The demo program has a comment saying that the reference's acting overrides one short cue at the start (A single short prefix is often drowned out by the reference performance.): it is used only when re-acting (dubbing another version with one instruction), by repeating the same instruction before every sentence, with no measurement attached, so it is not used as a source.
```

## b18

at: scene3 > Cues > Where a cue is written and how far it reaches

```text
 Source: launch blog (New direction partway through changes the read from that point, same as the previous entry); the steps above are a procedure, not a reading.
```

## b19

at: scene3 > Cues > Where a cue is written and how far it reaches

```text
 (a writing example, not tested; the states were worked backward from the cues of that line in 「Good examples」)
```

## b20

at: scene3 > Cues > Where a cue is written and how far it reaches

```text
 This table used to have two more rows, `[fast, rushing]` (reading: in 5 of 6 it was slower instead) and `[slow, drawn out]` (reading: in the line that had it, characters per second dropped for all 3 takes); the version listened to under "Scope" below had them, kept as a record.
```

## b21

at: scene3 > Cues > What to write

```text
 Source: requirement, raised on 2026-11-08 by the author of the "Good examples" below, in the words "What concrete features does that accent have? How do the tones change, and how do you write that? If you just write a label saying accent, how would the model know?" "If you write a generalized accent in, haven't I told you not to treat the model as a trash can???" "And aren't all the other model skills the same logic???".
```

## b22

at: scene3 > Cues > What to write

```text
 Source: requirement, raised on 2026-11-09 by the author of the "Good examples" below, in the words "this wrong way of writing has to be explicitly forbidden, or whatever you write in is useless".
```

## b23

at: scene3 > Cues > What to write

```text
 Source: requirement, raised on 2026-11-10 by the author of the "Good examples" below, in the words "isn't it the case that square brackets are not for writing what not to do?".
```

## b24

at: scene3 > Cues > What to write

```text
 Source: vendor documentation (Write it the way you'd brief a voice actor: emotion, intent, pacing, or who the character is talking to).
```

## b25

at: scene3 > Cues > What to write

```text
 Source: technical report (A control is a short span in square or angle brackets, typically a few words); previous report (rather than relying on lengthy global prompts); for two side by side, Halloween blog (pair a delivery with a feeling, like [whispering][menacing]) and the technical report's examples `[clears throat][serious]`, `[softly][to herself]`; requirement, raised on 2026-11-06 by the author of the "Good examples" below, in the words "full, fine-grained, concise control; the control tags are not for writing a little essay, and the point is not to write nothing or to write little", and on 2026-11-08 the same person asked again "why put such a long thing in [] instead of several [] controlling fine points one by one???", which follows 「Good examples」.
```

## b26

at: scene3 > Cues > What to write

```text
 Source: requirement, raised on 2026-11-09 by the author of the "Good examples" below; these examples come from the entry where one person listened and said "a cliff-like improvement" (「Good examples」 third example below), in the words "d is the best and is a cliff-like improvement over the other cases, mainly because the voice was not affected, and it is natural"; the comparison was the same recording dubbing the same line, changing only the square brackets: English at 9 spots (this entry) beat Chinese at 9 spots, English at 4 spots, Chinese at 4 spots, writing none, and the wrongly written version.
```

## b27

at: scene3 > Cues > What to write

```text
 Source: vendor documentation (Write it the way you'd brief a voice actor: emotion, intent, pacing…; the scene example `[fast, nervous, stumbling over words]` (a quotation, longer than the 4-word limit; take its direction, not its length, same as the previous entry), `[slow, dangerously quiet]`).
```

## b28

at: scene3 > Cues > What to write

```text
 Source: measured, 2026-11-05, two items, judged by transcription (model judged), no person listened to this spot specifically: for `[小声，嘿嘿地笑，有点不好意思]` (quiet, laughing "hehe", a bit embarrassed), one transcription had an extra "嘿嘿" and the other transcription had "哎呀" at that spot, so it cannot be told whether it was laughed out or the characters in the cue were read aloud; for `[眼珠一转，凑近了，嘿嘿笑着，讨好地商量]` (eyes dart, leans in, laughing "hehe", wheedling), across two transcriptions three times in all, none had "嘿嘿".
```

## b29

at: scene3 > Cues > What to write

```text
 Source: technical report (typically a few words, see the previous entry); previous report (rather than relying on lengthy global prompts, same as above); launch blog (Add new direction where the mood changes, and the read changes there; example `[choked up, crying quietly] … [voice breaking] …`); requirement, raised on 2026-11-08 by the author of the "Good examples" below, in the words "why put such a long thing in [] instead of several [] controlling fine points one by one???".
```

## b30

at: scene3 > Cues > What to write

```text
 Source: measured, 2026-11-06, measured by program: an English reference (a recorded voice), the same audition line, four cues (`[quietly]`, none, `[calm]`, `[warm, relaxed]`) each dubbed with 3 takes, 12 clips in all, plus the one that prompted this comparison. In 3 of the 4 `[quietly]` clips the breathiness was clearly heavier (H1-H2 16 to 22 dB, the others 5 to 14; GNE and CPP also lower), loudness about 2.2 LU lower, pitch flatter; none of the other 9 showed it. Reference, audio format, and loudness were all ruled out as causes. With only 3 takes and about 14 items measured, none survived multiple-comparison correction (corrected p 0.055 to 0.086), so it counts only as a weak reading.
```

## b31

at: scene3 > Cues > What to write

```text
 Lead: the model judged whether it was acted well, 3 wins, 13 losses, 14 ties (p=0.021). Source: another measurement group from before 2026-11-04; the judge at the time was calibrated, but what it can judge is whether it was acted well, which is a lead (the Measured entry in 「How the source is written」).
```

## b32

at: scene3 > Cues > What to write

```text
 Lead: model judged 2 wins, 10 losses, 18 ties (p=0.039). Source: same as the previous entry.
```

## b33

at: scene3 > Cues > Sudden sounds and pauses

```text
 Source: vendor documentation (Put a sound or pause in brackets exactly where it should happen, such as a sigh, a laugh, a breath, or a short pause; example `I'm fine. [shaky breath] Really. [small laugh] Go on without me.`, two in one line).
```

## b34

at: scene3 > Cues > Paired tags

```text
 Source: vendor documentation (Wrap words in a paired tag … to change the delivery of those words only; example `I'm fine. Really. <whisper>Go on without me.</whisper>`, and one turn in a scene `[voice breaking, close to panic] It is going to <emphasis>blow</emphasis>.`).
```

## b35

at: scene3 > Cues > Paired tags

```text
 (vendor documentation: Directions and paired tags from this page work inside each turn)
```

## b36

at: scene3 > Cues > Language tags

```text
 Source: vendor documentation (Wrap a phrase in a language tag to switch language for those words only; Wrap only the words that change language; example `She looked at the menu and said <french>Je voudrais une table pour deux, s'il vous plaît.</french> The waiter smiled.`).
```

## b37

at: scene3 > Cues > Phoneme tags

```text
 (vendor documentation)
```

## b38

at: scene3 > Cues > Text in round brackets is read aloud

```text
 Source: platform statement.
```

## b39

at: scene3 > Cues > Good examples

```text

- Source: one case that a developer tested on this model before 2026-11-04 and judged to work well (she rated it about 80 points herself), copied as it was (`suprise` is the spelling in the original). Only this one case, no comparison, not a blind listen.
```

## b40

at: scene3 > Cues > Good examples

```text

- Source: only three places were deleted ("低声，", `[shaky breath]`, "，坚定"), everything else was left untouched, not a single character; one version of each was dubbed with the same pack and the same take, and the person listened to both and said the trimmed one was acceptable (80 points), without saying what was wrong with the original. The three were deleted together; what each one does was not listened to separately.
```

## b41

at: scene3 > Cues > Good examples

```text

- Source: the same reference segment dubbing the same line, only the square brackets changed, six versions with one clip each: no cues, a wrong way of writing (actions of the body, what the sentence is doing), Chinese at 9 places, English at 9 places (this one), English at 4 places, Chinese at 4 places. The listener said "d is the best, and compared with all the other cases it is a cliff-like jump better; mainly the timbre was not affected, and it is natural", and d is this one. The English at 4 places, with the same words dubbing another voice: "Good. But not that good. Usable". Each clip was listened to once.
```

## b42

at: scene3 > Cues > Speed and pauses: conclusions from listening

```text
 (requirement, raised by the author of 「Good examples」 above on 2026-11-09: "the current speech rate is not adjusted at all, it does not sound like a real person talking", "speech rate, intonation, gaps and so on are still a problem", and acceptance requires "all problems solved and quality solved too")
```

## b43

at: scene3 > Cues > Speed and pauses: conclusions from listening

```text
Her last words: "I think neither of the two is as good as just going with Q0", "Then let's just go with Q0 for now. It can't be tuned any further, so leave it like this". 
```

## b44

at: scene3 > Cues > Speed and pauses: conclusions from listening

```text

Source: one person listened (the author of 「Good examples」 above), two pages on 2026-11-09, each clip listened to once. Two characters, one group each, both voices designed; the reference was the audition that comes straight out of the design step, scene3, take 1, expressiveness 100. Only these two voices, in Chinese, were listened to; other voices and languages are inference.
```

## b45

at: scene3 > Cues > Cross-language and accent

```text
 (inference; one person listened in two cases: 2026-11-05, an English reference speaking Chinese, no cue written, 1 of 4 voices had it audibly; 2026-11-06, a Japanese reference speaking English, "just a slight accent")
```

## b46

at: scene3 > Cues > Cross-language and accent

```text
 (so for the few voices listened to; for other voices it is inference)
```

## b47

at: scene3 > Cues > Cross-language and accent

```text
 (requirement, raised by the author of 「Good examples」 above on 2026-11-10, her words: "Didn't we already do the no-accent path before? Write it inside [], then use the target language for the text; with an accent it is the same operation")
```

## b48

at: scene3 > Cues > Cross-language and accent

```text
 (requirement, said on 2026-11-17, original words "The key point is that the voice pack must not do the brain's job; a mouth cannot speak on its own")
```

## b49

at: scene3 > Cues > Cross-language and accent

```text
 Source: requirement, raised by the author of 「Good examples」 above on 2026-11-06, her words: "Don't go through flash first; use scene to produce the reference in this language first. If the user later specifically mentions an accent problem in this language, then go through flash", and then she added: "qwen has to be kept as an option"; how to describe this item to the user was also decided by her: "Read it through qwen first, then clone: you can try this if you want to tone down the accent", with nothing added about how well it works; giving both segments together with the original first when taking this item was also her decision, her words: "Put the original language first. This doesn't need testing, just do it. Give both segments of the original voice together."; the dubbed one is not left to the user to pick, her words: "Don't let the user pick." (in the reading under 「Two segments given together」 below, compared against the Japanese reference, the two orders come out about the same).
```

## b50

at: scene3 > Cues > Cross-language and accent

```text

Readings (2026-11-10, one person listening): an English reference speaking Chinese; this version was settled after comparing several ways of writing, her words: "I think 庚 is better, but it is not a cliff-like jump better, and part of it has timbre leakage", "They each have their own timbre leakage and unnaturalness. Forget it, I'll stop listening, just go with the way 庚 is written", and 庚 is this version. Only the two values `zh` and `en` were listened to, and only one direction, an English reference speaking Chinese; same-language lines and other languages were not listened to, other languages are inferred from the same way of writing.

The reference half (name at the start, language at the end) is inferred from the technical report; the report does not say whether this can be written on the reference side: the language cue in the technical report (arxiv 2610.18010v2 appendix C, figure 7, table 10) is `[language: xx]` at the end of the line, marks the main language of this request, is not read aloud, and in the examples the reference text is always a plain verbatim transcript. Neither the vendor documentation nor the technical report describes putting a name at the start.

Origin (all requirements, raised by the author of 「Good examples」 above on 2026-11-10, found by listening round after round): first the name added at the start, her words: "Going directly cross-language, adding [character name] at the start is much better"; then both sides marked, with the language cue written in the language itself, her words: "Instead of writing [standard Mandarin], just [普通话], what is there to choose here. Also, in the annotated script of the reference audio the original language must be stated in the original language too, for example [british english] and the like. The annotation must be symmetric. The character name must also be marked, likewise in the original language", and after listening: "The electronic buzz is gone. The timbre has some loss. And there is still an accent. Change it, cross annotation. In the reference audio script use these two tags in the target language, and change the target script too"; after the cross annotation was corrected once ("Shouldn't the start of the reference annotation be: [哈利·波特][英语（英国）]?"), "The accent is much better, but the timbre loss is still a bit large"; asked again about the way of writing, "Those two tags definitely need to be written, but maybe there is a better way to write them, or the position is wrong, or the wrong tag is used?", and only after checking the technical report did the present version come out.
```

## b51

at: scene3 > Cues > Cross-language and accent

```text
, the source there is a requirement
```

## b52

at: scene3 > Cues > Cross-language and accent

```text
; why this is required: see the group 2026-11-08 "How densely the dialect is written in the line" below, which is inference
```

## b53

at: scene3 > Cues > Cross-language and accent

```text
: this is the user's requirement, not a reading
```

## b54

at: scene3 > Reference segments

```text
 (platform statement)
```

## b55

at: scene3 > Reference segments

```text
 (another set of measurements from before 2026-11-04)
```

## b56

at: scene3 > Reference segments

```text
 (platform statement)
```

## b57

at: scene3 > Reference segments

```text
 (inference; only the cases below were listened to)
```

## b58

at: scene3 > Reference segments

```text
 (platform statement: optional transcript)
```

## b59

at: scene3 > Reference segments

```text
 (requirement, raised on 2026-11-09 by the author of 「Good examples」 above)
```

## b60

at: scene3 > Speaker markers

```text
, checked in the model-side code on 2026-11-05
```

## b61

at: scene3 > Speaker markers

```text
 Source: vendor documentation (names such as `Narrator:` in a script are only for people to read, and are replaced by speaker tags in the request).
```

## b62

at: scene3 > Speaker markers

```text
 Source: vendor documentation (references correspond to speakers in order); the inference code matches them one to one.
```

## b63

at: scene3 > Speaker markers

```text
 Source: vendor documentation (Directions and paired tags from this page work inside each turn; example `<|speaker:0|>[calm, measured storyteller voice] The ship had been silent for three days.<|speaker:1|>[low, gravelly, tired but in control] Status report.`); the technical report's example `<|speaker:0|> [whispering] …`.
```

## b64

at: scene3 > Speaker markers

```text
 Source: the 2026-10-29 measurement recorded in a comment in the inference code (that code itself puts each turn on one line; the comment does not say how "correct" was judged, and nobody has checked).
```

## b65

at: scene3 > Speaker markers

```text
 Source: platform statement, inference code.
```

## b66

at: scene3 > Pause between lines

```text
 Source: measured, 2026-11-05, measured by program; the method of measuring is below the table.
```

## b67

at: scene3 > Pause between lines

```text
 Source: inference code (not the model itself).
```

## b68

at: scene3 > Punctuation

```text
 (words from the requirement, not a measured conclusion)
```

## b69

at: scene3 > Punctuation

```text
 Source: requirement, raised on 2026-11-07 by the author of 「Good examples」 above, in the words "The model is actually sensitive to punctuation, consider optimizing it. Not for standard grammar, but for the speech effect."
```

## b70

at: scene3 > Punctuation

```text
 (requirement, raised on 2026-11-09 by the author of 「Good examples」 above after listening to one pair, in the words "A single question mark is more like interrogating, `?!` is more like surprise, doubt and so on")
```

## b71

at: scene3 > Expressiveness: `drama_value`

```text
 Source: requirement, raised on 2026-11-08 by the author of 「Good examples」 above, at 21:13 (UTC+8) in the words "Consider making full use of this parameter to improve expressiveness / fit to the situation / context / timbre and so on. It is a model-level control parameter", and at 21:3x again "the effect is just what the name says, drama value"; platform statement, original text below.
```

## b72

at: scene3 > Expressiveness: `drama_value`

```text
 (platform statement)
```

## b73

at: scene3 > Expressiveness: `drama_value`

```text
 (the version of the inference code read on 2026-11-02)
```

## b74

at: scene3 > Expressiveness: `drama_value` > How to choose the value

```text
 Source: requirement (three layers, later overriding earlier, the global value being the whole voice's value, the value not changing within a scene); for how the order is written, see `references/dub.md`.
```

## b75

at: scene3 > Expressiveness: `drama_value` > How to choose the value

```text
 Source: requirement (move by about 10).
```

## b76

at: scene3 > Expressiveness: `drama_value` > How to choose the value

```text
 Source: requirement, the author of 「Good examples」 above said on 2026-11-10 "Drama cannot be hard-coded. It still has to be tuned per character, the preset included, and a value that fits the character needs to be tuned out first.", replacing the fixed 80 that this passage used to say; carrying this value into the default preset is also a requirement of the same day.
```

## b77

at: scene3 > Expressiveness: `drama_value` > How to choose the value

```text
 Source: requirement, the author of 「Good examples」 above said on 2026-11-08 23:2x (UTC+8) "every line follows this"; not giving another by default, giving another needing a reason, and not declaring in a setup by default are requirements; the exception of the default preset carrying a value is a requirement of 2026-11-10.
```

## b78

at: scene3 > Expressiveness: `drama_value` > How to choose the value

```text
 Source: starting from the character and not hard-coding is a requirement, the author of 「Good examples」 above said on 2026-11-10 "Drama cannot be hard-coded. It still has to be tuned per character", replacing the default 70 written before; adjusting in small steps is a requirement, the author of 「Good examples」 above said on 2026-11-09 00:1x (UTC+8) "Can the drama value be adjusted carefully?"; about 10 per step is a requirement.
```

## b79

at: scene3 > Expressiveness: `drama_value` > How to choose the value

```text
 Source: giving the value by situation, context, and timbre is a requirement, the sentence of 2026-11-08 21:13 (UTC+8) quoted above; which direction to adjust, by how much, and how to keep it coherent across what comes before and after are inference, not tested.
```

## b80

at: scene3 > Expressiveness: `drama_value` > How to choose the value

```text
 (inference, not tested)
```

## b81

at: scene3 > Expressiveness: `drama_value` > How to choose the value

```text
 Source: the platform statement says the effect of this value is subtle, and for a clear change you rely on the cues in the text (the recommendation quoted above: `the effect is subtle, so use text cues for a clear change`); giving both is a requirement, the sentence of 2026-11-06 quoted at the start of the 「Cues」 section, and the sentence of 2026-11-08 21:13 (UTC+8) above; how much better using both together is than using one alone has not been tested.
```

## b82

at: scene3 > Expressiveness: `drama_value` > How to choose the value

```text
 Source: the order in which `dub` takes the value, `references/dub.md`; lines with different values not entering the same request, explicitly giving one value to merge, and not taking an average are requirements.
```

## b83

at: scene3 > Limits of one request

```text
 Source: requirement, raised on 2026-11-06 by the author of 「Good examples」 above, in the words "In the skill, set a soft limit: anything over 1000 is split into segments, not one line at a time." The cause was that she listened to an English narration (2763 characters counting spaces, dubbed in two requests) and said of the second half "the timbre is not great. It seems to have suddenly changed." Whether 1000 is better than other numbers was not tested and it was decided not to test it, in her words "no need to test this, just set it like that"; the reading in 「Speaker markers」 for the 2026-11-06 two-person scene compares merged against separate, and that scene was far under 1000 characters and is not the basis for this number.
```

## b84

at: scene3 > Limits of one request

```text
 (checked in the model-side code on 2026-11-05)
```

## b85

at: scene3 > Limits of one request

```text
 Source: the version of the inference code read on 2026-11-02 (the comment records a measurement of 2026-10-29), in which there is also no character limit, matching the check of 2026-11-05; the platform statement says "at most about 14 minutes per request".
```

## b86

at: scene3 > Limits of one request

```text
 (inference code, the version read on 2026-11-02)
```
