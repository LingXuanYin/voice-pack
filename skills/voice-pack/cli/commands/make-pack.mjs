// SPDX-License-Identifier: Apache-2.0
//
// make-pack 命令：作者交来一批切好的录音（每段一个音频文件加它说的话），做成一个音色包的角色部分（或完整包）：筛片段、转写没有文本的、定语言、
// 挑出参考集和留出录音、给参考定音色基底标签、标提示标注、试合成、量还原度、提示还缺什么素材；也能给已有的包发新版本。流程在 lib/make-pack.mjs（输入、选项、报告、错误的正本在它的文件头），
// 这个命令只管读文件、组装运行环境、把包和报告写出来。
//
//   node cli.mjs make-pack [<素材目录|素材.json>] [--recording <文件|目录>] [--audition <文件|目录>] [--no-separate] --output <新目录> --name <名字> [--base-version <x.y.z>]
//                          [--short-name <英文短名>] [--language <标签>] [--text-language <zh|en>] [--guidance <文件.md>] [--direction <文件.json>] [--design-source <文件.json>] [--lexicon <文件.pls>] [--sample-lines <文件.json>] [--card-line <文件.txt> [--allow-cross-language] [--card-line-expressiveness <0 到 100>]] [--expressiveness <0 到 100|none>] [--setups <文件.json>]
//                          [--previous <上一版的包目录> [--version <x.y.z> | --bump patch|minor|major] [--changelog <说明>] [--drop <段名,段名>] [--retag <段名>=<标签>]...] [--default-segment <段名>]...
//                          [--source-pack <来源包的目录或分享文件>]
//                          [--protocol <协议核心目录>] [--base <基础部分目录>]
//                          [--adapter <名字|模块文件>]... [--adapter-option <键=值>]... [--environment <名字>]
//                          [--dry-run] [--no-evaluate] [--no-loudness] [--no-limiter] [--no-holdout] [--seed <整数>] [--max-error-rate <数>] [--concurrency <1-8>] [--save-evaluation <新目录>] [--share-file <分享文件>] [--json]
//
// 素材（片段列表）：
//   目录：里面的每个音频文件是一段（带视频轨的 .mp4、.m4v、.mov、.mkv 也算，见下面「带视频轨的文件」）。同名的 <名字>.json 记这一段的 { id?, text?, annotatedText?, language?, tag?, source?, externalUrl?, synthetic?, sentence?, trim? }（字段的意思见 lib/make-pack.mjs 文件头「输入」）；
//     没有 .json 但有同名的 <名字>.txt，里面的文字就是这段的逐字文本。两样都没有就是「没有文本」（环境有转写就转写，没有这一段用不上）。
//     段名：.json 里写了 id 就用它，没写就用文件名（小写字母、数字、连字符、下划线；别的字符换成连字符，换不出合格的名字就让库按次序起 seg-001……）。按文件名排序。
//   素材.json：{ "segments": [ { "id"?, "audio": "audio/a.wav", "text"?, "annotatedText"?, "language"?, "tag"?, "source"?, "externalUrl"?, "synthetic"?, "sentence"?, "trim"? } ] }（也可以直接是这个数组）；audio 是路径，相对这个 JSON 所在的目录。
//   language 是这段的语言，tag 是这段的音色基底标签（「平常」「愤怒」「少年」……，只用来在几段参考之间切换），和清单同名。
//     不给的，环境有 audio-text-to-text 时，标提示标注那一次顺带让模型起一个短名字（用 --text-language 的语言，不另调）；没有这项能力、这段没标上提示标注、
//     名字是空白的、素材给了 annotatedText（这段不调模型）的，用段名。同一种语言里撞名的加序号。上一版参考的标签用 --retag 改（见下）。
//     旧写法的 labels 不收：报 make_pack_input_invalid（field 是那一段的 labels），改写成 language、tag。
//   annotatedText 是这段的提示标注（逐字稿加上方括号提示的整句，提示以外的字和 text 一样）：给了就照给的，这段不再让模型标。
//     提示以外的字和 text 对不上，花钱之前报 make_pack_input_invalid；只给它不给 text，text 就是去掉提示的那句，这段不转写（规则在 lib/make-pack.mjs 文件头「输入」）。
//     作者要改上一版里一段的提示标注：--drop 那一段，再当素材重新给（换一个段名：去掉的段名这一版还不能再用），带上新的 annotatedText。
//     前面几步（分离、切段、转写）留下的说明可以写在 { "notes": [ { "code", "message", "details"? } ] } 里，原样进报告。
//   sentence 是 { bodySec, pauseSec }：这段是一句话（句子的秒数，和它后面原来的停顿）。长录音的句子模式给（--recording，见下），素材 .json 也可以写（references/make-pack.md「素材」）；
//     带它的几段由 makePack 先并成段（lib/make-pack-sentences.mjs）。
//   trim 是 { startSec?, endSec? }：只用这个文件里的这几秒（从文件开头算的秒），makePack 先切出来再做别的（lib/make-pack-take-audio.mjs）。一个文件里有几处能用的，写成几段，audio 指同一个文件：
//     素材.json 里指同一个路径的几段，文件只读一次，几段共用同一份字节（makePack 认出是同一个文件，只解一次码）。各段的 trim 不要重叠，重叠的后一段用不上（duplicate_audio）。
//     写法查在 lib/make-pack-input.mjs（至少 0.1 秒，外部资源不收）；起点超出录音的段用不上（trim_out_of_range），文字输出写明录音多长。--source-pack 查重只比切出来的那几秒。
//   带视频轨的文件（从视频、动画、游戏里截的片段）：后缀 .mp4、.m4v、.mov、.mkv（cli/audio-files.mjs 的 VIDEO_EXTENSIONS），素材和 --recording 都收，字节原样交给库，
//     由库取第一路音轨、存成 WAV。要环境有 ffmpeg：没有的话，素材里的这段用不上（audio_unrecognized，文字输出写「环境没有 ffmpeg，取不出音轨」），
//     --recording 交的整条命令停下，报 runtime_missing（lib/long-recording.mjs 先解码，这段录音一项能力都没调）。包里的参考照旧是音频；--recording 交给分离、VAD 的也是取出来的音轨。
//     外部资源（externalUrl）不取音轨（lib/make-pack-take-audio.mjs 的文件头）。
//     文字输出里取过音轨、切过的段，后面写「（音轨取自 <MIME 类型>，切了第 X 到 Y 秒）」。
//   发新版本时可以不给素材（只改指引、只换参考也行）。
//   长录音和默认音色、融合出来的试听（--recording、--audition）：不用先自己切。命令把每段录音（分离）切开，交给 makePack 转写、做包：长录音切成句子，makePack 先把句子并成 5–20 秒的段，再一段转写一次
//     （lib/make-pack-sentences.mjs：句子不逐句转写、不逐句先听，并段不按语言分开，规划和费用按段数算）；试听直接切成 5–20 秒的段。切段的规矩在 lib/long-recording.mjs 的文件头。
//     --recording <文件|目录>  一个音频文件（带视频轨的也行，见上面「带视频轨的文件」），或一个目录（里面每个音频文件是一段长录音，按文件名排）。环境有 audio-source-separation 就先分离出人声（--no-separate 不分离：输入已经是干净的人声）；
//                              环境有 voice-activity-detection 就用它给的说话区间切，没有按能量切。段名是「录音名-三位序号」（talk.wav → talk-001……）。
//                              前缀用过了就加 -2、-3，加到没用过为止：几段录音的名字转成同一个前缀的，第二个起加；素材里、上一版里（去掉的段也算）已经有「前缀-数字」这样的段名的也加
//                              （上一版有 talk-001，这一次的 talk.wav 切出来是 talk-2-001）；素材里有没写名字的段（库按次序起 seg-001……）时，seg 也算用过。
//     --audition <文件|目录>   默认音色、融合出来的试听：同样切开、转写，一部分当参考、一部分当留出录音（makePack 照规则挑），不分离（合成出来的本来就是干净的人声）。
//                              设计出来的声音不用它：设计的试听只当原料，不进交出去的包，见 references/make-pack.md「设计出来的声音怎么做包」。
//                              设计来源用 --design-source 写进清单；没给就在报告的说明里提醒（design_source_missing）。发新版本没给的，上一版的设计来源照规矩沿用就不提醒，
//                              不沿用（上一版的段一段都没留下，lib/pack-version.mjs 的 carriesDesignSource）照样提醒。
//     可以和素材目录、素材.json 一起给，段合在一起。段名不会重复：切出来的段起前缀时避开了素材里和上一版的段名（见上）；素材自己的段名重复、和上一版的段重名，在花钱之前报（下面「说明之前先查」）。转写由 makePack 做（只转写没有文本的段，费用在做包的规划里）；切段这一步不转写。
//     分离和 VAD 是花钱、耗时的调用，每段录音各一次，不重试：调之前在标准错误里说明（--json 时不说），--dry-run 不调，按能量切，只报段数。
//     说明之前先查只看输入就查得出的错（素材的段名、--retag、--drop、版本号、--setups 的 referenceTag、--card-line 配不配得成一个请求、清单的规矩、
//     要切出来的段名、素材里的句子和要切出来的句子标得一不一样（synthetic、annotatedText，lib/make-pack-input.mjs「句子」）……，lib/make-pack-precheck.mjs）：
//     查出来就报，分离和 VAD 一次都不调。
//     环境没有 automatic-speech-recognition 时，切出来的段都没有逐字文本，用不上（这两个选项不收逐字稿）：素材里也没有一段带着逐字文本、又不是发新版本，就做不出包，
//     这时不调分离和 VAD（和 --dry-run 一样按能量切），在花钱之前报 make_pack_no_material（lib/make-pack.mjs 文件头「抛出的错误」），--dry-run 报的一样。
//     命令自己在报告的 notes 里加的说明（[{ code, message, details }]，没有要说的数就是空对象；切段留下的说明见 lib/long-recording.mjs 的文件头，调响度留下的见 lib/make-pack-loudness.mjs 的文件头）：
//       dry_run_energy_cut      --dry-run 没调分离和 VAD，段数是按能量切的结果，真做时有 VAD 就用它。details: {}
//       design_source_missing   给了 --audition 却没给 --design-source，包里没有设计来源（发新版本、上一版的设计来源沿用过来的不算）。details: {}
//
// 选项：
//   --output <新目录>   把做出来的包写到这里（角色部分，给了 --base 就是完整包）。目录必须还不存在：不往已有的目录里写，也不覆盖上一版。检查在花钱之前做。--dry-run 时不要。
//   --name, --short-name, --base-version
//                       包的显示名、包 ID 里的英文短名、做包用的基础部分版本。发新版本时 --name 可以不给（沿用上一版的）。--base-version 省略时取正在运行的这份基础部分
//                       自己的版本（它的 manifest.json）；开发树里没有封印过，就要明说。
//   --language          给所有片段的默认语言标签（片段自己的 language 盖过它，两种都算素材给的，报告的 languageSource 是 material）。没有默认的音色基底标签。不给就由转写或文字本身认；认不出的用不上（language_unknown）：转写不报语言时，拉丁字母的文字认不出，
//                       所以没给 --language 又有要转写的片段，花钱之前在标准错误里提醒一行（接进来的适配器给了费用说明时就在费用说明里；--dry-run 的规划里也有；--json 时不说），不挡运行。
//   --text-language     包里 SKILL.md 骨架（各节的标题和说明）用的语言：zh（默认）或 en。给英文作者做英文包就给 en；别的值是用法错误（退出 2），在做任何事之前。
//                       只管骨架：「## 配音指引」这一行所有语言都一样，--name、--guidance、--direction 里写的字原样放进包，不翻译（规则的正本是 protocol/FORMAT.md「骨架的语言」）。
//                       发新版本时用这一次给的，不看上一版是什么语言；不给就是中文。
//   --guidance          配音指引的正文（Markdown 文件），放进 SKILL.md 的最后一节。--direction：{ description?, tags? }，tags 只能从设计词表选。
//                       --design-source：{ description?, model?, modelVersion?, date?, auditionLines? }，设计出来的声音、默认音色、融合出来的声音做包时写。--lexicon：读音词表（PLS），放进包里的 lexicon.pls。
//                       --sample-lines：示例台词，一份 JSON 数组，每项一句台词（字符串；最多 50 条，每条 1–500 个字符，不能只有空白；可以带舞台提示，例如（耳语）），原样写进清单；发新版本不给就沿用上一版的，给空数组就去掉。
//                         哪一项不是字符串（例如把 vocab/design-sample-lines.json 的对象原样抄进来）花钱之前报 make_pack_input_invalid（field 是 sampleLines[0]）。
//                       --card-line：卡片试听那一句，一个文本文件（UTF-8），整个文件是一句台词（去掉两头空白；1–500 个字符，可以带舞台提示）。包做好以后用这个包自己的声音配出来，
//                         写进清单的 cardLine，分享文件的卡片放它（lib/make-pack-card-line.mjs）；配不成一个请求在花钱之前报 make_pack_input_invalid（field 是 cardLine），
//                         配了没成包照做、报告里写明。发新版本不给，上一版有这一句就原样沿用，不重配（规则在 lib/make-pack-card-line.mjs 的 carriedCardLine）；要重配就交这一句。
//                         交的和上一版那一句的请求一样（同样的文字重配），换一个 seed（上一版的加 1，voiceCardLine），文字输出写明换了 seed。
//                       --allow-cross-language：给这一句挑的参考段不是这一句的语言（参考是日语，这一句是英文）也照配，跨语言克隆，带参考那种语言的口音。
//                         不给就不配这一句（配音默认不带口音，lib/dub.mjs 第 3a 步），一次都不调，包照做：报告的 cardLine 是 failed（dub_cross_language），
//                         「还缺什么素材」里是 card_line_cross_language，说怎么办（lib/material-hints.mjs）。不管试合成（量还原度照旧跨语言也配）。没给 --card-line 时它什么都不管。
//                       --expressiveness：这个声音的起伏（全局值，0 到 100 的整数，none 是去掉上一版的）；--card-line-expressiveness：卡片那一句单独取的起伏（只有这一次配的这一句用，要和 --card-line 一起给）。不是 0 到 100 的整数，在花钱之前报 make_pack_input_invalid。
//                       --setups：几套设定（固定到音色里），一份 JSON 数组，每项 { name, labels?, referenceTag?, speed?, instructions?, expressiveness?, default? }（写法见 protocol/FORMAT.md 4.4：labels 是 { language?, emotion?, style?, energy? }；
//                         instructions 是给写台本的人看的具体说明，配音时不发给模型，不限长；labels 的情绪、风格、能量合成的开头的提示超过 10 个词，--setups 给的报 make_pack_input_invalid（field 是 setups[0]，--dry-run 也报），
//                         沿用上一版的只在报告的 notes 里记一条 setup_opening_cue_too_long；
//                         expressiveness 是这套设定固定的起伏（0 到 100 的整数）：--setups 给的不是，在花钱之前报 make_pack_input_invalid（field 是 setups[0].expressiveness，--dry-run 也报），沿用上一版的不查，值也沿用；
//                         referenceTag 是这套设定的默认参考：素材里一段的音色基底标签，或者上一版参考的标签，对不上在花钱之前报 make_pack_input_invalid（field 是 setups[0].referenceTag，--dry-run 也报）；
//                         speed 是正数，名字不能重，最多一套带 default），
//                         原样写进清单；配音时 dub --setup <名字> 选一套，不选用带 default 的那一套。发新版本不给就沿用上一版的，给了就换掉，给空数组就去掉。
//   --recording, --audition, --no-separate
//                       长录音、试听（默认音色、融合）、不分离，见上面「素材」。--no-separate 只有给了 --recording 才有意义。
//   --previous          发新版本：上一版的包目录。包 ID 不变，版本号往上加（--version 明说，要比上一版大；或 --bump，默认 minor），上一版的参考和留出录音保持原来的角色，
//                       新补的素材接在后面。--changelog 不给就按变化生成一份。--drop 去掉上一版里不要的段（逗号隔开，可以多次给）。
//                       --retag <段名>=<标签> 改上一版一段参考的音色基底标签：一次一段，可以给几次；按第一个 = 拆，不按逗号拆（标签里可以有逗号、=）。
//                       没有 = 是用法错误（退出 2）；同一段给了两次，花钱之前报 make_pack_input_invalid（field 是 retag，details.segment 是哪一段）。
//                       别的规矩和报的错（哪些段能改、标签的写法、撞名、被设定引用的标签要一起改）见 lib/make-pack-input.mjs 的文件头。只给 --retag 也发得成新版本。
//                       上一版有外部资源时要取回来核对，环境得有 fetch。验证记录不带过来：这一版重新量，没量出来就没有（lib/pack-version.mjs 文件头）。
//   --default-segment   明说默认段：新包和发新版本都能给（不带 --previous 也行）。段名要是这次素材里的一段（或上一版的参考）；规则和理由在 lib/pack-material.mjs 的文件头。
//                       包里每种语言各有一段默认段，几种语言的包可以给几次，每次点名一段，那一段就是它自己的语言的默认段；一种语言只能点名一段，两段同一种语言报
//                       make_pack_input_invalid（field 是 defaultSegment；素材写了语言的在花钱之前报，要转写才知道语言的在转写之后报）。点名不定主语言：主语言是参考集里段最多的语言
//                       （发新版本时照旧是上一版的），它的默认段写进清单的 reference.defaultSegment，别的语言的写进 reference.languageDefaults（protocol/FORMAT.md 4.4）。
//                       没点名的语言，环境有 audio-text-to-text 就请它在这种语言的候选里挑一段（每种语言一次，lib/make-pack-pick.mjs），费用说明里算着这几次；点名了的语言不问。
//                       发新版本时没点名的语言沿用上一版的默认段。
//   --no-holdout        不留出录音（makePack 的 holdoutRatio 为 0）：能用的段都进参考集，报告不给 no_holdout、holdouts_few，规划里没有试合成。只管这次新挑的：发新版本时上一版已有的留出录音照旧带过来（要去掉用 --drop）。设计出来的声音做包时加它（写法见 references/make-pack.md）。
//   --source-pack       做「你自己的」一个新包时给：它是照着哪个包做的（目录，或分享文件）。给了就在花钱之前查重（lib/duplicate-check.mjs，规则、阈值、依据都在它的文件头）：
//                       新包的文字（描述、配音指引、示例台词、卡片试听那一句、设计来源的描述）和录音（--recording、--audition、素材里的每一段）和来源包比，重合太多就报 duplicate_detected 停下（没花过钱），
//                       说明是哪一项、量了多少、阈值是多少。只有用得上才给：来源包只在这一步读，不验签、不联网，也不往新包、标准输出、报告里写它的任何标识（路径、包 ID、名字）；
//                       新包有自己的包 ID，清单的 madeWith 只记做包用的基础部分的版本，没有来源包的记录。--dry-run 也查（查重不花钱）。
//                       怎么做一个干净的新包：先用 clean-room 命令准备输入，交给不认识来源包的会话去写文字，再回来用这个选项查（流程见 protocol/new-pack/README.md）。
//                       录音要整段解进内存再取指纹（WAV 以外的格式要 ffmpeg）：很长的长录音（二十分钟以上）会占几百兆。
//   --protocol, --base  协议核心的目录、基础部分的目录。省略时协议核心用这份基础部分自己的 protocol/，角色部分只做角色部分；给了 --base 就做成完整包（基础部分放进 voice-pack/）。
//                       协议核心要是封印过的（有 manifest.json）：开发树里没有，用官方发布的基础部分里的 protocol/，或者先用 seal 命令。
//   --adapter, --adapter-option, 官方适配器声明的简写和参数
//                       同 dub、fidelity：模型从适配器接进来（统一的入口和合并规则只在 cli/adapters.mjs 写，适配器的约定见 adapters/README.md）。
//                       环境没有 automatic-speech-recognition 或 speaker-verification 时，转写、说话人相似度量不了，要用的话再接一个有它的适配器。
//                       适配器给了费用说明（billing）时，每次花钱的几步开始之前，在标准错误里说明各项能力最多调几次（--json 时不说）。转写、挑默认段、标提示标注、试合成暂时出错会自己再试
//                       （每段最多问 3 次，规则只在 lib/call-attempts.mjs 写一份），多出来的上限各另起一行写明：这一次最多再加几次，实际调用不超过各项合起来的数（盲听出错不重试，不在里面）。
//   --environment       验证记录里「在哪个环境测的」。不给：用了适配器就是适配器的名字（几个用 + 连起来，名字的取法见 cli/adapters.mjs 的 environmentName），没用适配器不记名字（unspecified）。
//   --dry-run           只做不花钱的几步（认格式、查重、音质检查），说明各项能力最多调几次，不做包，不调任何所需能力，不写文件。
//   --no-evaluate       不试合成、不量还原度。
//   --no-loudness       不统一响度。默认把写进包里的参考和留出录音统一到 REFERENCE_LOUDNESS_LUFS、采样峰值不超过 PEAK_CEILING_DBFS（tools/loudness-normalize.mjs 里的两个常量；规则在 tools/loudness-normalize.mjs，
//                       怎么用在 lib/make-pack-loudness.mjs 的文件头）：音质检查照原始音频量，调的只是放进包里的那份字节，存成 16 位 WAV。
//                       加增益会让峰值超过上限的段（峰值比响度高 19 dB 以上的录音），默认用限幅器压住过高的峰再加（最多压 LIMITER_MAX_DB，参数和依据在 tools/loudness-normalize.mjs 文件头「限幅器」），
//                       压到最多还是到不了目标的，只加到能加的，报告里写明差多少、压了多少；上一版带来的段、外部资源、解不了的不动。关掉以后音频原样放进包里（不转码）。
//   --no-limiter        只关限幅器，响度照样统一：回到只加增益、加到峰值顶到上限为止，峰值太高的段到不了目标（报告里写明）。给了 --no-loudness 就没有意义（整个调响度都没做）。
//   --seed, --max-error-rate, --concurrency
//                       盲听先后的随机数种子；收音校验的阈值（默认见 lib/fidelity.mjs）；调能力的并发数，默认 2。
//   --save-evaluation <新目录>
//                       把还原度的评测集（真录音、合成出来的录音、评测集 JSON）和还原度报告写到这里（目录里有什么、评测集 JSON 的写法：cli/evaluation-set.mjs 的文件头）。盲听或说话人相似度有「没听成」时，补做就用它，不用重新合成：
//                         node cli.mjs fidelity <目录>/evaluation.json --redo <目录>/fidelity-report.json [<同样的适配器参数>]
//                       要调几次，做包的报告里已经写明（planRedo 算的）；适配器给了费用说明时，fidelity 开始之前还会在标准错误里再说一遍。补做的结果不改包里的验证记录：验证记录是做包那一刻量出来的，要更新就发新版本。
//   --share-file <分享文件>
//                       包做好、写到 --output 以后，再打一份分享文件（.voicepack.zip）到这里，里面带预览卡片（index.html）。文件必须还不存在，检查在花钱之前做；--dry-run 时不要。
//                       卡片上「在 X 里打开」的产品名和两个入口（打开、做一个你自己的）取自接进来的适配器给的 previewCard（形状和合并见 adapters/README.md 和 cli/adapters.mjs），
//                       不用自己给；没有适配器给，卡片上就没有产品名和入口（想自己给，用核心层的 pack 命令的 --product-name、--open-link、--make-link）。
//                       和 app 导出一样，这一步不验签、不做互相校验：只是把刚做好的包打成分享文件；要在分发之前核对，用 check 命令查这个分享文件。
//                       适配器给的链接不是 http、https 的地址时，包已经写到 --output 了，分享文件没有打出来（card_link_invalid）：别的都不用重做，修好链接用核心层的 pack 重打。
//   --json              标准输出是一份 JSON：{ packId?, version?, output?, evaluation?, shareFile?, recordings?, duplicateCheck?, report }（dry-run 是 { plan, recordings?, duplicateCheck?, report }）。
//                       shareFile 是 { file, bytes, sha256, card }（card 是预览卡片上的 { productName, open, make }，适配器没给就是 null），给了 --share-file 才有。
//                       duplicateCheck 是查重通过时的报告（lib/duplicate-check.mjs 文件头「返回和错误」），给了 --source-pack 才有。
//                       recordings 是每段长录音或试听的切段报告（lib/long-recording.mjs 的 report，加 kind、idPrefix），给了 --recording 或 --audition 才有。
//
// 输出：给人看的报告（素材去向、转写、标提示标注（哪几段没标上、为什么）、试合成、还原度、验证记录、还缺什么素材、每一段的语言和音色基底标签和来源、参考的提示标注）。还原度照 lib/fidelity.mjs 文件头「怎么读这份报告」显示：
//   量不了的一项报「量不了」并点名缺的能力，没听成的单独报并写明可以补做，都不是错误。
//
// 退出码：0 做完（有「量不了」「没听成」、试合成没成（暂时出错试满次数、文字被拒、合成那头做完了没取回，文字输出分开说）或作废的几条，包照样做出来了，报告里写明）；1 出错停下来（错误码在标准错误）；2 用法错误。
//
// 抛出的错误（VoicePackError；code 小写下划线，details 里放什么在抛出处写明）：
//   make_pack_input_unreadable   素材读不了：目录或 JSON 不存在、音频或 .json 或 .txt 读不了。details.file
//   make_pack_input_invalid      素材或文件不是约定的形状。details: { field, problem }（库抛的同一个 code，同一种写法）；--recording 或 --audition 的目录里没有音频文件、
//                                一段说话都没有切出来（没有素材可做）也是这个 code，field 是 --recording 或 --audition
//   make_pack_base_version_missing  没给 --base-version，这份基础部分又没有封印，不知道版本。
//   make_pack_previous_unreadable   --previous 的目录读不了或有问题（符号链接、特殊文件、超过上限）。details: { file, problems? }
//   file_exists                  --output、--save-evaluation 或 --share-file 的路径已经存在（在花钱之前就报）。
//   duplicate_detected           查重不通过（给了 --source-pack）：新包里有文字或录音和来源包重合太多。details.findings 是每一处的 { kind, item, measure, value, threshold }，没有来源包的任何标识（lib/duplicate-check.mjs）
//   duplicate_check_source_invalid  --source-pack 读不了（路径不存在、打不开，来自 cli/source-pack.mjs），或者读到了但不是角色部分（lib/duplicate-check.mjs）
//   另外 make_pack_*（正本在 lib/make-pack.mjs 的文件头，各自抛在各步的 lib/make-pack-*.mjs 和 lib/pack-version.mjs 里）、pack_invalid（protocol/lib/pack.mjs），adapter_invalid、adapter_not_found 来自 cli/adapters.mjs（适配器自己抛的错原样往上），file_unreadable 来自各自的模块，fidelity_* 来自 lib/fidelity.mjs，
//   card_link_invalid（--share-file 时适配器给的链接不对）和 file_unwritable 来自 protocol/lib/share.mjs、protocol/cli/disk.mjs。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VoicePackError, isVoicePackError } from '../../protocol/lib/errors.mjs';
import { partName, parseManifest, MANIFEST_FILE } from '../../protocol/lib/manifest.mjs';
import { TEXT_LANGUAGES } from '../../protocol/lib/skill-md.mjs';
import { readDirectory, writeDirectory, writeNewFile } from '../../protocol/cli/disk.mjs';
import { sha256Hex } from '../../protocol/lib/hash.mjs';
import { buildShareFile } from '../../protocol/lib/share.mjs';
import { makePack } from '../../lib/make-pack.mjs';
import { carriesDesignSource } from '../../lib/pack-version.mjs';
import { precheckInput } from '../../lib/make-pack-precheck.mjs';
import { hasWords } from '../../lib/make-pack-transcribe.mjs';
import { CARD_LINE_REASON_WORDS } from '../../lib/material-hints.mjs';
import { languagePair } from '../../lib/cross-language.mjs';
import { MAX_ATTEMPTS, RETRY_DELAYS_MS } from '../../lib/call-attempts.mjs';
import { POINT_CHUNKS_MAX } from '../../lib/point-measure.mjs';
import { prepareLongRecording } from '../../lib/long-recording.mjs';
import { hasCapability } from '../../protocol/lib/env.mjs';
import { seededRandom, UNMEASURABLE_LABEL } from '../../lib/fidelity.mjs';
import { LEXICON_FILE } from '../../lib/pronunciation-lexicon.mjs';
import { checkDuplicates, materialOfInput, materialOfPack } from '../../lib/duplicate-check.mjs';
import { assertFresh, isPlainObject, parseArgs, readBytes, readText, usageProblem } from '../input.mjs';
import { readMediaFile, isMediaFileName } from '../audio-files.mjs';
import { describeDuplicateCheck, readSourcePack } from '../source-pack.mjs';
import { ADAPTER_USAGE, applyAdapters, billingSentence, describeRequests, environmentName, maxCharsOf, maxPauseInRequestMsOf, minCharsOf, previewCardOf, takeAdapterArguments } from '../adapters.mjs';
import { EVALUATION_FILE, FIDELITY_REPORT_FILE, evaluationSetFiles } from '../evaluation-set.mjs';
import { fixed2, renderFidelityReport } from '../fidelity-report.mjs';

