// SPDX-License-Identifier: Apache-2.0
//
// 用音色包给一段台本配音（流程层）。
//   @capability voice-cloning       按挑中的参考合成每一句（签名在 vocab/capability-signatures.md）
//   @capability scene-in-request    可选：环境声明有它，并且有 text-to-dialogue，台本里几个说话人轮流说的一段连续的话，才按一场戏一个请求配（text-to-dialogue，第 5a 步，规则在 lib/scene-in-request.mjs）；
//                                   没有声明，一个声音一个声音地配（第 5c 步），和没有这一项时一字不差；调用方给了 options.scene: false（明说分开），一行一个请求（第 5c 步；第 5b 步按 minChars 并的短行例外）
//   @capability text-to-dialogue    可选：一场戏一个请求（第 5a、7 步），要和 scene-in-request 一起有；只有它、没声明 scene-in-request，配音不用它
//   @capability seed-in-request     可选：环境声明有它，每个合成请求（voice-cloning、text-to-dialogue）给同一个固定的 seed（DUB_SEED，第 7 步）；没有声明就不给
//   @capability speaker-verification 可选：环境有它，每一段合成出来以后量一次和所用参考的说话人相似度，写进报告（第 9 步）；没有就不量，报告写明没量
//   @capability phoneme-markers     可选：环境声明有它，读音词表的音素（拼音、Arpabet、日文罗马字）写成音素标签，换掉原来的词（第 4 步）
//   @capability phoneme-in-text     可选：环境只声明了它（没有 phoneme-markers），读音词表的拼音发送前写成 SSML（第 4、7 步）
//
// 「怎么说」只有一条路：台本里的提示。方括号里写给模型的话（[sad and surprised]、[小声]、[laughs]，台本标记以外的方括号，见 tools/markup.mjs 的文件头「提示」）
// 原样留在它所在的位置，随文字交给模型；舞台说明（（耳语）、*笑*）换成同样意思的提示，留在原位（第 2 步）。调用方和设定给的情绪、风格、能量，也合成一条提示，
// 写在每个请求的开头（第 7a 步）。dub 不另外交情绪、风格的名字（cues）：都在文字里。说明（instructions，例如口音）不发给模型，也不写进文字：
// 设定的说明是给写台本的人看的，规划的 notes 里列出来（setup_instructions，第 7a 步）。配音指引的演法不交给模型，由 agent 照它写成提示，写进台本里说法变化的地方。
//
//   const plan   = await planDub(env, pack, script, options);   只规划，不合成：每一段话用哪一段参考、为什么、读音词表换了什么。不花钱：一次能力都不调
//   const result = await dubScript(env, pack, script, options); 规划，再合成
// pack 是 lib/voice-pack.mjs 的 openVoicePack 打开的角色部分，或者几个（数组，第一个是台本开头，即第一个 [voice:] 之前用的声音；见第 1 步）。
// 库不碰文件系统：合成出来的音频是字节，写成文件是命令行层的事。
// 几个包：每一句用它那一刻的包（挑参考、读音词表、增强件、脚本都照那个包的）；短句并段只在同一个包里并（第 5b 步）；
//   每个 unit 记着包 ID（unit.pack），plan.packs 列出几个包。只给一个包时，这两样都不出现，输出和以前一字不差。
//
// 设定（清单的 setups，protocol/FORMAT.md 4.4）：作者写进包里的几套固定值 { name, labels?, speed?, instructions?, referenceTag?, expressiveness?, default? }。这一次用哪一套：options.setup 点名，不点名就用 default 那一套，都没有就不用设定；
//   每个包在自己的设定里选。几个包时，options.setup 可以是一张表 { 包: 名字 }，每个包点各自的（键认包的写法同 [voice:]：包名或包 ID，不分大小写），表里没列的包用它自己的默认。
//   options.setup 是 false：哪个包都不用设定（做包的试合成用：量的是声音本身，连同它的默认参考）。设定在配音里管这几样，每一项都是调用方给了的盖过设定的：
//   语言：调用方没给的，用设定的 labels.language 挑参考（第 3 步）。
//   默认参考（referenceTag，一个音色基底标签）：调用方没给这个包指定标签（options.referenceTag）时，用这个标签的段（第 3 步）。只是默认，不绑死：调用方指定的盖过它。
//   情绪、风格、能量（labels.emotion、labels.style、labels.energy）：合成一条提示，写在每个请求的开头（第 7a 步）。每一项分别取：调用方给的
//     （项的 labels，没有就是 options 的），没有再取设定的。情绪、风格另外照旧交给包里脚本的钩子（moodOf）。都不挑参考。
//   说明（instructions，例如口音）：不发给模型，不合进开头的提示。设定的说明是给写台本的人看的，用了带说明的设定，规划的 notes 里有一条 setup_instructions（第 7a 步）；
//     调用方不能再给说明（options.instructions、项的 instructions）：给了报 dub_input_invalid。
//   语速（speed）：调用方给的（项的 speed，没有就是 options.speed），没有就用设定的，记在 unit.speed，合成以后变速（第 7b 步）：合成能力不收语速，
//     台本里写的放慢、加快（<slow>…</slow>、[slow]、（慢慢地））是提示或尖括号标签，随文字交给模型，不改 unit.speed。
//   起伏（expressiveness，0 到 100 的整数，写法见 vocab/capability-signatures.md）：设定固定的是这套设定的起伏，全局值（清单顶层的 expressiveness）是整个声音的。每一行按这个先后取，取到就停：
//     项自己的 expressiveness（.json 台本）→ options.expressiveness（命令行 --expressiveness）→ 这一行用的设定的 expressiveness → 这个声音的全局值（清单顶层的 expressiveness）→ 都没有就不传（第 7 步）。
//     options.setup 是 false（--no-setup）的不取设定的，全局值照取（它不是设定）。取到的记在 unit.expressiveness，哪一层给的记在 unit.expressivenessFrom（item、option、setup、global；并进同一个请求的几行来自不同的层是 mixed）；值不同的行不并进同一个请求（第 7 步）。
//   报告：plan.pack（几个包时 plan.packs 的每一项）有设定时多 setups（包里有哪几套的名字）
//   和 setup: { name, by, expressiveness? }（这一次用了哪一套，by 是 'option' 或 'default'；没用设定就没有 setup；这套设定写了 expressiveness 才有这一项，
//   写台本的人看得到这个声音固定的值）。设定和全局值都没写的包，请求和报告都和以前一字不差。
//
// 台本（script）：一个字符串（带台本标记的整段台本），或者一个数组，每项是
//   { text, labels?, speed?, expressiveness?, targetDurationMs? }
//     text 是带标记的台本；labels 是调用方给这一项的标签 { language, emotion, style, energy }；
//     speed 是这一项的语速（正数，1 不变，0.85 放慢）：都见上面「设定」，盖过设定的同一项；
//     expressiveness 是这一项的起伏（0 到 100 的整数）：盖过 options 的，也盖过设定的（上面「设定」，第 7 步）；
//     targetDurationMs 是这一项配出来要多少毫秒（正整数，对画面的一句用，第 8 步）。
// options：labels（给所有项的默认标签，项自己的盖过它）、speed（给所有项的语速，项自己的盖过它；见上面「设定」）、expressiveness（给所有项的起伏，0 到 100 的整数，项自己的盖过它，它盖过设定的；见上面「设定」）、concurrency（并发数，默认 2，1–8）、maxChars（一个请求最多发出去多少个字，
//   连请求开头的提示一起算，环境声明的或调用方给的；默认不限）、maxSpokenChars（一个请求最多多少个要念的字，数法是 lib/synthesis-limits.mjs 的 spokenLength；
//   不给是那里的 DEFAULT_MAX_SPOKEN_CHARS（1000），null 是不按要念的字切；调用方自己给了上限、不要这个默认的，给 null；两个上限都要满足，放不下时在边界切开，第 5、5a、5c 步）、
//   minChars（合成能力一次至少多少个字，环境声明的；默认没有下限，见第 5b 步）、
//   setup（用音色包里的哪一套设定：清单 setups 里的 name；不给就用带 default 的那一套，没有就不用设定；对不上报 setup_unknown，每个包在自己的 setups 里找。
//   给字符串是每个包都按这个名字找；给一张表 { 包名或包 ID: 名字 } 是每个包点各自的，表里没列的包用它自己的默认；给 false 是哪个包都不用设定；见上面的「设定」）、
//   referenceTag（调用方指定的音色基底标签，第 3 步的第 1 层：用户换过的、agent 按标签挑的都从这里进来，盖过设定的默认参考。给字符串是每个包都用它，每个包都要有这个标签；
//   给一张表 { 包名或包 ID: 标签 } 是只给点到的包，表里没列的包走设定、默认段；认包的写法同 options.setup 的表。标签哪个包里没有，报 reference_tag_unknown）、
//   maxPauseInRequestMs（一个请求里一处停顿最多多少毫秒，环境声明的，不小于 0 的整数；不给就用 lib/pause-in-request.mjs 的默认值；长过它的停顿在那里切开，见第 5a、5c 步。
//   旧的 maxPauseInTextMs 给了报 dub_input_invalid）、joinShort（默认 true；
//   false 就不并短句，只按下限认：试合成用，每条留出录音一段）、only（只合成这几段，编号是规划里的 units[i].index，别的标成 skipped，规划里也标；失败后重做用）、
//   reuse（沿用上一次做好的：见下面「沿用」）、
//   previousSeed（函数：previousSeed(unit) 返回 only 点到的这一段上一次配它用的 seed（做成的那一次，或者换了 seed 重配、没成的那一次；哪些算由调用方定，命令行的在 cli/commands/dub.mjs
//   文件头「--only 换 seed」，做包配试听句的在 lib/make-pack-card-line.mjs 的 voiceCardLine），没有是 null；环境收 seed 时这一段的 seed 换成它加 1，见第 7 步「seed」）、
//   runtimesOf（几个包时，每个包的脚本运行时：runtimesOf(pack) 返回这个包的 { 运行时名字: 函数 }；命令行层给每个包目录各建一份（cli/script-runtimes.mjs）；
//   不给就用 env.runtimes。脚本在它自己的包目录里运行，所以要分开）、
//   scene（默认 true；false 是明说分开：不按一场戏一个请求，即使环境声明了 scene-in-request，而且一行一个请求，同一个声音接着说的几行也不并（第 5a、5c 步）：
//   要每一行各自的音频、要 only 重做到一行、要按行对时间时用；同一行里的几句照旧并成一个请求；环境声明了 minChars 时，比它短的一行照旧并到下一行（第 5b 步），那两行是一个请求、一个文件）、
//   maxSpeakers（一场戏最多几个说话人，环境声明的；不给就不限，一场里的人数超过它就在那之前切开，第 5a 步）、
//   allowCrossLanguage（默认 false；true 是参考段不是这一段台词的语言也照配，跨语言克隆，带参考那种语言的口音。不给就在花钱之前停下，报 dub_cross_language，规划也报，见第 3a 步。
//   不是 true、false 报 dub_input_invalid）、
//   languageMarks（默认 true；false 是跨语言的行不要求开头写名字对、不加两边的语言提示，台本怎么写就怎么发，见第 7c 步。不是 true、false 报 dub_input_invalid）、
//   targetDurationMs（每一项配出来要多少毫秒，正整数；项自己的 targetDurationMs 盖过它；不给就不变速，见第 8 步）、
//   minSimilarity（说话人相似度的阈值，有限的数：低于它的段标出来；不给就只报数、不标，见第 9 步）、
//   onUnit（每一段做完，立刻交给它；见下）、
//   onPlan（花钱之前交给它：规划做好了，花钱之前该核对的都核对过了，一次计费的调用都还没发生。第一个参数是这份规划；
//   第二个参数 { calls: { count } } 是这次要合成几次（正好 count 次）。命令行用它说明费用，抛错就什么都不做）。
//   交给 onPlan 的这份规划就是最后返回的那一个对象，每一段的结果写在它的 units 上。
//
// 沿用（options.reuse，函数）：花钱之前（onPlan 之前），每一段要合成的（only 点到的除外：点到的一律合成）和 only 没点到的（skipped），交给 reuse(unit) 问一次。
//   规划（planDub）也问，也照 only 标 skipped（settleUnits）：规划里 status 是 planned 的，就是正式运行要合成的。
//   它返回一个对象，这一段就不合成：对象的字段并进这一段，status 是 'ok'，carriedOver 是 true（一场戏的「量不了」按并进来的 scene 重写）；返回 null 照常。
//   哪一段算「上一次做好的、一模一样的请求」由调用方定（命令行的规则在 cli/commands/dub.mjs 的文件头「沿用」），库只照它的回答做。
//   有沿用的，notes 里有一条 carried_over（见下面「说明」）。
//
// 一句话是怎么变成合成的（顺序就是这样）：
//   1 解析台本标记（tools/markup.mjs）：章节、停顿、[voice:]，只有这三种；别的方括号是提示，原样留在文字里。[voice:名字] 对上台本给的几个包中的一个（包名或包 ID，不分大小写）：
//     对不上报 voice_unknown，对上不止一个包报 voice_ambiguous。第一个 [voice:] 之前（或者 [voice:] 是空的）用第一个包。
//     只有一个包时，别的名字报 voice_unknown：一个包只有一个声音，换声音的台本需要别的包，不悄悄用这个包去念。
//   2 读舞台说明（lib/line-hints.mjs 的 cuesInPlace，规则只在那里写）：（耳语）、*笑* 换成同样意思的提示 [耳语]、[笑]，留在原来的位置，括号里的字不念；
//     读成停顿的（（停顿 2 秒）、（沉默））照旧是停顿。括号里词表认不出的内容（（画外音））一样换成提示，如实记在这一段的 pick.directions 里（recognized 为 false），
//     notes 里另有一条 unrecognized_directions 列出这几处（原文括号里要念的正文也这样不念了，见下面「说明」）。
//     括号里的字原样搬进方括号，所以长的舞台说明就是长的提示：台本里一处提示（方括号写的、舞台说明换成的）超过 lib/cue-length.mjs 的 MAX_CUE_WORDS 个词，
//     notes 里有一条 long_cues 列出来。只提醒，不改字，不报错。
//     只有提示、没有要念的字的一段（一行只写了（生气），或者 [pause …] 后面只剩 [笑]）：接到同一个声音、同一章、同一项的下一段开头；后面没有这样的一段，就接在前一段的末尾，
//     还没有就丢掉（没有人念它）。它的停顿算在接上的那一段前面（接在末尾时，算在那一段后面）。
//   3 每一段话（台本里的一行）挑一次参考（lib/reference-pick.mjs，规则只在那个文件头写；一行一次是 paragraphPicks）：按这个顺序取：调用方给这个包指定的音色基底标签（options.referenceTag）→ 这个包选中的那套设定的 referenceTag
//     → 这一段的语言的默认段（包里每种语言各有一段，包里没有这种语言就用主语言的默认段）。定了标签，在这一段的语言里找这个标签的段，没有就跨语言用主语言的、再没有用排在最前的。
//     dub 自己不按标签挑，不按情绪、风格、能量挑，也不让模型判情绪：按标签挑是 agent 的事，挑好了从 options.referenceTag 交进来。认语种读的是去掉提示以后要念的字（作者写的方括号提示不算）。
//     一行里被停顿、提示隔开的几块按整行的字认语种，用同一段参考：一行中文里的一句英文跟着用中文的那段，这一块的 pick.crossLanguage 是 true（pick.language 是这一块自己的语言）；
//     包里有英文、这一块自己挑会用英文的段的，另有 pick.followsLine: true（跟着这一行，不是包里没有这种语言）。
//     指定的标签包里没有：规划时就报 reference_tag_unknown（--dry-run 也报），一次能力都不调。
//     用的是哪一段、它的标签、为什么、是不是跨语言，放在 units[i].pick 里：{ segmentId, tag, by, crossLanguage, followsLine?, language, directions }，by 是 'reference-tag'、'setup'、'default' 之一。
//     换标签的单位是一次 dub 里的一个包：台本中途要换，拆成几次 dub，再用 mix 按次序接起来（cli/commands/mix.mjs）。
//   3a 默认不带口音：用一种语言的参考念另一种语言，配出来常带参考那种语言的口音（日语的参考念英文，常是带日语口音的英文；models/scene3.md「Cross-language and accent」）。
//     所以没给 options.allowCrossLanguage: true 时，这一次要合成的段（规划里 status 是 planned 的）里有一行用的参考段不是这一行的语言，就停下：报 dub_cross_language，
//     一次能力都不调、不花钱；规划（planDub）也报，所以 --dry-run 看得到。查在 only、沿用（settleUnits）之后：only 没点到的、沿用上一次的段这一次不合成，不算。
//     比的是整行的语言（第 3 步按整行认的那个）和这一行用的参考段（比法同 lib/reference-pick.mjs 的 speaksLanguage）：
//     一行一个请求的段看它的每一行（并进来的几行都看）；一场戏一个请求的段看每个说话人整场用的那一段（scene.speakers[i].pick）和他每一轮的那一行。
//     不停的：一行里夹着别的语言的几个字（一行中文里的一句英文：整行是中文，用中文的参考，pick.followsLine，或者包里没有英文），这是混着说，不是一整行换了语言；
//     整行的语言看主要的文字（lib/line-hints.mjs 的 detectLanguages）：一行中文里一个片假名的名字、一行英文里一句ありがとう，整行还是中文、英文；
//     看不出语言的一行（只有数字、标点）。
//     给了语言的（调用方的 labels.language、设定的）一行，文字看得出不是这种语言的（英文台词给了 ja），不信给的，按文字认的比（lib/cross-language.mjs 的 languageOfText）：
//     设定写死了一种语言、调用方为了把混着语言的一段留在一个请求里给了语言，另一种语言的整行照样停。文字看不出的（只有数字、标点），同一种文字的几种语言（英语、法语），照给的比。
//     说「台词的语言」的写法（lib/cross-language.mjs 的 lineTarget）：给了的（调用方的 labels.language、设定的）照写；从文字认的（连上面不信给的），只可能是一种语言的文字（假名、谚文……）写那种语言，
//     别的（拉丁字母、汉字……）不猜，写是什么文字。
//     停下来的错说哪几段（第 N 段，同 only 的编号加 1）、哪个包、哪段参考、参考段的语言→台词的语言（ja→en；不猜的是 ja→拉丁字母），再说怎么办：不问使用者，
//     行开头写名字对（第 7c 步）、加 allowCrossLanguage: true 再配；使用者自己要补参考的，给包补一段这种语言的参考，make-pack --previous 发新版本。补的参考从哪来（lib/cross-language.mjs 的 referenceSources）：
//     有这个角色说这种语言的录音就用录音；没有的，默认用这个包跨语言配一段这种语言的话当参考；或者使用者在库里挑的一个说这种语言的声音；平台能指定模型的，另列一项先用别的模型念一遍再克隆。
//     包里其实有这种语言的段的，另说怎么用上它：给了语言、文字不是这种语言的，不给语言（设定写的，给 --language 盖过它，或者换一套设定、不用设定 --no-setup）；
//     定了标签的，是这种语言里没有这个标签，换一个这种语言里有的、或者不指定（标签是设定的默认参考的，用 --reference-tag 盖过它，或者换一套设定、不用设定 --no-setup）；
//     合并的一场里一个说话人整场只用一段参考的，分开配（scene: false），每一行各用各的语言的参考。
//     给了 allowCrossLanguage 就照第 3 步配：用的段照旧，pick.crossLanguage 照旧标着。
//   4 读音词表（包里的 lexicon.pls，lib/pronunciation-lexicon.mjs）：换掉要说的话里的词，只换标记、提示和尖括号标签以外的文字，方括号里面、标签名、音素标记都不动。做不到的如实报在 lexicon.unapplied。
//     音素（词表的 <phoneme>）看环境的声明：
//     声明了 phoneme-markers：拼音（x-pinyin）、Arpabet（x-arpabet）、日文罗马字（x-romaji）写成音素标签 <|phoneme_start|>…<|phoneme_end|>，换掉原来的词（拼音一个音节一个标签，Arpabet、罗马字一个词条一个标签），
//       和别名在同一次替换里（长的词条优先，别名换出来的字不再标），就在这一步，所以 spoken、一场戏每一轮的文字里就是标签，切开（第 5 步）看得见它，不从中间切开一个标签。
//       认语种、挑参考（第 3、3a 步）在这一步之前，看的是套用词表之前的原文（lines[i].words：去掉提示以后要念的字），不看换出来的标签和别名。
//       用上的记在 lexicon.phonemes，从 unapplied 去掉；unit 上没有 phonemes。规则在 lib/pronunciation-lexicon.mjs 的「音素标签」一节。
//     只声明了 phoneme-in-text：拼音句子里用上的记在 unit.phonemes 和 lexicon.phonemes，从 unapplied 去掉，发送前写成 SSML（第 7 步）；一场戏不写。
//       这一种的例外：用上了拼音音素的句子，发送前整句转成 <speak>（第 7 步的 applyPhonemes），句子里的尖括号标签也跟着转义，到不了模型。
//     都没声明的，照旧报在 unapplied（reason 是 phoneme，和没有这一项时一样）；环境收这种字母表、音节数等对不上的，reason 是 phoneme_format。
//     只写一个字的词条（汉字这类按子串找的字）这次用上了：说明里有一条 lexicon_single_character（见下面「说明」），照样换，不拦。
//   5 一行自己就放不下一个请求的（两个上限：maxSpokenChars、maxChars，见上面 options），在这一行里按句子切成几段（请求开头要加提示的，给它留出位置，第 7a 步；一句还放不下的，在逗号一类的地方，
//     还放不下 maxChars 的才在字与字之间硬切），同一句的几段共用同一段参考。只有 maxSpokenChars（软上限）放不下的不硬切：没有逗号一类的地方可切，就照原样留着，可以比它长，不在一个词中间切开。
//     切出来只有标点、没有字母和数字的一截，并进前一截（不发只有一个句号的请求）。
//     提示不切开，一对尖括号标签连同它包住的字、一个音素标记也不切开（tools/markup.mjs 的 TAG_BLOCK_PATTERN；切口落在里面的挪到它的末尾，连紧跟着的标点）；
//     一对标签连同包住的字自己就放不下的，在里面照常切，每一段两头补上这一对标签（<soft>甲。乙。</soft> 切成 <soft>甲。</soft> 和 <soft>乙。</soft>）。
//     所以一段可能比上限多出几个提示、标签的字（和上面并进前一截的几个标点）。分句时隔着标签看（tools/sentences.mjs）。
//     切出来只有提示、没有字的一截，接到下一截的开头（是最后一截就接在前一截末尾）。
//     切出来的几段在第 5c 步还会并回去：放得下的几句照旧一个请求，这一步只是给一行里面留出句子的边界。
//   5a 一场戏一个请求：环境声明了 text-to-dialogue 和 scene-in-request（options.scene 不是 false，给了几个包）时，几个说话人轮流说的一段连续的话放进一个 text-to-dialogue 请求，成为一个 unit。
//     哪几段连成一场、一个说话人整场用哪一段参考：规则只写在 lib/scene-in-request.mjs 的文件头，这里不重复。每一行是一轮（同一行被第 5 步切开的、被短停顿切开的几段并成同一轮）；
//     一场里不超过 maxPauseInRequestMs 的停顿留在请求里，写法和第 5c 步一样（lib/pause-in-request.mjs 的 pauseWriting，写法是空串的什么都不加）：同一轮里接在前一段后面，轮与轮之间写在前一轮的末尾；
//     只写着停顿的一行、读成停顿的舞台说明也一样。长过它的在那里切开，停顿留给拼接，插多长就是多长。这个 unit 的 pauseBeforeMs、pauseAfterMs 只有这一场头尾的，留在请求里的拼接不再插。
//     一场放不进一个请求（同样两个上限，要念的字是各轮加起来，发出去的字连每一轮开头的提示、轮与轮之间的换行，写进去的停顿也算），在行与行之间切成几场（规则也在那个文件头），
//     切口后面是一场的，那一场的 unit.cutBefore 是 'paragraph'，注意 cut_to_fit 也列着；前后不再一起演。切开的几场里，一个说话人用的参考段按切开以前的那一整场取，几场一样（规则也在那个文件头）。
//     切口两边是同一个人接着说的（前一块最后一个说话人就是后一块第一个），后一块的 pauseBeforeMs 记 CUT_PAUSE_MS、cutPause 是 'paragraph'（和第 5c 步「切口的气口」一样）；
//     换了人的切口不加，交给拼接的换人规则（lib/mix.mjs 规则 7）。每一轮的提示就在这一轮的文字里（第 2 步），不另外交给环境（unit.scene.turns 记着每一轮的说话人和文字）。
//     场景的 unit：pack 是第一个说话人的包，lastSpeakerPack 是最后一个说话人的包（mix 在换人处看它们），joined 列着成员行，scene.speakers 是每个说话人整场用的参考段：{ speaker, pack, pick: { segmentId, tag, by, crossLanguage } }（见 sceneUnit），这一场的 unit 自己没有 pick；
//     scene.turns 是每一轮 { speaker, line, text（发出去的文字，写进去的停顿在里面；设定的开头提示不在里面，记在 openingCue，发的时候加在这一轮最前面）, picked（这一行自己取到的段）, directions（这一行的舞台说明）, openingCue? }；
//     spoken 是各轮的话用换行连起来。一个请求只有一个音频，所以场景里每一行没有各自的音频。场景的 unit 不进 5b、5c，也不跑包里的脚本。没声明的环境，这一步什么都不做。
//   5c 放得下就一个请求：同一章、同一个声音里的几行（非空的一行是一段话），连一行里被停顿（[pause …]、舞台说明里的停顿）隔开的几段，并成一次请求，用同一段参考；
//     调用方给了 scene: false（明说分开）的，行和行不并：一行一个请求（一行里的几段照旧并；第 5b 步已经并成一段的短行照旧是一段）；
//     行和行之间换行，同一行里的几句照旧接着；后面没写提示的句子在同一个请求里，接着前面的说法。
//     中间的停顿不超过 maxPauseInRequestMs 的写在文字里（量过的写法，规则在 lib/pause-in-request.mjs；只写着停顿的一行也一样）；长过它的在那里切开，停顿留给拼接，插多长就是多长。
//     切开的后一个请求只重复这一行开头的第一个方括号（第 7c 步），不重复别的提示：要接着那样说，在停顿后面再写一次提示（references/dub.md「One request per passage」）。
//     除了长停顿，总是切的几处：章节、换了声音（[voice:] 写的名字变了）、换了参考段、换了语速、换了开头的提示（第 7a 步）、包里有配音脚本；
//     还有换行的地方，这一行要加设定的提示（第 7a 步）、前面要并进的那个请求里已经有台本自己写的提示（请求开头的，或者哪一行行首、句中写的）；规则写在 joinIntoRequests 上。
//     「前面要并进的那个请求」按上限切开之前的那一串算（joinIntoRequests 看的是这一串，不是 requestsOf 切完以后的那一块）：一行的台本提示被上限切进前一个请求时，
//     后一个请求从头到尾是设定的提示，下一行也不并进去，偶尔多一个切点；设定的提示不会丢。
//     并起来的一块，开头的提示按它的第一段算（第 7a 步），中间不再加。并起来的那一段，plan 里的 pick.directions 列着每个成员的舞台说明。
//     放不下一个请求（两个上限都要满足：要念的字不超过 maxSpokenChars；发出去的字连开头的提示不超过 maxChars）才在边界切，规则在 lib/pause-in-request.mjs 的 requestsOf：先在场景的边界（两行之间有整行只有停顿的一行；写在行尾、行首的停顿照段落算），
//     再在段落的边界（行和行之间），一行自己放不下才在它的句子之间（第 5 步切开的几段）；切出来的一块还放不下，只在它里面往下一级切，不和前后的块并。两个上限都没有（maxSpokenChars 给了 null，maxChars 没给）就不因为长度切。
//     因为放不下切开的，后一块的 unit.cutBefore 写着切在哪种边界（'scene'、'paragraph'、'sentence'），注意 cut_to_fit 列出这几处（见下面「说明」）。
//     切口的气口：dub 自己切开、台本在切口没写停顿（前一块的 pauseAfterMs 和后一块的 pauseBeforeMs 都是 0）的，后一块的 pauseBeforeMs 记 CUT_PAUSE_MS（540 毫秒，
//     出处在它上面），unit.cutPause 是 'paragraph'（行与行之间）或 'sentence'（一行里面、句子之间），拼接照它插静音。不管为什么切：放不下（cutBefore）、换了参考段（换了语言，
//     cutBefore 是 'language'）、开头的提示不同（含上面「这一行要加设定的提示」那一条）、语速不同、包里有配音脚本，都加；规则写在 joinIntoRequests 上。
//     不加的：台本写了停顿的照台本（'scene' 的切口本来就有那一行的停顿）；切口在一句话中间的（第 5 步一句放不下、在逗号一类的地方或者硬切开的，cutBefore 照旧是 'sentence'）：
//     一句话中间不停；调用方明说分开（scene: false）时行与行之间：一行一个请求是调用方要的，行与行之间照台本的停顿，不另加；章节、换声音（台本写的边界）、一场戏的前后
//     （例外：dub 把一场切成几场、切口两边是同一个人的，第 5a 步加）。
//     只因为换了参考段切开的（一行一段参考，所以是行与行之间换了语言、包里有那种语言的默认段），后一块的 unit.cutBefore 是 'language'，注意 language_cut 列出这几处。
//   5b 有下限（minChars，环境声明的；没有就跳过这一步）：一段的字数不到下限，就和后面的一段并成一段（joinShort 为 true 时），直到够下限或者没有可并的。
//     并段的规则和 app 的 fitMinLength 一样：同一个声音（台本里的声音都是这个包，voice_unknown 保证），
//     中间没有停顿（前一段没有停顿要求，后一段前面也没有），语速一样、起伏一样（一个请求只带一个起伏，第 7 步）；这里还多一条：参考段一样（同一个声音说这句的参考，见第 3 步）；
//     并起来放得进一个请求（同第 5c 步的两个上限；发出去的字连这个请求开头要加的提示一起算，第 7a 步）；开头的提示一样（第 7a 步，不一样的并了，后一段的那条就丢了）。各段的提示跟着各自的字，并起来照样在原位。
//     这一步不看 scene: false，也不看第 5c 步「前面有台本写的提示、这一行要加设定的提示就不并」那一条：挡了，短的那一行就合成不了（text_too_short）。
//     所以短的一行并过来以后，下一行不另加设定的提示（开头的提示按并起来的第一句算），scene: false 时这两行也是一个请求、一个文件。
//     并起来的那一段记成 joined（{ line, part } 的列表，写明并了哪几句）。比下限的字数按念出来的字数（lib/synthesis-limits.mjs 的 spokenLength）：方括号的提示、标签的名字都不算，开头的提示也不算（下限管念出来的字够不够，提示不念，第 7a 步）。
//     这一步并完还短的，不在这里判：第 5c 步还会把它和隔着短停顿的后一段并进同一个请求（这一步只并中间没有停顿的）。第 5c 步之后，按并好的请求的文字（unit.spoken，
//     并进请求的停顿的写法也算发出去的字）还不到下限的那一段，记成 failed（unit.error 是 { code: 'text_too_short', message: '比合成能力的下限短…', details: { chars, min } }），
//     不调用能力，不是暂时出错，所以不标 transient：别的段照常做。joinShort 为 false 的不并，在这一步就按下限判，比下限短的记成 failed，第 5c 步也就不并它们（试合成：每条留出录音一段）。
//     下限是 1 或者没有，这一步什么都不做；没有下限的，第 5c 步之后也不判，发出去的和没有这一步时一字不差。
//   6 脚本（lib/pack-script.mjs）：登记在 dub 功能名下的脚本，合成之前跑 text 钩子（可以改要说的话），合成之后跑 audio 钩子（可以换音频）。
//     清单里没写 feature 的脚本不属于任何功能，不运行；规划和正式运行的 notes 里都有一条 scripts_without_feature 点名它们（字段见下面「说明」），
//     说明这次没有运行和原因。
//   7 合成：场景的 unit 调 text-to-dialogue，参数 { turns: [{ speaker, text }], speakers: [{ ref_audio, ref_text }] }（没有 text；
//      每个说话人的参考段在 unit.scene.speakers，第 N 项是说话人 N），一个请求一个音频；平台说一场装不下就不重发（scene_too_long）。别的 unit 照下面，调 voice-cloning，
//      参数 { text, ref_audio, ref_text, enhancers? }。
//      seed（两种调用一样）：环境声明了 seed-in-request，每个请求都加 seed: DUB_SEED（固定值，不随台本、不随这一次变：切开的几块用的是同一个），记在 unit.seed，
//      plan.capabilities 里有 'seed-in-request': true；没声明就没有这个键，和以前一字不差。
//      例外是 only 点到的段（「这一段换一条再配」）：同一个 seed、同样的请求，测过出同一条（试听页 19、20、23 核过逐样本一样），也测到过出两条不一样的（models/scene3.md「Sampling: `seed`」），要换一条就换 seed：调用方给了 previousSeed、
//      它说这一段上一次配的时候用的是 S，这一次的 seed 就是 S + 1（S 到了 seed 的上限 2^53−1 就是 0），unit.seedChange 记着 { from: S }（这一段这一次没做成，失败的记录里也记着 seed 和 seedChange，
//      下一次照它接着加）。previousSeed 返回 null（这一段从没做成过）的照旧用 DUB_SEED。
//      不是自动重试：只有调用方点名重配（only）才换；没点到的、沿用的都不动。规划（planDub）一样算（settleUnits）。
//      expressiveness（起伏，两种调用一样）：这一行取到了值（先后见上面「设定」：项自己的、options 的、这一行用的设定的、这个声音的全局值），就传给这些行的每个合成请求，记在 unit.expressiveness；
//      都没有就不传：请求里没有这个键，dub.json 里也没有，和以前一字不差，dub 不自己填一个（不按场景、不按情绪）。环境收不收、怎么用，是环境的事（vocab/capability-signatures.md），怎么取值、模型的读数在模型说明里（models/ 的「起伏」）。
//      一个请求只带一个值：值不同的行不并进同一个请求（第 5a 步一场戏看它，规则在 lib/scene-in-request.mjs；第 5b 步短句并段也看它；第 5c 步同一个包同一章里的行值一样：一项自己是一章，一个包只用一套设定）。
//      重跑时换了值（设定的也算，换了新版本的包），是新的请求，不沿用（cli/commands/dub.mjs 文件头「沿用」）。
//      ref_text（两种调用一样）：参考段有提示标注（清单里的 annotatedText，逐字稿加上方括号提示的整句）就交它，模型就知道这段参考是怎么说的；没有就交逐字稿 text（lib/reference-pick.mjs 的 refTextOf）。
//        同语言、台词开头是这个包的名字的，开头再写这个名字（第 7c 步）。
//      text：unit.spoken（提示都在原位，并进请求的停顿写成了量过的写法，第 5c 步）；前面加开头的提示（第 7a 步）；
//      只声明了 phoneme-in-text 的，用上的拼音音素在这里换成 <phoneme> 标签（applyPhonemes，<speak> 包着，提示里面不换；整句转义，句子里的尖括号标签也转义了，见第 4 步）。
//      声明了 phoneme-markers 的，音素标签第 4 步已经在 spoken 里，这里不再换。
//      拼接的人怎么处理 unit 的停顿、并起来的段：写在 references/dub-details.md 的「Stitching details」，这里不重复。
//      enhancers：包里服务 voice-cloning 的增强件，以 { id, model, modelVersion, referenceVersion, capability, load } 递给能力，load() 才读文件。
//      环境认识对应的模型就用上，并在返回里用 enhancers_used 报出用了哪几个（id）；不认识的会忽略 enhancers，照常生成。
//      这一次有没有用上增强件，写在 enhancers 里：一个都没用上、而包里有，statement 是 'enhancers_not_used'，附上没用上的增强件是哪个模型的，
//      和包的验证记录（verification），让人知道当前环境下效果会差多少。
//   7a 请求开头的提示（设定，见上面「设定」）：每个请求的文字前面加一条提示，是调用方和设定给的情绪、风格、能量合成的（怎么合、怎么写进文字，规则在 lib/opening-cue.mjs 的文件头：
//      情绪、风格写成标签词表的规范名字，例如 [angry, low energy]）。三项都没有，就不加，unit 上也没有 openingCue。
//      说明（instructions）不在里面：不发给模型（「带一点四川口音」这种概括的标签，模型不知道具体怎么念）。调用方不能再给说明（options.instructions、项的 instructions、命令行 --instructions）：
//      读输入时就报 dub_input_invalid（field 是 instructions 或 script[i].instructions），--dry-run 也报，一次能力都不调；消息说要的说法在台本里写具体的提示，写在发生的位置。
//      设定的说明是给写台本的人看的：用了带说明的设定（没用设定、--no-setup 的没有），notes 里每个这样的包有一条 setup_instructions，列出说明原文和哪几句用了这套设定，
//      告诉写台本的人照说明在台本里写具体的（用词、语气词写进台词，读音不同的常用字写成读那个音的字，声调、尾音、节奏的变化在发生的那几个字前面写一个短提示），指到 models/scene3.md「What to write」「Cross-language and accent」。
//      加在哪个请求上：每个请求一条，写在它的最前面。一个请求是一个 unit：一行一个请求的一段，或者并起来的几句（5b、5c）。这条提示是这个请求从台本的哪一句开始（unit.line，
//      第 1、2 步拆出来的一句：两处停顿、换行、章节、换声音之间的一截），按那一句算的：那一项的调用方给的（项的 labels），那个包的设定。
//      那一句开头是台本自己写的提示（方括号的，或者舞台说明换成的，例如一行开头的（小声）），这个请求不加：照台本。同一句被第 5 步切开的后几段，也照这一句的开头算。
//      照台本的只是写了提示的那一行：同一章里接在后面、自己没写提示的一行，前面要并进的那个请求里已经有台本写的提示（开头的，或者哪一行行首、句中写的）就不并（第 5c 步），
//      另起一个请求，加设定的提示；那个请求从头到尾都是设定的提示，照旧并。「那个请求」按上限切开之前的那一串算（第 5c 步）：一行的台本提示被上限切进前一个请求时，
//      偶尔多一个切点。第 5b 步（minChars）并短句是例外：太短的一行照旧并到下一行，下一行不另加设定的提示。
//      句中写的提示不受影响：照旧在原位，从它写的位置起生效，开头的提示照加。一场戏（5a）一个请求里，每一轮是这个说话人的一次开头：每一轮各加他那个包、那一行的提示
//      （那一行开头自己写了提示的不加），和一行一个请求时每行加的一样；场的 unit 自己没有这一项。开头的提示算进 maxChars、不算进 maxSpokenChars 和 minChars：
//      maxChars 管的是发出去的字，提示也在里面；maxSpokenChars 管要念的字，提示不念。所以按句子切（第 5 步）时给它留出位置（提示加上一个空格；剩下的不到 MIN_ROOM 个字（= lib/synthesis-limits.mjs 的 MIN_MAX_CHARS）时报错，见下面「限长」），
//      并段（5b、5c）时连它一起量（openingChars）。minChars 管念出来的字够不够长，提示不念。开头的提示不一样的两段不并（5b、5c）。请求怎么切（哪几句并成一个请求）不归这一步。
//      限长（数法和两个上限在 lib/cue-length.mjs：汉字、假名两个算一个词；台本里一处提示 MAX_CUE_WORDS 个词，合成以后整条开头的提示 MAX_OPENING_CUE_WORDS 个词）：模型只收文字，开头的提示写进每个请求，要短。
//        一下子的声音（vocab/cues.json 的 oneShot：叹气、笑……），写在风格里、情绪里都一样（情绪的值整个得是一下子的声音的一个词，笑、叹气；微笑、惊叹是普通的情绪），设定的、调用方给的都一样：不合进开头的提示（并进去就成了整句的说法）；
//        notes 里有一条 one_shot_style_skipped，告诉写台本的人写在它发生的地方；这一句开头台本自己写了提示的不算。规则在 lib/opening-cue.mjs 的文件头。
//        兜底：要加的提示合成以后整条超过 MAX_OPENING_CUE_WORDS 个词（情绪、风格写了词表以外的一长串），规划时报 dub_input_invalid（field 是 openingCue，details: { line, cue, words, limit }），
//        消息写明怎么改（用更短的 --emotion、--style 盖过设定的那一项，或者 --no-setup，或者改包里的设定）；这一句开头台本自己写了提示的，提示不会发出去，不报。做包时 --setups 给的设定整条超了也报（lib/make-pack-input.mjs 的 checkSetupOpeningCues）。
//        开头的提示加上一个空格，maxChars 剩下的不到 MIN_ROOM 个字、这一句又放不进一个请求要切开，规划时报 dub_input_invalid（field 是 maxChars，details: { maxChars, cue, room, min }），不切成每段几个字；整句放得进一个请求的照发。
//        都在花钱之前，规划（planDub）也报。限长以内的，请求的文字和 unit.openingCue 和以前一字不差。
//      报告：unit.openingCue（一场戏是 unit.scene.turns[i].openingCue）{ cue, added, parts }：cue 是合成的提示；added 是加了没有（false：那一句开头台本自己写了提示）；
//      parts 是用上的每一项 { value, from }，from 是 'caller'（调用方给的）或 'setup'（设定的）。
//   7c 角色名和语言提示：台本规定每行以角色的名字开头（models/scene3.md「Put the character name first」）。
//      一行被切成几个请求的（长停顿切开、放不下切开），后面的请求开头重复这一行开头的第一个方括号（第一个方括号就是名字；旧台本第一个是情绪的，也照样重复），算开头写了提示，不再加设定的开头的提示（第 7a 步）。
//      跨语言的请求（第 3a 步比出来的：参考段不是这一行的语言，给了 allowCrossLanguage）：行开头写名字对 [参考语言里的名字|台词语言里的名字]（lib/cross-language.mjs 的 namePairOf）。发给模型的是：
//        text      [Harry Potter][说戏]台词 [language: zh]    名字对只留参考语言里的名字，结尾写台词的语言。一个请求一处，一场戏写在最后一轮的末尾
//        ref_text  [哈利·波特]标注全文 [language: en]         开头写台词语言里的名字，结尾写参考的语言。一场戏每个跨语言的说话人各写各的
//      台词的语言：调用方、设定给的照写主语言（zh-CN 写 zh）；从文字认的，只可能是一种语言的文字写那种语言，别的取这种文字的第一种（汉字 zh，拉丁字母 en，lib/line-hints.mjs 的 LANGUAGES_OF）。参考的语言读清单。
//      跨语言的行开头没写名字对：报 dub_cross_language_unnamed，花钱之前停（规划也报），只看这一次要合成的段。
//      languageMarks: false：不要求名字对，不加两边的语言提示，台本怎么写就怎么发（要带参考那种语言的口音时用；做包自己的试合成也这样：量的是声音本身）。
//      同语言的请求不写语言提示，不看名字对；台本写了名字对的，发的是参考语言里的名字。
//      同语言的一行一个请求，台词开头是这个包的名字（[包名]，清单的 name）的，参考的文字开头也写这个名字：[沈迟][calm]门响我就听见了。两边对称：只在台词开头写名字、
//      参考上不写时，配音的模型有时把整句配得比参考低几个半音到一个八度（读数在 models/scene3.md「Put the character name first」）。开头是说戏、别的名字的不写；一场戏的不写；
//      languageMarks: false 的不写（台本怎么写就怎么发）。报告：unit.referenceName 是写上的名字，没写就没有这一项。重跑时不一样的不沿用（cli/commands/dub.mjs 文件头「沿用」）。
//      报告：unit.languageMarks { language, referenceLanguage, referenceName }（referenceName 是 null：没写名字对，languageMarks: false 时不记整项）；一场戏的 unit.languageMarks 只有 language，参考那半在 scene.speakers[i].languageMarks。重跑时不一样的不沿用（cli/commands/dub.mjs 文件头「沿用」）。
//   7b 语速（设定，见上面「设定」）：unit.speed 不是 null、也不是 1 的段，合成以后（包里脚本的 audio 钩子之后）变速，规则同第 8 步和拼接：lib/mix.mjs 的 changeSpeed（ffmpeg 的 atempo，
//      保持音高），上下限是 SPEED_LIMITS，要的倍数超出了按最近的那一头变；交出去的音频是 ffmpeg 给的 WAV。一场戏整场变（一场里的语速都一样，scene-in-request 在语速变的地方切开）。
//      报告：unit.speedChange { wanted, speed, originalMs, actualMs, limit? }：要的倍数、实际用的倍数（没有 ffmpeg 是 null）、变速前后多长（毫秒，取整；不是 WAV、又没有 ffmpeg 时量不出，是 null），
//      超出上下限的另有 limit（'max' 或 'min'）。变过速的段 unit.speed 改成 null：拼接的人不再变一次。环境没有 ffmpeg：照原样交出，不报错，unit.speed 留着要的语速（拼接时有 ffmpeg 再变），
//      合成完有一条注意 speed_not_applied。
//   8 目标时长（对画面的一句）：台本的一项给了 targetDurationMs（或 options.targetDurationMs 给了每一项），这一项合成以后（包里脚本的 audio 钩子之后）变速，让它的长度对上目标。
//     变速是 lib/mix.mjs 的 changeSpeed：ffmpeg 的 atempo（保持音高），倍数 = 原长 ÷ 目标（取到小数点后 4 位），上下限是 lib/mix.mjs 的 SPEED_LIMITS（和拼接同一处）；
//     要的倍数超出了，按最近的那一头变，不硬变。变了速的段，交出去的音频是 ffmpeg 给的 WAV。环境没有 ffmpeg，照原长交出（和拼接一样，不报错）。
//     目标时长对的是一段音频，所以：给了目标时长的一项不和别的项并成一段（5b）；它配出来不止一段（请求里放不下的停顿、章节、换声音、行与行之间换了语言或开头的提示、放不下一个请求切开），
//     花钱之前就报 dub_input_invalid（规划也报）。几个人轮流说的一项进了一场戏（5a），一场是一个音频，整场按目标变速。
//     给了目标时长的段，unit.speed 是 null：语速由目标时长定，调用方和设定给的 speed 都不用（第 7b 步不变速，拼接时也不再变）。
//     报告：unit.targetDuration。规划里是 { targetMs }；合成以后是 { targetMs, originalMs, speed, actualMs, offByMs, limit? }：
//     originalMs 合成出来多长，speed 变速的倍数（没有 ffmpeg 是 null），actualMs 交出去的多长，offByMs 交出去的比目标长多少（短了是负数），毫秒都取整；
//     limit 是按哪一头变的（'max' 上限、'min' 下限，没超出就没有这个键）。不是 WAV、又没有 ffmpeg 时量不出长度，originalMs、actualMs、offByMs 是 null。
//     变不到目标的（超出上下限的，没有 ffmpeg 的）合成完有一条注意 target_duration_missed。
//   9 比一比音色（音色漂移）：环境有 speaker-verification 时，一行一个请求的每一段合成出来以后，量一次它和所用的那一段参考（unit.pick.segmentId）的说话人相似度。
//     量的是模型出的那段：包里脚本的 audio 钩子、第 7b 步和第 8 步的变速之前（变速改了音频，量的就不是模型配出来的声音了）。参数 { audio_a: 合成出来的音频, audio_b: 参考段的录音 }。
//     dub 只量、只报，不自己重配：换一段参考（换一个音色基底标签）重配是 agent 的事，规则不在这里。
//     报告：plan.speakerSimilarity 是这一次量不量：{ measured: true, minSimilarity } 或 { measured: false, reason: 'capability_missing', capability: 'speaker-verification', minSimilarity }；
//       minSimilarity 是 options.minSimilarity，没给是 null。规划（planDub）里就有。
//     unit.speakerSimilarity（合成成了才有）：
//       { status: 'measured', segmentId, similarity, model?, drifted? }  drifted 只在给了阈值时才有：similarity 低于 minSimilarity 是 true；
//       { status: 'no_speech', label: '量不到', segmentId, which, error }  某一路嵌不出声纹（speaker-verification 的标准写法），which 是 'generated'（合成出来的）或 'reference'（参考段）；
//       { status: 'not_heard', label: '没听成', segmentId, error }          服务暂时出错。
//       这两种都不重试、不停下，这一段的音频照样交出。量的时候别的错（401、返回的形状不对……）照「一段失败了怎么办」停下来：这一段已经合成好了，先交给 onUnit，再往上抛。
//     一场戏一个请求的段（第 5a 步）量不了：一个音频里没有每个说话人的边界。规划时就写上 unit.speakerSimilarity = { speakers: [{ speaker, pack, segmentId, status: 'unmeasurable',
//       label: '量不了', reason: 'scene_in_request', message }] }，每个说话人一项，不调能力。要量，用 scene: false 一行一个请求。
//     几次调用：一行一个请求的段每段一次（合成失败的不量）。
//   9a 念完没有：每个请求合成成了（一行一个请求的段、一场戏一个请求的段都算），量模型出的那段音频有多长（量法同第 8 步：WAV 自己解，别的格式要 ffmpeg），
//     和按交上去的字数估的「至少多长」比（lib/speech-length.mjs 的 expectedSpeechMs：提示不算，语速往快里取，只写在那一处）；不到估的一半（UNFINISHED_BELOW），
//     这一段可能没念完：模型一个请求念不完时不一定报错，是念到一半就停。合成完每段一条说明 speech_maybe_unfinished（见下面「说明」）。
//     只提醒：不重试、不报错、不调用能力（不花钱），这一段照样是 ok、照样交出。量不出长度的（不是 WAV、环境又没有 ffmpeg，或者解不了），不比，也不说。
//     只抓得到念了不到一半的：少念一两句（例如一行的最后一句没念）出来的还长过估的一半，抓不到，要靠听或转写核对（
//     2026-11-05 一行少念了最后一句，报告里没有这一条）。不为它改阈值：改到抓得住少一两句，念完了的也会被多报。
//
// 语速和停顿：合成能力不收语速；停顿只有一段话里、一场戏里的短停顿写进请求的文字（第 5a、5c 步），别的（请求里放不下的、切点上的）不是合成出来的。
// 语速由 dub 在合成以后变（第 7b 步）；dub 没变成的（环境没有 ffmpeg），unit.speed 还记着要的语速。
// unit.speed（还要变的语速；null 是没有要求，或者 dub 已经变过）、unit.pauseBeforeMs、unit.pauseAfterMs 如实记着，由拼接的人按它们处理。
// 拼接的人是拿到这些 unit、交出成品音频的那一方：命令行的使用者（自己用 ffmpeg 之类拼，或者用 mix），
// 或者适配器（它自己把音频拼好、直接返回成品的，就是拼接的人，unit.speed 归它处理，例如变速、保持音高，不能原样丢掉）。dub 本身不把 speed 传给合成能力。
// 台本里写的放慢、加快（<slow>…</slow>、[slow]、（慢慢地））是提示或尖括号标签，随文字交给模型，不改 unit.speed。
// 停顿有两个来源：台本标记 [pause …] 和舞台说明（（停顿 3 秒），一行里只有它时挂到前一句的后面，规则见 lib/line-hints.mjs）。同一处两样相加，
// 加起来照写的，不封顶（和 [pause …] 一样）；同一行里的都挂在前一句后面、相加。隔一行的缝上，前一句的后面和后一句的前面各写各的，不相加，由拼接的人各插各的（lib/mix.mjs）。放不下一份音频的，拼接时报错（lib/mix.mjs）。
//
// 模型：能力的返回里报了 model（实际用的模型），记在 unit.model；适配器这一次换了模型（例如原来要用的模型不可用），返回里另有 modelChange: { from, reason }，
// 原样记在 unit.modelChange（没换就没有这一项）。约定只写在 adapters/README.md「When the model changes」，读法在 lib/capability-calls.mjs 的 reportedModel。
// dub 自己不换模型，不拿别的能力顶替，也不重试（换不换由平台定，见 adapters/README.md「When the model changes」），能力抛的错照下一段对待。告诉使用者哪几句换了，是命令行层的事（cli/commands/dub.mjs 的输出）。
//
// 一段失败了怎么办：能力抛的错如果标了 details.transient（服务暂时出错，约定见 vocab/capability-signatures.md），或者标了 details.textRejected
// （只和这一次的文字有关，换一句就成，同一约定），这一段记成 failed（unit.error 是 { code, message, details }），别的段照常做，整体 ok 是 false；
// 调用方可以事后用 only 重做。服务那头已经做完、只是结果没取回来的（details.unretrieved，同一约定；怎么取回在 details.retrieve）也只记这一段失败、别的段照常做，
// 可它不是暂时出错：重做会再计一次费，命令行把它单列、不放进重做的命令（cli/commands/dub.mjs 的文件头「没取回」），
// 命令行写的报告（dub.json、--json 的输出）顶层另有 unretrieved，列出这几段的序号（从 1 起，同命令行的 --only，即 units[i].index + 1；没有这种段就没有这一项）；同一个输出目录里上一次没取回、这一次 only 没点到的段（同一个请求才算，认法同沿用），命令行照旧记成没取回（不是 skipped），也列在里面。
// 库返回的报告里没有 unretrieved：调用方看 units[i].error.details.unretrieved。
// 比下限短、并不了的那一段（第 5b 步，按第 5c 步并好的请求判）也记成 failed，但重做没有用，要改台本。别的错（401、参数错、参考的问题、
// 返回的形状不对……）一律停下来：不再开始新的段，等已经在做的段做完，错误原样往上抛。每一段做完（成功或失败）立刻交给 onUnit，
// 所以停下来的时候，已经做完的不会丢。合成成了（花过钱）以后的几步出错也是这样停：念完没有（第 9a 步）、包里脚本的 audio 钩子、目标时长（第 8 步）、
// 语速（第 7b 步）哪一步抛错，这一段先交给 onUnit，status 是 ok，音频是模型出的那段（没过钩子、没变速：unit.speed 还记着要的语速，unit.targetDuration 只有 targetMs，
// 都同规划里的），再往上抛，付过钱的不丢。这一段另有 unit.afterSynthesisFailed = { step }，step 是出错的那一步：'speech-length'（第 9a 步）、'audio-hook'、
// 'target-duration'（第 8 步）、'speed'（第 7b 步）。它有音频，可那一步和后面的几步没做：调用方（例如沿用，options.reuse）不能把它当成做完的一段。
// 量相似度（第 9 步）时出了别的错也一样先交出去，那时音频已经过了钩子和变速，没有这一项。
// 还有一道保护：还没有一句成功、已经有 TEXT_REJECTED_LIMIT（3）句被服务商拒了，也停下来：同样不再开始新的段、等在做的做完，然后抛 dub_text_rejected
// （details.rejected 写明被拒的段和句子）。只数服务商拒的：能力调用了服务商，服务商拒了这句的文字（details.textRejected 为 true，code 不是 capability_input_invalid）。
// 调用之前就查出来的（适配器自己的检查：空白、太长、有处理不了的字，code 是 capability_input_invalid，约定见 vocab/capability-signatures.md）不数：那是这句文字本身的问题，
// 换一句就成，只记这一句失败，别的照常做。为什么这样分：服务商拒的，原因可能是参考或别的输入（服务商的话没说拦的是哪个输入）。要是内容审核拦的是参考，
// 每一句都会这样被拒（这是推断，没有核过），所以要数，数到 3 句还没有一句成功，就停，不再白花钱。有过一句成功，参考就是能用的，之后再怎么被拒都不停：
// 台本中间一段敏感的话，不该让整份停下。中间夹着暂时出错的段，不算进这个数。平台说一个请求装不下的（details.problem 是 'too_long_for_one_request'）也不算进这个数：
// 它只和那一段的长度有关，不是参考被拦了。一场戏装不下（scene_too_long，第 5a 步）每一场各自失败、各自说明；不是一场戏的一句装不下，这一句记成 failed（原因在 unit.error），
// 别的照常做。
//
// 环境缺东西：规划（planDub）不抛错，只在 capabilities 和 missingRuntimes 里说明缺什么；dubScript 在花钱之前抛：
//   capability_missing  缺 voice-cloning（details.capability）
//   runtime_missing     脚本要的运行时环境没有（details: { runtime, entry, feature }）
// 只有配音用到的才报。
//
// 说明（返回值里的 notes：[{ code, message, details }]，规划和正式运行都有；message 是给人看的中文，details 是它说的那些事实，没有要说的数就是空对象）：
//   speed_not_applied        运行时：有几段要变速（调用方或设定给的语速，第 7b 步），环境没有 ffmpeg，照原速交出了。details: { units }（段的编号，从 0 起）；
//                            unit.speed 还记着要的语速，拼接时有 ffmpeg 再变
//   scripts_without_feature  包里有没登记功能的脚本，这次没有运行。details: { scripts }，scripts 是 [{ entry, runtime }]；note.scripts 是同一份，是原来的写法，留着给已有的读者
//   short_lines_joined       有几段比合成能力的下限短，并进了相邻的句子（第 5b 步）。details: { min, units }：下限是多少个字，并成的段有几段
//   pauses_in_request        有几处停顿并进了一次请求（第 5a 步一场戏里的，和第 5c 步一个声音并段的，一起数；写法是空串的也算）。details: { joins }
//   language_cut             有几处是因为换了语言才切开的（第 3、5c 步：一行一段参考，行与行之间换了语言、包里有那种语言的默认段，参考段不同）。details: { units }：切口后面那一段的编号（从 0 起）；
//                            message 说明一小段混着语言的话要留在一个请求里，写在同一行里，或者给语言（命令行 --language；另一种语言的整行也用这段参考，是跨语言克隆，要 allowCrossLanguage，第 3a 步）
//   cut_to_fit               有几处是因为一个请求放不下才切开的（第 5c 步，和第 5a 步一场戏切成几场的）。details: { maxChars, maxSpokenChars, cuts }：这一次的两个上限（不管的那个是 null），
//                            cuts 是 [{ unit, at }]：切口后面那一段的编号（从 0 起），切在哪种边界（'scene'、'paragraph'、'sentence'，同 unit.cutBefore）；
//                            message 写明两个上限，和一行里面切开的（那一行自己就放不下）
//   tag_pair_split           有几段发出去的文字里成对的尖括号标签没配上对（<whisper> 没有 </whisper>，或者反过来；tools/markup.mjs「尖括号标签」）：多半是一对标签被
//                            请求里放不下的停顿、换行、章节、换声音拆到了两个请求里，也可能是台本少写了一头。只提醒，不改字。details: { units }，每项是
//                            { unit（段的编号，从 0 起）, tags（没配上对的那几头，照原样写：先是没有开头的收尾标签，再是没关上的）}
//   lexicon_single_character 读音词表里只写一个字的词条（汉字这类按子串找的字）这次用上了：含这个字的每个词都照它念了。只提醒，照样换。每个包一条。
//                            details: { terms, pack? }（用上的那几个词条，按第一次用上的先后；几个包时 pack 是包 ID，message 开头点名包）；message 建议把词条写成整个词。
//                            写法在 lib/pronunciation-lexicon.mjs 的 singleCharacterNote
//   scene_in_request         有几场按一场戏一个请求合成（第 5a 步）。details: { scenes, lines }：几场，共几行；这几场没有每一行各自的音频
//   scene_too_long           运行时：平台说一场装不下（适配器标 details.problem 为 'too_long_for_one_request'，见 vocab/capability-signatures.md）。不自动切开，不重发：那一场记成 failed。
//                            details: { unit, lines }（段的编号从 0 起、台本的行）；message 说明在那里加章节标记切开（跟着写 CHAPTER_SPLIT_REMINDER：标题后面重写 [voice:]、要停一口气写 [pause]），或者用 scene: false 一行一个请求
//   pause_length_unchecked   台本里有停顿，可是参考段里一段也读不出采样率，计划阶段估不出成品的格式，停顿加起来放不放得下一份 WAV 这一次没核（拼接时照常核）。details: { reason: 'no_reference_format' }
//   speaker_name_in_line     台本写成「名字：台词」：有几句要念的字以给的某个包的名字或包 ID 开头（不分大小写），后面跟着「：」或「:」。只提醒：名字照原样念，
//                            这几句也不换成那个包（换声音只认 [voice:名字]）；message 引前几句，建议把开头的「名字：」换成 [voice:名字]。
//                            details: { lines: [{ line, name, pack }] }：line 同 lines[i].index（从 0 起），name 是台本里写的名字，pack 是那个包的 ID
//   speech_maybe_unfinished  运行时：一段出来的音频不到按字数估的一半（第 9a 步），可能没念完。每段一条，按段的编号。
//                            details: { unit, expectedMs, actualMs }：段的编号（从 0 起）、估的至少多少毫秒、出来的多少毫秒；message 写明这几样和这一段开头的字，说这一段照样交出、不自己重配，要不要重配（--only 或者加章节标记切短，跟着写 CHAPTER_SPLIT_REMINDER）
//   target_duration_missed   运行时：有几段没有变到目标时长（第 8 步）：要的倍数超出了变速的上下限、按最近的那一头变的，或者环境没有 ffmpeg、没变速的。
//                            details: { units }，每项是 { unit（段的编号，从 0 起）, ...这一段的 targetDuration }
//   unrecognized_directions  台本里有几处 30 个字以内的括号（（…）、(…)、【…】、*…*），词表一个词也认不出（第 2 步，pick.directions 里 recognized 为 false），照样换成提示、不念：
//                            可能是原文括号里要念的正文。只提醒，不改字；message 引前几处，建议要念的改成不带括号的写法（逗号、破折号）。结构规则认出的「副词 + 地说」（（认真地说））也在里面。
//                            词表只认出一部分、不是英文写的（（他眼睛一亮，满脸堆笑）只认出「笑」）也在里面：它原样放进方括号发出去，是中文的提示（pick.directions 里 notEnglish 为 true，recognized 为 true），
//                            message 叫写台本的人改成两三个词的英文提示（models/scene3.md「What to write」）。整个都认得的、英文写的又认出一部分的（(he smiles at her)）、只有快慢的不在里面
//                            details: { directions: [{ line, raw }] }：line 同 lines[i].index（从 0 起），raw 是括号里的字（同 directions 的 raw），按出现的次序
//   carried_over             有几段沿用上一次做好的（options.reuse，见上面「沿用」；规划里也有），不再合成、不花钱。details: { units }（段的编号，从 0 起）
//   setup_instructions      用了带说明（instructions，口音这类）的设定（第 7a 步）：说明不发给模型，列给写台本的人看。每个这样的包一条（没用设定、--no-setup、设定没有说明的没有）。
//                            details: { setup, instructions, lines, pack? }：设定的名字、说明原文、哪几句用了这套设定（同 lines[i].index，从 0 起；几个包时 pack 是包 ID，message 开头点名包）；
//                            message 写明 dub 不把它发给模型，叫写台本的人照说明在台本里写具体的，指到 models/scene3.md「What to write」「Cross-language and accent」
//   one_shot_style_skipped   情绪或风格是一下子的声音（vocab/cues.json 的 oneShot），没合进开头的提示（第 7a 步「限长」）。同一个包、同一个来处、同一项、同一个声音一条。
//                            details: { item, style, from, setup?, lines, pack? }：item 是 'emotion' 或 'style'，style 是那个声音的规范名字（情绪的值整个是一下子的声音的一个词才算），from 是 'caller' 或 'setup'（setup 时另有设定的名字），
//                            哪几句（同 lines[i].index，从 0 起；开头台本自己写了提示的不算）；message 说要这一下就写在台本里它发生的地方（例如 [sighs]）
//   long_cues                台本里一处提示（方括号写的、舞台说明换成的，第 2 步）超过 lib/cue-length.mjs 的 MAX_CUE_WORDS 个词。只提醒，不改字，照原样发。
//                            details: { cues: [{ line, cue, words }], limit }：line 同 lines[i].index（从 0 起），cue 是那一处提示（连方括号），words 是数出来几个词，按出现的次序；
//                            message 引前几处，说一处提示写两三个词，指到 models/scene3.md「What to write」
//
// 抛出的错误（VoicePackError；code 小写下划线，details 里放什么在抛出处写明）：
//   dub_input_invalid        输入不合约定：台本不是字符串或数组、项没有 text、给了说明（options.instructions、项的 instructions，已拿掉，第 7a 步；details.field 是 instructions 或 script[i].instructions）、项的 speed 不是正数、expressiveness（options.expressiveness 或项的，不是 0 到 100 的整数；details.field 是 expressiveness 或 script[i].expressiveness）不对、only 或 maxChars 或 maxSpokenChars 或 concurrency 或 speed
//                            或 previousSeed（不是函数，或者返回的不是 0 到 2^53−1 的整数、也不是 null）
//                            或 setup（不是非空字符串，也不是 { 包: 非空字符串 } 的表、也不是 false，或者表里同一个包点了两次）不对、
//                            或 referenceTag（不是非空字符串，也不是 { 包: 非空字符串 } 的表，或者表里同一个包点了两次）不对、
//                            targetDurationMs 不是正整数，或者给了目标时长的一项配成了不止一段（第 8 步；details 另有 item（项的编号，从 0 起）和 units（那几段的编号））、
//                            或者开头的提示太长（第 7a 步「限长」：合成以后整条超过 MAX_OPENING_CUE_WORDS 个词，field 是 openingCue；
//                            留给台词的不到 MIN_ROOM 个字、这一句又要切开，field 是 maxChars）。details.field
//   dub_nothing_to_say       台本里没有可说的话（只有标记和提示）
//   dub_cross_language       这一次要合成的段里有一行用的参考段不是这一行的语言，没给 allowCrossLanguage（第 3a 步；花钱之前就报，规划也报）。
//                            details: { units: [{ unit, pack: { id, name }, speaker?, segmentId, by, from, to, script?, lines, hasLanguage }] }：一段一项（一场戏里一个说话人一项），
//                            unit 是段的编号（同 only，从 0 起），speaker 只在一场戏里有（scene.speakers[i].speaker），segmentId、by 是用的参考段和为什么是它（同 pick），
//                            from 是这段参考的语言（清单里写的），to 是这几行的语言（给了的照写；从文字认、看不出是哪一种的是 null，另有 script，文字系统），
//                            lines 是这几行（同 lines[i].index，从 0 起；同一段里语言不同的几行分成几项），hasLanguage 是包里有没有这种语言的参考段
//   dub_text_rejected        还没有一句成功、已经有 3 句被服务商拒了（见上面「一段失败了怎么办」）：停下。details: { limit, rejected: [{ unit, line }] }，
//                            被服务商拒的段（unit，同 only 的编号）和它的句子（line，同 lines[i].index），都从 0 起
//   dub_cross_language_unnamed 跨语言的行开头没写名字对，没给 languageMarks: false（第 7c 步；花钱之前就报，规划也报）。
//                            details: { units: [{ unit, pack: { id, name }, speaker?, from, to, script?, lines }] }：同 dub_cross_language 的一项，lines 是缺名字对的那几句（同 lines[i].index，从 0 起）
//   setup_unknown            options.setup 点的名字，这个包的 setups 里没有（字符串：每个包都要有；表：表里点了名字的包要有）（花钱之前就报，规划也报）。details: { setup（点的名字）, pack: { id, name }（对不上的那个包）, setups（这个包里有哪几套的名字，没有就是空数组）}
//   reference_tag_unknown    指定的音色基底标签（options.referenceTag：字符串是每个包都要有，表是点到的包要有）这个包的参考集里一段都没有（花钱之前就报，规划也报，这个包一句台词都没有也报）。
//                            details: { referenceTag, pack: { id, name }（没有这个标签的那个包）, tags（这个包里每种语言有哪些标签：[{ language, tags }]，写法见 lib/reference-pick.mjs）}
//   voice_unknown            台本里的 [voice:名字]、或者 options.setup、options.referenceTag 表里的键，不是给出的包。台本里只给一个包时 details: { voices（不认识的名字）, pack: { id, name } }；
//                            几个包时（options.setup、options.referenceTag 的表一律）details: { voices, packs: [{ id, name }] }（给了哪些包）
//   voice_ambiguous          台本里的 [voice:名字]、或者 options.setup、options.referenceTag 表里的键，对上不止一个包（几个包的名字一样）：用包 ID 指定。details: { voices, packs }
//   dub_input_invalid        同一个包给了两次（details.field 是 pack）
//   capability_result_invalid  voice-cloning 的返回不合约定（不是 { bytes, mimeType }、enhancers_used 报了没递给它的增强件），
//                            或者 voice-cloning、text-to-dialogue 给了 modelChange 却写得不对（problem 是 model_change_invalid，见上面「模型」）。details: { capability, problem }
//   另外 pick_input_invalid（标签不对）、lexicon_invalid、script_*、file_missing（清单里列了、包里没有）等来自各自的模块。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError, isVoicePackError } from '../protocol/lib/errors.mjs';
import { hasCapability, requireCapability } from '../protocol/lib/env.mjs';
import { fromBase64 } from '../protocol/lib/bytes.mjs';
import { parseScript, CUE_PATTERN, PAIRED_TAG_PATTERN, TAG_BLOCK_PATTERN } from '../tools/markup.mjs';
import { splitSentences } from '../tools/sentences.mjs';
import { joinWritten, lastWrittenChar, LATIN_CLOSING, SPACED_WORD } from '../protocol/lib/word-spacing.mjs';
import { canonicalLabel, cuesInPlace, wordsOf } from './line-hints.mjs';
import { languageOfText, lineTarget, languagePair, referenceSources, namePairOf, lineNameOnly, lineLanguage, markLanguage, withLineLanguage, withReferenceMarks } from './cross-language.mjs';
import { pickReferences, pickSetupOf, refTextOf, speaksLanguage } from './reference-pick.mjs';
import { lexiconRules, applyLexicon, applyPhonemes, isSingleCharacterTerm, singleCharacterNote, PINYIN_ALPHABET } from './pronunciation-lexicon.mjs';
import { assertScriptRuntimes, missingScriptRuntimes, scriptsWithoutFeature, runScript, audioForScript, HOOKS } from './pack-script.mjs';
import { readAudioResult, summarizeOffer, summarizeUse } from './enhancers.mjs';
import { isServiceError, isTextRejected, isUnretrieved, summarizeError, pool, reportedModel } from './capability-calls.mjs';
import { requestsOf, pauseWriting, DEFAULT_MAX_PAUSE_IN_REQUEST_MS } from './pause-in-request.mjs';
import { cueThenText, openingCueOf, opensWithCue, withOpeningCue } from './opening-cue.mjs';
import { sceneRuns, mostPicked, isScene, TOO_LONG_FOR_ONE_REQUEST } from './scene-in-request.mjs';
import { checkPausesFit, changeSpeed, SPEED_LIMITS } from './mix.mjs';
import { speakerSimilarity, isNoSpeechError, NO_SPEECH_LABEL, NOT_HEARD_LABEL, UNMEASURABLE_LABEL } from './fidelity.mjs';
import { sniffAudio } from '../protocol/lib/audio.mjs';
import { decodeAudio, decodeFailureKind } from '../tools/audio-decode.mjs';
import { expectedSpeechMs, UNFINISHED_BELOW } from './speech-length.mjs';
import { MIN_MAX_CHARS, DEFAULT_MAX_SPOKEN_CHARS, spokenLength } from './synthesis-limits.mjs';
import { cueWords, MAX_CUE_WORDS, MAX_OPENING_CUE_WORDS } from './cue-length.mjs';

