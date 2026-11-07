# 流程层

流程层的程序：用音色包配音和变声、做包、挑参考、量还原度、查重、给净室里的做包 agent 准备输入。lib/ 里的每个 `.mjs` 在下面的表里都有一行。

- `.mjs`，写法见 `../protocol/README.md` 的「模块约定」。
- 要用模型、联网、起命令行工具，都通过注入的运行环境（`env`）取，缺了就报错并点名缺的东西，见同一份文档的「运行环境」。
- 可以用 `../protocol/lib/`（核心层）和 `../tools/`，也可以读 `../vocab/` 里的 JSON 词表。
- 命令行里的入口放在 `../cli/commands/`，一个命令一个文件。

## 读包、配音和变声

用一个音色包生成声音：配音（一段台本换成包的声音）和变声。每个文件头写自己的规则，规则只在那里写一遍；纯计算的几个不碰音频、不用模型，每条规则都能拿数据直接测。命令是 `cli/commands/dub.mjs`、`convert.mjs`，只管读写文件。

| 文件 | 干什么 |
|---|---|
| `voice-pack.mjs` | `openVoicePack(source, { env, verify? })`：打开一个角色部分来用：读清单，按需取参考音频、读音词表、配音指引、增强件和脚本；外部资源取回来都核对，包内文件的大小和 SHA-256 在进入环境时查过，这里默认不再算（`verify: true` 才核对，发新版本读上一版用它）。`MIME_OF_FORMAT` 是音频格式到 MIME 类型的对应表，流程层只写这一处 |
| `dub.mjs` | `planDub` 只规划（每句挑哪段参考、读音词表换了什么、每个请求开头加的提示、停顿和语速的记录；不花钱），`dubScript` 规划再逐句合成（调用方或设定给的语速在合成以后变速）：一段服务暂时出错、文字被拒（`details.textRejected`）、或者服务那头做完了结果没取回（`details.unretrieved`）记成 failed，别的段照做；调用之前查出来的文字错（`capability_input_invalid`）不计数；服务商拒的连着 3 句、还没有一句成功的停下来（`dub_text_rejected`）；别的错停下来。环境有 `speaker-verification` 时，每句合成好了和所用的参考比一次说话人相似度，低于阈值的标出来（一场戏一个请求的量不了）。调用方给 `reuse`，花钱之前问它每一段有没有上一次做好的、一模一样的，有就沿用、不合成（命令行同一个输出目录再跑不重复花钱，规则在 `cli/commands/dub.mjs`）；给 `only` 只合成点到的几段，别的标成 skipped，点到的一段环境收 `seed` 时换成上一次的加 1（`previousSeed`）。`only`、沿用和换 seed，`planDub` 和 `dubScript` 一样算，规划里看到的就是正式运行要做的 |
| `mix.mjs` | `planMix(report)` 检查 dub 的报告（有一句没做成、或者 dub 中途停下，就不出成品）；`mixParts(env, parts)` 把各句接成一个 WAV：句前句后的停顿插成静音，换人处（相邻两句的包不同）先把两边的静音各削到 50 毫秒，统一成第一句的采样率和声道（纯 JS 重采样），dub 没变成的语速用 ffmpeg 的 atempo 变速（没有就照原速接上，记一条）；非 WAV 的句子要 ffmpeg 解码。几个 dub 输出目录各自 `planMix`，按次序接成一串交给 `mixParts`，目录之间同相邻两句。变速的上下限 `SPEED_LIMITS` 和变速本身 `changeSpeed` 在这里，`dub.mjs` 的语速和目标时长也用它们。纯计算，不调能力，不花钱 |
| `convert.mjs` | `convertAudio(env, pack, audio, options)`：变声和唱歌（`voice-conversion`、`singing-voice-conversion`）：把一段音频换成包的声音，内容、节奏、旋律不变；用哪段参考同配音（`options.referenceTag` → 默认设定的 `referenceTag` → 这句语言的默认段），`onPlan` 在花钱之前 |
| `reference-pick.mjs` | `pickReferences(manifest, lines, options)`：挑参考，按调用方指定的音色基底标签（`options.referenceTag`）→ 设定写的默认参考（`options.setup.referenceTag`）→ 这句语言的默认段取，定了标签在这个标签的几段里按语言找；结果里写 `{ segmentId, tag, by, crossLanguage }`，标签包里没有报 `reference_tag_unknown`；`speaksLanguage` 看一段对不对得上一句的语言（合并的一场用它标说话人跨语言）；`defaultSegmentFor` 给一句的语言找这个包里的默认段（同没定标签那一层，做包比卡片那一句的默认段换没换用它）；`pickSetupOf` 把清单里的一套设定取成挑参考读的键、`refTextOf` 是交给模型的参考文字（配音、变声都用这两个）；自己不按标签挑，不按情绪、风格、能量挑，不调任何能力（规则只在文件头写） |
| `line-hints.mjs` | 从一句台词读出提示（纯计算）：`readDirections` 读舞台提示（（耳语）、*笑*……）和停顿，`cuesInPlace` 把舞台说明换成留在原位的提示（配音用），`detectLanguages` 按文字系统认语种（看主要的文字），`scriptFitsLanguage` 看认出的文字和一个给的语言对不对得上，`canonicalLabel`、`primaryLanguage`、`normalizeLanguage` 整理情绪、风格和语言标签。词表是 `../vocab/cues.json` |
| `pause-in-request.mjs` | 放得下就一个请求（纯计算，配音 `dub.mjs` 第 5c 步用）：`requestsOf` 把相邻的段并成几次请求（一处停顿不超过环境声明的上限，没声明用 `DEFAULT_MAX_PAUSE_IN_REQUEST_MS`；长的切开交给拼接；放不下上限的字数时按 `BOUNDARIES` 从强到弱在场景、段落、句子的边界切；上限可以有几个，各量各的），`pauseWriting` 是请求里的短停顿量过的写法 |
| `opening-cue.mjs` | 请求开头的提示（纯计算，`dub.mjs` 第 7a 步）：`openingCueOf` 把调用方和设定给的情绪、风格、能量、说明合成一条方括号的提示（情绪、风格写成标签词表的规范名字），`withOpeningCue` 把它写在一个请求的文字最前面，`opensWithCue` 认文字开头是不是已经有一条提示 |
| `scene-in-request.mjs` | 一场戏一个请求（纯计算，`lib/dub.mjs` 第 5a 步）：`sceneRuns` 把台本里连续的、几个说话人轮流说的段分成几场（一场放不进一个请求的，在行与行之间切成几场），`mostPicked` 取一个说话人整场用的那一段参考，`isScene` 认一个 unit 是不是一场戏；`TOO_LONG_FOR_ONE_REQUEST` 是平台说一场装不下时适配器给错误标的 `details.problem`。切点和取参考的规则只写在这个文件的头上 |
| `cross-language.mjs` | 跨语言怎么说（纯计算）：`languageOfText` 定拿哪种语言和参考段比（给了的语言文字看得出对不上，按文字认的比），`lineTarget` 把一行台词的语言写成 `{ to, script? }`（给了的照写；从文字认的，只可能是一种语言的文字才写语言，别的写文字系统），`languagePair` 写成「参考段的语言→台词的语言」（`ja→en`、`ja→拉丁字母`），`referenceSources` 说不要口音那条路补的参考从哪来（有录音用录音，没有的默认用这个包跨语言配一段，库里另一个声音，平台能指定模型时多列的一项）。配音停下来报 `dub_cross_language`（`dub.mjs` 第 3a 步）和做包的 `card_line_cross_language`（`material-hints.mjs`）都用它 |
| `speech-length.mjs` | 一段文字念出来至少要多长（纯计算，配音 `dub.mjs` 第 9a 步「念完没有」用）：`expectedSpeechMs` 按语速往短里估（提示、标点不算），`SPEECH_RATE` 是语速（只写在这里），`UNFINISHED_BELOW` 是出来的不到估的几倍算可能没念完 |
| `pronunciation-lexicon.mjs` | 读音词表（W3C 的 PLS）：`parseLexicon`、`lexiconRules`、`applyLexicon`：合成之前把台词里的词换成期望的读法。音素（拼音 `x-pinyin`、Arpabet `x-arpabet`、日文罗马字 `x-romaji`）在声明了 phoneme-markers 的环境里由 `applyLexicon` 一起换成音素标签（`<\|phoneme_start\|>…<\|phoneme_end\|>`）；只声明了 phoneme-in-text 的，拼音由 `applyPhonemes` 在发送前换成 SSML 的 `<phoneme>`。只写一个字的词条有提醒（`singleCharacterNote`）。解析器是自己写的，不引第三方依赖 |
| `enhancers.mjs` | 增强件的使用情况（配音和变声共用）：核对能力返回的音频和它报的 `enhancers_used`，汇总这一次有没有用上增强件 |
| `pack-script.mjs` | 包里的脚本：按清单登记的入口和运行时叫脚本、读它的回答（`runScript`），查缺哪个运行时（`missingScriptRuntimes`），列出没登记功能的脚本（`scriptsWithoutFeature`） |

