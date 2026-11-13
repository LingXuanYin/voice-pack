// SPDX-License-Identifier: Apache-2.0
//
// dub 命令：用一个音色包给一段台本配音。流程在 lib/dub.mjs（每句用哪段参考、读音词表、增强件、包里的脚本；台本里的提示原样交给模型），这个命令只管读包目录和台本、
// 组装运行环境、把每一句的音频写成文件、把报告写出来。
//
//   node cli.mjs dub <包目录> <台本文件|-> --out <目录> [--adapter <名字|模块文件>]... [--adapter-option <键=值>]...
//                    [--language <标签>] [--emotion <标签>] [--style <标签>] [--energy low|medium|high] [--speed <倍数>] [--expressiveness <0 到 100>] [--setup <名字>|<包>=<名字>]... [--no-setup] [--reference-tag <标签>|<包>=<标签>]...
//                    [--target-duration-ms <毫秒>] [--min-similarity <数>] [--only <序号,序号>] [--max-chars <数>] [--concurrency <1-8>] [--no-scene] [--allow-cross-language] [--no-language-marks] [--dry-run] [--json]
//
// 包目录：角色部分的根（里面有 manifest.json、SKILL.md、reference/……）。放进环境以后就是 .agents/skills/<包 ID>/，见 install 命令。
// 台本：带台本标记的文本（章节、[pause]、[voice:]，语法见基础部分 SKILL.md 和 tools/markup.mjs）；别的方括号是提示（[小声]、[laughs]），原样、按位置交给模型；
//   舞台说明（耳语）、*笑* 换成同样意思的提示（lib/line-hints.mjs 的 cuesInPlace）。
//   文件名以 .json 结尾的是数组，每项 { text, labels?, speed?, expressiveness?, targetDurationMs? }：这一项自己的标签（language、emotion、style、energy）、语速、起伏和目标时长（毫秒），
//   盖过命令行上给的同一项。
//   `-` 是标准输入。
// 选项：
//   --out        输出目录：每一句一个音频文件（<序号>-<参考段>.<扩展名>，序号从 1 起、补零到 3 位），加一份 dub.json（报告，不含音频）。
//                目录可以已经存在（重做时往里补）；同名文件会被盖掉。--dry-run 时可以不给；给了，规划里标出能沿用的句子（下面「沿用」），目录里什么都不动。
//   --dry-run    只规划，不合成：每一句要说什么、用哪段参考、为什么、读音词表换了什么、缺什么运行时。不花钱（一次能力都不调），不写文件。
//                --only 没点到的标 skipped、给了 --out 时能沿用的标 ok 和 carriedOver、上一次没取回的照旧标 failed（下面「没取回」），和正式运行一样：规划里 status 是 planned 的才是这次要合成的。
//                汇总：文字输出的第一行是「汇总：要念的 N 个字（去掉提示和标签名，连着的空白算一个），分 M 个请求[（其中 k 个是一场戏）][，这次要合成 p 个（…）]，模型：<模型名>（<能力>）」。
//                  字数是每一句（每一场）要念的字（按字符数），数法和配音默认的软上限一样（lib/synthesis-limits.mjs 的 spokenLength：方括号的提示、尖括号标签的名字不算，语言标签包住的字照算，
//                  一个音素标签算一个字，标点算，连着的空白算一个、两头的不算），各句、各场的字加起来（句与句之间的不算），--only 没点到的也算；字太少、不发请求的那几句，字数和请求数都不算。
//                  模型取自适配器返回里的 models（cli/adapters.mjs 的 modelOf）：一场戏看 text-to-dialogue，别的看 voice-cloning；提供这项能力的适配器没说，写「适配器没说用哪个模型」；
//                  环境没有 voice-cloning，写「环境没有 voice-cloning」。不估计时长（没量过）。长文分几个请求，agent 照这一行先告诉使用者（scenes/narration.md 第 6 步）。--json 时没有这一行。
//   --language --emotion --style --energy
//                调用方给的标签，用在每一句上，盖过设定的同一项。语言用来找参考段（规则在 lib/reference-pick.mjs 的文件头）；
//                情绪、风格、能量不影响用哪段参考：和设定的合成一条提示，写在每个请求的开头（lib/dub.mjs 第 7a 步，台本在那一段开头自己写了提示的不加）；
//                情绪、风格另外交给包里脚本的钩子（lib/dub.mjs 的 moodOf）。
//   --instructions
//                拿掉了：dub 不再把说明发给模型（「带一点四川口音」这种概括的标签，模型不知道具体怎么念），给了就报 dub_input_invalid，--dry-run 也报（用法里和选项表里还留着它，写明拿掉了，才报得出这个错）。
//                口音、口吻要的说法，在台本里写具体的提示，写在发生的位置（models/scene3.md「What to write」「Cross-language and accent」）；设定里的说明（清单 setups 的 instructions）是给写台本的人看的，
//                规划的 notes 里 setup_instructions 列出来。
//   --reference-tag
//                用包里哪个音色基底标签的参考段（清单里参考段的 tag；和设定写的默认参考、默认段谁先谁后，找段的规则，都在 lib/reference-pick.mjs 的文件头）。认包的写法同 --setup（包名或包 ID，不分大小写）：--reference-tag <标签> 每个包都用它（只给一个，
//                每个包都要有这个标签）；--reference-tag <包>=<标签> 点某一个包的，可以重复，同一个包只点一次，没点的包走设定、默认段；两种不混着给。和 --setup 不同的只有 = 的判法：
//                第一个 = 左边是这次给了的某个包的名字或 ID，才当 <包>=<标签>，否则整串是标签（标签里可以有 =）。标签哪个包里没有，报 reference_tag_unknown，
//                列出那个包每种语言有哪些标签（--dry-run 也报，一次能力都不调）。一次 dub 里一个包只用一个标签：台本中途要换，拆成几次 dub，再用 mix 接起来。
//                dub.json 每一句的 pick 写着 { segmentId, tag, by, crossLanguage, followsLine? }（一场戏一个请求的写在 scene.speakers[i].pick），by 是 reference-tag、setup、default 之一；
//                followsLine 是一行里另一种语言的那一块跟着这一行用的段（lib/dub.mjs 第 3 步），文字输出标「跟着这一行的参考段」，不说「包里没有这种语言」。
//   --allow-cross-language
//                参考段不是这一句的语言也照配（跨语言克隆，带参考那种语言的口音）。不给时，这一次要合成的句子里有一句用的参考段不是它的语言（一场戏是一个说话人整场用的那段和他的一轮），
//                在花钱之前停下，报 dub_cross_language，一次能力都不调，--dry-run 也报（规则、怎么办和 details 在 lib/dub.mjs 第 3a 步）。一行里夹着另一种语言的几个字的、
//                看不出语言的一句不停。--only 没点到的、沿用上一次的句子这一次不合成，不算。给了它，失败以后的重做命令也带着它。
//                跨语言的行开头写名字对 [参考语言里的名字|台词语言里的名字]，dub 把两边的名字和语言写进请求（lib/dub.mjs 第 7c 步）；没写名字对的句子在花钱之前停下，报 dub_cross_language_unnamed，--dry-run 也报。
//   --no-language-marks
//                跨语言的行不要求名字对，不加两边的语言提示，台本怎么写就怎么发（要带参考那种语言的口音时用，lib/dub.mjs 第 7c 步）。给了它，失败以后的重做命令也带着它。
//   --speed      调用方给的语速（正数，1 不变，0.85 放慢，1.15 加快），盖过设定的：合成以后变速（保持音高，上下限同 mix，lib/dub.mjs 第 7b 步）。
//   --expressiveness
//                调用方给的起伏（0 到 100 的整数，写法见 vocab/capability-signatures.md；越大越多变，越小越平稳），传给每个合成请求（一个人说话、一场戏的请求都传）；.json 台本里项自己的 expressiveness 盖过它，
//                它盖过设定的 expressiveness 和这个声音的全局值（清单顶层的 expressiveness；先后见 lib/dub.mjs 文件头「设定」）。不是 0 到 100 的整数（小数、0 到 1 的写法也不收），报 dub_input_invalid（details.field 是 expressiveness 或 script[<序号>].expressiveness），--dry-run 也报，花钱之前报。
//                都没有（调用方没给，用的设定没写，也没有全局值）就不传：请求、dub.json 和没有这个选项时一字不差，dub 不自己填一个。dub.json 的 units[i].expressiveness 记着传的值；不同值的行不并进同一个请求（lib/dub.mjs 第 7 步）。
//                环境收不收、数怎么换算，看环境自己的说明；怎么取值、模型的读数在模型说明里（models/ 的「起伏」）。失败以后的重做命令也带着它。
//   --setup      用音色包里的哪一套设定（清单的 setups，protocol/FORMAT.md 4.4）：设定里固定的语言、情绪、风格、能量、语速、起伏补在调用方没给的那一项上（设定的说明不发给模型，用了带说明的设定，规划的 notes 列给写台本的人看）。不给，用带 default 的那一套，没有就不用设定；
//                名字对不上，报 setup_unknown 并列出包里有哪几套（每个包在自己的设定里找）。--dry-run 和 dub.json 都写明用的是哪一套，这套设定写了起伏的，连它的起伏一起写（文字输出的「设定」一行写「起伏 80」，dub.json 的 pack.setup.expressiveness）。
//                两种写法：--setup <名字>，每个包都按这个名字找（只给一个，不和下一种混着给）；--setup <包>=<名字>，点某一个包的（包名或包 ID，不分大小写，和 [voice:] 认包的写法一样），
//                可以重复，几个包时每个包点各自的，没点的包用它自己的默认，同一个包只点一次（名字、包 ID 各写一次也算两次，用法错误）。名字取第一个 = 后面的全部：设定的名字里有 =，就写成 <包>=<名字>。
//   --no-setup   这一次哪个包都不用设定，带 default 的那一套也不套（库的 setup: false）：参考照 --reference-tag、默认段挑，语言、情绪、风格、能量、语速、起伏只有调用方给的。
//                要的是声音本身时用，例如拿这个包自己跨语言配一段、补成另一种语言的参考（references/character-voice.md「Add a reference segment in this language」）。不和 --setup 一起给（用法错误）。
//                文字输出的「设定」一行写明这次是 --no-setup 不用的；dub.json 的 pack.setup 没有（pack.setups 照旧列着包里有哪几套）。这个声音的全局值（起伏）不是设定，照用。失败以后的重做命令也带着它。
//   --target-duration-ms
//                对画面的一句：每一项（.txt 台本就是整份台本）配出来要多少毫秒，合成以后按它变速（保持音高），规则在 lib/dub.mjs 第 8 步。.json 台本里项自己的 targetDurationMs 盖过它。
//                一项要配成一段音频：配成了几段就在花钱之前报 dub_input_invalid。dub.json 的 units[i].targetDuration 写着目标、原长、变速的倍数、变速以后的长度。
//   --min-similarity
//                说话人相似度的阈值：环境有 speaker-verification 时，每一句合成出来以后和它用的参考比一次（lib/dub.mjs 第 9 步），低于这个数的标出来（dub.json 的
//                units[i].speakerSimilarity.drifted），输出里另起一条注意列出这几句。不给就只报数、不标。数的范围看环境的 speaker-verification。dub 不自己重配。
//   --only       只合成这几句（序号从 1 起，和输出里、文件名里的一致）：点到的一律重做（没变也重做，「这一句换一条再配」用它，见下面「--only 换 seed」），没点到的照下面「沿用」。
//   --max-chars  一个请求最多多少个字（发出去的字，连开头的提示）。同一章放得下就一个请求；放不下时先在场景的边界（只写着停顿的一行）切，再在行与行之间，
//                一行自己放不下才在它的句子之间切（lib/dub.mjs 第 5、5c 步）；一场戏在行与行之间切成几场（第 5a 步）。
//                不给：一个请求默认不超过约 1000 个要念的字符（lib/synthesis-limits.mjs 的 DEFAULT_MAX_SPOKEN_CHARS，数法同上面「汇总」），接进来的适配器给了 limits.maxChars 的，
//                发出去的字也不超过它（规则见 adapters/README.md）：两条都要满足。给了：只照给的数切，默认的 1000 不再管（适配器的 limits.maxChars 也不管，同以前）；它数的是发出去的字，和默认的不是一种数法，提示、标签多的台本切得更碎。
//                因为放不下切开的地方，文字输出在那一块下面写一行「放不下一个请求，在…和前一段切开」，dub.json 是 units[i].cutBefore 和注意 cut_to_fit；
//                换了语言切开的（一段话一段参考，行与行之间换了语言、包里有那种语言的默认段），写「换了语言…切开」，dub.json 是 cutBefore: 'language' 和注意 language_cut。
//                dub 自己切开（上面两种，和开头的提示、语速不同、包里有配音脚本这些别的切口）、台本在切口没写停顿、dub 记了默认停顿的（units[i].cutPause，lib/dub.mjs 的 CUT_PAUSE_MS），
//                同一行里接着写「台本在这里没写停顿，按默认停 N 毫秒」；没有 cutBefore 的，单独写一行：包里有配音脚本的是「包里有配音脚本，每一段单独一个请求…」，
//                别的是「和前一段分成两个请求配（开头的提示、语速或参考不同）…」。--no-scene 时行与行之间不加。
//   --concurrency 并发数，默认 2。
//   --no-scene   明说分开：不按一场戏一个请求配，一行一个请求（lib/dub.mjs 第 5a、5c 步；同一个声音接着说的几行也不并，同一行里的几句照旧一个请求）：环境声明了 text-to-dialogue 和 scene-in-request、
//                又给了几个包时，几个人轮流说的一段话默认是一个请求、一个音频（输出里是 <序号>-scene.<扩展名>，一个文件里有整场的几轮，每一行没有各自的音频）；
//                没给这个开关时，同一个声音接着说的几行放得下就并成一个请求。要每一行一个文件、或者只重做某一行，就给这个开关。
//                例外：适配器声明了 limits.minChars 时，比它短的一行照旧并到下一行（lib/dub.mjs 第 5b 步，不并就合成不了），那两行是一个请求、一个文件。
//                行与行之间照台本写的停顿，不记切口的默认停顿（lib/dub.mjs 第 5c 步「切口的气口」：一行一个请求是调用方要的，不是 dub 自己切的）。
//   --adapter, --adapter-option, 官方适配器声明的简写和参数
//                模型从适配器接进来：官方的给名字，自己的给模块文件，可以给多个，后给的盖过先给的（统一的入口和合并规则只在 cli/adapters.mjs 写）。
//                适配器给了费用说明（billing）时，合成开始之前会在标准错误里说明要生成几次（--json 时不说，免得弄脏机器读的输出）。
//   --pack       几个角色：给好几次，每次一个包目录（代替位置上的包目录，给了它位置上就只放台本）。第一个包是台本开头用的声音；
//                一句用哪个包的声音，看它前面最近的 [voice:名字]（认包名或包 ID，不分大小写）。每句的参考段都用它那个包里的，短句只在同一个包里并。
//                dub.json 的每个 unit 记着它的包 ID，顶层 packs 列出全部的包（只给一个包时没有 packs，和原来一样）。
//   --json       标准输出是一份 JSON（和 dub.json 一样的内容）。
//   文字输出      不给 --json 时，每一句下面，有开头的提示就写一行：加了什么、每一项从哪来，或者没加（台本开头自己写了提示），和 JSON 里这一句的 openingCue 对上（一场戏写在每一轮下面）；
//                这一句取到了起伏（0 到 100，没给没有）就写一行「起伏 N（来自 设定 <名字>|命令行的 --expressiveness|台本这一项|包的全局值）」，和 JSON 里这一句的 expressiveness、expressivenessFrom 对上；
//                有停顿、语速要求或目标时长就写一行括号：前面停顿、后面停顿（毫秒）、语速（变过速的写变速前后的长度）、目标时长，和 JSON 里这一句的 pauseBeforeMs、pauseAfterMs、
//                speed、speedChange、targetDuration 一一对上。
//   模型          适配器报了实际用的模型，dub.json 的每一句记在 model；这一次换了模型的句子另有 modelChange: { from, reason }（lib/dub.mjs 文件头「模型」）。
//                有换过的，文字输出另起一条注意，列出哪几句、换成了什么、原来要用什么、为什么。沿用的句子，这两项跟着沿用。
//
// 沿用（lib/dub.mjs 的 options.reuse）：--out 目录里有上一次的 dub.json 时，再跑不重复花钱。上一次做成了（status 是 ok）、文件还在的一句，和这一次的一句是同一个请求，
//   就不再合成：status 是 ok，carriedOver 是 true，文件、模型、换模型的记录、变速和目标时长的记录、seed（--only 换过的连 seedChange；上一次没给 seed 的不记）、增强件、说话人相似度（按这一次的阈值重标）跟着文件沿用。
//   同一个请求：要念的话（spoken）、包（包 ID 和版本；一场戏是每个说话人的包）、目标时长、要的语速、起伏（给了、没给之间换也算不同）、开头的提示、参考文字开头写的名字（referenceName，lib/dub.mjs 第 7c 步；这一版以前配的没记，算不同）都一样；一行一个请求的还要参考段（pick.segmentId）一样，
//   一场戏一个请求的还要每一轮（说话人、话、开头的提示）和每个说话人的参考段一样。按内容认，不按序号：前面插了一个章节标题、序号变了的照样沿用，文件按这一次的序号改名。
//   不比适配器和模型：换了适配器或模型要重配，换一个 --out，或者用 --only。
//   上一次的一句只沿用给一句。--only 点到的一律重做，不按内容沿用；没点到的不比参考段（一场戏只比每一轮，包照样比），沿用上一次的文件和参考段（pick，一场戏是 scene）：
//   偏了的几句换一个 --reference-tag、--only 重做时，别的句子留着上一次的。有沿用的，dub.json 的 notes 和文字输出里有一条 carried_over 写明沿用了哪几句。
//   上一次合成成了、合成以后的几步（audio 钩子、目标时长、语速）出错停下的一句，dub.json 里是 ok、有文件（模型原样的那段），另记着 afterSynthesisFailed: { step }
//   （lib/dub.mjs 文件头「一段失败了怎么办」）：它不算做完，不沿用，再跑重配（再计一次费），那几步照这一次的环境做。
//   要整个重来，换一个 --out。--dry-run 给同一个 --out，规划里照这一条标出能沿用的（ok、carriedOver，文字输出写「沿用上一次的 <文件>，不再合成」），不算进要合成的；不改名、不写文件。
//   磁盘上的 dub.json 只列文件里确实是它自己那一句的音频的句子：沿用按它认，一个文件名底下换成了别的句子的音频，下一次就会沿用错。所以 --out 里已经有 dub.json 的，
//   花钱、改名之前先把它换成一份「没跑完」的（ok 为 false，stoppedBy 是 UNFINISHED，只列不用改名的沿用的几句），改完名再写一次（列上全部沿用的、用新的文件名），
//   之后每做完一句（写好它的文件以后）更新一次；第一次跑（--out 里没有 dub.json）的，做完第一句才写。每次都先写临时文件再换名，写到一半被打断也不会留下半份。
//   进程被杀、agent 的命令超时、断电，留下的就是这一份：mix 不出成品（mix_incomplete），再跑同一条命令接着做，做好的（连被打断以前做好的）沿用，不再花钱。
//   例外是带着 --only 的那条：点到的一律重做，被打断以前这一次做好的几句（这一份里 ok、没有 carriedOver 的）照原样再跑会重配、再计一次费，从 --only 里去掉它们再跑才沿用
//   （UNFINISHED 的说明这样写，mix 的提示点名是哪几句，cli/commands/mix.mjs 的 carriedAdvice）。
//
// --only 换 seed（lib/dub.mjs 的 options.previousSeed）：环境收 seed（声明了 seed-in-request）时，每个请求给同一个固定的 seed，
//   同一句、同一段参考原样再配，出来的音频逐样本一样（试听页 19、20、23 核过），「这一句换一条再配」就落空了。所以 --only 点到的一句，同一个 --out 里
//   上一次的 dub.json 这一句做成了（status 是 ok、文件还在）的，这一次的 seed 是上一次的加 1；上一次是 --only 换了 seed 重配、没成的（失败的记录也记着发出去的 seed
//   和 seedChange），接着往上加：那一次的加 1，不退回固定的那一个（退回去，配出来正是想换掉的那一条）。上一次没做成、也不是换了 seed 重配的（这一句从没做成过），
//   没记 seed 的，照旧用固定的那一个：它要的是做成，不是换一条，和切开的别的几块用同一个 seed。
//   「这一句」按内容认（要念的话一样，同是一场戏或同不是；几句都对得上的，序号一样的优先）。沿用的句子 seed 跟着文件走（见上面「沿用」），所以「上一次的」就是现在那个文件配的时候用的。
//   dub.json 这一句记着 seed 和 seedChange: { from }（上一次的），
//   文字输出在这一句下面写一行「换了 seed」；--dry-run 给同一个 --out 也照这一条算。不是自动重试：只在调用方点名要重配时换，不点名的照旧是固定的 seed。
//
// 没取回：能力报的错标了 details.unretrieved（服务那头已经做完、计过费，只是结果没取回来，例如下载失败；约定见 vocab/capability-signatures.md「General conventions」），
//   这一句记成 failed，可它不是暂时出错：不放进「失败 N 句……重做」那条 --only 命令（照着跑又计一次费，试听页 23 就是这样多花的），文字输出另起一段「没取回 N 句」，
//   每一句照适配器给的 details.retrieve 说怎么取回（任务号这类线索；网址一律不打印），没给就让人看适配器的说明。这一段里写明两条路：再跑同一条命令（或者 --only 点到它）
//   会把它重配、再计一次费（不沿用失败的句子）；不想重配，照 retrieve 手动取回，可手动取回的音频现在还没有办法交回这个输出目录给 mix 用。
//   之后照输出里的 --only 命令重做别的句子，同一个 --out 里上一次没取回、这一次没点到的一句，照旧记成没取回（status 是 failed，error 照上一次的，连着 details.retrieve；
//   同一个请求才算，认法同「沿用」），不记成 skipped：记成 skipped，取回的线索就从 dub.json 里丢了，mix 还会叫人 --only 重配、再计一次费。所以那一次还是退出 1，
//   文字输出照样把它列在「没取回」里。--dry-run 给同一个 --out 也这样标。照旧记着的一句，seed、seedChange 照上一次的（再 --only 它接着往上加，见上面「--only 换 seed」），
//   文字输出不在它下面写「换了 seed」（这一次没配它）；只是参考段不同才对上的，参考跟着记录走（同「沿用」），一场戏的说话人相似度也按那一场上一次的参考段写。
//   这一次带了 --only 的，那一段说「用 --only 点到它、或者去掉 --only 再跑这条命令」：照原样再跑那条 --only 命令不重配它，还会把点到的句子再配一次、再计一次费。
//   dub.json（和 --json 的输出）顶层的 unretrieved 列出这几句的序号（从 1 起，和 --only、文件名、文字输出里的一样，从小到大；照旧记着的也在里面），一眼看得出有几句已经生成、只是没取回；
//   一句都没有就没有这一项（和其他只在有的时候才写的项一样，没有这种句子的 dub.json 和原来一字不差）。跑完的、没跑完的、出错停下的 dub.json 都照这一条。
//
// 文字被拒：能力报的错标了 details.textRejected（只和这一句的文字有关：服务商拒了这句话，或者适配器调用之前查出来的空白、太长、处理不了的字；约定见
//   vocab/capability-signatures.md「General conventions」），这一句记成 failed，别的照常做（lib/dub.mjs「一段失败了怎么办」）。它不是暂时出错：同一句原样再发还是会被拒，
//   所以不放进「失败 N 句（服务暂时出错，稍后重做）」那条 --only 命令；这一句下面写「文字被拒」和错误码，文字输出另起一段「文字被拒 N 句」：
//   先改台本里这几句的字再重做，给一条 --only 命令（同样带着这次的选项；点这几句，有服务暂时出错的连它们一起，见下面「只给一条重做的命令」），每一句列出错误的说明（网址不打印）。dub.json 照旧，原因在 error.details.textRejected。
//   例外：平台说一场戏一个请求装不下的（details.problem 是 too_long_for_one_request，也标 textRejected，lib/dub.mjs 的 scene_too_long）不在这一段：
//   改法是在那一场中间加章节标记切成两场（或者 --no-scene），切开以后序号跟着变，--only 原来的序号点不全。这一场下面写「装不下」，另起一段「装不下 N 场」，
//   说这两种改法、改好以后不带 --only 再跑（做好的沿用），不给 --only 命令。
//   只有一场戏才这样。不是一场戏的一个请求也可能带着这个标（约定写在 vocab/capability-signatures.md 的 voice-cloning、text-to-dialogue 两节「一个请求装不下」，
//   一个人说话和说一场戏用的是同一个模型时就会）：--no-scene 对它没用（台本里别的几场倒要全部重配），它照旧在「文字被拒」一段里（给 --only），
//   这一句的原因下面另写一行：一个请求说不完，把它改短再照那条命令重做；要切成两个请求的，切开以后序号会变，改好以后不带 --only 再跑。两种切法代价不同，那一行分开说：
//   中间另起一行写章节标记的，只有那一章重新切（章节总是切，lib/dub.mjs 第 5c 步），别的章做好的沿用；调小 --max-chars 的，整份都照新的数重新切，
//   比新的数长的请求都会切开，切法变了的做好了也要重配、再计一次费（沿用只认同一个请求，见上面「沿用」）。它不算进「连着被拒」的上限（lib/dub.mjs 的文件头「一段失败了怎么办」）。
//   只给一条重做的命令（cli/dub-failures.mjs 的文件头「只给一条重做的命令」）：几种同时有时，先跑哪一条都只跑了一半，--only 没点到的被拒的、装不下的一场
//   会记成这一次没做（skipped），原因就从 dub.json 里丢了。所以文字被拒的和服务暂时出错的同时有，那条 --only 在「文字被拒」一段，点两种（先改字），
//   「失败 N 句（服务暂时出错，稍后重做）」那一行不另给命令，说和文字被拒的一起重做；有比下限短的（「没合成」）、装不下的一场，一条 --only 命令也不给：
//   「没合成」「装不下」两段都说改好以后不带 --only 再跑（没合成的改长、装不下的切开以后序号可能会变），别的没做成的在那一次里一起重做，「失败」「文字被拒」两段也这样说。
//   叫人加章节标记切开的地方（「装不下」一段、一句装不下的那一行；lib/dub.mjs 的说明 scene_too_long、speech_maybe_unfinished 也是），同一句里跟着写提醒
//   （lib/dub.mjs 的 CHAPTER_SPLIT_REMINDER）：标题后面接着说的不是第一个包的，重写 [voice:名字]，不写就回到第一个包；要停一口气写 [pause 0.5s]，章节处不加默认的停顿。
//   mix 不出成品时照同样的分法说怎么办（cli/dub-failures.mjs，cli/commands/mix.mjs 的文件头）。
//
// 包里的脚本：登记在 dub 功能名下的，用本机的解释器直接运行（node 一定有，python 等按 PATH 找），不让用户确认，不隔离。
//   环境没有脚本要的运行时：在合成之前就报 runtime_missing（--dry-run 不报，只在输出里说缺什么）。
//
// 退出码：0 全部做完；1 有失败的句子（暂时出错的，输出里说了怎么重做；文字被拒的，说了先改字再重做；装不下的一场，说了怎么切开；没取回的，说了怎么取回）或者出错停下来了（错误码在标准错误）；2 用法错误。
// 出错停下来时，已经做完的音频文件和一份记着是怎么停的 dub.json（stoppedBy 是那个错误）都留着；没有出错、是被打断的，stoppedBy 是 UNFINISHED（见上面「沿用」）。
//
// 抛出的错误：dub_input_invalid（.json 台本写坏了、形状不对；给了 --instructions 或者项的 instructions（已拿掉，上面 --instructions 那一项）；开头的提示太长：合成以后整条超过上限、--max-chars 留给台词的太少，lib/dub.mjs 第 7a 步「限长」）；dub_cross_language（参考段不是这一句的语言，没给 --allow-cross-language，上面那一项）；dub_cross_language_unnamed（跨语言的行开头没写名字对，上面那一项）；adapter_invalid、adapter_not_found（cli/adapters.mjs）、适配器自己抛的错、file_unreadable、symlink_not_allowed 等
//   来自各自的模块，lib/dub.mjs、lib/voice-pack.mjs 的 code 见它们的文件头。
import fs from 'node:fs';
import path from 'node:path';
import { VoicePackError } from '../../protocol/lib/errors.mjs';
import { planDub, dubScript, packsNamed, CHAPTER_SPLIT_REMINDER, TEXT_TOO_SHORT } from '../../lib/dub.mjs';
import { isScene } from '../../lib/scene-in-request.mjs';
import { ADAPTER_USAGE, applyAdapters, billingSentence, describeRequests, ffmpegNote, moneySentence, maxCharsOf, maxPauseInRequestMsOf, maxSpeakersOf, minCharsOf, modelOf, quoteArgument, takeAdapterArguments } from '../adapters.mjs';
import { parseArgs, readText, usageProblem } from '../input.mjs';
import { openPackDirectory } from '../pack-directory.mjs';
import { createScriptRuntimes } from '../script-runtimes.mjs';
import { extensionOfMime } from '../audio-files.mjs';
import { BY_LABELS, CROSS_LANGUAGE, pickText, segmentText } from '../pick-text.mjs';
import { isTextRejectedUnit, isTooLong, isTooLongScene, isTooShortUnit, isUnretrievedUnit, rerunsWithoutOnly } from '../dub-failures.mjs';
import { spokenLength } from '../../lib/synthesis-limits.mjs';
import { ARPABET_ALPHABET, ROMAJI_ALPHABET } from '../../lib/pronunciation-lexicon.mjs';

