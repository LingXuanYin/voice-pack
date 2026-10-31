---
name: voice-pack
description: "音色包（voice pack）的基础部分：造声音、配音、做包的流程，和读写、检查、补全音色包的程序。Base part of the voice pack format: clone, design and blend voices, generate speech, audiobooks, dubbing, batches and transcripts, make voice packs, and read, check and complete them. Flows are written by required capability (text-to-speech, voice-cloning, voice-design, ...) and an environment adapter maps them to concrete models. Use when working with voice packs, voice cloning, voice design or blending, script markup, or dubbing a script with a voice pack. 声音克隆、声音设计、音色融合，配音、有声书、批量生成、转写，音色包的制作、读写、检查和补全。"
license: Apache-2.0
compatibility: "需要带 Web Crypto、Compression Streams（deflate-raw）和 fetch 的运行时：当前的浏览器，或 Node.js（在 24.14 上测过）。用到模型的功能，需要运行环境提供对应的所需能力，见 adapters/。"
---

# 音色包的基础部分

音色包由两个部分组成：**角色部分**（一个声音的参考集和配音指引）和**基础部分**（本目录）。基础部分放与具体角色无关的东西：造声音和合成语音的通用流程、协议核心（格式说明，读写和检查音色包的程序）、各类词表、环境适配层和官方小工具。目录总览见 `README.md`。

流程按**所需能力**来写，不点名模型。模型只从**适配器**接进来：一个适配器把所需能力对到一个运行环境里的具体模型，所有适配器合起来叫**环境适配层**（`adapters/`）；模型名只出现在适配器自己的目录 `adapters/<名字>/` 里。

## 0. 红线

1. **费用归使用者自己。** 生成、大语言模型和转写都记在使用者自己的账户上，由使用者授权；用的是使用者自己的额度，令牌也由使用者自己的登录态管。授权的方式看接进来的适配器的说明。
2. **模型名只写在适配器里。** 流程里只写所需能力。某项能力在当前运行环境用哪个模型、有什么限制，查接进来的适配器的对照表（模型会换，记在脑子里的会过时）；模型的实时参数用运行环境自己的方式查。

## 1. 所需能力

- **能力词表**在 `vocab/capabilities.json`，带版本号。有通用名字的用 Hugging Face 的任务名（`text-to-speech`、`automatic-speech-recognition`、`audio-text-to-text`、`text-generation` 等），没有的用业内趋同的叫法（`voice-cloning`、`voice-design`、`text-to-dialogue`、`audio-source-separation` 等）；参数名用 `ref_audio`、`ref_text`、`instructions`。流程和包里写的能力只从这份词表取。
- **运行环境缺某项能力**时，只有用到它的功能报错，并说明缺哪一项，其他功能照常。取能力和报错的写法见 `protocol/README.md` 的「运行环境」。
- **适配器**每种运行环境一个。官方的只有 `process`（把能力调用转给你自己的程序，入口 `adapters/process/README.md`）；别的适配器在它自己的目录里，用路径接进来。约定只写在 `adapters/README.md`。
- 要用模型才能做的处理（分离、水印、说话人相似度、转写）作为所需能力向运行环境要；运行环境没有的，报不可用。

## 2. 造声音的三条路

| 流程 | 所需能力 | 输入 | 输出 |
|---|---|---|---|
| 克隆 | `voice-cloning`（参数 `ref_audio`、`ref_text`）；逐字文本可用 `automatic-speech-recognition` 转写 | 一段干净的参考（做包至少 5 秒，10 到 20 秒最好，不带伴奏；平台的下限见适配器说明）和它的逐字文本 | 一个声音 |
| 设计 | `voice-design` | 按七个维度挑的属性，写成一段自然语言描述 | 一段声音；满意的锁定成参考，之后走克隆 |
| 融合 | `voice-cloning`，传多段参考 | 2 段以上参考，各带权重 | 一个融合的声音 |

**克隆**：参考音频裁成一段干净的（需要时用 `audio-source-separation` 去伴奏；响度在本机归一到 −20 LUFS）；逐字文本用 `automatic-speech-recognition` 转写或手写，核对一遍；用这段参考合成一句试听；写上名字、语言、性别、标签和简介，保存。

