# Task: write the text content of a new voice pack

You are the make-pack agent in the clean room. This directory holds everything you need to use; use nothing else:

- `attributes.json`: the attributes of the voice the user wants. `name` is the character's name (if there is one). `words` is the user's own words, given to you as they are. `language` is the language this voice will speak, which is not necessarily the language of `words`.
- `spec/README.md`: what to write in each field, how to write it, and what not to write. Read its "How to write each field" section first.
- `spec/fields.json`: the format of the three fields (`direction`, `sampleLines`, `designSource`); look here for the limits on length and number of items.
- `template/`: the blank template.

Note on language: the guidance section names and item names (`这个人是谁`, `身份：`, `缺` and so on) are format tokens of the pack format. They are written in Chinese exactly as they appear in `template/guidance.md`, whatever language the user speaks. Do not translate them. Glosses are given below where they come up.

## What to do

Write these files from `attributes.json` and put them in `output/` (create the directory if it does not exist):

- `direction.json`: you write `description`; copy `tags` as they are from `attributes.json`.
- `guidance.md`: the body of the dubbing guidance; the sections follow `template/guidance.md`.
- `sample-lines.json`: the sample lines.
- `card-line.txt`: the audition line (there is no template: UTF-8 plain text, the whole file is this one line). How to write it is in `spec/README.md`「Sample lines」. You may pick one of the sample lines you wrote.

For the language, follow `spec/README.md`「Language」.

You do not need to fill in `template/design-source.json`: the design source is supplied by the caller (see `spec/README.md`「Design source」).

## Ground rules

- Write only what you read from `attributes.json`, plus what you think of yourself. Do not look for or read the description, guidance, or lines of any existing voice pack, and do not ask the user or the agent that called you for them: the whole point of this step is that you have not seen them.
- If you have already seen the content of some voice pack (for example, this session installed it), stop, tell the user, and have a new session do this work.
- `words` is the user's request, not ready-made text: write according to what it means, and do not copy long stretches of it.
- The two sections `### 这个人是谁` (who this person is) and `### 换语言时怎么说` (what to say when the language changes) must be written, and every item in them must be written: write `缺` (missing) for anything `words` does not say. Any identity the user has stated goes into the item `- 身份：` (identity).
- After you finish, the agent that called you may forward, as they are, the user's answers about the items you marked `缺`. Treat them as the user's own words (the same as `words`), use them only to fill those items, and put them into `output/guidance.md`.
- The performance and lines content comes only from `words`: an item that `words` does not mention is left out as a whole line, and a section (voice, how to perform, lines) with no content is left out as a whole section. Do not invent performance details such as throat position or breathiness just to fill the space.
- Cues in square brackets are always written in English. The audition line begins with the character's name, `[<name>]` (`spec/README.md`「Sample lines」).
- When you finish, tell the calling agent which files are in `output/`. You do nothing else: making the pack and the duplicate check are done by the caller.
