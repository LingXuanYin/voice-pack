// SPDX-License-Identifier: Apache-2.0
//
// make-pack 命令：作者交来一批切好的录音（每段一个音频文件加它说的话），做成一个音色包的角色部分（或完整包）：筛片段、转写没有文本的、定语言、
// 挑出参考集和留出录音、给参考定音色基底标签、标提示标注、试合成、量还原度、提示还缺什么素材；也能给已有的包发新版本。流程在 lib/make-pack.mjs（输入、选项、报告、错误的正本在它的文件头），
// 这个命令只管读文件、组装运行环境、把包和报告写出来。
//
//   node cli.mjs make-pack [<素材目录|素材.json>] [--recording <文件|目录>] [--audition <文件|目录>] [--no-separate] --output <新目录> --name <名字> [--base-version <x.y.z>]
//                          [--short-name <英文短名>] [--language <标签>] [--text-language <zh|en>] [--guidance <文件.md>] [--direction <文件.json>] [--design-source <文件.json>] [--lexicon <文件.pls>] [--sample-lines <文件.json>] [--card-line <文件.txt> [--allow-cross-language] [--no-language-marks] [--card-line-language <标签>] [--card-line-expressiveness <0 到 100>]] [--expressiveness <0 到 100|none>] [--setups <文件.json>]
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
//   素材.json：{ "segments": [ { "id"?, "audio": "audio/a.wav", "text"?, "scriptText"?, "annotatedText"?, "language"?, "tag"?, "source"?, "externalUrl"?, "synthetic"?, "sentence"?, "trim"? } ] }（也可以直接是这个数组）；audio 是路径，相对这个 JSON 所在的目录。
//   language 是这段的语言，tag 是这段的音色基底标签（「平常」「愤怒」「少年」……，只用来在几段参考之间切换），和清单同名。
//     不给的，环境有 audio-text-to-text 时，标提示标注那一次顺带让模型起一个短名字（用 --text-language 的语言，不另调）；没有这项能力、这段没标上提示标注、
//     名字是空白的、素材给了 annotatedText（这段不调模型）的，用段名。同一种语言里撞名的加序号。上一版参考的标签用 --retag 改（见下）。
//     旧写法的 labels 不收：报 make_pack_input_invalid（field 是那一段的 labels），改写成 language、tag。
//   annotatedText 是这段的提示标注（逐字稿加上方括号提示的整句，提示以外的字和 text 一样）：给了就照给的，这段不再让模型标。
//     提示以外的字和 text 对不上，花钱之前报 make_pack_input_invalid；只给它不给 text，text 就是去掉提示的那句，这段不转写（规则在 lib/make-pack.mjs 文件头「输入」）。
//     作者要改上一版里一段的提示标注：--drop 那一段，再当素材重新给（换一个段名：去掉的段名这一版还不能再用），带上新的 annotatedText。
//     前面几步（分离、切段、转写）留下的说明可以写在 { "notes": [ { "code", "message", "details"? } ] } 里，原样进报告。
//   sentence 是 { bodySec, pauseSec }：这段是一句话（句子的秒数，和它后面原来的停顿）。长录音的句子模式给（--recording，见下），素材 .json 也可以写（references/make-pack.md「Source material」）；
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
//                              设计出来的声音不用它：设计的试听只当原料，不进交出去的包，见 references/make-pack.md「Making a pack from a designed voice」。
//                              设计来源用 --design-source 写进清单；没给就在报告的说明里提醒（design_source_missing）。发新版本没给的，上一版的设计来源照规矩沿用就不提醒，
//                              不沿用（上一版的段一段都没留下，lib/pack-version.mjs 的 carriesDesignSource）照样提醒。
//     可以和素材目录、素材.json 一起给，段合在一起。段名不会重复：切出来的段起前缀时避开了素材里和上一版的段名（见上）；素材自己的段名重复、和上一版的段重名，在花钱之前报（下面「说明之前先查」）。转写由 makePack 做（只转写没有文本的段，费用在做包的规划里）；切段这一步不转写。
//     分离和 VAD 是花钱、耗时的调用，每段录音各一次，不重试：调之前在标准错误里说明（--json 时不说），--dry-run 不调，按能量切，只报段数。
//     说明之前先查只看输入就查得出的错（素材的段名、--retag、--drop、版本号、--setups 的 referenceTag、--card-line 配不配得成一个请求、清单的规矩、
//     要切出来的段名、素材里的句子和要切出来的句子标得一不一样（synthetic、annotatedText，lib/make-pack-input.mjs「句子」）……，lib/make-pack-precheck.mjs）：
//     查出来就报，分离和 VAD 一次都不调。
//     环境没有 automatic-speech-recognition 时，切出来的段都没有逐字文本，用不上（这两个选项不收逐字稿）：素材里也没有一段带着逐字文本、又不是发新版本，就做不出包，
//     这时不调分离和 VAD（和 --dry-run 一样按能量切），在花钱之前报 make_pack_no_material（lib/make-pack.mjs 文件头「抛出的错误」），--dry-run 报的一样。
//     命令自己在报告的 notes 里加的说明（[{ code, message, details }]，没有要说的数就是空对象；切段留下的说明见 lib/long-recording.mjs 的文件头，调响度留下的见 lib/make-pack-loudness.mjs 的文件头，
//     录音的底噪 recording_noisy 见 lib/recording-noise.mjs 的文件头：文字输出时花钱之前也写到标准错误，--json 不写）：
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
//                       只管骨架：「## 配音指引」这一行所有语言都一样，--name、--guidance、--direction 里写的字原样放进包，不翻译（规则的正本是 protocol/FORMAT.md「Language of the skeleton」）。
//                       发新版本时用这一次给的，不看上一版是什么语言；不给就是中文。
//   --guidance          配音指引的正文（Markdown 文件），放进 SKILL.md 的最后一节。--direction：{ description?, tags? }，tags 只能从设计词表选。
//                       --design-source：{ description?, model?, modelVersion?, date?, auditionLines? }，设计出来的声音、默认音色、融合出来的声音做包时写。--lexicon：读音词表（PLS），放进包里的 lexicon.pls。
//                       --sample-lines：示例台词，一份 JSON 数组，每项一句台词（字符串；最多 50 条，每条 1–500 个字符，不能只有空白；可以带舞台提示，例如（耳语）），原样写进清单；发新版本不给就沿用上一版的，给空数组就去掉。
//                         哪一项不是字符串（例如把 vocab/design-sample-lines.json 的对象原样抄进来）花钱之前报 make_pack_input_invalid（field 是 sampleLines[0]）。
//                       --card-line：试听句，一个文本文件（UTF-8），整个文件是一句台词（去掉两头空白；1–500 个字符，可以带舞台提示）。包做好以后用这个包自己的声音配出来，
//                         写进清单的 cardLine，分享文件的卡片放它（lib/make-pack-card-line.mjs）；配不成一个请求在花钱之前报 make_pack_input_invalid（field 是 cardLine），
//                         配了没成包照做、报告里写明。发新版本不给，上一版有这一句就原样沿用，不重配（规则在 lib/make-pack-card-line.mjs 的 carriedCardLine）；要重配就交这一句。
//                         交的和上一版那一句的请求一样（同样的文字重配），换一个 seed（上一版的加 1，voiceCardLine），文字输出写明换了 seed。
//                       --allow-cross-language：给这一句挑的参考段不是这一句的语言（参考是日语，这一句是英文）也照配，跨语言克隆，带参考那种语言的口音。
//                         不给就不配这一句（配音默认不带口音，lib/dub.mjs 第 3a 步），一次都不调，包照做：报告的 cardLine 是 failed（dub_cross_language），
//                         「还缺什么素材」里是 card_line_cross_language，说怎么办（lib/material-hints.mjs）。不管试合成（量还原度照旧跨语言也配）。没给 --card-line 时它什么都不管。
//                         这一句开头写名字对（lib/dub.mjs 第 7c 步），没写的配不成（dub_cross_language_unnamed）。
//                       --no-language-marks：跨语言配这一句时不要求名字对，不加两边的语言提示（要带参考那种语言的口音时用，同 dub 的 --no-language-marks）。
//                       --expressiveness：这个声音的起伏（全局值，0 到 100 的整数，none 是去掉上一版的）；--card-line-expressiveness：试听句单独取的起伏（只有这一次配的这一句用，要和 --card-line 一起给）。不是 0 到 100 的整数，在花钱之前报 make_pack_input_invalid。
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
//                       新包的文字（描述、配音指引、示例台词、试听句、设计来源的描述）和录音（--recording、--audition、素材里的每一段）和来源包比，重合太多就报 duplicate_detected 停下（没花过钱），
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
// 输出：给人看的报告（素材去向、转写、标提示标注（哪几段没标上、为什么）、试合成、还原度、验证记录、还缺什么素材、每一段的语言和音色基底标签和来源、参考的提示标注）。还原度照 lib/fidelity.mjs 文件头「How to read this report」显示：
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
import { hasCapability, FFMPEG_INSTALL } from '../../protocol/lib/env.mjs';
import { seededRandom, UNMEASURABLE_LABEL } from '../../lib/fidelity.mjs';
import { LEXICON_FILE } from '../../lib/pronunciation-lexicon.mjs';
import { checkDuplicates, materialOfInput, materialOfPack } from '../../lib/duplicate-check.mjs';
import { assertFresh, isPlainObject, parseArgs, readBytes, readText, usageProblem } from '../input.mjs';
import { readMediaFile, isMediaFileName } from '../audio-files.mjs';
import { describeDuplicateCheck, readSourcePack } from '../source-pack.mjs';
import { ADAPTER_USAGE, applyAdapters, billingSentence, describeRequests, environmentName, ffmpegNote, moneySentence, maxCharsOf, maxPauseInRequestMsOf, minCharsOf, previewCardOf, takeAdapterArguments } from '../adapters.mjs';
import { EVALUATION_FILE, FIDELITY_REPORT_FILE, evaluationSetFiles } from '../evaluation-set.mjs';
import { fixed2, renderFidelityReport } from '../fidelity-report.mjs';

