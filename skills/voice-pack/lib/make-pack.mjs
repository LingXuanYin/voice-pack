// SPDX-License-Identifier: Apache-2.0
//
// 做包（流程层）：作者交来一组切好的片段（每段一个音频加它说的话），做包流程把它们整理成一个角色部分：
// 取音频（带视频轨的文件取音轨、写了起止秒的切出那几秒）、筛片段、定语言、挑出参考集和留出录音、标提示标注、给参考定音色基底标签、做出包，再试合成、量还原度、提示还缺什么素材。
// 参考集、留出录音怎么挑，规则在 lib/pack-material.mjs 的文件头。
// 库不碰文件系统：音频是字节，写成文件、把文件读成字节是命令行层的事（cli/commands/make-pack.mjs）。
//
//   const { pack, report } = await makePack(env, input, options);
//
// 交给 makePack 的段有的要先花钱准备（命令行的 --recording、--audition：分离人声、VAD 切段）：准备之前先用 lib/make-pack-precheck.mjs 的 precheckInput 查输入，
// 只看输入就查得出的错不等钱花完了才报。
//
// ---------------------------------------------------------------- 输入（input）：片段列表
//
//   {
//     name,             必填。包的显示名，1–100 个字符
//     shortName?,       包 ID 的英文短名；不给就用 vp
//     baseVersion,      必填。做包时用的基础部分版本（语义化版本号），记进清单的 madeWith；不记来源包
//     protocolCore,     必填。协议核心的文件，Map<路径, Uint8Array>，要带它自己的 manifest.json（用官方发布的基础部分里的 protocol/）
//     base?,            基础部分的文件（含它的 manifest.json、签名和嵌着的 protocol/），给了就做成完整包，不给就只有角色部分
//     segments: [       必填，至少一段。每一段：
//       {
//         id?,          名字：小写字母、数字、连字符、下划线，以字母或数字开头，最长 64 个字符，不重复；不给就按次序起 seg-001、seg-002……
//         audio,        必填。{ bytes: Uint8Array, mimeType: 'audio/…' }（protocol/lib/audio-clip.mjs）。库不收路径、网址：路径是命令行层读成字节的。
//                       不是包能放的格式的（带视频轨的 mp4、mov、mkv，别的格式），做包用 ffmpeg 取第一路音轨、存成 WAV（lib/make-pack-take-audio.mjs）；外部资源（externalUrl）不取，用不上
//         text?,        这段录音里说的原话（逐字文本）。可以不给、给空串或 null：就是「没有文本」，环境有 automatic-speech-recognition 时转写，
//                       没有就不能用（report 里写 no_text）。没有文本的片段当不了参考，也当不了留出录音
//         annotatedText?  这段的提示标注：逐字文本在说法变化的地方加上方括号提示的整句（提示以外的字和 text 一样，格式见 protocol/FORMAT.md 4.4）。
//                       给了就照给的（去掉两头空白），这段不再让 audio-text-to-text 标；只有空白、除了提示没有别的字、超过格式的上限，报 make_pack_input_invalid（field 是 segments[2].annotatedText）。
//                       提示以外的字花钱之前对一遍（规则只写在这里，程序在 lib/make-pack-input.mjs）：去掉方括号提示（tools/markup.mjs 的 CUE_PATTERN），空白不算，
//                       和 text（同样去掉提示）比；不一样报同一个错，details.differsAt 是两边从第一处不一样起的一小截 { annotatedText, text }。
//                       没给 text（不给、null、空串）的，text 就是它去掉提示、连着的空白并成一个、去掉两头空白的那句（算调用方给的），这段不转写。
//                       去掉提示的地方连同提示两边的空白一起去掉，两边这样接（看两边挨着的字，隔着引号、括号、省略号、破折号看；程序在 protocol/lib/word-spacing.mjs 的 spaceAfterCue）：
//                       有一边是全角标点、或者两边都是汉字或假名（々〇〆 算汉字），直接接；前一截只有一串省略号、破折号（一句的开头，或者开头的引号、括号后面），
//                       后一截是汉字或假名，直接接（「……[哽咽] 对不起」）；后一截开头是英文的收尾标点（. , ! ? ; : ) ] }），直接接；
//                       前一截结尾是开头的括号、引号（西文的 ¿ ¡ 也算），或者后一截开头是收尾的括号、引号（引号看它挨着什么：前面是空白的像开头，后面是空白或一串收尾的标点的像收尾，
//                       挨着汉字、假名、谚文的弯引号看字；还要数前面同一种引号，双数个才是开头、单数个才是收尾，对不上的不算；德文的 „Hallo“、撇号 ’em、
//                       法文的「« Oui » [soupir] « Non »」也照这样认；单引号一边紧挨着提示、另一边是空白或一句的头尾的，归提示那一边、不数，撇号 twins' 'em 不碍事），
//                       直接接，作者在引号、括号里面写了空格的（« Bonjour »、« Bonjour ! »，隔着标点看里面的字）照留；
//                       别的，提示两边原来有空白就留一个，两边都是拉丁、希腊、西里尔字母、数字（或韩文）又紧挨着也留一个，剩下的直接接。
//                       所以「你好 [sigh] 我说过了」是「你好我说过了」，「你好，[sigh] hello」是「你好，hello」，「Hello there [laughs] 你好」是「Hello there 你好」，
//                       「OK [sigh] 好的」是「OK 好的」，「I told you[sigh]already」是「I told you already」，「already[sigh]. Now」是「already. Now」，
//                       「That's enough [sigh].」是「That's enough.」，「々 [sigh] hello」是「々 hello」，「He said, "[softly] come here."」是「He said, "come here."」。
//                       当了留出录音的段不写进包（留出录音不标提示标注）。上一版的段沿用上一版清单里的
//         language?,    这段的语言（语言标签，形如 en、zh-CN），和清单同名。给了就是定下来的；没给的来自转写，再没有就从文字本身认（规则在 lib/make-pack-tags.mjs）
//         tag?,         这段的音色基底标签（自由文字，1–64 个字符，按码点算），和清单同名：一段参考的短名字，例如「平常」「愤怒」「少年」，只用来在几段参考之间切换。
//                       作者给的和库里给的（例如库里重生成的参考）不分，都是素材给的。去掉两头空白，别的不改；只有空白或者超过 64 个码点，花钱之前报 make_pack_input_invalid
//                       （field 是 segments[2].tag）。没给的，用标提示标注那一次调用顺带给的短名字（不另调），给不成用这段的 id。
//                       同一种语言里撞名的，挑完参考集以后加序号（「愤怒 2」，规则在 lib/make-pack-tags.mjs）。
//                       当了留出录音的段不带标签。旧写法的 labels（每段的、输入的）不收：花钱之前报 make_pack_input_invalid，field 是那一处的 labels
//         source?,      这段是从哪来的 { recording?: 来源录音的名字, startSec?, endSec? }（切段那一步留下的）。只放进报告，不进包
//         externalUrl?  明确选了外部资源：这段音频不放进包，清单里只记这个 https:// 网址、大小和哈希（资源默认放进包里）。所以 audio 原样算哈希：不取音轨、不调响度，不收 trim
//         synthetic?    true 表示这段是合成的（克隆出来的），不是这个人录的：清单里标 synthetic: true。它不当留出录音，不进真人基线，报告的真录音段数不数它；
//                       当参考、当默认段和真录音一样挑（规则 5）。不给就是真录音。上一版的段沿用上一版清单里的标记
//         sentence?     这段是一句话：{ bodySec, pauseSec }（句子的秒数，和它后面的原停顿，没有就是 null）。长录音的句子模式给，素材 .json 也可以写（references/make-pack.md「素材」）。
//                       做包先把句子并成段、再一段转写一次（段里每一句都带 text 的，接起来当段的文字，不转写；每一句都给了 annotatedText 的，接起来当段的提示标注；
//                       每一句都标了 synthetic 的，段才标；lib/make-pack-sentences.mjs）。可能并进同一段的句子（素材给的语言一样的），synthetic、annotatedText 要标得一样，
//                       不一样花钱之前报 make_pack_input_invalid（field 是 segments[2].synthetic 或 segments[2].annotatedText，规则在 lib/make-pack-input.mjs 的文件头「句子」）
//         trim?         只用这段音频里的这几秒：{ startSec?, endSec? }（从音频开头算的秒，至少写一个，至少 0.1 秒；startSec 不写是从头，endSec 不写是到结尾）。做包先切出来再做别的，
//                       报告里这一段的 trim 写实际切的秒。和 sentence、externalUrl 不能一起写。同一个文件的几段，用的秒有重叠的，后一段记 duplicate_audio（没写 trim 的算整个文件）。
//                       写法查在 lib/make-pack-input.mjs，切和比重叠的规则在 lib/make-pack-take-audio.mjs
//       }
//     ],
//     language?,        给所有片段的默认语言（片段自己的 language 盖过它），写法同上。没有默认的音色基底标签
//     direction?,       配音指引里的结构化部分 { description?, tags? }：tags 只能从设计词表（vocab/design.json）里选；别的字段（例如 scenes：没有场景标签了）报 make_pack_input_invalid；
//                       写法按 lib/design-vocab.mjs 换成规范的（中文名和别名也认，清单里存的是规范写法），不在词表里的报 make_pack_input_invalid（field 是 direction.tags[1] 这样的路径）
//     guidance?,        配音指引的正文（Markdown），放进 SKILL.md 的最后一节
//     sampleLines?,     示例台词：字符串数组，原样写进清单的 sampleLines（规则见 protocol/FORMAT.md 4.4 节：最多 50 条，每条 1–500 个字符，不能只有空白；台词里可以带舞台提示，例如（耳语））。
//                       不是数组报 make_pack_input_invalid（field 是 sampleLines），哪一条不是字符串（例如把 vocab/design-sample-lines.json 的 { text, feel, kind } 对象原样抄进来）
//                       也报它（field 是 sampleLines[0]），都在花钱之前；条数、长度、空白由清单检查在花钱之前报（试装，manifest_invalid）。空数组等于没写
//     cardLine?,        卡片试听那一句：一句台词（字符串，去掉两头空白；1–500 个字符，不能只有空白，可以带舞台提示，规则见 protocol/FORMAT.md 4.4 的 cardLine）。
//                       包做好以后用这个包配出来，写进清单的 cardLine（lib/make-pack-card-line.mjs：怎么配、没配成怎么办、花钱之前查什么）。不是字符串报 make_pack_input_invalid
//                       （field 是 cardLine）；长度、空白由清单检查在花钱之前报（试装，manifest_invalid）
//     expressiveness?,  这个声音的起伏（全局值，0 到 100 的整数）：写进清单顶层；配音时没有更靠后的一层声明起伏就用它（lib/dub.mjs 文件头「设定」）。发新版本没给就沿用上一版的，null 是去掉。不是 0 到 100 的整数，花钱之前报 make_pack_input_invalid（field 是 expressiveness，dryRun 也报）
//     cardLineExpressiveness?,  卡片试听那一句单独取的起伏（0 到 100 的整数）：只有这一次配的这一句用这个值，其余照默认那套，写进清单的 cardLine.expressiveness。要和 cardLine 一起给，不然 make_pack_input_invalid（field 是 cardLineExpressiveness）
//     setups?,          几套设定（固定到音色里）：数组，每项 { name, labels?, referenceTag?, speed?, instructions?, expressiveness?, default? }，原样写进清单的 setups（写法和规则见 protocol/FORMAT.md 4.4、4.5 节；配音怎么用，见 lib/dub.mjs 文件头「设定」）。
//                       不是数组报 make_pack_input_invalid（field 是 setups）；重名、不止一套带 default、speed 不是正数这类由清单检查在花钱之前报（试装，manifest_invalid）。空数组等于没写。
//                       instructions 是给写台本的人看的具体说明（口音、口吻的特征），配音时不发给模型，不限长。labels 的情绪、风格、能量合成的开头的提示超过 lib/cue-length.mjs 的 MAX_OPENING_CUE_WORDS 个词，
//                       给的：花钱之前报 make_pack_input_invalid（field 是 setups[0]，details 另有 words、limit）；沿用上一版的：不报错，报告的 notes 里记一条 setup_opening_cue_too_long
//                       （规则在 lib/make-pack-input.mjs 的文件头「设定合成的开头的提示」）；
//                       expressiveness 是这套设定固定的起伏（0 到 100 的整数）：给的不是，花钱之前报 make_pack_input_invalid（field 是 setups[0].expressiveness，dryRun 也报，规则在 lib/make-pack-input.mjs 的文件头「设定的起伏」）；
//                       referenceTag 是这套设定的默认参考（音色基底标签）：花钱之前查它是素材给的标签、或者上一版参考的标签，对不上报 make_pack_input_invalid（field 是 setups[0].referenceTag）；
//                       被引用的标签在一种语言里只有一段的，那段不当留出录音、参考上限不裁它；付费以后它还是没进参考集（例如转写没成），同样报错停下（lib/make-pack-tags.mjs）
//     designSource?,    设计来源 { description?, model?, modelVersion?, date?, auditionLines? }：设计出来的声音、默认音色、融合出来的声音做包时写
//     files?,           角色部分的其他文件 Map<路径, Uint8Array>：读音词表 lexicon.pls、脚本、增强件……原样放进包里
//     scripts?, enhancers?   清单里登记的脚本和增强件；增强件只保证格式上能放（见下），做包不做训练
//     notes?,           前面几步（分离、切段、转写）留下的说明 [{ code, message, details? }]，原样放进报告，例如「这次没做分离，输入要是干净的人声」。details 是这条说明说的那些事实
//                       （message 里的数和名字），没有就不给；库自己给的说明都带着（lib/long-recording.mjs、lib/make-pack-loudness.mjs 的文件头写了每个 code 的 details）
//     environment?,     验证记录里「在哪个环境测的」写什么；不给就用 options.environment
//     defaultSegment?   明说默认段：一段的名字，或者几种语言各一段的名字的数组（每段都要是参考集里的一段；一种语言最多一段，两段同一种语言报 make_pack_input_invalid）。
//                       每种语言各有一段默认段（规则的正本是 lib/pack-material.mjs 的规则 5）：点名了的语言照点名；没点名的语言照规则挑（有能听音频的模型就请它挑，
//                       每种语言一次，lib/make-pack-pick.mjs），发新版本时沿用上一版的（沿用的条件也在规则 5）。点名的、沿用上一版的语言不请模型挑，费用里也不算那一次。
//                       点名不定主语言：主语言是参考集里段最多的语言（发新版本时照旧是上一版的），它的那段写进清单的 reference.defaultSegment，别的语言的写进 reference.languageDefaults
//
//     发新版本（给了 previous）时，另外这几项；规则的正本在 lib/pack-version.mjs 的文件头：
//     previous?,        上一版的角色部分文件 Map<路径, Uint8Array>。给了就是发新版本：包 ID 不变，版本号往上加，上一版的参考和留出录音原样带过来（保持原来的
//                       角色），segments 是新补的素材（可以是空数组：只改指引、只换参考也能发）。上一版有外部资源的话，要取回来核对，环境得有 fetch
//     version?, bump?   新版本号：明说的（要比上一版大），或者按 major、minor、patch 往上加（默认 minor）。没有 previous 时 version 是第一个版本的版本号（默认 1.0.0），bump 不能给
//     changelog?        变更说明（至少一个字符，最长 CHANGELOG_MAX，读自清单 schema，见 lib/pack-version.mjs）；不给就按变化生成一份：库自己写的是中文的，调用方要别的写法，给 options.describeChanges
//     drop?             上一版里不要了的参考或留出录音的名字 [id]
//     retag?            改上一版参考的音色基底标签 { 段名: 新标签 }：段名要是上一版的参考、这次没 drop；标签的规矩同素材给的 tag。写错了（留出录音、上一版没有的、drop 了的、
//                       标签只有空白或超过 64 个码点、没给 previous）在花钱之前报 make_pack_input_invalid，field 是 retag，details.segment 是哪一段（规则在 lib/make-pack-input.mjs）。
//                       改了名的段报告里 tagSource 是 material；撞名时谁加序号见 lib/make-pack-tags.mjs。被设定引用的标签改了名，设定的 referenceTag 要一起改，不然花钱之前报错。
//                       只改名也发得成新版本：报告的 version.changes.retagged 是改了标签的段名，没写变更说明时生成的那句写明改了哪几段
//     name 可以不给（沿用上一版的）；guidance、direction、sampleLines、setups、designSource、scripts、enhancers、features、requires、files 给了就换掉上一版的（files 按路径合并；sampleLines、setups 给空数组就是去掉），没给就沿用。
//     例外是 designSource：没给、上一版的段这一版又一段都没留下（都 drop 了，换了来源）的，不沿用，这一版没有设计来源，报告的 notes 里有 design_source_dropped（规则在 lib/pack-version.mjs 的文件头「设计来源」）
//     cardLine 给了就重配（请求和上一版那一句一模一样时换一个 seed，上一版的加 1，lib/make-pack-card-line.mjs 的 voiceCardLine）；没给的，上一版有那一句就原样沿用，不重配（carriedCardLine）
//   }
//
// options（都可选）：
//   random          () => [0, 1) 的随机数，盲听的顺序用它（测试注入固定的）；省略用 Math.random
//   idRandom        (长度) => Uint8Array，包 ID 的随机字节（测试注入）；省略用 crypto.getRandomValues
//   now             () => Date，验证记录的日期
//   environment     验证记录里的环境名，例如适配器的名字（命令行上是 cli/adapters.mjs 的 environmentName）
//   holdoutRatio, maxHoldout, maxReferences, minHoldoutTokens, maxSynthesisChars   挑素材的参数，默认值和规则见 lib/pack-material.mjs。holdoutRatio 为 0 就是不留出录音：报告也不给 no_holdout、holdouts_few（lib/material-hints.mjs 的 noHoldout）
//   minChars        合成能力一次至少要多少个字（环境声明的：命令行上是适配器的 limits.minChars，app 是 contract 的 minTextChars）。给了，规划和试合成都按它算：
//                   留出录音里文字不够的不合成、不算费用，报告的 trial.items 里写明「比合成能力的下限短」（lib/dub.mjs、lib/make-pack-trial.mjs）；不给就没有下限
//   maxChars, maxPauseInRequestMs   配卡片试听那一句时交给配音的两项上限（环境声明的，意思同 lib/dub.mjs 的同名选项；命令行上是适配器的 limits），不给照配音的默认。写错抛 make_pack_input_invalid
//   thresholds      音质检查的阈值（tools/audio-quality.mjs 的 judgeReference 的写法），省略用默认
//   loudness        调响度（规则在 lib/make-pack-loudness.mjs 的文件头）：省略或 true 用默认目标，false 不调，{ targetLufs?, peakCeilingDbfs?, limiter? } 改目标、上限和限幅器（limiter: false 关掉限幅器，回到只加增益；{ maxDb } 改最多压多少 dB）。写错抛 make_pack_input_invalid（field 是 loudness）
//   concurrency     调能力的并发数，1–8，默认 2
//   describeChanges (changes, { name }) => string：发新版本、作者又没写变更说明（input.changelog）时，用它把这次的变化写成一句话；调用方要别的语言、别的写法时给。不给就用
//                   lib/pack-version.mjs 的 changelogOf（中文，命令行就是这样）。changes 是 diffVersions 的结果（形状见 lib/pack-version.mjs，只读），name 是这一版的名字；可以是异步函数。
//                   返回值去掉两头空白，超过 CHANGELOG_MAX 个字符的截断、末尾加「…」（库自己写的也是这样）；不是字符串、或者是空白，抛 make_pack_input_invalid（field 是 describeChanges）。
//                   选项本身不是函数，在入口就抛同一个错；返回值要等挑完素材、算出变化以后才看得到，所以返回值写错是在转写、挑默认段之后才报。
//                   作者写了变更说明、第一个版本、什么都没变（不发新版本）时不调它；报告里 changelogSource 仍是 'generated'
//   maxErrorRate    收音校验的上限，省略用 lib/fidelity.mjs 的 DEFAULT_MAX_ERROR_RATE
//   retryWait       (毫秒) => Promise：转写、挑默认段、标提示标注、试合成暂时出错、再试之前等多久（每段最多试 3 次，等 5 秒、15 秒，规则的正本是 lib/call-attempts.mjs）；不给就真的等。
//                   app 传一个按「取消」就停的，测试传一个马上返回的。不是函数，在入口就抛 make_pack_input_invalid（field 是 retryWait）
//   textLanguage    包里 SKILL.md 骨架（各节的标题和说明）用的语言：'zh'（省略就是它）或 'en'，调用方按作者的语言给（app 里是作者做包时的界面语言，命令行是 --text-language）；
//                   试装和正式装、第一个版本和发新版本都用这一次给的，发新版本不看上一版是什么语言。别的值抛 make_pack_input_invalid（field 是 textLanguage），在花钱之前。
//                   只管骨架：「## 配音指引」这一行所有语言都一样，作者写的名字、指引、描述、变更说明原样放进去，不翻译（规则的正本是 protocol/FORMAT.md「骨架的语言」）
//   evaluate        false 就不试合成、不量还原度（默认 true）
//   allowCrossLanguage  true 就照跨语言克隆配卡片试听那一句：包里给它挑的参考段不是这一句的语言（参考是日语，这一句是英文），也照配，带参考那种语言的口音。
//                   不给（默认 false）就不配这一句，包照做，报告的 cardLine 是 failed（error.code 是 dub_cross_language），提示是 card_line_cross_language（lib/make-pack-card-line.mjs 的 voiceCardLine「跨语言」）。
//                   不管试合成：试合成量的是声音本身，照旧跨语言也配（lib/make-pack-trial.mjs）。不是 true、false，抛 make_pack_input_invalid（field 是 allowCrossLanguage）
//   dryRun          true 就只做不花钱的几步（筛片段、查哪些能用），不调任何所需能力，不做包；返回 { plan, report }
//   onPlan          (plan) => void：不花钱的几步做完、第一次调所需能力之前交给它；plan.calls 是各项能力最多要调多少次。它抛错就停，什么都不调
//
// ---------------------------------------------------------------- 返回
//
//   { pack: { id, manifest, files }, report }
//   pack      packRolePart 的结果（protocol/lib/pack.mjs）：files 是包目录里的全部文件，含清单、SKILL.md、protocol/，给了 base 还有 voice-pack/
//   report    { segments, counts（references、holdouts、unused；realRecordings 是参考和留出录音里真录音的段数）, plan, steps, trial, fidelity, redo?, verification, cardLine, hints, notes, version?, defaultSegment, languageDefaults }
//             defaultSegment { id, language, rule, candidates?, why?, attempts?, model?, unpicked?, typicality?, tied?, unmeasured? }：主语言的默认段、它的语言（写法同参考段）和挑它的规则；
//             （'author' | 'previous' | 'model' | 'typical' | 'priority' | 'only'，规则 5）；
//             rule 是 'model' 时 candidates 是交给模型的几段（按优先级），why 是模型说的理由，attempts 是问了几次，model 是环境报的模型名（报了才有）；
//             unpicked 是请了模型、没挑成的：{ capability, candidates, status: 'voided' | 'not_heard' | 'failed', reason?, errorRate?, problem?, stopReason?, error?, attempts?, model? }
//             （字段的意思见 lib/make-pack-pick.mjs 的文件头），没请或者挑成了就没有这个字段；
//             rule 是 'typical' 时 typicality 是每段候选和其余参考的平均相似度，tied 是和最典型的那段差不多的几段（按优先级）；
//             unmeasured 是量相似度时抛了错、这一次退回按优先级的：{ capability, error: 错误的摘要（summarizeError：code、message、details） }，没有这种情况就没有这个字段；
//             languageDefaults 是别的语言各自的默认段，每项写法同 defaultSegment，次序同清单的 reference.languageDefaults（只有一种语言就是空数组）
//             segments 每一段的去向（参考、留出录音、没用上和原因；发新版本时还有 dropped）、语言和音色基底标签（参考段 { language, languageSource, tag, tagSource, renamedFrom? }，
//             留出录音 { language, languageSource }，写法在 lib/make-pack-report.mjs，来源的取值在 lib/make-pack-tags.mjs）、提示标注的结果（annotation：这一版新补的参考段才有）、调响度的情况（loudness）；
//             counts 数量；plan 各项能力最多调几次；
//             steps 转写、标提示标注（annotation，写法见 lib/make-pack-annotation.mjs）、调响度、试合成各一步的情况（长录音的句子模式另有 sentences）；trial 试合成；fidelity 还原度（读法的正本是 lib/fidelity.mjs 的文件头）；
//             redo 有「没听成」的盲听时，按 planRedo 说明补做要调几次；verification 写进清单的那一条验证记录（没量出来是 null）；
//             cardLine 卡片试听那一句配了没有、沿用了没有（status 是 voiced、carried、failed、none，写法见 lib/make-pack-card-line.mjs 的文件头）；
//             hints 还缺什么素材（lib/material-hints.mjs）；notes 前几步留下的说明（input.notes），后面接着发新版本留下的（design_source_dropped，lib/pack-version.mjs 的 versionNotes）、沿用上一版的设定合成的开头的提示超长的（setup_opening_cue_too_long，lib/make-pack-input.mjs 的 checkSetupOpeningCues）、读音词表里只写了一个字的词条（lexicon_single_character，lib/pronunciation-lexicon.mjs 的文件头「只写一个字的词条」）和调响度这一步留下的；
//             version 发新版本时才有：{ previous, next, bump, changelogSource: 'author' | 'generated', changes, verification: { status, droppedFromPrevious } }
//   evaluation  量还原度用的那一批数据（参考、留出录音、合成出来的录音），补做「没听成」的盲听时要用；没量就是 null
//
// 抛出的错误（VoicePackError；code 小写下划线，details 里放什么在抛出处写明）：
//   make_pack_input_invalid     输入不合约定。details.field 是出问题的字段（segments[2].audio、segments[2].tag、setups[0].referenceTag、setups[0].expressiveness……），details.problem 说哪里不对；设定合成的开头的提示超过 lib/cue-length.mjs 的 MAX_OPENING_CUE_WORDS 个词时 field 是 setups[0]，details 另有 words、limit
//   make_pack_no_material       没有一段能用，做不出包。details.unused 是没用上的原因和条数（{ no_text: 2, audio_undecodable: 1 }）；有段没有逐字文本、环境又没有
//                               automatic-speech-recognition 时，details.missingCapability 是 'automatic-speech-recognition'，说明里写怎么办（接一个有转写的适配器，或者每段配上逐字文本）；
//                               有段不是包能放的格式、环境又没有 ffmpeg 取音轨时，details.missingRuntime 是 'ffmpeg'，说明里写怎么办（装上 ffmpeg，或者先转成包能放的格式）。
//                               花钱之前看得出的（规划里能用的段是 0）在规划之后、第一次调所需能力之前就报，dryRun 也报；转写以后才看得出的（转写不出文本、认不出语言）在挑参考时报
//   make_pack_nothing_changed   发新版本，却和上一版比什么都没变（新补的素材没一段用得上、别的也没改）。details: { previous, unused }，不发空的新版本
//   make_pack_version_invalid   明说的版本号不比上一版大。details: { previous, version }
//   make_pack_previous_invalid  上一版读不了。details.reason 见 lib/pack-version.mjs 的文件头
//   make_pack_trial_mismatch    试合成规划出的段数和留出录音的条数不一样（配音把某条留出录音的文本切成了几段，或者合并了），没法把合成的音频和留出录音一条对一条地比：
//                               做包停下来，不拿对不上的东西去量还原度。details: { holdouts, units }
//   capability_result_invalid   转写（automatic-speech-recognition）的返回不合约定：不是 { text: 字符串, … }。details: { capability, problem }。
//                               别的能力的返回不合约定也是这个 code；都抛在各自的模块里（lib/make-pack-transcribe.mjs、lib/dub.mjs、lib/fidelity.mjs、lib/segment-annotation.mjs、lib/default-pick.mjs）
//   参考集的段数、包解开以后的总大小撞上格式写明的上限：在转写之前就报，一个付费步骤都不走，dryRun 也报（lib/make-pack-assemble.mjs 的 assertFitsFormat，按切出的段数和估算的大小，估法写在那里）。
//                               报的是格式那一条的原话，码和装包时一样：manifest_invalid（details.problems[0].details 是 { pointer: '/reference/segments', keyword: 'maxItems' }）、total_too_large；details.estimated 为真
//   另外 pack_invalid、manifest_invalid 来自 protocol/lib/pack.mjs；所需能力自己抛的错原样往上传（401 之类要让调用方看见），
//   服务暂时出错（details.transient）的那一项记在报告里，不让整件事作废。例外只有一处：配卡片试听那一句（包做好以后最后一次调能力）碰到凭据被拒（401）、
//   账户停了（details.halted）不往上抛，包照做（钱已经花在包上了，抛出去包就扔了），报告的 cardLine 标 halted、提示 card_line_halted 要使用者先处理（lib/make-pack-card-line.mjs）。上一版的文件和它自己的清单对不上（file_modified、external_hash_mismatch……）
//   来自 lib/voice-pack.mjs（读上一版时用 verify: true），原样抛出：不在被改过的东西上发新版本。
//
// 用到的所需能力和运行时（签名都只写在 vocab/capability-signatures.md，这里不抄；缺了，只有用到它的那一步跳过，报告里写明）：
//   @capability automatic-speech-recognition  没有文本的片段转写成文本；缺了，没有文本的片段没法补文本，不能用（no_text）。标提示标注时也用它量每段的停顿和快慢（lib/point-measure.mjs，量失败只用听的结果）。
//                                  转写暂时出错（details.transient 为 true）先重试，每段最多转写 3 次（lib/call-attempts.mjs），试满了还没成才记成 transcription_failed，那一段用不上；
//                                  被服务商拦下（provider_blocked）不重试，记成 transcription_blocked，那一段用不上，别的段照做；照暂时出错报的被拦下（details.problem 是 provider_blocked），
//                                  照暂时出错再试，试满了、最后一次还被拦也记成 transcription_blocked（lib/make-pack-transcribe.mjs）；别的错原样往上传，不重试
//   @capability audio-text-to-text 挑默认段（lib/default-pick.mjs，默认段没点名、没沿用、候选至少两段时每种语言问一次）、
//                                  给参考标提示标注（lib/segment-annotation.mjs，素材没给音色基底标签的段，同一次里顺带要一个短名字当标签）和盲听（lib/fidelity.mjs）；
//                                  不给片段打情绪、风格的标签，也不为一个名字另调一次。
//                                  缺了，默认段按相似度或优先级挑，参考只存逐字稿（报告的 steps.annotation 写明哪几段没标），素材没给标签的段用段名当标签，盲听量不了。
//                                  挑默认段的规则（暂时出错重试、作废、出错退回）写在 lib/make-pack-pick.mjs 的文件头；
//                                  标提示标注每段参考听 3 次、取一致（lib/segment-annotation.mjs），每一次听暂时出错先重试，最多问 3 次（lib/call-attempts.mjs）；被服务商拦下（provider_blocked）这一段就停；回答不是固定格式这一次不算，能用的不足 2 次才作废
//                                  （lib/make-pack-annotation.mjs 的文件头）；没标上的段只存逐字稿，报告写明是哪几段、为什么。盲听出错不在这里重试（lib/fidelity.mjs 有自己的补做）
//   @capability voice-cloning      试合成留出录音、配卡片试听那一句（都走 lib/dub.mjs）；缺了不能试合成，所以不量还原度，那一句也没配成（报告写明）
//   @capability speaker-verification  说话人相似度、真人基线（lib/fidelity.mjs）；缺了说话人相似度量不了（盲听照做）。能听音频的模型没挑默认段时，挑默认段也用它（lib/make-pack-pick.mjs）：
//                                  有它，默认段挑和其余参考平均最像的那一段（参考之间两两量，留出录音不量）；没有，就按优先级挑，报告的 defaultSegment.rule 写着是哪条。
//                                  量的时候抛的错（不是 no_speech）不往上传：这一次的默认段退回按优先级，报告的 defaultSegment.unmeasured 写明错误，做包接着做；
//                                  调用方中止（AbortError）和凭据被拒（401，或 details.halted）照旧往上传
//   ffmpeg（运行时，签名在 tools/audio-decode.mjs）  解不了 WAV 以外的音频：包能放的格式（mp3、flac、ogg、m4a）没写起止秒的，那一段不做音质检查，也不调响度，按「没量过」处理。
//                                  有两种段用不上（取音频那一步淘汰，lib/make-pack-take-audio.mjs）：不是包能放的格式的（带视频轨的 mp4、mov、mkv，webm、aac 这类）取不出音轨，
//                                  记 audio_unrecognized（details.runtime 是 'ffmpeg'）；写了起止秒（trim）的非 WAV 音频切不了，记 audio_undecodable
//
// ---------------------------------------------------------------- 流程，和各步的模块
//
// makePack 只管次序，一步一步调下面的模块；每一步的规则、读写条目的哪些字段、抛哪些错误，写在那一步的模块的文件头里（一个模块只为一件事改动，规则只在那里写一遍）：
//   读输入和选项      lib/make-pack-input.mjs       输入和选项写错了，在花钱之前报 make_pack_input_invalid
//                    （调用方花钱准备段之前，lib/make-pack-precheck.mjs 先查一遍这里到「试装」为止只看输入的几项：这里加了花钱之前的检查，那边跟着加）
//   取音频（不花钱）   lib/make-pack-take-audio.mjs  不是包能放的格式的取音轨（要 ffmpeg），写了起止秒（trim）的切出那几秒；取不出、切不出、同一个文件重叠的淘汰
//   筛片段（不花钱）   lib/make-pack-screen.mjs      认格式、查重、量音质
//   句子合段         lib/make-pack-sentences.mjs   长录音的句子先并成段（不花钱，在筛片段之后、规划和转写之前；合好的段再筛一遍，一段转写一次；没有句子就不做）
//   试装、规划（不花钱） lib/make-pack-assemble.mjs、lib/make-pack-plan.mjs   试装一遍；算各项能力最多调几次（plan）；参考集的段数和包的总大小撞上格式上限就在这里报（assertFitsFormat）；onPlan 和 dryRun 在这里
//   转写             lib/make-pack-transcribe.mjs  没有文本的片段转写成文本
//   语言和标签        lib/make-pack-tags.mjs        定语言（转写以后）；设定的 referenceTag 花钱之前查、付费以后再查；标完提示标注以后定音色基底标签（撞名加序号）
//   挑参考           lib/make-pack-pick.mjs        参考集、留出录音、默认段（挑的规则在 lib/pack-material.mjs；请能听音频的模型挑默认段在 lib/default-pick.mjs）
//   发新版本          lib/pack-version.mjs          读上一版、版本号、和上一版比、变更说明
//   标提示标注        lib/make-pack-annotation.mjs  给这一版新补的每段参考标提示标注（素材给了的照给的；一段的听和拼在 lib/segment-annotation.mjs，量停顿和快慢在 lib/point-measure.mjs），素材没给标签的段同一次里要一个名字。
//                                                  在「什么都没变就不发」之后，不发的版本不花这份钱
//   调响度           lib/make-pack-loudness.mjs    写进包里的参考和留出录音统一到同一个响度（「调响度」的规则在它的文件头）
//   装包             lib/make-pack-assemble.mjs    把素材装成角色部分
//   试合成和还原度     lib/make-pack-trial.mjs       合成留出录音，量还原度，写验证记录
//   卡片试听那一句     lib/make-pack-card-line.mjs   花钱之前查它配得成一个请求；包做好以后用这个包配（发新版本没给的，沿用上一版的），再装一次包（和验证记录一起）
//   报告             lib/make-pack-report.mjs      每一段的去向、dryRun 和最后的 report 怎么写
// 每一段在流程里是一个条目（item）：各步读它、写它，条目有哪些字段，见 lib/make-pack-input.mjs 的文件头和各步的文件头。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { DEFAULT_MAX_ERROR_RATE } from './fidelity.mjs';
import { readPreviousVersion, nextVersion, effectiveOf, versionNotes, assertSomethingNew, releaseChanges, withoutCardLine, changelogFor } from './pack-version.mjs';
import { assertInput, readInput, readOptions, materialOptionsOf, checkSetupOpeningCues } from './make-pack-input.mjs';
import { takeAudio } from './make-pack-take-audio.mjs';
import { screen } from './make-pack-screen.mjs';
import { transcribe, settleText } from './make-pack-transcribe.mjs';
import { resolveLanguages, assertReferenceTagsKnown, assertReferenceTagsPlaced, referencedTagsOf, assignTags, carriedTags } from './make-pack-tags.mjs';
import { mergeSentences } from './make-pack-sentences.mjs';
import { assertDefaultsUsable, assertSomeUsable, pickMaterial } from './make-pack-pick.mjs';
import { annotateReferences } from './make-pack-annotation.mjs';
import { adjustLoudness } from './make-pack-loudness.mjs';
import { preflight, assertFitsFormat, placeMaterial, assembler } from './make-pack-assemble.mjs';
import { evaluatePack, verificationOf } from './make-pack-trial.mjs';
import { assertCardLineSpeakable, voiceCardLine, carriedCardLine } from './make-pack-card-line.mjs';
import { buildPlan } from './make-pack-plan.mjs';
import { dryRunOf, resultOf } from './make-pack-report.mjs';
import { LEXICON_FILE, lexiconNotes } from './pronunciation-lexicon.mjs';

