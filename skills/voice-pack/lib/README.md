# 流程层

流程层的程序：用音色包配音和变声、做包、按台词挑参考、量还原度、查重、给净室里的做包 agent 准备输入。lib/ 里的每个 `.mjs` 在下面的表里都有一行。

- `.mjs`，写法见 `../protocol/README.md` 的「模块约定」。
- 要用模型、联网、起命令行工具，都通过注入的运行环境（`env`）取，缺了就报错并点名缺的东西，见同一份文档的「运行环境」。
- 可以用 `../protocol/lib/`（核心层）和 `../tools/`，也可以读 `../vocab/` 里的 JSON 词表。
- 命令行里的入口放在 `../cli/commands/`，一个命令一个文件。

## 读包、配音和变声

用一个音色包生成声音：配音（一段台本换成包的声音）和变声。每个文件头写自己的规则，规则只在那里写一遍；纯计算的几个不碰音频、不用模型，每条规则都能拿数据直接测。命令是 `cli/commands/dub.mjs`、`convert.mjs`，只管读写文件。

| 文件 | 干什么 |
|---|---|
| `voice-pack.mjs` | `openVoicePack(source, { env, verify? })`：打开一个角色部分来用：读清单，按需取参考音频、读音词表、配音指引、增强件和脚本；外部资源取回来都核对，包内文件的大小和 SHA-256 在进入环境时查过，这里默认不再算（`verify: true` 才核对，发新版本读上一版用它）。`MIME_OF_FORMAT` 是音频格式到 MIME 类型的对应表，流程层只写这一处 |
| `dub.mjs` | `planDub` 只规划（每句挑哪段参考、读音词表换了什么、停顿和语速的记录；不花钱），`dubScript` 规划再逐句合成：一段服务暂时出错、或者文字被拒（`details.textRejected`）记成 failed，别的段照做；调用之前查出来的文字错（`capability_input_invalid`）不计数；服务商拒的连着 3 句、还没有一句成功的停下来（`dub_text_rejected`）；别的错停下来 |
| `mix.mjs` | `planMix(report)` 检查 dub 的报告（有一句没做成、或者 dub 中途停下，就不出成品）；`mixParts(env, parts)` 把各句接成一个 WAV：句前句后的停顿插成静音，统一成第一句的采样率和声道（纯 JS 重采样），有语速要求时用 ffmpeg 的 atempo 变速（没有就照原速接上，记一条）；非 WAV 的句子要 ffmpeg 解码。纯计算，不调能力，不花钱 |
| `convert.mjs` | `convertAudio(env, pack, audio, options)`：变声和唱歌（`voice-conversion`、`singing-voice-conversion`）：把一段音频换成包的声音，内容、节奏、旋律不变 |
| `reference-pick.mjs` | `pickReferences(env, manifest, lines, options)`：按台词挑参考：每句话从参考集里挑语言、情绪、风格最匹配的一段；没有任何标签的句子，环境有 `text-generation` 就让它判（一次收费的调用，只规划的调用方传 `judge: false` 不调） |
| `line-hints.mjs` | 从一句台词读出提示（纯计算）：`readDirections` 读舞台提示（（耳语）、*笑*……）和停顿，`detectLanguages` 按文字系统认语种，`canonicalLabel`、`primaryLanguage`、`normalizeLanguage` 整理情绪、风格和语言标签。词表是 `../vocab/cues.json` |
| `pause-in-request.mjs` | 一段话里的停顿交给模型（纯计算）：`requestsOf` 把相邻的段并成几次请求（停顿 ≤ 2.5 秒、标点、`<speak>` 和 `<break>`），`renderRun`、`endsMidSentence`、`JOIN_PUNCTUATION_PAUSE_MS`。app 和配音（`dub.mjs` 第 5c 步）都用它 |
| `pronunciation-lexicon.mjs` | 读音词表（W3C 的 PLS）：`parseLexicon`、`lexiconRules`、`applyLexicon`：合成之前把台词里的词换成期望的读法。解析器是自己写的，不引第三方依赖 |
| `enhancers.mjs` | 增强件的使用情况（配音和变声共用）：核对能力返回的音频和它报的 `enhancers_used`，汇总这一次有没有用上增强件 |
| `pack-script.mjs` | 包里的脚本：按清单登记的入口和运行时叫脚本、读它的回答（`runScript`），查缺哪个运行时（`missingScriptRuntimes`），列出没登记功能的脚本（`scriptsWithoutFeature`） |

## 还原度

用两种方法量「用音色包生成的声音像不像角色本人」，读法的正本是 `fidelity.mjs` 文件头「怎么读这份报告」。

