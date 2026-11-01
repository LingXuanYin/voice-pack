# 做音色包

这一份是基础部分的参考，`SKILL.md` 第 7 节指到这里。流程（什么时候做包、做完怎么用）在 `SKILL.md`；命令的写法、选项、报告、素材、标签、配音指引、新版本的一般用法在这里；主路用不到的细则在 `references/make-pack-details.md`，净室和查重在 `references/clean-room.md`。

作者交来一批原声，做成一个音色包的角色部分：`node cli.mjs make-pack [<素材目录|素材.json>] --output <新目录> --name <名字> [--short-name <英文短名>]`。`--short-name` 是包 ID 的英文短名，不给就用 `vp`。素材可以省：长录音用 `--recording <文件|目录>` 直接交（下面「素材」一节），发新版本用 `--previous`（见「发新版本」）。输入、选项、报告、错误的正本在 `lib/make-pack.mjs` 的文件头。`--output` 的目录要求还不存在，命令不覆盖任何东西；协议核心要是封印过的（`--protocol` 指到官方发布的那份；开发树用 `seal` 封一份自用的）。

**素材**是已经切好的片段，每段一个音频文件加它说的话：目录里每个音频一段，同名的 `.json` 写 `{ text, labels, source, externalUrl }`（`source` 是 `{ recording?, startSec?, endSec? }`：来源录音和起止秒数，只进报告，不进包），只有文本时同名的 `.txt` 也行；或者一份 `.json`：`{ "segments": [{ "audio": "audio/a.wav", "text": "…", "labels": { "emotion": "angry" } }], "notes": [{ "code": "…", "message": "…" }] }`。长录音直接交，不用先切：`--recording <文件|目录>`（目录里每个音频文件是一段长录音）。环境有 `audio-source-separation` 就先分离出人声（`--no-separate` 不分离，输入已经是干净的人声），切成句子：环境有 `voice-activity-detection` 就用它给的说话区间，没有就按能量找停顿（`lib/long-recording.mjs` 文件头「句子模式」）；句子在做包时按情绪并成 5–20 秒的段。转写由做包这一步做，一句一次，费用在规划里。分离和 VAD 是花钱的调用，每段录音一次，调之前在标准错误里说明，`--dry-run` 不调（按能量切，只报句数）。切段留下的说明（例如「这次没做分离，输入要是干净的人声」）进报告的 `notes`；自己切的话，也可以写进素材 `.json` 的 `notes`，原样进报告。

**标签**：自己知道的写在 `labels` 里（`null` 是「明确没有」），给了的不再判断。没给的：语言来自 `--language`、转写或文字本身（拉丁字母认不出是英语还是法语，认不出又没给语言的那段用不上，`language_unknown`；转写不报语言时，拉丁字母原声付完转写费就全都用不上，所以这种情况加 `--language`，命令花钱前会提醒一行）；情绪、风格让 `audio-text-to-text` 听着打（名字取 `vocab/cues.json` 的 `emotion`、`style`）；能量靠响度跟这一批的中位数比，至少 3 段量得出响度才算。没有文本的片段，环境有 `automatic-speech-recognition` 才能转写，没有就用不上（`no_text`）。缺哪项能力，只有用到它的那一步跳过，报告里写明。

**响度**：规则、限幅器，以及 `--no-loudness`、`--no-limiter` 的用法，细则在 `references/make-pack-details.md`「响度」。

**先看规划**：`--dry-run` 只做不花钱的几步（认格式、查重、音质检查），说明各项能力最多调几次，不做包、不调任何能力，也不做情绪判断（正式运行会判，挑出的参考可能不同）。接进来的适配器给了费用说明时，真做之前会在标准错误里再说明一遍，费用记在使用者自己的账户上。`--no-evaluate` 不试合成、不量还原度。

**参考集和留出录音**：默认参考段怎么挑、留出录音留多少，细则在 `references/make-pack-details.md`「参考集和留出录音」。设计出来的声音和库里借来的声音用 `--default-segment intro --no-holdout`，写法见下面「设计出来的声音怎么做包」；使用者给的录音见「使用者给的录音」。