export const summary = 'Dub a script with a voice pack: the reference for each line, the pronunciation lexicon, cues passed to the model unchanged, enhancers, the scripts in the pack';
export const usage = `dub <pack directory>|--pack <pack directory>... <script file|-> --out <directory> ${ADAPTER_USAGE} [--language|--emotion|--style|--energy <tag>] [--instructions <text> (removed: giving it reports dub_input_invalid)] [--speed <factor>] [--expressiveness <0 to 100>] [--setup <name>|<pack>=<name>]... [--no-setup] [--reference-tag <tag>|<pack>=<tag>]... [--target-duration-ms <milliseconds>] [--min-similarity <number>] [--only <number,number>] [--max-chars <number>] [--concurrency <1-8>] [--no-scene] [--allow-cross-language] [--no-language-marks] [--dry-run] [--json]`;

/** 命令认的选项（传给 parseArgs 的那份；--json 由 runner 取走，适配器的参数由 takeAdapterArguments 取走，都不在表里）。用法里要都写出来，约定见 cli/input.mjs 文件头。 */
export const FLAGS = {
  out: 'string', 'dry-run': 'boolean', 'no-scene': 'boolean', 'allow-cross-language': 'boolean', 'no-language-marks': 'boolean', only: 'string', 'max-chars': 'number', concurrency: 'number',
  language: 'string', emotion: 'string', style: 'string', energy: 'string', instructions: 'string' /* 拿掉了，只为报 dub_input_invalid（lib/dub.mjs） */, speed: 'number', expressiveness: 'string' /* 不在这里按数字解析：不是数的值也要报 dub_input_invalid（lib/dub.mjs），不是用法错误 */, setup: 'strings', 'no-setup': 'boolean', 'reference-tag': 'strings', pack: 'strings',
  'target-duration-ms': 'number', 'min-similarity': 'number',
};
const LABEL_FLAGS = ['language', 'emotion', 'style', 'energy'];