export const summary = '做包：读一批切好的录音，挑参考集和留出录音、给参考定音色基底标签和标提示标注、试合成、量还原度、提示还缺什么素材；也能给已有的包发新版本';
export const usage = `make-pack [<素材目录|素材.json>] [--recording <文件|目录>] [--audition <文件|目录>] [--no-separate] --output <新目录> --name <名字> [--short-name <英文短名>] [--base-version <x.y.z>]
      [--language <标签>] [--text-language <zh|en>] [--guidance <文件.md>] [--direction <文件.json>] [--design-source <文件.json>] [--lexicon <文件.pls>] [--sample-lines <文件.json>] [--card-line <文件.txt> [--allow-cross-language] [--card-line-expressiveness <0 到 100>]] [--expressiveness <0 到 100|none>] [--setups <文件.json>]
      [--previous <包目录> [--version <x.y.z> | --bump patch|minor|major] [--changelog <说明>] [--drop <段名,段名>] [--retag <段名>=<标签>]...] [--default-segment <段名>]...
      [--source-pack <来源包的目录或分享文件>] [--protocol <协议核心目录>] [--base <基础部分目录>] [--environment <名字>]
      ${ADAPTER_USAGE}
      [--dry-run] [--no-evaluate] [--no-loudness] [--no-limiter] [--no-holdout] [--seed <整数>] [--max-error-rate <数>] [--concurrency <1-8>] [--save-evaluation <新目录>] [--share-file <分享文件>] [--json]`;