export const FEATURE = 'dub';
/** unit.error.code：比合成能力的下限短、并不了的那一段（第 5b 步）。make-pack 的试合成也认这个码，把它记成「没合成」，不是「暂时出错」。 */
export const TEXT_TOO_SHORT = 'text_too_short';
/**
 * 环境收 seed（声明了 seed-in-request）时，每个合成请求都给这一个 seed（文件头第 7 步）：长文切开的几块用同一个，前后的随机性一样。
 * 是一个固定的数，不随台本、不随这一次变：同一块同样的输入再配，出来的尽量一样（要不一样，改输入，或者用 only 点名重配：那一段换一个 seed，见文件头第 7 步）。
 * 数本身没有讲究，只要在签名的范围里（0 到 2^53−1）。
 */
export const DUB_SEED = 1;
/**
 * dub 自己切开、台本在切口没写停顿时，切口后一块前面停多久（毫秒，第 5c 步「切口的气口」）：行与行之间、一行里句子之间都是这一个值（一句话中间切开的切口不加）。
 * 出处：试听页 22（一段中文长文，开发用的适配器接的配音模型）。整段一个请求那一版，模型在三处段落交界留的静音是 660、650、740 毫秒（中位数 660）；
 * 切开那一版的三处切口，两块头尾本来就有 90、120、170 毫秒（中位数 120）。插的是差：660 − 120 = 540。量法：成品解码以后 10 毫秒一帧，低于 −40 dBFS、连着的一段算静音。
 * 一行里面句号处量到的 610 到 830 毫秒和段落交界的范围叠在一起，分不出两种，所以不另定句间的值。只在一个模型、一段中文上量过：换了模型，块头尾留的静音不一样，
 * 切口实际的静音也跟着差。
 */