export const summary = 'Make a pack: read a batch of cut recordings, pick the reference set and held-out recordings, give each reference a reference tag and a cue annotation, trial-synthesize, measure fidelity, and point out what material is still missing; can also issue a new version of an existing pack';
export const usage = `make-pack [<material directory|material.json>] [--recording <file|directory>] [--audition <file|directory>] [--no-separate] --output <new directory> --name <name> [--short-name <English short name>] [--base-version <x.y.z>]
      [--language <language tag>] [--text-language <zh|en>] [--guidance <file.md>] [--direction <file.json>] [--design-source <file.json>] [--lexicon <file.pls>] [--sample-lines <file.json>] [--card-line <file.txt> [--allow-cross-language] [--no-language-marks] [--card-line-language <language tag>] [--card-line-expressiveness <0 to 100>]] [--expressiveness <0 to 100|none>] [--setups <file.json>]
      [--previous <pack directory> [--version <x.y.z> | --bump patch|minor|major] [--changelog <text>] [--drop <segment name,segment name>] [--retag <segment name>=<tag>]...] [--default-segment <segment name>]...
      [--source-pack <source pack directory or share file>] [--protocol <protocol core directory>] [--base <base part directory>] [--environment <name>]
      ${ADAPTER_USAGE}
      [--dry-run] [--no-evaluate] [--no-loudness] [--no-limiter] [--no-holdout] [--seed <integer>] [--max-error-rate <number>] [--concurrency <1-8>] [--save-evaluation <new directory>] [--share-file <share file>] [--json]`;

/** --help 里接在用法后面的几行：用法里看不出来的要紧的事。每个选项的全文在本文件的文件头，做包的细则在 references/make-pack.md。 */
export const help = `The key points (the full text of each option is in the header of cli/commands/make-pack.mjs; the material format, the tags and how to read the report are in references/make-pack.md):
  --default-segment <segment name>  State the default segment explicitly. A pack has one default segment per language: for a pack in several languages you can give it several times, each time naming one segment, and that segment is the default segment of its own language;
                                    only one segment can be named per language. A language you do not name is picked by the rules; when issuing a new version, the previous version's pick is kept.
  --card-line <file.txt>    The audition line (give it for recorded and designed voices alike): after the pack is made it is dubbed with the pack's own voice. If you do not give it when issuing a new version, the previous version's line is kept as it is, if there is one.
  --card-line-expressiveness <0 to 100>   Only the audition line dubbed this time uses this expressiveness; everything else follows the defaults. Give it together with --card-line.
  --card-line-language <language tag>   The language of the audition line (zh, fr, ...). Give it when the text does not show which language it is (French and Spanish are both Latin script): the cross-language comparison and the language cues both follow it. Give it together with --card-line.
  --expressiveness <0 to 100|none>        The expressiveness of this voice (global value). If you do not give it when issuing a new version, the previous version's is kept; none removes it.
  --recording, --audition   Hand in long recordings, or auditions of a default voice or a blended voice, directly; the command cuts the segments itself. Separation and VAD are paid calls: check the input first, then explain, before calling them.
                            An audition from a designed voice is only raw material; do not use --audition for it (references/make-pack.md「Making a pack from a designed voice」).
  --previous <pack directory>       Issue a new version: the previous version's references and held-out recordings are carried over as they are; --drop removes some, --retag changes tags.
  --dry-run                Run only the steps that cost nothing, say how many times each capability is called at most, and do not make a pack. Run it once before the real run.`;

/** --expressiveness、--card-line-expressiveness 的值：none 是去掉（null），不是数的变成 NaN，由 lib 报 make_pack_input_invalid（花钱之前，--dry-run 也报）。 */
const expressivenessOption = (value) => (value.trim() === 'none' ? null : value.trim() === '' ? Number.NaN : Number(value));

/** 命令认的选项（传给 parseArgs 的那份；--json 由 runner 取走，适配器的参数由 takeAdapterArguments 取走，都不在表里）。用法里要都写出来，约定见 cli/input.mjs 文件头。 */
export const FLAGS = {
  output: 'string', name: 'string', 'short-name': 'string', 'base-version': 'string', language: 'string', 'text-language': 'string',
  guidance: 'string', direction: 'string', 'design-source': 'string', lexicon: 'string', 'sample-lines': 'string', 'card-line': 'string', 'card-line-expressiveness': 'string', 'card-line-language': 'string', expressiveness: 'string', 'allow-cross-language': 'boolean', 'no-language-marks': 'boolean', setups: 'string',
  previous: 'string', version: 'string', bump: 'string', changelog: 'string', drop: 'string', retag: 'strings', 'default-segment': 'strings',
  recording: 'string', audition: 'string', 'no-separate': 'boolean', 'source-pack': 'string',
  protocol: 'string', base: 'string', environment: 'string',
  'dry-run': 'boolean', 'no-evaluate': 'boolean', 'no-loudness': 'boolean', 'no-limiter': 'boolean', 'no-holdout': 'boolean', seed: 'number', 'max-error-rate': 'number', concurrency: 'number', 'save-evaluation': 'string', 'share-file': 'string',
};
const SKILL_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const invalid = (field, problem, more = {}) => new VoicePackError('make_pack_input_invalid', `The make-pack input does not match the contract (${field}): ${problem}`, { details: { field, problem, ...more } });
const unreadable = (file, cause) => new VoicePackError('make_pack_input_unreadable', `Cannot read the material: ${file}`, { details: { file }, ...(cause === undefined ? {} : { cause }) });

// ---------------------------------------------------------------- 读素材