| 文件 | 干什么 |
|---|---|
| `fidelity.mjs` | `measureFidelity`、`redoNotHeard`、`planRedo`：说话人相似度（除以真人基线）和盲听两种方法，按参考集的标签分组出报告；服务暂时出错的项记成「没听成」，可以补做；回答被模型的服务商拦下（`provider_blocked`）的盲听记成「作废」，另数条数，不补做；一段录音里嵌不出声纹的记成「量不到」；盲听的收音校验（`openingErrorRate`）只比每段音频开头的 `OPENING_WORDS` 个词，不要整段原话 |
| `fidelity-reading.mjs` | `readReport(report)`：读法的程序：分档、哪几个数不是分数、作废（含被拦下的几条）、没听成和量不到各算几条；命令行（`cli/commands/fidelity.mjs`）和 app 都从它的返回值显示，不各写一份阈值 |

## 做包（`make-pack`）

做包的流程在 `make-pack.mjs`（输入、选项、报告、错误的正本在它的文件头），它只管次序；每一步在自己的文件里，每个文件头写自己的规则、读写条目的哪些字段、抛出的错误，规则只在那里写一遍。纯数据的几个不碰音频、不用模型，所以每条规则都能拿数据直接测。

| 文件 | 干什么 |
|---|---|
| `make-pack.mjs` | `makePack(env, input, options)`：做包的流程，一步一步调下面的文件：读输入、筛片段、试装和规划（花钱之前）、转写、打标签、挑参考、发新版本、调响度、装包、试合成和量还原度、写报告。`options.describeChanges` 让调用方自己把变化写成一句话，不给就是 `pack-version.mjs` 的中文写法；`options.textLanguage`（`'zh'` 或 `'en'`，不给是中文）是包里 `SKILL.md` 骨架的语言 |
| `make-pack-input.mjs` | 读 `input` 和 `options`，写错了在花钱之前报 `make_pack_input_invalid`（点名字段），整理成后面各步读写的条目 |
| `make-pack-screen.mjs` | 筛片段（不花钱）：认格式、查重、量音质，淘汰用不上的；发新版本时上一版带来的段只量不淘汰 |
| `make-pack-plan.mjs` | 规划（不花钱）：筛完以后各项能力最多调几次、有几段素材能用（`plan`，用户在第一次调能力之前确认的就是它） |
| `make-pack-transcribe.mjs` | 转写没有文本的片段；转写以后定每段的文本从哪来，一个词都没有的淘汰 |
| `make-pack-tags.mjs` | 打标签：语言（调用方给的、转写报的、从文字认的）、情绪和风格（让听者听着打，暂时出错的段按 `call-attempts.mjs` 的规则再听，每段最多 3 次）、能量（响度跟这一批的中位数比），以及每个标签是谁定的 |
| `make-pack-pick.mjs` | 挑参考：把条目交给 `pack-material.mjs` 的规则，把结论写回条目；没有一段能用、默认参考段对不上时报错；环境有说话人相似度时，参考之间两两量一次，好让默认段挑最典型的那一段；量的时候出错（不是中止、不是 401）退回按优先级，报告写明原因 |
| `make-pack-loudness.mjs` | 调响度：写进包里的参考和留出录音统一到目标响度（规则和报告里记什么在文件头，怎么调在 `../tools/loudness-normalize.mjs`），不动的段写明原因 |
| `make-pack-assemble.mjs` | 装包：试装（花钱之前）、每段在包里的路径和清单里的样子、调 `packRolePart` 做出角色部分 |
| `make-pack-trial.mjs` | 试合成留出录音（暂时出错按 `call-attempts.mjs` 的规则每条最多试 3 次，`envForTrial`）；合成出来的每一句量还原度之前先查，静音占比或时长对不上的作废、不进比值（`checkSynthesized`）；量还原度、写验证记录；试合成用的环境（不带 `text-generation`，外部资源用手上的字节） |
| `make-pack-report.mjs` | 报告：每一段的去向，`dryRun` 和最后的返回；还缺什么素材（`material-hints.mjs`）也在这里算 |
| `pack-material.mjs` | 挑素材（纯数据）：哪些当参考、哪些当留出录音（留出录音从不当参考）、默认参考段（按平均相似度挑最典型的，相似度由调用方量） |
| `segment-tags.mjs` | 让听者（`audio-text-to-text`）给一段录音打情绪、风格标签，收音校验同盲听，只比录音开头的 `OPENING_WORDS` 个词；回答读不懂或被模型的服务商拦下（`provider_blocked`）就作废（不重试）；服务暂时出错按 `call-attempts.mjs` 的规则再问（`options.attempts`），问满了还没成才记成没听成 |
| `material-hints.mjs` | 「还缺什么素材」（纯数据）：每条规则一个代码，阈值在文件头 |
| `pack-version.mjs` | 发新版本：读上一版、算版本号、比较两版、这一版生效的描述、什么都没变不发、生成变更说明（中文；调用方要别的写法，给 `makePack` 的 `options.describeChanges`，它的返回值也过这里的 `fitChangelog` 裁到清单允许的长度） |
| `design-vocab.mjs` | 音色标签只能从设计词表里取，场景只能从场景词表里取（纯数据） |

在 `makePack` 前面用的：