## 还原度

用两种方法量「用音色包生成的声音像不像角色本人」，读法的正本是 `fidelity.mjs` 文件头「怎么读这份报告」。

| 文件 | 干什么 |
|---|---|
| `fidelity.mjs` | `measureFidelity`、`redoNotHeard`、`planRedo`：说话人相似度（除以真人基线）和盲听两种方法，按参考集的标签分组出报告；服务暂时出错的项记成「没听成」，可以补做；回答被模型的服务商拦下（`provider_blocked`）的盲听记成「作废」，另数条数，不补做；一段录音里嵌不出声纹的记成「量不到」；盲听的收音校验（`openingErrorRate`）只比每段音频开头的 `OPENING_WORDS` 个词，不要整段原话，两边折过写法再比一次（片假名当平假名，有汉字时阿拉伯数字当汉字数字），和原样比的取小的 |
| `fidelity-reading.mjs` | `readReport(report)`：读法的程序：分档、哪几个数不是分数、作废（含被拦下的几条）、没听成和量不到各算几条；命令行（`cli/commands/fidelity.mjs`）和 app 都从它的返回值显示，不各写一份阈值 |

## 做包（`make-pack`）

做包的流程在 `make-pack.mjs`（输入、选项、报告、错误的正本在它的文件头），它只管次序；每一步在自己的文件里，每个文件头写自己的规则、读写条目的哪些字段、抛出的错误，规则只在那里写一遍。纯数据的几个不碰音频、不用模型，所以每条规则都能拿数据直接测。

