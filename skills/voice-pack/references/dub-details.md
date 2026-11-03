# 用音色包配音和变声：主路用不到的细则

这一份是 `references/dub.md` 挪出来的：下面几节是主路用不到的细则，原处留了一行指针。配一段台本、几个角色的一场戏、出成品这几条主路，碰到下面的情况才读对应的一节：有读音词表，有增强件，句子续接、变速或换人处的静音（「拼接的细则」），失败要重做（「失败和重做的细则」）。变声和唱歌、自己的适配器不在这几条路上，要查时再读。

## 读音词表

4. **读音词表**：包根目录的 `lexicon.pls`（W3C Pronunciation Lexicon，PLS），写法见 `make-pack-details.md`「读音词表」。只换要说的话里的词，台本标记原样保留。`<alias>` 照做。拼音音素（字母表 `x-pinyin`）只在环境声明了 `phoneme-in-text` 时才用：句子里用上的记在报告的 `lexicon.phonemes` 和那一句的 `phonemes` 里，并从 `unapplied` 去掉；没用上的、字母表不认的，报在 `lexicon.unapplied`（`reason` 是 `phoneme`）；环境没声明的，音素一律是 `reason: phoneme`；环境声明了、音节数或写法对不上的，是 `reason: phoneme_format`。
只有清单的 `files` 列着 `lexicon.pls` 才读：直接改已装的包里的这个文件，清单没列，就当没有词表，报告里 `applied`、`unapplied` 都空。改读音要发新版本，做法见 `make-pack.md`。

## 增强件

6. **增强件**：包里服务 `voice-cloning` 的增强件，递给能力。环境认识对应的模型就用上（报告 `enhancers.used`），不认识就照常生成，`enhancers.statement` 是 `enhancers_not_used`，并附上包的验证记录，让人知道当前环境下效果会差多少。

## 拼接的细则

- 每一句的 `pauseBeforeMs` 挂在句首、`pauseAfterMs` 挂在句末，各按毫秒插静音，不封顶。续接的句子（`join` 为 `continue`，接着下一句说）也一样：`pauseAfterMs` 是 0 就不插；以「，、；：」结尾的续接处，`pauseAfterMs` 是 500（配音定的，常量在 `lib/pause-in-request.mjs` 的 `JOIN_PUNCTUATION_PAUSE_MS`）。合成能力收 `continues` 的，续接的那一段传 `continues: true`，不到最短字数补「，」，句末补「。」。
- `joined` 的段（一行话里的停顿并进了一次请求，文字里写着 `<break>`，或者靠标点；声明了 `cue-in-text` 的环境，一行里的笑、叹气也写在文字里它所在的位置，一行不在那里切开）是一段音频：里面的停顿已经在音频里，不再插静音，只看它的头和尾的 `pauseBeforeMs`、`pauseAfterMs`。只有声明了 `pause-in-text` 或 `cue-in-text` 的环境会有这种段；都没有声明的，报告里没有 `joined`。试运行里并起来的那一截，`pick.directions` 列着每个成员的舞台提示。
- `speed` 为 0.85（放慢）、1.15（加快）的，拼接的人自己变速：合成能力不收语速。`speed` 为 null 表示台本没有语速要求（不是 1.0）。`join` 只在句子被标记切开时出现（值是 `continue`）；没有这个键，这一句不接着下一句说。
- **换人处的静音**（`mix` 做）：相邻两句的 `pack` 不同（换了人）时，上一句尾、下一句头的静音各削到 50 毫秒，再插这一处标的停顿，没标的约 100 毫秒。不削的话，合成句子头尾的静音相加，换人处会停好几百毫秒，比多数对话的换人间隔长。同一个包接着说的不削；整句低于 -40 dBFS（每 10 毫秒量一次）的不削，报告里记一条 `silent_unit`。

## 失败和重做的细则

报错的 `details.action` 是 `download` 的，任务其实已经做完：报错里的任务号（`details.taskRunId`）用来取结果（适配器说明里写明怎么取），不要重做，重做会再计一次费。输出里打印的重做命令带着这次的适配器（`--adapter`、`--adapter-option`）和标签、说明、`--max-chars`、`--concurrency`，照着原样再跑就行。文字被拒的句子（`details.textRejected`，只和这一句的文字有关，换一句就成）也记成 `failed`，只记这一句，别的照常做，不重试，因为换一句才会有不同的结果。调用之前就查出来的（文字空白、太长、有处理不了的字，错误码 `capability_input_invalid`）不计数；服务商拒的，连着 3 句、还没有一句成功，就和别的错一样停下来（错误码 `dub_text_rejected`，`stoppedBy` 的 `details.rejected` 写明被拒的句子）：这种情况多半是参考或别的输入被拦了，每一句都会这样被拒，停下来才不白花钱。别的错（401、参数不对、缺能力、缺运行时……）直接停下来，不再开始新的句子，已经做好的文件和一份写着 `stoppedBy` 的 `dub.json` 留着。401 说明授权有问题：先让使用者处理好，再接着做（同一句再发还是 401）。

## 变声和唱歌

**变声和唱歌**：`node cli.mjs convert <包目录> <音频文件> --out <文件>`；`--singing` 是唱歌（输入要是人声分轨，没有伴奏）。说话用 `voice-conversion`，唱歌用 `singing-voice-conversion`，缺哪一项，只有这个命令报 `capability_missing` 并点名缺的是哪一项，配音照常。参考用默认参考段，给了 `--language` 等标签就按标签挑。输出文件已经存在就拒绝，不覆盖，而且是在花钱之前就拒绝；接进来的适配器给了费用说明时，换声之前在标准错误里说明要调一次哪项能力（`--json` 时不说）。登记在 `convert` 功能名下的脚本在换声之后处理音频；增强件的用法同配音。

## 自己的适配器

当前运行环境有哪些能力，看接进来的适配器的说明。要用别的模型，自己写一个适配器，用 `--adapter <目录或模块文件>` 交给命令：适配器是一个函数，返回一个对象（能力、运行时、网络读取、费用说明等，键都可选，写法见 `adapters/README.md`「返回的形状」）；后给的盖过先给的，也盖过命令已有的同名项。约定只写在 `adapters/README.md`，每项能力的调用参数和返回值见 `vocab/capability-signatures.md`。适配器在本进程里直接运行，不隔离，和包里的脚本一样。