**设计**：
1. 按七个维度挑属性：性别、年龄、音高、语速、情绪、特点、用途，取值见 `references/character-voice.md` 的表。音色标签「机械感」（robotic）、「金属感」（metallic）、「低吼」（growling）说的是声音听起来怎样，不是角色；写进设计描述不保证合成得出来。
2. 把属性写成一句描述（照官方例子的形状，年龄写到岁数，30 岁以下的角色往上写四五岁；例子见 `references/character-voice.md`），写这个人平常跟身边的人说话时的声音。描述只写七个维度的内容：沙哑、低沉写进「特点」；喉位、松紧、气声和口音不在七个维度里，写进描述没有验证过效果。写法和理由见 `references/character-voice.md`。
3. 试听文本是角色用自己口吻做的一段自我介绍，读出来 10 到 20 秒，就是默认参考段；不放口头禅和语气词（理由见 `references/character-voice.md` 的「默认段」）。用 `voice-design` 念它合成一个候选。描述和试听文本的字数上限、处理不了的字，由适配器写明；超了适配器在调用之前就报 `capability_input_invalid`。
4. 挑一个候选锁定成参考：参考音频是这段试听，参考文字是试听文本的原文，之后用它就是克隆。做成音色包时，这段试听是素材的 `intro` 段（默认段），三句情绪台词各克隆一遍，素材和命令见 `references/make-pack.md`「设计出来的声音怎么做包」。候选不满意，照实告诉使用者，说明描述里哪一项要改；换一个的做法见 `references/character-voice.md`。候选像不像真人，由使用者自己听来定：`audio-text-to-text` 问过的几种问法都分不开真人录音和合成的声音（理由写在 `CHANGELOG.md` 的 2.0.8）。

**融合**：权重是和为 1 的份额，调一个，其余按比例重新分配。最多能融合几段，由适配器写明。

**怎么选能力**：有描述而没有参考，用 `voice-design`；参考多于一段，用 `voice-cloning` 做融合；其余按调用者的要求，没要求时有参考用 `voice-cloning`，没有参考用 `text-to-speech`。

**从已有角色开始**：先看手上有什么材料（角色的文字：小说、剧本、设定；录音：原作配音、同一个人的样音），再选路。有录音，走克隆，逐字文本从录音里来；只有文字，走设计，描述按上面的七个维度写。演法和台词由 `text-generation` 从文字材料里分析；有录音，录音的情绪和能量标签由做包时给出（`references/make-pack.md` 的「标签」）。分析时每条带出处，材料里没有、按人物类型推的标「推断」；写进包的时候，演法的每一项只写内容，不带出处和标记（演法一节整节交给模型），音色和台词照旧带出处。默认参考段和情绪台词怎么录、怎么挑，见 `references/character-voice.md`。

## 3. 合成一段话

1. 应用读音词表：把容易读错的词换成期望的读法。
2. 分句：长文本按运行环境的单段上限切开；有台本标记时按标记切。
3. 解析台本标记（第 4 节）。用一个音色包给台本配音时，每一句还要挑参考、读包里的读音词表和配音指引，见第 6 节「用音色包配音和变声」。
4. 逐段生成，多段可以并发。**每段生成任务的 id 要记下来**：重新加载后接着用同一批任务，不重复付费。
5. 本地拼接：去静音、淡入淡出、插入停顿、变速（拼接的规则见 `references/dub.md`）。
6. 需要时加水印（`audio-watermarking`）。
7. 汇总费用。

## 4. 台本标记、场景和设计词表

这几份词表是 JSON，放在 `vocab/`，app、服务端和程序读的是同一份。台本标记的名单和写法见 `references/markup.md`：`# 标题`、`[pause 0.6s]`、`[voice:<声音>]`、`[slow]…[/slow]`、`[fast]…[/fast]`、`[emphasis]…[/emphasis]`、`[spell]…[/spell]`，以及舞台提示 `（耳语）`、`*笑*`。

**场景**（`vocab/scenes.json`）：台本润色按场景选规则，由 `text-generation` 执行。每个场景有 id 和中英文名，例如 `news`（新闻播报）、`narration`（有声书 / 长文旁白）、`dubbing`（本地化配音）。

