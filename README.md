# voice-pack

给 agent 用的音色包 skill：一个声音的参考集和配音指引装成一个包，谁拿到都能用。<br>
The voice pack skill for your agent: a voice's reference clips and dubbing guidance, sealed in one pack that anyone can use.

[产品页 Home](https://lingxuanyin.github.io/voice-pack/) · [2.0 发布了 What's new in 2.0](https://lingxuanyin.github.io/voice-pack/2.0/) · [发布说明 Release notes](skills/voice-pack/CHANGELOG.md) · [中文](#中文) · [English](#english)

## 装上 · Install

读 Agent Skill 的 agent，装进当前项目 · Agents that read Agent Skills, into the current project:

```sh
npx skills add LingXuanYin/voice-pack
```

Claude Code，依次输入这两条 · In Claude Code, these two in order:

```text
/plugin marketplace add LingXuanYin/voice-pack
/plugin install voice-pack@voice-pack
```

## 中文

### 是什么

voice-pack 是给 agent 用的 skill：音色包（voice pack）的格式，和造声音、配音、做包、验包的一整套工具。一个声音的参考集、配音指引和读音词表装成一个包；包能检查、能补全，交给别人、交给别的 agent，拿到就能配出同一个声音，不用再来问你。

流程按所需能力写（`text-to-speech`、`voice-cloning`、`voice-design`……），不点名模型；模型经适配器接进来。今天接本机的一个程序，明天换成别家的服务，台本、音色包和流程都不用改。

产品页上有两段合成的声音：一段照文字描述设计出来，一段拿它当参考克隆，[去听一听](https://lingxuanyin.github.io/voice-pack/#voices)。

### 能做什么

- **造声音**：克隆（一段 5–20 秒、不带伴奏的干净参考，加它的逐字文本）；设计（从设计词表挑属性写成描述，试听，满意的锁定成参考）；融合（两段以上参考，各带权重）。
- **让它说话**：用音色包给台本配音，每句挑最对得上的参考，读音词表换掉容易读错的词；有声书和长文用台本标记分章、停顿、调语速和重音，新闻、播客、有声书、本地化配音、短视频等 12 个场景各有台本润色的规则；批量生成按单次的上限切开、并发，失败的句子单独重做，做好的不重复付费；变声和唱歌。
- **听**：转写，给克隆和做包补逐字文本；长录音先切段，再一段一段地转写。
- **音色包**：做包（打标签，挑参考集和留出录音，响度统一到 −20 LUFS，试合成，量还原度，告诉你还缺什么素材）、检查、补全、放进项目，打成一个 `.voicepack.zip` 分享。
- **量**：还原度，说话人相似度跟真人基线的比值，加盲听。

### 接模型

能力 → 适配器 → 你的模型。适配器把所需能力对到一个运行环境里的具体模型。

- 已经有一个程序：通用的 `process` 适配器把每次能力调用变成对你程序的一次请求（标准输入输出，一行一个 JSON），程序用什么语言写都行。

  ```sh
  node cli.mjs dub my-voice/ script.txt --out out/ --adapter process --command "python my_tts.py"
  ```

- 还没有程序：生成一个骨架（要本机有 Python 3），把 `program.py` 里每项能力「还没有实现」的那一行换成真的调用，每项能力真调一次核对返回，再用 `--adapter ./my-tts` 交给 dub、convert、make-pack、fidelity。

  ```sh
  node cli.mjs adapter new my-tts --kind process --capabilities text-to-speech,voice-cloning
  node cli.mjs adapter check ./my-tts --live
  ```

- 适配器的约定只写在一处：[adapters/README.md](skills/voice-pack/adapters/README.md)。适配器在本进程里直接运行，不隔离：只接你信得过的。

花钱之前：要调模型的命令，开始之前说明要调哪几项能力、各几次；`--dry-run` 只做不花钱的几步，不接模型也能先看配音和做包的规划；运行环境缺某项能力，只有用到它的功能报错，并点名缺的是哪一项。

### 开始

装好以后，对你的 agent 说：

- 看看这个音色包里有什么，检查一下签名。
- 用这个音色包给 script.txt 配音，先给我看规划，别花钱。
- 帮我把本机的 python my_tts.py 接成适配器，跑一遍检查。

或者在 skill 的目录里跑：

```sh
node cli.mjs help                                          # 列出所有命令；help <命令> 看用法
node cli.mjs check my-voice.voicepack.zip                  # 检查一个音色包，不用接模型
node cli.mjs dub my-voice/ script.txt --out out/ --dry-run # 配音的规划：每句说什么、挑哪段参考、还缺什么能力
```

需要 Node.js（在 24.14 上测过）；库只用平台自带的 Web Crypto、Compression Streams 和 fetch，当前的浏览器里也能跑；ffmpeg 可选，用来解码 WAV 以外的音频。

### 版本、许可、签名

- 每一版改了什么：[发布说明](skills/voice-pack/CHANGELOG.md)。2.0.0 是第一个能单独装的正式版，[它带来什么](https://lingxuanyin.github.io/voice-pack/2.0/)。
- 许可：Apache-2.0，见 [LICENSE](LICENSE)。
- 签名：基础部分和协议核心带官方签名（Ed25519）；check、install、complete 默认只认协议核心里列出的公钥。
- 格式说明在 [protocol/](skills/voice-pack/protocol/)：第三方照着就能读写音色包。

## English

### What it is

voice-pack is a skill for your agent: the voice pack format, plus the tools to make voices, dub scripts, and build and check packs. A voice's reference clips, dubbing guidance and pronunciation lexicon go into one pack that can be checked and completed; hand it to someone else, or to another agent, and they can dub in the same voice without coming back to ask you.

Every flow is written by the capability it needs (`text-to-speech`, `voice-cloning`, `voice-design`, …) and names no model; models come in through adapters. Plug in a program on your machine today and someone's service tomorrow, without changing your scripts, your packs or your flows.

The home page has two synthetic voices, one designed from a written description and one cloned from it: [listen](https://lingxuanyin.github.io/voice-pack/?lang=en#voices).

### What it does

- **Make a voice**: clone (one clean 5–20 s reference with no music under it, plus its verbatim text); design (pick attributes from the design vocabulary, write them as a description, audition it, lock the take you like as a reference); blend (two or more references, each with a weight).
- **Make it speak**: dub a script with a voice pack, each line getting the reference that matches it best and the pronunciation lexicon fixing words that get misread; audiobooks and long text with script markup for chapters, pauses, pace and emphasis, and 12 scenes, from news and podcasts to audiobooks, localization and short video, each with its own script-polishing rules; batches split at the per-call limit and generated in parallel, failed lines redone on their own and finished ones never paid for twice; voice conversion and singing.
- **Listen**: transcription, for the verbatim text that clones and packs need; long recordings are cut first, then transcribed one segment at a time.
- **Voice packs**: make (tag, pick the reference set and the holdout, even loudness to −20 LUFS, run a trial synthesis, measure fidelity, say what material is missing), check, complete, install into a project, and share as one `.voicepack.zip` file.
- **Measure**: fidelity, as speaker similarity against a same-person baseline, plus blind listening.

### Plug in a model

Capability → adapter → your model. An adapter maps capabilities to the concrete models of one runtime.

- You already have a program: the generic `process` adapter turns each capability call into a request to your program over stdin and stdout, one JSON object per line, so it can be written in any language.

  ```sh
  node cli.mjs dub my-voice/ script.txt --out out/ --adapter process --command "python my_tts.py"
  ```

- No program yet: generate a skeleton (needs Python 3), replace each capability's "not implemented yet" line in `program.py` with the real call, call each capability once for real to check what comes back, then hand it to dub, convert, make-pack and fidelity with `--adapter ./my-tts`.

  ```sh
  node cli.mjs adapter new my-tts --kind process --capabilities text-to-speech,voice-cloning
  node cli.mjs adapter check ./my-tts --live
  ```

- The adapter contract lives in one place: [adapters/README.md](skills/voice-pack/adapters/README.md). Adapters run in-process, without a sandbox: plug in only what you trust.

Before anything is billed: a command that calls a model first says which capabilities it will call and how many times; `--dry-run` does only the free steps, so you can see a dub or a pack plan before any model is connected; if the runtime lacks a capability, only the features that need it fail, and they name what is missing.

### Get started

Once it's in, say to your agent:

- Check this voice pack and tell me what's in it.
- Dub script.txt with this pack. Show me the plan first, and don't spend anything.
- Wire up my local python my_tts.py as an adapter and run the check.

Or run these in the skill's directory:

```sh
node cli.mjs help                                          # lists every command; help <command> shows its usage
node cli.mjs check my-voice.voicepack.zip                  # checks a voice pack; no model needed
node cli.mjs dub my-voice/ script.txt --out out/ --dry-run # the dubbing plan: each line, its reference, what is missing
```

Requires Node.js (tested on 24.14); the library uses only built-in Web Crypto, Compression Streams and fetch, so current browsers run it too; ffmpeg is optional, for audio other than WAV.

### Version, license, signatures

- What changed in each release: [release notes](skills/voice-pack/CHANGELOG.md). 2.0.0 is the first formal release that installs on its own: [what it brings](https://lingxuanyin.github.io/voice-pack/2.0/?lang=en).
- License: Apache-2.0, see [LICENSE](LICENSE).
- Signatures: the base part and the protocol core carry the official signature (Ed25519); by default check, install and complete trust only the keys listed in the protocol core.
- The format spec is in [protocol/](skills/voice-pack/protocol/): enough for anyone to read and write voice packs.