/** --help 里接在用法后面的几行：用法里看不出来的要紧的事。每个选项的全文在本文件的文件头，做包的细则在 references/make-pack.md。 */
export const help = `要紧的几条（每个选项的全文在 cli/commands/make-pack.mjs 的文件头，素材的格式、标签、报告怎么读在 references/make-pack.md）：
  --default-segment <段名>  明说默认段。包里每种语言各有一段默认段：几种语言的包可以给几次，每次点名一段，那一段就是它自己那种语言的默认段；
                           一种语言只能点名一段。没点名的语言照规则挑，发新版本时沿用上一版的。
  --card-line <文件.txt>    卡片试听那一句（录音做的、设计做的声音都交）：包做好以后用这个包自己的声音配。发新版本不给，上一版有就原样沿用。
  --card-line-expressiveness <0 到 100>   只有这一次配的卡片那一句用这个起伏，其余照默认那套。要和 --card-line 一起给。
  --expressiveness <0 到 100|none>        这个声音的起伏（全局值）。发新版本不给就沿用上一版的，none 是去掉。
  --recording、--audition   长录音、默认音色或融合出来的试听直接交，命令自己切段；分离、VAD 是花钱的调用，调之前先查输入、再说明。
                           设计出来的试听只当原料，不用 --audition（references/make-pack.md「设计出来的声音怎么做包」）。
  --previous <包目录>       发新版本：上一版的参考和留出录音原样带过来，--drop 去掉、--retag 改标签。
  --dry-run                只做不花钱的几步，说明各项能力最多调几次，不做包。真做之前先跑一遍。`;

/** --expressiveness、--card-line-expressiveness 的值：none 是去掉（null），不是数的变成 NaN，由 lib 报 make_pack_input_invalid（花钱之前，--dry-run 也报）。 */
const expressivenessOption = (value) => (value.trim() === 'none' ? null : value.trim() === '' ? Number.NaN : Number(value));

/** 命令认的选项（传给 parseArgs 的那份；--json 由 runner 取走，适配器的参数由 takeAdapterArguments 取走，都不在表里）。用法里要都写出来，约定见 cli/input.mjs 文件头。 */
export const FLAGS = {
  output: 'string', name: 'string', 'short-name': 'string', 'base-version': 'string', language: 'string', 'text-language': 'string',
  guidance: 'string', direction: 'string', 'design-source': 'string', lexicon: 'string', 'sample-lines': 'string', 'card-line': 'string', 'card-line-expressiveness': 'string', expressiveness: 'string', 'allow-cross-language': 'boolean', setups: 'string',
  previous: 'string', version: 'string', bump: 'string', changelog: 'string', drop: 'string', retag: 'strings', 'default-segment': 'strings',
  recording: 'string', audition: 'string', 'no-separate': 'boolean', 'source-pack': 'string',
  protocol: 'string', base: 'string', environment: 'string',
  'dry-run': 'boolean', 'no-evaluate': 'boolean', 'no-loudness': 'boolean', 'no-limiter': 'boolean', 'no-holdout': 'boolean', seed: 'number', 'max-error-rate': 'number', concurrency: 'number', 'save-evaluation': 'string', 'share-file': 'string',
};
const SKILL_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const invalid = (field, problem, more = {}) => new VoicePackError('make_pack_input_invalid', `做包的输入不合约定（${field}）：${problem}`, { details: { field, problem, ...more } });
const unreadable = (file, cause) => new VoicePackError('make_pack_input_unreadable', `读不了素材：${file}`, { details: { file }, ...(cause === undefined ? {} : { cause }) });

// ---------------------------------------------------------------- 读素材

function readJson(ctx, file, field) {
  const text = readText(ctx, file);
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new VoicePackError('make_pack_input_invalid', `${file} 不是合法的 JSON（${cause.message}）`, { details: { field, problem: `不是合法的 JSON：${cause.message}` }, cause });
  }
}

/** 文件名换成合格的段名（小写字母、数字、连字符、下划线，最长 64 个字符）；换不出来给 undefined，让库按次序起名。 */
function slugOf(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 64);
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug) ? slug : undefined;
}

/** 目录：每个音频文件一段；同名的 .json 或 .txt 是它的描述。 */
function readDirectorySegments(ctx, directory) {
  const names = fs.readdirSync(directory).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // 不同系统 readdir 的顺序不一样，按名字排：输入次序是挑素材时最后的决胜
  return names.filter(isMediaFileName).map((name) => {
    const stem = path.basename(name, path.extname(name));
    const audio = readMediaFile(ctx, path.join(directory, name));
    const sidecar = path.join(directory, `${stem}.json`);
    const transcript = path.join(directory, `${stem}.txt`);
    let meta = {};
    if (fs.existsSync(sidecar)) {
      meta = readJson(ctx, sidecar, name);
      if (!isPlainObject(meta)) throw invalid(name, `${sidecar} 必须是一个对象：{ id?, text?, annotatedText?, language?, tag?, source?, externalUrl?, synthetic?, sentence?, trim? }`);
    }
    if (meta.text === undefined && fs.existsSync(transcript)) meta = { ...meta, text: readText(ctx, transcript) };
    return { ...(meta.id === undefined ? (slugOf(stem) === undefined ? {} : { id: slugOf(stem) }) : {}), ...meta, audio };
  });
}

/**
 * 素材.json：segments 数组，每项的 audio 是路径（相对这个 JSON 所在的目录）。几段指同一个文件（各写各的 trim）的，文件只读一次，几段共用同一份字节：
 * 一集动画几百兆，切成几段不该读几遍、占几份内存；makePack 也按这个认出是同一个文件，只解一次码（lib/make-pack-take-audio.mjs）。
 */