function readJson(ctx, file, field) {
  const text = readText(ctx, file);
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new VoicePackError('make_pack_input_invalid', `${file} is not valid JSON (${cause.message})`, { details: { field, problem: `not valid JSON: ${cause.message}` }, cause });
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
      if (!isPlainObject(meta)) throw invalid(name, `${sidecar} must be an object: { id?, text?, annotatedText?, language?, tag?, source?, externalUrl?, synthetic?, sentence?, trim? }`);
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
  if (!Array.isArray(list)) throw invalid('segments', `${file} must be { "segments": [ … ] } or an array`);
  const root = path.dirname(file);
  const read = new Map(); // 绝对路径 -> 读成的 { bytes, mimeType }
  const segments = list.map((raw, index) => {
    const field = `segments[${index}]`;
    if (!isPlainObject(raw)) throw invalid(field, 'must be an object { id?, audio, text?, scriptText?, annotatedText?, language?, tag?, source?, externalUrl?, synthetic?, sentence?, trim? }');
    if (typeof raw.audio !== 'string' || raw.audio === '') throw invalid(`${field}.audio`, 'must be the path of an audio file (relative to the directory the material .json is in)');
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
    if (retag.has(id)) throw invalid('retag', `${JSON.stringify(id)} was given twice: a segment can only be renamed once`, { segment: id });
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
  if (files.length === 0) throw invalid(`--${kind}`, `${resolved} has no audio files`);
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
  if (separating > 0 && hasCapability(env, 'audio-source-separation')) lines.push(`  Separation: ${separating} ${separating === 1 ? 'call' : 'calls'} (audio-source-separation, one per long recording)`);
  if (hasCapability(env, 'voice-activity-detection')) lines.push(`  Cutting: ${recordings.length} ${recordings.length === 1 ? 'call' : 'calls'} (voice-activity-detection, one per recording)`);
  return lines.length === 0 ? null : `These capabilities will be called before cutting (they cost money and time, and errors are not retried):\n${lines.join('\n')}\n`;
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
      notes.push(several ? { ...note, message: `${entry.recording.name}: ${note.message}` } : note);
    }
  }
  if (dryRun && cut.length > 0) notes.push({ code: 'dry_run_energy_cut', message: 'dry-run did not call separation or VAD, so the number of segments is the result of cutting by energy; in a real run, if the environment has VAD it is used to cut and the number may differ', details: {} });
  if (!designSourceGiven && cut.some((entry) => entry.recording.kind === 'audition')) {
    notes.push({ code: 'design_source_missing', message: 'This is an audition of a default voice or a blended voice, so a design source should be written when making the pack (--design-source <file.json>: description, model, date); none was given this time, so the pack has no design source', details: {} });
  }
  return notes;
}

/** 给人看的一行：这段录音怎么切的。 */
function describeCut({ recording, report }) {
  const separation = report.separation.status === 'done' ? `separated${report.separation.model === undefined ? '' : ` (${report.separation.model})`}` : 'not separated';
  const method = report.cutting.method === 'voice-activity-detection' ? `by VAD${report.cutting.model === undefined ? '' : ` (${report.cutting.model})`}` : 'by energy';
  const dropped = report.cutting.dropped.length > 0 ? `, ${report.cutting.dropped.length} leftover ${report.cutting.dropped.length === 1 ? 'piece' : 'pieces'} dropped` : '';
  const unit = recording.kind === 'recording' ? 'sentence' : 'segment'; // 长录音切成句子（见 cutRecordings）
  return `${recording.kind === 'audition' ? 'Audition' : 'Long recording'} ${recording.name}: ${report.recording.durationSec} s, ${separation}, cut ${method} into ${report.cutting.segments} ${unit}${report.cutting.segments === 1 ? '' : 's'}${dropped}`;
}

/** 长录音的句子先并成段（报告的 steps.sentences，lib/make-pack-sentences.mjs），给人看的一行：几句并成几段。没有句子就不写。 */
const describeSentences = (step) => (step === undefined ? [] : [`Sentences merged into segments: ${step.sentences} ${step.sentences === 1 ? 'sentence' : 'sentences'} of the long recording merged into ${step.segments} ${step.segments === 1 ? 'segment' : 'segments'}, each segment transcribed once (sentences are not transcribed one by one)`]);

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
    throw new VoicePackError('make_pack_previous_unreadable', `${what} ${directory} has a problem and cannot be used: ${problems[0].message}${problems.length > 1 ? ` (${problems.length} problems in all)` : ''}`, { details: { file: directory, problems } });
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

const CALL_NOTE = { 'automatic-speech-recognition': 'Transcription', 'audio-text-to-text': 'Picking the default segment, cue annotation and blind listening', 'voice-cloning': 'Trial synthesis', 'speaker-verification': 'Speaker similarity' };

/**
 * voice-cloning 那一项合成的是什么：试合成留出录音（plan 里合成的次数减去试听句），和配试听句（给了 --card-line、环境有 voice-cloning，lib/make-pack-plan.mjs），
 * 哪样有写哪样（没有留出录音、--no-evaluate 时只有试听句，不说成试合成）。{ work: 各项次数那一行和重试那一行开头的说法, each: 重试那一行说的「每……」 }
 */
function cloningNote(plan, cardLine) {
  const card = cardLine && plan.capabilities['voice-cloning'] ? 1 : 0;
  const trial = plan.calls['voice-cloning'] - card > 0;
  if (card === 0) return { work: CALL_NOTE['voice-cloning'], each: 'each held-out recording' };
  return trial ? { work: 'Trial synthesis and dubbing the audition line', each: 'each held-out recording and the audition line' } : { work: 'Dubbing the audition line', each: 'this line' };
}
/** 各项次数那一行开头的说法：voice-cloning 照 cloningNote，别的照 CALL_NOTE。 */
const callNote = (capability, plan, cardLine) => (capability === 'voice-cloning' ? cloningNote(plan, cardLine).work : CALL_NOTE[capability]);

/**
 * 没给 --language，又有要转写的片段：转写不报语言时（automatic-speech-recognition 返回里的 language 可以没有），拉丁字母的文字（英文、法文……）认不出是哪种语言，
 * 这些段付完转写费才发现用不上（language_unknown）；中文、日文这类非拉丁字母的文字从文字本身就认得出，不受影响。只是提醒，不挡运行。
 * 规则的正本是 lib/make-pack-tags.mjs 的文件头「语言」和 references/make-pack.md 的「Segment tags」；没有要提醒的返回 null。
 * 数的是「没有文本、也没有自己的 language」的片段，和规划里要转写的段数取小的那个（环境没有转写时，规划里要转写的段数是 0，所以不会提醒）。
 */
function languageNote({ plan, segments, language }) {
  if (language !== undefined) return null;
  const unlabelled = segments.filter((segment) => (segment.text === undefined || segment.text === '') && !segment.language).length;
  const count = Math.min(plan.calls['automatic-speech-recognition'], unlabelled);
  if (count === 0) return null;
  return `--language was not given, and ${count} ${count === 1 ? 'segment has' : 'segments have'} to be transcribed before the language is known: when the transcription does not report a language, text in Latin script (English, French, ...) cannot be told apart by language, so after the transcription is paid for all of these segments would be unusable because of language_unknown (text in non-Latin scripts such as Chinese and Japanese is not affected). Add --language <language tag>, for example en (references/make-pack.md「Segment tags」)`;
}

/**
 * 有重试规则的几项能力（转写；挑默认段、标提示标注；试合成和试听句。规则在 lib/call-attempts.mjs，数目在 plan.extraCalls），各自的说法：做的是什么（work）、再来叫什么（again）、
 * 每什么再来（each）、上限怎么说（limit）。audio-text-to-text 那一项的总数是「挑默认段、标提示标注和盲听」（和各项最多调几次那一行同一个口径），盲听出错不重试，所以不在多出来的次数里，写明。
 * voice-cloning 那一项的 work、each 照 cloningNote（合成的是试合成、试听句，还是两样都有）。
 */
/** 规划里转写的上限，有多少是标提示标注时量停顿和快慢的（lib/make-pack-plan.mjs 算在 extraCalls 里）：不管有没有出错都要转写，不是重试，所以单写一行。 */
const measureCalls = (plan) => Math.max(0, (plan.extraCalls?.['automatic-speech-recognition'] ?? 0) - (MAX_ATTEMPTS - 1) * plan.calls['automatic-speech-recognition']);

const RETRY_NOTE = {
  'automatic-speech-recognition': { work: 'Transcription', again: 'transcription attempts', limit: (extra, total, plan) => `this run adds at most ${extra} more call(s), and ${measureCalls(plan) > 0 ? 'for the transcription that fills in missing text, ' : ''}actual calls will not exceed ${total}` },
  'audio-text-to-text': { work: 'Picking the default segment and cue annotation', again: 'listening attempts', each: 'each call', limit: (extra, total) => `this run adds at most ${extra} more call(s) (a blind listening error is not retried), and for picking the default segment, cue annotation and blind listening together actual calls will not exceed ${total}` },
  'voice-cloning': { again: 'synthesis attempts', limit: (extra, total) => `this run adds at most ${extra} more call(s), and actual calls will not exceed ${total}` },
};

/**
 * 暂时出错会再来的上限：转写、挑默认段和标提示标注、合成（试合成、试听句）各另起一行写明，写进费用说明和规划里。
 * 没有要转写、要听、要合成的，或者环境没有那项能力，那一项就没有这一行。cardLine 是给了 --card-line。
 */