| 文件 | 干什么 |
|---|---|
| `make-pack.mjs` | `makePack(env, input, options)`：做包的流程，一步一步调下面的文件：读输入、取音频、筛片段、试装和规划（花钱之前）、转写、定语言、挑参考、定音色基底标签、发新版本、标提示标注、调响度、装包、试合成和量还原度、写报告。`options.describeChanges` 让调用方自己把变化写成一句话，不给就是 `pack-version.mjs` 的中文写法；`options.textLanguage`（`'zh'` 或 `'en'`，不给是中文）是包里 `SKILL.md` 骨架的语言 |
| `make-pack-input.mjs` | 读 `input` 和 `options`，写错了在花钱之前报 `make_pack_input_invalid`（点名字段），整理成后面各步读写的条目 |
| `make-pack-precheck.mjs` | 花钱准备段之前查输入（`precheckInput`）：命令行切长录音、试听（分离人声、VAD）之前，先查 `makePack` 在筛片段之前查的那几项（输入和选项、上一版、改名、版本号、点名的默认段（`assertDefaultsUsable`：同一种语言点了两段、放不进参考上限）、设定的 `referenceTag`、试装、卡片试听那一句），查出问题一次能力都不调 |
| `make-pack-take-audio.mjs` | 取音频（不花钱，在筛片段之前）：不是包能放的格式的段（带视频轨的 mp4、mov、mkv 等）用 ffmpeg 取出第一路音轨存成 WAV，写了起止秒（`trim`）的段只留那几秒；包里的参考照旧是音频，外部资源不动。同一个文件的几段只解一次码。取不出、切不出、和同一个文件的前一段重叠的段淘汰，原因写进报告。`trimRange` 是切哪几个采样，查重照它切 |
| `make-pack-screen.mjs` | 筛片段（不花钱）：认格式、查重、量音质（只提醒，不淘汰），淘汰认不出的、重复的和解不开的；发新版本时上一版带来的段只量不淘汰 |
| `make-pack-plan.mjs` | 规划（不花钱）：筛完以后各项能力最多调几次、有几段素材能用（`plan`，用户在第一次调能力之前确认的就是它） |
| `make-pack-transcribe.mjs` | 转写没有文本的片段；转写以后定每段的文本从哪来，一个词都没有的淘汰 |
| `make-pack-tags.mjs` | 语言和音色基底标签（不花钱）：定每段的语言（素材给的、转写报的、从文字认的；认不出的淘汰）；花钱之前和付费以后各查一次设定的 `referenceTag` 对不对得上；标完提示标注以后给每段参考定音色基底标签（素材给的、上一版带来的、提示标注那一次模型顺带给的名字，再没有就用段名；同一种语言里撞名的加序号），以及每一项是谁定的 |
| `make-pack-sentences.mjs` | 句子合段（不花钱）：长录音的句子（句子模式）在转写之前，按素材给的语言、采样率分组（不按转写报的语言分开），每组按原次序并成 5–20 秒的段，之后一段转写一次（句子不逐句转写、不逐句先听）；相邻的句子留原停顿，其余之间 0.3 秒静音；合成的段照常筛 |
| `make-pack-pick.mjs` | 挑参考：把条目交给 `pack-material.mjs` 的规则，把结论写回条目；没有一段能用、点名的默认段对不上（或两段同一种语言）时报错；每种语言的默认段没定下来时，环境有能听音频的模型就请它挑（`default-pick.mjs`，每种语言一次），没有或没挑成，环境有说话人相似度就在参考之间两两量一次、挑最典型的那一段；问、量的时候出错（不是中止、不是 401）退回，报告写明原因 |
| `default-pick.mjs` | 让能听音频的模型（`audio-text-to-text`）在几段候选里挑最自然、带表演的一段当默认段：一次调用交全部候选（最多 `MAX_PICK_CANDIDATES` 段），收音校验同盲听，只比挑的那段开头的 `OPENING_WORDS` 个词；回答读不懂、没正常结束、被拦下就作废（不重试）；服务暂时出错按 `call-attempts.mjs` 的规则再问 |
| `make-pack-annotation.mjs` | 标提示标注：挑完参考集以后，给这一版新补的每段参考定提示标注（`annotatedText`）：素材给了的照给的，上一版带来的照旧，别的每段调一次 `segment-annotation.mjs`（暂时出错按 `call-attempts.mjs` 的规则每段最多 3 次；素材没给音色基底标签的段，同一次里顺带要一个短名字）；留出录音不标；没标上的段只存逐字稿，报告写明哪几段、为什么 |
| `make-pack-loudness.mjs` | 调响度：写进包里的参考和留出录音统一到目标响度（规则和报告里记什么在文件头，怎么调在 `../tools/loudness-normalize.mjs`），不动的段写明原因 |
| `make-pack-assemble.mjs` | 装包：试装（花钱之前）、每段和卡片试听那一句在包里的路径和清单里的样子、调 `packRolePart` 做出角色部分 |
| `make-pack-card-line.mjs` | 卡片试听那一句：花钱之前用试装的包规划配它（不是正好一个请求就报错），包做好以后用这个包交给 `dub.mjs` 配（不点名设定和参考），没配成只记在报告里；交了这一句、请求又和上一版那一句一模一样（使用者用同样的文字重配）时，环境收 seed 就换一个：上一版的 seed 加 1（清单的 `cardLine.seed`），用的 seed 记进清单和报告；发新版本没给这一句时，原样沿用上一版的（seed 跟着带过来），报告里比一比和现在的配法对不对得上（`carriedCardLine`） |
| `make-pack-trial.mjs` | 试合成留出录音（暂时出错按 `call-attempts.mjs` 的规则每条最多试 3 次，`envForPackDub`，配卡片试听那一句也用它）；合成出来的每一句量还原度之前先查，静音占比或时长对不上的作废、不进比值（`checkSynthesized`）；量还原度、写验证记录；试合成用的环境（外部资源用手上的字节） |
| `make-pack-report.mjs` | 报告：每一段的去向，`dryRun` 和最后的返回；还缺什么素材（`material-hints.mjs`）也在这里算 |
| `pack-material.mjs` | 挑素材（纯数据）：哪些当参考、哪些当留出录音（留出录音从不当参考）、每种语言一段默认段和主语言（沿用的、模型挑的、按平均相似度挑最典型的、按优先级的；模型挑的和相似度由调用方给） |
| `segment-annotation.mjs` | 让能听音频的模型（`audio-text-to-text`）给一段录音标提示标注：交去掉开头 `OPENING_WORDS` 个词的逐字稿，回答是固定格式的 `opening` 和 `cues`（`{ cue, before }`），要名字时再加一个 `name`（`nameOf` 整理成音色基底标签），收音校验同盲听；照 `cues` 把提示插进逐字稿拼出 `annotatedText`（`insertCues`，逐字稿一个字都不改），找不到原文的提示丢掉；回答读不懂、没正常结束、被拦下、收音校验没过、提示一条都对不上原文就作废（不重试）。别的程序给参考标提示标注，照这里的写法 |
| `material-hints.mjs` | 「还缺什么素材」（纯数据）：每条规则一个代码，阈值在文件头 |
| `pack-version.mjs` | 发新版本：读上一版、算版本号、比较两版、这一版生效的描述、什么都没变不发、生成变更说明（中文；调用方要别的写法，给 `makePack` 的 `options.describeChanges`，它的返回值也过这里的 `fitChangelog` 裁到清单允许的长度） |
| `design-vocab.mjs` | 音色标签只能从设计词表里取（纯数据） |