**还原度**：量法、报告怎么读、补做和作废的条目，细则在 `references/make-pack-details.md`「还原度」。

**报告在哪**：报告只打印在标准输出：不带 `--json` 是文字摘要，`--json` 是完整的 JSON（`report` 字段）。命令不把报告写成文件，要留存就重定向标准输出。

**还缺什么素材**：报告里的 `hints`，一条一个原因，例如没有留出录音（`no_holdout`）、没有某种情绪的参考（`emotion_missing`）、某种语言只有一段（`language_single_reference`）、没有配音指引（`guidance_missing`）。设计来源的包、加了 `--no-holdout` 的包，不给留出录音的两条（`no_holdout`、`holdouts_few`）。补了素材，发新版本。

**配音指引和音色标签**：`--guidance <文件.md>` 写配音指引，三节的写法见下面「配音指引的三层」，放进 `SKILL.md` 最后一节；只写想要的效果；模型的指令语法由适配器决定，写进配音指引会绑死某个模型。`--direction <文件.json>`：`{ description, tags, scenes }`，音色标签只能从设计词表（`vocab/design.json`）里取，场景只能从 `vocab/scenes.json` 里取，中文名也认，写进清单的是规范写法；不在词表里的在花钱之前报 `make_pack_input_invalid`。`--lexicon <文件.pls>` 放读音词表：只有清单的 `files` 列着它才读，所以直接改已装的包里的 `lexicon.pls` 不生效。改读音要发新版本（`--previous <上一版> --lexicon <新文件.pls>`，见「发新版本」），由它把词表和哈希写进清单。`--design-source <文件.json>` 记设计来源，用设计出来的声音、默认音色、融合出来的声音做包时写：`{ description, model, modelVersion, date, auditionLines }`，`auditionLines` 是设计时试听用的台词（字符串数组，设计时念的原文）。`model` 取能力调用返回的 `model` 字段（`voice-design` 的返回里有，适配器给了才有；取法见接进来的适配器的说明），返回里没有就不写；`modelVersion` 返回里没有这一项，不写。锁定的试听用 `--audition <文件>` 交：不分离（合成出来的本来就是干净的人声），同样切开、转写，一部分当参考、一部分当留出录音（做包照规则挑），设计来源写进清单；没给 `--design-source`，报告里提醒 `design_source_missing`。`--sample-lines <文件.json>` 记示例台词：一份 JSON 数组，每项一句，原样写进清单的 `sampleLines`；最多 50 条，每条 1–500 个字符，不能只有空白（`text_blank`）；台词里可以带舞台提示，例如 `（耳语）`，格式只存这句字符串、不解析它。发新版本不给 `--sample-lines` 就沿用上一版的，给空数组就去掉。

**读音词表**：`--lexicon` 的两种写法（`<alias>`、`<phoneme>`）和音素的条件，见 `make-pack-details.md`「读音词表」。

素材是设计出来的声音时，示例台词照 `SKILL.md` 第 2 节「设计」第 3 步试听文本的写法：当面对人说的平常话，其余几句也一样，每句一种情绪，至少两句是问句、回答或插话。示例台词取 `vocab/design-sample-lines.json` 里跟声音语言一样的那一组（zh、en 各 7 句，每句的 `feel` 各不相同，`kind` 写明是问句、回答还是插话）的 `text`，写成字符串数组：`--sample-lines` 要的是字符串数组，直接给那一组的对象会报 `manifest_invalid`。也可以自己写同样口气的几句。示例台词只写进 `sampleLines`，不克隆成素材。

**配音指引的三层**：配音指引写的是这个声音怎么说话、怎么念、说什么，分三节。三节都可选，小节名照「## 配音指引」的规矩不翻译：