function retryNotes(plan, cardLine) {
  const waits = RETRY_DELAYS_MS.map((ms) => `${ms / 1000} s`).join(', ');
  return Object.entries(RETRY_NOTE).flatMap(([capability, note]) => {
    const extra = (plan.extraCalls?.[capability] ?? 0) - (capability === 'automatic-speech-recognition' ? measureCalls(plan) : 0);
    const measuring = capability === 'automatic-speech-recognition' && measureCalls(plan) > 0
      ? [`Cue annotation also measures pauses and speed: with or without errors, every reference segment is cut into chunks and transcribed chunk by chunk, at most ${POINT_CHUNKS_MAX} chunks per segment, each chunk tried at most ${MAX_ATTEMPTS} times, at most ${measureCalls(plan)} call(s) this run, and transcription calls in all will not exceed ${plan.calls[capability] + (plan.extraCalls?.[capability] ?? 0)}`]
      : [];
    if (extra === 0) return measuring;
    const { work, each } = capability === 'voice-cloning' ? cloningNote(plan, cardLine) : note;
    return [`${work}: on a temporary service error, ${each ?? 'each segment'} gets at most ${MAX_ATTEMPTS - 1} more ${note.again} (waiting ${waits} before them, in that order), ${note.limit(extra, plan.calls[capability] + extra, plan)}`, ...measuring];
  });
}

/**
 * 试合成和试听句都有：合成的次数里有配试听句的一次（lib/make-pack-plan.mjs）。写在各项次数的后面；只有一样（cloningNote 已经说清楚了）就是 null。
 */
const cardLineNote = (plan, cardLine) => (cloningNote(plan, cardLine).work === 'Trial synthesis and dubbing the audition line' ? 'one of these calls dubs the audition line (--card-line, dubbed after the pack is made)' : null);

/** 花钱的几步开始之前的说明（只给人看，写到标准错误）。language 是 languageNote 的结果，有就写成最后一行之前的一行；cardLine 是给了 --card-line。 */
function costNote({ billing, plan, saveEvaluation, language, cardLine, money, ffmpeg }) {
  const lines = [`${billing}; below is how many times each capability is called at most (the actual number may be lower):`];
  for (const [capability, count] of Object.entries(plan.calls)) {
    lines.push(plan.capabilities[capability] ? `  ${callNote(capability, plan, cardLine)}: ${count} ${count === 1 ? 'call' : 'calls'} (${capability})` : `  ${callNote(capability, plan, cardLine)}: this environment does not have ${capability}, so this step ${capability === 'automatic-speech-recognition' ? 'is skipped and segments without text cannot be used' : `reports "${UNMEASURABLE_LABEL}" or is skipped`}`);
  }
  const card = cardLineNote(plan, cardLine);
  if (card !== null) lines.push(`  ${card}`);
  for (const retry of retryNotes(plan, cardLine)) lines.push(`  ${retry}`);
  if (language !== null) lines.push(`  Language: ${language}`);
  if (money !== null) lines.push(`  ${money}`);
  if (ffmpeg !== null) lines.push(`  ${ffmpeg}`);
  lines.push(`  For everything other than transcription, picking the default segment, cue annotation and synthesis, an item that hits a service error is recorded as "not heard" and is not retried automatically${saveEvaluation ? '' : '; to redo it later, add --save-evaluation <new directory> this time to keep the evaluation set'}`);
  return `${lines.join('\n')}\n`;
}

const UNUSED_NOTE = {
  no_text: 'no verbatim transcript',
  duplicate_audio: 'the same audio as another segment',
  audio_unrecognized: 'the audio format is not recognized',
  audio_undecodable: 'cannot be decoded',
  language_unknown: 'the language could not be identified',
  transcription_failed: 'transcription had a temporary error',
  transcription_blocked: 'transcription was blocked by the provider (content filter)',
  over_limit: 'too many references, over the limit',
  trim_out_of_range: 'the start is beyond the end of the recording',
};
function unusedNote(segment) {
  const tried = (segment.reason === 'transcription_failed' || segment.reason === 'transcription_blocked') && Number.isInteger(segment.details?.attempts) ? `, tried ${segment.details.attempts} time(s)` : '';
  const base = `${UNUSED_NOTE[segment.reason] ?? segment.reason}${tried}`;
  const codes = segment.details?.codes?.length > 0 ? `: ${segment.details.codes.join(', ')}` : '';
  const same = segment.details?.sameAs === undefined ? '' : `: same as ${segment.details.sameAs}`;
  const said = typeof segment.details?.message === 'string' ? `: ${segment.details.message}` : ''; // 解不开的：解码程序说的话，全文
  const range = segment.reason === 'trim_out_of_range' ? `: start ${segment.details.startSec} s, the recording is only ${segment.details.durationSec} s long` : '';
  const runtime = segment.details?.runtime === undefined ? '' : `: the environment does not have ${segment.details.runtime}, so the audio track cannot be extracted`; // 带视频轨的文件、别的格式（lib/make-pack-take-audio.mjs）
  return `${base} (${segment.reason}${codes}${same})${said}${range}${runtime}`;
}

/** 试合成的一句被作废的原因，给人看（lib/make-pack-trial.mjs 的 checkSynthesized 给的 codes）。 */
const VOIDED_WHY = {
  synthesized_mostly_silent: 'almost entirely silent',
  synthesized_too_long: 'the synthesized audio is much longer than the held-out recording of the same line',
  synthesized_too_short: 'the synthesized audio is much shorter than the held-out recording of the same line',
};

/** 试合成的一句没查到的原因，给人看（checkSynthesized 给的 reason）：没查到照旧量，报告写明原因。 */
const UNCHECKED_WHY = {
  runtime_missing: (check) => `the environment is missing the runtime ${check.runtime}, so the synthesized recording cannot be decoded`,
  undecodable: () => 'the synthesized recording is not in a recognizable audio format and cannot be decoded',
};

/** 作废的一句：为什么（几条原因都写上），量到的静音占比和时长，同一句的留出录音时长（有的话）。 */
function describeVoided(check) {
  const why = check.codes.map((code) => VOIDED_WHY[code]).join('; ');
  const silence = check.silenceRatio === null ? 'shorter than one window, so the silence ratio cannot be measured' : `silence ratio ${check.silenceRatio}`;
  const holdout = check.holdoutSec === undefined ? '' : `, held-out recording of the same line ${check.holdoutSec} s`;
  return `${why} (${silence}, duration ${check.durationSec} s${holdout})`;
}

/** 一段参考没标上提示标注的原因，给人看（lib/make-pack-annotation.mjs 的 notAnnotated 和每段的 annotation）。 */
const NOT_ANNOTATED_WHY = {
  listening_check_failed: 'the model itself said it heard nothing (the listening check failed)',
  annotation_answer_invalid: 'the answer could not be understood',
  annotation_answer_unusable: 'the answer did not end normally',
  provider_blocked: "the answer was blocked by the model's provider",
  cues_unmatched: 'none of the cues matched the original text',
  not_heard: `temporary service error, and still failed after all the retries (at most ${MAX_ATTEMPTS} attempts)`,
  capability_missing: 'the environment does not have audio-text-to-text',
};