export const CUT_PAUSE_MS = 540;
/**
 * 叫人在一段中间加章节标记切开时，同一句里跟着写的提醒（references/dub.md「How long text is split」的「A piece cannot hear the previous one.」）：声音标记不跨章（tools/markup.mjs），
 * 标题后面接着说的不是第一个包的，不重写 [voice:名字] 就回到第一个包；章节是台本自己的边界，不记切口的默认停顿（第 5c 步「切口的气口」），要停一口气得自己写。
 * 说明 scene_too_long、speech_maybe_unfinished 用它；命令行的 dub、mix 叫人加章节标记的地方也用它（cli/commands/dub.mjs、cli/commands/mix.mjs）。
 */
export const CHAPTER_SPLIT_REMINDER = 'If what follows a heading is not for the first pack, rewrite [voice:name] at the start of the line under the heading, or the voice goes back to the first pack; for a breath of silence, write [pause 0.5s] at the start of the line under the heading, since a chapter break adds no default pause';
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 8;
/**
 * 还没有一句成功、已经有这么多句被服务商拒了（details.textRejected，调用之前查出来的、平台说一个请求装不下的不算），就停下（文件头「一段失败了怎么办」）。依据：要是参考真被拦了，每一句都会被拒，
 * 这时最多白调这么多次；并发时，停的那一刻还在做的几句照常做完，所以实际还会多出并发数减一次。
 */
const TEXT_REJECTED_LIMIT = 3;
// 配音的台本是明确拿来配音的：30 个字以内的括号一律是舞台说明，词表里认不出的（（画外音））、有词表里的词可是还有别的字的（（笑话比赛））也换成提示、不念
// （规则的正本是 lib/line-hints.mjs 的 cuesInPlace）。挑参考拿到的是去掉提示的字（认语种）和读好的舞台说明（原样记下，不影响用哪一段），不再自己读括号；这个选项照旧交给它，两边说的是同一件事
const REMOVE_UNRECOGNIZED = Object.freeze({ unrecognized: 'remove' });

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (field, message) => new VoicePackError('dub_input_invalid', message, { details: { field } });

// ---------------------------------------------------------------- 输入

/** 目标时长（毫秒）的写法：正整数。 */
const isTargetMs = (value) => Number.isInteger(value) && value >= 1;
/** 语速的写法：正数（1 不变，0.85 放慢，1.15 加快），同清单里设定的 speed。 */
const isSpeed = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
/** 起伏（expressiveness）的写法：0 到 100 的整数（0、100 本身算），同能力签名里 voice-cloning、text-to-dialogue 的 expressiveness。 */
const isExpressiveness = (value) => Number.isInteger(value) && value >= 0 && value <= 100;
/**
 * 调用方不能再给说明（options.instructions、项的 instructions）：dub 不再把说明发给模型（第 7a 步）。给了就是输入错误，规划时就报，--dry-run 也报。
 * @param {string} field 出问题的字段（instructions 或 script[i].instructions）
 * @param {string} given 在消息里怎么称呼它
 * @throws {VoicePackError} dub_input_invalid（details: { field }）
 */
function rejectInstructions(field, given) {
  throw invalid(field, `${given} is no longer accepted: dub no longer sends instructions to the model (a summary label such as "a slight Sichuan accent" does not tell the model how to say anything). To get that way of speaking, write specific cues in the script, where they happen: put wording and particles directly in the line, write a common character that is read differently as a character with that reading, and put a short cue in front of the few characters where tone, ending sound or rhythm changes (how to write them: models/scene3.md「What to write」「Cross-language and accent」)`);
}

function readScript(script) {
  if (typeof script === 'string') return [{ text: script, labels: undefined, speed: undefined, expressiveness: undefined, targetDurationMs: undefined }];
  if (!Array.isArray(script)) throw invalid('script', 'script must be a string (the whole script, with script markup) or an array: each item { text, labels?, speed?, expressiveness?, targetDurationMs? }');
  return script.map((item, index) => {
    const at = `script[${index}]`;
    const entry = typeof item === 'string' ? { text: item } : item;
    if (!isPlainObject(entry) || typeof entry.text !== 'string') throw invalid(`${at}.text`, `${at}.text must be a string (the script of this item)`);
    if (entry.instructions !== undefined) rejectInstructions(`${at}.instructions`, `${at}.instructions`);
    if (entry.speed !== undefined && !isSpeed(entry.speed)) throw invalid(`${at}.speed`, `${at}.speed must be a positive number (speed of this item: 1 unchanged, 0.85 slower, 1.15 faster; applied after synthesis), or omitted`);
    if (entry.expressiveness !== undefined && !isExpressiveness(entry.expressiveness)) throw invalid(`${at}.expressiveness`, `${at}.expressiveness must be an integer from 0 to 100 (expressiveness of this item: higher is more varied, lower is steadier; left to the synthesis capability), or omitted`);
    if (entry.targetDurationMs !== undefined && !isTargetMs(entry.targetDurationMs)) throw invalid(`${at}.targetDurationMs`, `${at}.targetDurationMs must be a positive integer (how many milliseconds this item should come out at), or omitted`);
    return { text: entry.text, labels: entry.labels, speed: entry.speed, expressiveness: entry.expressiveness, targetDurationMs: entry.targetDurationMs };
  });
}

/**
 * 按包点名的选项（options.setup、options.referenceTag）的写法：一个非空字符串（每个包都用它），或者一张表，键是包（包名或包 ID）、值是非空字符串（只给这个包）。
 * options.setup 另外可以是 false（哪个包都不用设定）。
 */
const isPerPackOption = (value) => {
  const named = (item) => typeof item === 'string' && item !== '';
  return named(value) || (isPlainObject(value) && Object.entries(value).every(([key, item]) => key.trim() !== '' && named(item)));
};
const isSetupOption = (setup) => setup === false || isPerPackOption(setup);

function readOptions(options) {
  if (!isPlainObject(options)) throw invalid('options', 'options must be an object');
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) throw invalid('concurrency', `concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`);
  const maxChars = options.maxChars ?? null;
  if (maxChars !== null && (!Number.isInteger(maxChars) || maxChars < MIN_MAX_CHARS)) throw invalid('maxChars', `maxChars must be an integer of at least ${MIN_MAX_CHARS}`);
  const maxSpokenChars = options.maxSpokenChars === undefined ? DEFAULT_MAX_SPOKEN_CHARS : options.maxSpokenChars; // 不给是默认的软上限，null 是不要（lib/synthesis-limits.mjs）
  if (maxSpokenChars !== null && (!Number.isInteger(maxSpokenChars) || maxSpokenChars < MIN_MAX_CHARS)) throw invalid('maxSpokenChars', `maxSpokenChars must be an integer of at least ${MIN_MAX_CHARS} (the most spoken characters in one request), or null (do not split by spoken characters), or omitted (default ${DEFAULT_MAX_SPOKEN_CHARS})`);
  if (options.onUnit !== undefined && typeof options.onUnit !== 'function') throw invalid('onUnit', 'onUnit must be a function');
  if (options.onPlan !== undefined && typeof options.onPlan !== 'function') throw invalid('onPlan', 'onPlan must be a function');
  if (options.reuse !== undefined && typeof options.reuse !== 'function') throw invalid('reuse', 'reuse must be a function: reuse(unit) returns the fields of this piece, finished last time, to merge in, or null');
  if (options.previousSeed !== undefined && typeof options.previousSeed !== 'function') throw invalid('previousSeed', 'previousSeed must be a function: previousSeed(unit) returns the seed that the piece picked by only was dubbed with last time, or null');
  if (options.setup !== undefined && !isSetupOption(options.setup)) throw invalid('setup', 'setup must be a string (the name of a setup, the name in setups in the voice pack manifest), or a table { pack name or pack ID: setup name } (with several packs, name one for each pack), or false (use no setup), or omitted');
  if (options.referenceTag !== undefined && !isPerPackOption(options.referenceTag)) throw invalid('referenceTag', 'referenceTag must be a string (a reference tag, used for every pack), or a table { pack name or pack ID: reference tag } (only for the packs named), or omitted');
  const minChars = options.minChars ?? null;
  if (minChars !== null && (!Number.isInteger(minChars) || minChars < 1)) throw invalid('minChars', 'minChars must be an integer of at least 1 (the fewest characters the synthesis capability takes at once), or omitted');
  const maxPauseInRequestMs = options.maxPauseInRequestMs ?? DEFAULT_MAX_PAUSE_IN_REQUEST_MS; // 不给就用基础部分的默认值（lib/pause-in-request.mjs）
  if (!Number.isInteger(maxPauseInRequestMs) || maxPauseInRequestMs < 0) throw invalid('maxPauseInRequestMs', 'maxPauseInRequestMs must be an integer of at least 0 (the longest single pause allowed inside one request, in milliseconds, as declared by the environment; 0 splits at every pause and leaves it to stitching), or omitted');
  // 旧的名字（一个请求里写进 <speak> 的停顿加起来最多多少）不再收：意思变了，给了就报错，不悄悄当成新的
  if (options.maxPauseInTextMs !== undefined) throw invalid('maxPauseInTextMs', 'maxPauseInTextMs is no longer accepted: the longest single pause inside one request is now called maxPauseInRequestMs (each pause is checked on its own, not summed)');
  if (options.joinShort !== undefined && typeof options.joinShort !== 'boolean') throw invalid('joinShort', 'joinShort must be true or false');
  if (options.runtimesOf !== undefined && typeof options.runtimesOf !== 'function') throw invalid('runtimesOf', 'runtimesOf must be a function: runtimesOf(pack) returns the script runtimes of this pack');
  if (options.scene !== undefined && typeof options.scene !== 'boolean') throw invalid('scene', 'scene must be true or false (false: one request per line, not one request per scene)');
  const maxSpeakers = options.maxSpeakers ?? Number.POSITIVE_INFINITY; // 不给就不限
  if (options.maxSpeakers !== undefined && options.maxSpeakers !== null && (!Number.isInteger(maxSpeakers) || maxSpeakers < 2)) throw invalid('maxSpeakers', 'maxSpeakers must be an integer of at least 2 (the most speakers in one scene that the environment accepts), or omitted');
  const targetDurationMs = options.targetDurationMs ?? null;
  if (targetDurationMs !== null && !isTargetMs(targetDurationMs)) throw invalid('targetDurationMs', 'targetDurationMs must be a positive integer (how many milliseconds each item should come out at), or omitted');
  if (options.instructions !== undefined) rejectInstructions('instructions', 'options.instructions (command line --instructions)');
  if (options.speed !== undefined && !isSpeed(options.speed)) throw invalid('speed', 'speed must be a positive number (the speed the caller gives: 1 unchanged, 0.85 slower, 1.15 faster; applied after synthesis), or omitted');
  if (options.expressiveness !== undefined && !isExpressiveness(options.expressiveness)) throw invalid('expressiveness', 'expressiveness must be an integer from 0 to 100 (the expressiveness the caller gives: higher is more varied, lower is steadier; left to the synthesis capability), or omitted');
  const minSimilarity = options.minSimilarity ?? null;
  if (minSimilarity !== null && (typeof minSimilarity !== 'number' || !Number.isFinite(minSimilarity))) throw invalid('minSimilarity', 'minSimilarity must be a finite number (pieces whose speaker similarity is below it are flagged, step 9; the range of the number depends on speaker-verification in the environment), or omitted');
  if (options.allowCrossLanguage !== undefined && typeof options.allowCrossLanguage !== 'boolean') throw invalid('allowCrossLanguage', 'allowCrossLanguage must be true or false (true: dub even when the reference segment is not in the language of this line, a cross-language clone, which carries an accent; see step 3a in the file header)');
  if (options.languageMarks !== undefined && typeof options.languageMarks !== 'boolean') throw invalid('languageMarks', 'languageMarks must be true or false (false: a cross-language line does not need a name pair at its start and gets no language cue on either side, the script is sent as written; see step 7c in the file header)');
  return { concurrency, maxChars, maxSpokenChars, minChars, maxPauseInRequestMs, maxSpeakers, targetDurationMs, minSimilarity, scene: options.scene ?? true, joinShort: options.joinShort ?? true, allowCrossLanguage: options.allowCrossLanguage ?? false, languageMarks: options.languageMarks ?? true, onUnit: options.onUnit, onPlan: options.onPlan, reuse: options.reuse, previousSeed: options.previousSeed, labels: options.labels, speed: options.speed, expressiveness: options.expressiveness, setup: options.setup ?? null, referenceTag: options.referenceTag ?? null, only: options.only, runtimesOf: options.runtimesOf };
}

// ---------------------------------------------------------------- 几个包

/** 给的包：一个，或者几个（数组）。统一成数组，第一个是台本开头用的声音。同一个包给了两次是输入错误。 */
function packsOf(input) {
  const packs = Array.isArray(input) ? input : [input];
  if (packs.length === 0) throw invalid('pack', 'Give at least one voice pack');
  const seen = new Set();
  for (const pack of packs) {
    if (seen.has(pack.manifest.id)) throw new VoicePackError('dub_input_invalid', `Pack ${pack.manifest.id} was given twice: give each pack once`, { details: { field: 'pack' } });
    seen.add(pack.manifest.id);
  }
  return packs;
}

/** 这个包的脚本要的运行时在哪个环境里：几个包时用 runtimesOf（每个包的脚本在它自己的目录里运行）；不给就是 env。 */
const envFor = (env, settings, pack) => (settings.runtimesOf === undefined ? env : { ...env, runtimes: settings.runtimesOf(pack) });

/**
 * 这个包这一次用的设定（清单的 setups，见 protocol/FORMAT.md 4.4）：点了名（options.setup）就按名字找，对不上报 setup_unknown（在花钱之前，规划就报）；
 * 没点名就用带 default: true 的那一套，没有就不用设定。返回 { setup, by: 'option' | 'default' }，不用设定是 null。
 * name 是这个包点的名字（perPackValues 按 options.setup 算出来的），没点是 null。每个包在自己的 setups 里找：点的名字这个包没有，就是这个包对不上。
 */
function chooseSetup(pack, name) {
  const setups = pack.manifest.setups ?? [];
  if (name !== null) {
    const found = setups.find((setup) => setup.name === name);
    if (found !== undefined) return { setup: found, by: 'option' };
    const names = setups.map((setup) => setup.name);
    throw new VoicePackError('setup_unknown', `Pack ${pack.manifest.name} (${pack.manifest.id}) has no setup named ${JSON.stringify(name)}: ${names.length === 0 ? 'the pack has no setups at all' : `it has ${names.map((item) => JSON.stringify(item)).join(', ')}`}`, { details: { setup: name, pack: { id: pack.manifest.id, name: pack.manifest.name }, setups: names } });
  }
  const found = setups.find((setup) => setup.default === true);
  return found === undefined ? null : { setup: found, by: 'default' };
}

/**
 * 名字或包 ID（不分大小写）对上的包：台本里的 [voice:]、options.setup 和 options.referenceTag 的表认包，用的是这同一条规则。
 * 命令行的 --reference-tag 也用它认 <包>=<标签> 的左边（cli/commands/dub.mjs），所以导出。
 * @param {{ manifest: { id: string, name: string } }[]} packs
 * @param {string} name
 */
export const packsNamed = (packs, name) => packs.filter((pack) => [pack.manifest.id, pack.manifest.name].some((item) => item.trim().toLowerCase() === name.trim().toLowerCase()));

/**
 * 「名字：台词」（对话、使用者给的台本常这样写）：一句要念的字（去掉提示以后的，line.words）以给的某个包的名字或包 ID 开头（不分大小写，同 [voice:] 认包），
 * 后面（中间可以有空白）跟着「：」或「:」。dub 只提醒、不改字，也不换声音（换声音只认 [voice:名字]）。返回 [{ line, name, pack, prefix }]：line 是 lines[i].index，
 * name 是台本里写的那个名字，pack 是那个包的 ID，prefix 是台本里写的「名字：」那一截（连冒号）。几个包的名字都对得上时取先给的包。
 */
function namePrefixedLines(lines, packs) {
  const found = [];
  for (const line of lines) {
    const words = line.words.trimStart();
    for (const pack of packs) {
      const named = [pack.manifest.name, pack.manifest.id].map((item) => item.trim()).filter((item) => item !== '' && words.slice(0, item.length).toLowerCase() === item.toLowerCase());
      const name = named.find((item) => NAME_COLON.test(words.slice(item.length)));
      if (name === undefined) continue;
      found.push({ line: line.index, name: words.slice(0, name.length), pack: pack.manifest.id, prefix: words.slice(0, name.length + NAME_COLON.exec(words.slice(name.length))[0].length) });
      break;
    }
  }
  return found;
}
/** 名字后面的冒号（全角、半角都算，前面可以有空白）。 */
const NAME_COLON = /^\s*[:：]/;
/** 文字里的提示（方括号，tools/markup.mjs「提示」）。 */
const CUES_IN_TEXT = new RegExp(CUE_PATTERN, 'g');

