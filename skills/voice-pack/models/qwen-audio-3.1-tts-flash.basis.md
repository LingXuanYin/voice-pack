# Basis for qwen-audio-3.1-tts-flash.md

Text moved out of `qwen-audio-3.1-tts-flash.md`, word for word. In the doc, `[^bN]` marks the place each entry stood; putting an entry back in place of its anchor gives the doc as it was before. `at:` is the section the anchor is in.

## b1

at: qwen-audio-3.1-tts-flash

```text
; the platform declarations in this file were read on 2026-10-29
```

## b2

at: qwen-audio-3.1-tts-flash > What it accepts

```text
 Source: platform declaration.
```

## b3

at: qwen-audio-3.1-tts-flash > What it accepts

```text
 Source: vendor documentation (this model's parameter table).
```

## b4

at: qwen-audio-3.1-tts-flash > What it accepts

```text
 Source: the vendor's voice design guide.
```

## b5

at: qwen-audio-3.1-tts-flash > What it accepts

```text
 Source: platform declaration (The same seed does not reproduce the same audio).
```

## b6

at: qwen-audio-3.1-tts-flash > Dimensions of a description

```text
 Source: the vendor's voice design guide (original text read on 2026-11-07; this model is among the models it supports).
```

## b7

at: qwen-audio-3.1-tts-flash > How to write a description

```text
 (source: requirement, see that item)
```

## b8

at: qwen-audio-3.1-tts-flash > How to write a description

```text
 The source for writing only the timbre and not the manner of speaking: on 2026-11-09 one person listened (settled), to two characters (a 50-year-old ship captain and a 60-year-old blacksmith, both male voices), a pair for each, all auditions straight out of the design step, each requested only once, not picked: A is the original way of writing (a description of several sentences that wrote the manner of speaking above; the audition text also in the original way), and B changes both (the description writes only the timbre, the original text is in "Example descriptions" below; the audition text changed to the way a person says it face to face, see "Design audition text"). Both B were better than A; the blacksmith's B was better (nobody asked what it was still missing), and the captain's B was still not enough (the problem the listener picked: the lines do not sound like something a person says, the rhythm drags, the pauses are odd). The two changes were made together, and the two cells that changed only the description or only the audition text were not listened to, so which one did the work cannot be separated: "changing only the description would also be better" is an inference. Only these two Mandarin-speaking, middle-aged and older male characters were listened to; that young, female, accented, or other-language characters should be written the same way is also an inference.
```

## b9

at: qwen-audio-3.1-tts-flash > How to write a description

```text
 Source: measured on 2026-10-30, 4 voices per way of writing, model-judged (only asking whether it resembles the person the character's materials describe; the age heard, nobody has checked it): of 4 with the original way of writing, 3 were too young, and with the pitch changed to "medium", the features changed to "round", and the purpose changed to "audiobook" it was still 3, with "pitch rather low" 4, and with about 28 years old written 1. It did not pass the trap check, and only young female voices were tested.
```

## b10

at: qwen-audio-3.1-tts-flash > How to write a description

```text
 This item is an inference, and nobody has listened to it: the lead is another measurement of 2026-10-25, on the previous design model, where the model judged whether it sounds like reading aloud (it judges whether it is affected, see the measured item in `scene3.md`「How the source is written.」): with words like "讲故事时带一点戏剧性" (a little dramatic when telling a story) in the description and lines in the old, written-language tone, 7 of 16 answers said "reading aloud"; after it was changed, 0 of 30. On this model it carries no weight.
```

## b11

at: qwen-audio-3.1-tts-flash > How to write a description

```text
 Source: the vendor's voice design guide.
```

## b12

at: qwen-audio-3.1-tts-flash > How to write a description

```text
 (source: requirement, said on 2026-11-09, in answer to exactly this item: "Q5 行。但是这个只影响配音相关的对吧", "Q5 fine. But this only affects dubbing, right?")
```

## b13

at: qwen-audio-3.1-tts-flash > How to write a description

```text
 (measured on 2026-10-30)
```

## b14

at: qwen-audio-3.1-tts-flash > Design audition text

```text
, requirement, said on 2026-11-17, original words "The key point is that the voice pack must not do the brain's job; a mouth cannot speak on its own"
```

## b15

at: qwen-audio-3.1-tts-flash > Design audition text

```text
: Source: on 2026-11-09 one person listened (the first item of "How to write a description", settled): both changes were better than the original, the captain's was still not enough and is not a model to copy (`references/character-voice.md`, same section); the audition text and the description were changed together, so which one did the work cannot be separated, and "changing only the audition text would also be better" is an inference. Only two Mandarin-speaking, middle-aged and older male voices were listened to; that young, female, accented, or other-language voices should be written the same way is also an inference. The earlier lead is the measurement of 2026-10-25 (the same as the item "Do not write words like reading aloud or announcing" in "How to write a description", model-judged whether it sounds like reading aloud), which carries no weight on this model.
```

## b16

at: qwen-audio-3.1-tts-flash > Design audition text

```text
 Source: the run of 2026-10-30 and 31: of 4 audition texts with "哎呀", "嘛", "就行啦" (interjections and particles), 3 were said to be too young; model-judged, the age heard, nobody has checked it; only a young female voice was tested, and the description was in the old way; the two ways of writing (with and without filler words) were not compared on a young female voice.
```

## b17

at: qwen-audio-3.1-tts-flash > Design audition text

```text
 (inference: only one character on the first page of auditions was listened to, by one person, `scene3.md`「Reference segments」)
```

## b18

at: qwen-audio-3.1-tts-flash > Fallback when scene3 is unavailable

```text
 Inference, not listened to side by side.
```

## b19

at: qwen-audio-3.1-tts-flash > Fallback when scene3 is unavailable

```text
 (inference: the platform declaration, plus the model did not judge any effect, a lead)
```

## b20

at: qwen-audio-3.1-tts-flash > Fallback when scene3 is unavailable

```text
 Source: measured, run on 2026-11-10 in a dev environment where another platform connects voice packs; one phoneme tag in a line was read as a stretch of noise; only this once, and who judged it was not recorded.
```

## b21

at: qwen-audio-3.1-tts-flash > Fallback when scene3 is unavailable

```text
 Source: platform declaration (the lower limit stated when another platform connected this model for dubbing; when the service rejects, what it says is "requires input of at least N Unicode code points"); "merge into the previous or next line" is a requirement, a general way of writing said on 2026-11-12.
```

## b22

at: qwen-audio-3.1-tts-flash > Fallback when scene3 is unavailable

```text
: measured on 2026-10-28 on the vendor's interface directly, 2.5 seconds was rejected and 3.0 seconds was built
```

## b23

at: qwen-audio-3.1-tts-flash > Fallback when scene3 is unavailable

```text
 (inference)
```
