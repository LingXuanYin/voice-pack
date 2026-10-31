# 做音色包

这一份是基础部分的参考，`SKILL.md` 第 7 节指到这里。流程（什么时候做包、做完怎么用）在 `SKILL.md`；命令的写法、选项、报告、素材的格式、标签、配音指引、新版本的一般用法，都在这里；主路用不到的细则（响度、还原度、留出录音、增强件、发新版本的其余部分、净室和查重）挪到了 `references/make-pack-details.md`，原处留了指针。

作者交来一批原声，做成一个音色包的角色部分：`node cli.mjs make-pack [<素材目录|素材.json>] --output <新目录> --name <名字> [--short-name <英文短名>]`。`--short-name` 是包 ID 的英文短名，不给就用 `vp`。素材可以省：长录音用 `--recording <文件|目录>` 直接交（下面「素材」一节），发新版本用 `--previous`（见「发新版本」）。输入、选项、报告、错误的正本在 `lib/make-pack.mjs` 的文件头，命令只管读文件、写文件。`--output` 的目录要求还不存在，命令不覆盖任何东西；协议核心要是封印过的（`--protocol` 指到官方发布的那份；开发树里没有官方签名，用 `seal` 封一份自用的）。

**素材**是已经切好的片段，每段一个音频文件加它说的话：目录里每个音频一段，同名的 `.json` 写 `{ text, labels, source, externalUrl }`（`source` 的形状是 `{ recording?, startSec?, endSec? }`：来源录音的名字，和这段在它里面的起止秒数；切段时留下的，只进报告，不进包），只有文本时同名的 `.txt` 也行；或者一份 `.json`：`{ "segments": [{ "audio": "audio/a.wav", "text": "…", "labels": { "emotion": "angry" } }], "notes": [{ "code": "…", "message": "…" }] }`。长录音直接交，不用先切：`--recording <文件|目录>`（目录里每个音频文件是一段长录音）。环境有 `audio-source-separation` 就先分离出人声（`--no-separate` 不分离，输入已经是干净的人声），环境有 `voice-activity-detection` 就用它给的说话区间切，没有就按能量切成 5–20 秒的段（`lib/long-recording.mjs` 文件头）；转写由做包这一步做，一段一次，费用在规划里。分离和 VAD 是花钱的调用，每段录音一次，调之前在标准错误里说明，`--dry-run` 不调（按能量切，只报段数）。切段留下的说明（例如「这次没做分离，输入要是干净的人声」）进报告的 `notes`；自己切的话，也可以写进素材 `.json` 的 `notes`，原样进报告。

**标签**：自己知道的写在 `labels` 里（`null` 是「明确没有」），给了的不再判断。没给的：语言来自 `--language`、转写或文字本身（拉丁字母认不出是英语还是法语，认不出又没给语言的那段用不上，`language_unknown`；转写不报语言时，要转写的拉丁字母原声会在付完转写费以后全部这样用不上，所以这种情况加 `--language`，命令在花钱之前会提醒一行）；情绪、风格让 `audio-text-to-text` 听着打（名字取 `vocab/cues.json` 的 `emotion`、`style`）；能量靠响度跟这一批的中位数比，至少 3 段量得出响度才算（照原始音频量，先量后调响度，不受下面「响度」那一步影响）。没有文本的片段，环境有 `automatic-speech-recognition` 才能转写，没有就用不上（`no_text`）。缺哪项能力，只有用到它的那一步跳过，报告里写明。

**响度**：规则、限幅器，以及 `--no-loudness`、`--no-limiter` 的用法，细则在 `references/make-pack-details.md`「响度」。

**先看规划**：`--dry-run` 只做不花钱的几步（认格式、查重、音质检查），说明各项能力最多调几次，不做包、不调任何能力，也不做情绪判断（正式运行会判，挑出的参考可能不同）。接进来的适配器给了费用说明时，真做之前会在标准错误里再说明一遍，费用记在使用者自己的账户上。`--no-evaluate` 不试合成、不量还原度。

**参考集和留出录音**：默认参考段怎么挑、留出录音留多少，细则在 `references/make-pack-details.md`「参考集和留出录音」。设计出来的声音用 `--default-segment intro --no-holdout`，写法见下面「设计出来的声音怎么做包」。

**还原度**：量法、报告怎么读、补做和作废的条目，细则在 `references/make-pack-details.md`「还原度」。

**报告在哪**：报告只打印在标准输出：不带 `--json` 是文字摘要，`--json` 是完整的 JSON（`report` 字段）。命令不把报告写成文件，要留存就重定向标准输出。

**还缺什么素材**：报告里的 `hints`，一条一个原因，例如没有留出录音（`no_holdout`）、没有某种情绪的参考（`emotion_missing`）、某种语言只有一段（`language_single_reference`）、没有配音指引（`guidance_missing`）。设计来源的包、加了 `--no-holdout` 的包，不给留出录音的两条（`no_holdout`、`holdouts_few`）。补了素材，发新版本。