function readListSegments(ctx, file) {
  const data = readJson(ctx, file, 'segments');
  const list = Array.isArray(data) ? data : data?.segments;
  if (!Array.isArray(list)) throw invalid('segments', `${file} 要是 { "segments": [ … ] } 或者一个数组`);
  const root = path.dirname(file);
  const read = new Map(); // 绝对路径 -> 读成的 { bytes, mimeType }
  const segments = list.map((raw, index) => {
    const field = `segments[${index}]`;
    if (!isPlainObject(raw)) throw invalid(field, '必须是对象 { id?, audio, text?, annotatedText?, language?, tag?, source?, externalUrl?, synthetic?, sentence?, trim? }');
    if (typeof raw.audio !== 'string' || raw.audio === '') throw invalid(`${field}.audio`, '必须是音频文件的路径（相对素材.json 所在的目录）');
    const audioFile = path.resolve(root, raw.audio);
    if (!read.has(audioFile)) read.set(audioFile, readMediaFile(ctx, audioFile));
    return { ...raw, audio: read.get(audioFile) };
  });
  return { segments, notes: Array.isArray(data) ? undefined : data.notes };
}

function loadMaterial(ctx, argument) {
  const resolved = path.resolve(ctx.cwd, argument);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (cause) {
    throw unreadable(resolved, cause);
  }
  return stat.isDirectory() ? { segments: readDirectorySegments(ctx, resolved) } : readListSegments(ctx, resolved);
}

/**
 * --retag 给的几次（每次 <段名>=<标签>，按第一个 = 拆，段名去掉两头空白；标签原样交给库，库去掉两头空白、查长短）整理成库的 retag：{ 段名: 标签 }。
 * 同一段给了两次，库的对象里放不下：在这里报，和库报别的改名问题同一个错。
 * @throws {VoicePackError} make_pack_input_invalid（field 是 retag，details.segment 是给了两次的那一段）
 */
function retagOf(values) {
  const retag = new Map();
  for (const value of values) {
    const at = value.indexOf('=');
    const id = value.slice(0, at).trim();
    if (retag.has(id)) throw invalid('retag', `${JSON.stringify(id)} 给了两次：一段只能改一个名字`, { segment: id });
    retag.set(id, value.slice(at + 1));
  }
  return Object.fromEntries(retag); // 段名都成了自己的键（连 __proto__ 这样的写法也是），库再查它是不是上一版的参考
}

// ---------------------------------------------------------------- 长录音和试听

/** --recording、--audition 的参数：一个音频文件，或者一个目录（里面每个音频文件是一段，按文件名排）。读成字节。 */
function loadRecordings(ctx, argument, kind) {
  const resolved = path.resolve(ctx.cwd, argument);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (cause) {
    throw unreadable(resolved, cause);
  }
  const files = stat.isDirectory()
    ? fs.readdirSync(resolved).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).filter(isMediaFileName).map((name) => path.join(resolved, name))
    : [resolved];
  if (files.length === 0) throw invalid(`--${kind}`, `${resolved} 里没有音频文件`);
  return files.map((file) => ({ kind, name: path.basename(file), audio: readMediaFile(ctx, file) }));
}

/**
 * 给每段录音起段名的前缀（切出来的段名是「前缀-001」……，lib/long-recording.mjs）：文件名转成合格的写法，转不出来用 rec（长录音）或 audition（试听）。
 * 前缀用过了就加 -2、-3，加到没用过为止。用过的：这一次前面几段录音的前缀；taken（这次素材里的段名、上一版的段名，去掉的也算）里有「前缀-数字」这样的段名的；
 * unnamed 为真（素材里有没写名字的段，库按次序起 seg-001……）时的 seg。所以切出来的段名不会和这些撞（规则写在本文件头「素材」的 --recording）。
 */
function assignPrefixes(recordings, { taken = [], unnamed = false } = {}) {
  const used = new Set(unnamed ? ['seg'] : []);
  for (const id of taken) {
    const numbered = /^(.+)-[0-9]+$/.exec(id); // 段名 x-001 占住前缀 x（x 里可以有连字符：talk-2-001 占住的是 talk-2）
    if (numbered !== null) used.add(numbered[1]);
  }
  return recordings.map((recording) => {
    const base = (slugOf(path.basename(recording.name, path.extname(recording.name))) ?? (recording.kind === 'audition' ? 'audition' : 'rec')).slice(0, 50);
    let idPrefix = base;
    for (let n = 2; used.has(idPrefix); n++) idPrefix = `${base}-${n}`;
    used.add(idPrefix);
    return { ...recording, idPrefix };
  });
}

/** 切段之前的说明（只给人看，写到标准错误）：分离和 VAD 是花钱、耗时的调用，每段录音各一次，不重试。没有要调的就是 null。 */
function cutCostNote({ env, recordings, separate }) {
  const lines = [];
  const separating = separate ? recordings.filter((recording) => recording.kind === 'recording').length : 0;
  if (separating > 0 && hasCapability(env, 'audio-source-separation')) lines.push(`  分离：${separating} 次（audio-source-separation，每段长录音一次）`);
  if (hasCapability(env, 'voice-activity-detection')) lines.push(`  切段：${recordings.length} 次（voice-activity-detection，每段录音一次）`);
  return lines.length === 0 ? null : `切段之前要调这几项能力（花钱、耗时，出错不重试）：\n${lines.join('\n')}\n`;
}

/**
 * 每段录音（分离）切成片段。转写不在这里做（makePack 做，一段一次，费用在做包的规划里）。
 * dry-run 不调分离和 VAD：环境里的能力都不给，按能量切，只为报段数。一段录音出错就停（花钱的调用不重试）。
 * @returns {Promise<{ recording: object, segments: object[], notes: object[], report: object }[]>}
 */
async function cutRecordings(env, recordings, { separate, dryRun }) {
  const cutEnv = dryRun ? { ...env, capabilities: {} } : env;
  const cut = [];
  for (const recording of recordings) {
    // 长录音（--recording）切成句子，之后在做包里先并成段、再一段转写一次（lib/make-pack-sentences.mjs）；试听照旧切成段
    const prepared = await prepareLongRecording(cutEnv, { audio: recording.audio, name: recording.name }, { transcribe: false, separate: separate && recording.kind === 'recording', sentences: recording.kind === 'recording', idPrefix: recording.idPrefix });
    cut.push({ recording, ...prepared });
  }
  return cut;
}

/** 切段留下的说明，加上命令自己的：几段录音放在一起，说明前面带上录音名；转写不是这里的事，没转写的说明不要。 */
function cutNotes(cut, { dryRun, designSourceGiven }) {
  const several = cut.length > 1;
  const notes = [];
  for (const entry of cut) {
    for (const note of entry.notes) {
      if (note.code === 'transcription_skipped') continue; // 转写是做包那一步做的
      if (dryRun && note.code === 'separation_skipped') continue; // dry-run 没调分离，说「环境没有」不对
      notes.push(several ? { ...note, message: `${entry.recording.name}：${note.message}` } : note);
    }
  }
  if (dryRun && cut.length > 0) notes.push({ code: 'dry_run_energy_cut', message: 'dry-run 没调分离和 VAD，切出来的数是按能量切的结果；真做时环境有 VAD 就用它切，数可能不同', details: {} });
  if (!designSourceGiven && cut.some((entry) => entry.recording.kind === 'audition')) {
    notes.push({ code: 'design_source_missing', message: '这是默认音色、融合出来的试听，做包时要写设计来源（--design-source <文件.json>：描述、模型、日期）；这次没给，包里没有设计来源', details: {} });
  }
  return notes;
}

/** 给人看的一行：这段录音怎么切的。 */
function describeCut({ recording, report }) {
  const separation = report.separation.status === 'done' ? `分离做了${report.separation.model === undefined ? '' : `（${report.separation.model}）`}` : '没分离';
  const method = report.cutting.method === 'voice-activity-detection' ? `按 VAD${report.cutting.model === undefined ? '' : `（${report.cutting.model}）`}` : '按能量';
  const dropped = report.cutting.dropped.length > 0 ? `，丢掉 ${report.cutting.dropped.length} 块零头` : '';
  const unit = recording.kind === 'recording' ? '句' : '段'; // 长录音切成句子（见 cutRecordings）
  return `${recording.kind === 'audition' ? '试听' : '长录音'} ${recording.name}：${report.recording.durationSec} 秒，${separation}，${method}切成 ${report.cutting.segments} ${unit}${dropped}`;
}

/** 长录音的句子先并成段（报告的 steps.sentences，lib/make-pack-sentences.mjs），给人看的一行：几句并成几段。没有句子就不写。 */
const describeSentences = (step) => (step === undefined ? [] : [`句子并段：长录音的 ${step.sentences} 句并成 ${step.segments} 段，每段转写一次（句子不逐句转写）`]);

/** 上一版的清单（只为看设计来源沿用不沿用）；读不懂是 null：上一版有问题由 makePack 报（make_pack_previous_invalid）。 */
function manifestOrNull(files) {
  try {
    return parseManifest(files.get(MANIFEST_FILE));
  } catch {
    return null;
  }
}

/** 读一个目录（上一版、协议核心、基础部分）成文件集。有问题（符号链接、特殊文件、超过上限）就不用。 */
function loadFiles(directory, what) {
  const { files, problems } = readDirectory(directory);
  if (problems.length > 0) {
    throw new VoicePackError('make_pack_previous_unreadable', `${what} ${directory} 里有问题，不能用：${problems[0].message}${problems.length > 1 ? `（共 ${problems.length} 处）` : ''}`, { details: { file: directory, problems } });
  }
  return files;
}

/** 这份基础部分自己的版本：它的 manifest.json（封印过的才有）。 */
function ownBaseVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, 'manifest.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 分享文件

/**
 * 把做好的包打成分享文件写到 file（已存在就拒绝，file_exists）。预览卡片的产品名和入口用 previewCard（适配器给的，没有就是 undefined：卡片上没有）。
 * 不验签、不做互相校验：和 app 导出一样，只是把刚做好、库自检过的包打成分享文件。
 * @throws {VoicePackError} card_link_invalid（适配器给的链接不是 http、https 的地址）、file_exists、file_unwritable，以及 buildShareFile 的别的错
 */
async function writeShare(file, packFiles, previewCard) {
  const bytes = buildShareFile(packFiles, previewCard === undefined ? {} : { card: previewCard });
  writeNewFile(file, bytes);
  const card = previewCard === undefined ? null : { productName: previewCard.productName ?? null, open: previewCard.links?.open ?? null, make: previewCard.links?.make ?? null };
  return { file, bytes: bytes.length, sha256: await sha256Hex(bytes), card };
}

// ---------------------------------------------------------------- 给人看的报告

const CALL_NOTE = { 'automatic-speech-recognition': '转写', 'audio-text-to-text': '挑默认段、标提示标注和盲听', 'voice-cloning': '试合成', 'speaker-verification': '说话人相似度' };

/**
 * voice-cloning 那一项合成的是什么：试合成留出录音（plan 里合成的次数减去卡片那一句），和配卡片试听那一句（给了 --card-line、环境有 voice-cloning，lib/make-pack-plan.mjs），
 * 哪样有写哪样（没有留出录音、--no-evaluate 时只有卡片那一句，不说成试合成）。{ work: 各项次数那一行和重试那一行开头的说法, each: 重试那一行说的「每……」 }
 */
function cloningNote(plan, cardLine) {
  const card = cardLine && plan.capabilities['voice-cloning'] ? 1 : 0;
  const trial = plan.calls['voice-cloning'] - card > 0;
  if (card === 0) return { work: CALL_NOTE['voice-cloning'], each: '每条留出录音' };
  return trial ? { work: '试合成和配卡片试听那一句', each: '每条留出录音和卡片试听那一句' } : { work: '配卡片试听那一句', each: '这一句' };
}
/** 各项次数那一行开头的说法：voice-cloning 照 cloningNote，别的照 CALL_NOTE。 */
const callNote = (capability, plan, cardLine) => (capability === 'voice-cloning' ? cloningNote(plan, cardLine).work : CALL_NOTE[capability]);