/** 规划的说明 speaker_name_in_line（文件头「说明」）：哪几句、建议换成什么。found 是 namePrefixedLines 的结果，不空。 */
function namePrefixNote(found, lines) {
  const QUOTED = 3; // 说明里只引前几句，全部的在 details 里
  const clip = (text) => ([...text].length > 30 ? `${[...text].slice(0, 30).join('')}…` : text);
  // 引台本里写的字，去掉提示（line.words 里音素标记、语言标签换成了 U+FFFC，不给人看）
  const quoted = found.slice(0, QUOTED).map((entry) => `"${clip(lines[entry.line].text.replace(CUES_IN_TEXT, '').replace(/[ \t]{2,}/g, ' ').trim())}"`).join(', ');
  const more = found.length > QUOTED ? ` etc. (${found.length} lines)` : '';
  const advice = [...new Map(found.map((entry) => [entry.prefix, `the leading "${entry.prefix}" with [voice:${entry.name}]`])).values()];
  return {
    code: 'speaker_name_in_line',
    message: `${found.length} ${found.length === 1 ? 'line' : 'lines'} whose spoken text starts with a pack name or pack ID followed by a colon: ${quoted}${more}. The name is read aloud as written, and the voice does not switch to that pack (only [voice:name] switches the voice). If it marks a speaker, replace ${advice.join(', ')}`,
    details: { lines: found.map(({ line, name, pack }) => ({ line, name, pack })) },
  };
}

/**
 * 台本里一处超过 MAX_CUE_WORDS 个词的提示（方括号写的，舞台说明换成的；数法在 lib/cue-length.mjs），写成 long_cues（见文件头「说明」）。只提醒，不改字。没有就是 null。
 */
function longCuesNote(lines) {
  const QUOTED = 3; // 说明里只引前几处，全部的在 details 里
  const found = lines.flatMap((line) => (line.text.match(CUES_IN_TEXT) ?? []).filter((cue) => namePairOf(cue) === null).map((cue) => ({ line: line.index, cue, words: cueWords(cue.slice(1, -1)) }))).filter((entry) => entry.words > MAX_CUE_WORDS);
  if (found.length === 0) return null;
  const quoted = found.slice(0, QUOTED).map((entry) => `line ${entry.line + 1} ${entry.cue} (${entry.words} words)`).join(', ');
  const more = found.length > QUOTED ? ` etc. (${found.length} cues)` : '';
  return {
    code: 'long_cues',
    message: `${found.length} ${found.length === 1 ? 'cue is' : 'cues are'} longer than ${MAX_CUE_WORDS} words (two Chinese characters or kana count as one word): ${quoted}${more}. Write two or three words per cue, only how this one spot is said, not a sentence (the vendor's technical report says a cue is usually a few words; how to write them: models/scene3.md「What to write」). A stage direction (a parenthesis of up to 30 characters) is also carried into the square brackets as it is. This is only a notice; the text is sent as it is`,
    details: { cues: found, limit: MAX_CUE_WORDS },
  };
}

/**
 * 规划的说明 unrecognized_directions（文件头「说明」）：括号里词表一个词也认不出、照样拿掉不念的几处（第 2 步，lib/line-hints.mjs 的 cuesInPlace 记成 recognized: false），
 * 和词表只认出一部分、发出去的提示里还是别的文字（notEnglish: true，cueFor 原样放进方括号的那种：（他眼睛一亮，满脸堆笑））的几处。
 * 没有这样的括号是 null。只有提示、接不到哪一句上、丢掉的那几处不在 lines 里，不列。
 */
function unrecognizedNote(lines) {
  const QUOTED = 5; // 说明里只引前几处（同样的字只引一次），全部的在 details 里
  const found = lines.flatMap((line) => line.directions.filter((direction) => direction.recognized === false || direction.notEnglish === true).map((direction) => ({ line: line.index, raw: direction.raw })));
  if (found.length === 0) return null;
  const distinct = [...new Set(found.map((entry) => entry.raw))];
  const quoted = distinct.slice(0, QUOTED).map((raw) => `"${raw}"`).join(', ');
  const more = distinct.length > QUOTED ? ` etc. (${distinct.length} different ones)` : '';
  return {
    code: 'unrecognized_directions',
    message: `${found.length} ${found.length === 1 ? 'parenthesis' : 'parentheses'} whose words the stage-direction vocabulary does not recognize, or recognizes only in part (a parenthesis not in English): ${quoted}${more}. When dubbing, every parenthesis of up to 30 characters counts as a stage direction: these are turned into square-bracket cues for the model and the words inside are not spoken. If one is body text that should be spoken, first rewrite it without parentheses (commas, dashes), then dub. If it is a stage direction not in English, it goes to the model as written: rewrite it as an English cue of two or three words (models/scene3.md「What to write」). If it is a stage direction in English, ignore this`,
    details: { directions: found },
  };
}

/**
 * 名字是在哪里写的：报错的话里怎么称呼这些名字。mention(名字列表) 是称呼；onePack（可选）是只给了一个包时单独的说法，没有就和几个包时一样。
 * 台本里的 [voice:]：只有一个包时，报错和以前一字不差。
 */
const NAMED_IN_SCRIPT = {
  mention: (list) => `[voice:${list.join(', ')}] in the script`,
  onePack: (list, pack) => `[voice:${list.join(', ')}] in the script is not this pack (${pack.manifest.name}, ${pack.manifest.id}): a pack has only one voice; a script that switches voices needs other packs`,
};
const NAMED_IN_SETUP = { mention: (list) => `${list.map((item) => JSON.stringify(item)).join(', ')} named in options.setup` };
const NAMED_IN_REFERENCE_TAG = { mention: (list) => `${list.map((item) => JSON.stringify(item)).join(', ')} named in options.referenceTag` };

/**
 * 认包的名字（台本里的 [voice:名字]，或者 options.setup 表里的键）：对不上任何一个包是 voice_unknown，对上不止一个是 voice_ambiguous。
 * where 是 NAMED_IN_SCRIPT 或 NAMED_IN_SETUP。
 */
function checkPackNames(packs, names, where) {
  const described = (pack) => `${pack.manifest.name}, ${pack.manifest.id}`;
  const { mention } = where;
  const unknown = [...new Set(names.filter((name) => packsNamed(packs, name).length === 0))];
  if (unknown.length > 0) {
    if (packs.length === 1 && where.onePack !== undefined) {
      const [pack] = packs;
      throw new VoicePackError('voice_unknown', where.onePack(unknown, pack), { details: { voices: unknown, pack: { id: pack.manifest.id, name: pack.manifest.name } } });
    }
    throw new VoicePackError('voice_unknown', `No pack given matches ${mention(unknown)} (packs given: ${packs.map((pack) => `${pack.manifest.name} (${pack.manifest.id})`).join(', ')}): the name or pack ID must match`, { details: { voices: unknown, packs: packs.map((pack) => ({ id: pack.manifest.id, name: pack.manifest.name })) } });
  }
  const ambiguous = [...new Set(names.filter((name) => packsNamed(packs, name).length > 1))];
  if (ambiguous.length > 0) {
    throw new VoicePackError('voice_ambiguous', `More than one pack matches ${mention(ambiguous)} (${packsNamed(packs, ambiguous[0]).map(described).join('; ')}): specify the pack ID`, { details: { voices: ambiguous, packs: packsNamed(packs, ambiguous[0]).map((pack) => ({ id: pack.manifest.id, name: pack.manifest.name })) } });
  }
}

/**
 * 每一句属于哪个包（owners[i] 是第 i 句的包）：[voice:名字] 认包名或包 ID（不分大小写）；没有 [voice:] 的句子用第一个包。
 * 对不上：voice_unknown；对上不止一个包：voice_ambiguous。只有一个包时，报错和以前一字不差。
 */
function ownersOf(packs, lines, voices) {
  checkPackNames(packs, voices, NAMED_IN_SCRIPT);
  return lines.map((line) => (line.voice === null ? packs[0] : packsNamed(packs, line.voice)[0]));
}

/**
 * 按包点名的选项（options.setup 的设定名字、options.referenceTag 的音色基底标签），每个包这一次是什么：字符串是每个包都用它；
 * 表 { 包: 值 } 里的键认包的写法同台本里的 [voice:]，表里没列的包是 null（设定用它自己的默认；标签走设定、默认段那两层）。没给是 null。
 * 键对不上包是 voice_unknown，对上不止一个包是 voice_ambiguous，同一个包点了两次（名字和 ID 写成了两个键）是 dub_input_invalid（details.field 是 field）。
 * @param {'setup' | 'referenceTag'} field 是哪一个选项（报错时用）
 * @returns {Map<object, string | null>}
 */
function perPackValues(packs, value, field) {
  if (value === null || typeof value === 'string') return new Map(packs.map((pack) => [pack, value]));
  const keys = Object.keys(value);
  checkPackNames(packs, keys, field === 'setup' ? NAMED_IN_SETUP : NAMED_IN_REFERENCE_TAG);
  const values = new Map(packs.map((pack) => [pack, null]));
  for (const key of keys) {
    const [pack] = packsNamed(packs, key);
    if (values.get(pack) !== null) throw invalid(field, `options.${field} names the same pack twice (${pack.manifest.name}, ${pack.manifest.id}): name each pack once`);
    values.set(pack, value[key]);
  }
  return values;
}

// ---------------------------------------------------------------- 台本 -> 一句一句

/**
 * 解析台本标记、读舞台说明，得到一句一句（每句是一段要交给模型的文字，提示在原位，带着自己的停顿）。
 * 停顿标记单独成段的（文字是空的），算在前一句后面；一开头的算在第一句前面。舞台说明里一句要念的话都没有的一段（（停顿 3 秒））也一样：
 * 它的停顿（cuesInPlace 的 unattachedPauseMs）和这一段后面的 [pause] 一起算。
 * 同一行里同一处停顿（舞台说明的加上 [pause …] 的）相加、挂在前一句后面，不封顶；隔一行的缝上，前一句的后面和后一句的前面各写各的，不相加。
 * 只有提示、没有要念的字的一段，接到哪里（文件头第 2 步）：同一个声音、同一章、同一项的下一句的开头；没有这样的下一句，接在前一句的末尾（同样要同一个声音、同一章、同一项），
 * 前一句也没有就丢掉。它的停顿跟着它：接在开头的算在那一句前面，接在末尾的算在那一句后面。
 */
function buildLines(sources, { labels: defaults, targetDurationMs: targetDefault, speed: speedDefault, expressiveness: expressivenessDefault }) {
  const lines = [];
  const voices = [];
  let pendingBefore = 0;
  let chapterOffset = 0;
  // 同一行里前一段留下的状态（cuesInPlace 的 carry）：跨过 [pause …] 接着算，换一行、换声音就清掉
  let carried = null;
  // 只有提示、没有要念的字的一段，等着接到下一句的开头：{ text, directions, pauseMs, voice, chapter, source }
  let waiting = null;
  const addPause = (ms) => {
    if (ms <= 0) return;
    if (lines.length > 0) lines[lines.length - 1].pauseAfterMs += ms;
    else pendingBefore += ms;
  };
  const sameRun = (line, cue) => line !== undefined && line.voice === cue.voice && line.chapter === cue.chapter && line.source === cue.source;
  // 等着的提示没有下一句可接（换了声音、章、项，或者台本完了）：接在前一句的末尾
  const flush = () => {
    if (waiting === null) return;
    const previous = lines[lines.length - 1];
    if (sameRun(previous, waiting)) {
      previous.text = cueAfter(previous.text, waiting.text);
      previous.directions = [...previous.directions, ...waiting.directions];
    }
    addPause(waiting.pauseMs);
    waiting = null;
  };
  const hintsOf = (hints) => ({ ...(hints.emotion === null ? {} : { emotion: hints.emotion }), ...(hints.style === null ? {} : { style: hints.style }) });
  // 一段话（第 5c 步）：台本里的一行（非空的一行是一段），同一个声音。每一项、每一章、每换一行、每换一次声音都开一段新的；lines[i].paragraph 是它的编号（只在库里用，不进报告）
  let paragraph = 0;
  // 场景的边界（第 5c 步）：上一句之后见过整行只有停顿的一行（[pause …] 或者读成停顿的舞台说明），下一句的 lines[i].sceneBefore 是 true。
  // 停顿写在一行的行尾、行首的不算，那里照段落的边界算
  let sceneAhead = false;
  sources.forEach((source, sourceIndex) => {
    const labels = { ...(defaults ?? {}), ...(source.labels ?? {}) };
    const chapters = parseScript(source.text, { lineStarts: true, pauseLines: true });
    chapters.forEach((chapter, chapterIndex) => {
      paragraph += 1;
      sceneAhead = false;
      chapter.spans.forEach((span, spanIndex) => {
        if (span.voice_id !== null) voices.push(span.voice_id);
        if (span.line_start === true) {
          carried = null;
          paragraph += 1;
        }
        const read = cuesInPlace(span.text, carried, { script: source.text });
        carried = read.carry;
        addPause(read.headPauseMs); // 同一行里前一段后面的停顿，挂在前一句后面
        const { pieces, unattachedPauseMs } = read;
        // 整行只有读成停顿的舞台说明的行：这一段的最后一行后面还接着同一行的下一段（中间只隔着停顿标记）的，不是整行
        const continues = chapter.spans[spanIndex + 1] !== undefined && chapter.spans[spanIndex + 1].line_start !== true;
        const lastTextLine = span.text.split('\n').length - 1; // parseScript 已经把 CRLF、CR 换成了 LF
        const pauseLines = read.pauseLines.filter((line) => !(continues && line === lastTextLine));
        const markerLine = span.pause_line === true && span.pause_ms_after > 0;
        if (pieces.length === 0) {
          if (pauseLines.length > 0 || markerLine) sceneAhead = true;
          addPause(unattachedPauseMs);
          addPause(span.pause_ms_after);
          return;
        }
        const where = { voice: span.voice_id, chapter: chapterOffset + chapterIndex, source: sourceIndex };
        // 这个 span 的文字里面换了行（cuesInPlace 按行切，piece.line 是行号），就是换了一段
        let lastLine = 0;
        let lastPieceLine = -1;
        pieces.forEach((piece, pieceIndex) => {
          if (piece.line !== lastLine) paragraph += 1;
          lastLine = piece.line;
          if (pauseLines.some((line) => line > lastPieceLine && line < piece.line)) sceneAhead = true;
          lastPieceLine = piece.line;
          const last = pieceIndex === pieces.length - 1;
          const pauseAfterMs = piece.pauseAfterMs + (last ? span.pause_ms_after : 0);
          if (waiting !== null && !sameRun(where, waiting)) flush();
          if (piece.words === '') {
            // 只有提示：等着接到下一句的开头
            waiting = {
              ...where,
              text: waiting === null ? piece.text : `${waiting.text}${piece.text}`,
              directions: [...(waiting?.directions ?? []), ...piece.directions],
              pauseMs: (waiting?.pauseMs ?? 0) + piece.pauseBeforeMs + pauseAfterMs,
            };
            return;
          }
          const directions = [...(waiting?.directions ?? []), ...piece.directions];
          // 这一句的情绪、风格（只给包里脚本的钩子，moodOf；不挑参考，也不交给模型）：接上来的提示里有就用它（它写在这一句前面），没有就是这一段自己的
          const mood = (waiting?.directions ?? []).find((direction) => direction.emotion !== null || direction.style !== null);
          lines.push({
            index: lines.length,
            source: sourceIndex,
            chapter: where.chapter,
            paragraph,
            span: spanIndex,
            voice: span.voice_id,
            text: waiting === null ? piece.text : cueBefore(waiting.text, piece.text),
            words: piece.words, // 去掉提示以后要念的字：挑参考时认语种用，也用来认行首的说话人名字（namePrefixedLines）
            labels,
            hints: hintsOf(mood === undefined ? piece.hints : { emotion: mood.emotion, style: mood.style }),
            directions,
            targetDurationMs: source.targetDurationMs ?? targetDefault, // 这一项的目标时长（第 8 步），项自己的盖过 options 给的，都没有是 null
            speed: source.speed ?? speedDefault ?? null, // 调用方给的语速（见「设定」），项自己的盖过 options 给的，都没有是 null
            expressivenessFrom: (source.expressiveness ?? null) !== null ? 'item' : (expressivenessDefault ?? null) !== null ? 'option' : null, // 这个值是哪一层给的（dub.json 的 units[i].expressivenessFrom，第 7 步）
            expressiveness: source.expressiveness ?? expressivenessDefault ?? null, // 调用方给的起伏（第 7 步），项自己的盖过 options 给的，都没有是 null：这里还不取设定的，buildPlan 再取（第 7 步）
            pauseBeforeMs: piece.pauseBeforeMs + (waiting?.pauseMs ?? 0) + pendingBefore, // 一开头单独成段的停顿，算在第一句前面
            pauseAfterMs,
            sceneBefore: sceneAhead, // 和上一句之间有整行只有停顿的一行（场景的边界，第 5c 步；只在库里用，不进报告）
          });
          sceneAhead = false;
          waiting = null;
          pendingBefore = 0;
        });
        if (pauseLines.some((line) => line > lastPieceLine) || markerLine) sceneAhead = true;
      });
    });
    flush(); // 提示不跨项
    chapterOffset += chapters.length;
    paragraph += 1; // 一项是一段话的边界
  });
  return { lines, voices };
}

/**
 * 只有提示的一截接到一句的开头、末尾。字符类只写在 protocol/lib/word-spacing.mjs：
 *   开头：同请求开头的提示（lib/opening-cue.mjs 的 cueThenText）：这一句的第一个字是词和词之间写空格的字（SPACED_WORD：拉丁字母，带重音的也算，希腊、西里尔字母，谚文，数字）
 *         留一个空格（[angrily] Stop it.、[生气] Ça suffit.），别的直接接（[生气]站住！）；
 *   末尾：这一句的最后一个字是 SPACED_WORD，或者英文的收尾标点（LATIN_CLOSING 里的 . , ! ? ; :），留一个空格（Стой, хватит [叹气]、Fine. [sighs]），别的直接接（站住[叹气]）。
 *         「最后一个字」先去掉末尾的提示（一句以提示收尾的，提示自己的「]」不算英文的收尾标点：站住[笑][叹气]、Hello there [laughs] [sighs]），
 *         再隔着收尾的引号、括号、省略号、破折号和尖括号标签看（word-spacing.mjs 的 lastWrittenChar：他说：“走吧。”[叹气]、He said, "Go." [sighs]）。
 */
const cueBefore = cueThenText;
const TRAILING_CUES = new RegExp(`(?:\\s*${CUE_PATTERN})+\\s*$`, 'u');
function cueAfter(text, cue) {
  const last = lastWrittenChar(text.replace(TRAILING_CUES, ''));
  return SPACED_WORD.test(last) || LATIN_CLOSING.test(last) ? `${text} ${cue}` : `${text}${cue}`;
}

// ---------------------------------------------------------------- 分段

const count = (text) => [...text].length;
/**
 * 两段要念的话接起来（分段和并段用同一个规则，程序在 protocol/lib/word-spacing.mjs 的 joinWritten）：接的地方有一边是汉字、假名或它们的全角标点
 * （隔着引号、括号看），中间不加空格；别的加一个空格，韩文和英文一样（词和词之间本来就有空格）。
 */
const joinSpoken = joinWritten;

// 切分时不从中间切开的一块：提示（方括号，语法见 tools/markup.mjs 的文件头「提示」）；一对尖括号标签连同它包住的字、一个音素标记（同一个文件头「尖括号标签」）
const WHOLE_RE = new RegExp(`${CUE_PATTERN}|${TAG_BLOCK_PATTERN}`, 'gu');
/**
 * 一段文字里不切开的几块，[开头, 末尾] 的位置，按次序。一对标签连同它包住的字放不进一段（fits，见 partsOf）的，整块放不进一段：只有它两头的标签各是一块，
 * 包住的字照常切（里面的提示、标签照样是一块），名字记进 long（partsOf 给切开的每一段两头补上这一对标签，见 rebalance）。
 */
function blocksOf(text, fits, long = new Set()) {
  const blocks = [];
  for (const match of text.matchAll(WHOLE_RE)) {
    const start = match.index;
    const end = start + match[0].length;
    if (match.groups?.tag === undefined || fits(match[0])) {
      blocks.push([start, end]);
      continue;
    }
    long.add(match.groups.tag);
    const inner = start + match[0].indexOf('>') + 1;
    const close = start + match[0].lastIndexOf('</');
    blocks.push([start, inner]);
    for (const [from, to] of blocksOf(text.slice(inner, close), fits, long)) blocks.push([inner + from, inner + to]);
    blocks.push([close, end]);
  }
  return blocks;
}
/** 一段文字按「不切开的一块或一个字」分开：硬切时只在两个之间切。blocks 是 blocksOf 的结果。 */
function atomsOf(text, blocks) {
  const atoms = [];
  let at = 0;
  let next = 0;
  while (at < text.length) {
    while (next < blocks.length && blocks[next][0] < at) next += 1;
    const end = next < blocks.length && blocks[next][0] === at ? blocks[next][1] : at + String.fromCodePoint(text.codePointAt(at)).length;
    atoms.push(text.slice(at, end));
    at = end;
  }
  return atoms;
}
/** 紧跟在一块后面、跟着前面走的标点（，。！？、」）这一类）：切口挪到一块的末尾时连它们一起带上，不让后一截以标点开头。 */
const TRAILING_PUNCTUATION = /^[\p{Po}\p{Pe}\p{Pf}]+/u;
/**
 * text 切开的几截（按次序，可以去掉了两头的空白）里，切口落在不切开的一块（blocks，blocksOf 的结果）中间的，切口挪到这一块的末尾（连紧跟着的标点）：
 * 这一块整个留在前一截里，后一截从挪过去的切口起（切口后面的空白也在后一截里，要去掉的调用方自己去），整截都在切口前面的并进前一截。
 * 两截的字照 text 的原文取。返回 [{ text, tail }]：tail 是这一截从原来一截的中间起（原来那一截的开头挪进了前一截）。
 */
function keepWhole(text, pieces, blocks) {
  const out = [];
  let moved = null; // 上一个切口挪到的位置：下一截从这里起
  let cursor = 0;
  for (const piece of pieces) {
    const at = text.indexOf(piece, cursor);
    const end = at + piece.length;
    cursor = end;
    const from = moved ?? at;
    if (end <= from) continue; // 整截都在挪过去的切口前面，已经在前一截里
    const block = blocks.find(([start, stop]) => start < end && end < stop);
    const cut = block === undefined ? end : block[1] + (TRAILING_PUNCTUATION.exec(text.slice(block[1]))?.[0].length ?? 0);
    out.push({ text: text.slice(from, cut), tail: from > at });
    moved = block === undefined ? null : cut;
  }
  return out;
}

/** 有字母或数字（提示、标签里的也算）：没有的一截只剩标点、空白，不单独成一段（breakLong）。 */
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
/**
 * 把放不下的一句按逗号一类的停顿处再切；还放不下硬上限（hard）的，才在字与字之间硬切（提示、尖括号标签不切开，见 blocksOf、atomsOf）。fits、hard 见 partsOf。
 * 软上限（要念的字）只切到逗号一类的地方，不硬切：没有 hard（没有 maxChars），或者一截放得下 hard，就照原样留着，可以比软上限长（不在一个词中间切开）。
 * 切出来只有标点、空白（没有字母、数字）的一截，并进前一截（是第一截就和后一截并）：不发只有一个句号的请求，所以一截可能比上限多出几个标点。
 */
function breakLong(sentence, fits, hard) {
  const clauses = keepWhole(sentence, sentence.split(/(?<=[，,、;；:：])/), blocksOf(sentence, fits)).map((clause) => clause.text);
  const out = [];
  let current = '';
  for (const clause of clauses) {
    if (current !== '' && !fits(current + clause)) {
      out.push(current);
      current = '';
    }
    current += clause;
  }
  if (current !== '') out.push(current);
  const pieces = out.flatMap((piece) => {
    if (fits(piece) || hard === null || hard(piece)) return [piece];
    const cuts = [];
    let cut = '';
    for (const atom of atomsOf(piece, blocksOf(piece, hard))) {
      if (cut !== '' && !hard(cut + atom)) {
        cuts.push(cut);
        cut = '';
      }
      cut += atom;
    }
    if (cut !== '') cuts.push(cut);
    return cuts;
  });
  const kept = [];
  for (const piece of pieces) {
    if (kept.length > 0 && !LETTER_OR_DIGIT.test(piece)) kept[kept.length - 1] += piece;
    else if (kept.length === 1 && !LETTER_OR_DIGIT.test(kept[0])) kept[0] += piece;
    else kept.push(piece);
  }
  return kept;
}

/**
 * 一句话切成放得下的几段：先按句子，再把相邻的句子并起来，装不下的才再切。fits(文字) 说一段放不放得下（两个上限，见 partFits），是 null 就不切；
 * hard(文字) 只看硬上限（见 hardFits），是 null 就不在字与字之间硬切（breakLong：软上限只切到逗号一类的地方）。
 * 提示、尖括号标签不切开（keepWhole、atomsOf）；只有提示、没有字的一截接到下一截的开头
 * （是最后一截就接在前一截的末尾）；一对标签连同包住的字放不下的，在里面照常切，每一段两头补上这一对标签（rebalance）。
 * 所以一段可能比上限多出几个提示、标签的字（文件头第 5 步）。
 * 返回 [{ text, opens }]：opens 是这一段从一句话的开头起（第一段总是）；false 是切在一句话中间（一句放不下，在逗号一类的地方或者硬切开的；或者分句的切口挪过一对标签，后一截是一句话的后半），第 5c 步的切口不加停顿。
 * 句子的边界只看分句（tools/sentences.mjs：句末后面的提示跟着后一句，接不接看提示后面的字），breakLong 在一句里面切出来的第二截起都是一句话中间。
 * 只有提示的一截挪到下一截开头的，切口挪到了提示前面：这几截（提示的和下一截）里有一截从一句话的开头起，opens 就是 true
 * （例如一句开头的提示比上限还长、单独成了一截，后面的字在这一句里又切开：提示那截从句首起，后面那截在一句话中间）。
 * 句号后面的提示不会单独成一截（跟着后一句；英文句号后面不空格就接提示的，那里整个不切，见 tools/sentences.mjs）。
 * 句末的提示只有在全文最后才单独剩下（分句把它接在前一句里，这一句放不下时 breakLong 可能把它切成单独的一截），那时接在前一截的末尾（cueAfter）。
 */
function partsOf(text, fits, hard) {
  if (fits === null || fits(text)) return [{ text, opens: true }];
  const long = new Set(); // 放不下、要在里面切开的几对标签的名字
  // 分句；切口挪过一块的，后一截是一句话的后半（tail），不从一句话的开头起
  const sentences = keepWhole(text, splitSentences(text), blocksOf(text, fits, long))
    .map((sentence) => ({ text: sentence.text.trim(), opens: !sentence.tail })).filter((sentence) => sentence.text !== '')
    .flatMap((sentence) => (!fits(sentence.text)
      ? breakLong(sentence.text, fits, hard).map((piece, k) => ({ text: piece, opens: k === 0 && sentence.opens }))
      : [sentence]));
  const parts = [];
  let current = '';
  let opens = true;
  for (const sentence of sentences) {
    const joined = current === '' ? sentence.text : joinSpoken(current, sentence.text);
    if (current !== '' && !fits(joined)) {
      parts.push({ text: current, opens });
      current = sentence.text;
      opens = sentence.opens;
    } else {
      if (current === '') opens = sentence.opens;
      current = joined;
    }
  }
  if (current !== '') parts.push({ text: current, opens });
  // 只有提示的一截：接到下一截的开头（opens：这几截里有一截从一句话的开头起就是 true，见上），最后一截接到前一截的末尾
  const kept = [];
  let cue = '';
  let cueOpens = false;
  for (const part of parts) {
    if (wordsOf(part.text) === '') {
      cue = cue === '' ? part.text.trim() : `${cue}${part.text.trim()}`;
      cueOpens ||= part.opens;
      continue;
    }
    kept.push(cue === '' ? part : { text: cueBefore(cue, part.text.trimStart()), opens: cueOpens || part.opens });
    cue = '';
    cueOpens = false;
  }
  if (cue !== '') {
    if (kept.length === 0) return [{ text, opens: true }];
    kept[kept.length - 1] = { ...kept[kept.length - 1], text: cueAfter(kept[kept.length - 1].text.trimEnd(), cue) };
  }
  return rebalance(kept, long);
}

/** 成对标签的一头（<名字>、</名字>，tools/markup.mjs「尖括号标签」）。 */
const PAIRED_TAG_RE = new RegExp(PAIRED_TAG_PATTERN, 'g');
const nameOfTag = (tag) => tag.replace(/^<\/?|>$/g, '');
/**
 * 放不下、被切开的几对标签（名字在 names 里）：每一段两头补上这一对标签，前面的段没关上的在这一段开头补 <名字>，到这一段末尾还没关上的在末尾补 </名字>；
 * 补出来空的一对（这一段开头就是 </名字>、末尾就是 <名字>）去掉。别的标签不动。<soft>甲。乙。</soft> 切成 <soft>甲。</soft> 和 <soft>乙。</soft>。
 */
function rebalance(parts, names) {
  if (names.size === 0) return parts;
  let open = [];
  return parts.map((part) => {
    const before = open;
    open = [...open];
    for (const [tag] of part.text.matchAll(PAIRED_TAG_RE)) {
      const name = nameOfTag(tag);
      if (!names.has(name)) continue;
      if (!tag.startsWith('</')) open.push(name);
      else if (open.lastIndexOf(name) !== -1) open.splice(open.lastIndexOf(name), 1);
    }
    let text = `${before.map((name) => `<${name}>`).join('')}${part.text}${[...open].reverse().map((name) => `</${name}>`).join('')}`;
    for (const name of names) text = text.replace(new RegExp(`<${name}>(\\s*)</${name}>`, 'g'), '$1'); // 名字只有字母、数字、下划线、连字符，放进正则不用转义
    return { ...part, text: text.trim() };
  });
}

/** 一段发出去的文字里没配上对的成对标签（tag_pair_split）：先是没有开头的收尾标签，再是没关上的，写法照原样（</whisper>、<whisper>）。<|…|> 和音素标记不算。 */
function unpairedTags(text) {
  const open = [];
  const stray = [];
  for (const [tag] of text.matchAll(PAIRED_TAG_RE)) {
    if (!tag.startsWith('</')) {
      open.push(tag);
      continue;
    }
    const k = open.map(nameOfTag).lastIndexOf(nameOfTag(tag));
    if (k === -1) stray.push(tag);
    else open.splice(k, 1);
  }
  return [...stray, ...open];
}