**配音指引和音色标签**：`--guidance <文件.md>` 写配音指引，三节的写法见下面「配音指引的三层」，放进 `SKILL.md` 最后一节；只写想要的效果；模型的指令语法由适配器决定，写进配音指引会绑死某个模型。`--direction <文件.json>`：`{ description, tags, scenes }`，音色标签只能从设计词表（`vocab/design.json`）里取，场景只能从 `vocab/scenes.json` 里取，中文名也认，写进清单的是规范写法；不在词表里的在花钱之前报 `make_pack_input_invalid`。`--lexicon <文件.pls>` 放读音词表：只有清单的 `files` 列着它才读（`lib/voice-pack.mjs`），所以直接改已装的包里的 `lexicon.pls` 不生效。改读音要发新版本（`--previous <上一版> --lexicon <新文件.pls>`，见「发新版本」），由它把词表和哈希写进清单。`--design-source <文件.json>` 记设计来源，用设计出来的声音、默认音色、融合出来的声音做包时写：`{ description, model, modelVersion, date }`。`model` 取能力调用返回的 `model` 字段（`voice-design` 的返回里有，适配器给了才有；候选是在运行环境的命令行里生成的，取法见接进来的适配器的说明），返回里没有就不写；`modelVersion` 返回里没有这一项，不写。锁定的试听用 `--audition <文件>` 交：不分离（合成出来的本来就是干净的人声），同样切开、转写，一部分当参考、一部分当留出录音（做包照规则挑），设计来源写进清单；没给 `--design-source`，报告里提醒 `design_source_missing`。`--sample-lines <文件.json>` 记示例台词：一份 JSON 数组，每项一句，原样写进清单的 `sampleLines`；最多 50 条，每条 1–500 个字符，不能只有空白（`text_blank`）；台词里可以带舞台提示，例如 `（耳语）`，格式只存这句字符串、不解析它。发新版本不给 `--sample-lines` 就沿用上一版的，给空数组就去掉。

素材是设计出来的声音时，示例台词照 `SKILL.md` 第 2 节「设计」第 3 步试听文本的写法：当面对人说的平常话，其余几句也一样，每句一种情绪，至少两句是问句、回答或插话。示例台词取 `vocab/design-sample-lines.json` 里跟声音语言一样的那一组（zh、en 各 7 句，每句的 `feel` 各不相同，`kind` 写明是问句、回答还是插话）的 `text`，写成字符串数组：`--sample-lines` 要的是字符串数组，直接给那一组的对象会报 `manifest_invalid`。也可以自己写同样口气的几句。示例台词只写进 `sampleLines`，不克隆成素材。

**配音指引的三层**：配音指引写的是这个声音怎么说话、怎么念、说什么，分三节。三节都可选，小节名照「## 配音指引」的规矩不翻译：

- `### 音色`：这个声音听起来怎样（性别、年龄、音高、特点这类，和设计描述说的是同一种东西）。沙哑、低沉写在特点里；喉位、松紧、气声、语速写在演法里（演法交给模型，音色不交）。设计描述的七个维度里也有语速，那是设计时用的，不放进这一节。
- `### 演法`：怎么念，七项：喉位、松紧、气声、沙哑、语速、停顿、笑和叹气。配音时交给模型的范围，见 `references/dub.md` 的「一句话是怎么变成合成的」第 5 步。基础部分交整节演法，不按模型挑；每一项在哪个模型上有没有效果，看运行环境的适配器说明里的效果表。七项是能写的范围，不是要逐项填的表：材料里没有的项整行不写，不写占位（「角色卡没有写，不写」这类，占位会被当成指令念给模型）。一项都没有，就不写这一节：读回时没有演法，什么都不交给模型（规则在 `protocol/lib/guidance-sections.mjs`）。
- `### 台词`：说什么、怎么措辞，五项：自称、句尾、口头禅、用词、方言。写台本的人照着看，不交给模型。

音色和台词的每条特征后面跟出处：材料里的原句或叙述片段，照原文写。只从叙述里抽，台词原文照抄。材料里没有、按人物类型推的，写「推断」，不当成角色的事实。演法的每一项只写内容，不跟出处，也不写「推断」：演法一节整节交给模型。分析材料时照旧要找出处，找不到出处的条目不写进演法。格式的正本是 `protocol/FORMAT.md` 第 5 节。怎么填、默认段和情绪台词怎么录，见 `references/character-voice.md`。

**骨架的语言**：做出来的包里 `SKILL.md` 的骨架（各节的标题和说明）默认是中文；给英文作者做英文包，加 `--text-language en`（只有 `zh`、`en` 两个值，别的是用法错误，退出 2）。只管骨架：「## 配音指引」这一行所有语言都一样，`--name`、`--guidance`、`--direction` 里写的字原样放进包，不翻译；任何语言的包，读回来的指引都一样。发新版本用这一次给的语言，不看上一版是什么语言。规则的正本是 `protocol/FORMAT.md` 的「骨架的语言」。

**发新版本**：`--previous <上一版的包目录>`。包 ID 不变，版本号往上加（`--version` 明说，要比上一版大，否则 `make_pack_version_invalid`；或 `--bump patch|minor|major`，默认 minor），`--changelog` 不给就按变化生成一份。换一个用 `--drop` 去掉上一版的全部段名，见下面「设计出来的声音怎么做包」。其余细则（上一版的参考和留出录音怎么带过来、段名、验证记录、没有变化时的报错、基础部分版本）在 `references/make-pack-details.md`「发新版本的细则」。