在 `makePack` 前面用的：

| 文件 | 干什么 |
|---|---|
| `long-recording.mjs` | `prepareLongRecording(env, recording, options)`：长录音 →（分离）→ 切段 → 逐段转写，产出 `makePack` 的 `input.segments` 和 `input.notes`。环境有 `voice-activity-detection` 就用它切，没有按能量切（`../tools/silence-split.mjs`）；输入输出和每一步的规矩在文件头 |

## 做新包的净室和查重

照一个已有的包做新包，来源包的文字和录音不能被搬进来（流程的正本是 `../protocol/new-pack/README.md`）。命令是 `cli/commands/clean-room.mjs`（生成净室输入）和 `make-pack` 的 `--source-pack`（查重）；命令只管读文件，规则都在这几个文件里，每个文件头写自己的规则。

| 文件 | 干什么 |
|---|---|
| `clean-room.mjs` | `buildCleanRoomInput({ protocolCore, attributes })`：纯函数，只收协议核心和使用者说的属性（标签、自己的话、语言、是不是设计出来的），组装净室输入：任务说明、抽象规格、字段格式、空白模板、属性。不收来源包，也没法收：入参的键是白名单，所以净室输入里不会有来源包的内容 |
| `duplicate-check.mjs` | `checkDuplicates(env, { candidate, source })`：新包和来源包比文字、比录音，重合太多抛 `duplicate_detected`（哪一项、量多少、阈值多少）。阈值只在这里写一处，附标定的依据；`materialOfInput`、`materialOfPack` 把两边整理成要比的东西 |
| `text-overlap.mjs` | `compareTexts`：文字重合的三个量（ROUGE-L F1、抄用比例、来源被带走的比例），中文按字、拉丁字母按词 |