| 文件 | 干什么 |
|---|---|
| `long-recording.mjs` | `prepareLongRecording(env, recording, options)`：长录音 →（分离）→ 切段 → 逐段转写，产出 `makePack` 的 `input.segments` 和 `input.notes`。环境有 `voice-activity-detection` 就用它切，没有按能量切（`../tools/silence-split.mjs`）；输入输出和每一步的规矩在文件头 |

## 做新包的净室和查重

照一个已有的包做新包，来源包的文字和录音不能被搬进来（流程的正本是 `../protocol/new-pack/README.md`）。命令是 `cli/commands/clean-room.mjs`（生成净室输入）和 `make-pack` 的 `--source-pack`（查重）；命令只管读文件，规则都在这几个文件里，每个文件头写自己的规则。

| 文件 | 干什么 |
|---|---|
| `clean-room.mjs` | `buildCleanRoomInput({ protocolCore, attributes })`：纯函数，只收协议核心和使用者说的属性（标签、场景、自己的话、语言、是不是设计出来的），组装净室输入：任务说明、抽象规格、字段格式、空白模板、属性。不收来源包，也没法收：入参的键是白名单，所以净室输入里不会有来源包的内容 |
| `duplicate-check.mjs` | `checkDuplicates(env, { candidate, source })`：新包和来源包比文字、比录音，重合太多抛 `duplicate_detected`（哪一项、量多少、阈值多少）。阈值只在这里写一处，附标定的依据；`materialOfInput`、`materialOfPack` 把两边整理成要比的东西 |
| `text-overlap.mjs` | `compareTexts`：文字重合的三个量（ROUGE-L F1、抄用比例、来源被带走的比例），中文按字、拉丁字母按词 |

音频指纹（找「同一段录音」）在 `../tools/audio-fingerprint.mjs`，是只做计算的小工具。标定阈值用的数据、脚本和逐项结果不随基础部分发布；阈值和依据写在 `duplicate-check.mjs` 的文件头。

## 老声音转音色包（迁移）

音色包出现以前的声音（只有一段参考录音和逐字文本，加上简介、性别、年龄段、标签这些展示用的字）怎么变成音色包里属于它的那部分：规则只在这里写一遍，嵌入这个库的 app 和服务端的迁移程序都调它，不各写一份。纯数据，不碰音频、不联网、不用模型，浏览器和 Node 都能跑。

| 文件 | 干什么 |
|---|---|
| `legacy-voice.mjs` | `convertLegacyVoice(voice, options)`：整个老声音 → 一段叫 `default` 的参考集（逐字文本、语言标签）加配音指引（音色描述、音色标签、适合的场景），转不了的返回原因（没名字、没文本、文本太长），不抛错；`legacyDirection`（只转指引）、`scenesOfUseCases`（用途词 → 场景 id）。标签只留设计词表认得的，认不得的列进 `dropped`，不带进包；发布表单要原样留着时传 `unknownTags: 'keep'`。头像、授权、网址不在转出来的东西里 |
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
| `capability-calls.mjs` | 调所需能力时共用的几个小函数：`isServiceError`（能力抛的错是不是「服务暂时出错」，看 `details.transient`）、`summarizeError`（收进报告的错误摘要）、`badResult`（能力的返回不合约定，造 `capability_result_invalid`）、`pool`（一批事分给几个并发的工人，出错就不再开始新的） |
| `manifest-limits.mjs` | 清单里长短文字字段的长度上限（`LONG_TEXT_MAX`、`SHORT_TEXT_MAX`），读自协议核心的清单 schema，流程层不另抄一份数；语言标签的写法留在 `language-tag.mjs`（不引别的模块），要和 schema 里的写法保持一致 |
| `event-loop.mjs` | 让事件循环转一圈：`turnEventLoop`（等一个宏任务，用 `MessageChannel`）、`nowMs`（量「连续做了多久」的钟）、`YIELD_AFTER_MS`（50，连续做了这么久就让一圈）。长录音切段编段（`long-recording.mjs`）、做包筛片段（`make-pack-screen.mjs`）都用它：一段同步的活做久了页面就卡，浏览器里 `await crypto.subtle.digest` 不让事件循环转，要自己让 |
| `call-attempts.mjs` | 一段录音的一次能力调用最多试几次、暂时出错等多久再来，规则只在这里写一份，做包的转写（`make-pack-transcribe.mjs`）、打标签（`make-pack-tags.mjs`、`segment-tags.mjs`）和试合成（`make-pack-trial.mjs` 的 `envForTrial`）、长录音（`long-recording.mjs`）和 app 听试听都用它：`callWithRetries`（每段最多 `MAX_ATTEMPTS` 次，暂时出错才再来，两次之前各等 `RETRY_DELAYS_MS`：5 秒、15 秒）、`extraAttempts`（多听的上限，写进「确认费用」里用户同意的次数）、`spent`（把一个已经用完次数的失败原样交回去）。文件头还写着为什么是这几个数、失败的转写收不收费是怎么量的 |