**设计出来的声音怎么做包**（库里借来的声音也这样做）：素材四段，都是锁定的试听和它的三句情绪台词，标签全给齐，做包就不调转写和打标签（`--dry-run` 的规划里能看到）：

- `intro`：锁定的试听，`text` 是试听文本原文，`labels` 写 `{ "emotion": "calm", "style": null }`。它是默认参考段。
- `happy`、`angry`、`calm`：三句情绪台词，用锁定的试听克隆出来（参考音频是试听，参考文字是试听的原文，`text` 是那一句），`labels` 写 `{ "emotion": "<情绪>", "style": null }`；生气那段再加 `"energy": "high"`，配音时能量高的句子（被惹急了提高声音）挑它。每句的写法见 `references/character-voice.md`「情绪台词」。三句各克隆一次：调用之前说清是 3 次，说明以后接着做，创作者的请求就是授权（费用归使用者，见 `SKILL.md` 第 0 节）。

库里借来的声音：`intro` 是借来的参考音频。库里没有它的逐字原文，所以 `text` 不写，做包时转写。`labels` 照设计声音那样给 `{ "emotion": "calm", "style": null }`：它是默认段，选它就是因为它是这个角色平常的样子，不打标签。先用 `--dry-run` 核对：给了 `labels`、没给 `text` 时，规划里有一次转写，没有 `intro` 的打标签（不给 `labels` 时 `audio-text-to-text` 的次数多一次，那一次就是给它打标签）。三句情绪台词用借来的参考克隆，照上面写。`--design-source` 写 `{ "description": "声音库：<名字>（<id>）" }`，和默认音色一样记下声音从哪来，换一个时照它跳过这一条。

素材写成 `.json`（`audio` 的路径相对它所在的目录）：

```json
{
  "segments": [
    { "id": "intro", "audio": "audio/intro.wav", "text": "<试听文本>", "labels": { "emotion": "calm", "style": null } },
    { "id": "happy", "audio": "audio/happy.wav", "text": "<那一句>", "labels": { "emotion": "happy", "style": null } },
    { "id": "angry", "audio": "audio/angry.wav", "text": "<那一句>", "labels": { "emotion": "angry", "style": null, "energy": "high" } },
    { "id": "calm", "audio": "audio/calm.wav", "text": "<那一句>", "labels": { "emotion": "calm", "style": null } }
  ]
}
```

不用 `--audition`：它把试听切成 5 到 20 秒的几段再转写，段名由命令按文件名起，`intro` 指不到试听上，默认段得照规则从切出来的段里挑。`--default-segment intro --no-holdout` 把试听定成默认段，并且不留出录音：设计出来的声音没有真人录音，留出几条只是多一轮试合成。完整的命令（`--design-source`、`--direction`、`--sample-lines` 的写法见上面「配音指引和音色标签」）：

```sh
node cli.mjs make-pack <素材.json> --output <新目录> --name <名字> --short-name <英文短名> --language zh --design-source <设计来源.json> --direction <音色.json> --guidance <指引.md> --sample-lines <示例台词.json> --default-segment intro --no-holdout --adapter <适配器目录>
```

第二版（换一个，做法见 `references/character-voice.md`「换一个」）：段名不能和上一版重复，去掉的也算，所以四段的名字各加 `-2`（`intro-2`、`happy-2`、`angry-2`、`calm-2`）；`--drop` 去掉上一版的全部段名（从上一版 `manifest.json` 的参考和留出录音里取），默认段指新的 `intro-2`。描述换了，设计来源、音色（`--direction` 的 `description`）和配音指引的「音色」一节都照新描述重写；没给的会沿用上一版，包里写的就还是旧声音：

```sh
node cli.mjs make-pack <新素材.json> --previous <上一版的包目录> --drop intro,happy,angry,calm --default-segment intro-2 --no-holdout --design-source <新的设计来源.json> --direction <新的音色.json> --guidance <新的指引.md> --language zh --changelog "<说明>" --output <新目录> --adapter <适配器目录>
```

**完整包**：给了 `--base <基础部分目录>` 就放进 `voice-pack/`，不给就只有角色部分（带协议核心 `protocol/`）。资源默认放进包里，片段写了 `externalUrl` 才记成外部资源（清单里只有网址、大小、哈希）。增强件的细则在 `references/make-pack-details.md`「增强件」。

**分享文件**：做包时加 `--share-file <分享文件>`，包写出来以后再打一份 `.voicepack.zip`，里面带预览卡片（`index.html`）。卡片上「在 X 里打开」和「做一个你自己的」两个入口由接进来的适配器给出（适配器背后的产品提供），命令不自己造链接；没有适配器给，卡片上就没有入口。这一步不验签，分发之前用 `check` 查一遍。

**照一个已有的包做新包（净室和查重）**：三步流程、查重比什么和阈值，细则在 `references/make-pack-details.md`「净室和查重」。