/**
 * 没给 --language，又有要转写的片段：转写不报语言时（automatic-speech-recognition 返回里的 language 可以没有），拉丁字母的文字（英文、法文……）认不出是哪种语言，
 * 这些段付完转写费才发现用不上（language_unknown）；中文、日文这类非拉丁字母的文字从文字本身就认得出，不受影响。只是提醒，不挡运行。
 * 规则的正本是 lib/make-pack-tags.mjs 的文件头「语言」和 references/make-pack.md 的「标签」；没有要提醒的返回 null。
 * 数的是「没有文本、也没有自己的 language」的片段，和规划里要转写的段数取小的那个（环境没有转写时，规划里要转写的段数是 0，所以不会提醒）。
 */
function languageNote({ plan, segments, language }) {
  if (language !== undefined) return null;
  const unlabelled = segments.filter((segment) => (segment.text === undefined || segment.text === '') && !segment.language).length;
  const count = Math.min(plan.calls['automatic-speech-recognition'], unlabelled);
  if (count === 0) return null;
  return `没给 --language，${count} 段要先转写再判断语言：转写不报语言时，拉丁字母的文字（英文、法文……）认不出是哪种语言，付完转写费这些段会全部因为 language_unknown 用不上（中文、日文这类非拉丁字母的文字不受影响）。建议加 --language <标签>，例如 en（references/make-pack.md 的「标签」）`;
}

/**
 * 有重试规则的几项能力（转写；挑默认段、标提示标注；试合成和卡片试听那一句。规则在 lib/call-attempts.mjs，数目在 plan.extraCalls），各自的说法：做的是什么（work）、再来叫什么（again）、
 * 每什么再来（each）、上限怎么说（limit）。audio-text-to-text 那一项的总数是「挑默认段、标提示标注和盲听」（和各项最多调几次那一行同一个口径），盲听出错不重试，所以不在多出来的次数里，写明。
 * voice-cloning 那一项的 work、each 照 cloningNote（合成的是试合成、卡片那一句，还是两样都有）。
 */
/** 规划里转写的上限，有多少是标提示标注时量停顿和快慢的（lib/make-pack-plan.mjs 算在 extraCalls 里）：不管有没有出错都要转写，不是重试，所以单写一行。 */
const measureCalls = (plan) => Math.max(0, (plan.extraCalls?.['automatic-speech-recognition'] ?? 0) - (MAX_ATTEMPTS - 1) * plan.calls['automatic-speech-recognition']);

const RETRY_NOTE = {
  'automatic-speech-recognition': { work: '转写', again: '转写', limit: (extra, total, plan) => `这一次最多再加 ${extra} 次，${measureCalls(plan) > 0 ? '补文本的转写' : ''}实际调用不超过 ${total} 次` },
  'audio-text-to-text': { work: '挑默认段、标提示标注', again: '听', each: '每次', limit: (extra, total) => `这一次最多再加 ${extra} 次（盲听出错不重试），挑默认段、标提示标注和盲听实际调用不超过 ${total} 次` },
  'voice-cloning': { again: '合成', limit: (extra, total) => `这一次最多再加 ${extra} 次，实际调用不超过 ${total} 次` },
};

/**
 * 暂时出错会再来的上限：转写、挑默认段和标提示标注、合成（试合成、卡片那一句）各另起一行写明，写进费用说明和规划里。
 * 没有要转写、要听、要合成的，或者环境没有那项能力，那一项就没有这一行。cardLine 是给了 --card-line。
 */
function retryNotes(plan, cardLine) {
  const waits = RETRY_DELAYS_MS.map((ms) => `${ms / 1000} 秒`).join('、');
  return Object.entries(RETRY_NOTE).flatMap(([capability, note]) => {
    const extra = (plan.extraCalls?.[capability] ?? 0) - (capability === 'automatic-speech-recognition' ? measureCalls(plan) : 0);
    const measuring = capability === 'automatic-speech-recognition' && measureCalls(plan) > 0
      ? [`标提示标注还要量停顿和快慢：不管有没有出错，每段参考都要切成块逐块转写，每段最多 ${POINT_CHUNKS_MAX} 块，每块最多试 ${MAX_ATTEMPTS} 次，这一次最多 ${measureCalls(plan)} 次，转写实际调用一共不超过 ${plan.calls[capability] + (plan.extraCalls?.[capability] ?? 0)} 次`]
      : [];
    if (extra === 0) return measuring;
    const { work, each } = capability === 'voice-cloning' ? cloningNote(plan, cardLine) : note;
    return [`${work}碰到服务暂时出错，${each ?? '每段'}最多再${note.again} ${MAX_ATTEMPTS - 1} 次（两次之前各等 ${waits}），${note.limit(extra, plan.calls[capability] + extra, plan)}`, ...measuring];
  });
}

/**
 * 试合成和卡片试听那一句都有：合成的次数里有配卡片试听那一句的一次（lib/make-pack-plan.mjs）。写在各项次数的后面；只有一样（cloningNote 已经说清楚了）就是 null。
 */
const cardLineNote = (plan, cardLine) => (cloningNote(plan, cardLine).work === '试合成和配卡片试听那一句' ? '其中 1 次是配卡片试听那一句（--card-line，包做好以后配）' : null);

/** 花钱的几步开始之前的说明（只给人看，写到标准错误）。language 是 languageNote 的结果，有就写成最后一行之前的一行；cardLine 是给了 --card-line。 */
function costNote({ billing, plan, saveEvaluation, language, cardLine }) {
  const lines = [`${billing}；下面是各项最多调几次（实际可能更少）：`];
  for (const [capability, count] of Object.entries(plan.calls)) {
    lines.push(plan.capabilities[capability] ? `  ${callNote(capability, plan, cardLine)}：${count} 次（${capability}）` : `  ${callNote(capability, plan, cardLine)}：这个环境没有 ${capability}，这一步${capability === 'automatic-speech-recognition' ? '跳过，没有文本的片段用不上' : `报「${UNMEASURABLE_LABEL}」或跳过`}`);
  }
  const card = cardLineNote(plan, cardLine);
  if (card !== null) lines.push(`  ${card}`);
  for (const retry of retryNotes(plan, cardLine)) lines.push(`  ${retry}`);
  if (language !== null) lines.push(`  语言：${language}`);
  lines.push(`  转写、挑默认段、标提示标注和合成以外，碰到服务出错的那一项会记成「没听成」，不自动重试${saveEvaluation ? '' : '；之后想补做，这次要加 --save-evaluation <新目录> 存下评测集'}`);
  return `${lines.join('\n')}\n`;
}

const UNUSED_NOTE = {
  no_text: '没有逐字文本',
  duplicate_audio: '和别的一段是同一段音频',
  audio_unrecognized: '认不出是什么音频',
  audio_undecodable: '解不开',
  language_unknown: '认不出是哪种语言',
  transcription_failed: '转写暂时出错',
  transcription_blocked: '转写被服务商拦下了（内容过滤）',
  over_limit: '参考太多，超过了上限',
  trim_out_of_range: '起点超出了录音',
};
function unusedNote(segment) {
  const tried = (segment.reason === 'transcription_failed' || segment.reason === 'transcription_blocked') && Number.isInteger(segment.details?.attempts) ? `，试了 ${segment.details.attempts} 次` : '';
  const base = `${UNUSED_NOTE[segment.reason] ?? segment.reason}${tried}`;
  const codes = segment.details?.codes?.length > 0 ? `：${segment.details.codes.join('、')}` : '';
  const same = segment.details?.sameAs === undefined ? '' : `：同 ${segment.details.sameAs}`;
  const said = typeof segment.details?.message === 'string' ? `：${segment.details.message}` : ''; // 解不开的：解码程序说的话，全文
  const range = segment.reason === 'trim_out_of_range' ? `：起点 ${segment.details.startSec} 秒，录音只有 ${segment.details.durationSec} 秒` : '';
  const runtime = segment.details?.runtime === undefined ? '' : `：环境没有 ${segment.details.runtime}，取不出音轨`; // 带视频轨的文件、别的格式（lib/make-pack-take-audio.mjs）
  return `${base}（${segment.reason}${codes}${same}）${said}${range}${runtime}`;
}

/** 试合成的一句被作废的原因，给人看（lib/make-pack-trial.mjs 的 checkSynthesized 给的 codes）。 */
const VOIDED_WHY = {
  synthesized_mostly_silent: '几乎全是静音',
  synthesized_too_long: '合成的时长比同一句的留出录音长得多',
  synthesized_too_short: '合成的时长比同一句的留出录音短得多',
};

/** 试合成的一句没查到的原因，给人看（checkSynthesized 给的 reason）：没查到照旧量，报告写明原因。 */
const UNCHECKED_WHY = {
  runtime_missing: (check) => `环境缺运行时 ${check.runtime}，解不开合成出来的录音`,
  undecodable: () => '合成出来的录音不是能认的音频格式，解不开',
};

/** 作废的一句：为什么（几条原因都写上），量到的静音占比和时长，同一句的留出录音时长（有的话）。 */
function describeVoided(check) {
  const why = check.codes.map((code) => VOIDED_WHY[code]).join('；');
  const silence = check.silenceRatio === null ? '不足一个窗口，量不出静音占比' : `静音占比 ${check.silenceRatio}`;
  const holdout = check.holdoutSec === undefined ? '' : `，同一句的留出录音 ${check.holdoutSec} 秒`;
  return `${why}（${silence}，时长 ${check.durationSec} 秒${holdout}）`;
}

/** 一段参考没标上提示标注的原因，给人看（lib/make-pack-annotation.mjs 的 notAnnotated 和每段的 annotation）。 */
const NOT_ANNOTATED_WHY = {
  listening_check_failed: '开头和逐字稿对不上（收音校验没过）',
  annotation_answer_invalid: '回答读不懂',
  annotation_answer_unusable: '回答没正常结束或是空的',
  provider_blocked: '被模型的服务商拦下了回答',
  cues_unmatched: '提示一条都对不上原文',
  not_heard: `服务暂时出错，试满重试次数也没成（一段听 3 次，每次最多试 ${MAX_ATTEMPTS} 次）`,
  capability_missing: '环境没有 audio-text-to-text',
};

/** 标提示标注那一步，给人看（steps.annotation，写法见 lib/make-pack-annotation.mjs）：标上了几段、丢了几条提示、哪几段没标上和为什么。 */
function describeAnnotation(step) {
  if (step === undefined) return [];
  const given = step.given > 0 ? `${step.given} 段用素材给的提示标注` : '';
  if (step.status === 'not_needed') return given === '' ? [] : [`标提示标注：${given}，没调模型`];
  const missed = step.notAnnotated.length > 0 ? `${step.notAnnotated.length} 段没标上，只存逐字稿：${step.notAnnotated.map((entry) => `${entry.id}（${NOT_ANNOTATED_WHY[entry.reason] ?? entry.reason}）`).join('、')}` : '';
  if (step.status === 'skipped') return [`标提示标注：没做，环境没有 ${step.capability}，${[given, missed].filter((part) => part !== '').join('；')}`];
  const parts = [
    `${step.annotated} 段标上了${step.retried > 0 ? `（暂时出错，自动多听了 ${step.retried} 次）` : ''}`,
    step.droppedCues > 0 ? `丢掉了 ${step.droppedCues} 条对不上原文的提示` : '',
    step.withoutCues > 0 ? `${step.withoutCues} 段听下来说法没有变化，不加提示` : '',
    given,
    missed,
    step.notMeasured > 0 ? `${step.notMeasured} 段没量出停顿和快慢，只用听的结果（原因在报告每段的 annotation.measureReason）` : '',
  ];
  return [`标提示标注：${parts.filter((part) => part !== '').join('；')}`];
}

/** 一段参考的提示标注，给人看的那一小截（报告每段的 annotation）；没有就是空串。 */
function annotationNote(annotation) {
  if (annotation === undefined) return '';
  if (annotation.status === 'annotated') return ` 提示标注：${annotation.cues} 条提示${annotation.droppedCues === undefined ? '' : `（丢了 ${annotation.droppedCues} 条）`}`;
  if (annotation.status === 'given') return ' 提示标注：素材给的';
  if (annotation.status === 'no_cues') return ' 提示标注：没有提示（说法没有变化）';
  const why = annotation.status === 'not_heard' ? 'not_heard' : annotation.reason; // 作废的原因，或者 capability_missing
  return ` 提示标注：没标上（${NOT_ANNOTATED_WHY[why] ?? why}）`;
}