/** 注意 tag_pair_split（文件头「说明」）：found 是 [{ unit, tags }]，unit 是段的编号（从 0 起），tags 是 unpairedTags 的结果。 */
function tagPairNote(found) {
  const where = found.map(({ unit, tags }) => `piece ${unit + 1} (${tags.join(', ')})`).join('; ');
  return {
    code: 'tag_pair_split',
    message: `In ${found.length} ${found.length === 1 ? 'piece' : 'pieces'} of the text sent out, paired tags do not pair up: ${where}. The model gets half a pair. Most likely a pair was split across two requests: a [pause …] in between does not fit in a request, or the pair spans a line break, a chapter or a voice change; or one end is missing from the script. Write a pair of tags within one line, with none of these in between; to pause, write a pair on each side of the pause`,
    details: { units: found },
  };
}

// ---------------------------------------------------------------- 短句并段（第 5b 步）

/** 能不能把 before 和后面的 after 并成一段（规则见文件头第 5b 步）。sameTarget：目标时长归同一项（第 8 步）。 */
function canJoin(before, after, limits, sameTarget) {
  if (before.pauseAfterMs !== 0 || after.pauseBeforeMs !== 0 || !sameTarget(before, after) || !sameOpening(before, after)) return false;
  if (before.speed !== after.speed || before.expressiveness !== after.expressiveness || before.pick.segmentId !== after.pick.segmentId || before.pack !== after.pack) return false; // 一个请求只带一个起伏（第 7 步）：值不同的不并
  return fitsRequest(joinSpoken(before.spoken, after.spoken), openingChars(before), limits); // 开头的提示算进 maxChars（第 7a 步）
}

/** 两段并成一段：要念的话接起来（各段的提示跟着各自的字）；停顿跟着两头的位置走；记下并了哪几句（joined）。原文 text 同一句的几段（分段的）不重复。 */
function joinedUnit(before, after) {
  const members = before.joined ?? [{ line: before.line, part: before.part }];
  return {
    ...before,
    spoken: joinSpoken(before.spoken, after.spoken),
    text: before.line === after.line ? before.text : joinSpoken(before.text, after.text),
    pauseAfterMs: after.pauseAfterMs,
    joined: [...members, { line: after.line, part: after.part }],
    ...(before.expressivenessFrom === after.expressivenessFrom ? {} : { expressivenessFrom: 'mixed' }), // 值一样才并得进来（第 7 步），来自不同的层时照实写
  };
}

/**
 * 短句并段：前一段不到下限，就并进后面的一段，直到够下限或者没有可并的（和 app 的 fitMinLength 一样的走法）。
 * @returns {object[]} 段的编号按并完以后的次序重排（index）
 */
function joinShortUnits(units, { min, limits, sameTarget }) {
  const out = [];
  units.forEach((unit) => {
    const last = out.length - 1;
    // 场景的 unit（第 5a 步）不并：它不是一句短话，下限（voice-cloning 的）管不到它
    if (last >= 0 && !isScene(out[last]) && !isScene(unit) && spokenLength(out[last].spoken) < min && canJoin(out[last], unit, limits, sameTarget)) {
      out[last] = joinedUnit(out[last], unit);
      return;
    }
    out.push({ ...unit });
  });
  return out.map((unit, index) => ({ ...unit, index }));
}

/** 比下限短、并不了的那一段的错。不是暂时出错：不标 transient，不重做（见文件头第 5b 步）。 */
const tooShortError = (spoken, min) => ({
  code: TEXT_TOO_SHORT,
  message: `This piece is shorter than the minimum of the synthesis capability: ${spokenLength(spoken)} characters, the minimum is ${min}; not synthesized`,
  details: { chars: spokenLength(spoken), min },
});

/** 还要做的段（不是一场戏）里，发出去的字比下限 min 短的，记成 failed（text_too_short）。什么时候判，见文件头第 5b 步。 */
function markTooShort(units, min) {
  for (const unit of units) {
    if (unit.status !== 'planned' || isScene(unit) || spokenLength(unit.spoken) >= min) continue;
    unit.status = 'failed';
    unit.error = tooShortError(unit.spoken, min);
  }
}

/** 还没有一句成功、已经有 TEXT_REJECTED_LIMIT 句被服务商拒了（文件头「一段失败了怎么办」）：停下。rejected 是被服务商拒的段，按被拒的次序。 */
const textRejectedStop = (rejected) =>
  new VoicePackError('dub_text_rejected', `${rejected.length} lines have been rejected by the provider and none has succeeded yet: this may not be a problem with the text of these lines but a reference or other input being blocked (then every line is rejected). Stopped, no new lines are started; pieces already finished are passed to onUnit as usual; the rejected pieces and lines are in details.rejected`, {
    details: { limit: TEXT_REJECTED_LIMIT, rejected: rejected.map((unit) => ({ unit: unit.index, line: unit.line })) },
  });
/**
 * 调用之前就查出来的文字错（适配器自己的检查：空白、太长、有处理不了的字；code 是 capability_input_invalid，约定见 vocab/capability-signatures.md）：
 * 那是这句文字本身的问题，不是服务商拒的，所以不计数（文件头「一段失败了怎么办」）。
 */
const checkedBeforeCall = (error) => error.code === 'capability_input_invalid';

// ---------------------------------------------------------------- 这一句的情绪、风格（给包里脚本的钩子）

/** 调用方或设定给的一项标签：没给（undefined、null、空字符串）是 undefined。写法在挑参考时已经查过（lib/reference-pick.mjs，写错报 pick_input_invalid）。 */
const givenLabel = (labels, key) => (typeof labels?.[key] === 'string' && labels[key] !== '' ? labels[key] : undefined);

/**
 * 这一句的情绪、风格，只交给包里脚本的钩子（hookUnit 的 emotion、style）：不挑参考（lib/reference-pick.mjs），也不交给模型（提示已经在文字里，文件头开头）。
 * 每一项分别按这个顺序取，取到就停（不是整组取：调用方给了其中一项，别的项照样往后看）：
 *   调用方给的（line.labels）→ 舞台说明读出的（line.hints，cuesInPlace 读的）→ 设定的 labels。
 * 取到的写成规范名字（lib/line-hints.mjs 的 canonicalLabel，近义词认作同一个），都没有是 null。
 * @returns {{ emotion: string|null, style: string|null }}
 */
function moodOf(line, setupLabels) {
  const mood = {};
  for (const key of ['emotion', 'style']) {
    const value = givenLabel(line.labels, key) ?? line.hints[key] ?? givenLabel(setupLabels, key);
    mood[key] = value === undefined || value === null ? null : canonicalLabel(key, value);
  }
  return mood;
}

// ---------------------------------------------------------------- 请求开头的提示（设定）

/**
 * 一句（lines[i]）在它的包里，请求开头要加的提示（文件头「设定」，怎么合在 lib/opening-cue.mjs）：情绪、风格、能量取调用方给的标签（line.labels），
 * 每一项没有再取设定的（setup.labels）。说明（setup.instructions）不在里面：不发给模型（设定的说明由规划的 notes 里的 setup_instructions 列出，setupInstructionsNotes）。opening 都没有是 null（unit 上就没有 openingCue）。
 * added：这一句开头是不是台本自己写的提示（或者舞台说明换成的提示）：是就不加（false），照台本。同一句切开的几段都照这一句的开头算。
 * skipped：取到了、没合进去的一下子的声音（lib/opening-cue.mjs 的 skipped，第 7a 步「限长」），规划的 notes 照它说明（skippedCueNotes）；这一句开头台本自己写了提示的不列（本来就不加）。
 * 要加的提示合成以后整条超过 MAX_OPENING_CUE_WORDS 个词（第 7a 步「限长」的兜底：情绪、风格写了词表以外的一长串），报 dub_input_invalid；这一句开头台本自己写了提示的不报（提示不会发出去）。
 * @returns {{ opening: { cue: string, added: boolean, parts: object } | null, skipped: object[] }}
 * @throws {VoicePackError} dub_input_invalid（details: { field: 'openingCue', line, cue, words, limit }）
 */
function openingOf(line, setup) {
  const setupItems = setup === null ? {} : pickItems(setup.labels);
  const composed = openingCueOf(pickItems(line.labels), setupItems);
  const added = !opensWithCue(line.text);
  const words = composed.cue === null ? 0 : cueWords(composed.cue);
  if (added && words > MAX_OPENING_CUE_WORDS) {
    const from = Object.entries(composed.parts).map(([item, part]) => `${OPENING_ITEM_NAMES[item]} from ${part.from === 'caller' ? 'the caller' : 'the setup'}`).join(', ');
    throw new VoicePackError('dub_input_invalid', `The opening cue ${composed.cue} of line ${line.index + 1} counts ${words} words, over the limit of ${MAX_OPENING_CUE_WORDS} words (${from}; two Chinese characters or kana count as one word). For emotion and style use the short words of the tag vocabulary (vocab/cues.json): shorten what the caller gave; for what the setup gave, override it with the same item from the caller (on the command line a shorter --emotion or --style), or use no setup (command line --no-setup), or change the setup in the pack`, { details: { field: 'openingCue', line: line.index, cue: composed.cue, words, limit: MAX_OPENING_CUE_WORDS } });
  }
  return { opening: composed.cue === null ? null : { cue: composed.cue, added, parts: composed.parts }, skipped: added ? composed.skipped : [] };
}
/**
 * 开头的提示里取到了、没合进去的一下子的声音（第 7a 步「限长」），写成规划的 notes：同一个包、同一个来处（调用方、设定）、同一项、同一个声音一条 one_shot_style_skipped，lines 是哪几句（从 0 起）。
 * skipped 是 [{ item, value, from, line, pack, setup }]（pack 是那一句的包，setup 是它用的设定）。many 为真（几个包）时 message 开头点名包、details 另有 pack（包 ID）。
 */
function skippedCueNotes(skipped, many) {
  const groups = new Map(); // 包、来处、项、声音 -> 那几句
  for (const item of skipped) {
    const key = [item.pack.manifest.id, item.from, item.item, item.value].join('\u0000');
    const seen = groups.get(key) ?? { ...item, lines: [] };
    if (!seen.lines.includes(item.line)) seen.lines.push(item.line);
    groups.set(key, seen);
  }
  return [...groups.values()].map((group) => {
    const source = group.from === 'setup' ? `from setup ${JSON.stringify(group.setup)}` : 'given by the caller';
    const message = `The ${OPENING_ITEM_NAMES[group.item]} "${group.value}" ${source} is a sudden sound, so it is not merged into the opening cue of each request (the opening cue sets how the whole line is said; merged in, it would become the way the whole line is said): ${group.lines.length === 1 ? 'line' : 'lines'} ${group.lines.map((line) => line + 1).join(', ')}. To get that sound, write it in the script where it happens, for example [sighs] for a sigh (how to write them: models/scene3.md「Sudden sounds and pauses」)`;
    return {
      code: 'one_shot_style_skipped',
      message: many ? `${group.pack.manifest.name}: ${message}` : message,
      details: { item: group.item, style: group.value, from: group.from, ...(group.from === 'setup' ? { setup: group.setup } : {}), lines: group.lines, ...(many ? { pack: group.pack.manifest.id } : {}) },
    };
  });
}
/**
 * 用了一套带说明（instructions）的设定，写成规划的 notes：每个用了这样一套设定的包一条 setup_instructions（文件头「说明」），给写台本的人看：
 * 说明的原文，哪几句用了这套设定，照说明在台本里写具体的，dub 不把说明发给模型。entries 是 [{ line, pack, setup, instructions }]（那一句、它的包、设定的名字、说明）。
 * many 为真（几个包）时 message 开头点名包、details 另有 pack（包 ID）。
 */
function setupInstructionsNotes(entries, many) {
  const groups = new Map(); // 包 -> 那几句
  for (const entry of entries) {
    const seen = groups.get(entry.pack) ?? { ...entry, lines: [] };
    seen.lines.push(entry.line);
    groups.set(entry.pack, seen);
  }
  return [...groups.values()].map((group) => {
    const message = `The instructions of setup ${JSON.stringify(group.setup)} are for the person writing the script, and dub does not send them to the model: "${group.instructions}"; ${group.lines.length === 1 ? 'line' : 'lines'} ${group.lines.map((line) => line + 1).join(', ')} use this setup. Follow the instructions by writing the specifics in the script, where they happen: put wording and particles directly in the line, write a common character that is read differently as a character with that reading, and put a short cue in front of the few characters where tone, ending sound or rhythm changes (how to write them: models/scene3.md「What to write」「Cross-language and accent」)`;
    return {
      code: 'setup_instructions',
      message: many ? `${group.pack.manifest.name}: ${message}` : message,
      details: { setup: group.setup, instructions: group.instructions, lines: group.lines, ...(many ? { pack: group.pack.manifest.id } : {}) },
    };
  });
}
/** 开头的提示的几项，给人看的名字。 */
const OPENING_ITEM_NAMES = Object.freeze({ emotion: 'emotion', style: 'style', energy: 'energy' });
/** 标签里合成提示用的三项（语言不在提示里：它用来挑参考）。 */
const pickItems = (labels) => ({ emotion: labels?.emotion, style: labels?.style, energy: labels?.energy });
/** 两段开头的提示一样（都没有也算一样）：不一样的不并进一个请求（第 5b、5c 步），不然后一段的那条提示就丢了。 */
const sameOpening = (a, b) => (a.openingCue?.cue ?? null) === (b.openingCue?.cue ?? null);
/** 这个请求开头真要加的提示：没有、或者台本开头自己写了（added 为 false），是 null。 */
const cueToAdd = (opening) => (opening?.added === true ? opening.cue : null);
/** 发给模型的台词（第 7c 步）：名字对只留参考语言里的名字；跨语言的请求结尾写语言。 */
const markedLine = (text, marks) => (marks === undefined ? lineNameOnly(text) : withLineLanguage(lineNameOnly(text), marks.language));
/** 发给模型的参考的文字（第 7c 步）：跨语言的，开头写台词语言里的名字，结尾写参考的语言；同语言、台词开头是包名的（name），开头写这个名字。 */
const markedReference = (text, marks, name) => (marks !== undefined ? withReferenceMarks(text, marks) : name === undefined ? text : `[${name}]${text}`);
/** 这一段做请求的开头时，开头的提示占几个字（提示加上它和文字之间的空格；不加就是 0）：算进 maxChars（第 7a 步）。 */
function openingChars(unit) {
  const cue = cueToAdd(unit.openingCue);
  return cue === null ? 0 : count(withOpeningCue(unit.spoken, cue)) - count(unit.spoken.trimStart());
}
/**
 * 按句子切的时候（第 5 步），一个请求里留给文字的字数：maxChars 减去开头的提示和一个空格（没有上限或者不加提示是 max）。
 * roomFits(max, cue) 返回「一段文字放不放得下」的判断：放得下就是放得下；放不下、剩下的又不到 MIN_ROOM 个字，报 dub_input_invalid（第 7a 步「限长」的兜底），
 * 不按它切成每段几个字（那样每个请求都比 maxChars 多出来，每段都带着那条提示）。整句放得进一个请求的，照发，不报。
 * @throws {VoicePackError} dub_input_invalid（details: { field: 'maxChars', maxChars, cue, room, min }）
 */
const MIN_ROOM = MIN_MAX_CHARS; // maxChars 的下限（lib/synthesis-limits.mjs）
function roomFits(max, cue) {
  if (max === null) return () => true;
  const room = cue === null ? max : max - count(cue) - 1;
  return (text) => {
    if (count(text) <= room) return true;
    if (cue !== null && room < MIN_ROOM) {
      throw new VoicePackError('dub_input_invalid', `The opening cue ${cue} with the space after it takes ${count(cue) + 1} characters, and a request sends at most ${max} characters (maxChars), leaving only ${room} for the line, fewer than ${MIN_ROOM}: this line does not fit in one request, and cut this way each piece would have only a few characters. Give a larger maxChars (command line --max-chars), or shorten the opening cue (the emotion, style or energy given by the caller or by the setup)`, { details: { field: 'maxChars', maxChars: max, cue, room, min: MIN_ROOM } });
    }
    return false;
  };
}

// 一个请求的两个上限（第 5、5a、5b、5c 步都按这两条）：要念的字不超过 maxSpokenChars（lib/synthesis-limits.mjs 的 spokenLength 数，默认 DEFAULT_MAX_SPOKEN_CHARS），
// 发出去的字（码位）连开头的提示不超过 maxChars（环境声明的或调用方给的）。两条都要满足；是 null 的那一条不管。

/** 并起来的文字 spoken、开头的提示占 opening 个字，放不放得进一个请求。limits 是 { maxChars, maxSpokenChars }（readOptions 的结果就是）。 */
const fitsRequest = (spoken, opening, { maxChars, maxSpokenChars }) =>
  (maxChars === null || count(spoken) + opening <= maxChars) && (maxSpokenChars === null || spokenLength(spoken) <= maxSpokenChars);

/** 第 5 步按句子切时，一段放不放得下（交给 partsOf 的 fits）：发出去的字按 roomFits 给开头的提示 cue 留出位置。两个上限都没有是 null（不切）。 */
function partFits({ maxChars, maxSpokenChars }, cue) {
  if (maxChars === null && maxSpokenChars === null) return null;
  const fitsRoom = roomFits(maxChars, cue);
  return (text) => fitsRoom(text) && (maxSpokenChars === null || spokenLength(text) <= maxSpokenChars);
}
/**
 * 第 5 步硬切（一句在逗号一类的地方还放不下，在字与字之间切）时，一段放不放得下（交给 partsOf 的 hard）：只看发出去的字（maxChars，硬上限），
 * 要念的字的上限（软上限）不硬切。没有 maxChars 是 null（不硬切）。
 */
function hardFits({ maxChars }, cue) {
  if (maxChars === null) return null;
  return roomFits(maxChars, cue);
}

/**
 * 第 5a 步：一场里相邻两段（before 是前一段，next 是后一段）之间写进请求的停顿：写法和第 5c 步是同一个（lib/pause-in-request.mjs 的 pauseWriting，只看前一段怎么收尾）。
 * 写法是空串就什么都不加（没有停顿的，和写法挑出来是什么都不加的，例如句末标点后面）。
 */
const scenePauseWriting = (before, next) => pauseWriting(before.spoken, before.pauseAfterMs + next.pauseBeforeMs);

/** 第 5a 步：两段是不是同一轮。一轮是台本的一行（lines[i].paragraph），被放不下切开的、被停顿切开的几段都还是这一行。 */
const sameTurn = (lines, before, next) => lines[before.line].paragraph === lines[next.line].paragraph;

/** 第 5a 步：同一轮里相邻两段的话接起来。写法是空串的，照第 5 步的规则接（joinSpoken：中文这类什么都不放，英文这类放一个空格）；不是空串的，写法放在中间（写法自己带着要的空格）。 */
const joinInTurn = (before, next, writing) => (writing === '' ? joinSpoken(before, next) : `${before}${writing}${next}`);

/**
 * 第 5a 步：一场戏放不放得进一个请求（交给 lib/scene-in-request.mjs 的 sceneRuns 的 fits(first, last)）。要念的字、发出去的字（后者连每一轮开头加的提示）都按发出去的样子量：
 * 同一轮的两段照 joinInTurn 接，轮与轮之间是写法（去掉末尾的空白）加一个换行。留在请求里的停顿，写进去的字也算（scenePauseWriting）。
 * 量缝的办法同 lib/pause-in-request.mjs 的 requestsOf：量「字 + 缝 + 字」多出来的，接的地方放了几个字、连着的空白算几个才数得对。缝只算一场中间的：这一块最后一段后面的停顿不写进请求。
 * 前缀和，每一段只量一次。
 */
function sceneFits(units, { maxChars, maxSpokenChars }, lines) {
  const opensTurn = (k) => k === 0 || !sameTurn(lines, units[k - 1], units[k]);
  const seam = (k) => {
    if (k + 1 >= units.length) return { spoken: 0, sent: 0 };
    const [before, next] = [units[k].spoken, units[k + 1].spoken];
    const writing = scenePauseWriting(units[k], units[k + 1]);
    const joined = sameTurn(lines, units[k], units[k + 1]) ? joinInTurn(before, next, writing) : `${before}${writing.trimEnd()}\n${next}`;
    return { spoken: spokenLength(joined) - spokenLength(before) - spokenLength(next), sent: count(joined) - count(before) - count(next) };
  };
  const seams = units.map((_, k) => seam(k));
  const spoken = [0];
  const sent = [0];
  units.forEach((unit, k) => {
    spoken.push(spoken[k] + spokenLength(unit.spoken) + seams[k].spoken);
    sent.push(sent[k] + count(unit.spoken) + seams[k].sent + (opensTurn(k) ? openingChars(unit) : 0));
  });
  return (first, last) => (maxSpokenChars === null || spoken[last + 1] - spoken[first] - seams[last].spoken <= maxSpokenChars)
    && (maxChars === null || sent[last + 1] - sent[first] - seams[last].sent + (opensTurn(first) ? 0 : openingChars(units[first])) <= maxChars);
}

// ---------------------------------------------------------------- 规划

const emptyEnhancers = (offers) => ({ offered: offers.map(summarizeOffer), used: [], notUsed: [], statement: null });

/**
 * 5c：放得下就一个请求。台本里同一章、同一个声音的相邻几段（一行里被停顿隔开的几段，和几行）并成一次请求，行和行之间换行，中间的短停顿写在文字里
 * （一处停顿不超过 maxPauseMs：options.maxPauseInRequestMs，环境声明的，没声明用 lib/pause-in-request.mjs 的默认值），长过它的停顿在那里切开，交给拼接。
 * 各段的提示跟着各自的字，并起来照样在原位；后面没写提示的句子在同一个请求里，接着前面的说法。切开的后一个请求不重复前一个的提示：提示只在台本写它的地方（第 2 步）。
 * 停顿怎么写、放不下时切在哪是 lib/pause-in-request.mjs 的；这里只决定哪两段能并、两段之间是哪种边界：
 *   能并：同一章；同一个声音（[voice:] 写的名字，换了就切）；同一个包；同一个参考段；同一个语速；同一条开头的提示（第 7a 步：不一样的并了，后一段的那条就丢了）；包里没有配音脚本；
 *   换了一行时，这一行要加设定的提示（openingCue.added 为 true），前面这一串里（会和它并成一个请求的几段）已经有台本自己写的提示（开头的 added 为 false，或者文字里有提示，
 *   行首、句中都算）的不并：并进去，这一行就接着台本的说法，没有设定的那条了（第 7a 步）。前面从头到尾都是设定的提示的，照旧并；
 *   linesApart（调用方给了 scene: false，明说分开）：行和行不并，一行一个请求；
 *   都还要做（不是规划时就记成 failed 的），都不是一场戏。项和项之间是不同的章，不并。并起来要放得进一个请求：两个上限（limits，见 fitsRequest 上面），发出去的字连这个请求开头要加的提示一起算。
 *   边界：同一行里是 sentence；换了一行是 paragraph；两行之间有整行只有停顿的一行（[pause …]，或者读成停顿的舞台说明）是 scene，停顿写在行尾、行首的照 paragraph 算。
 *   放不下时先切 scene，再 paragraph，再 sentence。
 * 并起来的请求用第一段的开头提示。
 * 包里登记了配音脚本的不并：text 钩子要看到每一句的原话（几个包时，只看这一句所在的包有没有脚本）。
 * 并起来的段：unit.spoken 是发出去的文字（停顿的写法在里面）；unit.joined 写明并了哪几句；停顿在它的两头（unit.pauseBeforeMs、unit.pauseAfterMs），
 * 中间的已经在文字里，拼接的人不再插静音。unit.pick 是第一段的，但 pick.directions 列着每个成员的舞台说明（pickOf 取一句台词的挑参考结果），
 * 有一个成员是跨语言的（pick.crossLanguage），并起来的 pick.crossLanguage 就是 true：语言不同、参考段一样的几行照样并。
 * 跨语言的成员都是跟着自己那一行用的段（pick.followsLine，见 paragraphPicks），并起来的 pick.followsLine 才是 true。
 * 因为放不下切开的，后一块的 unit.cutBefore 写着边界（'scene'、'paragraph'、'sentence'）；
 * 只因为换了参考段切开的（一段话一段参考，同一个包里就是换了语言、包里有那种语言的默认段），后一块的 unit.cutBefore 是 'language'。
 * 切口的气口（文件头第 5c 步）：dub 自己切开的缝（ownSeam：两段都要做、都不是一场戏，同一章、同一个声音、同一个包，明说分开时同一行；也就是说，换了参考段、语速、开头的提示，
 * 包里有脚本，或者放不下，才没并成一个请求），台本在缝上没写停顿的，后一块的 pauseBeforeMs 是 CUT_PAUSE_MS，unit.cutPause 是 'paragraph'（行与行之间）或 'sentence'（同一行里）。
 * 切口在一句话中间的（midSentence(后一块) 为 true：第 5 步一句放不下、在逗号一类的地方或者硬切开的）不加，cutBefore 照旧是 'sentence'。
 * @returns {{ units: object[], joins: number, languageCuts: number[] }} joins 是并进请求、写在文字里的停顿有几处；languageCuts 是因为换了语言切开的几处（切口后面那一段的编号）。
 *   因为放不下切开的几处，看段上的 cutBefore（注意 cut_to_fit 照它列，见 cutNote）
 */
function joinIntoRequests(units, { lines, limits, maxPauseMs, hasScripts, pickOf, linesApart, midSentence }) {
  // 一个缝的停顿：前一段的后面，加上后一段的前面（照加；上限是 maxPauseMs，在 requestsOf 里）
  const items = units.map((unit, at) => ({
    text: unit.spoken,
    pause: at + 1 < units.length ? unit.pauseAfterMs + units[at + 1].pauseBeforeMs : unit.pauseAfterMs,
    at,
  }));
  // 一段的头、尾各在台本的哪一行（5b 并过的一段可能跨行：尾是它最后一个成员的）
  const firstLine = (unit) => lines[unit.line];
  const lastLine = (unit) => lines[unit.joined === undefined ? unit.line : unit.joined[unit.joined.length - 1].line];
  // 台本自己写的提示（第 7a 步）：一段的开头是台本写的（openingCue.added 为 false），或者它的文字里有提示（行首、句中都算；设定的那条不在 spoken 里，发出去时才加）。
  // scriptCues[k] 是第 0 到第 k-1 段里有几段是这样的：一串里有没有，O(1) 查
  const CUE_IN_TEXT = new RegExp(CUE_PATTERN, 'u');
  const scriptCues = [0];
  units.forEach((unit, k) => scriptCues.push(scriptCues[k] + (unit.openingCue?.added === false || CUE_IN_TEXT.test(unit.spoken) ? 1 : 0)));
  // 第 at 段和后一段之间换了一行、后一段要加设定的提示（第 7a 步），前面这一串（第 head 段到第 at 段，会是同一个请求）里已经有台本自己写的提示：并进去，这一行就接着台本的说法、丢了设定的那一条，
  // 所以不并（这一行另起一个请求，带上设定的提示）。前面从头到尾都是设定的提示，照旧并
  const losesOpening = (at, head) => lastLine(units[at]).paragraph !== firstLine(units[at + 1]).paragraph && units[at + 1].openingCue?.added === true && scriptCues[at + 1] - scriptCues[head] > 0;
  const cueCuts = new Set(); // 因为上面这一条才没并的缝（前一段的编号）：不是换了语言切开的
  // 调用方明说分开（scene: false）：一行一个请求，行和行不并（同一行里的几句照旧并）
  const sameLineIfApart = (a, b) => !linesApart || lastLine(a).paragraph === firstLine(b).paragraph;
  // dub 自己切开的缝（切口的气口，第 5c 步）：两段本来可以并，没并是 dub 自己的理由（放不下、参考段、语速、开头的提示、脚本）。章节、换声音、一场戏是台本定的边界，
  // 明说分开时行与行之间是调用方要的：都不算
  const ownSeam = (a, b) => a.status === 'planned' && b.status === 'planned' && !isScene(a) && !isScene(b)
    && lastLine(a).chapter === firstLine(b).chapter && lastLine(a).voice === firstLine(b).voice && a.pack === b.pack && sameLineIfApart(a, b);
  // 两段能不能并（规则见上；台本的提示那一条要看前面这一串，在 canJoin 里）。sameSegment 为 false 时不比参考段：看是不是只因为换了参考段（换了语言）才切开的
  const joinable = (a, b, sameSegment = true) => a.status === 'planned' && b.status === 'planned' && !isScene(a) && !isScene(b)
    // 换声音（[voice:] 写的名字变了，同一个包换了个叫法也算）总是切：和章节一样，不是「放不下才切」
    && lastLine(a).chapter === firstLine(b).chapter && lastLine(a).voice === firstLine(b).voice && a.pack === b.pack
    && (!sameSegment || a.pick.segmentId === b.pick.segmentId) && a.speed === b.speed && sameOpening(a, b) && sameLineIfApart(a, b) && !hasScripts(a) && !hasScripts(b);
  const requests = requestsOf(items, {
    limits: [
      ...(limits.maxChars === null ? [] : [{ max: limits.maxChars, measure: count, extra: (item) => openingChars(units[item.at]) }]), // 开头的提示算进 maxChars（第 7a 步）：按这个请求的第一段算
      ...(limits.maxSpokenChars === null ? [] : [{ max: limits.maxSpokenChars, measure: spokenLength }]), // 开头的提示不念，不算
    ],
    maxPauseMs,
    canJoin: (prev, next, head) => {
      if (losesOpening(prev.at, head.at)) {
        cueCuts.add(prev.at);
        return false;
      }
      return joinable(units[prev.at], units[next.at]);
    },
    // 缝的强弱：同一行里是 sentence；换了一行是 paragraph；两行之间有整行只有停顿的一行是 scene（停顿写在行尾、行首的，照 paragraph 算）
    boundary: (prev, next) => {
      const after = firstLine(units[next.at]);
      if (lastLine(units[prev.at]).paragraph === after.paragraph) return 'sentence';
      return after.sceneBefore ? 'scene' : 'paragraph';
    },
  });
  let joins = 0;
  const languageCuts = [];
  const out = [];
  for (const request of requests) {
    const members = units.slice(request.first, request.last + 1);
    joins += request.pauseCount;
    // 只因为换了参考段才切开的（同一个包里一段话一段参考，所以是换了语言、包里有那种语言的默认段）：cutBefore 是 'language'
    const before = units[request.first - 1];
    const byLanguage = request.cutBefore === undefined && before !== undefined && items[request.first - 1].pause <= maxPauseMs && !cueCuts.has(request.first - 1) && !joinable(before, members[0]) && joinable(before, members[0], false);
    const cut = request.cutBefore !== undefined ? { cutBefore: request.cutBefore } : byLanguage ? { cutBefore: 'language' } : {};
    // 切口的气口（第 5c 步）：dub 自己切开、台本在这里没写停顿（缝的停顿是 0），后一块前面停 CUT_PAUSE_MS，拼接时插成静音；台本写了停顿的照台本。
    // 切口在一句话中间（第 5 步一句放不下、在逗号一类的地方或者硬切开的，后一块是 midSentence）不加：一句话中间不停
    const breath = before !== undefined && items[request.first - 1].pause === 0 && ownSeam(before, members[0]) && !midSentence(members[0])
      ? { pauseBeforeMs: CUT_PAUSE_MS, cutPause: lastLine(before).paragraph === firstLine(members[0]).paragraph ? 'sentence' : 'paragraph' }
      : {};
    if (byLanguage) languageCuts.push(out.length);
    if (members.length === 1) { out.push({ ...members[0], ...cut, ...breath }); continue; }
    const head = members[0];
    const last = members[members.length - 1];
    // 原文：同一句切开的几段不重复；同一行里的几句接起来；换了一行的换一行
    const text = members.reduce((acc, member, k) => {
      if (k === 0 || member.line === members[k - 1].line) return acc;
      return firstLine(member).paragraph === lastLine(members[k - 1]).paragraph ? joinSpoken(acc, member.text) : `${acc}\n${member.text}`;
    }, head.text);
    const joined = members.flatMap((member) => member.joined ?? [{ line: member.line, part: member.part }]);
    // 每个成员的舞台说明都列在 pick.directions 里（一句话的几段共用一份 pick，每句只取一次）
    const directions = [...new Set(joined.map((member) => member.line))].flatMap((line) => pickOf(line).directions ?? []);
    // 跨语言（这一块的语言和用的那段对不上）：有一个成员是，并起来的这一段就是（同一段参考、语言不同的几行也并）；
    // 跨语言的成员都只是跟着自己那一行用的段（followsLine），并起来的才是 followsLine，有一个是包里没有那种语言的就不是
    const crossMembers = members.filter((member) => member.pick.crossLanguage === true);
    const crossLanguage = crossMembers.length > 0;
    const followsLine = crossLanguage && crossMembers.every((member) => member.pick.followsLine === true);
    const { followsLine: headFollows, ...headPick } = head.pick;
    void headFollows;
    out.push({
      ...head,
      text,
      spoken: request.text,
      pick: { ...headPick, directions, ...(crossLanguage ? { crossLanguage } : {}), ...(followsLine ? { followsLine } : {}) },
      pauseAfterMs: last.pauseAfterMs,
      joined,
      ...cut,
      ...breath,
    });
  }
  return { units: out.map((unit, index) => ({ ...unit, index })), joins, languageCuts };
}