音频指纹（找「同一段录音」）在 `../tools/audio-fingerprint.mjs`，是只做计算的小工具。标定阈值用的数据、脚本和逐项结果不随基础部分发布；阈值和依据写在 `duplicate-check.mjs` 的文件头。

## 老声音转音色包（迁移）

音色包出现以前的声音（只有一段参考录音和逐字文本，加上简介、性别、年龄段、标签这些展示用的字）怎么变成音色包里属于它的那部分：规则只在这里写一遍，嵌入这个库的 app 和服务端的迁移程序都调它，不各写一份。纯数据，不碰音频、不联网、不用模型，浏览器和 Node 都能跑。

| 文件 | 干什么 |
|---|---|
| `legacy-voice.mjs` | `convertLegacyVoice(voice, options)`：整个老声音 → 一段叫 `default` 的参考集（逐字文本、语言标签）加配音指引（音色描述、音色标签），转不了的返回原因（没名字、没文本、文本太长），不抛错；`legacyDirection`（只转指引）。标签只留设计词表认得的，认不得的和用途词列进 `dropped`，不带进包；发布表单要原样留着时传 `unknownTags: 'keep'`。头像、授权、网址不在转出来的东西里 |
| `language-tag.mjs` | `languageTagOf(显示名, 文本)` 和 `languageLabelOf(标签)`：app 里声音的语言是显示名（中文、English），包的清单要 BCP 47 标签（zh、en）。名字认不出时按文本的文字系统认（汉字 zh、假名 ja、谚文 ko），再认不出是 `und`，不猜。`isLanguageTag` 是清单放得下的语言标签的写法（写法对、不超过 35 个字符），做包、长录音、净室输入检查语言标签都用它，写法只在这里写一处。单独一个文件、不引别的模块：app 的每个页面都要读声音的语言，不能为它拖进词表 |