**设计词表**（`vocab/design.json`）：app 和服务端读的分类、可选值，音色 / 节奏 / 情绪的标签，以及 8 个预设角色。描述里写的取值用 `references/character-voice.md` 的官方表，两份不一样。

**标签词表**（`vocab/cues.json`）：情绪（`emotion`）、风格（`style`）、动作（`actions`：停顿、慢、快）的名字。台本里括号中的语气说明（例如 `（耳语）`、`*笑*`）认成哪一个，也看这份。

## 5. 命令行

在本目录运行 `node cli.mjs help` 列出当前可用的命令，`node cli.mjs <命令> --help` 看用法。只有协议核心时用 `node protocol/cli.mjs`。命令行默认给命令一个只有网络读取、没有任何所需能力的运行环境；要用模型的命令，用 `--adapter` 把适配器接进来（见第 8 节和 `adapters/README.md`）。命令的写法、退出码和错误的报告方式，见 `protocol/README.md` 的「命令行」。放进环境、配音、变声的命令写在第 6 节「用音色包配音和变声」；做包（`node cli.mjs make-pack`）写在第 7 节「做音色包」。

## 6. 用音色包配音和变声

拿到一个音色包（角色部分的目录，里面有 `manifest.json`、`SKILL.md`、`reference/`），先 `install` 放进环境，再用它的声音给台本配音（`dub`），或者把一段音频换成它的声音（`convert`）。三个命令都不点名模型，只要运行环境有对应的所需能力。先加 `--dry-run` 看规划，只规划，不合成，不花钱。

命令的选项、报告、拼接、失败和重做、包里的脚本、变声的细则，都在 `references/dub.md`。配音指引（包的 `SKILL.md` 最后一节）分三节，配音时交给模型的范围在那里定。

几个角色的一场戏：`node cli.mjs dub --pack <包目录> --pack <包目录> <台本文件> --out <输出目录>`，台本里的 `[voice:名字]` 换角色。把输出目录接成一个音频：`node cli.mjs mix <dub 输出目录> --out <文件.wav>`，只在本地算，不花钱，规则见 `references/dub.md`「拼接」。

## 7. 做音色包

作者交来一批原声，做成一个音色包的角色部分：`node cli.mjs make-pack [<素材>] --output <新目录> --name <名字>`，素材可以省（长录音用 `--recording`，发新版本用 `--previous`）。素材的格式、标签、配音指引的三层、发新版本、设计出来的声音怎么做包（`--no-holdout`），都在 `references/make-pack.md`；响度、还原度、留出录音、增强件、发新版本的其余细则、照一个已有的包做新包（净室和查重），在 `references/make-pack-details.md`。命令只管读文件、写文件，正本在 `lib/make-pack.mjs` 的文件头。

## 8. 接自己的模型

要用自己的模型（本机的，或别家的服务），写一个适配器，用 `--adapter` 交给配音、变声、做包、量还原度这几个命令（第 6、7 节）。四步，每步一条命令；规则（工厂、返回的形状、出错、检查看什么、`--live` 会做什么）只写在 `adapters/README.md`，这里不重述。

1. **生成**：`node cli.mjs adapter new <目录> --capabilities <能力,…>`，能力名取自能力词表（`vocab/capabilities.json`）。模型是 Python 之类的程序时，加 `--kind process`：生成一个 Python 程序骨架，只需要填它里面的模型调用。
2. **填写**：把生成的文件里每项能力「还没有实现」的那一行换成真的调用；每项能力上面的注释写着参数和返回值。
3. **检查**：`node cli.mjs adapter check <目录>` 只看结构，不调用模型；加 `--live` 会把每项能力用一段很短的输入真调一次，核对返回（会真的调用，可能花钱：调之前会说明调哪几项、各几次）。
4. **使用**：`node cli.mjs dub <包目录> <台本文件> --out <输出目录> --adapter <目录>`。

已经有写好的程序，不想生成骨架：`--adapter process --command "python my_tts.py"`。程序怎么和适配器说话，见 `adapters/process/README.md`。