/**
 * --setup、--reference-tag 共用的拆法：两个开关认包的写法一样（包名或包 ID，不分大小写），只有 = 的判法和说法不同，各自拆好每个值再交给这里。
 * entries 是 [{ value }]（不带包的）或 [{ pack, packs, value }]（<包>=<值>：pack 照命令行上写的，packs 是它对上的包，lib/dub.mjs 的 packsNamed）。
 * 不带包的只能给一个，两种不混着给；同一个包只点一次：同一个写法两次、名字和包 ID 各写一次、大小写不同，都是用法错误。
 * 名字对不上给了的包、对上不止一个包的，不在这里拦，留给库报 voice_unknown、voice_ambiguous（同 [voice:]）。
 * 返回 { value }（字符串，或者 { 包: 值 } 的表，键照命令行上写的），写法不对返回 { problem }（用法错误）。
 */
function splitPerPack(entries, words) {
  if (entries.some((entry) => entry.value === '' || entry.pack === '')) return { problem: words.empty };
  const bare = entries.filter((entry) => entry.pack === undefined);
  const tabled = entries.filter((entry) => entry.pack !== undefined);
  if (bare.length > 0 && tabled.length > 0) return { problem: words.mixed };
  if (bare.length > 1) return { problem: words.twoBare };
  if (bare.length === 1) return { value: bare[0].value };
  const table = {};
  const seen = new Set();
  for (const { pack, packs: named, value } of tabled) {
    if (Object.hasOwn(table, pack) || (named.length === 1 && seen.has(named[0]))) return { problem: words.twice(pack) };
    if (named.length === 1) seen.add(named[0]);
    table[pack] = value;
  }
  return { value: table };
}

const SETUP_WORDS = {
  empty: '--setup needs the name of a setup (--setup <name>) or <pack>=<name> (neither the pack nor the name may be empty)',
  mixed: '--setup without a pack (every pack looks for that name) and <pack>=<name> (names a setup for one pack) cannot be given together',
  twoBare: '--setup without a pack can be given only once; to name a setup for each pack, write --setup <pack>=<name>, as many times as you need',
  twice: (pack) => `--setup names a setup for pack ${pack} twice (the name and the pack ID each count once): name only one setup per pack`,
};
const REFERENCE_TAG_WORDS = {
  empty: '--reference-tag needs a reference tag (--reference-tag <tag>) or <pack>=<tag> (the tag may not be empty)',
  mixed: '--reference-tag without a pack (every pack uses it) and <pack>=<tag> (names a tag for one pack) cannot be given together',
  twoBare: '--reference-tag without a pack can be given only once; to use a different tag for each pack, write --reference-tag <pack>=<tag>, as many times as you need',
  twice: (pack) => `--reference-tag names a tag for pack ${pack} twice (the name and the pack ID each count once): name only one tag per pack`,
};

/**
 * --setup 的值（给了几次，就有几个）：不带 = 的是设定的名字，每个包都按这个名字找，只能给一个；带 = 的是 <包>=<名字>（名字取第一个 = 后面的全部），点某一个包的，可以重复。
 * 别的规矩见 splitPerPack。返回 { setup }（库的 options.setup：字符串，或者 { 包: 名字 } 的表；没给就没有这个键），写法不对返回 { problem }（用法错误）。
 */
function readSetupFlag(values, packs) {
  if (values === undefined) return {};
  const entries = values.map((value) => {
    const at = value.indexOf('=');
    if (at === -1) return { value };
    const pack = value.slice(0, at).trim();
    return { pack, packs: packsNamed(packs, pack), value: value.slice(at + 1) };
  });
  const split = splitPerPack(entries, SETUP_WORDS);
  return split.problem !== undefined ? split : { setup: split.value };
}

/**
 * --reference-tag 的值（给了几次，就有几个）。和 --setup 不同的只有 = 的判法：第一个 = 左边是这次给了的某个包的名字或 ID，才当 <包>=<标签>；
 * 否则整串是标签（标签里可以有 =），所以要先打开包、认出给了哪些包再拆。别的规矩见 splitPerPack。
 * 返回 { referenceTag }（库的 options.referenceTag：字符串，或者 { 包: 标签 } 的表，键照命令行上写的；没给就没有这个键），写法不对返回 { problem }（用法错误）。
 */
function readReferenceTagFlag(values, packs) {
  if (values === undefined) return {};
  const entries = values.map((value) => {
    const at = value.indexOf('=');
    const left = at === -1 ? '' : value.slice(0, at).trim();
    const named = left === '' ? [] : packsNamed(packs, left);
    return named.length === 0 ? { value } : { pack: left, packs: named, value: value.slice(at + 1) };
  });
  const split = splitPerPack(entries, REFERENCE_TAG_WORDS);
  return split.problem !== undefined ? split : { referenceTag: split.value };
}

/** 读音词表里做不到的一条，写成一句话说明原因（reason 的写法见 lib/pronunciation-lexicon.mjs 的 lexiconRules）。 */
function unappliedReason(item) {
  if (item.reason === 'phoneme') return 'the reading is phonemes; the synthesis model reads them itself';
  if (item.reason === 'phoneme_format' && item.alphabet === ROMAJI_ALPHABET) return item.problem === 'term' ? 'romaji is only for Japanese; this term has characters that are not kana or kanji' : 'the romaji is malformed: each syllable is letters followed by a tone number, one after another, no spaces (ha0shi1ga0)';
  if (item.reason === 'phoneme_format' && item.alphabet === ARPABET_ALPHABET) return item.problem === 'term' ? 'an Arpabet entry takes only one English word' : 'the Arpabet is malformed: phonemes in capitals, vowels with a stress digit 0 to 2, consonants without';
  if (item.reason === 'phoneme_format') return item.problem === 'term' ? 'pinyin is only for Chinese characters; this term has other characters' : item.problem === 'count' ? 'the number of pinyin syllables does not match the number of characters' : 'the pinyin is malformed: each syllable is lowercase letters plus a tone 1 to 5, and ü is written v';
  return 'the reading depends on the part of speech, and there is no grammar information here';
}
const REPORT_FILE = 'dub.json';
/**
 * 还没跑完的 dub.json 的 stoppedBy（文件头「沿用」最后一段）：跑着的时候磁盘上就是这一份，跑完换成完整的报告，出错停下换成那个错误；
 * 被打断（进程被杀、命令超时）的，留下的就是它。
 */
