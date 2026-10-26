# 基础部分（voice-pack）

音色包里与角色无关的那部分：通用流程、协议核心、各类词表和环境适配层（所有适配器所在的那一层）。它是一个标准的 Agent Skill 目录，目录名就是 skill 名 `voice-pack`，入口是 `SKILL.md`。可以单独放在运行环境里，也可以作为子目录放在完整包里。许可是 Apache-2.0，全文在 `LICENSE`。

## 安装

对外的仓库是 `LingXuanYin/voice-pack`（公开），`main` 上就是能装的样子；每个版本一个提交、一个标签 `v<版本>`，每一版改了什么见 `CHANGELOG.md`。两种装法，装到的是同一个 skill 目录：

- **别的 agent**（Codex、Cursor 等；装法由 `vercel-labs/skills` 提供）：`npx skills add LingXuanYin/voice-pack`。默认装进当前项目，加 `-g` 装到用户目录。
- **Claude Code**：在会话里 `/plugin marketplace add LingXuanYin/voice-pack`，再 `/plugin install voice-pack@voice-pack`；在终端里是 `claude plugin marketplace add LingXuanYin/voice-pack` 和 `claude plugin install voice-pack@voice-pack`。

装好以后，agent 读 `SKILL.md`，命令行入口是 skill 目录里的 `cli.mjs`（`node cli.mjs --help`）。运行环境的要求写在 `SKILL.md` 的 `compatibility` 里。

两种装法取的都是仓库里的文件。基础部分每个版本带签名的 zip 和版本索引在 `https://lingxuanyin.github.io/voice-pack/releases/`（`protocol/trust.json` 的 `official_url`），做包时程序按规则从那里取需要的版本，用官方公钥验签。

## 目录

```
voice-pack/
├── SKILL.md                入口：流程按所需能力写，不点名模型
├── README.md               本文件
├── LICENSE                 Apache-2.0 全文
├── CHANGELOG.md            每个版本改了什么（中英文），新的在前；最上面一条是 manifest-fields.json 里的版本，发布说明取这一条
├── manifest-fields.json    基础部分清单里除文件列表以外的字段：版本号（version）和登记的运行时（ffmpeg，可选）；发布时 seal --fields 读它
├── cli.mjs                 命令行入口：协议核心的命令 + 流程层的命令
├── cli/                    命令行层：Node 专有的东西只准出现在这里（有基础部分才有这些命令）
│   ├── commands/           流程层和官方小工具的命令，一个命令一个文件：install（放进环境）、dub（配音）、convert（变声和唱歌）、make-pack（做包和发新版本；给了 --source-pack 就和来源包查重）、clean-room（给净室里的做包 agent 准备输入）、adapter（生成适配器骨架、检查适配器）等
│   ├── adapters.mjs        统一的加载入口：命令行上的 --adapter（官方的给名字，别的给目录或模块文件）都从这里进来，合并规则只在它的文件头写；骨架生成器也从这里找；通用层里只有它碰 adapters/
│   ├── source-pack.mjs     读来源包（目录或分享文件，只为查重，不验签、不联网、不往外传它的标识），把查重的结果写成给人看的几行
│   ├── environment.mjs     给命令的运行环境（核心层的 Node 环境加本机的运行时）
│   ├── node-runtimes.mjs   在本机 PATH 上找 ffmpeg 等命令行工具，包成库要的运行时
│   ├── script-runtimes.mjs 包里的脚本要的运行时（node、python 等），照清单里登记的入口直接运行
│   ├── pack-directory.mjs  打开包目录：按需读里面的文件，不跟符号链接，交给 lib/voice-pack.mjs
│   ├── audio-files.mjs     读音频文件：后缀和 MIME 类型互相换，读成字节加 MIME 类型
│   ├── evaluation-set.mjs  评测集（量还原度用的真录音和合成出来的录音）存成文件的样子：make-pack 写、fidelity 读，格式只在它的文件头写一处
│   ├── fidelity-report.mjs 把还原度报告写成给人看的文字：fidelity 和 make-pack 共用
│   └── input.mjs           读输入（文件、标准输入）、解析选项的小函数
├── protocol/               协议核心：每个部分都带一份，细节见 protocol/README.md
│   ├── README.md           模块约定、运行环境、错误、命令行
│   ├── FORMAT.md           格式说明
│   ├── schema/             清单的 JSON Schema
│   ├── trust.json          官方公钥和官方地址
│   ├── new-pack/           做新包：抽象规格、给净室里的做包 agent 的任务说明、空白模板（没有完整的示例角色）
│   ├── lib/                核心层程序
│   └── cli.mjs、cli/       核心层的命令行，只有协议核心时也能跑
├── vocab/                  词表（JSON）
│   ├── capabilities.json   能力词表，带版本号
│   ├── capability-signatures.md  所需能力的调用签名：参数、返回值、音频怎么传
│   ├── design.json         设计词表
│   ├── scenes.json         场景词表
│   ├── markup.json         台本标记
│   ├── design-sample-lines.json  设计出来的声音做音色包时克隆的示例台词（zh、en 各一组）
│   └── cues.json           舞台提示和情绪、风格标签的近义词（按台词挑参考时认的写法）
├── lib/                    流程层程序：用音色包配音和变声（按台词挑参考、读音词表、配音指引、增强件、包里的脚本）、做包（长录音的分离、切段、转写）、量还原度、查重、给净室里的做包 agent 准备输入；清单见 lib/README.md
├── tools/                  官方小工具：台本标记解析、分句、音质检查、长录音按能量切段、音频指纹（查重找「同一段录音」）等，只做计算，不用模型
└── adapters/               环境适配层：所有适配器所在的那一层。适配器是什么、怎么写、出错怎么报，约定只写在 adapters/README.md
    └── process/            进程适配器（唯一的官方适配器）：把能力调用转成对用户自己的程序（Python 等）的请求，经标准输入输出，一行一个 JSON；进程协议只写在 adapters/process/README.md
        ├── adapter.mjs             适配器的工厂：命令行上的 --adapter process --command "…" 加载的就是它
        ├── adapter.json            命令行上的样子：参数 --command
        ├── wire.mjs                请求的编码、回应的解析（纯函数，浏览器和 Node 都能跑）
        ├── skeleton.mjs            adapter new --kind process 生成的骨架（adapter.mjs 加 program.py）
        └── cli/session.mjs         Node 专有：起程序、等 ready、按 id 配对回应、超时、命令结束时收掉程序
```

别的运行环境的适配器不放在这里，放在它自己的目录，命令行上用 `--adapter <目录>` 接进来（`adapters/README.md`「谁是适配器」）。

## 规则

- **模型名只出现在适配器自己的目录里**。基础部分里（`SKILL.md`、`protocol/`、`vocab/`、`lib/`、`tools/`）只用能力词表里的所需能力名。
- **通用层不点名任何一个适配器**：`protocol/`、`lib/`、`tools/`、`cli/` 里不 import `adapters/` 下的文件，文字里也不出现某个适配器专有的东西；用适配器只经过 `cli/adapters.mjs`。
- 库的写法、运行环境的形状、统一的错误，见 `protocol/README.md`。
- 要用模型才能做的处理（分离、水印、说话人相似度、转写）不放在这里，作为所需能力向运行环境要。模型代码和权重也不放在这里。
- 完整包里每个包都带着一整份基础部分，所以这个目录里不放大文件：每个文件不超过 256 KB。
