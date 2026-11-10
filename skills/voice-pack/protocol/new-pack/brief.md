# 任务：为一个新的音色包写文字内容

你是净室里的做包 agent。这个目录里只有你要用的东西，别的一概不用：

- `attributes.json`：使用者想要的声音的属性。`name` 是角色的名字（有的话）。`words` 是使用者自己的话，原样给你。`language` 是这个声音要说的语言，不一定是 `words` 的语言。
- `spec/README.md`：每个字段写什么、怎么写、不能写什么。先读它的「每个字段怎么写」。
- `spec/fields.json`：三个字段（`direction`、`sampleLines`、`designSource`）的格式，字数和条数的上限看它。
- `template/`：空白模板。

## 做什么

照 `attributes.json` 写这几个文件，放进 `output/`（没有这个目录就新建）：

- `direction.json`：`description` 由你写；`tags` 原样抄 `attributes.json` 里的。
- `guidance.md`：配音指引的正文，小节照 `template/guidance.md`。
- `sample-lines.json`：示例台词。
- `card-line.txt`：卡片试听那一句（没有模板：UTF-8 的纯文字，整个文件就是这一句），写法见 `spec/README.md`「示例台词」那一段。可以从你写的示例台词里挑一句。

语言照 `spec/README.md`「语言」。

`template/design-source.json` 不用填：设计来源由调用方给（见 `spec/README.md`「设计来源」）。

## 规矩

- 只写你从 `attributes.json` 读到的，加上你自己想的。不去找、不去读任何现有音色包的描述、指引、台词，也不向使用者或调用你的 agent 要它们：这一步的全部意义，就是你没有见过。
- 要是你已经见过某个音色包的内容（比如这个会话装过它），停下来，告诉使用者，换一个新会话来做。
- `words` 是使用者的要求，不是现成的文字：按它的意思写，不要大段照抄。
- 「这个人是谁」「换语言时怎么说」两节必须写，每项都写，`words` 没说的写 `缺`；使用者说过的身份写进「身份」。
- 演法和台词只从 `words` 里来：`words` 没说的那一项整行不写，音色、演法、台词三节没有内容的整节不写。不为了写满，编喉位、气声这类演法。
- 方括号里的提示一律写英文；卡片那一句开头写角色名 `[<名字>]`（`spec/README.md`「示例台词」）。
- 写完告诉调用你的 agent：`output/` 里有哪几个文件。别的不用做：做包和查重由它来做。