/** 切口的说法（unit.cutBefore、注意 cut_to_fit 的 at）。 */
const CUT_LABELS = { scene: 'scene boundary', paragraph: 'paragraph boundary', sentence: 'inside a line' };
/**
 * 注意 cut_to_fit（第 5a、5c 步）：有几处是因为一个请求放不下（两个上限，见 fitsRequest 上面）才切开的，在哪种边界上，各在第几段前面。
 * 一行自己放不下、在这一行里面切的单独说一句。照最后的段上的 cutBefore 列（一场戏切开的也在里面）；一处都没有是 null。
 */
function cutNote(units, { maxChars, maxSpokenChars }) {
  const cuts = units.filter((unit) => Object.hasOwn(CUT_LABELS, unit.cutBefore ?? '')).map((unit) => ({ at: unit.index, kind: unit.cutBefore }));
  if (cuts.length === 0) return null;
  const counted = ['scene', 'paragraph', 'sentence'].map((kind) => [kind, cuts.filter((cut) => cut.kind === kind)]).filter(([, list]) => list.length > 0);
  const where = counted.map(([kind, list]) => `${CUT_LABELS[kind]}: ${list.length} (before ${list.length === 1 ? 'piece' : 'pieces'} ${list.map((cut) => cut.at + 1).join(', ')})`).join('; ');
  const inLine = cuts.some((cut) => cut.kind === 'sentence') ? '. Cuts inside a line: that line alone did not fit in one request, so it was cut between its sentences (a sentence that still does not fit is cut at commas and the like, and hard-cut only when it is over the limit on characters sent)' : '';
  const caps = [...(maxSpokenChars === null ? [] : [`${maxSpokenChars} spoken characters`]), ...(maxChars === null ? [] : [`${maxChars} characters sent (including the opening cue)`])].join(', ');
  return {
    code: 'cut_to_fit',
    message: `${cuts.length} ${cuts.length === 1 ? 'cut was' : 'cuts were'} made because a request could not hold the text (limits: ${caps}): ${where}${inLine}. The pieces on either side of a cut use the same reference segment (a scene cut into several scenes: each speaker uses the segment picked most often across the whole scene before the cut; a line dubbed on its own picks for that line itself). Where the pieces do not join up is most likely at these cuts; listen there`,
    details: { maxChars, maxSpokenChars, cuts: cuts.map((cut) => ({ unit: cut.at, at: cut.kind })) },
  };
}

/**
 * 5a：一场戏一个请求。把能连成一场的几段（lib/scene-in-request.mjs 的 sceneRuns）各换成一个场景的 unit，别的段原样；段的编号重排。
 * 没有脚本的包才进场（脚本的 text 钩子要看到每一句）。一场放不进一个请求（两个上限，limits 是 { maxChars, maxSpokenChars }，见 sceneFits）的，sceneRuns 在行与行之间切成几场；
 * 切口后面是一场的，这一场的 unit.cutBefore 是 'paragraph'；切口前面是一场、后面只剩一个人说话的，那一段的 cutBefore 是 'paragraph'（之后照第 5c 步配，不和前一场并）。
 * 前后都不成场的切口不记：那几段照第 5c 步自己并、自己切。
 * 切口的气口（文件头第 5a 步）：记下的切口两边是同一个人接着说（前一块最后一个说话人的包，就是后一块第一个说话人的包），台本在切口没写停顿的，
 * 后一块的 pauseBeforeMs 是 CUT_PAUSE_MS，unit.cutPause 是 'paragraph'，和第 5c 步旁白里切开的两段一样；换了人的切口不加，交给拼接的换人规则（lib/mix.mjs 规则 7）。
 * 每个说话人用哪段参考，按切开以前的那一整场取（sceneRuns 的 whole，交给 sceneUnit）：一个人在切开的几场里用同一段。
 * 一处停顿不超过 maxPauseMs（options.maxPauseInRequestMs）的留在一场里，长过它的在那里切开（规则在 lib/scene-in-request.mjs 的文件头）。
 * sceneRuns 的 line 是台本的第几行，给的是 lines[i].paragraph：被停顿切开的几段，unit.line 各是各的，还是台本的同一行。
 * @returns {{ units: object[], scenes: number, lines: number, joins: number }} scenes 是分出几场，lines 是这几场一共包了台本的几行，joins 是留在这几场的请求里的停顿有几处（写法是空串的也算）
 */
function groupScenes(units, { packs, lines, perPack, maxSpeakers, maxPauseMs, limits }) {
  const { runs, cuts } = sceneRuns(units.map((unit) => ({ ...unit, line: lines[unit.line].paragraph })), { eligible: (unit) => unit.status === 'planned' && perPack.get(ownerOfUnit(packs, unit)).scripts.length === 0, maxSpeakers, maxPauseMs, fits: sceneFits(units, limits, lines) });
  if (runs.length === 0) return { units, scenes: 0, lines: 0, joins: 0 };
  const startsRun = new Set(runs.map((run) => run.first));
  const endsRun = new Set(runs.map((run) => run.last));
  const cutAt = new Set(cuts.filter((at) => startsRun.has(at) || endsRun.has(at - 1)));
  const out = [];
  let at = 0;
  let covered = 0;
  let joins = 0;
  // 记下的切口（cutAt）后面那一块：cutBefore 是 'paragraph'；同一个人接着说、台本没写停顿的，再加切口的气口（见上）
  const cutHere = (unit) => {
    const before = out[out.length - 1];
    const sameSpeaker = (before.lastSpeakerPack ?? before.pack) === unit.pack && before.pauseAfterMs + unit.pauseBeforeMs === 0;
    return { ...unit, cutBefore: 'paragraph', ...(sameSpeaker ? { pauseBeforeMs: CUT_PAUSE_MS, cutPause: 'paragraph' } : {}) };
  };
  const keep = (until) => {
    for (; at < until; at += 1) out.push(cutAt.has(at) ? cutHere(units[at]) : units[at]);
  };
  for (const { first, last, whole } of runs) {
    keep(first);
    const scene = sceneUnit(units.slice(first, last + 1), { lines, manifestOf: (unit) => ownerOfUnit(packs, unit).manifest, whole: units.slice(whole.first, whole.last + 1) });
    out.push(cutAt.has(first) ? cutHere(scene) : scene);
    covered += scene.scene.turns.length;
    joins += units.slice(first, last).filter((unit, k) => unit.pauseAfterMs + units[first + k + 1].pauseBeforeMs > 0).length;
    at = last + 1;
  }
  keep(units.length);
  return { units: out.map((unit, index) => ({ ...unit, index })), scenes: runs.length, lines: covered, joins };
}

/**
 * 一场戏的 unit（members 是连着的几段，至少两个说话人）。每一行是一轮：同一行被第 5 步切开的、被短停顿切开的几段并成同一轮；
 * 留在这一场里的停顿写进文字（scenePauseWriting）：同一轮里接在前一段后面，轮与轮之间写在前一轮的末尾（去掉写法末尾的空白）；拼接不再插它们，这个 unit 的 pauseBeforeMs、pauseAfterMs 只有这一场头尾的。
 * 一轮的文字带着这一行自己的提示（第 2 步），这一行挑到的参考段记在 picked，读到的舞台说明记在 directions（被短停顿切开的几段各有各的，都列着）。说话人按首次出现的次序编号；
 * 每个说话人整场用他各轮挑到最多的那一段参考（mostPicked，并列取先出现的），写在 scene.speakers[i].pick：{ segmentId, tag, by, crossLanguage }；
 * 「各轮」是 whole 里他的各轮（whole 是这一场切开以前的那一整场，没切开的就是 members 自己）：切开的几场里一个人用同一段。
 * segmentId 是这一段，tag 是它的音色基底标签，by 是挑到这一段的那几轮的（一个包在一次 dub 里各轮的 by 都一样：调用方给这个包的标签、它的设定、默认段，三层取一层），
 * crossLanguage 是这一段和他在这一场（members）里任何一轮的语言对不上（比法同挑参考，lib/reference-pick.mjs 的 speaksLanguage；包里没有那一轮的语言，自然也对不上；
 * 那一轮没有语言算对得上）。
 * 这一场的 unit 自己没有 pick：用哪段参考只在每个说话人的 pick 里写一处。manifestOf(unit) 是这一段所在的包的清单。
 */
function sceneUnit(members, { lines, manifestOf, whole = members }) {
  const head = members[0];
  const last = members[members.length - 1];
  const speakerPacks = []; // 第 N 个说话人的包 ID
  const turns = [];
  members.forEach((unit, k) => {
    if (k > 0) {
      const before = members[k - 1];
      const turn = turns[turns.length - 1];
      const writing = scenePauseWriting(before, unit);
      if (sameTurn(lines, before, unit)) {
        turn.text = joinInTurn(turn.text, unit.spoken, writing);
        if (unit.line !== before.line) turn.directions = [...turn.directions, ...(unit.pick.directions ?? [])];
        return;
      }
      turn.text += writing.trimEnd();
    }
    let speaker = speakerPacks.indexOf(unit.pack);
    if (speaker === -1) {
      speakerPacks.push(unit.pack);
      speaker = speakerPacks.length - 1;
    }
    // 开头的提示（文件头「设定」）：一轮是这个说话人在这一场里的一次开头，每一轮各加他那个包的（这一行开头自己写了提示的不加，和一行一个请求时一样）
    turns.push({ speaker, line: unit.line, text: unit.spoken, picked: unit.pick.segmentId, directions: unit.pick.directions ?? [], ...(unit.openingCue === undefined ? {} : { openingCue: unit.openingCue }) });
  });
  const wholeTurns = whole.filter((unit, k) => k === 0 || !sameTurn(lines, whole[k - 1], unit)); // 整场的每一轮（同一行切开的几段只算一次），按次序
  const speakers = speakerPacks.map((pack, speaker) => {
    const spoke = wholeTurns.filter((unit) => unit.pack === pack);
    const segmentId = mostPicked(spoke.map((unit) => unit.pick.segmentId));
    const own = members.filter((member) => member.pack === pack);
    const manifest = manifestOf(own[0]);
    const crossLanguage = own.some((member) => !speaksLanguage(manifest, segmentId, member.pick.language));
    const { tag, by } = spoke.find((unit) => unit.pick.segmentId === segmentId).pick;
    return { speaker, pack, pick: { segmentId, tag, by, crossLanguage } };
  });
  const lineIndexes = [...new Set(members.map((member) => member.line))];
  const rest = { ...head };
  delete rest.openingCue; // 这一场的 unit 自己没有开头的提示：每一轮各有各的（scene.turns[i].openingCue）
  delete rest.pick; // 也没有 pick：每个说话人用哪段参考写在 scene.speakers[i].pick，舞台说明写在 scene.turns[i].directions
  return {
    ...rest,
    part: 1,
    parts: 1,
    // 原文：同一行被停顿切开的几段接起来，换了一行的换一行（同第 5c 步）
    text: lineIndexes.reduce((acc, line, k) => (k === 0 ? lines[line].text : lines[line].paragraph === lines[lineIndexes[k - 1]].paragraph ? joinSpoken(acc, lines[line].text) : `${acc}\n${lines[line].text}`), ''),
    spoken: turns.map((turn) => turn.text).join('\n'),
    pauseAfterMs: last.pauseAfterMs,
    joined: members.map((member) => ({ line: member.line, part: member.part })),
    ...(new Set(members.map((member) => member.expressivenessFrom)).size > 1 ? { expressivenessFrom: 'mixed' } : {}), // 值一样才并得进来（第 7 步），来自不同的层时照实写
    lastSpeakerPack: last.pack,
    scene: { speakers, turns },
    enhancers: { offered: [], used: [] },
  };
}

/** 读一段参考出的、算「读不到、认不出」的错的码（lib/voice-pack.mjs 的 referenceClip 和 loadFile 抛的）。 */
const UNREADABLE_REFERENCE = new Set(['file_missing', 'file_modified', 'file_unlisted', 'audio_unrecognized']);

/**
 * 成品的采样率和声道，按参考段估：采样率取参考段里最高的，声道取最多的；mp3 这类没有声道信息的不算声道，声道就按单声道（WAV 的默认）。
 * 外部的参考段（清单的 externals，取它要上网）和读不到、认不出格式的参考段不算，它们在用到的时候才报。一段也认不出采样率，返回 null：计划阶段核不了，拼接时照常核。
 * 「读不到、认不出」只指包里的文件不在、被改过、没列进清单、认不出格式（UNREADABLE_REFERENCE 的那几个码）；别的错（读取函数自己出了错、程序错）照抛。
 */
async function productFormatOf(packs) {
  let sampleRate = null;
  let channels = null;
  for (const pack of packs) {
    const external = new Set((pack.manifest.externals ?? []).map((entry) => entry.path));
    for (const segment of pack.manifest.reference.segments) {
      if (external.has(segment.audio)) continue;
      let bytes;
      try {
        bytes = (await pack.referenceClip(segment.id)).clip.bytes;
      } catch (error) {
        if (isVoicePackError(error) && UNREADABLE_REFERENCE.has(error.code)) continue;
        throw error;
      }
      const info = sniffAudio(bytes);
      if (info === null) continue;
      if (typeof info.sampleRate === 'number') sampleRate = Math.max(sampleRate ?? 0, info.sampleRate);
      if (typeof info.channels === 'number') channels = Math.max(channels ?? 0, info.channels);
    }
  }
  return sampleRate === null ? null : { sampleRate, channels: channels ?? 1 };
}

/**
 * 第 3 步：一段话（台本里的一行，lines[i].paragraph）只挑一次参考：按整行要念的字认语种（一行里被停顿、提示隔开的几块接起来认），挑一段，这一行的每一块都用它。
 * 每一块的 pick.language 是这一块自己的语言，directions 是这一块自己的舞台说明；这一块的语言和挑中的那段对不上（一行中文里的一句英文），crossLanguage 是 true
 * （比法同 lib/reference-pick.mjs 的 speaksLanguage）。这一块自己挑会用另一段的（包里有它的语言），另有 followsLine: true：跨语言是因为跟着这一行用的段，
 * 不是包里没有这种语言（自己挑也是这一段的，没有 followsLine）。只有一块的行，和按这一块挑的一样。own 是这个包的几句（lines 的项，按次序）。
 * 另外记下每一行整行的语言（第 3a 步按它看停不停）：wholeLines 里每一块（lines[i].index）一项 { language, text, crossLanguage }：language 是整行认的语言（pick.language 的写法），
 * text 是整行要念的字，crossLanguage 是整行挑到的那段和整行的语言对不上。
 * @returns {{ picks: Map<number, object>, wholeLines: Map<number, { language: object | null, text: string, crossLanguage: boolean }> }} picks：lines[i].index -> 这一块的 pick
 */
function paragraphPicks(manifest, own, options) {
  const { picks: pieces } = pickReferences(manifest, own.map((line) => ({ text: line.words, labels: line.labels, directions: line.directions })), options);
  const paragraphs = [];
  own.forEach((line, k) => {
    const last = paragraphs[paragraphs.length - 1];
    if (last !== undefined && own[last[last.length - 1]].paragraph === line.paragraph) last.push(k);
    else paragraphs.push([k]);
  });
  const texts = paragraphs.map((members) => members.map((k) => own[k].words).join(' '));
  const whole = pickReferences(manifest, paragraphs.map((members, p) => ({ text: texts[p], labels: own[members[0]].labels, directions: [] })), options).picks;
  const picks = new Map();
  const wholeLines = new Map();
  paragraphs.forEach((members, p) => {
    for (const k of members) {
      const piece = pieces[k];
      const crossLanguage = !speaksLanguage(manifest, whole[p].segmentId, piece.language);
      // 这一块自己挑会用另一段（包里有它的语言、或者它的标签段）：跨语言是因为跟着这一行，不是包里没有这种语言
      const followsLine = crossLanguage && piece.segmentId !== whole[p].segmentId;
      const pick = members.length === 1 ? piece : { ...whole[p], language: piece.language, directions: piece.directions, crossLanguage, ...(followsLine ? { followsLine } : {}) };
      picks.set(own[k].index, { ...pick, index: own[k].index });
      wholeLines.set(own[k].index, { language: whole[p].language, text: texts[p], crossLanguage: whole[p].crossLanguage });
    }
  });
  return { picks, wholeLines };
}

// ---------------------------------------------------------------- 跨语言（第 3a 步）

/**
 * 第 3a 步：这一次要合成的段（status 是 planned）里，用的参考段不是这一段台词的语言的，一项一项列出来（规则在文件头第 3a 步）。
 * 一行一个请求的段看它的每一行（并进来的几行都看）；一场戏看每个说话人整场用的那段和他的每一轮。按整行的语言比（paragraphPicks 的 wholeLines）：
 * 一行里夹着别的语言的几个字（followsLine，或者包里没有那种语言），整行是参考的语言，不算。看不出语言的一行不算。
 * 给了语言的（--language、设定的 labels.language），文字看得出不是这种语言的，按文字认的比（lib/cross-language.mjs 的 languageOfText）。
 * 返回 [{ entry, alone, given }]：entry 是报告里的一项 { unit, pack: { id, name }, speaker?, segmentId, by, from, to, script?, lines, hasLanguage }，同一段、同一个说话人、同一种目标语言的几行并成一项；
 * alone、given 只在库里用（不进报告）：alone 是这几行自己挑参考也跨语言（一场戏里分开配也不行，是标签的事）；
 * given 是这几行给了语言、文字却不是这种语言，语言是哪一层给的（'caller'、'setup'），没有是 null。
 */
function crossLanguageEntries(units, { packs, wholeLines }) {
  const entries = [];
  for (const unit of units) {
    if (unit.status !== 'planned') continue;
    const sides = isScene(unit)
      ? unit.scene.speakers.map((speaker) => ({ owner: ownerOfPack(packs, speaker.pack, unit.index), speaker: speaker.speaker, segmentId: speaker.pick.segmentId, by: speaker.pick.by, lines: [...new Set(unit.scene.turns.filter((turn) => turn.speaker === speaker.speaker).map((turn) => turn.line))] }))
      : [{ owner: ownerOfUnit(packs, unit), segmentId: unit.pick.segmentId, by: unit.pick.by, lines: [...new Set((unit.joined ?? [{ line: unit.line }]).map((member) => member.line))] }];
    for (const side of sides) {
      const { manifest } = side.owner;
      const grouped = new Map();
      for (const line of side.lines) {
        const whole = wholeLines.get(line);
        if (whole === undefined || whole.language === null) continue;
        // 给了语言（--language、设定的）、文字看得出不是这种语言的，按文字认的比，given 记着是哪一层给的（lib/cross-language.mjs 的 languageOfText）
        const { language, given } = languageOfText(whole.language, whole.text);
        if (speaksLanguage(manifest, side.segmentId, language)) continue;
        const target = lineTarget(language, whole.text); // { to, script? }，写法在 lib/cross-language.mjs
        const key = JSON.stringify(target);
        if (!grouped.has(key)) {
          const entry = {
            unit: unit.index,
            pack: { id: manifest.id, name: manifest.name },
            ...(side.speaker === undefined ? {} : { speaker: side.speaker }),
            segmentId: side.segmentId,
            by: side.by,
            from: manifest.reference.segments.find((segment) => segment.id === side.segmentId).language,
            ...target,
            lines: [],
            hasLanguage: manifest.reference.segments.some((segment) => speaksLanguage(manifest, segment.id, language)),
          };
          grouped.set(key, { entry, alone: false, given: null });
        }
        const found = grouped.get(key);
        found.entry.lines.push(line);
        found.alone ||= whole.crossLanguage;
        found.given ??= given ?? null;
        found.language ??= lineLanguage(target, whole.text); // 语言提示写哪种语言（第 7c 步）：给了的照写；从文字认、认不出是哪一种的取这种文字的第一种（汉字 zh，拉丁字母 en）
      }
      entries.push(...grouped.values());
    }
  }
  return entries;
}

/**
 * 第 3a 步停下来的错（dub_cross_language）：哪几段、哪个包、参考段的语言→台词的语言，和怎么办（不问使用者，写名字对、allowCrossLanguage；使用者自己要补参考的，参考从哪来照 lib/cross-language.mjs 的 referenceSources）。
 * 包里其实有这种语言的段，另说怎么用上它：给了语言、文字不是这种语言的，不给 --language（设定写的，给 --language 盖过它，或者换一套设定、不用设定 --no-setup）；
 * 定了标签的换一个这种语言里有的标签（标签是设定的默认参考的，用 --reference-tag 盖过它，或者换一套设定、不用设定 --no-setup）；合并的一场里整场一段参考的分开配（scene: false）。
 */
