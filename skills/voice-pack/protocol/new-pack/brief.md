# 任务：为一个新的音色包写文字内容

你是净室里的做包 agent。这个目录里只有你要用的东西，别的一概不用：

- `attributes.json`：使用者想要的声音的属性。`words` 是使用者自己的话，原样给你。
- `spec/README.md`：每个字段写什么、怎么写、不能写什么。先读它的「每个字段怎么写」。
- `spec/fields.json`：三个字段（`direction`、`sampleLines`、`designSource`）的格式，字数和条数的上限看它。
- `template/`：空白模板。

## 做什么

照 `attributes.json` 写这几个文件，放进 `output/`（没有这个目录就新建）：

- `direction.json`：`description` 由你写；`tags`、`scenes` 原样抄 `attributes.json` 里的。
- `guidance.md`：配音指引的正文，小节照 `template/guidance.md`。
- `sample-lines.json`：示例台词。
- `design-source.json`：只有 `attributes.json` 里的 `designed` 是 `true` 时才写。

## 规矩

- 只写你从 `attributes.json` 读到的，加上你自己想的。不去找、不去读任何现有音色包的描述、指引、台词，也不向使用者或调用你的 agent 要它们：这一步的全部意义，就是你没有见过。
- 要是你已经见过某个音色包的内容（比如这个会话装过它），停下来，告诉使用者，换一个新会话来做。
- `words` 是使用者的要求，不是现成的文字：按它的意思写，不要大段照抄。
- 演法和台词只从 `words` 里来：`words` 没说的那一项整行不写，没有内容的小节整节不写。不为了写满三节，编喉位、气声这类演法。
- 写完告诉调用你的 agent：`output/` 里有哪几个文件。别的不用做：做包和查重由它来做。