const UNFINISHED = {
  code: 'dub_unfinished',
  message: 'dub is not finished: this report lists only the lines that are already done (it is still running, or it was interrupted: process killed, command timed out). Run the same dub command again to carry on: lines already done are reused and cost nothing; with --only, every line it names is dubbed again, so remove from --only the lines this report shows as done in this run (ok, no carriedOver) before running again',
  details: {},
};

/** 写报告：先写同一个目录里的临时文件，再换名盖过去（写到一半被打断，留下的还是上一份完整的）。 */
function writeReport(file, report) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(temp, file);
}

const pad = (number) => String(number).padStart(3, '0');
/** 一行一个文件：<序号>-<参考段>.<扩展名>；一场戏一个文件（里面有几个人、几段参考）：<序号>-scene.<扩展名>。 */
const fileNameOf = (unit) => `${pad(unit.number)}-${isScene(unit) ? 'scene' : unit.pick.segmentId}.${extensionOfMime(unit.audio.mimeType)}`;

/** 台本文件：.json 是数组，别的是带标记的文本。 */
function readScript(ctx, argument) {
  const text = readText(ctx, argument);
  if (!argument.toLowerCase().endsWith('.json')) return text;
  try {
    const value = JSON.parse(text);
    if (!Array.isArray(value)) throw new Error('not an array');
    return value;
  } catch (cause) {
    throw new VoicePackError('dub_input_invalid', `${argument} is not a script array (expected [{ "text": "…", "labels": {…}? }, …]): ${cause.message}`, { details: { field: 'script' }, cause });
  }
}

/** --only 2,5 -> [1, 4]（库里的下标从 0 起，命令行上的序号从 1 起）。 */
function parseOnly(text) {
  const numbers = text.split(',').map((part) => part.trim());
  if (numbers.some((part) => !/^[1-9][0-9]*$/.test(part))) return null;
  return [...new Set(numbers.map((part) => Number(part) - 1))];
}

/** 给每一段加上命令行层的序号（从 1 起）和文件名。 */
function decorate(units) {
  for (const unit of units) unit.number = unit.index + 1;
  return units;
}

/** 报告里的一段：去掉音频字节。 */
function reportUnit(unit) {
  const { audio, ...rest } = unit;
  void audio;
  return rest;
}

/**
 * 几句是一场戏一个请求、这几场共几行（一场里一行是一轮，unit.scene.turns），写成「一场戏一个请求，这一场共 6 行」；没有场是 null。
 * 费用说明和「共 N 句」那一行都用它：一场戏是一句、一个请求，可里面有好几行，只写句数会让人以为台本只剩一行。
 */
function scenesText(units) {
  const scenes = units.filter(isScene);
  if (scenes.length === 0) return null;
  const lines = scenes.reduce((sum, unit) => sum + unit.scene.turns.length, 0);
  return `one request per scene, ${lines} ${lines === 1 ? 'line' : 'lines'} in ${scenes.length === 1 ? 'this scene' : `these ${scenes.length} scenes`}`;
}

/** 「共 N 句」那一行：有场的时候说清其中几句是一场戏、共几行；没有场和原来一字不差。 */
function totalText(units) {
  const scenes = scenesText(units);
  const count = `${units.length} ${units.length === 1 ? 'line' : 'lines'}`;
  const sceneCount = units.filter(isScene).length;
  return scenes === null ? `Total ${count}:` : `Total ${count} (${sceneCount} of them ${sceneCount === 1 ? 'is a scene' : 'are scenes'}: ${scenes}):`;
}

/**
 * --dry-run 文字输出的第一行（文件头「汇总」）：要念多少字、分几个请求（这次要合成几个）、用哪个模型。models 是要调的两项能力 → modelOf 的结果
 * （模型名；适配器没声明是 null；没有适配器提供是 undefined）。不估计时长：念多快没量过，写了就是编的。
 */
function summaryText(report, models) {
  const requests = report.units.filter((unit) => unit.error?.code !== TEXT_TOO_SHORT); // 比下限短的不发请求，字也不算
  const chars = requests.reduce((sum, unit) => sum + spokenLength(unit.spoken ?? ''), 0); // 和配音默认的软上限同一种数法（lib/synthesis-limits.mjs）
  const planned = requests.filter((unit) => unit.status === 'planned').length;
  const scenes = requests.filter(isScene).length;
  const counted = `split into ${requests.length} ${requests.length === 1 ? 'request' : 'requests'}${scenes === 0 ? '' : ` (${scenes} of them ${scenes === 1 ? 'is a scene' : 'are scenes'})`}${planned === requests.length ? '' : `, ${planned} to synthesize this time (the others are reused from the last run, kept as not retrieved, or not done this time)`}`;
  // 一场戏调 text-to-dialogue（规划出一场戏，环境就有它），别的调 voice-cloning；同一个模型的几项能力写在一起
  const used = [...new Set(requests.map((unit) => (isScene(unit) ? 'text-to-dialogue' : 'voice-cloning')))];
  const byModel = new Map();
  const missing = [];
  for (const capability of used) {
    if (capability === 'voice-cloning' && !report.capabilities[capability]) {
      missing.push(`the environment has no ${capability}`);
      continue;
    }
    const name = models[capability] ?? 'the adapter does not say which model';
    byModel.set(name, [...(byModel.get(name) ?? []), capability]);
  }
  const model = [...[...byModel].map(([name, capabilities]) => `${name} (${capabilities.join(', ')})`), ...missing].join(', ');
  return `Summary: ${chars} ${chars === 1 ? 'character' : 'characters'} to speak (cues and tag names removed; a run of whitespace counts as one), ${counted}${model === '' ? '' : `, model: ${model}`}`;
}

/** 这一句所在的包有没有配音脚本（report.scripts 是登记在 dub 名下的脚本；几个包时脚本和句子都带着包 ID，一个包时都没有）。 */
const hasDubScripts = (report, unit) => report.scripts.some((item) => item.pack === unit.pack);

/**
 * 报告（dub.json，--json 的输出）顶层的 unretrieved（文件头「没取回」）：没取回的几句的序号，从 1 起，和 --only、文件名、文字输出里的一样，从小到大。
 * 这一次没取回的，和上一次没取回、这一次 --only 没点到、照旧记着的（unretrievedFinder）都在里面。
 * 一句都没有就不写这一项：没有这种句子的报告和原来一字不差。跑完的、没跑完的、出错停下的报告，--dry-run 的规划，都照这一条。
 */
function withUnretrieved(report) {
  const numbers = report.units.filter(isUnretrievedUnit).map((unit) => unit.number).sort((a, b) => a - b);
  return numbers.length === 0 ? report : { ...report, unretrieved: numbers };
}
/** 没取回的一句怎么取回：适配器给的 error.details.retrieve（网址一律不打印，万一写进去了也换掉）；没给就让人看适配器的说明。 */
const retrieveText = (unit) => {
  const said = unit.error?.details?.retrieve;
  return typeof said === 'string' && said.trim() !== '' ? said.trim().replace(/https?:\/\/\S+/g, '(URL not printed)') : `the adapter does not say how to retrieve it (error code ${unit.error?.code}); see the adapter's documentation`;
};

/** 文字被拒的一句为什么被拒：错误的说明，并成一行，网址不打印（同「没取回」）。 */
const rejectedText = (unit) => String(unit.error?.message ?? '').replace(/\s+/g, ' ').trim().replace(/https?:\/\/[^\s)）\]】」>"']+/g, '(URL not printed)').replace(/[（(]\(URL not printed\)[）)]/g, '(URL not printed)') || 'no explanation';

/** 一串段的序号（命令行上的，从 1 起，和下面的列表、文件名、--only 一样），用顿号连起来。 */
const numbersOf = (units) => units.map((unit) => unit.number).join(', ');

/** 因为放不下一个请求才切开的地方（unit.cutBefore，lib/dub.mjs 第 5c 步；换了语言切开的 'language' 另有说法）。 */
const CUT_LABELS = { scene: 'a scene boundary (a line that only has a pause)', paragraph: 'a paragraph boundary (between lines)', sentence: 'inside a line (between sentences: this line alone does not fit)' };

/** 一句用的参考段（和它的标签）、原因（说法在 cli/pick-text.mjs，convert 也用）。几个包时前面写着包 ID：一句用哪个包的声音，要看得出来。 */
function pickLabel(unit, many) {
  // 一场戏：每个说话人用的参考段（包 ID 加参考段）和原因，次序就是说话人的编号
  if (isScene(unit)) return `[a scene · ${unit.scene.speakers.map(({ pack, pick }) => `${pack} ${segmentText(pick)}, ${[BY_LABELS[pick.by], ...(pick.crossLanguage ? [CROSS_LANGUAGE.speaker] : [])].join(', ')}`).join(' · ')}]`;
  return `[${[...(many ? [unit.pack] : []), ...pickText(unit.pick)].join(' · ')}]`;
}

/** 一句的目标时长（dub.json 的 units[i].targetDuration，lib/dub.mjs 第 8 步）：规划里只有目标；合成以后有原长、变速的倍数、变速以后的长度。 */
function targetText(fit) {
  if (fit.originalMs === undefined) return `target ${fit.targetMs} ms (the speed is changed after synthesis)`;
  const original = fit.originalMs === null ? 'original length not measured (not WAV; ffmpeg is needed to decode it)' : `original ${fit.originalMs} ms`;
  if (fit.speed === null) return `target ${fit.targetMs} ms, ${original}, speed not changed (the environment has no ffmpeg)`;
  const missed = fit.limit === undefined ? '' : `, beyond the ${fit.limit === 'max' ? 'upper' : 'lower'} limit of the speed change, ${fit.offByMs > 0 ? `${fit.offByMs} ms longer` : `${-fit.offByMs} ms shorter`} than the target`;
  return `target ${fit.targetMs} ms, ${original}, speed factor ${fit.speed}, ${fit.actualMs} ms after the speed change${missed}`;
}

/** 一句的语速变了没有（dub.json 的 units[i].speedChange，lib/dub.mjs 第 7b 步）：要的倍数、实际用的、变速前后的长度。 */
function speedText(change) {
  const original = change.originalMs === null ? 'original length not measured (not WAV; ffmpeg is needed to decode it)' : `original ${change.originalMs} ms`;
  if (change.speed === null) return `speed ${change.wanted}, ${original}, speed not changed (the environment has no ffmpeg; it is changed when stitching if ffmpeg is available)`;
  const limited = change.limit === undefined ? '' : ` (the wanted factor ${change.wanted} is beyond the ${change.limit === 'max' ? 'upper' : 'lower'} limit of the speed change)`;
  return `speed ${change.speed}${limited}, changed after synthesis: ${original}, ${change.actualMs} ms after the speed change`;
}

/**
 * 适配器换了模型的几句（unit.modelChange，lib/dub.mjs 文件头「模型」）：一条注意，写明哪几句、换成了什么、原来要用什么、为什么；一句都没换就是 null。
 * 换上的模型、原来的模型、原因都一样的几句写在一起。
 */
function modelChangeNote(units) {
  const groups = new Map();
  for (const unit of units) {
    if (unit.modelChange === undefined) continue;
    const key = JSON.stringify([unit.model, unit.modelChange.from, unit.modelChange.reason]);
    if (!groups.has(key)) groups.set(key, { model: unit.model, from: unit.modelChange.from, reason: unit.modelChange.reason, units: [] });
    groups.get(key).units.push(unit);
  }
  if (groups.size === 0) return null;
  const parts = [...groups.values()].map((group) => `${group.units.length === 1 ? 'line' : 'lines'} ${numbersOf(group.units)} synthesized with ${group.model} instead of ${group.from} (${group.reason})`);
  return `Note: the adapter changed the model: ${parts.join('; ')}. The voice and the acting of these lines may differ from the other lines`;
}

const ITEM_LABELS = { emotion: 'emotion', style: 'style', energy: 'energy' };
const FROM_LABELS = { caller: 'the caller', setup: 'the setup' };
/** 请求开头的提示（unit.openingCue，一场戏是每一轮的，lib/dub.mjs 文件头「设定」）：加了什么、每一项从哪来；台本在这一段开头自己写了提示的，写明没加。 */
function openingText(opening) {
  const from = Object.entries(opening.parts).map(([item, part]) => `${ITEM_LABELS[item]} from ${FROM_LABELS[part.from]}`).join(', ');
  return opening.added
    ? `Opening cue added: ${opening.cue} (${from})`
    : `Opening cue not added: the script wrote its own cue at the start of this passage, so the script's is used (the caller and the setup would have made it ${opening.cue})`;
}

const EXPRESSIVENESS_FROM = { item: 'this script item', option: 'the --expressiveness option', global: "the pack's global value", mixed: 'different levels for the lines merged into this request' };
/**
 * 一个请求的起伏和它从哪一层来（unit.expressiveness、unit.expressivenessFrom，lib/dub.mjs 文件头「设定」的先后）：写在预演和正式运行的文字输出里，
 * 写台本的人看得到默认设定、命令行、台本、包的全局值里是哪一个起了作用。哪一层都没给（没有这个值）是 null。
 */
