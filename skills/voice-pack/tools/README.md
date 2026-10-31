# 官方小工具

只做计算、不用模型的小工具。agent 环境里配音、做包和 app 都用它们。

| 工具 | 文件 | 命令 | 规则和说明的正本 |
|---|---|---|---|
| 台本标记解析 | `markup.mjs` | `markup` | 文件头：语法、输出的形状 |
| 分句 | `sentences.mjs` | `sentences` | 文件头：规则和取舍 |
| 音频解码 | `audio-decode.mjs`、`wav.mjs` | 经 `quality` | `audio-decode.mjs` 文件头：怎么解、ffmpeg 运行时的签名；`wav.mjs` 文件头：WAV 解到什么程度，以及只想知道多长、什么格式时用的 `wavInfo`（只读文件头，不解采样值） |
| 音质检查 | `audio-quality.mjs` | `quality` | 文件头：量什么、阈值和依据、结论的形状 |
| 长录音按能量切段 | `silence-split.mjs` | 无（库函数） | 文件头：怎么切、选项、返回的形状 |
| 统一响度（含预读限幅器） | `loudness-normalize.mjs` | 无（库函数；做包流程用） | 文件头：目标和峰值上限、增益怎么取、限幅器的做法和参数依据、状态、写成 16 位 WAV 要留的刻度 |
| 音频指纹 | `audio-fingerprint.mjs` | 无（库函数；查重用，经 `../lib/duplicate-check.mjs`） | 文件头：方法（地标哈希加位置差投票）、抗什么、抗不了什么（变速、变调、倒放）、返回的形状、每个数的依据 |

规则只在正本里写一遍，这里不重复。命令的用法：`node cli.mjs help`、`node cli.mjs <命令> --help`；命令的实现在 `../cli/commands/`。

## 写法

- `.mjs`，写法见 `../protocol/README.md` 的「模块约定」：只用平台自带的 API，浏览器和 Node 都能跑。
- 不取所需能力（`env.capabilities`）：这里的东西不用模型。
- 可以用 `../protocol/lib/`（核心层）。
- 用到的平台 API 里有 `Intl.Segmenter`（分句、`[spell]` 按字素簇拆开）：Chrome 87、Firefox 125、Safari 14.1 起才有。没有它，分句抛 `segmenter_missing`（没有退路，按标点硬切会切坏缩写和小数）；`[spell]` 退回按码点拆（普通文字结果一样）。

## 运行时

小工具向运行环境要的命令行工具只有一个：**ffmpeg**，而且是可选的：

- 用在解码 WAV 以外的音频（mp3、flac、ogg、m4a、webm、opus……），以及 WAV 里自己不会解的编码（8 位、ADPCM……）。PCM 16、24、32 位整数和 32 位浮点的 WAV 自己解，不需要它。
- 环境没有就抛核心层的 `runtime_missing`（`details.runtime` 是 `ffmpeg`），只有用到它的功能报错，其他照常。
- 签名在 `audio-decode.mjs` 文件头的 `@runtime ffmpeg`（办法是：运行时登记在第一个调用它的模块的文件头里，在基础部分的根目录里 `grep -rn "@runtime" .` 就能找全；登记和调用要保持一致）。
- 命令行里，ffmpeg 从本机 `PATH` 上找（`../cli/node-runtimes.mjs`），由 `../cli/environment.mjs` 接进命令的运行环境。

基础部分的清单在 `runtimes` 里登记了这一项（`ffmpeg`，可选）：登记的内容放在根上的 `manifest-fields.json`，写法见 `../protocol/FORMAT.md` 4.3。

## 台本标记的标准用例

`cases/markup.json` 是台本标记解析的标准用例，**每一份实现都拿它来对**：基础部分的 `markup.mjs` 是一份；嵌入这个库的 app 要是自己带了解析器（例如在浏览器里解析台本），那是另一份。同一份契约的两份实现，一个结果不一致就是有一边错了：先定哪个对，再一起改，不为了迁就一边把另一边写错。

- 验证：每一份实现都要把这份用例全跑一遍，结果和 `expected` 一样；用 2 万条随机台本逐条比较两份实现的输出，能补上标准用例想不到的组合（随机比较的程序不随基础部分发布）。
- 加用例：在 `cases/markup.json` 里加一条 `{ name, input, options?, expected }`，`expected` 里省略等于默认值的字段（默认值在文件开头的 `defaults`）；用例名不重复；不可见的字符写成 `\uXXXX`。语法有变，先改 `markup.mjs` 文件头，再改两份实现和用例。
- `vocab/markup.json` 是台本标记的词表；词表里的每个词在每一份解析器里都要生效，词表加了新词，每一份解析器都要实现它。

## 测试

这些小工具的测试不随基础部分发布。测试里的音频除了一处全是现场生成的，没有音频文件：例外是音频指纹的测试，它要真人说话的录音才测得出「同一个人说的另一句话不算复用」，用了几段公开语料里的录音（共 600 KB）。用到真 ffmpeg 的几节在没有 ffmpeg 的机器上会跳过并说明。
