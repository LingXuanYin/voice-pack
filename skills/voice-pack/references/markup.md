# Script markup

This is a reference for the base part; section 4 of `SKILL.md` points here. The list of markers is in `vocab/markup.json`; the exact syntax and the parser are in the script markup parser in `tools/`.

There are only three kinds of script markup, and all three are handled by the base part itself (where to cut, which pack to use, how long a silence to insert when joining):

| Syntax | Effect |
|---|---|
| `# 标题` | Start of a chapter (the heading text is the chapter title; `标题` means "title") |
| `[pause 0.6s]` | A pause, in `s` or `ms`; if the duration is omitted, the default is used |
| `[voice:<voice>]` | From here on, switch to this voice (a pack name or pack ID, case-insensitive); it applies until the next voice marker or the end of the chapter (it does not cross chapters; the next chapter goes back to the first pack); `[voice:]` (name left empty) goes back to the first pack, that is, the voice at the start of the script |

Any other square-bracket content is a **cue**: a "how to say it" written for the model. It stays as it is in the position where it is written, goes to the model together with the text, and is not spoken.

| Syntax | Effect |
|---|---|
| `[sad and surprised]`, `[hushed voice]`, `[crying quietly]` | Acting direction: written where the delivery changes, and effective from there on; one line can have several, each two or three words, saying the emotion or delivery at this point, not written as a sentence (`models/scene3.md`「What to write」); always written in English, whatever language the line is in. `dub` does not interpret it and does not change it |
| `[sighs]`, `[small laugh]`, `[shaky breath]` | A momentary sound: written at the position where it happens (`models/scene3.md`「Sudden sounds and pauses」) |
| `[slow]`, `[fast]`, `[emphasis]`, `[spell]` | They used to be markers; now, if written, each is an acting direction, handed to the model as it is, and `unit.speed` is not changed. A square-bracket one is an acting direction and applies from there on; to slow down only a few words write `<slow>…</slow>`, and to stress one word write `<emphasis>…</emphasis>` ("Angle-bracket tags" below) |
| `（耳语）`, `*笑*`, `【叹气】`, `(angrily)` | Stage directions (the Chinese examples mean "whisper", "laugh", "sigh"): before sending, they are replaced with an English cue of the same meaning (`[whispering]`, `[laughs]`), kept in the original position, and the words inside the brackets are not spoken; one that only says fast or slow (`（慢慢地）`, "slowly") does not get a cue. One that reads as a pause (`（停顿 2 秒）`, "pause 2 seconds"; `（沉默）`, "silence") is still a pause and is not written into the text; a momentary sound such as drawing a breath or coughing (`（深吸一口气）`, "take a deep breath"; `*coughs*`) is not a pause and is replaced with a cue all the same (`[deep breath]`, `[coughs]`). If the lexicon does not recognise it, the words inside the brackets are put into square brackets as they are, and a Chinese one you change into English yourself. A line with only a cue and no words (a line that contains only `（生气）`, "angry") has its cue attached to the start of the next line of the same voice. `dub` treats every bracket of 30 characters or fewer (full-width and half-width round brackets, `【…】`, and `*…*` that touches the words) as a stage direction: it is replaced with a cue and not spoken; if there is not a single word from the lexicon inside the brackets, the planned `notes` has an `unrecognized_directions` entry that lists it (one that contains a word from the lexicon is likewise not spoken, and is listed only when it is not in English, because it goes out as Chinese: `（笑话比赛）`, "joke contest", contains 笑, "laugh", and is listed; `(he smiles at her)` is not). One longer than 30 characters is body text, and is spoken brackets included. If the words inside the original brackets are to be spoken, first change it to a form without brackets. The rules are in `references/dub.md`「How a line becomes synthesis」step 2. The asterisks must touch the words: `3 * 4 * 5`, `* 第一项 *` at the start of a line, and `* 笑 *` with spaces on both sides, where there is whitespace between the asterisk and the words, are not stage directions and are spoken as they are |

## Angle-bracket tags

Angle brackets hold **text**, not markup and not a cue: `dub` hands it to the model as it is, by position. The dubbing model recognises these kinds (syntax, where to use them, and readings are in `models/scene3.md`「Cues」):

- Paired tags, which affect only the words they enclose: `<whisper>别出声</whisper>` (whisper; the enclosed words mean "don't make a sound"), `<emphasis>…</emphasis>` (stress), `<slow>…</slow>` (slow down) ... all seven are in `models/scene3.md`「Paired tags」.
- Language tags, which make the few enclosed words be in that language: `<french>croissant aux amandes</french>`, `<japanese>ありがとう</japanese>`.
- Phoneme tags, which are spoken as the phonemes written, and the original words are not written: in English one tag per word, in Chinese one tag per syllable (`银行` ("bank") is written as `<|phoneme_start|>yin2<|phoneme_end|><|phoneme_start|>hang2<|phoneme_end|>`). For a word the pack's pronunciation lexicon gives phonemes for, when the environment declares `phoneme-markers`, `dub` writes it as this kind of tag for you (`references/dub-details.md`「Pronunciation lexicon」); for a word the lexicon does not cover, write it yourself.

The base part does not change them and does not cut through them:

- The pronunciation lexicon does not touch tag names or the phonemes inside phoneme tags; the words enclosed by a paired tag are words to be spoken, and are replaced as usual.
- When a line is too long and must be cut into several requests, a pair of tags together with the words it encloses, and a phoneme tag, stay whole in one request. For a pair of tags together with its enclosed words that is longer than the limit of one request, it is cut inside as usual, and the pair of tags is added at both ends of each piece (`<soft>甲。乙。</soft>` is cut into `<soft>甲。</soft>` and `<soft>乙。</soft>`; the two characters 甲 and 乙 are placeholders for "A" and "B").
- When recognising what language a sentence is in, the letters of tag names and phonemes are not counted (`<whisper>` or `chong2` in a Chinese sentence does not get it recognised as English), and the words in another language enclosed by a language tag are not counted either (`<japanese>ありがとう</japanese>` in a Chinese sentence does not get it recognised as Japanese).
- When splitting sentences, joining two passages, and writing pauses into a request, look at the words inside through the tag: `<whisper>快走！</whisper>` ("Go, quick!") ends with an exclamation mark.
- When a pair of tags is written on one line, do not write a pause, `[voice:]` or a chapter heading in the middle: `dub` may cut the request at these places, and the tag would be split across two requests. If it was split, the planned `notes` of `--dry-run` has a `tag_pair_split` entry that lists which pieces lack which end.
- Exception: when the environment declares only `phoneme-in-text` (without `phoneme-markers`) and the sentence uses pinyin phonemes from the pronunciation lexicon, the whole sentence is converted to SSML, and the angle-bracket tags in the sentence are also escaped, so they do not reach the model. For a sentence that needs tags, write the words the lexicon covers as phoneme tags yourself. An environment that declares `phoneme-markers` has no such exception: the lexicon's phonemes are written as phoneme tags, and the other tags in the sentence still reach the model.

The pronunciation lexicon replaces only text outside cues, markers and angle-bracket tags; what is inside square brackets is left alone.