function expressivenessText(report, unit) {
  if (unit.expressiveness === undefined) return null;
  const packId = unit.pack ?? report.pack?.id;
  const setup = (report.packs ?? [report.pack]).find((item) => item?.id === packId)?.setup?.name;
  const from = unit.expressivenessFrom === 'setup' ? (setup === undefined ? 'the setup' : `setup ${setup}`) : EXPRESSIVENESS_FROM[unit.expressivenessFrom];
  return `expressiveness ${unit.expressiveness}${from === undefined ? '' : ` (from ${from})`}`;
}

/** 沿用上一次的说话人相似度：量出来的按这一次的阈值重标（没给阈值就不标），别的原样。 */
function againstThreshold(record, minSimilarity) {
  if (record.status !== 'measured') return record;
  const { drifted, ...rest } = record;
  void drifted;
  return minSimilarity === null ? rest : { ...rest, drifted: record.similarity < minSimilarity };
}

/** 上一次的报告里一句的文件名：只认 dub 自己写的样子（<序号>-<…>.<扩展名>，没有目录），别的不沿用（不按报告里写的路径去挪目录外面的文件）。 */
const isOwnFileName = (name) => typeof name === 'string' && path.basename(name) === name && /^[0-9]{3,}-[^/\\]+\.[A-Za-z0-9]+$/.test(name);

/**
 * 一个报告（上一次的 dub.json，或者这一次的规划）里，一句用到的包：[{ id, version }]。一行一个请求的是它自己的一个包：只给一个包时 unit.pack 没有，是顶层的 pack；
 * 几个包时在 packs 里按 ID 找。一场戏是每个说话人的包，按说话人的编号排（scene.speakers[i].pack）。
 */
function packsOf(report, unit) {
  const listed = report?.packs ?? (report?.pack === undefined ? [] : [report.pack]);
  const ids = isScene(unit) ? (unit.scene?.speakers ?? []).map((speaker) => speaker.pack) : [unit.pack ?? report?.pack?.id];
  return ids.map((id) => ({ id, version: listed.find((item) => item.id === id)?.version }));
}
/** 上一次的这几个包（was）和这一次的（now）是不是同样的几个：ID 一个一个对上，版本也对上（上一次没记版本的不比版本）。 */
const samePacks = (was, now) => was.length > 0 && was.length === now.length
  && was.every((item, k) => item.id !== undefined && item.id === now[k].id && (item.version === undefined || item.version === now[k].version));

/** 一场戏的几轮：说话人、话、开头的提示（每一轮的参考 picked、舞台说明 directions 不比）。 */
const turnsOf = (scene) => JSON.stringify((scene?.turns ?? []).map((turn) => [turn.speaker, turn.text, turn.openingCue ?? null]));
/** 一场戏每个说话人用的参考段。 */
const speakersOf = (scene) => JSON.stringify((scene?.speakers ?? []).map((speaker) => [speaker.pack, speaker.pick?.segmentId ?? speaker.segmentId, speaker.languageMarks ?? null]));

/**
 * 上一次的一句（before，dub.json 里的）和这一次的一句（unit，规划里的）是不是同一个请求（文件头「沿用」）。withPick 为 false 时不比参考段（一场戏只比每一轮）。
 * 包按 ID 和版本比，一场戏比每个说话人的包（withPick 为 false 时也比）：previous 是上一次的报告，current 是这一次的包（写法同报告顶层的 pack、packs）。
 */
function sameRequest(before, unit, { previous, current, withPick }) {
  if (isScene(before) !== isScene(unit) || before.spoken !== unit.spoken) return false;
  if (!samePacks(packsOf(previous, before), packsOf(current, unit))) return false;
  if ((before.targetDuration?.targetMs ?? null) !== (unit.targetDuration?.targetMs ?? null)) return false;
  // 要的语速：上一次变过速的记在 speedChange.wanted（speed 已经是 null），没变成的还在 speed
  if ((before.speedChange?.wanted ?? before.speed ?? null) !== unit.speed) return false;
  // 起伏：没记的（上一次没给，或者是没有这一项的老报告）和这一次没给是同一个请求
  if ((before.expressiveness ?? null) !== (unit.expressiveness ?? null)) return false;
  if (JSON.stringify(before.openingCue ?? null) !== JSON.stringify(unit.openingCue ?? null)) return false;
  if (JSON.stringify(before.languageMarks ?? null) !== JSON.stringify(unit.languageMarks ?? null)) return false; // 跨语言的请求写的语言和名字（lib/dub.mjs 第 7c 步）：不一样就是另一个请求
  if ((before.referenceName ?? null) !== (unit.referenceName ?? null)) return false; // 同语言的参考文字开头写的名字（lib/dub.mjs 第 7c 步）：这一版以前配的没记，是另一个请求
  if (isScene(unit)) return turnsOf(before.scene) === turnsOf(unit.scene) && (!withPick || speakersOf(before.scene) === speakersOf(unit.scene));
  return !withPick || before.pick?.segmentId === unit.pick.segmentId;
}

/**
 * 库的 reuse（文件头「沿用」）：previous 是上一次的 dub.json（没有是 null），current 是这一次的包（写法同报告顶层的 pack、packs），minSimilarity 是这一次的阈值。
 * 返回 (unit) => 要并进这一句的字段，或者 null。合成以后的几步没做完的（afterSynthesisFailed）不沿用。上一次的一句只沿用给一句；先找参考段也一样的，only 没点到的再找只是参考段不同的；几句都对得上的，序号一样的优先。
 */
function reuser({ previous, out, minSimilarity, current }) {
  // 合成以后的几步没做完就停下的一句（afterSynthesisFailed，lib/dub.mjs 文件头「一段失败了怎么办」）不沿用：文件是模型原样的那段，目标时长、钩子、语速没做
  const pool = (Array.isArray(previous?.units) ? previous.units : []).filter((before) => before?.status === 'ok' && before.afterSynthesisFailed === undefined && isOwnFileName(before.file) && fs.existsSync(path.join(out, before.file)));
  const used = new Set();
  return (unit) => {
    const pick = (withPick) => {
      const matched = pool.filter((before) => !used.has(before) && sameRequest(before, unit, { previous, current, withPick }));
      return matched.find((before) => before.index === unit.index) ?? matched[0];
    };
    const strict = pick(true);
    const before = strict ?? (unit.status === 'skipped' ? pick(false) : undefined);
    if (before === undefined) return null;
    used.add(before);
    return {
      file: before.file,
      ...(strict === undefined ? (isScene(unit) ? { scene: before.scene } : { pick: before.pick }) : {}), // 只沿用了文件、参考段不同的：参考跟着文件走
      // 那个文件是上一次用哪个模型合成的、换没换过模型、变速和目标时长的记录、用上的增强件，都跟着文件走；按语速变过速的 speed 是 null，拼接的人不再变
      ...(before.model === undefined ? {} : { model: before.model }),
      ...(before.modelChange === undefined ? {} : { modelChange: before.modelChange }),
      ...(before.targetDuration === undefined ? {} : { targetDuration: before.targetDuration }),
      ...(before.speedChange === undefined ? {} : { speedChange: before.speedChange }),
      ...(before.enhancers === undefined ? {} : { enhancers: before.enhancers }),
      // seed 也跟着文件走（文件头「--only 换 seed」）：那个文件是用哪个 seed 配的，--only 换过的连 seedChange 一起；下一次 --only 这一句，按它加 1。
      // 上一次没给 seed 的（那时的环境不收 seed），这一句也不记 seed（规划时按这一次的环境写上的固定 seed 不是那个文件用的）
      ...(before.seed === undefined ? { seed: undefined } : { seed: before.seed }),
      ...(before.seedChange === undefined ? {} : { seedChange: before.seedChange }),
      speed: before.speed ?? null,
      // 说话人相似度量的是那个文件，跟着沿用；标不标按这一次的阈值重算（一场戏的是规划时写的，库按并进来的 scene 重写）
      ...(isScene(unit) || before.speakerSimilarity === undefined ? {} : { speakerSimilarity: againstThreshold(before.speakerSimilarity, minSimilarity) }),
    };
  };
}

/**
 * 上一次没取回的一句，这一次 --only 没点到的（文件头「没取回」）：照旧记成没取回，不记成 skipped。上一次的 dub.json 里这一句的 error（details.retrieve）
 * 是取回它的线索，记成 skipped 就从新的 dub.json 里丢了，mix 还会叫人 --only 重配、再计一次费。previous 是上一次的 dub.json，current 是这一次的包（同 reuser）。
 * 返回 (unit) => 要并进这一句的字段，或者 null；调用方只拿 skipped 的来问（沿用之后还是 skipped 的）。认法同沿用（sameRequest）：先找参考段也一样的，再找只是参考段不同的
 * （参考跟着记录走）；几句都对得上的，序号一样的优先；上一次的一句只给一句。并进来的：status 是 failed，error 照上一次的，seed 是配它那一次用的（上一次没记就不记）；
 * seedChange 照上一次的：再 --only 它接着往上加（seedFinder 认失败记录上的 seedChange）；文字输出不写「换了 seed」，这一次没配它（调用方记下照旧记着的几句，render 的 kept）。
 */
function unretrievedFinder({ previous, current }) {
  const pool = (Array.isArray(previous?.units) ? previous.units : []).filter((before) => isPlainRecord(before) && isUnretrievedUnit(before));
  const used = new Set();
  return (unit) => {
    const pick = (withPick) => {
      const matched = pool.filter((before) => !used.has(before) && sameRequest(before, unit, { previous, current, withPick }));
      return matched.find((before) => before.index === unit.index) ?? matched[0];
    };
    const strict = pick(true);
    const before = strict ?? pick(false);
    if (before === undefined) return null;
    used.add(before);
    return {
      status: 'failed',
      error: before.error,
      ...(strict === undefined ? (isScene(unit) ? keptScene(unit, before) : { pick: before.pick }) : {}), // 只是参考段不同的：参考跟着记录走（同沿用）
      seed: before.seed,
      seedChange: before.seedChange, // 没有就是 undefined，不写进 JSON
    };
  };
}
const isPlainRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/**
 * 只是参考段不同才对上的一场戏（unretrievedFinder）：scene 跟着记录走；规划时写的说话人相似度（每个说话人「量不了」，带着这一次的参考段，lib/dub.mjs 第 9 步）
 * 改成那一场上一次的参考段，同库里沿用的一场（lib/dub.mjs 的 settleUnits）。说话人的次序两边一样：sameRequest 的 samePacks 按说话人逐个比过包。
 */
const keptScene = (unit, before) => ({
  scene: before.scene,
  ...(unit.speakerSimilarity?.speakers === undefined ? {} : {
    speakerSimilarity: {
      ...unit.speakerSimilarity,
      speakers: unit.speakerSimilarity.speakers.map((item, k) => {
        const was = before.scene?.speakers?.[k];
        return { ...item, segmentId: was?.pick?.segmentId ?? was?.segmentId ?? item.segmentId };
      }),
    },
  }),
});

/**
 * 库的 previousSeed（文件头「--only 换 seed」）：--only 点到的一句，上一次配它用过的 seed：上一次做成了（status 是 ok、文件还在）的，那一次用的；
 * 上一次是 --only 换了 seed 重配、没成的（status 是 failed，记着 seedChange），那一次发出去的。都没有就是 null（照旧用固定的 seed）。
 * 「这一句」按内容认：要念的话（spoken）一样、同是一场戏或同不是；几句都对得上的，序号一样的优先，再取 seed 最大的。上一次没记 seed（那时的环境不收 seed）的不算。
 */
function seedFinder({ previous, out }) {
  const known = (Array.isArray(previous?.units) ? previous.units : []).filter((before) => Number.isSafeInteger(before?.seed)
    && ((before.status === 'ok' && isOwnFileName(before.file) && fs.existsSync(path.join(out, before.file))) || (before.status === 'failed' && before.seedChange !== undefined)));
  return (unit) => {
    const matched = known.filter((before) => isScene(before) === isScene(unit) && before.spoken === unit.spoken);
    const same = matched.filter((item) => item.index === unit.index);
    const seeds = (same.length > 0 ? same : matched).map((before) => before.seed);
    return seeds.length === 0 ? null : Math.max(...seeds);
  };
}

/** 沿用的一句这一次该叫什么：<序号>-<参考段>（一场戏是 -scene），扩展名照上一次的文件。 */
const carriedName = (unit) => `${pad(unit.number)}-${isScene(unit) ? 'scene' : unit.pick.segmentId}${path.extname(unit.file)}`;

/**
 * 沿用的文件按这一次的序号改名（前面插了一块、序号变了的）。在花钱之前做：之后这一次合成的文件按序号写，不会盖掉沿用的。
 * 先都挪到临时的名字，再挪到新名字：几个文件的新旧名字交错时不互相盖掉（上一次的一句只沿用给一句，所以旧名字不重复）。
 */