/** 标提示标注那一步，给人看（steps.annotation，写法见 lib/make-pack-annotation.mjs）：标上了几段、丢了几条提示、哪几段没标上和为什么。 */
function describeAnnotation(step) {
  if (step === undefined) return [];
  const given = step.given > 0 ? `${step.given} ${step.given === 1 ? 'segment uses' : 'segments use'} the cue annotation given in the material` : '';
  if (step.status === 'not_needed') return given === '' ? [] : [`Cue annotation: ${given}, no model called`];
  const missed = step.notAnnotated.length > 0 ? `${step.notAnnotated.length} ${step.notAnnotated.length === 1 ? 'segment' : 'segments'} not annotated, only the verbatim transcript is stored: ${step.notAnnotated.map((entry) => `${entry.id} (${NOT_ANNOTATED_WHY[entry.reason] ?? entry.reason})`).join(', ')}` : '';
  if (step.status === 'skipped') return [`Cue annotation: not done, the environment does not have ${step.capability}, ${[given, missed].filter((part) => part !== '').join('; ')}`];
  const parts = [
    `${step.annotated} ${step.annotated === 1 ? 'segment' : 'segments'} annotated${step.retried > 0 ? ` (temporary error, listened ${step.retried} extra ${step.retried === 1 ? 'time' : 'times'} automatically)` : ''}`,
    step.droppedCues > 0 ? `dropped ${step.droppedCues} ${step.droppedCues === 1 ? 'cue' : 'cues'} that did not match the original text` : '',
    step.withoutCues > 0 ? `${step.withoutCues} ${step.withoutCues === 1 ? 'segment' : 'segments'} sounded the same throughout, no cues added` : '',
    step.openingMismatched > 0 ? `${step.openingMismatched} ${step.openingMismatched === 1 ? 'segment' : 'segments'} where the opening the model wrote does not match the verbatim transcript, not voided: the cues are placed only at the positions found in the original (annotation.openingErrorRate of each segment is in the report)` : '',
    given,
    missed,
    step.notMeasured > 0 ? `${step.notMeasured} ${step.notMeasured === 1 ? 'segment' : 'segments'} could not be measured for pauses and speed, only the listening result is used (the reason is in annotation.measureReason of each segment in the report)` : '',
  ];
  return [`Cue annotation: ${parts.filter((part) => part !== '').join('; ')}`];
}

/** 一段参考的提示标注，给人看的那一小截（报告每段的 annotation）；没有就是空串。 */
function annotationNote(annotation) {
  if (annotation === undefined) return '';
  if (annotation.status === 'annotated') return ` cue annotation: ${annotation.cues} ${annotation.cues === 1 ? 'cue' : 'cues'}${annotation.droppedCues === undefined ? '' : ` (${annotation.droppedCues} dropped)`}`;
  if (annotation.status === 'given') return ' cue annotation: given in the material';
  if (annotation.status === 'no_cues') return ' cue annotation: no cues (no change in the way of speaking)';
  const why = annotation.status === 'not_heard' ? 'not_heard' : annotation.reason; // 作废的原因，或者 capability_missing
  return ` cue annotation: not annotated (${NOT_ANNOTATED_WHY[why] ?? why})`;
}

function describeSteps(steps) {
  const lines = [];
  const transcription = steps.transcription;
  if (transcription?.status === 'skipped') lines.push(`Transcription: not done, the environment does not have ${transcription.capability}, ${transcription.segments} segment(s) without text cannot be used`);
  else if (transcription?.status === 'done') lines.push(`Transcription: ${transcription.transcribed} segment(s) given text${transcription.retried > 0 ? ` (${transcription.blocked > 0 ? 'temporary errors or blocked' : 'temporary errors'}, ${transcription.retried} extra transcription call(s) made automatically)` : ''}${transcription.failed > 0 ? `; ${transcription.failed} segment(s) had a temporary service error and still failed to transcribe after ${MAX_ATTEMPTS} attempts (unusable)` : ''}${transcription.blocked > 0 ? `; ${transcription.blocked} segment(s) blocked by the provider (content filter, unusable)` : ''}`);
  lines.push(...describeAnnotation(steps.annotation));
  const loudness = steps.loudness;
  if (loudness?.status === 'skipped') lines.push('Loudness adjustment: not done (--no-loudness), the audio is put into the pack as it is');
  else if (loudness?.status === 'done') {
    const changed = loudness.adjusted + loudness.peakLimited;
    const limiterOn = loudness.limiter !== null && loudness.limiter !== undefined;
    const rest = [
      loudness.limiterUsed > 0 ? `${loudness.limiterUsed} segment(s) had peaks that were too high held down by the limiter` : '',
      loudness.peakLimited > 0 ? (limiterOn ? `${loudness.peakLimited} segment(s) still short of the target after the limiter took them down to ${loudness.limiter.maxDb} dB` : `${loudness.peakLimited} segment(s) short of the target because the peak must not exceed ${loudness.peakCeilingDbfs} dBFS`) : '',
      loudness.unchanged > 0 ? `${loudness.unchanged} segment(s) already on the target` : '',
      loudness.skipped > 0 ? `${loudness.skipped} segment(s) could not be adjusted and went into the pack as they are` : '',
      loudness.carried > 0 ? `${loudness.carried} segment(s) from the previous version left untouched` : '',
      limiterOn ? '' : 'limiter off (--no-limiter)',
    ].filter((text) => text !== '');
    lines.push(`Loudness adjustment: ${changed} segment(s) adjusted to ${loudness.targetLufs} LUFS (sample peak not above ${loudness.peakCeilingDbfs} dBFS)${rest.length > 0 ? `; ${rest.join('; ')}` : ''}`);
  }
  const trial = steps.trial;
  if (trial?.status === 'done') {
    // retried 是为暂时出错多合成了几次；failed 是没合成出来的（lib/make-pack-trial.mjs），分三种照实说：暂时出错试满次数的（和转写那一行同样的写法），
    // 文字被拒的（details.textRejected，不重试），合成那头做完了、结果没取回的（details.unretrieved，计过费，不再调）
    const retried = trial.retried > 0 ? ` (temporary error, ${trial.retried} extra synthesis call(s) made automatically)` : '';
    const idsOf = (entries) => entries.map((entry) => entry.id).join(', ');
    const unretrieved = trial.failed.filter((entry) => entry.error?.details?.unretrieved === true);
    const rejected = trial.failed.filter((entry) => entry.error?.details?.unretrieved !== true && entry.error?.details?.textRejected === true);
    const serviceErrors = trial.failed.filter((entry) => !unretrieved.includes(entry) && !rejected.includes(entry));
    const failedParts = [
      ...(serviceErrors.length > 0 ? [`${serviceErrors.length} item(s) had a temporary service error and could not be synthesized after ${MAX_ATTEMPTS} attempts (${idsOf(serviceErrors)})`] : []),
      ...(rejected.length > 0 ? [`${rejected.length} item(s) had their text rejected (${idsOf(rejected)}), not retried`] : []),
      ...(unretrieved.length > 0 ? [`${unretrieved.length} item(s) not retrieved (${idsOf(unretrieved)}): the synthesis side has finished and was billed, only the result was not retrieved, and no further call was made; making the pack again will synthesize it again and bill it again`] : []),
    ];
    const failed = failedParts.length > 0 ? `; ${failedParts.join('; ')}, left out of the evaluation` : '';
    // 合成出来的每一句量还原度之前先检查：作废的不进比值，逐条写明哪条、为什么、量到的数；没查到的照旧量，写明原因
    const voided = trial.items.filter((item) => item.check?.status === 'voided');
    const unchecked = trial.items.filter((item) => item.check?.status === 'unchecked');
    const voidedText = voided.length > 0 ? ` (${voided.length} of them voided)` : '';
    // 文字不够合成能力的下限的（status 是 skipped）：没合成，不算试了一遍，逐条写明字数和下限（lib/make-pack-trial.mjs）
    const tooShort = trial.items.filter((item) => item.status === 'skipped');
    const tooShortText = tooShort.length > 0 ? ` (another ${tooShort.length} shorter than the lower limit of the synthesis capability, not synthesized)` : '';
    lines.push(`Trial synthesis: tried ${trial.items.length - tooShort.length} held-out recording(s), ${trial.synthesized} synthesized${voidedText}${tooShortText}${retried}${failed}`);
    for (const item of tooShort) lines.push(`  Not synthesized: ${item.id}, shorter than the lower limit of the synthesis capability (${item.chars} characters, the limit is ${item.min}), not in the ratio, no cost`);
    for (const item of voided) lines.push(`  Voided: ${item.id}, ${describeVoided(item.check)}, not in the ratio`);
    const byWhy = new Map();
    for (const item of unchecked) {
      const why = UNCHECKED_WHY[item.check.reason](item.check);
      byWhy.set(why, [...(byWhy.get(why) ?? []), item.id]);
    }
    for (const [why, ids] of byWhy) lines.push(`  Not checked: ${ids.join(', ')}, ${why}, measured as usual and in the ratio`);
  }
  else if (trial?.status === 'skipped') {
    const why = { evaluate_false: 'not run this time (--no-evaluate)', no_holdout: 'no held-out recordings', capability_missing: `missing ${trial.capability}`, runtime_missing: `missing runtime ${trial.runtime}` }[trial.reason] ?? trial.reason;
    lines.push(`Trial synthesis: not done, ${why}`);
  }
  return lines;
}