/**
 * 做包。输入、选项、返回和错误见文件头。
 * @param {object} env 注入的运行环境（所需能力、运行时）
 * @param {object} input 片段列表和包的描述
 * @param {object} [options]
 * @returns {Promise<{ pack: { id: string, manifest: object, files: Map<string, Uint8Array> }, report: object, evaluation: object | null }>}
 */
export async function makePack(env, input, options = {}) {
  assertInput(input);
  const settings = readOptions(options);
  const previous = input.previous === undefined ? null : await readPreviousVersion(env, input.previous);
  const { items: entries, version, direction, cardLine, cardLineExpressiveness } = readInput(input, previous);
  let items = entries; // 句子模式：筛过片段以后，句子换成合好的段（见下）
  // 版本号先定下来：明说的不对，在花钱之前就报
  const versionNumber = previous === null ? version.version : nextVersion(previous.version, { version: version.version, bump: version.bump });
  const effective = effectiveOf(input, direction, previous);
  const setupCueNotes = checkSetupOpeningCues(effective.setups, { carried: previous !== null && input.setups === undefined }); // 设定合成的开头的提示要短：给的超了报错（花钱之前，dryRun 也报），沿用上一版的超了记 note
  // 报告的说明：前几步留下的，接着发新版本留下的（上一版的设计来源不沿用，lib/pack-version.mjs），
  // 这一版包里的读音词表（这一次给的，没给就是上一版带来的）有只写一个字的词条（lib/pronunciation-lexicon.mjs 的 lexiconNotes，只提醒，不拦）
  const lexiconFile = effective.files.get(LEXICON_FILE);
  const notes = [...(input.notes ?? []), ...versionNotes(previous, input), ...setupCueNotes, ...(lexiconFile === undefined ? [] : lexiconNotes(lexiconFile))];
  const carried = carriedTags(items); // 上一版带来的参考这一版的标签（作者改了名的算上）：花钱之前就定得下，「变了什么」比它
  const concurrency = settings.concurrency ?? 2;
  const maxErrorRate = settings.maxErrorRate ?? DEFAULT_MAX_ERROR_RATE;
  const materialOptions = materialOptionsOf(settings);
  const steps = {};

  // 不花钱的几步：裁剪（写了起止秒的段先切出那几秒），筛片段，查出花钱之前能查出的问题，试装，规划
  await takeAudio(env, items);
  await screen(env, items, { thresholds: settings.thresholds, loudness: settings.loudness });
  // 句子模式（长录音）：句子先并成段，再一段转写一次（不花钱，在规划和转写之前：句子不逐句转写、不逐句听，规划和费用都按段数算）。
  // 合成的段和别的段一样量音质（规则在 lib/make-pack-sentences.mjs）；点名的默认段是句子的，换成它所在的段
  const sentences = mergeSentences(items);
  if (sentences.step.sentences > 0) {
    items = sentences.items;
    await screen(env, sentences.merged, { thresholds: settings.thresholds, loudness: settings.loudness });
    steps.sentences = sentences.step;
    version.defaultSegments = [...new Set(version.defaultSegments.map((id) => sentences.aliases.get(id) ?? id))];
  }
  const fresh = items.filter((item) => item.previous === undefined); // 这一版新补的（句子模式是合好的段）
  assertDefaultsUsable(items, version.defaultSegments, materialOptions);
  assertReferenceTagsKnown(items, effective.setups); // 设定的默认参考（referenceTag）要是素材给的标签、或者上一版参考的标签：对不上花钱之前就报（dryRun 也报）
  if (previous !== null) await assertSomethingNew(previous, { effective, items, fresh, defaultSegments: version.defaultSegments, tags: carried, cardLine }); // 花钱之前先看一眼：新补的素材一段都用不上、别的也没改（只改了标签也算改了），就不用往下做了
  const context = { effective, input, previous, versionNumber, changelog: version.changelog, textLanguage: settings.textLanguage };
  const stub = await preflight(items, context, { cardLine });
  const limits = { maxChars: settings.maxChars, minChars: settings.minChars, maxPauseInRequestMs: settings.maxPauseInRequestMs }; // 配卡片试听那一句时交给配音的上限
  if (cardLine !== undefined) await assertCardLineSpeakable(env, stub, cardLine, limits); // 卡片试听那一句配不配得成一个请求：花钱之前就报（dryRun 也报）
  // 默认段花钱之前就定了的语言（作者点名的，或者发新版本时沿用上一版的），不请模型挑，费用里不算那一次（lib/make-pack-plan.mjs）
  const before = previous?.manifest.reference;
  const previousDefaults = before === undefined ? [] : [before.defaultSegment, ...(before.languageDefaults ?? [])];
  const pinned = [...version.defaultSegments, ...items.filter((item) => item.previous === 'reference' && previousDefaults.includes(item.id)).map((item) => item.id)];
  const plan = buildPlan(env, items, settings, materialOptions, { pinned, cardLine: cardLine !== undefined });
  assertFitsFormat(env, items, plan, context, { maxReferences: materialOptions.maxReferences, reencoded: settings.loudness !== null, cardLine }); // 参考集的段数、包解开的总大小（连卡片试听那一句）撞上格式的上限：转写之前就报（dryRun 也报）
  assertSomeUsable(env, items); // 一段能用的都没有（筛掉了，或者没有逐字文本、环境又不能转写）：花钱之前就报 make_pack_no_material，dryRun 也报
  if (settings.dryRun === true) return dryRunOf({ plan, items, fresh, previous, versionNumber, steps, notes });
  await settings.onPlan?.(plan); // 花钱之前：不花钱的几步都做完了，调用方在这里说明费用，抛错就停

  // 转写（调所需能力），定语言
  steps.transcription = await transcribe(env, items, { concurrency, wait: settings.retryWait });
  settleText(items);
  resolveLanguages(items);
  // 设定引用的标签，带着它的段这次没能用上（例如转写没成）：停下，不再花挑默认段、标提示标注的钱
  assertReferenceTagsPlaced(items, effective.setups);

  const { chosen, roleOf } = await pickMaterial(env, items, { previous, version, materialOptions, referencedTags: referencedTagsOf(effective.setups), maxErrorRate, wait: settings.retryWait });
  // 参考集定了：再查一遍设定引用的标签在参考集里（参考上限裁掉的也在这里报），在标提示标注之前，做不成的包不再花这份钱
  assertReferenceTagsPlaced(items, effective.setups, { referenceIds: chosen.references });
  const byId = new Map(items.map((item) => [item.id, item]));
  // 卡片试听那一句：给了就要重配；没给、上一版有的，沿用（见下面「卡片试听那一句」）
  const plannedCard = cardLine !== undefined ? { text: cardLine, revoiced: true } : previous?.cardLine ? { text: previous.cardLine.text } : undefined;
  // 发新版本：这一版比上一版变了什么（什么都没变就不发；变更说明作者没写就按这个生成）
  let { changes, changelog } = await releaseChanges(previous, { effective, chosen, fresh, changelog: version.changelog, describeChanges: settings.describeChanges, tags: carried, cardLine: plannedCard });
  // 标提示标注（调所需能力）：参考集定了才标，每段参考听 3 次，留出录音不标；放在「什么都没变就不发」之后，不发的版本不花这份钱。
  // 素材没给标签的段，同一次里顺带要一个短名字（用骨架的语言），不另调
  steps.annotation = await annotateReferences(env, items, chosen.references, { concurrency, maxErrorRate, wait: settings.retryWait, nameLanguage: settings.textLanguage });
  // 给每段参考定音色基底标签：素材给的、模型给的名字、段名（撞名加序号，只在参考集里）
  assignTags(items, chosen.references);

  // 调响度：量音质、挑默认段、标提示标注都是照原始音频做的，到这里才把要写进包里的参考和留出录音统一响度。后面写进包、试合成、量还原度用的都是调过的这份
  const loudness = await adjustLoudness(env, [...chosen.references, ...chosen.holdouts].map((id) => byId.get(id)), settings.loudness);
  steps.loudness = loudness.step;
  const material = placeMaterial({ chosen, byId, effective });
  const assemble = assembler({ context, changelog, material, idRandom: settings.idRandom });

  let made = await assemble();
  const evaluated = await evaluatePack(env, made, byId, { enabled: settings.evaluate, concurrency, maxErrorRate, random: settings.random, externals: material.externals, wait: settings.retryWait, minChars: settings.minChars });
  steps.trial = evaluated.trial;
  const verification = verificationOf(evaluated.fidelity, { environment: input.environment ?? settings.environment ?? 'unspecified', models: evaluated.trial.models ?? [], now: settings.now ?? (() => new Date()) });
  // 卡片试听那一句：给了就用做好的包配（没配成，包照做、清单里没有它）；没给的，上一版的那一句原样沿用，报告里比一比和现在的配法（都在 lib/make-pack-card-line.mjs），上一版没有就是没有
  const card = cardLine !== undefined
    ? await voiceCardLine(env, made, cardLine, { externals: material.externals, wait: settings.retryWait, limits, previous, previousFiles: input.previous, allowCrossLanguage: settings.allowCrossLanguage === true, expressiveness: cardLineExpressiveness }) // 上一版：用同样的请求重配就换一个 seed
    : (await carriedCardLine(env, previous, made, { previousFiles: input.previous, externals: material.externals, limits })) ?? { outcome: { status: 'none' }, audio: null };
  if (plannedCard !== undefined && card.audio === null) {
    // 打算放的这一句最后没有（要重配的没配成）：变了什么照实改，作者没写变更说明的重写一遍
    changes = withoutCardLine(previous, changes);
    if (changes !== null && version.changelog === undefined) changelog = await changelogFor(changes, { describeChanges: settings.describeChanges, name: effective.name });
  }
  if (verification !== null || card.audio !== null || (changelog !== undefined && changelog !== made.manifest.changelog)) {
    made = await assemble({ id: made.id, ...(verification === null ? {} : { verification: [verification] }), ...(card.audio === null ? {} : { cardLine: card.audio }), ...(changelog === undefined ? {} : { changelog }) });
  }

  return resultOf({ made, evaluated, verification, items, fresh, chosen, roleOf, previous, version, changes, effective, byId, plan, steps, inputNotes: notes, loudnessNotes: loudness.notes, noHoldout: materialOptions.holdoutRatio === 0, cardLine: card.outcome });
}

export { DEFAULTS as MATERIAL_DEFAULTS } from './pack-material.mjs';