function crossLanguageStop(found) {
  const entries = found.map(({ entry }) => entry);
  const alone = new Set(found.filter((item) => item.alone).map(({ entry }) => entry));
  const givenBy = new Map(found.filter((item) => item.given !== null).map(({ entry, given }) => [entry, given]));
  const numbers = (list) => [...new Set(list.map((entry) => entry.unit + 1))].join(', ');
  const groups = new Map();
  for (const entry of entries) {
    const key = JSON.stringify([entry.pack.id, entry.speaker ?? null, entry.segmentId, languagePair(entry)]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const listed = [...groups.values()].map((list) => {
    const [first] = list;
    return `piece(s) ${numbers(list)} (${first.speaker === undefined ? '' : `speaker ${first.speaker} in a scene, `}reference segment ${first.segmentId} of ${first.pack.name}, ${languagePair(first)})`;
  }).join('; ');
  const has = entries.filter((entry) => entry.hasLanguage);
  const lacking = entries.filter((entry) => !entry.hasLanguage);
  const givenCaller = has.filter((entry) => givenBy.get(entry) === 'caller');
  const givenSetup = has.filter((entry) => givenBy.get(entry) === 'setup');
  const tagged = has.filter((entry) => !givenBy.has(entry) && (alone.has(entry) || entry.speaker === undefined));
  const apart = has.filter((entry) => !givenBy.has(entry) && !alone.has(entry) && entry.speaker !== undefined);
  const kinds = [
    [lacking, 'add a reference segment in this language to the pack, issue a new version with make-pack --previous, then dub with the new version'],
    [givenCaller, 'the pack has a reference segment in this language, but a language was given (labels.language in the library, --language on the command line), the whole script picks references by it, and the words of these lines are not in that language: do not give --language, then dub recognizes the language from the text and uses a reference in that language'],
    [givenSetup, 'the pack has a reference segment in this language, but the setup used this time sets a language (labels.language), the reference was picked by it, and the words of these lines are not in that language: give --language with the language of the lines (it overrides the setup), or use another setup (--setup <name>), or use no setup (--no-setup)'],
    [tagged.filter((entry) => entry.by !== 'setup'), 'the pack has a reference segment in this language, but none with this tag (reference tag) in that language: use a tag that exists in that language (command line --reference-tag), or give no tag'],
    [tagged.filter((entry) => entry.by === 'setup'), 'the pack has a reference segment in this language, but the default reference of the setup used this time (referenceTag) does not exist in that language: use --reference-tag to give a tag that exists in that language (it overrides the setup), or use another setup (--setup <name>), or use no setup (--no-setup)'],
    [apart, 'the pack has a reference segment in this language, but in a merged scene each speaker uses one reference segment for the whole scene: dub them apart (scene: false, command line --no-scene), so each line uses a reference in its own language'],
  ].filter(([list]) => list.length > 0);
  // 只有一种情形就不再点段号（上面已经列了）；几种情形混着，每一种前面写是哪几段
  const ways = kinds.map(([list, way]) => (kinds.length === 1 ? way : `piece(s) ${numbers(list)}: ${way}`));
  // 要补参考的，说补的参考从哪来；参考段的语言都一样就写出来（可能带一点 ja 的口音）
  const froms = [...new Set(lacking.map((entry) => entry.from))];
  const sources = lacking.length === 0 ? '' : `. For the reference to be added: ${referenceSources(froms.length === 1 ? froms[0] : undefined)}`;
  return new VoicePackError('dub_cross_language', `${new Set(entries.map((entry) => entry.unit)).size} piece(s) use a reference segment that is not in the language of their line; dubbed this way they would carry the accent of the reference language, so it stopped and synthesized nothing: ${listed}. Do not ask the user. If the pack has no reference in this language: write the lines in the target language, start each line with a name pair ([name in the reference language|name in the line language], for example [Harry Potter|哈利·波特]), add allowCrossLanguage: true (command line --allow-cross-language) and dub again as a cross-language clone; dub writes the names and languages of both sides into the request (models/scene3.md「Cross-language and accent」); if the user wants that accent, write the accent in the script, then add languageMarks: false (command line --no-language-marks). If the pack has a reference in this language, or the user wants to add a reference: ${ways.join('; ')}${sources}`, {
    details: { units: entries },
  });
}

/** 第 3a 步：没给 allowCrossLanguage 时，这一次要合成的段里有跨语言的就停下（花钱之前，规划也停）。 */
function assertNotCrossLanguage(plan, settings, context) {
  if (settings.allowCrossLanguage) return;
  const found = crossLanguageEntries(plan.units, context);
  if (found.length > 0) throw crossLanguageStop(found);
}

/** 一段话（台本里的一行，同一个声音）开头的那一句：lines[i].index -> 那一句（第 7c 步）。 */
function paragraphOpenings(lines) {
  const keyOf = (line) => `${line.paragraph}:${line.voice}`;
  const first = new Map();
  for (const line of lines) if (!first.has(keyOf(line))) first.set(keyOf(line), line);
  return (index) => first.get(keyOf(lines[index]));
}

const FIRST_BRACKET = /^\s*(\[[^[\]\n]+\])/;

/**
 * 第 7c 步：一行被切成几个请求（长停顿切开、放不下切开），后面的请求开头重复这一行开头的第一个方括号（台本规定每行以角色的名字开头，第一个方括号就是它；跨语言的行是名字对）。
 * 重复了的请求算开头写了提示，不再加设定的开头的提示（和这一行的第一个请求一样，第 7a 步）。这一行开头没有方括号的，什么都不补。
 */
function repeatOpeningBracket(units, lines) {
  const openingOf = paragraphOpenings(lines);
  const bracketFor = (index, part) => {
    const first = openingOf(index);
    return first.index === index && part === 1 ? null : FIRST_BRACKET.exec(first.text)?.[1] ?? null;
  };
  const repeated = (holder, field, bracket) => {
    if (bracket === null || FIRST_BRACKET.exec(holder[field])?.[1] === bracket) return;
    holder[field] = `${bracket}${holder[field].trimStart()}`;
    if (holder.openingCue?.added === true) holder.openingCue = { ...holder.openingCue, added: false };
  };
  for (const unit of units) {
    if (isScene(unit)) for (const turn of unit.scene.turns) repeated(turn, 'text', bracketFor(turn.line, 1));
    else repeated(unit, 'spoken', bracketFor(unit.line, unit.part));
  }
}

/**
 * 第 7c 步：同语言的一行一个请求，台词开头是这个包的名字（[包名]，清单的 name）的，记下 unit.referenceName，发送时参考的文字开头也写它（第 7 步）。
 * 跨语言的（有 languageMarks，名字照名字对写）、一场戏的不记；开头是说戏、别的名字的不记。
 */
function applyReferenceNames(units, packs) {
  for (const unit of units) {
    if (isScene(unit) || unit.languageMarks !== undefined || unit.status === 'failed') continue;
    const { name } = ownerOfUnit(packs, unit).manifest;
    if (unit.spoken.trimStart().startsWith(`[${name}]`)) unit.referenceName = name;
  }
}

/**
 * 第 7c 步：跨语言的请求记下要写的语言和名字（unit.languageMarks，一场戏的参考那半在 scene.speakers[i].languageMarks，发送时照它写，第 7 步）。
 * 返回 [{ entry, lines }]：跨语言、开头没有名字对的，lines 是这一项里缺名字对的那几句（assertCrossLanguageNamed 照它停）。
 */
function applyLanguageMarks(units, { packs, wholeLines, lines }) {
  const openingOf = paragraphOpenings(lines);
  const pairOf = (index) => namePairOf(openingOf(index).text);
  const byIndex = new Map(units.map((unit) => [unit.index, unit]));
  const unnamed = [];
  for (const { entry, language } of crossLanguageEntries(units, { packs, wholeLines })) {
    const unit = byIndex.get(entry.unit);
    const missing = entry.lines.filter((line) => pairOf(line) === null);
    if (missing.length > 0) unnamed.push({ entry, lines: missing });
    const pair = entry.lines.map(pairOf).find((item) => item !== null) ?? null;
    const reference = { referenceLanguage: markLanguage(entry.from), referenceName: pair?.line ?? null };
    if (isScene(unit)) {
      unit.languageMarks ??= { language: markLanguage(language) };
      unit.scene.speakers.find((speaker) => speaker.speaker === entry.speaker).languageMarks ??= reference;
    } else unit.languageMarks ??= { language: markLanguage(language), ...reference };
  }
  return unnamed;
}

/** 第 7c 步：跨语言的行开头要有名字对；这一次要合成的段里有没写的就停下（花钱之前，规划也停）。调用方给了 languageMarks: false 的不看。 */
function assertCrossLanguageNamed(plan, settings, unnamed) {
  if (!settings.languageMarks) return;
  const planned = new Set(plan.units.filter((unit) => unit.status === 'planned').map((unit) => unit.index));
  const stopped = unnamed.filter(({ entry }) => planned.has(entry.unit));
  if (stopped.length === 0) return;
  const listed = stopped.map(({ entry, lines }) => `piece ${entry.unit + 1} (${entry.speaker === undefined ? '' : `speaker ${entry.speaker} in a scene, `}${entry.pack.name}, ${languagePair(entry)}, line(s) ${lines.map((line) => line + 1).join(', ')})`).join('; ');
  throw new VoicePackError('dub_cross_language_unnamed', `${new Set(stopped.map(({ entry }) => entry.unit)).size} piece(s) are dubbed cross-language but their lines do not start with a name pair, so nothing was synthesized: ${listed}. Start these lines with [name in the reference language|name in the line language] (for example [Harry Potter|哈利·波特]), before all cues, then dub again. Write the name once in each language; dub puts them separately into the line and the reference (models/scene3.md「Cross-language and accent」). To keep the accent of the reference language, write that accent in square brackets and add languageMarks: false (command line --no-language-marks)`, {
    details: { units: stopped.map(({ entry, lines }) => ({ unit: entry.unit, pack: entry.pack, ...(entry.speaker === undefined ? {} : { speaker: entry.speaker }), from: entry.from, to: entry.to ?? null, ...(entry.script === undefined ? {} : { script: entry.script }), lines })) },
  });
}

/**
 * 规划：返回 { plan, phonemesOf, moods }。moods 是每一句（lines[i].index）的情绪、风格（moodOf），包里脚本的钩子用。不调任何能力。
 */
async function buildPlan(env, packInput, script, options) {
  const settings = readOptions(options);
  const packs = packsOf(packInput);
  const many = packs.length > 1;
  const sources = readScript(script);
  const { lines, voices } = buildLines(sources, settings);
  const owners = ownersOf(packs, lines, voices);
  // 第 8 步：给了目标时长的段只和同一项的段并成一段（5b），没给的是 null，和以前一样并
  const targetKeyOf = (unit) => (unit.targetDuration === undefined ? null : lines[unit.line].source);
  const sameTarget = (a, b) => targetKeyOf(a) === targetKeyOf(b);
  const named = (pack, message) => (many ? `${pack.manifest.name}: ${message}` : message); // 几个包时，说明里点名是哪个包

  const notes = [];
  // 读音词表的音素（第 4 步）：环境声明了 phoneme-markers，写成音素标签（拼音、Arpabet、罗马字，和别名在同一次替换里，标签直接写进 spoken）；
  // 只声明了 phoneme-in-text，拼音发送前写成 SSML（phonemeOn）；都没有声明，音素和以前一样只报在 unapplied（reason 是 phoneme）
  const markersOn = hasCapability(env, 'phoneme-markers');
  const phonemeOn = !markersOn && hasCapability(env, 'phoneme-in-text');
  // 第 9 步：环境有 speaker-verification，合成以后每段量一次和所用参考的说话人相似度
  const verifying = hasCapability(env, 'speaker-verification');
  // 第 7 步：环境收 seed，每个请求给同一个固定的 seed（DUB_SEED），记在每一段上
  const seeding = hasCapability(env, 'seed-in-request');
  // 每个包各自的：挑参考、每一句的情绪和风格（给脚本的钩子）、读音词表、配音指引（只说有没有）、增强件、脚本
  const perPack = new Map();
  // 每个包用哪一套设定：花钱之前就定下来，名字对不上的在这里报（任何一次计费的调用之前）
  const setupNames = settings.setup === false ? null : perPackValues(packs, settings.setup, 'setup');
  const chosen = new Map(packs.map((pack) => [pack, setupNames === null ? null : chooseSetup(pack, setupNames.get(pack))])); // setup: false 是哪个包都不用设定
  // 每个包调用方指定的音色基底标签（第 3 步的第 1 层）：表里没点到的包是 null，走设定、默认段。键对不上包的，在这里报（花钱之前）
  const referenceTags = perPackValues(packs, settings.referenceTag, 'referenceTag');
  for (const pack of packs) {
    const own = lines.filter((line) => owners[line.index] === pack);
    const setup = chosen.get(pack)?.setup ?? null;
    const scripts = pack.scripts(FEATURE);
    // 挑参考（lib/reference-pick.mjs）：调用方指定的标签 → 设定写的默认参考 → 这一句的语言的默认段。语言读的是去掉提示以后要念的字（line.words），读到的舞台说明在 line.directions。
    // 指定的标签这个包里没有，在这里报 reference_tag_unknown（这个包一句台词都没有也报）
    const referenceTag = referenceTags.get(pack);
    const pickOptions = { ...REMOVE_UNRECOGNIZED, setup: pickSetupOf(setup), ...(referenceTag === null ? {} : { referenceTag }) };
    const { picks, wholeLines } = paragraphPicks(pack.manifest, own, pickOptions);
    const lexicon = await pack.lexicon();
    const { rules, phonemes, unapplied } = lexicon === null ? { rules: [], phonemes: [], unapplied: [] } : lexiconRules(lexicon, { phonemeInText: phonemeOn, phonemeMarkers: markersOn });
    // 配音指引不交给模型（文件头开头），只在 plan.guidance 里说有没有、多长
    const rawGuidance = await pack.guidance();
    const moods = new Map(own.map((line) => [line.index, moodOf(line, setup?.labels)]));
    // markerOf：写成音素标签的词 -> { alphabet, ph }（声明了 phoneme-markers 才有）：这些词的替换记成音素（lexicon.phonemes），不记成别名
    const markerOf = new Map(rules.filter((rule) => rule.phoneme !== undefined).map((rule) => [rule.term, rule.phoneme]));
    // singleUsed：这个包用上的只写一个字的词条（第 4 步的 lexicon_single_character），按第一次用上的先后
    perPack.set(pack, { own, picks, wholeLines, moods, setup, rules, markerOf, unapplied, phonemes, usedTerms: new Set(), singleUsed: new Set(), rawGuidance, offers: pack.enhancers('voice-cloning'), scripts });
  }

  const applied = new Map(); // 读音词表换了什么：同一个词、同一个读法的次数加起来（几个包的词表里一样的词，读法不同的分开记）
  const usedPhonemes = new Map(); // 用上的音素：同一个词、字母表、音素的次数加起来（音素标签在下面逐行记，SSML 的在第 5c 步以后逐段记）
  const countPhoneme = (item) => {
    const key = `${item.term}\u0000${item.alphabet}\u0000${item.ph}`;
    const seen = usedPhonemes.get(key);
    usedPhonemes.set(key, seen === undefined ? { ...item } : { ...seen, count: seen.count + item.count });
  };
  let units = [];
  const skippedCues = []; // 开头的提示里取到了、没合进去的一下子的声音（第 7a 步「限长」），每一句的都记下，规划的 notes 照它说明
  const instructed = []; // 用了带说明的设定的每一句（第 7a 步），规划的 notes 照它列（setup_instructions）
  // 第 5 步在一句话中间切开的段（`${line}:${part}`）：第 5c 步在它前面切开时不加句间的停顿（切口的气口）。只在库里用，不进报告
  const midSentence = new Set();
  for (const line of lines) {
    const owner = owners[line.index];
    const mine = perPack.get(owner);
    const replaced = applyLexicon(line.text, mine.rules);
    for (const replacement of replaced.replacements) {
      if (isSingleCharacterTerm(replacement.term)) mine.singleUsed.add(replacement.term);
      const marker = mine.markerOf.get(replacement.term);
      if (marker !== undefined) {
        countPhoneme({ term: replacement.term, ...marker, count: replacement.count });
        mine.usedTerms.add(replacement.term);
        continue;
      }
      const key = `${replacement.term}\u0000${replacement.say}`;
      const seen = applied.get(key);
      applied.set(key, seen === undefined ? { ...replacement } : { ...seen, count: seen.count + replacement.count });
    }
    const { opening, skipped } = openingOf(line, mine.setup);
    for (const item of skipped) skippedCues.push({ ...item, line: line.index, pack: owner, setup: mine.setup?.name });
    if (typeof mine.setup?.instructions === 'string' && mine.setup.instructions.trim() !== '') instructed.push({ line: line.index, pack: owner, setup: mine.setup.name, instructions: mine.setup.instructions.trim() });
    const parts = partsOf(replaced.text, partFits(settings, cueToAdd(opening)), hardFits(settings, cueToAdd(opening)));
    // 起伏：调用方给的（项自己的盖过 options 的，line.expressiveness），没有就用这一行用的设定的（--no-setup 的 mine.setup 是 null），再没有用这个声音的全局值（清单顶层的 expressiveness，--no-setup 也用：它不是设定），都没有是 null：不传（第 7 步）
    const given = line.expressiveness ?? null;
    const fromSetup = mine.setup?.expressiveness ?? null;
    const fromVoice = owner.manifest.expressiveness ?? null;
    const expressiveness = given ?? fromSetup ?? fromVoice;
    const expressivenessFrom = given !== null ? line.expressivenessFrom : fromSetup !== null ? 'setup' : fromVoice !== null ? 'global' : null;
    parts.forEach(({ text: spoken, opens }, partIndex) => {
      const first = partIndex === 0;
      if (!opens) midSentence.add(`${line.index}:${partIndex + 1}`);
      const last = partIndex === parts.length - 1;
      units.push({
        index: units.length,
        line: line.index,
        part: partIndex + 1,
        parts: parts.length,
        chapter: line.chapter,
        span: line.span,
        voice: line.voice,
        text: line.text,
        spoken,
        pick: mine.picks.get(line.index),
        // 语速：调用方给的，没有就用设定的（台本里写的放慢、加快是提示，不在这里），合成以后变速（第 7b 步）。给了目标时长的项，语速由目标时长定（第 8 步），这两样都不用
        speed: line.targetDurationMs !== null ? null : line.speed ?? mine.setup?.speed ?? null,
        ...(line.targetDurationMs === null ? {} : { targetDuration: { targetMs: line.targetDurationMs } }),
        ...(expressiveness === null ? {} : { expressiveness, expressivenessFrom }), // 取到了才有（上面）：没取到就没有这个键
        pauseBeforeMs: first ? line.pauseBeforeMs : 0,
        pauseAfterMs: last ? line.pauseAfterMs : 0,
        ...(opening === null ? {} : { openingCue: opening }),
        ...(seeding ? { seed: DUB_SEED } : {}),
        status: 'planned',
        enhancers: { offered: mine.offers.map((offer) => offer.id), used: [] },
        ...(many ? { pack: owner.manifest.id } : {}),
      });
    });
  }
  // 台本写成「名字：台词」：只提醒（不改字，不换声音），规划和正式运行都有
  const prefixed = namePrefixedLines(lines, packs);
  if (prefixed.length > 0) notes.push(namePrefixNote(prefixed, lines));
  // 开头的提示里没合进去的一下子的声音（第 7a 步「限长」）。只说明，规划和正式运行都有
  notes.push(...skippedCueNotes(skippedCues, many));
  // 用了带说明的设定：说明不发给模型，列给写台本的人看，照它在台本里写具体的。规划和正式运行都有
  notes.push(...setupInstructionsNotes(instructed, many));
  // 括号里词表认不出的字（第 2 步）：换成提示、不念，可能是原文括号里要念的正文。只提醒，规划和正式运行都有
  const unrecognized = unrecognizedNote(lines);
  if (unrecognized !== null) notes.push(unrecognized);
  // 台本里长的提示（方括号写的、舞台说明换成的，一处超过 MAX_CUE_WORDS 个词）：只提醒，不改字，规划和正式运行都有
  const longCues = longCuesNote(lines);
  if (longCues !== null) notes.push(longCues);
  // 5a：一场戏一个请求（text-to-dialogue 和 scene-in-request 都声明了、给了几个包、调用方没说 scene: false）。分场只看章节、语速、起伏、停顿、脚本、人数，不看挑出来的参考
  let sceneJoins = 0; // 留在一场戏的请求里的停顿有几处（和第 5c 步的一起进 pauses_in_request）
  if (many && settings.scene && hasCapability(env, 'text-to-dialogue') && hasCapability(env, 'scene-in-request')) {
    const grouped = groupScenes(units, { packs, lines, perPack, maxSpeakers: settings.maxSpeakers, maxPauseMs: settings.maxPauseInRequestMs, limits: settings });
    units = grouped.units;
    sceneJoins = grouped.joins;
    if (grouped.scenes > 0) {
      notes.push({ code: 'scene_in_request', message: `${grouped.scenes} scene(s) (${grouped.lines} line(s) in all) are synthesized as one request per scene (text-to-dialogue): each speaker uses, for the whole scene, the reference segment picked most often across their lines; the cues of each line are written in the text of that turn. One request gives one audio, so in these scenes no line has its own audio; to get one file per line (or to redo a single line), use scene: false (command line --no-scene)`, details: { scenes: grouped.scenes, lines: grouped.lines } });
    }
  }
  // 5b：有下限的，短句并段（joinShort 为 false 的不并：比下限短的这里就记成 failed，第 5c 步也就不并它们）。没有下限就什么都不做
  if (settings.minChars !== null) {
    if (settings.joinShort) units = joinShortUnits(units, { min: settings.minChars, limits: settings, sameTarget });
    else markTooShort(units, settings.minChars);
    const joined = units.filter((unit) => unit.joined !== undefined).length;
    if (joined > 0) notes.push({ code: 'short_lines_joined', message: `${joined} piece(s) were made by joining lines shorter than the synthesis minimum (${settings.minChars} characters) with neighbouring lines (same reference, same speed, no pause between them; the cues of each line stay at their own positions)`, details: { min: settings.minChars, units: joined } });
  }
  // 5c：一段话一次请求：同一段话的相邻几段并进一次请求，短停顿写在文字里，长的切开（见 joinIntoRequests）
  const hasScripts = (unit) => perPack.get(ownerOfUnit(packs, unit)).scripts.length > 0;
  const pickOf = (lineIndex) => perPack.get(owners[lineIndex]).picks.get(lineIndex);
  const paused = joinIntoRequests(units, { lines, limits: settings, maxPauseMs: settings.maxPauseInRequestMs, hasScripts, pickOf, linesApart: settings.scene === false, midSentence: (unit) => midSentence.has(`${unit.line}:${unit.part}`) });
  units = paused.units;
  // 比下限短的（第 5b 步）按并好的请求判：第 5c 步并进请求、够了下限的照常合成，还不到的那一段记成 failed（不调用能力，见文件头）
  if (settings.minChars !== null && settings.joinShort) markTooShort(units, settings.minChars);
  const joins = sceneJoins + paused.joins;
  if (joins > 0) notes.push({ code: 'pauses_in_request', message: `${joins} pause(s) were put into a request (written in the text: punctuation, [pause] and similar forms that were measured, see lib/pause-in-request.mjs); the joining step no longer adds these pauses`, details: { joins } });
  const cutToFit = cutNote(units, settings); // 放不下切开的：第 5c 步的，和第 5a 步一场戏切开的
  if (cutToFit !== null) notes.push(cutToFit);
  if (paused.languageCuts.length > 0) {
    notes.push({ code: 'language_cut', message: `${paused.languageCuts.length} cut(s) were made because the language changed (the pack has a default segment in that language, and the reference segments before and after differ): before piece(s) ${paused.languageCuts.map((at) => at + 1).join(', ')}. A short passage that mixes languages must stay in one request: write it in one line (a line picks only one reference segment); or give the language (command line --language), so the whole piece picks one segment for that one language, and the lines wholly in the other language are dubbed from this segment too (a cross-language clone, with an accent, needs --allow-cross-language)`, details: { units: paused.languageCuts } });
  }
  // 成对的标签没配上对的段（多半是一对标签被长停顿、换行这些拆开了）：只提醒，不改字
  const unpaired = units.map((unit) => ({ unit: unit.index, tags: unpairedTags(unit.spoken) })).filter((item) => item.tags.length > 0);
  if (unpaired.length > 0) notes.push(tagPairNote(unpaired));
  // 第 8 步：目标时长对的是一段音频。给了目标时长的一项，并完还是不止一段，花钱之前就报（规划也报）
  const targetUnits = new Map(); // 项的编号 -> 这一项的几段
  for (const unit of units) if (unit.targetDuration !== undefined) targetUnits.set(targetKeyOf(unit), [...(targetUnits.get(targetKeyOf(unit)) ?? []), unit]);
  for (const [item, parts] of targetUnits) {
    if (parts.length === 1) continue;
    const own = sources[item].targetDurationMs !== undefined;
    const field = own ? `script[${item}].targetDurationMs` : 'targetDurationMs';
    const where = typeof script === 'string' ? 'The script' : `Item ${item + 1} of the script`;
    throw new VoicePackError('dub_input_invalid', `${where} has a target duration (${field}), but it is dubbed as ${parts.length} piece(s) (pieces ${parts.map((unit) => unit.index + 1).join(', ')}): a target duration applies to one audio, and pieces synthesized separately with pauses inserted between them cannot match one target. Split it into several items, each with its own target duration; or remove what cuts it apart (pauses that do not fit in a request, chapters, voice changes, a change of language or of leading cues between lines, or a long line that does not fit in one request and was cut (the command line can take a larger --max-chars))`, { details: { field, item, units: parts.map((unit) => unit.index) } });
  }
  // SSML 的拼音音素（只声明了 phoneme-in-text）：每一句记下用上了哪几个（unit.phonemes，只在用上时才有），用上的词记在它的包里（从 unapplied 去掉）。发送时在 runUnit 里写成 SSML。
  // 声明了 phoneme-markers 的，音素标签在第 4 步已经写进 spoken，不走这里
  if (phonemeOn) {
    for (const unit of units) {
      if (isScene(unit)) continue; // 场景的文字不走 voice-cloning 的 SSML
      const owner = perPack.get(ownerOfUnit(packs, unit));
      const { replacements } = applyPhonemes(unit.spoken, owner.phonemes, { ssml: false });
      if (replacements.length === 0) continue;
      unit.phonemes = replacements.map(({ term, ph, count }) => ({ term, alphabet: PINYIN_ALPHABET, ph, count }));
      for (const { term } of replacements) {
        owner.usedTerms.add(term);
        if (isSingleCharacterTerm(term)) owner.singleUsed.add(term);
      }
    }
  }
  // 只写一个字的词条这次用上了：提醒（含这个字的每个词都照它念），不拦。每个包各自说（几个包时点名是哪个包，details 带包 ID）
  for (const pack of packs) {
    const terms = [...perPack.get(pack).singleUsed];
    if (terms.length === 0) continue;
    const note = singleCharacterNote(terms);
    notes.push(many ? { ...note, message: named(pack, note.message), details: { ...note.details, pack: pack.manifest.id } } : note);
  }
  // 包里没登记功能的脚本：每个包各自说（几个包时点名是哪个包）
  for (const pack of packs) {
    const unregistered = scriptsWithoutFeature(pack.scripts());
    if (unregistered.length > 0) {
      notes.push({
        code: 'scripts_without_feature',
        message: named(pack, `The pack has ${unregistered.length} script(s) with no feature registered (the manifest has no feature): ${unregistered.map((item) => `${item.entry} (${item.runtime})`).join(', ')}; a script with no feature belongs to no feature, and dubbing only runs the scripts registered under ${FEATURE}, so they were not run this time (for dubbing to run them, the author has to register them under ${FEATURE} in the manifest; you can also run them by hand following the pack's dubbing guidance)`),
        scripts: unregistered,
        details: { scripts: unregistered },
      });
    }
  }

  // 第 7c 步：切开的请求开头重复这一行的第一个方括号；跨语言的请求记下要写的语言和名字（languageMarks: false 的不记，台本怎么写就怎么发）
  repeatOpeningBracket(units, lines);
  const wholeLinesOfAll = new Map(packs.flatMap((pack) => [...perPack.get(pack).wholeLines]));
  const unnamed = settings.languageMarks ? applyLanguageMarks(units, { packs, wholeLines: wholeLinesOfAll, lines }) : [];
  if (settings.languageMarks) applyReferenceNames(units, packs);
  // 要用到脚本运行时的包：几个包时只看这次真用到的（没有句子的包，不要它的运行时）
  const inUse = packsInUse(packs, units);
  // 用上的音素从 unapplied 去掉（只有用到的；没用到的仍报着，它是词表里有、这句话里没有）；用上的按词、读法汇总成 lexicon.phonemes（没有用上就没有这一项）
  const lexiconUnapplied = packs.flatMap((pack) => perPack.get(pack).unapplied.filter((item) => !(item.reason === 'phoneme' && perPack.get(pack).usedTerms.has(item.term))));
  for (const unit of units) for (const item of unit.phonemes ?? []) countPhoneme(item);
  // 装不下的停顿，花钱之前就拦下：照拼接的次序排一遍停顿（mix 的规则 8 的下限），规则和估法写在 references/dub.md「Whether the pauses fit」。成品的格式按参考段估；
  // 估不出来，这里核不了，写一条注意说明这一次没核（台本里没有停顿就没什么可核），拼接时照常核。
  const format = await productFormatOf(packs);
  const pauses = units.map((unit) => ({ number: unit.index + 1, pauseBeforeMs: unit.pauseBeforeMs, pauseAfterMs: unit.pauseAfterMs }));
  if (format !== null) checkPausesFit(pauses, format);
  else if (pauses.some((unit) => unit.pauseBeforeMs > 0 || unit.pauseAfterMs > 0)) {
    notes.push({
      code: 'pause_length_unchecked',
      message: 'Whether the pauses added together fit in one WAV was not checked this time: no reference segment has a readable sample rate (external ones, unreadable ones and ones in an unrecognized format do not count), so the format of the output cannot be estimated. The check is done at mixing time with the actual sample rate of the output; if they do not fit, it fails then.',
      details: { reason: 'no_reference_format' },
    });
  }
  // 第 9 步：一场戏一个请求的段量不了（一个音频里没有每个说话人的边界），规划时就写明，每个说话人一项
  if (verifying) for (const unit of units) if (isScene(unit)) unit.speakerSimilarity = sceneSimilarity(unit);
  const plan = {
    pack: packInfo(packs[0], chosen.get(packs[0])),
    lines: lines.map(({ index, source, chapter, span, voice, text, labels }) => ({ index, source, chapter, span, voice, text, labels })),
    units,
    lexicon: { applied: [...applied.values()], unapplied: many ? uniqueJson(lexiconUnapplied) : lexiconUnapplied, ...(usedPhonemes.size > 0 ? { phonemes: [...usedPhonemes.values()] } : {}) },
    guidance: guidanceSummary(packs.map((pack) => ({ rawGuidance: perPack.get(pack).rawGuidance }))),
    enhancers: emptyEnhancers(mergedOffers(packs.map((pack) => perPack.get(pack).offers))),
    scripts: packs.flatMap((pack) => perPack.get(pack).scripts.map((entry) => ({ entry: entry.entry, runtime: entry.runtime, hooks: [...HOOKS], ...(many ? { pack: pack.manifest.id } : {}) }))),
    missingRuntimes: inUse.flatMap((pack) => missingScriptRuntimes(envFor(env, settings, pack), perPack.get(pack).scripts, FEATURE).map((item) => (many ? { ...item, pack: pack.manifest.id } : item))),
    // phoneme-markers、phoneme-in-text、scene-in-request、speaker-verification、seed-in-request 只在环境有它的时候才写进来：没有的环境，计划和 dub.json 的 capabilities 和没有这一项时一字不差
    capabilities: { 'voice-cloning': hasCapability(env, 'voice-cloning'), ...(markersOn ? { 'phoneme-markers': true } : {}), ...(hasCapability(env, 'phoneme-in-text') ? { 'phoneme-in-text': true } : {}), ...(hasCapability(env, 'scene-in-request') ? { 'scene-in-request': true } : {}), ...(verifying ? { 'speaker-verification': true } : {}), ...(seeding ? { 'seed-in-request': true } : {}) },
    // 第 9 步：这一次量不量说话人相似度，阈值是多少（没给是 null，只报数、不标）
    speakerSimilarity: verifying ? { measured: true, minSimilarity: settings.minSimilarity } : { measured: false, reason: 'capability_missing', capability: 'speaker-verification', minSimilarity: settings.minSimilarity },
    notes,
    verification: many ? packs.flatMap((pack) => pack.manifest.verification ?? []) : (packs[0].manifest.verification ?? []),
    ...(many ? { packs: packs.map((pack) => packInfo(pack, chosen.get(pack))) } : {}),
  };
  return { plan, packs, unnamed, wholeLines: wholeLinesOfAll, phonemesOf: new Map(packs.map((pack) => [pack, perPack.get(pack).phonemes])), moods: new Map(packs.flatMap((pack) => [...perPack.get(pack).moods])) };
}

/**
 * 只规划，不合成，一次能力都不调。
 * 规则和返回值见文件头。pack 可以是一个包，也可以是几个（数组，第一个是台本开头用的声音）。
 * @returns {Promise<object>} { pack, lines, units, lexicon, guidance, enhancers, scripts, missingRuntimes, capabilities, notes, verification }（几个包时还有 packs）
 */
export async function planDub(env, pack, script, options = {}) {
  const { plan, packs, wholeLines, unnamed } = await buildPlan(env, pack, script, options);
  const settings = readOptions(options);
  await settleUnits(plan, settings); // only 没点到的、能沿用的，规划里和正式运行一样标出来（不调能力）
  assertNotCrossLanguage(plan, settings, { packs, wholeLines }); // 第 3a 步：正式运行会停的，规划也停
  assertCrossLanguageNamed(plan, settings, unnamed); // 第 7c 步：同上
  return plan;
}

/**
 * only 和沿用（文件头「沿用」），规划（planDub）和正式运行（dubScript）都走这里，所以规划里看到的就是正式运行要做的：
 * only 没点到的标成 skipped（规划里已经记成 failed 的，比下限短、并不了的，不动）；only 点到的一律合成，环境收 seed 的问 previousSeed 上一次的 seed、换成它加 1（文件头第 7 步「seed」）；
 * 别的要合成的和 only 没点到的，问 reuse 有没有上一次做好的、一模一样的，有就并进来，标成 ok、carriedOver。only 写得不对报 dub_input_invalid。
 */
async function settleUnits(plan, settings) {
  // 编号是并段之后的（units[i].index，并段会重新编号）
  if (settings.only !== undefined && (!Array.isArray(settings.only) || settings.only.some((index) => !Number.isInteger(index) || index < 0 || index >= plan.units.length))) {
    throw invalid('only', `only must be an array of integers 0–${plan.units.length - 1} (the numbers of the pieces in the plan)`);
  }
  const only = settings.only === undefined ? null : new Set(settings.only);
  for (const unit of plan.units) if (unit.status === 'planned' && only !== null && !only.has(unit.index)) unit.status = 'skipped';
  // only 点到的段（「这一句换一条再配」）：环境收 seed、previousSeed 说上一次用过哪个的，换一个 seed（第 7 步「seed」）
  if (only !== null && settings.previousSeed !== undefined) {
    for (const unit of plan.units) {
      if (unit.status !== 'planned' || !only.has(unit.index) || unit.seed === undefined) continue;
      const was = await settings.previousSeed(unit);
      if (was === null || was === undefined) continue;
      if (!Number.isSafeInteger(was) || was < 0) throw invalid('previousSeed', `previousSeed must return an integer from 0 to ${Number.MAX_SAFE_INTEGER} (the seed the last dubbing of this piece used), or null`);
      unit.seed = was === Number.MAX_SAFE_INTEGER ? 0 : was + 1; // 到了 seed 的上限（签名的范围）就从 0 再来
      unit.seedChange = { from: was };
    }
  }
  if (settings.reuse === undefined) return;
  const carried = [];
  for (const unit of plan.units) {
    if (!(unit.status === 'skipped' || (unit.status === 'planned' && only === null))) continue;
    const earlier = await settings.reuse(unit);
    if (earlier === null || earlier === undefined) continue;
    if (!isPlainObject(earlier)) throw invalid('reuse', 'reuse must return an object (the fields of the piece finished last time that are merged in), or null');
    Object.assign(unit, earlier, { status: 'ok', carriedOver: true });
    if (isScene(unit) && unit.speakerSimilarity?.speakers !== undefined) unit.speakerSimilarity = sceneSimilarity(unit); // 每个说话人用的参考跟着并进来的 scene
    carried.push(unit.index);
  }
  if (carried.length > 0) {
    plan.notes.push({ code: 'carried_over', message: `${carried.length} piece(s) keep the audio finished last time, not synthesized again, no cost: pieces ${carried.map((index) => index + 1).join(', ')}`, details: { units: carried } });
  }
}

// ---------------------------------------------------------------- 合成

/**
 * 规划，再合成。规则、选项和返回值见文件头。
 * @returns {Promise<object>} planDub 的返回值，加上 ok；units[i] 多了 status（ok / failed / skipped）、audio（{ bytes, mimeType }）、model、modelChange（换过模型才有）、error，
 *   enhancers 是这一次的实际情况（用上了哪几个，没用上的有哪些）
 */
export async function dubScript(env, pack, script, options = {}) {
  const settings = readOptions(options);
  const packs = packsOf(pack);
  const ownerOf = (unit) => ownerOfUnit(packs, unit);
  // 规划不调任何能力：规划好了，交给 onPlan 说费用，再合成
  const { plan, wholeLines, phonemesOf, moods, unnamed } = await buildPlan(env, packs, script, options);
  if (plan.units.length === 0) throw new VoicePackError('dub_nothing_to_say', 'The script has nothing to say (only markers and stage directions)');
  // 不做的几段标成 skipped、能沿用的并进来（settleUnits），在 onPlan 之前（onPlan 看到的就是这个状态）。规划里已经记成 failed 的（比下限短、并不了的）不调用能力
  await settleUnits(plan, settings);
  assertNotCrossLanguage(plan, settings, { packs, wholeLines }); // 第 3a 步：这一次要合成的段里有跨语言的，没给 allowCrossLanguage 就停下（花钱之前）
  assertCrossLanguageNamed(plan, settings, unnamed); // 第 7c 步：跨语言的行开头没写名字对，也在花钱之前停下

  // 花钱之前把该有的都核对好：能力、脚本的运行时
  const clone = requireCapability(env, 'voice-cloning');
  for (const owner of packsInUse(packs, plan.units)) assertScriptRuntimes(envFor(env, settings, owner), owner.scripts(FEATURE), FEATURE);
  const todo = plan.units.filter((unit) => unit.status === 'planned');
  await settings.onPlan?.(plan, { calls: { count: todo.length } }); // 花钱之前：该核对的都核对过了，一次计费的调用都还没发生；调用方在这里说明费用、检查输出位置，抛错就停
  // 参考按（哪个包，哪一段）取一次：几个包的参考段 id 可能一样，所以带上包 ID
  const referenceKey = (pack, segmentId) => `${pack ?? ''}\u0000${segmentId}`;
  // 一个 unit 用到的参考段：一场戏是每个说话人一段（他的包，他整场用的那一段），别的 unit 是它自己的一段
  const referencesOf = (unit) => (isScene(unit) ? unit.scene.speakers.map((speaker) => ({ pack: speaker.pack, segmentId: speaker.pick.segmentId })) : [{ pack: unit.pack, segmentId: unit.pick.segmentId }]);
  const references = new Map();
  for (const unit of todo) {
    for (const { pack, segmentId } of referencesOf(unit)) {
      if (!references.has(referenceKey(pack, segmentId))) references.set(referenceKey(pack, segmentId), await ownerOfPack(packs, pack, unit.index).referenceClip(segmentId));
    }
  }
  for (const unit of plan.units) if (unit.status === 'failed') await settings.onUnit?.(unit); // 规划时就做完的（比下限短）：交出去，和别的段一样

  const hookUnit = (unit, spoken) => ({
    index: unit.index, line: unit.line, part: unit.part, parts: unit.parts, chapter: unit.chapter, text: spoken,
    language: unit.pick.language?.wanted ?? null, emotion: moods.get(unit.line).emotion, style: moods.get(unit.line).style, segment: unit.pick.segmentId,
  });

  // 连着被拒的保护（TEXT_REJECTED_LIMIT，见文件头）：rejected 记服务商拒的段（调用之前查出来的、平台说装不下的不记）；还没有一句成功、被拒够了，就 stopped，之后开始的段都不做
  const rejected = [];
  let succeeded = false;
  let stopped = false;
  // 第 9a 步：出来的音频不到按字数估的一半的段（可能没念完），段的编号 -> { unit, expectedMs, actualMs }；合成完按编号记成说明
  const unfinished = new Map();
  const checkFinished = async (unit, bytes, text) => {
    const found = await unfinishedSpeech(env, bytes, text);
    if (found !== null) unfinished.set(unit.index, { unit: unit.index, ...found });
  };
  /** 一场戏：一个 text-to-dialogue 请求，一个音频。失败的记法和别的段一样；平台说装不下的，不重发、不自己切，记成 failed 并说明是哪一场、怎么办（scene_too_long）。 */
  async function runScene(unit) {
    if (stopped) return;
    const dialogue = requireCapability(env, 'text-to-dialogue');
    const call = {
      turns: unit.scene.turns.map((turn, k) => ({ speaker: turn.speaker, text: markedLine(withOpeningCue(turn.text, cueToAdd(turn.openingCue)), k === unit.scene.turns.length - 1 ? unit.languageMarks : undefined) })), // 提示在每一轮的文字里，开头的提示写在这一轮的最前面；一场戏是一个请求，语言提示写在最后一轮的末尾（第 7c 步）
      speakers: unit.scene.speakers.map((speaker) => {
        const { segment, clip } = references.get(referenceKey(speaker.pack, speaker.pick.segmentId));
        return { ref_audio: clip, ref_text: markedReference(refTextOf(segment), speaker.languageMarks) };
      }),
      ...(unit.seed === undefined ? {} : { seed: unit.seed }), // 环境收 seed 才有（第 7 步）
      ...(unit.expressiveness === undefined ? {} : { expressiveness: unit.expressiveness }), // 取到了才有：调用方给的，或这一行用的设定、这个声音的全局值固定的（第 7 步）
    };
    let result;
    try {
      result = await dialogue(call);
    } catch (error) {
      if (isServiceError(error) || isTextRejected(error) || isUnretrieved(error)) { // 没取回的（服务那头做完了）也只记这一段：别的段照常做
        unit.status = 'failed';
        unit.error = summarizeError(error);
        if (error.details?.problem === TOO_LONG_FOR_ONE_REQUEST) {
          // 只和这一场的长度有关：不算进连续被拒的上限（TEXT_REJECTED_LIMIT），三场都装不下也不停，别的场照常做
          const sceneLines = [...new Set(unit.joined.map((member) => member.line))];
          plan.notes.push({
            code: 'scene_too_long',
            message: `Piece ${unit.index + 1} (one request per scene, ${unit.scene.turns.length} turn(s), starting from "${[...unit.scene.turns[0].text].slice(0, 20).join('')}") does not fit, the platform said, so nothing was synthesized: the lines and the references of this scene together exceed the length one request can speak. It is not cut automatically and not sent again. Either add a chapter marker (# title) in the middle of this scene to cut it into two scenes (${CHAPTER_SPLIT_REMINDER}), or use scene: false (command line --no-scene) for one request per line`,
            details: { unit: unit.index, lines: sceneLines },
          });
        } else if (isTextRejected(error) && !checkedBeforeCall(error)) {
          rejected.push(unit);
          if (!succeeded && rejected.length >= TEXT_REJECTED_LIMIT) stopped = true;
        }
        await settings.onUnit?.(unit);
        return;
      }
      throw error;
    }
    readAudioResult('text-to-dialogue', result, []);
    const reported = reportedModel('text-to-dialogue', result);
    // 合成成了（花过钱）：先记成做好了、带着模型出的那段，合成以后的几步出错时照它交出去（文件头「一段失败了怎么办」）
    unit.status = 'ok';
    succeeded = true;
    unit.audio = { bytes: result.bytes, mimeType: result.mimeType };
    Object.assign(unit, reported); // model，换过模型时还有 modelChange（见文件头「模型」）
    await afterSynthesis(unit, async (at) => {
      at('speech-length');
      await checkFinished(unit, result.bytes, unit.spoken); // 第 9a 步：量的是模型出的那段（变速之前）；一场的 spoken 是每一轮的文字，一轮一行
      let audio = unit.audio;
      at('target-duration');
      if (unit.targetDuration !== undefined) audio = await fitToTarget(env, unit, audio); // 第 8 步：一场是一个音频，整场按目标时长变速
      at('speed');
      if (wantsSpeed(unit)) audio = await fitToSpeed(env, unit, audio); // 第 7b 步：整场按语速变速（一场里的语速都一样，scene-in-request 在语速变的地方切开）
      unit.audio = audio;
    });
    await settings.onUnit?.(unit);
  }
  /**
   * 合成成了以后的几步（念完没有、包里脚本的 audio 钩子、目标时长、语速）：哪一步抛错要停下，这一段已经合成好了（花过钱），
   * 先把模型出的那段交给 onUnit（unit 上已经是 ok、带着它），再往上抛，不丢（文件头「一段失败了怎么办」）。几步都在 steps 里，成了才换 unit.audio。
   * steps 每开始一步先调 at(名字)（名字见文件头「一段失败了怎么办」），出错时 unit.afterSynthesisFailed 记着是哪一步：这一段 ok、有音频，可后面几步没做完，调用方不能把它当成做完的沿用。
   */
  async function afterSynthesis(unit, steps) {
    let step = null;
    try {
      await steps((name) => {
        step = name;
      });
    } catch (error) {
      unit.afterSynthesisFailed = { step };
      await settings.onUnit?.(unit);
      throw error;
    }
  }
  async function runUnit(unit) {
    if (isScene(unit)) return runScene(unit);
    if (stopped) return;
    const owner = ownerOf(unit); // 这一句的包：它的脚本、增强件、运行时都是这个包的
    const runtimes = envFor(env, settings, owner);
    const scripts = owner.scripts(FEATURE);
    const offers = owner.enhancers('voice-cloning');
    let spoken = unit.spoken;
    for (const entry of scripts) {
      const output = await runScript(runtimes, owner, entry, { feature: FEATURE, hook: 'text', unit: hookUnit(unit, spoken) });
      if (output.text !== undefined) spoken = output.text;
    }
    // 脚本的 text 钩子可能把要说的话改短了：比下限短的，不调用能力（和规划时一样，记成 failed）
    if (settings.minChars !== null && spokenLength(spoken) < settings.minChars) {
      unit.status = 'failed';
      unit.spoken = spoken;
      unit.error = tooShortError(spoken, settings.minChars);
      await settings.onUnit?.(unit);
      return;
    }
    const { segment, clip } = references.get(referenceKey(unit.pack, unit.pick.segmentId));
    // 开头的提示（设定、调用方给的，文件头「设定」）写在最前面；SSML 的拼音音素：发送前在文字上换成标签（只声明了 phoneme-in-text 才有；没有声明、声明的是 phoneme-markers（标签已经在 spoken 里）、或这一句没有用到的，文字原样，提示里面不换）
    const sentText = applyPhonemes(markedLine(withOpeningCue(spoken, cueToAdd(unit.openingCue)), unit.languageMarks), phonemesOf.get(owner) ?? [], { ssml: false }).text;
    const call = { text: sentText, ref_audio: clip, ref_text: markedReference(refTextOf(segment), unit.languageMarks, unit.referenceName), ...(unit.seed === undefined ? {} : { seed: unit.seed }), ...(unit.expressiveness === undefined ? {} : { expressiveness: unit.expressiveness }) }; // seed：环境收 seed 才有；expressiveness：取到了才有，调用方给的或设定固定的（都在第 7 步）
    if (offers.length > 0) call.enhancers = offers;

    let result;
    try {
      result = await clone(call);
    } catch (error) {
      if (isServiceError(error) || isTextRejected(error) || isUnretrieved(error)) { // 没取回的（服务那头做完了）也只记这一段：别的段照常做
        unit.status = 'failed';
        unit.spoken = spoken;
        unit.error = summarizeError(error);
        // 服务商拒的这一句才数；调用之前查出来的只记这一句失败（见 checkedBeforeCall）；平台说一个请求装不下的也不数：只和这一句的长度有关，同 runScene 的一场装不下（文件头「一段失败了怎么办」）
        if (isTextRejected(error) && !checkedBeforeCall(error) && error.details?.problem !== TOO_LONG_FOR_ONE_REQUEST) {
          rejected.push(unit);
          if (!succeeded && rejected.length >= TEXT_REJECTED_LIMIT) stopped = true; // 在 await onUnit 之前记下，这之后开始的段都不做
        }
        await settings.onUnit?.(unit);
        return;
      }
      throw error;
    }
    const used = readAudioResult('voice-cloning', result, offers);
    const reported = reportedModel('voice-cloning', result);
    const fromModel = { bytes: result.bytes, mimeType: result.mimeType }; // 模型出的那段：第 9 步量的是它（脚本和变速之前）
    // 合成成了（花过钱）：先记成做好了、带着模型出的那段，合成以后的几步出错时照它交出去（afterSynthesis）
    unit.status = 'ok';
    succeeded = true;
    unit.spoken = spoken;
    unit.audio = fromModel;
    Object.assign(unit, reported); // model，换过模型时还有 modelChange（见文件头「模型」）
    unit.enhancers = { offered: unit.enhancers.offered, used };
    await afterSynthesis(unit, async (at) => {
      at('speech-length');
      await checkFinished(unit, fromModel.bytes, spoken); // 第 9a 步：念完没有，量的也是它
      let audio = fromModel;
      at('audio-hook');
      for (const entry of scripts) {
        const output = await runScript(runtimes, owner, entry, { feature: FEATURE, hook: 'audio', unit: { ...hookUnit(unit, spoken), ...audioForScript(audio) } });
        if (output.audio !== undefined) audio = { bytes: fromBase64(output.audio), mimeType: output.mimeType ?? audio.mimeType };
      }
      at('target-duration');
      if (unit.targetDuration !== undefined) audio = await fitToTarget(env, unit, audio); // 第 8 步：合成以后（脚本之后）按目标时长变速
      at('speed');
      if (wantsSpeed(unit)) audio = await fitToSpeed(env, unit, audio); // 第 7b 步：合成以后（脚本之后）按语速变速；有目标时长的段没有语速（第 8 步）
      unit.audio = audio;
    });
    if (plan.speakerSimilarity.measured) {
      try {
        unit.speakerSimilarity = await measureSimilarity(env, fromModel, clip, unit.pick.segmentId, settings.minSimilarity);
      } catch (error) {
        await settings.onUnit?.(unit); // 量的时候出了别的错要停下：这一段已经合成好了（花过钱），先交出去，不丢
        throw error;
      }
    }
    await settings.onUnit?.(unit);
  }

  await pool(todo, settings.concurrency, runUnit);
  if (stopped) throw textRejectedStop(rejected); // 在做的几段都做完了（pool 等它们），再抛
  // 第 8 步：变不到目标时长的段（超出变速的上下限、按最近的那一头变的；环境没有 ffmpeg、没变速的），合成完一起说
  const missed = plan.units.filter((unit) => unit.status === 'ok' && unit.targetDuration !== undefined && (unit.targetDuration.limit !== undefined || unit.targetDuration.speed === null));
  if (missed.length > 0) {
    const how = (fit) => (fit.speed === null ? 'the environment has no ffmpeg, no speed change' : `beyond the ${fit.limit === 'max' ? 'upper' : 'lower'} limit of the speed change, changed by a factor of ${fit.speed}`);
    const off = (fit) => (fit.offByMs === null ? 'length not measurable' : fit.offByMs > 0 ? `${fit.offByMs} ms too long` : `${-fit.offByMs} ms too short`);
    const listed = missed.map(({ index, targetDuration: fit }) => `piece ${index + 1} target ${fit.targetMs} ms, actual ${fit.actualMs === null ? 'not measurable' : `${fit.actualMs} ms`} (${off(fit)}, ${how(fit)})`);
    plan.notes.push({
      code: 'target_duration_missed',
      message: `${missed.length} piece(s) did not reach the target duration (the speed change is only made between ${SPEED_LIMITS.min} and ${SPEED_LIMITS.max} times, beyond that it changes to the nearest limit and does not force it; the speed change needs ffmpeg): ${listed.join('; ')}. For pieces far off, edit the text of the line (delete characters if too long, add if too short) and dub again`,
      details: { units: missed.map(({ index, targetDuration: fit }) => ({ unit: index, ...fit })) },
    });
  }

  // 第 9a 步：可能没念完的段，每段一条说明（按段的编号）
  for (const index of [...unfinished.keys()].sort((a, b) => a - b)) {
    const found = unfinished.get(index);
    const seconds = (ms) => (ms / 1000).toFixed(1);
    const unit = plan.units.find((item) => item.index === index);
    const said = (unit?.spoken ?? unit?.scene?.turns?.map((turn) => turn.text).join(' ') ?? '').replace(/\s+/g, ' ').trim();
    const opening = said === '' ? '' : ` (starts with "${[...said].slice(0, 20).join('')}${[...said].length > 20 ? '…' : ''}")`;
    plan.notes.push({
      code: 'speech_maybe_unfinished',
      message: `Piece ${index + 1}${opening} may not have been spoken to the end: by character count it needs at least ${seconds(found.expectedMs)} s, but only ${seconds(found.actualMs)} s came out, less than half (when a model cannot speak a whole request it does not always report an error, it just stops halfway). The piece is delivered as it is, and dub does not redub it by itself; ask the user to listen to its ending, and the user decides whether to redub (redub with --only ${index + 1}, or add a chapter marker in the middle to cut it shorter: ${CHAPTER_SPLIT_REMINDER})`,
      details: found,
    });
  }

  // 第 7b 步：要变速、环境没有 ffmpeg 的段，照原速交出了，合成完一起说
  const unchanged = plan.units.filter((unit) => unit.status === 'ok' && unit.speedChange?.speed === null);
  if (unchanged.length > 0) {
    plan.notes.push({
      code: 'speed_not_applied',
      message: `${unchanged.length} piece(s) need a speed change (the speed given by the caller or the setup), but the environment has no ffmpeg, so they are delivered at the original speed: pieces ${unchanged.map((unit) => unit.index + 1).join(', ')}. dub.json still records the wanted speed in the speed of these pieces; when mix runs with ffmpeg available it changes them by it`,
      details: { units: unchanged.map((unit) => unit.index) },
    });
  }

  const finished = plan.units.filter((unit) => unit.status === 'ok');
  return { ok: plan.units.every((unit) => unit.status !== 'failed'), ...plan, enhancers: summarizeUse(mergedOffers(packs.map((pack) => pack.enhancers('voice-cloning'))), finished, plan.verification) };
}

// ---------------------------------------------------------------- 念完没有（第 9a 步）

/**
 * 第 9a 步：模型出的这段音频，是不是不到按字数估的一半（lib/speech-length.mjs）。是就返回 { expectedMs, actualMs }（毫秒，取整），不是返回 null。
 * 量不出长度的（不是 WAV、环境又没有 ffmpeg，或者解不了），也返回 null：这一步只提醒，不报错、不重试、不调用能力。
 */
async function unfinishedSpeech(env, bytes, text) {
  const expectedMs = expectedSpeechMs(text);
  if (expectedMs === 0) return null;
  let actual;
  try {
    actual = await lengthMs(env, bytes);
  } catch (error) {
    if (decodeFailureKind(error) === null) throw error;
    return null;
  }
  return actual < expectedMs * UNFINISHED_BELOW ? { expectedMs, actualMs: Math.round(actual) } : null;
}

// ---------------------------------------------------------------- 目标时长（第 8 步）

/** 一段音频有多长（毫秒，不取整）。WAV 自己解，别的格式要 ffmpeg（tools/audio-decode.mjs）。 */
async function lengthMs(env, bytes) {
  const { frames, sampleRate } = await decodeAudio(env, bytes);
  return (frames / sampleRate) * 1000;
}

/**
 * 第 8 步：给了目标时长的段，合成以后变速，长度对上目标（规则在文件头第 8 步）。返回交出去的音频；unit.targetDuration 写上
 * originalMs（合成出来的长度）、speed（变速的倍数，没变速是 null）、actualMs（交出去的长度）、offByMs（交出去的比目标长多少毫秒，短了是负数），
 * 超出变速的上下限、按最近的那一头变的，另有 limit（'max' 或 'min'）。毫秒都取整。
 * 没有 ffmpeg：照原长交出（规则同拼接），WAV 量得出原长，别的格式量不出（originalMs、actualMs、offByMs 是 null）。
 */
async function fitToTarget(env, unit, audio) {
  const { targetMs } = unit.targetDuration;
  const ffmpeg = env.runtimes?.ffmpeg;
  if (typeof ffmpeg !== 'function') {
    let originalMs = null;
    try {
      originalMs = Math.round(await lengthMs(env, audio.bytes));
    } catch (error) {
      if (decodeFailureKind(error) !== 'runtime_missing') throw error; // 不是 WAV、又没有 ffmpeg：量不出，照原样交出
    }
    unit.targetDuration = { targetMs, originalMs, speed: null, actualMs: originalMs, offByMs: originalMs === null ? null : originalMs - targetMs };
    return audio;
  }
  const original = await lengthMs(env, audio.bytes);
  const wanted = Math.round((original / targetMs) * 10000) / 10000; // 倍数取到小数点后 4 位：交给 ffmpeg 的和报告里写的是同一个数
  const changed = await changeSpeed(ffmpeg, audio.bytes, wanted);
  const actualMs = Math.round(await lengthMs(env, changed.bytes));
  unit.targetDuration = { targetMs, originalMs: Math.round(original), speed: changed.speed, actualMs, offByMs: actualMs - targetMs, ...(changed.limit === null ? {} : { limit: changed.limit }) };
  return { bytes: changed.bytes, mimeType: 'audio/wav' };
}

// ---------------------------------------------------------------- 语速（第 7b 步）

/** 这一段合成以后要不要变速：有语速要求，而且不是 1。 */
const wantsSpeed = (unit) => unit.speed !== null && unit.speed !== undefined && unit.speed !== 1;

/**
 * 第 7b 步：调用方或设定给的语速，合成以后变速（规则在文件头第 7b 步，变速同拼接：lib/mix.mjs 的 changeSpeed、SPEED_LIMITS）。返回交出去的音频；
 * unit.speedChange 写上 { wanted, speed, originalMs, actualMs, limit? }：wanted 是要的倍数，speed 是实际用的（没有 ffmpeg 是 null），originalMs、actualMs 是变速前后的长度（毫秒，取整；
 * 不是 WAV、又没有 ffmpeg 时量不出，是 null），超出上下限的另有 limit（'max' 或 'min'）。变过速的段 unit.speed 改成 null：拼接的人不再变一次；
 * 没有 ffmpeg 的照原样交出，unit.speed 留着要的语速，拼接时有 ffmpeg 再变。
 */
async function fitToSpeed(env, unit, audio) {
  const wanted = unit.speed;
  const ffmpeg = env.runtimes?.ffmpeg;
  if (typeof ffmpeg !== 'function') {
    let originalMs = null;
    try {
      originalMs = Math.round(await lengthMs(env, audio.bytes));
    } catch (error) {
      if (decodeFailureKind(error) !== 'runtime_missing') throw error; // 不是 WAV、又没有 ffmpeg：量不出，照原样交出
    }
    unit.speedChange = { wanted, speed: null, originalMs, actualMs: originalMs };
    return audio;
  }
  const originalMs = Math.round(await lengthMs(env, audio.bytes));
  const changed = await changeSpeed(ffmpeg, audio.bytes, wanted);
  unit.speedChange = { wanted, speed: changed.speed, originalMs, actualMs: Math.round(await lengthMs(env, changed.bytes)), ...(changed.limit === null ? {} : { limit: changed.limit }) };
  unit.speed = null; // 已经变过：拼接的人不再变
  return { bytes: changed.bytes, mimeType: 'audio/wav' };
}

// ---------------------------------------------------------------- 说话人相似度（第 9 步）

/**
 * 一段合成出来的音频（audio，模型出的那段）和它用的那一段参考（clip，segmentId）的说话人相似度，写法见文件头第 9 步。
 * 某一路嵌不出声纹（speaker-verification 的标准写法 no_speech）是「量不到」；服务暂时出错是「没听成」；都不重试。别的错照常抛出。
 */
async function measureSimilarity(env, audio, clip, segmentId, minSimilarity) {
  try {
    const { similarity, model } = await speakerSimilarity(env, audio, clip);
    return { status: 'measured', segmentId, similarity, ...(model === undefined ? {} : { model }), ...(minSimilarity === null ? {} : { drifted: similarity < minSimilarity }) };
  } catch (error) {
    if (isNoSpeechError(error)) return { status: 'no_speech', label: NO_SPEECH_LABEL, segmentId, which: error.details.field === 'audio_a' ? 'generated' : 'reference', error: summarizeError(error) };
    if (isServiceError(error)) return { status: 'not_heard', label: NOT_HEARD_LABEL, segmentId, error: summarizeError(error) };
    throw error;
  }
}

/** 一场戏一个请求的段：每个说话人一项「量不了」（一个音频里没有每个说话人的边界）。 */
const sceneSimilarity = (unit) => ({
  speakers: unit.scene.speakers.map(({ speaker, pack, pick: { segmentId } }) => ({
    speaker,
    pack,
    segmentId,
    status: 'unmeasurable',
    label: UNMEASURABLE_LABEL,
    reason: 'scene_in_request',
    message: `${UNMEASURABLE_LABEL}: one request per scene, and one audio has no boundaries between the speakers, so this person's lines cannot be measured; to measure, use scene: false (command line --no-scene) for one request per line`,
  })),
});

// ---------------------------------------------------------------- 几个包：小工具（一个包时各自都是原来的样子）

/** 段属于哪个包：unit.pack 只在几个包时才有；没有就是给的那一个（第一个）。 */
function ownerOfUnit(packs, unit) {
  return ownerOfPack(packs, unit.pack, unit.index);
}

/** 包 ID（几个包时才有，没有就是给的第一个）对应的包；index 是要这个包的那一段的编号，只用在出错的说明里。 */
function ownerOfPack(packs, id, index) {
  if (id === undefined) return packs[0];
  const owner = packs.find((pack) => pack.manifest.id === id);
  if (owner === undefined) throw new Error(`Piece ${index} records pack ${id}, which is not among the packs given this time`);
  return owner;
}

/** 用到的包：一个包时就是它；几个包时只要有句子在它里面的（没有句子的包，不要它的运行时）。 */
function packsInUse(packs, units) {
  if (packs.length === 1) return packs;
  return packs.filter((pack) => units.some((unit) => ownerOfUnit(packs, unit) === pack));
}

/**
 * 一个包的身份（plan.pack，几个包时还有 plan.packs 里的每一项）。包里有设定时多两样：setups（包里有哪几套，名字）；这一次用了哪一套时再加 setup: { name, by, expressiveness? }，
 * by 是 'option'（options.setup 点的名）或 'default'（包里带 default 的那一套），expressiveness 是这套设定固定的起伏（写了才有）。
 * 这个包自己给起伏（设定的或全局值）时再加 expressiveness: { value, from }，from 是 'setup' 或 'global'（effectiveExpressiveness）。包里没有设定、设定和全局值都没写，就和以前一字不差。
 */
function packInfo(pack, chosen) {
  const names = (pack.manifest.setups ?? []).map((setup) => setup.name);
  return {
    id: pack.manifest.id,
    name: pack.manifest.name,
    version: pack.manifest.version,
    ...(names.length === 0 ? {} : { setups: names }),
    ...(chosen === null || chosen === undefined ? {} : { setup: { name: chosen.setup.name, by: chosen.by, ...(chosen.setup.expressiveness === undefined ? {} : { expressiveness: chosen.setup.expressiveness }) } }),
    ...effectiveExpressiveness(pack, chosen),
  };
}

/** 这个包自己给的起伏（命令行、台本没给时用它）：expressiveness: { value, from }，from 是 'setup' 或 'global'；都没写就没有这个键。 */
function effectiveExpressiveness(pack, chosen) {
  const fromSetup = chosen?.setup?.expressiveness ?? null;
  const fromVoice = pack.manifest.expressiveness ?? null;
  if (fromSetup === null && fromVoice === null) return {};
  return { expressiveness: { value: fromSetup ?? fromVoice, from: fromSetup !== null ? 'setup' : 'global' } };
}

/** 去掉按 JSON 完全一样的项，保留第一次出现的次序。 */
function uniqueJson(list) {
  const seen = new Set();
  return list.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 配音指引的概况（plan.guidance）。entries 是每个包一项 { rawGuidance }：一个包时就是 { present, chars, truncated, sent }；
 * 几个包时 present 取任一个有的，chars 相加。sent：dub 不再把指引交给模型（文件头开头），恒为 false；truncated 恒为 false。两个字段留着，--json 的输出形状不变。
 */
function guidanceSummary(entries) {
  return {
    present: entries.some((entry) => entry.rawGuidance !== null && entry.rawGuidance !== undefined),
    chars: entries.reduce((sum, entry) => sum + (entry.rawGuidance ? count(entry.rawGuidance) : 0), 0),
    truncated: false, // 基础部分不截指引：字段留着、恒为 false，--json 的输出形状不变
    sent: false, // 指引不交给模型：字段留着、恒为 false
  };
}

/** 几个包各自声明的增强件合在一起，按 id 去重（同一个 id 只留第一个）；一个包时原样返回它的那一份。 */
function mergedOffers(lists) {
  if (lists.length === 1) return lists[0];
  const seen = new Map();
  for (const list of lists) for (const offer of list) if (!seen.has(offer.id)) seen.set(offer.id, offer);
  return [...seen.values()];
}