/** 试听句，给人看（报告的 cardLine，写法见 lib/make-pack-card-line.mjs 的文件头）；没有这一句就不写。没配成、沿用了但有出入的怎么补，在「还缺什么素材」里。 */
function describeCardLine(cardLine) {
  if (cardLine === undefined || cardLine.status === 'none') return [];
  const quoted = `"${cardLine.text}"`;
  if (cardLine.status === 'voiced') {
    // 适配器换了模型（modelChange）：写明换成了哪个、原来要用哪个、为什么（约定见 adapters/README.md「When the model changes」）
    const changed = cardLine.modelChange === undefined ? '' : `; note: the adapter changed the model, this line was dubbed with ${cardLine.model ?? 'the replacement model'}, while ${cardLine.modelChange.from} was meant to be used (${cardLine.modelChange.reason})`;
    // 用同样的请求重配，换了 seed（seedChange，lib/make-pack-card-line.mjs 的 voiceCardLine「seed」）：同一个 seed、同样的请求，测过出同一条，也测到过出不一样的（models/scene3.md「Sampling: `seed`」）
    const reseeded = cardLine.seedChange === undefined ? '' : `, the request is the same as the previous version's line, so the seed was changed: the previous version used ${cardLine.seedChange.from}, this time ${cardLine.seed}`;
    return [`Audition line: dubbed, written to ${cardLine.audio} (reference segment ${cardLine.pick.segmentId}${cardLine.openingCue?.added ? `, opening cue ${cardLine.openingCue.cue} added` : ''}${cardLine.attempts > 1 ? `, temporary error, synthesized ${cardLine.attempts} times` : ''}${reseeded}${changed}): ${quoted}`];
  }
  if (cardLine.status === 'carried') {
    // 沿用了，但和现在的配法有出入（reasons，lib/make-pack-card-line.mjs 的 carriedCardLine）：写明哪里对不上，要重配交 --card-line
    const reasons = cardLine.reasons ?? [];
    const off = reasons.length === 0 ? '' : `, which differs from how it would be dubbed now (${reasons.map((reason) => CARD_LINE_REASON_WORDS[reason] ?? reason).join(', ')}); to dub it again, hand in --card-line (see "Material still missing")`;
    return [`Audition line: carried over from the previous version (${cardLine.from})${off}: ${quoted}`];
  }
  // 参考段不是这一句的语言、没给 --allow-cross-language（lib/make-pack-card-line.mjs 的 voiceCardLine「跨语言」）：不是没配成，是没配；怎么办在「还缺什么素材」
  const cross = cardLine.status === 'failed' && cardLine.error?.code === 'dub_cross_language' ? cardLine.error.details?.units?.[0] : undefined;
  if (cross !== undefined) return [`Audition line: not dubbed. The reference segment picked for it, ${cross.segmentId}, is not in the same language as this line (${languagePair(cross)}), and dubbing it this way would carry an accent, so no call was made. Do not ask the user: start the line with a name pair ([name in the reference language|name in the line's language]) and issue a new version with --allow-cross-language to dub it again; if the user wants to add a reference in this language themselves (when there is no recording of this character speaking this language, by default dub a passage across languages with this pack and use it as the reference), see "Material still missing"; the manifest does not have it: ${quoted}`];
  // 凭据被拒、账户停了（halted，lib/make-pack-card-line.mjs）：不是这一句的问题，要使用者先处理
  if (cardLine.status === 'failed' && cardLine.halted === true) return [`Audition line: failed to dub, the credentials were rejected or the account is suspended (${cardLine.error.code}: ${cardLine.error.message}): deal with the credentials or account first, do not retry, and once that is fixed issue a new version to add it (see "Material still missing"); the manifest does not have it: ${quoted}`];
  // 合成那头做完了、结果没取回（error.details.unretrieved，和 lib/material-hints.mjs 的 card_line_failed 认法一样）：计过费，没有再调；手动取回、重配（再计一次费）见「还缺什么素材」
  if (cardLine.status === 'failed' && cardLine.error?.details?.unretrieved === true) return [`Audition line: not retrieved (billed): the synthesis side has finished but the result was not retrieved, and no further call was made this time (${cardLine.error.code}: ${cardLine.error.message}); how to retrieve it and whether to dub it again: see "Material still missing"; the manifest does not have it: ${quoted}`];
  return [`Audition line: failed to dub (${cardLine.error.code}: ${cardLine.error.message}), the manifest does not have it: ${quoted}`];
}

function renderVerification(report) {
  const lines = [];
  const record = report.verification;
  if (record === null) lines.push('Verification record: none (neither evaluation measured anything, so there is nothing to record)');
  else lines.push(`Verification record: written to the manifest: environment ${record.environment}, model ${record.model}, date ${record.date}, ${record.fidelity.ratio === undefined ? 'no ratio (speaker similarity could not be measured, only blind listening)' : `ratio ${fixed2(record.fidelity.ratio)}`}`);
  if (report.version?.verification.droppedFromPrevious > 0) lines.push(`  ${report.version.verification.droppedFromPrevious} verification record(s) of the previous version were not carried over: they measured the previous version's reference set and guidance`);
  return lines;
}

function renderSegments(report) {
  const shown = report.segments.slice(0, 40);
  const lines = shown.map((segment) => {
    const role = { reference: 'reference', holdout: 'held-out recording', unused: 'not used', dropped: 'dropped', candidate: 'candidate' }[segment.role] ?? segment.role;
    // 参考段：语言和音色基底标签（加了序号的写原名）；留出录音：语言。括号里是来源（lib/make-pack-tags.mjs 的文件头）
    const language = segment.language === undefined ? '' : ` ${segment.language} (${segment.languageSource})`;
    const tag = segment.tag === undefined ? '' : ` "${segment.tag}" (${segment.tagSource}${segment.renamedFrom === undefined ? '' : `, original name "${segment.renamedFrom}", a number was added because of a name clash`})`;
    const tags = `${language}${tag}`;
    const why = segment.role === 'unused' ? `: ${unusedNote(segment)}` : '';
    // 做包先取的音频（lib/make-pack-take-audio.mjs）：不是包能放的格式、取了音轨的；素材写了起止秒、切了的
    const prepared = [...(segment.convertedFrom === undefined ? [] : [`audio track taken from ${segment.convertedFrom}`]), ...(segment.trim === undefined ? [] : [`cut from ${segment.trim.startSec} s to ${segment.trim.endSec} s`])];
    const preparedNote = prepared.length === 0 ? '' : ` (${prepared.join(', ')})`;
    return `  ${segment.id}  ${role}${segment.previous === undefined ? '' : ' (from the previous version)'}${preparedNote}${tags}${annotationNote(segment.annotation)}${why}`;
  });
  if (report.segments.length > shown.length) lines.push(`  (${report.segments.length - shown.length} more segment(s), use --json to see all)`);
  return lines;
}

/** 音质和时长没查的段（lib/make-pack-screen.mjs 的 quality.status 是 unchecked）写给人看：只写在 --json 里的话，看文字输出的人不知道超长、削波这些没人管。 */
function describeUncheckedQuality(segments) {
  const unchecked = segments.filter((segment) => segment.quality?.status === 'unchecked');
  if (unchecked.length === 0) return [];
  const ids = (list) => list.map((segment) => segment.id).join(', ');
  const noRuntime = unchecked.filter((segment) => segment.quality.reason === 'runtime_missing');
  const other = unchecked.filter((segment) => segment.quality.reason !== 'runtime_missing');
  const parts = [
    ...(noRuntime.length > 0 ? [`${ids(noRuntime)}: decoding needs ${noRuntime[0].quality.runtime}, which this environment does not have (${FFMPEG_INSTALL})`] : []),
    ...(other.length > 0 ? [`${ids(other)}: cannot be decoded`] : []),
  ];
  return [`Audio quality and duration: ${unchecked.length} segment(s) not checked, so nothing is known about whether they are too long, too short, clipped or too silent. ${parts.join('; ')}`];
}