function describeSteps(steps) {
  const lines = [];
  const transcription = steps.transcription;
  if (transcription?.status === 'skipped') lines.push(`转写：没做，环境没有 ${transcription.capability}，${transcription.segments} 段没有文本的片段用不上`);
  else if (transcription?.status === 'done') lines.push(`转写：${transcription.transcribed} 段补上了文本${transcription.retried > 0 ? `（${transcription.blocked > 0 ? '暂时出错或被拦下' : '暂时出错'}，自动多转写了 ${transcription.retried} 次）` : ''}${transcription.failed > 0 ? `；${transcription.failed} 段服务暂时出错，试满 ${MAX_ATTEMPTS} 次也没转成（用不上）` : ''}${transcription.blocked > 0 ? `；${transcription.blocked} 段被服务商拦下（内容过滤，用不上）` : ''}`);
  lines.push(...describeAnnotation(steps.annotation));
  const loudness = steps.loudness;
  if (loudness?.status === 'skipped') lines.push('调响度：没做（--no-loudness），音频原样放进包里');
  else if (loudness?.status === 'done') {
    const changed = loudness.adjusted + loudness.peakLimited;
    const limiterOn = loudness.limiter !== null && loudness.limiter !== undefined;
    const rest = [
      loudness.limiterUsed > 0 ? `${loudness.limiterUsed} 段用限幅压住了过高的峰` : '',
      loudness.peakLimited > 0 ? (limiterOn ? `${loudness.peakLimited} 段限幅压到 ${loudness.limiter.maxDb} dB 还是没到目标` : `${loudness.peakLimited} 段为了峰值不超过 ${loudness.peakCeilingDbfs} dBFS 没到目标`) : '',
      loudness.unchanged > 0 ? `${loudness.unchanged} 段本来就在目标上` : '',
      loudness.skipped > 0 ? `${loudness.skipped} 段没法调，原样放进包里` : '',
      loudness.carried > 0 ? `上一版的 ${loudness.carried} 段不动` : '',
      limiterOn ? '' : '限幅器关了（--no-limiter）',
    ].filter((text) => text !== '');
    lines.push(`调响度：${changed} 段调到了 ${loudness.targetLufs} LUFS（采样峰值不超过 ${loudness.peakCeilingDbfs} dBFS）${rest.length > 0 ? `；${rest.join('；')}` : ''}`);
  }
  const trial = steps.trial;
  if (trial?.status === 'done') {
    // retried 是为暂时出错多合成了几次；failed 是没合成出来的（lib/make-pack-trial.mjs），分三种照实说：暂时出错试满次数的（和转写那一行同样的写法），
    // 文字被拒的（details.textRejected，不重试），合成那头做完了、结果没取回的（details.unretrieved，计过费，不再调）
    const retried = trial.retried > 0 ? `（暂时出错，自动多合成了 ${trial.retried} 次）` : '';
    const idsOf = (entries) => entries.map((entry) => entry.id).join('、');
    const unretrieved = trial.failed.filter((entry) => entry.error?.details?.unretrieved === true);
    const rejected = trial.failed.filter((entry) => entry.error?.details?.unretrieved !== true && entry.error?.details?.textRejected === true);
    const serviceErrors = trial.failed.filter((entry) => !unretrieved.includes(entry) && !rejected.includes(entry));
    const failedParts = [
      ...(serviceErrors.length > 0 ? [`${serviceErrors.length} 条服务暂时出错，试满 ${MAX_ATTEMPTS} 次也没合成出来（${idsOf(serviceErrors)}）`] : []),
      ...(rejected.length > 0 ? [`${rejected.length} 条的文字被拒了（${idsOf(rejected)}），不重试`] : []),
      ...(unretrieved.length > 0 ? [`${unretrieved.length} 条没取回（${idsOf(unretrieved)}）：合成那头已经做完、计过费，只是结果没取回来，没有再调；再做一次包会把它重新合成，再计一次费`] : []),
    ];
    const failed = failedParts.length > 0 ? `；${failedParts.join('；')}，不进评测` : '';
    // 合成出来的每一句量还原度之前先检查：作废的不进比值，逐条写明哪条、为什么、量到的数；没查到的照旧量，写明原因
    const voided = trial.items.filter((item) => item.check?.status === 'voided');
    const unchecked = trial.items.filter((item) => item.check?.status === 'unchecked');
    const voidedText = voided.length > 0 ? `（其中 ${voided.length} 条作废）` : '';
    // 文字不够合成能力的下限的（status 是 skipped）：没合成，不算试了一遍，逐条写明字数和下限（lib/make-pack-trial.mjs）
    const tooShort = trial.items.filter((item) => item.status === 'skipped');
    const tooShortText = tooShort.length > 0 ? `（另 ${tooShort.length} 条比合成能力的下限短，没有合成）` : '';
    lines.push(`试合成：用 ${trial.items.length - tooShort.length} 条留出录音试了一遍，合成出来 ${trial.synthesized} 条${voidedText}${tooShortText}${retried}${failed}`);
    for (const item of tooShort) lines.push(`  没合成：${item.id}，比合成能力的下限短（${item.chars} 个字，下限 ${item.min} 个字），不进比值，不算费用`);
    for (const item of voided) lines.push(`  作废：${item.id}，${describeVoided(item.check)}，不进比值`);
    const byWhy = new Map();
    for (const item of unchecked) {
      const why = UNCHECKED_WHY[item.check.reason](item.check);
      byWhy.set(why, [...(byWhy.get(why) ?? []), item.id]);
    }
    for (const [why, ids] of byWhy) lines.push(`  没查到：${ids.join('、')}，${why}，照旧量，进比值`);
  }
  else if (trial?.status === 'skipped') {
    const why = { evaluate_false: '这次没让试（--no-evaluate）', no_holdout: '没有留出录音', capability_missing: `缺 ${trial.capability}`, runtime_missing: `缺运行时 ${trial.runtime}` }[trial.reason] ?? trial.reason;
    lines.push(`试合成：没做，${why}`);
  }
  return lines;
}

/** 卡片试听那一句，给人看（报告的 cardLine，写法见 lib/make-pack-card-line.mjs 的文件头）；没有这一句就不写。没配成、沿用了但有出入的怎么补，在「还缺什么素材」里。 */
function describeCardLine(cardLine) {
  if (cardLine === undefined || cardLine.status === 'none') return [];
  const quoted = `「${cardLine.text}」`;
  if (cardLine.status === 'voiced') {
    // 适配器换了模型（modelChange）：写明换成了哪个、原来要用哪个、为什么（约定见 adapters/README.md「换了模型」）
    const changed = cardLine.modelChange === undefined ? '' : `；注意：适配器换了模型，这一句是 ${cardLine.model ?? '换上的模型'} 配的，原来要用 ${cardLine.modelChange.from}（${cardLine.modelChange.reason}）`;
    // 用同样的请求重配，换了 seed（seedChange，lib/make-pack-card-line.mjs 的 voiceCardLine「seed」）：同一个 seed、同样的请求配出来是一样的
    const reseeded = cardLine.seedChange === undefined ? '' : `，和上一版那一句的请求一样，换了 seed：上一版是 ${cardLine.seedChange.from}，这一次是 ${cardLine.seed}`;
    return [`卡片试听那一句：配好了，写进了 ${cardLine.audio}（参考 ${cardLine.pick.segmentId}${cardLine.openingCue?.added ? `，开头补了 ${cardLine.openingCue.cue}` : ''}${cardLine.attempts > 1 ? `，暂时出错，合成了 ${cardLine.attempts} 次` : ''}${reseeded}${changed}）：${quoted}`];
  }
  if (cardLine.status === 'carried') {
    // 沿用了，但和现在的配法有出入（reasons，lib/make-pack-card-line.mjs 的 carriedCardLine）：写明哪里对不上，要重配交 --card-line
    const reasons = cardLine.reasons ?? [];
    const off = reasons.length === 0 ? '' : `，和现在的配法有出入（${reasons.map((reason) => CARD_LINE_REASON_WORDS[reason] ?? reason).join('、')}），要重配就交 --card-line（见「还缺什么素材」）`;
    return [`卡片试听那一句：沿用上一版（${cardLine.from}）的${off}：${quoted}`];
  }
  // 参考段不是这一句的语言、没给 --allow-cross-language（lib/make-pack-card-line.mjs 的 voiceCardLine「跨语言」）：不是没配成，是没配；怎么办在「还缺什么素材」
  const cross = cardLine.status === 'failed' && cardLine.error?.code === 'dub_cross_language' ? cardLine.error.details?.units?.[0] : undefined;
  if (cross !== undefined) return [`卡片试听那一句：没配，给它挑的参考段 ${cross.segmentId} 和这一句不是一种语言（${languagePair(cross)}），照这样配会带口音，一次都没调；不问使用者：开头的方括号写要听到的口音，加 --allow-cross-language 发新版本重配；使用者自己要补这种语言的参考的（没有这个角色说这种语言的录音的，默认用这个包跨语言配一段当参考），见「还缺什么素材」；清单里没有它：${quoted}`];
  // 凭据被拒、账户停了（halted，lib/make-pack-card-line.mjs）：不是这一句的问题，要使用者先处理
  if (cardLine.status === 'failed' && cardLine.halted === true) return [`卡片试听那一句：没配成，凭证被拒或账户停了（${cardLine.error.code}：${cardLine.error.message}）：先处理凭证或账户，不要重试，处理好以后再发新版本补上（见「还缺什么素材」）；清单里没有它：${quoted}`];
  // 合成那头做完了、结果没取回（error.details.unretrieved，和 lib/material-hints.mjs 的 card_line_failed 认法一样）：计过费，没有再调；手动取回、重配（再计一次费）见「还缺什么素材」
  if (cardLine.status === 'failed' && cardLine.error?.details?.unretrieved === true) return [`卡片试听那一句：没取回（计过费）：合成那头已经做完，结果没取回来，这一次没有再调（${cardLine.error.code}：${cardLine.error.message}）；怎么取回、要不要重配见「还缺什么素材」；清单里没有它：${quoted}`];
  return [`卡片试听那一句：没配成（${cardLine.error.code}：${cardLine.error.message}），清单里没有它：${quoted}`];
}

function renderVerification(report) {
  const lines = [];
  const record = report.verification;
  if (record === null) lines.push('验证记录：没有（两种评测一项都没量出来，没有东西可记）');
  else lines.push(`验证记录：写进了清单：环境 ${record.environment}，模型 ${record.model}，日期 ${record.date}，${record.fidelity.ratio === undefined ? '没有比值（说话人相似度量不了，只有盲听）' : `比值 ${fixed2(record.fidelity.ratio)}`}`);
  if (report.version?.verification.droppedFromPrevious > 0) lines.push(`  上一版的 ${report.version.verification.droppedFromPrevious} 条验证记录没有带过来：它们量的是上一版的参考集和指引`);
  return lines;
}

function renderSegments(report) {
  const shown = report.segments.slice(0, 40);
  const lines = shown.map((segment) => {
    const role = { reference: '参考', holdout: '留出录音', unused: '没用上', dropped: '去掉了', candidate: '候选' }[segment.role] ?? segment.role;
    // 参考段：语言和音色基底标签（加了序号的写原名）；留出录音：语言。括号里是来源（lib/make-pack-tags.mjs 的文件头）
    const language = segment.language === undefined ? '' : ` ${segment.language}（${segment.languageSource}）`;
    const tag = segment.tag === undefined ? '' : ` 「${segment.tag}」（${segment.tagSource}${segment.renamedFrom === undefined ? '' : `，原名「${segment.renamedFrom}」撞名加了序号`}）`;
    const tags = `${language}${tag}`;
    const why = segment.role === 'unused' ? `：${unusedNote(segment)}` : '';
    // 做包先取的音频（lib/make-pack-take-audio.mjs）：不是包能放的格式、取了音轨的；素材写了起止秒、切了的
    const prepared = [...(segment.convertedFrom === undefined ? [] : [`音轨取自 ${segment.convertedFrom}`]), ...(segment.trim === undefined ? [] : [`切了第 ${segment.trim.startSec} 到 ${segment.trim.endSec} 秒`])];
    const preparedNote = prepared.length === 0 ? '' : `（${prepared.join('，')}）`;
    return `  ${segment.id}  ${role}${segment.previous === undefined ? '' : '（上一版的）'}${preparedNote}${tags}${annotationNote(segment.annotation)}${why}`;
  });
  if (report.segments.length > shown.length) lines.push(`  （还有 ${report.segments.length - shown.length} 段，用 --json 看全部）`);
  return lines;
}