## 适配器的检查和骨架

适配器的约定只写在 `../adapters/README.md`；这里是检查它、生成它的程序。命令是 `cli/commands/adapter.mjs`（`adapter new`、`adapter check`），只管读写文件，规则都在这两个纯函数文件里。

| 文件 | 干什么 |
|---|---|
| `adapter-check.mjs` | 纯函数，浏览器、Node、Bun 都能跑，收的是一个适配器工厂返回的对象（或一个运行环境）：`checkAdapterShape`（容器和类型，命令行加载适配器时用）、`checkAdapterStructure`（结构检查，不调用任何能力）、`planLiveCalls` 和 `checkAdapterLive`（每项能力用一段很短的输入真调一次，核对返回）、`checkCapabilityResult`（核对一项能力的一次返回）。app 的测试可以直接调它，去验 app 自己组装的环境。问题的 code、真调用跳过一项能力的原因（`SKIP_REASONS`，其中 `no_signature` 和 `not_wired` 分别是签名表里没有、签名表里有而检查没接上）和每项能力的返回规则在文件头 |
| `adapter-check-voice.wav`、`adapter-check-voice.json` | 真调用检查用的人声（数据，不是程序）：一个人念一句话，16 kHz 单声道 16 位 WAV，5–8 秒。旁边的 json 写着逐字文本（`text`，voice-cloning 的 `ref_text` 用它）、念的时候用的描述、来源和日期。`cli/commands/adapter.mjs` 读它，经 `checkAdapterLive` 的 `voice` 给进去；库不读文件 |
| `adapter-skeleton.mjs` | 纯函数：`adapter new` 生成的骨架。`parseSignatureDoc` 从 `../vocab/capability-signatures.md` 读出每项能力的说明、调用写法和参数名（注释和函数的参数都从这里生成，不抄一份），`generateModuleSkeleton` 生成 module 骨架；别的种类由官方适配器自己的 `skeleton.mjs` 生成，拿到的上下文和返回的形状在文件头 |

## 几个模块共用的小东西

同一件事只在一个文件里写，别的模块引用它。