function renderPlan(plan, report, cut, duplicateCheck, language, cardLine) {
  const lines = [...cut.map(describeCut), ...describeSentences(report.steps?.sentences), `Material: ${plan.segments.input} segment(s) in${plan.segments.carried === undefined ? '' : `, ${plan.segments.carried} brought over from the previous version`}, ${plan.segments.usable} usable (${plan.segments.withoutText} without text)`];
  if (duplicateCheck !== null) lines.push(...describeDuplicateCheck(duplicateCheck));
  lines.push(...describeUncheckedQuality(report.segments));
  const unused = Object.entries(plan.segments.unused).map(([reason, count]) => `${UNUSED_NOTE[reason] ?? reason}: ${count} ${count === 1 ? 'segment' : 'segments'}`);
  if (unused.length > 0) lines.push(`Not used: ${unused.join('; ')}`);
  lines.push('How many times each capability is called at most:');
  for (const [capability, count] of Object.entries(plan.calls)) lines.push(`  ${callNote(capability, plan, cardLine)}: ${plan.capabilities[capability] ? `${count} ${count === 1 ? 'call' : 'calls'}` : `this environment does not have ${capability}`}`);
  const card = cardLineNote(plan, cardLine);
  if (card !== null) lines.push(`  ${card}`);
  for (const retry of retryNotes(plan, cardLine)) lines.push(`  ${retry}`);
  lines.push(`Held-out recordings expected: ${plan.holdouts}`);
  if (language !== null) lines.push(`Note: ${language}`);
  for (const note of report.notes) lines.push(`Note: ${note.message}`);
  lines.push('', 'Each segment:', ...renderSegments(report));
  return lines;
}

/** 默认段是按哪条规则挑的，写给人看（规则见 lib/pack-material.mjs 的规则 5；报告的 defaultSegment.rule）。 */
const DEFAULT_RULE_NOTE = {
  author: () => 'stated explicitly by the author',
  previous: () => 'carried over from the previous version',
  model: (defaultSegment) => `picked by a model that can listen to audio from ${defaultSegment.candidates.length} candidate(s): ${defaultSegment.why}`,
  typical: () => 'the segment most similar to the other references on average',
  priority: (defaultSegment) => (defaultSegment.unpicked === undefined && defaultSegment.unmeasured === undefined ? 'by priority: this environment has no model that can listen to audio and no speaker similarity, or they could not be measured' : 'by priority'),
  only: () => 'the only candidate',
};

/** 问了能听音频的模型、没挑成的原因，写给人看（报告的 defaultSegment.unpicked，写法见 lib/default-pick.mjs 和 lib/make-pack-pick.mjs）。 */
const UNPICKED_WHY = {
  listening_check_failed: 'the opening it wrote does not match the segment it picked, so it did not really hear the audio (the listening check failed)',
  pick_answer_invalid: 'the answer is not in the fixed format',
  pick_answer_unusable: 'the answer did not end normally or is empty',
  provider_blocked: "the answer was blocked by the model's provider",
};
function unpickedNote(unpicked) {
  if (unpicked.status === 'voided') return UNPICKED_WHY[unpicked.reason] ?? unpicked.reason;
  if (unpicked.status === 'not_heard') return `temporary service error, and it still failed after ${unpicked.attempts} attempts`;
  return unpicked.error.message;
}

/** 别的语言各自的默认段（报告的 languageDefaults），写给人看：「；其他语言的默认段：zh z2（规则）、ja j1（规则）」，只有一种语言就是空的。 */
const languageDefaultsNote = (entries) => (entries === undefined || entries.length === 0 ? '' : `; default segments of the other languages: ${entries.map((entry) => `${entry.language} ${entry.id}${describeDefaultRule(entry)}`).join(', ')}`);

/** 默认段的规则写给人看；问了模型没挑成的、量相似度出了错退回的，连原因一起写上（报告的 defaultSegment.unpicked、unmeasured）。 */
function describeDefaultRule(defaultSegment) {
  const unpicked = defaultSegment.unpicked === undefined ? '' : `; the model that can listen to audio could not pick one: ${unpickedNote(defaultSegment.unpicked)}`;
  const unmeasured = defaultSegment.unmeasured === undefined ? '' : `; speaker similarity could not be measured: ${defaultSegment.unmeasured.error.message}`;
  return ` (${DEFAULT_RULE_NOTE[defaultSegment.rule](defaultSegment)}${unpicked}${unmeasured})`;
}

function render(result, { output, evaluation, share, adapterArguments, cut, duplicateCheck }) {
  const { report, pack } = result;
  const lines = [];
  const { manifest } = pack;
  lines.push(`Pack: ${manifest.name} (${pack.id} ${manifest.version})${output === null ? '' : `, written to ${output}`}`);
  if (report.version !== undefined) {
    lines.push(`Version: previous ${report.version.previous} → ${report.version.next} (changelog ${report.version.changelogSource === 'author' ? 'written by the author' : 'generated from the changes'}): ${manifest.changelog}`);
  }
  lines.push(...cut.map(describeCut), ...describeSentences(report.steps.sentences));
  const { counts } = report;
  lines.push(`Material: ${counts.input} segment(s) in${counts.carried === undefined ? '' : `, ${counts.carried} brought over from the previous version, ${counts.dropped} dropped`}; ${counts.references} reference segment(s), ${counts.holdouts} held-out recording(s), ${counts.realRecordings} real-recording segment(s), ${counts.unused} not used; default segment ${manifest.reference.defaultSegment}${report.defaultSegment === undefined ? '' : describeDefaultRule(report.defaultSegment)}${languageDefaultsNote(report.languageDefaults)}`);
  if (duplicateCheck !== null) lines.push(...describeDuplicateCheck(duplicateCheck));
  for (const note of report.notes) lines.push(`Note: ${note.message}`);
  lines.push(...describeSteps(report.steps));
  lines.push(...describeUncheckedQuality(report.segments));

  const fidelity = report.fidelity;
  lines.push('');
  if (fidelity.status === 'skipped') {
    const why = { no_trial: 'trial synthesis not done', no_generated: 'no synthesis came out', generated_voided: 'all the synthesized recordings were voided (see "Trial synthesis")',no_holdout: 'no held-out recordings', evaluate_false: 'not run this time (--no-evaluate)' }[fidelity.reason] ?? fidelity.reason;
    lines.push(`Fidelity: not measured (${why})`);
  } else {
    const redoHint = evaluation === null
      ? '  How to redo it: no evaluation set was saved this time, so it cannot be redone; to be able to, add --save-evaluation <new directory> when making the pack (this costs money again), then use --redo of the fidelity command.'
      : `  How to redo it: node cli.mjs fidelity ${path.join(evaluation, EVALUATION_FILE)} --redo ${path.join(evaluation, FIDELITY_REPORT_FILE)}${adapterArguments === '' ? '' : ` ${adapterArguments}`} (say how many calls it will make before calling; redoing does not change the verification record in the pack, to update it issue a new version).`;
    lines.push('Fidelity (speaker similarity against the real-person baseline, plus blind listening; for how to read it see the header of lib/fidelity.mjs)', renderFidelityReport(fidelity, { redoHint }).trimEnd());
  }
  lines.push('', ...renderVerification(report));
  const card = describeCardLine(report.cardLine);
  if (card.length > 0) lines.push('', ...card);
  if (report.hints.length > 0) lines.push('', 'Material still missing:', ...report.hints.map((hint) => `  ${hint.message}`));
  lines.push('', 'Each segment:', ...renderSegments(report));
  if (evaluation !== null) lines.push('', `The evaluation set and the fidelity report were written to ${evaluation}`);
  if (share !== null) lines.push('', ...describeShare(share));
  return `${lines.join('\n')}\n`;
}