- `### 音色`：这个声音听起来怎样（性别、年龄、音高、特点这类，和设计描述说的是同一种东西）。沙哑、低沉写在特点里；喉位、松紧、气声、语速写在演法里（演法交给模型，音色不交）。设计描述的七个维度里也有语速，那是设计时用的，不放进这一节。
- `### 演法`：怎么念，七项：喉位、松紧、气声、沙哑、语速、停顿、笑和叹气。配音时交给模型的范围，见 `references/dub.md` 的「一句话是怎么变成合成的」第 5 步。基础部分交整节演法，不按模型挑；每一项在哪个模型上有没有效果，看运行环境的适配器说明里的效果表。七项是能写的范围，不是要逐项填的表：材料里没有的项整行不写，不写占位（「角色卡没有写，不写」这类，占位会被当成指令念给模型）。一项都没有，就不写这一节：读回时没有演法，什么都不交给模型（规则在 `protocol/lib/guidance-sections.mjs`）。
- `### 台词`：说什么、怎么措辞，五项：自称、句尾、口头禅、用词、方言。写台本的人照着看，不交给模型。

音色和台词的每条特征后面跟出处：材料里的原句或叙述片段，照原文写。只从叙述里抽，台词原文照抄。材料里没有、按人物类型推的，写「推断」，不当成角色的事实。演法的每一项只写内容，不跟出处，也不写「推断」：演法一节整节交给模型。分析材料时照旧要找出处，找不到出处的条目不写进演法。格式的正本是 `protocol/FORMAT.md` 第 5 节（改格式时读，做包不用读）。怎么填、默认段和情绪台词怎么录，见 `references/character-voice.md`。

**骨架的语言**：英文作者做英文包时加 `--text-language en`，写法和规则见 `make-pack-details.md`「骨架的语言」。

**发新版本**：`--previous <上一版的包目录>`。包 ID 不变，版本号往上加（`--version` 明说，要比上一版大，否则 `make_pack_version_invalid`；或 `--bump patch|minor|major`，默认 minor），`--changelog` 不给就按变化生成一份。换一个用 `--drop` 去掉上一版的全部段名，见下面「设计出来的声音怎么做包」。其余细则在 `references/make-pack-details.md`「发新版本的细则」。

**设计出来的声音怎么做包**（库里借来的声音略有不同，见下面「库里借来的声音」）：素材四段，`intro` 是默认参考段，`happy`、`angry`、`calm` 是它的三句情绪台词，标签全给齐，做包就不调转写和打标签（`--dry-run` 的规划里能看到）：

- `intro`：锁定的试听，`text` 是试听文本原文，`labels` 写 `{ "emotion": "calm", "style": null, "energy": "medium" }`。它是默认参考段。能量也写上：不写的话，能量按这一批的响度中位数算（见上面「标签」），同一段录音在不同的批次里会算成不同的能量。
- `happy`、`angry`、`calm`：三句情绪台词，用锁定的试听克隆出来（参考音频是试听，参考文字是试听的原文，`text` 是那一句），`labels` 写 `{ "emotion": "<情绪>", "style": null }`；生气那段再加 `"energy": "high"`，配音时能量高的句子（被惹急了提高声音）挑它。每句的写法见 `references/character-voice.md`「情绪台词」。三句各克隆一次：调用之前说清是 3 次，说明以后接着做，创作者的请求就是授权（费用归使用者，见 `SKILL.md` 第 0 节）。

**库里借来的声音**：素材四段，名字和设计出来的一样（`intro`、`happy`、`angry`、`calm`），四段都是克隆出来的，借来的原声只当克隆的参考，不进素材，不进包。`intro` 是用借来的参考克隆出来的角色自我介绍：写法照 `references/character-voice.md`「默认段」，`text` 写这段自我介绍的原文，`labels` 照设计声音的 `intro` 那样给。原声长于 20 秒的，截下来的那一截当克隆的参考，截法见 `references/make-pack-details.md`「长原声的截法」；不超过 20 秒的整段用。三句情绪台词 `happy`、`angry`、`calm` 用借来的原声克隆，不用克隆出来的自我介绍；这截原声没有原文，运行环境的克隆要参考文字的（看适配器说明），先转写它。克隆一共 4 次（`intro` 一次，三句各一次），调用之前说清是 4 次，授权照上一条。做包时加 `--default-segment intro --no-holdout`，配音指引、示例台词和命令都和设计出来的声音一样（命令见下）。`--direction` 的音色标签从这条声音自己的标签里挑，取法同「配音指引和音色标签」。借来的声音四段都是克隆的，包里没有真人录音，留不出录音，真人基线凑不成（`lib/fidelity.mjs` 的 `baseline_needs_two_recordings`），还原度量不了。4 次克隆做完、素材里的音频都在了，再用 `--dry-run` 核对（音频不在会报 `file_unreadable`）。`--design-source` 写 `{ "description": "声音库：<名字>（<id>）" }`，和默认音色一样记下声音从哪来，换一个时照它跳过这一条。