function renameCarried(out, units) {
  const moves = units.filter((unit) => unit.carriedOver === true && unit.file !== carriedName(unit));
  const temps = moves.map((unit, k) => {
    const temp = `.dub-carried-${k}.tmp`;
    fs.renameSync(path.join(out, unit.file), path.join(out, temp));
    return temp;
  });
  moves.forEach((unit, k) => {
    unit.file = carriedName(unit);
    fs.renameSync(path.join(out, temps[k]), path.join(out, unit.file));
  });
}

/** 说话人相似度量不了的原因（unit.speakerSimilarity.speakers[i].reason），命令行上的说法。 */
const UNMEASURABLE_REASONS = { scene_in_request: 'one request per scene, and one audio has no boundaries between the speakers; to measure, use --no-scene for one request per line' };

/** 一句的说话人相似度（unit.speakerSimilarity，lib/dub.mjs 第 9 步），写在这一句下面的一行；没有就是 null。minSimilarity 是这一次的阈值。 */
function similarityText(unit, minSimilarity) {
  const record = unit.speakerSimilarity;
  if (record === undefined) return null;
  if (record.speakers !== undefined) {
    // 一场戏：每个说话人一项，原因一样的几个人写在一起
    const groups = new Map();
    for (const speaker of record.speakers) groups.set(speaker.reason, [...(groups.get(speaker.reason) ?? []), speaker]);
    return [...groups.values()].map((group) => `${group.map((speaker) => `speaker ${speaker.speaker} (${speaker.pack} ${speaker.segmentId})`).join(', ')}: similarity ${group[0].label}: ${UNMEASURABLE_REASONS[group[0].reason] ?? group[0].message}`).join('; ');
  }
  if (record.status === 'measured') return `similarity ${record.similarity}, compared with reference ${record.segmentId}${record.drifted ? `, below the threshold ${minSimilarity}: the voice may have drifted` : ''}`;
  if (record.status === 'no_speech') return `similarity ${record.label}: ${record.which === 'generated' ? 'the synthesized audio' : `reference ${record.segmentId}`} has no speech to take a voiceprint from`;
  return `similarity ${record.label}: ${record.error.code} (service error, not retried)`;
}

/** 低于阈值的几句（unit.speakerSimilarity.drifted）：一条注意，列出哪几句、相似度、和哪一段参考比的；一句都没有就是 null。 */
function driftNote(units, minSimilarity) {
  const drifted = units.filter((unit) => unit.speakerSimilarity?.drifted === true);
  if (drifted.length === 0) return null;
  const listed = drifted.map((unit) => `line ${unit.number} ${unit.speakerSimilarity.similarity} (reference ${unit.speakerSimilarity.segmentId})`);
  return `Note: speaker similarity is below the threshold ${minSimilarity} (--min-similarity), so the voice may have drifted: ${listed.join('; ')}. dub does not redo them itself: to redo, use a different reference segment (a different reference tag), then use --only to redo just these lines`;
}

/** 用了哪一套设定：包里有设定的才说（几个包时每个包一行）。noSetup：这一次给了 --no-setup。 */
/** 文字输出：这个声音的全局值在起作用的包，一个一行（设定的值写在「设定」一行，这里不重复）。写台本的人靠它知道这个声音固定了值。 */
function globalExpressivenessLines(report) {
  const many = report.packs !== undefined;
  return (report.packs ?? [report.pack]).filter((item) => item.expressiveness?.from === 'global').map((item) => `Expressiveness from the pack: ${many ? `${item.name}: ` : ''}${item.expressiveness.value} (global value)`);
}

function setupLines(report, noSetup) {
  const many = report.packs !== undefined;
  return (report.packs ?? [report.pack]).filter((item) => item.setups !== undefined).map((item) => {
    const who = many ? `${item.name}: ` : '';
    const available = item.setups.join(', ');
    if (noSetup) return `Setup: ${who}no setup used this time (--no-setup); the pack has ${available}`;
    return item.setup === undefined
      ? `Setup: ${who}no setup used this time (the pack has ${available}, none is the default; name one with --setup <name>)`
      : `Setup: ${who}${item.setup.name} (${item.setup.by === 'option' ? 'named by --setup' : "the pack's default setup"}${item.setup.expressiveness === undefined ? '' : `, expressiveness ${item.setup.expressiveness}`}); the pack has ${available}`;
  });
}

/**
 * 文字输出。noSetup：这一次给了 --no-setup（「设定」一行的说法）。onlyGiven：这一次带了 --only（「没取回」一段的说法跟着变，文件头「没取回」）；kept：照旧记着没取回的几句的序号（unretrievedFinder，这一次没配它们）。
 */