| 文件 | 干什么 |
|---|---|
| `capability-calls.mjs` | 调所需能力时共用的几个小函数：`isServiceError`（能力抛的错是不是「服务暂时出错」，看 `details.transient`）、`isProviderBlocked`（被服务商拦下：`provider_blocked` 这个码，或者暂时出错里 `details.problem` 是 `provider_blocked`，转写用）、`summarizeError`（收进报告的错误摘要）、`badResult`（能力的返回不合约定，造 `capability_result_invalid`）、`pool`（一批事分给几个并发的工人，出错就不再开始新的）、`reportedModel`（能力的返回里报的模型，换过模型时的 `modelChange`，见 `adapters/README.md`「换了模型」） |
| `input-batches.mjs` | 一份很长的输入分成几次请求（纯计算）：`splitBatches` 按模型一次请求能收的输入上限（环境声明的 `limits.maxPromptTokens`）把输入装成几批，量法按提示的 UTF-8 字节数，单独就超限的单列；`askBatches` 一批一批地问，回答被截断的那一批对半分开再问；`utf8Length`。app 的文字功能用它；基础部分自己的命令现在不用 |
| `manifest-limits.mjs` | 清单里长短文字字段的长度上限（`LONG_TEXT_MAX`、`SHORT_TEXT_MAX`），读自协议核心的清单 schema，流程层不另抄一份数；语言标签的写法留在 `language-tag.mjs`（不引别的模块），要和 schema 里的写法保持一致 |
| `event-loop.mjs` | 让事件循环转一圈：`turnEventLoop`（等一个宏任务，用 `MessageChannel`）、`nowMs`（量「连续做了多久」的钟）、`YIELD_AFTER_MS`（50，连续做了这么久就让一圈）。长录音切段编段（`long-recording.mjs`）、做包筛片段（`make-pack-screen.mjs`）都用它：一段同步的活做久了页面就卡，浏览器里 `await crypto.subtle.digest` 不让事件循环转，要自己让 |
| `synthesis-limits.mjs` | 合成请求的上限里基础部分自己定的几条：环境声明的 `maxChars` 最少是多少（`MIN_MAX_CHARS`），配音、做包配卡片试听那一句、适配器检查都按它查，不各写一份；配音默认一个请求最多多少个要念的字（`DEFAULT_MAX_SPOKEN_CHARS`，1000，出处在文件头），和这个字怎么数（`spokenLength`：按字符数，提示、标签名不算，连着的空白算一个，语言标签包住的字照算，一个音素标签算一个字），配音切请求和 `dub --dry-run` 的汇总都用它 |
| `../protocol/lib/word-spacing.mjs` | 两截文字接起来中间放不放空格（纯计算）：`writtenWithoutSpaceBetween`、`joinWritten`、`endsWrittenWithoutSpaces`，去掉一处提示以后留不留空格的 `spaceAfterCue`，和它们的字符类。放在协议核心（预览卡片也用），规则和字符类只写在那里。做包拼句子（`make-pack-sentences.mjs`）、提示标注推逐字文本（`make-pack-input.mjs`）、配音并句和请求里的停顿写法（`dub.mjs`、`pause-in-request.mjs`）都用它 |
| `call-attempts.mjs` | 一段录音的一次能力调用最多试几次、暂时出错等多久再来，规则只在这里写一份，做包的转写（`make-pack-transcribe.mjs`）、挑默认段（`make-pack-pick.mjs`、`default-pick.mjs`）、标提示标注（`make-pack-annotation.mjs`、`segment-annotation.mjs`）和试合成、卡片试听那一句（`make-pack-trial.mjs` 的 `envForPackDub`）、长录音（`long-recording.mjs`）和 app 听试听都用它：`callWithRetries`（每段最多 `MAX_ATTEMPTS` 次，暂时出错才再来，两次之前各等 `RETRY_DELAYS_MS`：5 秒、15 秒）、`extraAttempts`（多听的上限，写进「确认费用」里用户同意的次数）、`spent`（把一个已经用完次数的失败原样交回去）。文件头还写着为什么是这几个数、失败的转写收不收费是怎么量的 |