**使用者给的录音**：`--recording <录音>`（一个目录就是几段录音），不用先切。带配乐、混着别人说话的录音，先交干净的人声：环境没有分离能力时，做包不去伴奏，报告里留 `separation_skipped`。录多长才留得出还原度：读还原度要有效的留出录音至少 5 条（`lib/fidelity.mjs`「怎么读这份报告」第 1 点）；留出条数是真录音段数的 20%（四舍五入，`lib/pack-material.mjs` 规则 2），所以要 23 段真录音（每段 5 到 20 秒，合几分钟的录音）才留得出 5 条。按下面五步做，一步做完再做下一步，没有循环：

1. 做包：`node cli.mjs make-pack --recording <录音> --output <新目录> --name <名字> --guidance <指引.md> --direction <音色.json> --sample-lines <示例台词.json> --adapter <适配器目录>`，写法见「配音指引和音色标签」。演法、台词和示例台词从角色卡写；没有角色卡就都不写，指引只剩「音色」一节。命令把录音切成句子，每句转写、听一次情绪（`--dry-run` 的规划里，转写和打标签各是句数），同一种情绪的句子按原来的先后并成 5 到 20 秒的段，一段只有一种情绪。相邻的两句之间留原来的停顿，隔着别的句子的是 0.3 秒静音（规则在 `lib/make-pack-sentences.mjs` 的文件头）。默认参考段照「参考集和留出录音」挑，`--default-segment` 可以点名任一句子或段；留出录音和还原度照常，不加 `--no-holdout`。`--dry-run` 的留出录音条数按句数估，做包按并好的段算，会更少。
2. 读报告的 `hints`：没有 `emotion_missing` 就到此为止。
3. 每个 `emotion_missing` 点名的情绪，用默认段克隆一句台词：参考音频是默认段，参考文字是它的原文，台词照 `references/character-voice.md`「情绪台词」，`labels` 写 `{ "emotion": "<情绪>", "style": null }`，生气那句也写 `"energy": "high"`，同上面「设计出来的声音怎么做包」。克隆出来的每一句都标 `"synthetic": true`：它不是这个人录的，不当留出录音，也不进真人基线。调用之前说清是几次，授权和费用照那里。
4. 把这几句写成一份素材 `.json`（格式照「素材」一节），段名用情绪名，不和上一版重名。克隆的那几句带上标记，写法例如 `{ "id": "happy", "audio": "audio/happy.wav", "text": "<那一句>", "labels": { "emotion": "happy", "style": null }, "synthetic": true }`。
5. 发新版本：`node cli.mjs make-pack <素材.json> --previous <上一版的包目录> --language <语言> --changelog "<说明>" --output <新目录> --adapter <适配器目录>`（见「发新版本」）。默认段沿用上一版，不用给 `--default-segment`。

上面几种做包都一样：`--short-name` 不问使用者，不给就用 `vp`。

素材写成 `.json`（`audio` 的路径相对它所在的目录）：

```json
{
  "segments": [
    { "id": "intro", "audio": "audio/intro.wav", "text": "<试听文本>", "labels": { "emotion": "calm", "style": null, "energy": "medium" } },
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

**完整包和外部资源**：要把基础部分放进包里，或者片段要记成外部资源，见 `make-pack-details.md`「完整包」。

**分享文件**：要打一份带预览卡片的 `.voicepack.zip` 时，见 `make-pack-details.md`「分享文件」。

**照一个已有的包做新包（净室和查重）**：流程、查重比什么和阈值，细则在 `references/clean-room.md`「净室和查重」。