function renderPlan(plan, report, cut, duplicateCheck, language, cardLine) {
  const lines = [...cut.map(describeCut), ...describeSentences(report.steps?.sentences), `素材：输入 ${plan.segments.input} 段${plan.segments.carried === undefined ? '' : `，上一版带来 ${plan.segments.carried} 段`}，能用 ${plan.segments.usable} 段（${plan.segments.withoutText} 段没有文本）`];
  if (duplicateCheck !== null) lines.push(...describeDuplicateCheck(duplicateCheck));
  const unused = Object.entries(plan.segments.unused).map(([reason, count]) => `${UNUSED_NOTE[reason] ?? reason} ${count} 段`);
  if (unused.length > 0) lines.push(`没用上：${unused.join('；')}`);
  lines.push('各项能力最多调几次：');
  for (const [capability, count] of Object.entries(plan.calls)) lines.push(`  ${callNote(capability, plan, cardLine)}：${plan.capabilities[capability] ? `${count} 次` : `这个环境没有 ${capability}`}`);
  const card = cardLineNote(plan, cardLine);
  if (card !== null) lines.push(`  ${card}`);
  for (const retry of retryNotes(plan, cardLine)) lines.push(`  ${retry}`);
  lines.push(`留出录音预计 ${plan.holdouts} 条`);
  if (language !== null) lines.push(`注意：${language}`);
  for (const note of report.notes) lines.push(`注意：${note.message}`);
  lines.push('', '每一段：', ...renderSegments(report));
  return lines;
}

/** 默认段是按哪条规则挑的，写给人看（规则见 lib/pack-material.mjs 的规则 5；报告的 defaultSegment.rule）。 */
const DEFAULT_RULE_NOTE = {
  author: () => '作者明说的',
  previous: () => '沿用上一版的',
  model: (defaultSegment) => `能听音频的模型从 ${defaultSegment.candidates.length} 段候选里挑的：${defaultSegment.why}`,
  typical: () => '和其余参考平均最像的那一段',
  priority: (defaultSegment) => (defaultSegment.unpicked === undefined && defaultSegment.unmeasured === undefined ? '按优先级：这个环境没有能听音频的模型和说话人相似度，或者量不到' : '按优先级'),
  only: () => '只有一段候选',
};

/** 问了能听音频的模型、没挑成的原因，写给人看（报告的 defaultSegment.unpicked，写法见 lib/default-pick.mjs 和 lib/make-pack-pick.mjs）。 */
const UNPICKED_WHY = {
  listening_check_failed: '它写的开头和挑的那段对不上，没有真的听到（收音校验没过）',
  pick_answer_invalid: '回答不是固定格式',
  pick_answer_unusable: '回答没正常结束或是空的',
  provider_blocked: '回答被模型的服务商拦下了',
};
function unpickedNote(unpicked) {
  if (unpicked.status === 'voided') return UNPICKED_WHY[unpicked.reason] ?? unpicked.reason;
  if (unpicked.status === 'not_heard') return `服务暂时出错，试满 ${unpicked.attempts} 次也没成`;
  return unpicked.error.message;
}

/** 别的语言各自的默认段（报告的 languageDefaults），写给人看：「；其他语言的默认段：zh z2（规则）、ja j1（规则）」，只有一种语言就是空的。 */
const languageDefaultsNote = (entries) => (entries === undefined || entries.length === 0 ? '' : `；其他语言的默认段：${entries.map((entry) => `${entry.language} ${entry.id}${describeDefaultRule(entry)}`).join('、')}`);

/** 默认段的规则写给人看；问了模型没挑成的、量相似度出了错退回的，连原因一起写上（报告的 defaultSegment.unpicked、unmeasured）。 */
function describeDefaultRule(defaultSegment) {
  const unpicked = defaultSegment.unpicked === undefined ? '' : `；能听音频的模型没挑成：${unpickedNote(defaultSegment.unpicked)}`;
  const unmeasured = defaultSegment.unmeasured === undefined ? '' : `；说话人相似度没量成：${defaultSegment.unmeasured.error.message}`;
  return `（${DEFAULT_RULE_NOTE[defaultSegment.rule](defaultSegment)}${unpicked}${unmeasured}）`;
}

function render(result, { output, evaluation, share, adapterArguments, cut, duplicateCheck }) {
  const { report, pack } = result;
  const lines = [];
  const { manifest } = pack;
  lines.push(`包：${manifest.name}（${pack.id} ${manifest.version}）${output === null ? '' : `，已写到 ${output}`}`);
  if (report.version !== undefined) {
    lines.push(`版本：上一版 ${report.version.previous} → ${report.version.next}（变更说明${report.version.changelogSource === 'author' ? '是作者写的' : '按变化生成'}）：${manifest.changelog}`);
  }
  lines.push(...cut.map(describeCut), ...describeSentences(report.steps.sentences));
  const { counts } = report;
  lines.push(`素材：输入 ${counts.input} 段${counts.carried === undefined ? '' : `，上一版带来 ${counts.carried} 段，去掉 ${counts.dropped} 段`}；参考 ${counts.references} 段，留出录音 ${counts.holdouts} 条，真录音 ${counts.realRecordings} 段，没用上 ${counts.unused} 段；默认段 ${manifest.reference.defaultSegment}${report.defaultSegment === undefined ? '' : describeDefaultRule(report.defaultSegment)}${languageDefaultsNote(report.languageDefaults)}`);
  if (duplicateCheck !== null) lines.push(...describeDuplicateCheck(duplicateCheck));
  for (const note of report.notes) lines.push(`注意：${note.message}`);
  lines.push(...describeSteps(report.steps));

  const fidelity = report.fidelity;
  lines.push('');
  if (fidelity.status === 'skipped') {
    const why = { no_trial: '试合成没做', no_generated: '一条合成都没出来', generated_voided: '合成出来的录音都作废了（见「试合成」）',no_holdout: '没有留出录音', evaluate_false: '这次没让量（--no-evaluate）' }[fidelity.reason] ?? fidelity.reason;
    lines.push(`还原度：没量（${why}）`);
  } else {
    const redoHint = evaluation === null
      ? '  怎么补做：这次没有存评测集，补做不了；要补做，做包时加 --save-evaluation <新目录>（会重新花钱），之后用 fidelity 命令的 --redo。'
      : `  怎么补做：node cli.mjs fidelity ${path.join(evaluation, EVALUATION_FILE)} --redo ${path.join(evaluation, FIDELITY_REPORT_FILE)}${adapterArguments === '' ? '' : ` ${adapterArguments}`}（先说清要调几次再调；补做不改包里的验证记录，要更新就发新版本）。`;
    lines.push('还原度（说话人相似度跟真人基线比，加盲听；读法见 lib/fidelity.mjs 文件头）', renderFidelityReport(fidelity, { redoHint }).trimEnd());
  }
  lines.push('', ...renderVerification(report));
  const card = describeCardLine(report.cardLine);
  if (card.length > 0) lines.push('', ...card);
  if (report.hints.length > 0) lines.push('', '还缺什么素材：', ...report.hints.map((hint) => `  ${hint.message}`));
  lines.push('', '每一段：', ...renderSegments(report));
  if (evaluation !== null) lines.push('', `评测集和还原度报告已写到 ${evaluation}`);
  if (share !== null) lines.push('', ...describeShare(share));
  return `${lines.join('\n')}\n`;
}

/** 分享文件写到哪、预览卡片上有什么：有适配器给的产品名和入口就写出来，没有就说没有、想要怎么办。 */
function describeShare(share) {
  const { card } = share;
  const entries = card === null ? [] : [card.productName === null ? null : `产品 ${card.productName}`, card.open === null ? null : '打开入口', card.make === null ? null : '「做一个你自己的」入口'].filter((part) => part !== null);
  return [
    `分享文件已写到 ${share.file}（${share.bytes} 字节，sha256 ${share.sha256}）`,
    entries.length > 0
      ? `  预览卡片上：${entries.join('，')}（接进来的适配器给的）`
      : '  预览卡片上没有产品名和入口（接进来的适配器没给 previewCard）；要入口，用核心层的 pack 命令，自己给 --product-name、--open-link、--make-link',
    '  这一步没有验签：只是把刚做好的包打成分享文件；分发之前要核对，用 check 命令查这个分享文件',
  ];
}

// ---------------------------------------------------------------- 命令