function render(report, { packArguments, scriptArgument, out, planOnly, redo, onlyGiven, kept, models, noSetup }) {
  const lines = planOnly ? [summaryText(report, models)] : []; // 文件头「汇总」
  const many = report.packs !== undefined;
  lines.push(many
    ? `Pack: ${report.packs.map((item) => `${item.name} (${item.id} ${item.version})`).join(', ')} (the voice at the start is ${report.pack.name})`
    : `Pack: ${report.pack.name} (${report.pack.id} ${report.pack.version})`);
  lines.push(...setupLines(report, noSetup));
  lines.push(...globalExpressivenessLines(report));
  const { lexicon } = report;
  const phonemes = lexicon.phonemes ?? [];
  if (lexicon.applied.length > 0 || lexicon.unapplied.length > 0 || phonemes.length > 0) {
    const applied = lexicon.applied.map((item) => `${item.term} → ${item.say} (${item.count} ${item.count === 1 ? 'place' : 'places'})`).join('; ');
    const marked = phonemes.map((item) => `${item.term} (${item.ph}, ${item.count} ${item.count === 1 ? 'place' : 'places'})`).join('; ');
    const unapplied = lexicon.unapplied.map((item) => `${item.term} (${unappliedReason(item)})`).join('; ');
    lines.push(`Pronunciation lexicon: ${applied === '' ? 'not used in this script' : `replaced ${applied}`}${marked === '' ? '' : `; phonemes marked ${marked}`}${unapplied === '' ? '' : `; could not apply: ${unapplied}`}`);
  }
  // 指引不交给模型（lib/dub.mjs 文件头开头）：照它写的演法要写成台本里的提示
  if (report.guidance.present) lines.push('Dubbing guidance: not passed to the model; write the acting it describes as cues in the script (square brackets, placed where the delivery changes)');
  const similarity = report.speakerSimilarity;
  lines.push(similarity.measured
    ? `Speaker similarity: each synthesized audio is compared once with the reference it used (speaker-verification)${similarity.minSimilarity === null ? ', --min-similarity not given, so the numbers are only reported, not flagged' : `, those below ${similarity.minSimilarity} are flagged`}`
    : 'Speaker similarity: the environment has no speaker-verification, so nothing was measured this time');
  if (report.enhancers.offered.length > 0) {
    const describe = (list) => list.map((item) => `${item.id} (${item.model} ${item.modelVersion})`).join(', ');
    if (planOnly) lines.push(`Enhancers: the pack has ${describe(report.enhancers.offered)}; they are passed to the environment at synthesis and are used only if the environment knows the matching model`);
    else if (report.enhancers.used.length > 0) lines.push(`Enhancers: used ${report.enhancers.used.join(', ')}${report.enhancers.notUsed.length > 0 ? `; not used ${describe(report.enhancers.notUsed)}` : ''}`);
    else if (report.enhancers.statement === 'enhancers_not_used') lines.push(`Enhancers: none used this time (the environment has no matching model); generated as usual. The pack has ${describe(report.enhancers.notUsed)}${report.verification.length > 0 ? `; verification records are in ${REPORT_FILE}` : ''}`);
  }
  if (report.scripts.length > 0) lines.push(`Scripts: ${report.scripts.map((item) => `${item.pack === undefined ? '' : `${item.pack} `}${item.entry} (${item.runtime})`).join(', ')}`);
  if (report.missingRuntimes.length > 0) lines.push(`Missing runtime: ${report.missingRuntimes.map((item) => `${item.runtime} (script ${item.pack === undefined ? '' : `${item.pack} `}${item.entry})`).join(', ')}; the real synthesis reports runtime_missing before it starts`);
  if (!report.capabilities['voice-cloning']) lines.push('Missing required capability: voice-cloning; the real synthesis reports capability_missing before it starts');
  for (const note of report.notes) lines.push(`Note: ${note.message}`);
  const switched = modelChangeNote(report.units);
  if (switched !== null) lines.push(switched);
  const drift = driftNote(report.units, similarity.minSimilarity);
  if (drift !== null) lines.push(drift);
  lines.push('', totalText(report.units));
  for (const unit of report.units) {
    // 规划里沿用的一句（--dry-run 给了 --out）：文件还是上一次的名字，正式运行时才按这一次的序号改名
    const carried = planOnly ? ` (reuses ${unit.file} from the last run, not synthesized again)` : ` → ${path.join(out, unit.file ?? '')} (reused from the last run, not synthesized again)`;
    const failedText = isTooShortUnit(unit) ? ' (not synthesized: shorter than the lower limit of the synthesis capability)'
      : isUnretrievedUnit(unit) ? ' (not retrieved: the service has finished it, see below)'
        : isTooLongScene(unit) ? ' (does not fit: the platform says one request cannot hold this scene, see below)'
        : isTextRejectedUnit(unit) ? ` (text rejected: ${unit.error.code}, see below)`
          : ` (failed: ${unit.error?.code})`;
    const where = unit.carriedOver === true ? carried : unit.file !== undefined ? ` → ${path.join(out, unit.file)}` : unit.status === 'failed' ? failedText : unit.status === 'skipped' ? (planOnly ? ' (will not be done this time)' : ' (not done this time)') : '';
    lines.push(`  ${unit.number}. ${pickLabel(unit, many)}${where}`);
    if (!isScene(unit)) {
      lines.push(`     ${unit.spoken.replaceAll('\n', '\n     ')}`); // 一章并成一个请求的，台本的一行一行（lib/dub.mjs 第 5c 步）：每一行都缩进
      // 切口（lib/dub.mjs 第 5c 步）：为什么切开；dub 记了默认停顿的（cutPause），写明按默认停了多久
      const breath = unit.cutPause === undefined ? '' : `; the script wrote no pause here, so the default pause of ${unit.pauseBeforeMs} ms is used`;
      if (unit.cutBefore === 'language') lines.push(`     (the language changed and a different reference segment is used, so it is cut from the previous piece here${breath})`);
      else if (unit.cutBefore !== undefined) lines.push(`     (does not fit in one request: cut from the previous piece at ${CUT_LABELS[unit.cutBefore]}${breath})`);
      // 包里有配音脚本的一律不并（lib/dub.mjs 的 joinIntoRequests：text 钩子要看到每一句的原话），理由就是它；别的是开头的提示、语速或参考不同
      else if (unit.cutPause !== undefined && hasDubScripts(report, unit)) lines.push(`     (the pack has dubbing scripts, so each piece is its own request, dubbed apart from the previous piece${breath})`);
      else if (unit.cutPause !== undefined) lines.push(`     (dubbed as a separate request from the previous piece: the opening cue, speed or reference differs${breath})`);
      if (unit.openingCue !== undefined) lines.push(`     ${openingText(unit.openingCue)}`);
    } else {
      lines.push(`     (one request, one audio: each line has no audio of its own; use --no-scene to split them, one file per line; where the environment has a minimum character count, a line shorter than it is still merged into the next line)`);
      // 一场戏放不下一个请求，在行与行之间切成了几场（lib/dub.mjs 第 5a 步）：后一场写明；切口两边是同一个人、dub 记了默认停顿的（cutPause），写明停多久
      const breath = unit.cutPause === undefined ? '' : `; the script wrote no pause here, so the default pause of ${unit.pauseBeforeMs} ms is used`;
      if (unit.cutBefore !== undefined) lines.push(`     (does not fit in one request: cut from the previous scene at ${CUT_LABELS[unit.cutBefore]}${breath})`);
      for (const turn of unit.scene.turns) {
        lines.push(`     speaker ${turn.speaker}: ${turn.text}`);
        if (turn.openingCue !== undefined) lines.push(`       ${openingText(turn.openingCue)}`);
      }
    }
    const expressiveness = expressivenessText(report, unit);
    if (expressiveness !== null) lines.push(`     ${expressiveness}`);
    // --only 重配换了 seed（文件头「--only 换 seed」）：和 JSON 里这一句的 seed、seedChange 对上。沿用的一句、照旧记着没取回的一句（kept）带着上一次的 seedChange，
    // 这一次没重配它，不写
    if (unit.seedChange !== undefined && unit.carriedOver !== true && !kept.has(unit.number)) lines.push(`     (seed changed: ${unit.seedChange.from} last time, ${unit.seed} this time. Only a redo with --only changes it; the same seed with the same request has not always given the same audio)`);
    // 停顿、语速和目标时长：和 --json 里这一句的 pauseBeforeMs、pauseAfterMs、speed、targetDuration 说的是一回事（前面的停顿挂在后一句上，以前文字输出里看不到）
    const timing = [
      ...(unit.pauseBeforeMs > 0 ? [`pause before: ${unit.pauseBeforeMs} ms`] : []),
      ...(unit.pauseAfterMs > 0 ? [`pause after: ${unit.pauseAfterMs} ms`] : []),
      ...(unit.speedChange !== undefined ? [speedText(unit.speedChange)] : unit.speed === null ? [] : [`speed ${unit.speed}`]),
      ...(unit.targetDuration === undefined ? [] : [targetText(unit.targetDuration)]),
    ];
    if (timing.length > 0) lines.push(`     (${timing.join(', ')})`);
    const measured = similarityText(unit, similarity.minSimilarity);
    if (measured !== null) lines.push(`     (${measured})`);
  }
  // 服务暂时出错的，稍后用 --only 重做；文字被拒的，先改字再重做，单独说（文件头「文字被拒」）；比合成能力的下限短的重做没有用（台本要改），单独说；
  // 服务那头做完了、没取回的，重做会再计一次费，单独说（文件头「没取回」）
  // 重做要照着这次的命令行再跑一遍：适配器、标签、切句和并发都要带上（缺了，重做用的就不是同一个环境）
  const packPart = many ? packArguments.map((argument) => `--pack ${argument}`).join(' ') : packArguments[0];
  const redoCommand = (units) => [`node cli.mjs dub ${packPart} ${scriptArgument} --out ${out}`, ...(redo?.adapters ? [redo.adapters] : []), ...(redo?.rest ?? []), `--only ${units.map((unit) => unit.number).join(',')}`].join(' ');
  const failed = report.units.filter((unit) => unit.status === 'failed' && !isTooShortUnit(unit) && !isUnretrievedUnit(unit) && !isTextRejectedUnit(unit) && !isTooLongScene(unit));
  const rejected = report.units.filter(isTextRejectedUnit);
  const tooLong = report.units.filter(isTooLongScene);
  const tooShort = report.units.filter(isTooShortUnit);
  // 只给一条重做的命令（cli/dub-failures.mjs 的文件头「只给一条重做的命令」）：有字太少的、装不下的一场，只说改好以后不带 --only 再跑，别的没做成的在那一次里一起重做；
  // 不然文字被拒的和服务暂时出错的并成一条 --only（先改字）。不给先跑一半的那条：照它先跑，没点到的被拒的、装不下的一场会记成这一次没做，原因就丢了
  const rerun = rerunsWithoutOnly(report.units);
  const listOf = (units) => units.map((unit) => unit.number).join(', ');
  const linesOf = (units) => `${units.length === 1 ? 'line' : 'lines'} ${listOf(units)}`;
  if (failed.length > 0) {
    const where = rerun ? `${linesOf(failed)} will be redone together in the run you make without --only after the script is fixed (see below); no separate --only run is needed`
      : rejected.length > 0 ? `${linesOf(failed)} and the ${rejected.length === 1 ? 'line' : 'lines'} with rejected text below are redone together with one command (the command is in the "Text rejected" section; do not redo ${failed.length === 1 ? 'it' : 'them'} alone first: a rejected line that --only does not name is recorded as not done this time, and the reason it was rejected is lost from dub.json)`
        : redoCommand(failed);
    lines.push('', `Failed: ${failed.length} ${failed.length === 1 ? 'line' : 'lines'} (temporary service error, redo later): ${where}`);
  }
  if (rejected.length > 0) {
    const these = rejected.length === 1 ? 'this line' : 'these lines';
    const together = [...rejected, ...failed].sort((a, b) => a.number - b.number);
    const then = rerun ? `, then run the command below again without --only to redo them together`
      : `, then redo ${failed.length > 0 ? `${these} and ${linesOf(failed)} above (temporary service error) together` : these} with: ${redoCommand(together)}`;
    lines.push('', `Text rejected: ${rejected.length} ${rejected.length === 1 ? 'line' : 'lines'} (it depends only on the text of ${these}; sending it again unchanged is rejected again): first change the text of ${these} in the script${then}`);
    for (const unit of rejected) {
      lines.push(`  line ${unit.number} (${unit.error.code}): ${rejectedText(unit)}`);
      // 不是一场戏的一个请求，平台说装不下（文件头「文字被拒」的例外的最后一条）：说怎么改，不叫人 --no-scene
      if (isTooLong(unit)) lines.push(`    the platform says one request cannot hold this line: shorten it${rerun ? '' : ', then redo with the command above'}; to split it into two requests, the line numbers change after the split, so after fixing run again without --only (to split in the middle, start a new line with a chapter marker # title (${CHAPTER_SPLIT_REMINDER}) and only that chapter is split again, while chapters already done are reused at no extra cost; if you lower --max-chars, the whole script is split again by the new number and every request longer than it is split, and lines whose split changed must be dubbed again and are charged again)`);
    }
  }
  // 别的没做成的（文字被拒的、服务暂时出错的）在不带 --only 再跑的那一次里一起重做
  const others = [...rejected, ...failed].sort((a, b) => a.number - b.number);
  const alsoRedone = others.length > 0 ? `; ${linesOf(others)}, which ${others.length === 1 ? 'was' : 'were'} not done, ${others.length === 1 ? 'is' : 'are'} also redone in that run` : '';
  // 装不下的一场：切开以后序号会变，不给 --only 命令（文件头「文字被拒」的例外）
  if (tooLong.length > 0) {
    lines.push('', `Does not fit: ${tooLong.length} ${tooLong.length === 1 ? 'scene' : 'scenes'}: ${tooLong.map((unit) => `line ${unit.number}`).join(', ')} (one request per scene): the platform says one request cannot hold it, and redoing it unchanged does not fit either. Add a chapter marker (# title) in the middle of the scene to split it into two scenes (${CHAPTER_SPLIT_REMINDER}), or add --no-scene for one request per line (the whole script then goes one request per line, and scenes already done must be dubbed again); after fixing, run again without --only (the line numbers change after the split; lines already done whose request did not change are reused at no extra cost${alsoRedone})`);
  }
  if (tooShort.length > 0) {
    const min = tooShort[0].error.details.min;
    // --dry-run 的规划里也有这一段（规划时就知道）：那时还没有要重做的，只说要改台本
    const rerunText = planOnly ? '' : ` After fixing, run this command again without --only (lines already done whose request did not change are reused at no extra cost${alsoRedone}).`;
    lines.push('', `Not synthesized: ${tooShort.length} ${tooShort.length === 1 ? 'line' : 'lines'}: shorter than the lower limit of the synthesis capability (${min} characters), and they do not form a long enough piece with the neighbouring lines either: ${tooShort.map((unit) => `line ${unit.number} (${unit.error.details.chars} ${unit.error.details.chars === 1 ? 'character' : 'characters'})`).join(', ')}. Change the script to make them long enough; redoing them unchanged does not help.${rerunText}`);
  }
  const unretrieved = report.units.filter(isUnretrievedUnit);
  if (unretrieved.length > 0) {
    // 这一次带了 --only 的：照原样再跑这条命令，没点到的没取回的一句照旧记着、不重配，点到的句子倒会再配一次（文件头「没取回」）
    const redub = onlyGiven ? 'Name the line(s) with --only, or remove --only and run this command again' : 'Run the same command again, or name the line(s) with --only';
    lines.push('', `Not retrieved: ${unretrieved.length} ${unretrieved.length === 1 ? 'line' : 'lines'}: the service has finished and billed ${unretrieved.length === 1 ? 'it' : 'them'}, but the result was not retrieved. ${redub}: either way the line(s) are dubbed again and charged again; if you do not want that, retrieve them by hand as the adapter says (audio retrieved by hand cannot yet be handed back to this output directory for mix):`);
    for (const unit of unretrieved) lines.push(`  line ${unit.number}: ${retrieveText(unit)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 重做命令里跟在适配器后面的选项：这次命令行上给了的（标签、语速、设定（--setup、--no-setup）、音色基底标签、目标时长、相似度的阈值、切句、并发、--no-scene、--allow-cross-language），按它原来的样子写回去；
 * --only、--out、--json、--dry-run 另有位置，不在这里。
 */
function redoFlags(options) {
  const parts = [];
  for (const name of LABEL_FLAGS) if (options[name] !== undefined) parts.push(`--${name} ${quoteArgument(String(options[name]))}`);
  if (options.speed !== undefined) parts.push(`--speed ${options.speed}`);
  if (options.expressiveness !== undefined) parts.push(`--expressiveness ${Number(options.expressiveness)}`); // 值是字符串（FLAGS）；写回去的是校验过的数
  for (const value of options.setup ?? []) parts.push(`--setup ${quoteArgument(value)}`); // --setup 可以给几次，次序照命令行上的
  if (options['no-setup'] === true) parts.push('--no-setup');
  for (const value of options['reference-tag'] ?? []) parts.push(`--reference-tag ${quoteArgument(value)}`); // 同上
  if (options['target-duration-ms'] !== undefined) parts.push(`--target-duration-ms ${options['target-duration-ms']}`);
  if (options['min-similarity'] !== undefined) parts.push(`--min-similarity ${options['min-similarity']}`);
  if (options['max-chars'] !== undefined) parts.push(`--max-chars ${options['max-chars']}`);
  if (options.concurrency !== undefined) parts.push(`--concurrency ${options.concurrency}`);
  if (options['no-scene'] === true) parts.push('--no-scene');
  if (options['allow-cross-language'] === true) parts.push('--allow-cross-language');
  if (options['no-language-marks'] === true) parts.push('--no-language-marks');
  return parts;
}

/**
 * 费用说明（花钱之前写到标准错误）。calls 来自 dubScript 的 onPlan：这次要合成几次（一场戏一个请求的也在里面）。
 * 两种能力分开数：一场戏一个请求调 text-to-dialogue，别的调 voice-cloning；有场的时候写明这几场共几行。没有场和原来一字不差。
 */
function costNote({ billing, plan, calls, adapters, ffmpeg }) {
  const planned = plan.units.filter((unit) => isScene(unit) && unit.status === 'planned'); // 这次要做的场（--only 没点到的不算）
  const scenes = planned.length;
  const times = (count) => `${count} ${count === 1 ? 'call' : 'calls'}`;
  const parts = [...(calls.count - scenes > 0 ? [`voice-cloning ${times(calls.count - scenes)}`] : []), `text-to-dialogue ${times(scenes)} (${scenesText(planned)})`];
  const lines = [`${billing}:`, scenes === 0 ? `  synthesis: ${times(calls.count)} (voice-cloning)` : `  synthesis: ${times(calls.count)}: ${parts.join(', ')}`];
  // 第 9 步：每段合成好了量一次说话人相似度（合成失败的不量，所以是最多）；一场戏一个请求的量不了，不调
  const verifications = plan.speakerSimilarity.measured ? calls.count - scenes : 0;
  if (verifications > 0) lines.push(`  speaker similarity: up to ${times(verifications)} (speaker-verification: each synthesized audio is compared once with the reference it used${scenes === 0 ? '' : '; scenes with one request per scene cannot be measured, so they are not compared'})`);
  lines.push(`  ${moneySentence(adapters, callsByCapability(plan, calls.count))}`);
  if (ffmpeg !== null) lines.push(`  ${ffmpeg}`);
  return `${lines.join('\n')}\n`;
}

/** 这次要合成 count 次，各项能力调几次（费用说明和预演估金额用）。 */
function callsByCapability(plan, count) {
  const scenes = plan.units.filter((unit) => isScene(unit) && unit.status === 'planned').length;
  return { 'voice-cloning': count - scenes, 'text-to-dialogue': scenes, 'speaker-verification': plan.speakerSimilarity.measured ? count - scenes : 0 };
}

/** 打开每个包目录，并算出它的脚本运行时（和环境的合在一起，环境的盖过脚本的，和原来一样）。返回 { packs, runtimes }，runtimes 按包 ID 取。 */
async function openPacks(ctx, env, packArguments) {
  const packs = [];
  const runtimes = new Map();
  for (const argument of packArguments) {
    const { pack, dir } = await openPackDirectory(ctx, argument, { env });
    const names = pack.scripts('dub').map((entry) => entry.runtime);
    packs.push(pack);
    runtimes.set(pack.manifest.id, { ...createScriptRuntimes({ packDir: dir, names, existing: env.runtimes }), ...env.runtimes });
  }
  return { packs, runtimes };
}

export async function run(args, ctx) {
  const taken = takeAdapterArguments(args);
  if (taken.problem) return usageProblem(ctx, usage, taken.problem);
  const parsed = parseArgs(taken.rest, FLAGS);
  if (parsed.problem) return usageProblem(ctx, usage, parsed.problem);
  const { options } = parsed;
  // 包目录：位置上的一个，或者 --pack 给的几个（给了 --pack，位置上就只剩台本）
  let packArguments;
  let scriptArgument;
  if (options.pack !== undefined) {
    if (parsed.positional.length !== 1) return usageProblem(ctx, usage, 'With --pack, do not also put a pack directory in a positional argument: give every pack directory with --pack (as many as you need) and put only the script in the positional argument');
    [scriptArgument] = parsed.positional;
    packArguments = options.pack;
  } else {
    if (parsed.positional.length !== 2) return usageProblem(ctx, usage, 'Give a pack directory and a script (two positional arguments)');
    const [packArgument, script] = parsed.positional;
    packArguments = [packArgument];
    scriptArgument = script;
  }
  const dryRun = options['dry-run'] === true;
  if (!dryRun && options.out === undefined) return usageProblem(ctx, usage, 'Give --out <directory> (the audio and dub.json go there); to see only the plan, use --dry-run');
  let only;
  if (options.only !== undefined) {
    only = parseOnly(options.only);
    if (only === null) return usageProblem(ctx, usage, `--only takes line numbers (starting at 1, separated by commas, for example 2,5); got ${options.only}`);
  }

  // 环境：命令已有的，加适配器的（后给的盖过先给的，命令行上明说的盖过默认的），再加这个包的脚本要的运行时
  const { env: adapted, adapters } = await applyAdapters(ctx, ctx.env, taken.requests);
  let env = adapted;
  const billing = billingSentence(adapters);
  const models = { 'voice-cloning': modelOf(adapters, 'voice-cloning'), 'text-to-dialogue': modelOf(adapters, 'text-to-dialogue') }; // --dry-run 汇总那一行用（文件头「汇总」）
  const { packs, runtimes } = await openPacks(ctx, env, packArguments);
  // --setup、--reference-tag 要认出给了哪些包：同一个包名字、ID 各写一次也算点了两次；--reference-tag 还要靠它拆（<包>=<标签> 还是整串是标签）
  if (options['no-setup'] === true && options.setup !== undefined) return usageProblem(ctx, usage, 'Give only one of --no-setup (use no setup for any pack) and --setup (name a setup)');
  const setupFlag = readSetupFlag(options.setup, packs);
  if (setupFlag.problem !== undefined) return usageProblem(ctx, usage, setupFlag.problem);
  const referenceTagFlag = readReferenceTagFlag(options['reference-tag'], packs);
  if (referenceTagFlag.problem !== undefined) return usageProblem(ctx, usage, referenceTagFlag.problem);
  // 一个包：脚本的运行时直接放进环境（和原来一样）；几个包：每个包的脚本在它自己的目录里运行，由 runtimesOf 按包取（见 lib/dub.mjs 的 envFor）
  if (packs.length === 1) env = { ...env, runtimes: runtimes.get(packs[0].manifest.id) };

  const script = readScript(ctx, scriptArgument);
  const labels = Object.fromEntries(LABEL_FLAGS.filter((name) => options[name] !== undefined).map((name) => [name, options[name]]));
  const adapterMaxChars = maxCharsOf(adapters);
  const adapterMaxPauseInRequestMs = maxPauseInRequestMsOf(adapters); // 一个请求里一处停顿最多多少毫秒（环境声明的）：长过它的切开交给拼接；不给就用基础部分的默认值（lib/dub.mjs 第 5c 步）
  const adapterMaxSpeakers = maxSpeakersOf(adapters); // 一场戏最多几个说话人（环境声明的，声明了 scene-in-request 才用）：不给就不限（lib/dub.mjs 第 5a 步）
  const adapterMinChars = minCharsOf(adapters); // 合成能力一次至少多少个字（环境声明的）：短句并段，并不了的记成没做（lib/dub.mjs 第 5b 步）
  const dubOptions = {
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    ...(options.speed === undefined ? {} : { speed: options.speed }),
    ...(options.expressiveness === undefined ? {} : { expressiveness: options.expressiveness.trim() === '' ? Number.NaN : Number(options.expressiveness) }),
    ...(options['no-setup'] === true ? { setup: false } : setupFlag.setup === undefined ? {} : { setup: setupFlag.setup }),
    ...(referenceTagFlag.referenceTag === undefined ? {} : { referenceTag: referenceTagFlag.referenceTag }),
    ...(options['target-duration-ms'] === undefined ? {} : { targetDurationMs: options['target-duration-ms'] }),
    ...(options['min-similarity'] === undefined ? {} : { minSimilarity: options['min-similarity'] }),
    ...(only === undefined ? {} : { only }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    // 一个请求的上限（文件头 --max-chars）：给了就只照它（发出去的字），配音默认的要念的字的上限不再管；没给，默认的照旧，适配器声明了 limits.maxChars 的发出去的字也不超过它
    ...(options['max-chars'] !== undefined ? { maxChars: options['max-chars'], maxSpokenChars: null } : adapterMaxChars !== undefined ? { maxChars: adapterMaxChars } : {}),
    ...(adapterMinChars !== undefined ? { minChars: adapterMinChars } : {}),
    ...(adapterMaxPauseInRequestMs !== undefined ? { maxPauseInRequestMs: adapterMaxPauseInRequestMs } : {}),
    ...(adapterMaxSpeakers !== undefined ? { maxSpeakers: adapterMaxSpeakers } : {}),
    ...(options['no-scene'] === true ? { scene: false } : {}),
    ...(options['allow-cross-language'] === true ? { allowCrossLanguage: true } : {}),
    ...(options['no-language-marks'] === true ? { languageMarks: false } : {}),
    ...(packs.length > 1 ? { runtimesOf: (pack) => runtimes.get(pack.manifest.id) } : {}),
  };
  // 重做提示用的：这次命令行上给的适配器、标签、切句、并发（和 --out、--only 之外的选项一样，照着原样写回去）
  const redo = { adapters: describeRequests(taken.requests), rest: redoFlags(options) };
  const keptNumbers = new Set(); // 照旧记着没取回的几句的序号（keepUnretrieved 记下）：文字输出不在它们下面写「换了 seed」
  const render_ = (report, planOnly) => render(report, { packArguments, scriptArgument, out: options.out === undefined ? '' : path.resolve(ctx.cwd, options.out), planOnly, redo, onlyGiven: only !== undefined, kept: keptNumbers, models, noSetup: options['no-setup'] === true });

  // 上一次的报告（--out 里的 dub.json）和这一次的包：沿用按它们认（文件头「沿用」）。--dry-run 给了 --out 也一样，规划里标出能沿用的句子
  const out = options.out === undefined ? null : path.resolve(ctx.cwd, options.out);
  const reportFile = out === null ? null : path.join(out, REPORT_FILE);
  let previous = null;
  try {
    if (reportFile !== null) previous = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } catch {
    // 没有上一次的报告，或者读不了：当作第一次
  }
  // 这一次的包（写法同报告顶层的 pack、packs）：沿用时按包 ID 和版本比；出错停下来的那份报告也写上，下一次才认得出是哪个包做的
  const current = { pack: { id: packs[0].manifest.id, version: packs[0].manifest.version }, ...(packs.length > 1 ? { packs: packs.map((pack) => ({ id: pack.manifest.id, version: pack.manifest.version })) } : {}) };
  const reuse = out === null ? undefined : reuser({ previous, out, minSimilarity: options['min-similarity'] ?? null, current });
  // --only 重配的一句换一个 seed（文件头「--only 换 seed」）：上一次的 seed 从同一个 --out 里的 dub.json 找
  const previousSeed = out === null ? undefined : seedFinder({ previous, out });
  const again = { ...(reuse === undefined ? {} : { reuse }), ...(previousSeed === undefined ? {} : { previousSeed }) };
  // 上一次没取回、这一次 --only 没点到的几句，照旧记成没取回（文件头「没取回」）：在沿用之后（还是 skipped 的才问），返回照旧记着的这几句
  const unretrievedBefore = out === null ? null : unretrievedFinder({ previous, current });
  const keepUnretrieved = (units) => {
    if (unretrievedBefore === null) return [];
    const kept = [];
    for (const unit of units) {
      if (unit.status !== 'skipped') continue;
      const earlier = unretrievedBefore(unit);
      if (earlier === null) continue;
      Object.assign(unit, earlier);
      keptNumbers.add(unit.number);
      kept.push(unit);
    }
    return kept;
  };

  if (dryRun) {
    const plan = await planDub(env, packs, script, { ...dubOptions, ...again });
    decorate(plan.units);
    keepUnretrieved(plan.units);
    const shown = withUnretrieved(plan);
    const money = billing === null ? null : moneySentence(adapters, callsByCapability(plan, plan.units.filter((unit) => unit.status === 'planned').length));
    const ffmpeg = ffmpegNote(env);
    shown.notes = [...shown.notes, ...(money === null ? [] : [{ code: 'money_estimate', message: money, details: {} }]), ...(ffmpeg === null ? [] : [{ code: 'ffmpeg_missing', message: ffmpeg, details: {} }])];
    ctx.stdout(ctx.json ? `${JSON.stringify(shown, null, 2)}\n` : render_(shown, true));
    return 0;
  }

  const hadReport = fs.existsSync(reportFile);
  const finished = [];
  const writeAudio = (unit) => {
    fs.mkdirSync(out, { recursive: true });
    unit.file = fileNameOf(unit);
    fs.writeFileSync(path.join(out, unit.file), unit.audio.bytes);
  };
  // 没跑完的报告（文件头「沿用」最后一段）：只列 units 这几句（做好了的、沿用的），按序号排；replaced 记着磁盘上的 dub.json 是不是已经换成了这一次的
  let replaced = false;
  const writeUnfinished = (units, stoppedBy = UNFINISHED) => {
    fs.mkdirSync(out, { recursive: true });
    writeReport(reportFile, withUnretrieved({ ok: false, stoppedBy, ...current, units: [...units].sort((a, b) => a.index - b.index).map(reportUnit) }));
    replaced = true;
  };
  const dubbed = dubScript(env, packs, script, {
    ...dubOptions,
    ...again, // 文件头「沿用」「--only 换 seed」
    onPlan: (plan, { calls }) => {
      decorate(plan.units);
      // 上一次没取回、这一次没点到的：照旧记成没取回（文件头「没取回」）。没有文件，和沿用的一样算已经有下落的，每一份报告都列上
      const kept = keepUnretrieved(plan.units);
      const carried = plan.units.filter((unit) => unit.carriedOver === true);
      // 改名、写新文件之前，先换掉上一次的 dub.json：留着它，被打断以后下一次会照它把挪过、盖过的文件当成原来那一句的（这一份只列不用改名的沿用的几句，和照旧没取回的几句）
      if (hadReport) writeUnfinished([...carried.filter((unit) => unit.file === carriedName(unit)), ...kept]);
      // 沿用的文件按这一次的序号改名，在这一次写文件之前；它们算已经做完的：报告里列上（出错停下来时也是）
      renameCarried(out, plan.units);
      finished.push(...carried, ...kept);
      if (carried.length > 0 || kept.length > 0) writeUnfinished(finished);
      if (billing !== null && !ctx.json) ctx.stderr(costNote({ billing, plan, calls, adapters, ffmpeg: ffmpegNote(env) }));
    },
    onUnit: (unit) => {
      unit.number ??= unit.index + 1;
      if (unit.status === 'ok') writeAudio(unit);
      // 照旧没取回的几句在 onPlan 已经列上了；库还会把它们和规划时就失败的一起交过来一次（status 已经是 failed），不重复列
      if (!finished.includes(unit)) finished.push(unit);
      writeUnfinished(finished); // 文件写好了才列上它
    },
  });
  let result;
  try {
    result = await dubbed;
    decorate(result.units); // 每一段都要有编号（onPlan 已经编过；这里再编一次，不靠 onPlan 被调过）
  } catch (error) {
    // 出错停下来：已经做完的文件留着，写一份记着怎么停的报告（让人知道留下来的是什么），再把错误交给 runner 报告。
    // 还没换掉上一次的 dub.json 就出错（缺能力、缺运行时、台本不对……，都在花钱之前）什么都不写：没有东西要交代，上一次的报告也还对得上磁盘上的文件。
    if (replaced) writeUnfinished(finished, { code: error.code ?? 'internal_error', message: String(error.message), details: error.details ?? {} });
    throw error;
  }

  const report = withUnretrieved({ ...result, units: result.units.map(reportUnit) });
  fs.mkdirSync(out, { recursive: true });
  writeReport(reportFile, report);
  ctx.stdout(ctx.json ? `${JSON.stringify(report, null, 2)}\n` : render_(report, false));
  return result.ok ? 0 : 1;
}