/** 分享文件写到哪、预览卡片上有什么：有适配器给的产品名和入口就写出来，没有就说没有、想要怎么办。 */
function describeShare(share) {
  const { card } = share;
  const entries = card === null ? [] : [card.productName === null ? null : `product ${card.productName}`, card.open === null ? null : 'open entry', card.make === null ? null : '"Make your own" entry'].filter((part) => part !== null);
  return [
    `Share file written to ${share.file} (${share.bytes} bytes, sha256 ${share.sha256})`,
    entries.length > 0
      ? `  On the preview card: ${entries.join(', ')} (given by the adapter that was plugged in)`
      : '  The preview card has no product name or entries (the adapter that was plugged in gave no previewCard); for entries, use the pack command of the core layer and give --product-name, --open-link, --make-link yourself',
    '  This step does not verify signatures: it only packs the pack that was just made into a share file; to check it before distributing, use the check command on this share file',
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
  if (parsed.positional.length > 1) return usageProblem(ctx, usage, `Only one material directory or material.json is expected, extra given: ${parsed.positional.slice(1).join(' ')}`);
  const hasRecordings = options.recording !== undefined || options.audition !== undefined;
  if (parsed.positional.length === 0 && options.previous === undefined && !hasRecordings) return usageProblem(ctx, usage, 'Give a material directory or material.json, or --recording <long recording> / --audition <audition of a default voice or a blended voice> (when issuing a new version that only changes the guidance or swaps references you can give none of them, but --previous is required)');
  if (options['no-separate'] === true && options.recording === undefined) return usageProblem(ctx, usage, '--no-separate only makes sense with --recording (--audition is never separated)');
  if (!dryRun && options.output === undefined) return usageProblem(ctx, usage, 'Give --output <new directory> (the pack is written there); to only see the plan, use --dry-run');
  if (options.name === undefined && options.previous === undefined) return usageProblem(ctx, usage, 'Give --name <name> (it may be omitted when issuing a new version)');
  if (options.bump !== undefined && !['patch', 'minor', 'major'].includes(options.bump)) return usageProblem(ctx, usage, `--bump must be one of patch, minor, major, got ${options.bump}`);
  if (options.version !== undefined && options.bump !== undefined) return usageProblem(ctx, usage, 'Give only one of --version and --bump');
  if (options['text-language'] !== undefined && !TEXT_LANGUAGES.includes(options['text-language'])) {
    return usageProblem(ctx, usage, `--text-language must be one of ${TEXT_LANGUAGES.join(', ')} (the language of the SKILL.md skeleton in the pack), got ${JSON.stringify(options['text-language'])}`);
  }
  for (const flag of ['version', 'bump', 'changelog', 'drop', 'retag']) {
    if (options[flag] !== undefined && options.previous === undefined) return usageProblem(ctx, usage, `--${flag} only makes sense when issuing a new version (--previous)`);
  }
  if (options.seed !== undefined && !Number.isInteger(options.seed)) return usageProblem(ctx, usage, `--seed must be an integer, got ${options.seed}`);
  if (options['max-error-rate'] !== undefined && options['max-error-rate'] < 0) return usageProblem(ctx, usage, `--max-error-rate must be a number not less than 0, got ${options['max-error-rate']}`);
  if (dryRun && options['save-evaluation'] !== undefined) return usageProblem(ctx, usage, '--dry-run does not make a pack or run the trial synthesis, so there is no evaluation set to save');
  if (dryRun && options['share-file'] !== undefined) return usageProblem(ctx, usage, '--dry-run does not make a pack, so there is no share file to build');
  const unsplit = (options.retag ?? []).find((value) => !value.includes('='));
  if (unsplit !== undefined) return usageProblem(ctx, usage, `--retag must be written as <segment name>=<tag> (one segment at a time), got ${JSON.stringify(unsplit)}`);

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
    throw new VoicePackError('make_pack_base_version_missing', 'The version of the base part used to make the pack is unknown: this base part has not been sealed (development tree), so state it with --base-version <x.y.z>', { details: { field: 'baseVersion' } });
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
    ...(options['card-line-language'] === undefined ? {} : { cardLineLanguage: options['card-line-language'] }),
    ...(options.expressiveness === undefined ? {} : { expressiveness: expressivenessOption(options.expressiveness) }),
    ...(options.setups === undefined ? {} : { setups: readJson(ctx, options.setups, 'setups') }),
    ...(options.lexicon === undefined ? {} : { files: new Map([[LEXICON_FILE, readBytes(ctx, options.lexicon)]]) }),
    ...(options.previous === undefined ? {} : { previous: loadFiles(path.resolve(ctx.cwd, options.previous), 'previous version') }),
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
  // 估金额：这个环境调得到的几项，和暂时出错最多再多调的几次（lib/make-pack-plan.mjs 的 calls、extraCalls）
  const moneyOf = (plan) => (billing === null ? null : moneySentence(adapters, plan.calls, plan.extraCalls));
  const environment = options.environment ?? environmentName(adapters);
  const minChars = minCharsOf(adapters); // 合成能力一次至少多少个字（环境声明的）：影响配音和试合成，见 lib/make-pack.mjs 的 minChars
  const maxChars = maxCharsOf(adapters); // 下面两项只交给配试听句的配音（lib/make-pack.mjs 的 maxChars、maxPauseInRequestMs）
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
    if (!ctx.json && candidate.recordings.length > 0) ctx.stderr('Duplicate check: comparing text and recordings (each recording is decoded whole and fingerprinted; anything that is not WAV is decoded with ffmpeg first)...\n');
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
    throw invalid(options.recording === undefined ? '--audition' : '--recording', `No segment was cut, so there is no material to make a pack from: ${notes.map((note) => note.message).join('; ')}`);
  }
  const recordingReports = cut.map((entry) => ({ kind: entry.recording.kind, idPrefix: entry.recording.idPrefix, ...entry.report }));

  const result = await makePack(env, { ...input, segments, ...(notes.length === 0 ? {} : { notes }) }, {
    ...(dryRun ? { dryRun: true } : {}),
    ...(options['no-evaluate'] === true ? { evaluate: false } : {}),
    ...(options['allow-cross-language'] === true ? { allowCrossLanguage: true } : {}),
    ...(options['no-language-marks'] === true ? { languageMarks: false } : {}),
    ...(options['no-loudness'] === true ? { loudness: false } : options['no-limiter'] === true ? { loudness: { limiter: false } } : {}),
    ...(options['no-holdout'] === true ? { holdoutRatio: 0 } : {}),
    ...(options.seed === undefined ? {} : { random: seededRandom(options.seed) }),
    ...(options['max-error-rate'] === undefined ? {} : { maxErrorRate: options['max-error-rate'] }),
    ...(options['text-language'] === undefined ? {} : { textLanguage: options['text-language'] }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(environment === null ? {} : { environment }),
    ...limits,
    onPlan: (plan, { notes: early = [] } = {}) => {
      if (ctx.json) return;
      for (const note of early) ctx.stderr(`Note: ${note.message}
`); // 花钱之前就说：录音的底噪（lib/recording-noise.mjs）
      const language = languageNote({ plan, segments, language: options.language });
      if (billing !== null) ctx.stderr(costNote({ billing, plan, saveEvaluation: evaluationDirectory !== null, language, cardLine: options['card-line'] !== undefined, money: moneyOf(plan), ffmpeg: ffmpegNote(env, { makePack: true }) }));
      else if (language !== null) ctx.stderr(`Note: ${language}\n`);
    },
  });

  if (dryRun) {
    const language = languageNote({ plan: result.plan, segments, language: options.language });
    const money = moneyOf(result.plan);
    const ffmpeg = ffmpegNote(env, { makePack: true });
    // 只写进文字输出：--json 的报告照旧（缺 ffmpeg 在报告里本来就有 runtime_missing，次数在 plan 里）
    if (!ctx.json) result.report.notes.push(...(money === null ? [] : [{ code: 'money_estimate', message: money, details: {} }]), ...(ffmpeg === null ? [] : [{ code: 'ffmpeg_missing', message: ffmpeg, details: {} }]));
    ctx.stdout(ctx.json ? `${JSON.stringify({ plan: result.plan, ...(cut.length === 0 ? {} : { recordings: recordingReports }), ...(duplicateCheck === null ? {} : { duplicateCheck }), report: result.report }, null, 2)}\n` : `Plan: no pack is made and no required capability is called\n${renderPlan(result.plan, result.report, cut, duplicateCheck, language, options['card-line'] !== undefined).join('\n')}\n`);
    return 0;
  }

  writeDirectory(output, result.pack.files);
  if (!ctx.json && path.basename(output) !== result.pack.id) result.report.notes.push({ code: 'directory_name_differs', details: { directory: path.basename(output), id: result.pack.id }, message: `The directory name ${path.basename(output)} differs from the pack ID ${result.pack.id}: this pack is meant to be handed over and passed on to others, so rename the directory to the pack ID (${path.join(path.dirname(output), result.pack.id)})` });
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
    if (evaluationDirectory !== null && evaluation === null) ctx.stderr('Note: there is no evaluation set to save (no recording was trial-synthesized), so the --save-evaluation directory was not written.\n');
  }
  if (shareError !== null) {
    if (!ctx.json) ctx.stderr(`The pack was written to ${output}, but the share file was not built:\n`);
    throw shareError;
  }
  return 0;
}