export async function run(args, ctx) {
  const taken = takeAdapterArguments(args);
  if (taken.problem) return usageProblem(ctx, usage, taken.problem);
  const parsed = parseArgs(taken.rest, FLAGS);
  if (parsed.problem) return usageProblem(ctx, usage, parsed.problem);
  const { options } = parsed;
  const dryRun = options['dry-run'] === true;
  if (parsed.positional.length > 1) return usageProblem(ctx, usage, `只要一个素材目录或素材.json，多给了：${parsed.positional.slice(1).join(' ')}`);
  const hasRecordings = options.recording !== undefined || options.audition !== undefined;
  if (parsed.positional.length === 0 && options.previous === undefined && !hasRecordings) return usageProblem(ctx, usage, '要给素材目录或素材.json，或者 --recording <长录音> / --audition <默认音色、融合出来的试听>（发新版本只改指引、换参考时可以都不给，但要 --previous）');
  if (options['no-separate'] === true && options.recording === undefined) return usageProblem(ctx, usage, '--no-separate 只有给了 --recording 才有意义（--audition 本来就不分离）');
  if (!dryRun && options.output === undefined) return usageProblem(ctx, usage, '要给 --output <新目录>（做出来的包放这里）；只想看规划用 --dry-run');
  if (options.name === undefined && options.previous === undefined) return usageProblem(ctx, usage, '要给 --name <名字>（发新版本时可以不给）');
  if (options.bump !== undefined && !['patch', 'minor', 'major'].includes(options.bump)) return usageProblem(ctx, usage, `--bump 要给 patch、minor、major 之一，收到 ${options.bump}`);
  if (options.version !== undefined && options.bump !== undefined) return usageProblem(ctx, usage, '--version 和 --bump 只能给一个');
  if (options['text-language'] !== undefined && !TEXT_LANGUAGES.includes(options['text-language'])) {
    return usageProblem(ctx, usage, `--text-language 要给 ${TEXT_LANGUAGES.join('、')} 之一（包里 SKILL.md 骨架用的语言），收到 ${JSON.stringify(options['text-language'])}`);
  }
  for (const flag of ['version', 'bump', 'changelog', 'drop', 'retag']) {
    if (options[flag] !== undefined && options.previous === undefined) return usageProblem(ctx, usage, `--${flag} 只有发新版本（--previous）时才有意义`);
  }
  if (options.seed !== undefined && !Number.isInteger(options.seed)) return usageProblem(ctx, usage, `--seed 要给一个整数，收到 ${options.seed}`);
  if (options['max-error-rate'] !== undefined && options['max-error-rate'] < 0) return usageProblem(ctx, usage, `--max-error-rate 要给一个不小于 0 的数，收到 ${options['max-error-rate']}`);
  if (dryRun && options['save-evaluation'] !== undefined) return usageProblem(ctx, usage, '--dry-run 不做包也不试合成，没有评测集可存');
  if (dryRun && options['share-file'] !== undefined) return usageProblem(ctx, usage, '--dry-run 不做包，没有分享文件可打');
  const unsplit = (options.retag ?? []).find((value) => !value.includes('='));
  if (unsplit !== undefined) return usageProblem(ctx, usage, `--retag 要写成 <段名>=<标签>（一次一段），收到 ${JSON.stringify(unsplit)}`);

  // 花钱之前先把能查的都查了：输出目录还没有、素材读得了、上一版和协议核心读得了
  const output = options.output === undefined ? null : path.resolve(ctx.cwd, options.output);
  const evaluationDirectory = options['save-evaluation'] === undefined ? null : path.resolve(ctx.cwd, options['save-evaluation']);
  const shareFile = options['share-file'] === undefined ? null : path.resolve(ctx.cwd, options['share-file']);
  if (output !== null) assertFresh(output);
  if (evaluationDirectory !== null) assertFresh(evaluationDirectory);
  if (shareFile !== null) assertFresh(shareFile);

  const material = parsed.positional.length === 1 ? loadMaterial(ctx, parsed.positional[0]) : { segments: [] };
  const loaded = [
    ...(options.recording === undefined ? [] : loadRecordings(ctx, options.recording, 'recording')),
    ...(options.audition === undefined ? [] : loadRecordings(ctx, options.audition, 'audition')),
  ];
  const baseVersion = options['base-version'] ?? ownBaseVersion();
  if (baseVersion === null) {
    throw new VoicePackError('make_pack_base_version_missing', '不知道做包用的基础部分是哪个版本：这份基础部分没有封印过（开发树），请用 --base-version <x.y.z> 明说', { details: { field: 'baseVersion' } });
  }
  const input = {
    baseVersion,
    protocolCore: loadFiles(path.resolve(ctx.cwd, options.protocol ?? path.join(SKILL_ROOT, 'protocol')), partName('protocol')),
    ...(options.base === undefined ? {} : { base: loadFiles(path.resolve(ctx.cwd, options.base), partName('base')) }),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options['short-name'] === undefined ? {} : { shortName: options['short-name'] }),
    ...(options.language === undefined ? {} : { language: options.language }),
    ...(options.guidance === undefined ? {} : { guidance: readText(ctx, options.guidance) }),
    ...(options.direction === undefined ? {} : { direction: readJson(ctx, options.direction, 'direction') }),
    ...(options['design-source'] === undefined ? {} : { designSource: readJson(ctx, options['design-source'], 'designSource') }),
    ...(options['sample-lines'] === undefined ? {} : { sampleLines: readJson(ctx, options['sample-lines'], 'sampleLines') }),
    ...(options['card-line'] === undefined ? {} : { cardLine: readText(ctx, options['card-line']) }),
    ...(options['card-line-expressiveness'] === undefined ? {} : { cardLineExpressiveness: expressivenessOption(options['card-line-expressiveness']) }),
    ...(options.expressiveness === undefined ? {} : { expressiveness: expressivenessOption(options.expressiveness) }),
    ...(options.setups === undefined ? {} : { setups: readJson(ctx, options.setups, 'setups') }),
    ...(options.lexicon === undefined ? {} : { files: new Map([[LEXICON_FILE, readBytes(ctx, options.lexicon)]]) }),
    ...(options.previous === undefined ? {} : { previous: loadFiles(path.resolve(ctx.cwd, options.previous), '上一版') }),
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.bump === undefined ? {} : { bump: options.bump }),
    ...(options.changelog === undefined ? {} : { changelog: options.changelog }),
    ...(options.drop === undefined ? {} : { drop: options.drop.split(',').map((id) => id.trim()).filter((id) => id !== '') }),
    ...(options.retag === undefined ? {} : { retag: retagOf(options.retag) }),
    // 点名的默认段：给几次就是几段（每种语言一段），交给库的是数组
    ...(options['default-segment'] === undefined ? {} : { defaultSegment: options['default-segment'] }),
  };
  // 段名的前缀避开素材里的段名和上一版的段名（去掉的也算）：切出来的段名撞了，要等分离、VAD 的钱花完了才知道。上一版的清单读不懂就不看它，makePack 会报
  const previousManifest = input.previous === undefined ? null : manifestOrNull(input.previous);
  const previousIds = [...(previousManifest?.reference?.segments ?? []), ...(previousManifest?.holdout ?? [])].map((segment) => segment?.id);
  const recordings = assignPrefixes(loaded, {
    taken: [...material.segments.map((segment) => segment?.id), ...previousIds].filter((id) => typeof id === 'string'),
    unnamed: material.segments.some((segment) => segment?.id === undefined),
  });

  // 环境：命令已有的，加适配器的（后给的盖过先给的，和 dub 一样）
  const { env, adapters } = await applyAdapters(ctx, ctx.env, taken.requests);
  const billing = billingSentence(adapters);
  const environment = options.environment ?? environmentName(adapters);
  const minChars = minCharsOf(adapters); // 合成能力一次至少多少个字（环境声明的）：影响配音和试合成，见 lib/make-pack.mjs 的 minChars
  const maxChars = maxCharsOf(adapters); // 下面两项只交给配卡片试听那一句的配音（lib/make-pack.mjs 的 maxChars、maxPauseInRequestMs）
  const maxPauseInRequestMs = maxPauseInRequestMsOf(adapters);
  const limits = { ...(minChars === undefined ? {} : { minChars }), ...(maxChars === undefined ? {} : { maxChars }), ...(maxPauseInRequestMs === undefined ? {} : { maxPauseInRequestMs }) };

  // 长录音和试听要先切段：环境没有转写时，切出来的段都没有逐字文本（切段不转写，--recording、--audition 也不收逐字稿），一段都用不上；素材里也没有一段带着逐字文本、又不是发新版本：
  // 做不出包已经定了。这时不调花钱的分离和 VAD，和 --dry-run 一样按能量切（不调能力），makePack 在规划之后、花钱之前报 make_pack_no_material，details 和 --dry-run 的一样
  const nothingUsable = recordings.length > 0 && options.previous === undefined && !hasCapability(env, 'automatic-speech-recognition')
    && material.segments.every((segment) => (typeof segment.text !== 'string' || !hasWords(segment.text)) && typeof segment.annotatedText !== 'string'); // 只给了提示标注的段，逐字文本就是它去掉提示的那句
  // 要调花钱的分离、VAD 切段：只看输入就查得出的错（--retag、--setups 的 referenceTag、--card-line、版本号……）先查，查出来一次能力都不调（lib/make-pack-precheck.mjs）。
  // 要切出来的段也交代给它：段名的前缀，和有没有长录音要切成句子（句子不标 synthetic、没有 annotatedText，和素材里的句子一起查）
  if (recordings.length > 0 && !dryRun && !nothingUsable) {
    const upcoming = { idPrefixes: recordings.map((recording) => recording.idPrefix), sentences: recordings.some((recording) => recording.kind === 'recording') };
    await precheckInput(env, { ...input, segments: material.segments }, { ...limits, ...(options['text-language'] === undefined ? {} : { textLanguage: options['text-language'] }), upcoming });
  }

  // 查重（给了 --source-pack）：新包的文字和录音都定下了，花钱的几步还没开始，查出来就不用白花。来源包只在这里读，查完不留它的任何标识
  let duplicateCheck = null;
  if (options['source-pack'] !== undefined) {
    const source = materialOfPack(await readSourcePack(ctx, options['source-pack']));
    const candidate = materialOfInput(
      { ...input, segments: material.segments },
      { recordings: recordings.map((recording) => ({ item: recording.name, audio: recording.audio })) },
    );
    if (!ctx.json && candidate.recordings.length > 0) ctx.stderr('查重：正在比文字和录音（录音要整段解码、取指纹；不是 WAV 的要先用 ffmpeg 解）……\n');
    duplicateCheck = await checkDuplicates(env, { candidate, source });
  }

  // 长录音和试听：切段在转写和做包之前（要调分离或 VAD 的话先说明）。读文件、查输出目录、查上一版、查输入这些能查的，前面都已经做完了
  const separate = options['no-separate'] !== true;
  let cut = [];
  if (recordings.length > 0) {
    if (!dryRun && !ctx.json && !nothingUsable) {
      const note = cutCostNote({ env, recordings, separate });
      if (note !== null) ctx.stderr(note);
    }
    cut = await cutRecordings(env, recordings, { separate, dryRun: dryRun || nothingUsable });
  }
  // 设计来源有着落：给了 --design-source，或者发新版本、上一版的设计来源照规矩沿用（上一版的段这一版还留着，lib/pack-version.mjs 的 carriesDesignSource）
  const designSourceGiven = options['design-source'] !== undefined || (input.previous !== undefined && carriesDesignSource(manifestOrNull(input.previous), input.drop ?? []));
  const notes = [...(material.notes ?? []), ...cutNotes(cut, { dryRun, designSourceGiven })];
  const segments = [...material.segments, ...cut.flatMap((entry) => entry.segments)];
  if (cut.length > 0 && segments.length === 0 && options.previous === undefined) {
    throw invalid(options.recording === undefined ? '--audition' : '--recording', `没有切出任何一段，没有素材可做：${notes.map((note) => note.message).join('；')}`);
  }
  const recordingReports = cut.map((entry) => ({ kind: entry.recording.kind, idPrefix: entry.recording.idPrefix, ...entry.report }));

  const result = await makePack(env, { ...input, segments, ...(notes.length === 0 ? {} : { notes }) }, {
    ...(dryRun ? { dryRun: true } : {}),
    ...(options['no-evaluate'] === true ? { evaluate: false } : {}),
    ...(options['allow-cross-language'] === true ? { allowCrossLanguage: true } : {}),
    ...(options['no-loudness'] === true ? { loudness: false } : options['no-limiter'] === true ? { loudness: { limiter: false } } : {}),
    ...(options['no-holdout'] === true ? { holdoutRatio: 0 } : {}),
    ...(options.seed === undefined ? {} : { random: seededRandom(options.seed) }),
    ...(options['max-error-rate'] === undefined ? {} : { maxErrorRate: options['max-error-rate'] }),
    ...(options['text-language'] === undefined ? {} : { textLanguage: options['text-language'] }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(environment === null ? {} : { environment }),
    ...limits,
    onPlan: (plan) => {
      if (ctx.json) return;
      const language = languageNote({ plan, segments, language: options.language });
      if (billing !== null) ctx.stderr(costNote({ billing, plan, saveEvaluation: evaluationDirectory !== null, language, cardLine: options['card-line'] !== undefined }));
      else if (language !== null) ctx.stderr(`注意：${language}\n`);
    },
  });

  if (dryRun) {
    const language = languageNote({ plan: result.plan, segments, language: options.language });
    ctx.stdout(ctx.json ? `${JSON.stringify({ plan: result.plan, ...(cut.length === 0 ? {} : { recordings: recordingReports }), ...(duplicateCheck === null ? {} : { duplicateCheck }), report: result.report }, null, 2)}\n` : `规划：不做包，没调任何所需能力\n${renderPlan(result.plan, result.report, cut, duplicateCheck, language, options['card-line'] !== undefined).join('\n')}\n`);
    return 0;
  }

  writeDirectory(output, result.pack.files);
  let evaluation = null;
  if (evaluationDirectory !== null && result.evaluation !== null) {
    writeDirectory(evaluationDirectory, evaluationSetFiles(result));
    evaluation = evaluationDirectory;
  }
  // 分享文件在包写出去以后才打：卡片的链接要是不对（card_link_invalid），包和评测集都已经在了，不用为这个重做、重花钱。
  // 出错先把做包的结果照常写出来，再把错抛出去
  let share = null;
  let shareError = null;
  if (shareFile !== null) {
    try {
      share = await writeShare(shareFile, result.pack.files, previewCardOf(adapters));
    } catch (error) {
      if (!isVoicePackError(error)) throw error;
      shareError = error;
    }
  }
  if (ctx.json) {
    ctx.stdout(`${JSON.stringify({ packId: result.pack.id, version: result.pack.manifest.version, output, evaluation, ...(share === null ? {} : { shareFile: share }), ...(cut.length === 0 ? {} : { recordings: recordingReports }), ...(duplicateCheck === null ? {} : { duplicateCheck }), report: result.report }, null, 2)}\n`);
  } else {
    ctx.stdout(render(result, { output, evaluation, share, adapterArguments: describeRequests(taken.requests), cut, duplicateCheck }));
    if (evaluationDirectory !== null && evaluation === null) ctx.stderr('注意：没有评测集可存（没有试合成出任何录音），--save-evaluation 的目录没有写。\n');
  }
  if (shareError !== null) {
    if (!ctx.json) ctx.stderr(`包已经写到 ${output}，分享文件没有打出来：\n`);
    throw shareError;
  }
  return 0;
}
