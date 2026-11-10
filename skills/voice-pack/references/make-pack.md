# 做音色包

这一份是基础部分的参考，`SKILL.md` 第 7 节指到这里。流程（什么时候做包、做完怎么用）在 `SKILL.md`；命令的写法、选项、报告、素材、标签、配音指引、新版本的一般用法在这里；主路用不到的细则在 `references/make-pack-details.md`，净室和查重在 `references/clean-room.md`。

作者交来一批原声，做成一个音色包的角色部分：`node cli.mjs make-pack [<素材目录|素材.json>] --output <新目录> --name <名字> [--short-name <英文短名>]`。`--short-name` 是包 ID 的英文短名，不给就用 `vp`。素材可以省：长录音用 `--recording <文件|目录>` 直接交（下面「素材」一节），发新版本用 `--previous`（见「发新版本」）。输入、选项、报告、错误的正本在 `lib/make-pack.mjs` 的文件头。`--output` 的目录要求还不存在，命令不覆盖任何东西；协议核心要是封印过的（`--protocol` 指到官方发布的那份；开发树用 `seal` 封一份自用的）。

**素材**是已经切好的片段，每段一个音频文件加它说的话：目录里每个音频一段，同名的 `.json` 写 `{ id, text, annotatedText, language, tag, source, sentence, synthetic, trim, externalUrl }`（`id` 是段名，不写就用文件名；`annotatedText` 见下面「提示标注」，`synthetic` 见下面「重生成的参考」，`trim` 见下面「只用一段里的几秒」那一段）（`source` 是 `{ recording?, startSec?, endSec? }`：来源录音和起止秒数，只进报告，不进包。`sentence` 和 `source` 平级，写在段上，不写进 `source`（写进去不报错，也不算数）：`{ bodySec, pauseSec }`，这一段是一句话，句子的秒数和它后面原来的停顿，后面没有停顿写 `null`。带 `sentence` 的几段当成句子，和下面 `--recording` 切出来的句子一样先并成 5–20 秒的段；段里每一句都写了 `text` 的，段的文字就是这几句的 `text` 按次序接起来，这一段不转写，接的地方有一边是汉字、假名或它们的全角标点就直接接，别的加一个空格，韩文和英文一样；有一句没写 `text`，整段转写；每一句都写了 `annotatedText` 的，段的提示标注照样接起来，每一句都标了 `synthetic` 的，段才标。语言一样的句子可能并进同一段，`synthetic`、`annotatedText` 要么都写、要么都不写，不一样花钱之前报 `make_pack_input_invalid`；和 `--recording` 一起交时，切出来的句子算没写），只有文本时同名的 `.txt` 也行；或者一份 `.json`：`{ "segments": [{ "audio": "audio/a.wav", "text": "…", "language": "zh", "tag": "愤怒" }], "notes": [{ "code": "…", "message": "…" }] }`。长录音直接交，不用先切：`--recording <文件|目录>`（目录里每个音频文件是一段长录音）。环境有 `audio-source-separation` 就先分离出人声（`--no-separate` 不分离，输入已经是干净的人声），切成句子：环境有 `voice-activity-detection` 就用它给的说话区间，没有就按能量找停顿（`lib/long-recording.mjs` 文件头「句子模式」）；句子在做包时先并成 5–20 秒的段，再一段转写一次（句子不逐句转写、不逐句先听：短句没有上下文，转写错字多，没人说话的一小块还会编出一句话来；读数，2026-11-05 只在一个适配器上量过：25 句两秒以下的短句，中文 38 个字错 18 个，两块杂音都编出了整句），转写的次数、费用的估算和 `--dry-run` 的规划都按段数算。分离和 VAD 是花钱的调用，每段录音一次，调之前在标准错误里说明，`--dry-run` 不调（按能量切，报句数和并成的段数）。切出来的段没有逐字文本，环境没有转写（`automatic-speech-recognition`）就一段都用不上：素材里也没有别的带逐字文本的段时，做包在花钱之前报 `make_pack_no_material`，不调分离和 VAD（`--dry-run` 也报），要接一个有转写的适配器。切段留下的说明（例如「这次没做分离，输入要是干净的人声」）进报告的 `notes`；自己切的话，也可以写进素材 `.json` 的 `notes`，原样进报告。

**截来的片段**：从视频、动画、游戏里截的录音，常是带视频轨的文件，常带配乐、别人插话。素材（包括写了 `trim` 的）不做分离，只有 `--recording` 在环境有分离能力时分离。素材和 `--recording` 都收 `.mp4`、`.m4v`、`.mov`、`.mkv`：做包只取第一路音轨，存成 WAV，包里的参考照旧是音频（包能放的格式还是 wav、mp3、flac、ogg、m4a，`.webm`、`.aac` 这类别的格式也一样先取音轨）；`--recording` 交给分离和 VAD 的也是这一路音轨。取音轨要环境有 `ffmpeg`，同解码别的格式。没有的话：素材里的这一段用不上（`audio_unrecognized`，文字输出写「环境没有 ffmpeg，取不出音轨」；一段都用不上时 `make_pack_no_material` 带 `details.missingRuntime`）；`--recording` 交的，整条命令停下，报 `runtime_missing`（点名 ffmpeg），这段录音一项能力都没调。取过音轨的段，报告里的 `convertedFrom` 写原来的格式。外部资源（写了 `externalUrl` 的段）不取音轨，也不收 `trim`：包里只记网址、大小和哈希，取了、切了就对不上网址上的文件；要用就先转成包能放的格式、切好，再放到网址上。

只用一段里的几秒，给这一段写 `trim`：`{ startSec?, endSec? }`，秒，从这个文件的开头算，至少写一个，至少切 0.1 秒；`startSec` 不写是从头，`endSec` 不写是到结尾，超过结尾的切到结尾。做包先切出这几秒，再筛片段、转写、挑参考，报告里这一段的 `trim` 写实际切的秒；`--source-pack` 查重也只比这几秒。一个文件里有几处能用，就写成几段，`audio` 指同一个文件，各写各的 `trim`（文件只读一次、只解一次码），每段 5 到 20 秒最好（参考的建议长度，长的拆开）。各段的 `trim` 不要重叠：同一个文件里重叠的，后一段用不上，记成 `duplicate_audio`（没写 `trim` 的段算整个文件，挨着的不算重叠）。素材目录里同名的 `.json` 也能写 `trim`。`trim` 和 `sentence` 不能一起写，外部资源也不收；写错了（不是数、负数、终点不在起点后面、不到 0.1 秒）花钱之前报 `make_pack_input_invalid`，点名是哪一段的 `trim`；起点在录音结尾以后的段用不上（`trim_out_of_range`）。`--recording` 不收 `trim`，要切的录音当素材交，没写 `text` 的段做包会转写：

```json
{ "segments": [
  { "id": "clip-a", "audio": "clip.mp4", "trim": { "startSec": 12, "endSec": 20 } },
  { "id": "clip-b", "audio": "clip.mp4", "trim": { "startSec": 41.5, "endSec": 50 } }
] }
```

**标签**：每段素材有两项，写成段自己的 `language`（语言）和 `tag`（音色基底标签），和清单里的字段同名；作者给的、库里给的不分。

- 语言：`--language`（在库里调 `makePack` 时是输入的 `language`）给所有段一个默认，段自己的 `language` 盖过它。都没给的，来自转写或文字本身（拉丁字母认不出是英语还是法语，认不出又没给语言的那段用不上，`language_unknown`；转写不报语言时，拉丁字母原声付完转写费就全都用不上，所以这种情况加 `--language`，命令花钱前会提醒一行）。
- 音色基底标签：只用来在一个角色的几段参考之间切换（不同情绪、不同年龄的几段），一段一个，自由文字，中文、英文都行，1–64 个字符（按码点算）。给了的去掉两头空白，别的不改；只有空白或超过 64 个字符，花钱之前报 `make_pack_input_invalid`。没有默认的标签。没给的段，做包自己起名字：在给这段标提示标注的调用里（见下面「提示标注」，同一次回答），让模型顺带给一个短名字，用包的骨架语言（`--text-language`，默认中文），说这段的情绪、年龄或状态里最突出的一种，例如「平常」「愤怒」「少年」，不带角色名；不为一个名字另调，费用估算也不多算。名字去掉两头空白，超过 64 个字符的截到 64。起不成名字的用段名（`id`）：环境没有 `audio-text-to-text`；这一段没标上提示标注（作废、被拦下、服务一直出错）；名字缺了或是空白；素材给了 `annotatedText`（这段不调模型）。模型起的名字不参与挑留出录音和参考上限的分组。同一种语言里两段参考标签一样（逐字比，大小写不同算两个），清单里排在后面的加序号（「愤怒 2」）；只有一处例外：有人给过的标签优先，模型起的名字和段名兜底的名字，和素材写的、上一版的、`--retag` 改成的标签撞了，不管谁在前，都由模型起名、段名兜底的那段加序号，所以设定的 `referenceTag` 指的总是给了这个标签的那段。留出录音只记语言，不带标签。上一版带来的参考照旧用上一版的标签，要改见下面「改标签」。
- 旧写法的 `labels`（每段的，或者输入的）不再认：花钱之前报 `make_pack_input_invalid`，改写成 `language`、`tag`。

报告里每段参考写 `{ language, languageSource, tag, tagSource, renamedFrom? }`：`languageSource` 是 `material`（素材或 `--language` 给的）、`transcription`、`text`、`previous` 之一，`tagSource` 是 `material`（素材给的，`--retag` 改的也是）、`model`（模型起的名字）、`id`、`previous`（上一版带来的）之一，加了序号的 `renamedFrom` 写原名（素材给的、改名给的标签，或者模型起的名字）；留出录音只写 `{ language, languageSource }`。没有文本的片段，环境有 `automatic-speech-recognition` 才能转写，没有就用不上（`no_text`）。缺哪项能力，只有用到它的那一步跳过，报告里写明。

**提示标注**：参考段除了逐字稿 `text`，还存一句提示标注 `annotatedText`：逐字稿在说法变化的地方加上方括号提示，例如 `[normal]啊，瞧瞧这是谁？[laughs]呵呵，[happy]太可爱了吧。`，提示以外的字和 `text` 一样。配音时它和参考一起交给模型，模型就知道这段参考是怎么说的。做包标得更细，逐点标：每个分句前面写这个分句里的人怎样、停在哪里、说得快还是慢，字一个不动（写法、门槛、例子和听过的结果在 `models/scene3.md`「参考的文字和提示标注」）。留出录音不标；素材给了 `annotatedText` 的、上一版带来的段不调模型。别的每段参考，挑完参考集以后，环境有 `audio-text-to-text` 就这样标，一段做三件事：听、量、拼（正本在 `lib/segment-annotation.mjs` 和 `lib/make-pack-annotation.mjs` 的文件头）：

- **听 1 次。** 让模型听着逐分句标。交给它的逐字稿去掉了开头几个词，它要写出听到的开头（收音校验，同盲听：和逐字稿的开头对不上就作废；片假名和平假名、有汉字的话里阿拉伯数字和汉字数字（94 和九十四；日文照日文的写法，100 和百）只是写法不同，不算对不上；折过的和原样比的取小的，所以不会比原样比更容易作废（5 位以上的数逐位读，和「一万」这类写法折了也对不上，就照原样比的算），`lib/fidelity.mjs` 的 `openingErrorRate`、`foldWritings`），再给每个分句的提示和提示后面紧跟着的几个字：情绪从一份固定的英文词表里选一到两个词（提示一律写英文，台词什么语言都一样），可以再加尾音拖长、尾音上扬；真听到笑、叹气、吸气、哽咽才另写一条，没有的不写。提示按那几个字的位置插进逐字稿，逐字稿一个字都不改。
- **听失败了。** 暂时出错的、回答是空的，按重试的规矩再问（`lib/call-attempts.mjs`），问满了还不成，记成没听成；被服务商拦下，回答读不懂、收音校验没过、没正常结束的，这一段作废，不再问。音色基底标签的短名字（上面「标签」）在同一次回答里。
- **量。** 和听同时做（听失败时量的转写已经花了，结果不用）。环境有转写（`automatic-speech-recognition`）就量，量只做计算和转写，不判好坏：录音里静音连续 0.05 秒以上的地方切开（5 毫秒窗的峰值低于 -30 dBFS 算静音，两头的静音不算停顿），短于 0.05 秒的块不是语音，去掉、不转写，它两边的静音算成一段停顿；最多 24 块，超了从最短的静音起并回去；每块转写一次（只用来对位置，逐字稿 `text` 不因此改一个字），带这一段的语言，按字和时长一起对到逐字稿的字上（只按时长对会放错字，短块的转写常错）；和时长明显不相称的转写不算（词数大于 2 加这块的秒数乘 12，或者是空的），这样的块对字时只靠时长，不进错误率，转写可用的块的时长不到全部的一半，也算对不上；转写可用的块总的编辑错误率超过 0.6 算对不上，这一段不用量的结果。量出每块前面停了多久、每个分句每秒说多少字（中文、日文按字，别的按词，单字的分句不算快慢）。
- **拼。** 照 `models/scene3.md`「参考的文字和提示标注」那张表，把量到的停顿和快慢并进听到的提示。拼好去掉方括号，必须和 `text` 一字不差，也不超过清单允许的长度；不合就作废，这一段退回只存逐字稿。
- **量失败不挡标注。** 没有转写、解不开音频、转写问满重试还失败、对不上逐字稿：这一段只用听出来的提示，不写停顿和快慢，报告写明。

门槛（停多久写 `[pause]`、快慢的倍数、静音的音量和长度、0.6）都只从一个声音的一段参考定下来，是推断，没有在别的声音上试过；转写算不算编造的那个数（每秒 12 个词）是从四个声音推断的，英文这类按词数的语言宽得多，只拦得住编造，没有量过。没标上的段（被服务商拦下、能用的回答不足 2 次、提示一条都对不上原文、拼出来和逐字稿对不上）只存逐字稿，报告写明是哪几段、为什么；对不上原文的个别几条提示丢掉，报告写丢了几条；模型说说法没有变化的段没有提示标注，不算没标上。环境没有这项能力，只存逐字稿，报告写明。报告里这一步写实际问了几次、转写了几块、几段量成了、几段没量成和原因（对不上又对过字的段另带对字的错误率 `measureErrorRate`，看得出差多少；转写可用的块太少的没有对字，切不出路的也没有，都不带），每段写用上了几次听的结果。这些调用算在花钱之前的费用估算里：`audio-text-to-text` 每段参考 3 次；暂时出错多问的，和转写（每段最多 24 块，每块一次，加重试）算在多问的余量里，不算在预计的次数里。实际调用不超过用户同意的总数。

**改标签**：发新版本时用 `--retag <段名>=<标签>` 改上一版一段参考的音色基底标签（在库里调 `makePack` 时是输入的 `retag: { 段名: 标签 }`），和 `--drop` 一样要给 `--previous`。一次改一段，要改几段就给几次；按第一个 `=` 拆，不按逗号拆，标签里可以有逗号。标签的规矩同素材给的 `tag`：去掉两头空白，只有空白或超过 64 个字符不行。段名不是上一版的参考（留出录音、上一版没有的、这次 `--drop` 去掉的），或者同一段给了两次，也不行。不行的都在花钱之前报 `make_pack_input_invalid`，`field` 是 `retag`，`details.segment` 是哪一段；没给 `--previous` 是用法错误。改了的段报告里 `tagSource` 是 `material`。撞名：几个 `--retag` 先都算上再比，所以两段互换名字不算撞名；改的名和上一版没改的段撞了，改名的这段加序号；和这次新补的段撞了，新补的加序号；两段改成同一个名字，排在参考集后面的加序号。设定的 `referenceTag` 引用了改掉的标签，要一起改（`--setups` 里写新名字；沿用上一版的设定也一样），不然花钱之前报 `make_pack_input_invalid`，`field` 是 `setups[<序号>].referenceTag`。只给 `--retag`、别的都没改，也发得成新版本：报告 `version.changes` 里的 `retagged` 是标签变了的段名（库的 `describeChanges` 收到的变化里也是这一项），没写 `--changelog` 时生成的变更说明点名这几段；改成原来的名字是什么都没变（`make_pack_nothing_changed`）。

**改提示标注**：素材的 `.json` 里写 `annotatedText`，就照给的，这段不再让模型标（作者给的、库里给的不分）。提示以外的字要和 `text` 一样，对不上花钱之前报错；只写 `annotatedText` 不写 `text`，逐字稿就是去掉提示的那句，这段不转写（规则在 `lib/make-pack.mjs` 文件头「输入」）。上一版带来的段，这一版不另开改的办法：要改就 `--drop` 那一段，再当素材重新给，带上新的 `annotatedText`；段名不能和上一版重复（去掉的也算），所以换一个段名，例如 `calm` 换成 `calm-2`。上一版带来的段不再标，照上一版的。

**响度**：规则、限幅器，以及 `--no-loudness`、`--no-limiter` 的用法，细则在 `references/make-pack-details.md`「响度」。

**先看规划**：`--dry-run` 只做不花钱的几步（认格式、查重、音质检查），说明各项能力最多调几次，不做包、不调任何能力。接进来的适配器给了费用说明时，真做之前会在标准错误里再说明一遍，费用记在使用者自己的账户上。`--no-evaluate` 不试合成、不量还原度。

**参考集和留出录音**：留出录音留多少，细则在 `references/make-pack-details.md`「参考集和留出录音」；默认段怎么定，见下面「默认段和卡片试听」。设计出来的声音做两次包，都用 `--default-segment <那一段> --no-holdout`，写法见下面「设计出来的声音怎么做包」；使用者给的录音（库里有这个角色本人的录音也算）见「使用者给的录音」。

**默认段和卡片试听**：默认段是这个声音平常说话的样子。一个角色可以说几种语言，参考集里每种语言各有一段默认段：调用方和设定都没指定参考时，配音用这句台词的语言的那段（`references/dub.md`「一句话是怎么变成合成的」第 3 步）。主语言是参考集里段最多的语言（发新版本照旧是上一版的主语言），它的默认段写进清单的 `reference.defaultSegment`；别的语言的写进 `reference.languageDefaults`（`protocol/FORMAT.md` 4.4）。卡片上的试听：包里有卡片试听那一句（下面「卡片试听那一句」），放它；没有，放主语言默认段那段录音，不合成，只是兜底。做包时都交那一句，设计出来的声音和用录音做的声音都一样。每种语言的默认段这样定（规则的正本是 `lib/pack-material.mjs` 的规则 5 和 `lib/make-pack-pick.mjs` 的文件头）：

- 作者点名的，照点名。命令行用 `--default-segment <段名>`，几种语言就可以给几次，每次点名一段，那一段就是它自己的语言的默认段，例如 `--default-segment e3 --default-segment z2`；在库里调 `makePack` 时是输入的 `defaultSegment`：一段的名字，或者几段的名字的数组（`lib/make-pack.mjs` 的文件头）。一种语言只能点名一段：两段同一种语言报 `make_pack_input_invalid`（`details.field` 是 `defaultSegment`），素材写了语言的在花钱之前就报。点名不定主语言：只点名了中文的一段，主语言照旧按段数（或上一版）定。发新版本时没点名的语言，沿用上一版的（条件见规则 5）。
- 一种语言没有点名、也没有沿用的，候选又不止一段：环境有能听音频的模型（`audio-text-to-text`），就请它在这种语言的候选里挑最自然、像在跟人说话、带着表演的一段，不挑平平地念稿的。候选是参考集里这种语言的全部参考，按优先级取前 8 段，每种语言一次调用，一次只交这种语言的段；它要写出挑的那段开头的几个词，和已知的文本对不上就作废（收音校验，同标提示标注）。挑的理由写进报告：主语言的在 `defaultSegment.why`，别的语言的在 `languageDefaults` 的那一项的 `why`，文字摘要里也有。这几次调用（每种语言一次，加重试的余量）算进花钱之前的费用估算；点名了、沿用上一版的语言，不请它挑，也不算这一次。
- 环境没有这项能力，或者它没挑成（报告里那种语言的那一项的 `unpicked` 写明原因）：有说话人相似度就挑和其余参考平均最像的一段，再没有就按优先级。
- 重生成的段（标了 `synthetic: true` 的）和原始录音一样是候选，挑中了就是默认段，包里没有卡片试听那一句时，卡片兜底放的就是这段录音。

**卡片试听那一句**：`--card-line <文件.txt>`（在库里调 `makePack` 时是输入的 `cardLine`）交一句台词，怎么写见 `references/character-voice.md`「卡片试听」。文件是 UTF-8 的纯文字，去掉两头空白以后整个是台词，可以带提示（`[happy, bright voice]`）。包做好以后用这个新包配它，照 `dub` 不点名设定、不点名参考时的规矩（参考怎么挑见 `references/dub.md`「一句话是怎么变成合成的」，带 `default` 的设定照配音的规矩补上），一个请求；音频放进包里，清单写 `cardLine`（`protocol/FORMAT.md` 4.4），分享文件的卡片放它。这一次合成和它重试的余量，算在 `--dry-run` 的规划和花钱之前的费用估算里。规则的正本是 `lib/make-pack-card-line.mjs` 的文件头，报告的 `cardLine` 见 `lib/make-pack.mjs` 的文件头。

- 这一句单独取一个起伏：`--card-line-expressiveness <0 到 100 的整数>`（在库里调 `makePack` 时是输入的 `cardLineExpressiveness`；刻度见 `vocab/capability-signatures.md`）。只有这一次配的这一句用这个值，其余的起伏照原来，由默认那套设定来；要和 `--card-line` 一起给，没给 `--card-line` 报 `make_pack_input_invalid`（`details.field` 是 `cardLineExpressiveness`，`--dry-run` 也报）。给了的值记在清单的 `cardLine.expressiveness`（`protocol/FORMAT.md` 4.4）。声音没固定值的（包没给全局值，默认那套设定也没写），这一句默认给 70（`models/scene3.md`「起伏」「怎么取值」）；固定了的不给。出处：要求。
- 配音会把它配成不止一个请求的（中间有长停顿、章节标记、超过一次合成的字数上限，见 `references/dub.md`「一段话一次请求」）：花钱之前报 `make_pack_input_invalid`，`details.field` 是 `cardLine`，`--dry-run` 也报。比环境声明的一次合成的下限（`minChars`）短的，报同一个错。去掉两头空白以后是空的：`manifest_invalid`（`details.keyword` 是 `minLength`）。只有看不见的字符（例如零宽空格）：`manifest_invalid`（`details.reason` 是 `text_blank`）。
- 配了没成：包照做，清单里没有这一句；报告的 `cardLine.status` 是 `failed`，`hints` 里有 `card_line_failed`。补上就发新版本：`--previous <这一版的包目录> --card-line <文件.txt>`，别的不用给。没成是因为凭据被拒（401）或账户停了的，报告的 `cardLine` 另标 `halted`，提示换成 `card_line_halted`：先处理凭据或账户，不要重试，处理好再照上面发新版本（包为什么照做、不停下，见 `lib/make-pack-card-line.mjs` 的文件头）。没成是因为合成那头做完了、结果没取回来的（错误的 `details.unretrieved`，`vocab/capability-signatures.md`「通用约定」）：这一次没有再调、没有再计费，`card_line_failed` 写明没取回，`details` 带适配器给的取回办法（`retrieve`）；照上面重配会再计一次费，照 `retrieve` 手动取回的音频现在还不能交给做包放进包里。
- 这一句的语言：`--card-line-language <标签>`（在库里调 `makePack` 时是输入的 `cardLineLanguage`）。文字认不出是哪种语言的要给：法语、西语、德语都是拉丁字母，不给按英语认；比跨语言、写语言提示都照它。要和 `--card-line` 一起给。
- 和给它挑的参考段不是一种语言（包里的参考是日语，这一句是英文）：配了常会带上参考那种语言的口音，所以照配音的规矩（`references/dub.md` 第 3 步「默认不带口音」）不配，一次都不调，包照做，清单里没有这一句。报告的 `cardLine.status` 是 `failed`，`cardLine.error.code` 是 `dub_cross_language`；`hints` 里是 `card_line_cross_language`（不是 `card_line_failed`），`details` 是 `{ segmentId, from, to, script?, hasLanguage }`（参考段、它的语言、这一句的语言；从文字认不出是哪一种的，`to` 是 `null`，`script` 是文字，例如 `Latin`；`hasLanguage` 是包里有没有这一句的语言的参考段，有的是带 `default` 的设定把这一句引到了别的段，改设定发新版本也行），文字输出写「卡片试听那一句：没配」。照 `references/character-voice.md`「语言和口音」不问、不另补参考：这一句开头写名字对 `[参考语言里的名字|台词语言里的名字]`，发新版本加 `--allow-cross-language`（`--previous <这一版的包目录> --card-line <文件.txt> --allow-cross-language`，库里是 `makePack` 的选项 `allowCrossLanguage: true`），照跨语言克隆配。使用者自己要补这种语言的参考的，补一段当素材（有这个角色说这种语言的录音就用录音；没有的，默认用这个包跨语言配一段这种语言的话，素材标 `synthetic`；或者使用者在库里挑的一个说这种语言的声音，是另一个声音，先说清楚；做法见 `references/character-voice.md`「补一段这种语言的参考」），`--previous` 发新版本，同时交 `--card-line`。做包之前就知道录音和这一句不是一种语言的，第一次做包就加 `--allow-cross-language`。`--dry-run` 不报这一条：参考是哪几段、什么语言，要做完包才定。试合成（量还原度）不管这一条，照旧配（量的是声音本身）。
- 配的时候适配器换了模型（`modelChange`，`adapters/README.md`「换了模型」）：报告的 `cardLine` 记着它，`hints` 里有 `card_line_model_changed`；原来的模型能用了，照上面发新版本重配。
- 配成了、比卡片能放的长（截短的规则和上限在 `protocol/lib/preview-audio.mjs`，卡片能放多长是那里的 `PREVIEW_MAX_SECONDS`）：包照做，`hints` 里有 `card_line_trimmed`，卡片上只放前面一截；写短一点，照上一条发新版本重配。
- 没给这一句：`hints` 里有 `card_line_missing`，哪种包都提醒，话也一样（卡片兜底放主语言默认段那段录音）。
- 发新版本：这一句做好以后不重配，除非明说要重配（交 `--card-line`）。没给的，上一版有这一句就原样沿用，台词和音频都带过来，一次能力都不调（`cardLine.status` 是 `carried`）。报告照样比一比：现在照配音配它，和上一版对不上的地方写进 `cardLine.reasons`：`reference_changed`（参考段或它的录音、逐字稿、提示标注换了）、`request_text_changed`（读音词表、开头补的提示变了）、`speed_changed`（语速变了）、`expressiveness_changed`（起伏变了：默认设定的 `expressiveness` 或整个声音的全局值换了，写了和没写也算；上一版的这一句记了 `cardLine.expressiveness` 的不比起伏，沿用时不报它）、`not_one_request`（有一版配不成一个请求，前几样不比）、`default_segment_changed`（这一句的语言的默认段换了）。有 `reasons` 时 `hints` 里有 `card_line_stale`：沿用了，但和现在的配法有出入。默认段换了多半是换了声音（「换一个」）：换了声音就交 `--card-line` 重配；别的（改了读音、语速、起伏）要按现在的配法配，也是交 `--card-line`。规则在 `lib/make-pack-card-line.mjs` 的 `carriedCardLine`（包里配音脚本的 text 钩子、增强件、seed 不比，见那里）。
- 用同样的文字重配（使用者听出这一句念错了，再交同样的 `--card-line`）：环境收 seed 时，配音给每个请求的 seed 是固定的，同一个 seed 加同样的请求配出来是一样的。所以这一次的请求和上一版那一句一模一样（参考、请求的文字、语速、起伏都对得上，比法同上一条）时，seed 换成上一版那一句的加 1（清单的 `cardLine.seed`；上一版没记，是固定的那个加 1），报告的 `cardLine` 带 `seed` 和 `seedChange`（`{ from }`），文字输出写明换了 seed。请求不一样的照旧用固定的那个。用的 seed 记在清单的 `cardLine.seed`（`protocol/FORMAT.md` 4.4），沿用的版本照旧带着，下一次重配接着加。不是自动重试：只在交了这一句时换。规则在 `lib/make-pack-card-line.mjs` 的 `voiceCardLine`。

**重生成的参考**：库里重生成的参考（例如从一段干净的参考重新生成的几段），和给包补另一种语言时用这个包跨语言配的那一段（`references/character-voice.md`「补一段这种语言的参考」），当素材收，和原始录音一样：一样当参考、能当默认段。素材里给它标 `"synthetic": true`，这个记号只给量还原度用：它不当留出录音，不进真人基线，报告的真录音段数不数它。`make-pack` 自己不克隆、不重生成素材。

**还原度**：量法、报告怎么读、补做和作废的条目，细则在 `references/make-pack-details.md`「还原度」。

**报告在哪**：报告只打印在标准输出：不带 `--json` 是文字摘要，`--json` 是完整的 JSON（`report` 字段）。命令不把报告写成文件，要留存就重定向标准输出。

**还缺什么素材**：报告里的 `hints`，一条一个原因，例如没有留出录音（`no_holdout`）、某种语言只有一段（`language_single_reference`）、没有配音指引（`guidance_missing`）。设计来源的包、加了 `--no-holdout` 的包，不给留出录音的两条（`no_holdout`、`holdouts_few`）。只能拿这个包自己再克隆才补得上的，不提示去补：设计来源的包也不给参考段的三条（`few_references`、`short_reference_total`、`language_single_reference`），设计出来的声音参考只有照试听配的那一段，没有录音可补。默认音色、融合出来的声音做包也写设计来源，清单分不出它和设计出来的，所以这三条也不给；它的参考是 `--audition` 的试听切出来的，段少、加起来短、某种语言只有一段的（门槛是 `lib/material-hints.mjs` 的 `THRESHOLDS`），看报告里的参考（`report.segments` 里 `role` 是 `reference` 的段，时长在 `quality.metrics.durationSec`）自己补：再用默认音色、融合多生成几段试听，`--previous` 发新版本交进来；某种语言的参考全是合成的（标了 `synthetic`，例如补另一种语言时用这个包跨语言配的那一段），这种语言不给 `language_single_reference`。语言按规范化以后的写法比（`zh-CN` 和 `zh-cn` 是一种）。补了素材，发新版本。

**配音指引和音色标签**：`--guidance <文件.md>` 写配音指引，五节的写法见下面「配音指引的五节」，放进 `SKILL.md` 最后一节；只写想要的效果；模型的指令语法由适配器决定，写进配音指引会绑死某个模型。`--direction <文件.json>`：`{ description, tags }`，音色标签只能从设计词表（`vocab/design.json`）里取，中文名也认，写进清单的是规范写法；不在词表里的、别的字段，在花钱之前报 `make_pack_input_invalid`。`--lexicon <文件.pls>` 放读音词表：只有清单的 `files` 列着它才读，所以直接改已装的包里的 `lexicon.pls` 不生效。改读音要发新版本（`--previous <上一版> --lexicon <新文件.pls>`，见「发新版本」），由它把词表和哈希写进清单。`--design-source <文件.json>` 记设计来源，用设计出来的声音、默认音色、融合出来的声音做包时写：`{ description, model, modelVersion, date, auditionLines }`，`auditionLines` 是设计时试听用的台词（字符串数组，设计时念的原文）。`model` 取能力调用返回的 `model` 字段（`voice-design` 的返回里有，适配器给了才有；取法见接进来的适配器的说明），返回里没有就不写；`modelVersion` 返回里没有这一项，不写。`--audition <文件>` 收默认音色、融合出来的试听：不分离（合成出来的本来就是干净的人声），同样切开、转写，一部分当参考、一部分当留出录音（做包照规则挑），设计来源写进清单；没给 `--design-source`，报告里提醒 `design_source_missing`。设计出来的试听不用它交：它只当原料，不进交出去的包（见「设计出来的声音怎么做包」）。`--sample-lines <文件.json>` 记示例台词：一份 JSON 数组，每项一句，原样写进清单的 `sampleLines`；最多 50 条，每条 1–500 个字符，不能只有空白（`text_blank`）；台词里可以带舞台提示，例如 `（耳语）`，格式只存这句字符串、不解析它。发新版本不给 `--sample-lines` 就沿用上一版的，给空数组就去掉。

**读音词表**：`--lexicon` 的两种写法（`<alias>`、`<phoneme>`）和音素的条件，见 `make-pack-details.md`「读音词表」。音素用中文的拼音（`x-pinyin`）、英文的 Arpabet（`x-arpabet`）或日文的罗马字（`x-romaji`）写；音素写成标签发出去，标签的字照样算钱；词条写整个词，只写一个字的，报告的 `notes` 里有一条 `lexicon_single_character`。原来用同音字的别名改读音的怎么改写成音素，也在那一节。

**几套设定（把固定值写进音色里）**：`--setups <文件.json>`：一份 JSON 数组，每项是一套设定 `{ name, labels?, referenceTag?, speed?, instructions?, expressiveness?, default? }`（`labels` 是固定的 `{ language?, emotion?, style?, energy? }`：`language` 是语言标签，`emotion`、`style` 的名字取标签词表（`vocab/cues.json`），`energy` 是 `low`、`medium`、`high` 之一，它们和参考段的音色基底标签不是一回事；`referenceTag` 是这套设定的默认参考，写包里一段参考的音色基底标签，可以不写；`speed` 是正数，1 不变，0.85 放慢，1.15 加快；`expressiveness` 是这套设定固定的起伏，配音时调用方没给、这一行又用了这套设定，就用它（盖过包的全局值，全局值见下面「整个声音的起伏」）（刻度见 `vocab/capability-signatures.md`），值怎么定见 `models/scene3.md`「起伏」；做设定时默认不声明它，只有这套设定真要和全局值不同时才声明（例如暴怒），声明时从全局值挪约 10，包里没有全局值的，照 `models/scene3.md`「怎么取值」（出处：要求）；`instructions` 是给写台本的人看的说明，写口音、口吻具体的特征，`dub` 不把它发给模型；名字不能重，最多一套带 `default: true`，写法的正本是 `protocol/FORMAT.md` 4.4），原样写进清单的 `setups`。配音时用 `dub` 命令的 `setup` 选项选一套，不选就用带 `default` 的那一套；设定补在调用方没给的那一项上：语言用来挑参考（`references/dub.md` 第 3 步）；情绪、风格、能量合成一条提示，写在每个请求的开头，台本在一段的开头自己写了提示的那一段照台本；语速在合成以后变速；起伏原样传给每个合成请求（都在 `references/dub.md`「开头的提示和语速」）。**说明（`instructions`）不发给模型。** 「带一点四川口音」「新闻播报的口吻」这种概括的标签，模型不知道具体怎么念（这两句是反例）。说明是给写台本的人看的，写这个口音、口吻具体的特征：口音记这种方言自己的用词、语气词，和哪些常用字写成哪些别的字，也可以记声调、句尾升还是降、节奏快慢；不知道的，查资料或者问使用者，不凭印象编（写法和理由见 `models/scene3.md`「跨语言和口音」「写什么」）。用了带说明的设定，`dub` 规划的 `notes` 里有一条 `setup_instructions`，列出说明原文和哪几句用了这套设定，叫写台本的人照说明在台本里写具体的（`references/dub.md`「开头的提示和语速」）。说明不限长，做包不查它的长短；清单的格式也只管 1–4000 个字符（`protocol/FORMAT.md` 4.4）。情绪、风格用标签词表（`vocab/cues.json`）里的名字或近义词；写一下子的声音（叹气、笑这类，`vocab/cues.json` 的 `oneShot`），写在风格里、情绪里都一样，配音时不进开头的提示：要叹气、笑，写在台本里它发生的地方。**情绪、风格、能量合成的开头的提示要短。** 配音的模型只收文字，它会写进每个请求的开头。照 `dub` 合成的样子数（一下子的声音不算），整条不超过 10 个词（`lib/cue-length.mjs` 的 `MAX_OPENING_CUE_WORDS`；汉字、假名两个算一个词，拼音文字按空格数，数字、标点不算）。`--setups` 给的有一套超了，花钱之前报 `make_pack_input_invalid`（`--dry-run` 也报），`details.field` 是 `setups[<序号>]`，`details.words` 是数出来几个词；发新版本不给 `--setups`、沿用上一版的设定超了，不报错，原样写进新版本，报告的 `notes` 里有一条 `setup_opening_cue_too_long`（`details` 是 `{ setup, words, limit, from: 'previous' }`），配音用到这套设定时会报 `dub_input_invalid`，要改就给 `--setups` 换一份。`--setups` 给的有一套 `expressiveness` 不是 0 到 100 的整数（小数、0 到 1 的写法、越界、不是数），也在花钱之前报 `make_pack_input_invalid`（`--dry-run` 也报），`details.field` 是 `setups[<序号>].expressiveness`。`cueWords` 和两个上限（`MAX_CUE_WORDS`、`MAX_OPENING_CUE_WORDS`）是给调用方用的稳定接口：调用方可以直接 import `lib/cue-length.mjs`，在交给 `make-pack`、`dub` 之前自己先查。`referenceTag` 在花钱之前查（`--dry-run` 也查）：它得是素材给的标签（花钱之前没被筛掉的段），或者上一版参考的标签（这次 `--drop` 去掉的不算，`--retag` 改了的认改以后的），模型起的名字、段名兜底的标签不算；对不上报 `make_pack_input_invalid`，`details.field` 是 `setups[<序号>].referenceTag`，给的设定和沿用上一版的都查。它指的标签在这种语言里只剩一段时，这段不当留出录音，参考上限也不裁它；付费以后这段还是没进参考集（例如转写没成），命令报同一个错停下。做包的试合成（量还原度）不用设定，也不用 `referenceTag`：每条留出录音用它那种语言的默认段。改设定有两条路。**只是存一套预设、删一套预设，不出新版本**：用 `setups` 命令原地改，`node cli.mjs setups save <包目录> --setup <一套设定.json>`（文件是一个 JSON 对象，字段同 `--setups` 的每一项；同名就覆盖，没有就新增）和 `node cli.mjs setups delete <包目录> --name <名字>`，库里是 `lib/pack-setups.mjs` 的 `saveSetup`、`deleteSetup`。两个都收 `--json`，输出 `{ status, name, setups }`：`status` 是 `added`、`replaced`、`deleted` 之一，`setups` 是改完的整份（没有了是空数组）；不加 `--json` 打一两行说明。它们只改当前这个版本的 `manifest.json`（设定在清单里），以及清单里记着大小和哈希的 `SKILL.md`（骨架里有一句取决于有没有设定写了 `referenceTag`，改完按现在的清单重新生成，字节没变就不写）；`version`、`changelog`、验证记录和别的文件都不动。动手前先查包本身完好（文件对清单、清单合规），不好就拒绝，报它原来的错；改完把整份清单再校验一遍（重名、两套默认、`referenceTag` 不在参考集、`speed`、`expressiveness` 越界），这次保存的这一套合成的开头的提示也不能超过 10 个词，不合格报 `pack_setup_invalid`（`details.problems` 是问题清单），一个字节都不写。保存 `default: true` 时别的设定的 `default` 去掉（一个包最多一套）；同名覆盖是整套换掉，旧设定的字段（包括 `default`）不继承；删光了清单里就没有 `setups` 这个字段；删掉默认的那一套，包就没有默认设定，不会自动指定别的；删不存在的名字报 `setup_not_found`（`details.name`、`details.names`）；新值和旧值一模一样，照常成功，不写盘。**只改命令给的这一个包目录**：装在别处的同一个包的副本、已经导出的分享文件不会变，要各改各的；同一个目录不要两个进程同时改（不加锁，后写的盖掉先写的）。**换参考、改指引、补素材这些会变声音的，还是要发新版本**：`make-pack --previous`，发新版本不给 `--setups` 就沿用上一版的，给了就换掉，给空数组就去掉。

**整个声音的起伏（全局值）**：`--expressiveness <0 到 100 的整数>`（在库里调 `makePack` 时是输入的 `expressiveness`；刻度见 `vocab/capability-signatures.md`）：写进角色部分清单顶层的可选字段 `expressiveness`（`protocol/FORMAT.md` 4.4），是整个声音的值，不是设定。配音时它排在设定的 `expressiveness` 后面：这一行用的设定写了就用设定的，没写就用它，调用方给的盖过两者（先后见 `references/dub.md` 选项表的 `--expressiveness` 一行）。配音时不用设定，只是不取设定的值，全局值照用。发新版本不给它就沿用上一版的值；`--expressiveness none`（库里是 `expressiveness: null`）去掉它；换一个值要发新版本。不是 0 到 100 的整数（小数、0 到 1 的写法、越界、不是数），花钱之前报 `make_pack_input_invalid`（`--dry-run` 也报），`details.field` 是 `expressiveness`。值怎么定见 `models/scene3.md`「起伏」「怎么取值」。

素材是设计出来的声音时，示例台词是当面对人说的平常话（口气同 `references/character-voice.md`「默认段」：说话的口气，像面对面说话；不照同一份的「台本对谁说」写，示例台词是给包的范例句，不是对创作者说的台本），其余几句也一样，每句一种情绪，至少两句是问句、回答或插话。示例台词取 `vocab/design-sample-lines.json` 里跟声音语言一样的那一组（zh、en 各 7 句，每句的 `feel` 各不相同，`kind` 写明这一句是哪一类：`greeting` 招呼、`question` 问句、`reply` 回答、`aside` 插话、`request` 请求、`apology` 道歉）的 `text`，写成字符串数组：`--sample-lines` 要的是字符串数组，直接给那一组的对象，花钱之前报 `make_pack_input_invalid`（`details.field` 是 `sampleLines[0]`，点名第几条）。也可以自己写同样口气的几句。示例台词只写进 `sampleLines`，不克隆成素材。

**配音指引的五节**：配音指引写的是这个人是谁、这个声音怎么说话、怎么念、说什么、换了语言怎么说，分五节，小节名照「## 配音指引」的规矩不翻译。「这个人是谁」「换语言时怎么说」两节做包时必须写：给了 `--guidance`，却缺这两节或者哪一节一行都没有，花钱之前报 `make_pack_input_invalid`（`details.field` 是 `guidance`，`details.missing` 是缺的节名）；整节每项都写 `缺` 也算写了。另外三节可选。五节都是写台本的人看的，`dub` 不交给模型：

- `### 这个人是谁`：五项，每项一行，项名照写：`- 身份：`（做什么的、在哪、多大；使用者说过的身份原样写进来，一处不丢）、`- 性格：`、`- 在意什么：`、`- 对不同的人：`（对熟人、生人、孩子各是什么态度，至少写熟人和生人）、`- 情绪上来时：`（生气、难过、高兴时声音往哪边变）。依据是使用者的话、角色卡、作品原文，每条跟出处；没有依据的项写 `缺`（`- 在意什么：缺`），不编，也不按人物类型推。写台本时照它定这个人这一刻会怎么说、对谁什么态度。

- `### 音色`：这个声音听起来怎样（性别、年龄、音高、特点这类，和设计描述说的是同一种东西）。沙哑、低沉写在特点里，沙哑也写进演法；喉位、松紧、气声、语速写在演法里（两节都是写台本的人看的：演法照着写提示，音色照着挑写法）。设计描述也只写音色；角色的语速、停顿、笑这类说话方式写进演法，不写进设计描述（`references/character-voice.md`「设计出来的声音：描述」）。
- `### 演法`：怎么念，七项：喉位、松紧、气声、沙哑、语速、停顿、笑和叹气。`dub` 不把指引交给模型：配音的 agent 照演法在台本里写提示，写在说法、嗓子要变的地方，一处一个两三个词（`references/dub.md`「一句话是怎么变成合成的」第 5 步，和各场景的子 skill；细的演法见 `models/scene3.md`「写什么」细的演法那一条）；模型认哪几种写法、读数怎样，看基础部分的模型说明（`models/scene3.md`「提示」）。七项是能写的范围，不是要逐项填的表：材料里没有的项整行不写，不写占位（「角色卡没有写，不写」这类，占位会被当成要演的东西写进提示）。一项都没有，就不写这一节。
- `### 台词`：说什么、怎么措辞，五项：自称、句尾、口头禅、用词、方言。写台本的人照着看，不交给模型。角色带口音的，方言一项记这种口音具体的特征（`references/character-voice.md`「口音的特征」）。
- `### 换语言时怎么说`：三项，项名照写，前面写语言标签：`- 名字：`（各语言里的名字，`en Harry Potter；zh 哈利·波特`）、`- 自称：`（各语言里怎么称呼自己）、`- 口头禅：`（到别的语言里怎么说，或者写明保留原文不译）。没有依据的写 `缺`，同上。跨语言配音的名字对（`[参考语言里的名字|台词语言里的名字]`，`references/dub.md` 第 3 步）从「名字」一项取；是 `缺` 的，写台本的人现拟一个，并告诉使用者是现拟的。
- 年龄档：指引里分年龄档写的（「16-18 岁版」「成年」），档名和设定（`--setups` 的 `name`、`referenceTag`）写成同一个；几档的说法能不能互用（成年档能不能用少年时的口头禅），写明。

音色和台词的每条特征后面跟出处：材料里的原句或叙述片段，照原文写。只从叙述里抽，台词原文照抄。材料里没有、按人物类型推的，写「推断」，不当成角色的事实。演法的每一项只写内容，不跟出处，也不写「推断」：它是照着写提示用的，出处和「推断」写进去会被当成要演的东西。分析材料时照旧要找出处，找不到出处的条目不写进演法。格式的正本是 `protocol/FORMAT.md` 第 5 节（改格式时读，做包不用读）。怎么填、默认段怎么定，见 `references/character-voice.md`。

**骨架的语言**：英文作者做英文包时加 `--text-language en`，写法和规则见 `make-pack-details.md`「骨架的语言」。

**发新版本**：`--previous <上一版的包目录>`。包 ID 不变，版本号往上加（`--version` 明说，要比上一版大，否则 `make_pack_version_invalid`；或 `--bump patch|minor|major`，默认 minor），`--changelog` 不给就按变化生成一份。上一版要是协议 3.x 的包。1.x、2.x 的包（清单的 `protocol` 是 `1.x`、`2.x`，2.7.0 和更早的基础部分做的都是）在花钱之前（`--dry-run` 也一样）就报 `make_pack_previous_invalid`：`details.reason` 是 `protocol_old`，`details.protocol` 是它写的协议版本。这一版不迁移旧包，要用新的素材做一个新包，包 ID 是新的。改上一版参考的标签用 `--retag`（上面「改标签」）。换一个用 `--drop` 去掉上一版的全部段名，见下面「设计出来的声音怎么做包」。设计来源（`--design-source`）没给的，上一版的段这一版还留着至少一段就沿用（补卡片那一句、改设定、改读音、补素材）；一段都没留下（`--drop` 掉了全部段，例如在设计的声音上改做音色库的声音）就不沿用，这一版没有设计来源，报告的说明（`report.notes`）里有 `design_source_dropped`：清单认不出哪几段是设计来的，所以按段一段都没留下算；这一版的声音还是设计出来的，就交它的 `--design-source`（规则在 `lib/pack-version.mjs` 的文件头「设计来源」）。其余细则在 `references/make-pack-details.md`「发新版本的细则」。

**设计出来的声音怎么做包**：先用 `design` 设计出试听，再做两次包，用 `make-pack` 和 `dub` 走。设计出来的试听只当原料：它是没处理过的干声，多半念得平，拿它当参考，之后每一句多半也演得平（推断：听过的只有第一页试听里的一个角色，一个人听的，`models/scene3.md`「参考」）。所以先用试听做一个临时的包，用它照角色卡配一段带表演的话，再用配出来的这一段做正式的包；交出去的是正式的包。素材写成 `.json`，`audio` 的路径相对它所在的目录。

第 0 步，设计：`node cli.mjs design --description <描述> --text <试听文本> --out <候选目录> --adapter <适配器目录>`（描述、试听文本的写法见 `SKILL.md` 第 2 节「设计」）。它调一次 `voice-design`（暂时出错按 `lib/call-attempts.mjs` 再来），在候选目录写出试听 `intro.<扩展名>`、第 1 步的素材 `material.json` 和第 3 步的设计来源 `design-source.json`，再打印后面几步的完整命令。一次一个候选，再要一个就换一个输出目录再跑（`references/character-voice.md`「不问人做完一轮，和换一个」）。先加 `--dry-run` 看规划，不调能力。

第 1 步，临时的包，只当原料，不交出去：不装、不放进库、不打分享文件，正式的包做好以后可以删掉。素材只有一段 `intro`，就是锁定的试听，`text` 是试听文本原文（`design` 写出的 `material.json` 就是它，路径照写，不用再拷）。有文本，做包就不转写整段（标提示标注量停顿时按块转写，只用来对位置，不改文字）；只有一段，也不请模型挑默认段（`--dry-run` 的规划里能看到）；标提示标注照常做（听 1 次）。设计来源、音色、指引、示例台词和 `--card-line` 都不给。报告的「还缺什么素材」里会有 `few_references`、`short_reference_total`、`language_single_reference`、`guidance_missing`、`direction_tags_missing`、`card_line_missing`，都不用管：临时的包只当原料，不补素材，也不发新版本。素材这样写：

```json
{
  "segments": [
    { "id": "intro", "audio": "audio/intro.mp3", "text": "<试听文本>" }
  ]
}
```

```sh
node cli.mjs make-pack <试听素材.json> --output <临时目录> --name <名字> --language zh --default-segment intro --no-holdout --adapter <适配器目录>
```

第 2 步，带表演的那一段。照角色卡写（没有角色卡的，照描述和名字写），写法见 `references/character-voice.md`「默认段」，贴这个角色，把它最有特点的地方演足，存成台本文件，用临时的包配。起伏固定取 80（`--expressiveness 80`，要求，`models/scene3.md`「好例子」的作者 2026-11-10 提的；80 和别的值没有对照过）：只管这一段，不写进正式的包的全局值，预演和重配也带着它。先加 `--dry-run` 看规划：要是一个请求（文字输出是「共 1 句」，`--json` 里 `units` 只有一项）；写了长停顿、章节标题的会切成几个请求，去掉再配：

```sh
node cli.mjs dub <临时目录> <那一段.txt> --out <输出目录> --expressiveness 80 --adapter <适配器目录>
```

配完看 `dub.json`：

- 这一段带 `modelChange`（适配器换了模型，`adapters/README.md`「换了模型」）：这一段不用，参考得是配音的模型（`models/scene3.md`）配的。等原来的模型能用了，照下面重配。不问人的一轮停在这里，不做正式的包，照实写进报告。
- 没念全：`notes` 里有 `speech_maybe_unfinished` 的，照下面重配。少念一两句（例如最后一句丢了）没有这一条，也不另外转写去对：第 3 步做包转写这一段，正式的包里的逐字稿是真念出来的，跟着声音走。
- 长于 20 秒：模型那边会把它截短，给的文字也不用了（`references/character-voice.md`「默认段」）。`dub.json` 里没有时长：第 3 步的命令先加 `--dry-run --json` 跑一遍（不花钱，不调能力），报告里这一段的 `quality.reasons` 有 `duration_long` 就是长了。照那一节改短台本，照下面重配，再用新配的一条做第 3 步。

重配：`node cli.mjs dub <临时目录> <那一段.txt> --out <输出目录> --only 1 --expressiveness 80 --adapter <适配器目录>`。环境收 `seed` 的，重配会换一个 `seed`（`references/dub.md`「失败和重做」）。没念全的、长了的只重配一次：第二条还没念全或者还长，不再配，正式的包用它做（逐字稿是做包转写的，和录音对得上），照实写进报告。

第 3 步，正式的包。素材只有一段，段名例如 `acted`：把输出目录里配出来的 `001-intro.<扩展名>` 拷成素材旁边的 `audio/acted.<同一个扩展名>`（或者 `audio` 直接写它相对素材 .json 的路径）。不写 `text`，写 `scriptText`：第 2 步那一段的台本原文（带提示、带名字都行，做包去掉）。做包照样转写这一段：转写和台本原文的字数差不到一成、字有七成对得上，逐字稿用台本原文（转写常把同音字听错，`摆轮` 听成 `百伦`）；差得多的（念漏了一句、念得不一样）用转写，跟着声音走，报告里这一段带 `scriptTextUnused`。`annotatedText` 也不写：做包请能听音频的模型照这一段音频实际的样子标（上面「提示标注」）。不要拿台本里的提示填它：台本的提示是想要的说法，不是这段音频里念出来的，填进去就标错了。环境没有能听音频的模型，也不填，只存逐字稿。环境没有转写（`automatic-speech-recognition`）的，不写 `text` 做包会报 `make_pack_no_material`（`--dry-run` 也报）：这时写 `text`，就是台本去掉提示的原文；少念了一两句也查不出来，照实写进报告。音色基底标签不写由模型起名，要自己起名就写 `tag`（上面「标签」）。它是唯一的参考，也是默认段；试听那段不进正式的包。所以报告的「还缺什么素材」里没有参考太少、太短、某种语言只有一段这几条（设计来源的包不给，上面「还缺什么素材」），不用照提示再克隆几段。设计来源（`auditionLines` 是试听文本原文）、音色、指引、示例台词、卡片那一句照常交，写法见上面「配音指引和音色标签」「卡片试听那一句」：

```json
{
  "segments": [
    { "id": "acted", "audio": "audio/acted.mp3", "scriptText": "<第 2 步那一段的台本>" }
  ]
}
```

```sh
node cli.mjs make-pack <正式素材.json> --output <新目录> --name <名字> --short-name <英文短名> --language zh --design-source <设计来源.json> --direction <音色.json> --guidance <指引.md> --sample-lines <示例台词.json> --card-line <卡片台词.txt> --card-line-expressiveness 70 --default-segment acted --no-holdout --adapter <适配器目录>
```

做好以后，目录名要和包 ID 一样：报告的说明里有 `directory_name_differs` 的，照它写的改。卡片那一句用正式的包配，参考就是这一段。之后用这个包配音，参考也是它；平台临时换了配音的模型，克隆的也是它，不是试听。

两次都不用 `--audition`：它把音频切成 5 到 20 秒的几段再转写，段名由命令按文件名起，点名的段名指不到它上面，默认段得照规则从切出来的段里挑。`--default-segment <段名> --no-holdout` 把这一段定成默认段，并且不留出录音：设计出来的声音没有真人录音，留出几条只是多一轮试合成。不再用试听克隆情绪台词：克隆多半会照搬参考里的表演，拿平读的试听克隆出来的「开心」「生气」多半还是平读（推断：第一页一个人听，一个角色如此，没有专门比过，`models/scene3.md`「参考」）。

第二版（换一个，做法见 `references/character-voice.md`「不问人做完一轮，和换一个」）：第 1、2 步照走（新的试听、新的临时的包、新配的一段），第 3 步改成发上一版的新版本。上一版是 2.x 或更早的基础部分做的（清单的 `protocol` 是 `1.x`、`2.x`；这种包设计出来的段名是 `intro`，有的还有 `happy`、`angry`、`calm`），发不了新版本（上面「发新版本」）：这种包要换一个，照第 1 到 3 步做一个新包，包 ID 是新的，旧包留着，报告里写明旧包是旧协议的，没有接着发版本。协议 3.x 的包照下面做。段名不能和上一版重复，去掉的也算，所以新配的一段叫 `acted-2`（再换一次叫 `acted-3`，依次往下）；`--drop` 去掉上一版的全部段名（从上一版 `manifest.json` 的参考和留出录音里取：照这个做法做的包是 `acted`，换过的是 `acted-2`、`acted-3`……），默认段指新的 `acted-2`。描述换了，设计来源、音色（`--direction` 的 `description`）和配音指引的「音色」一节都照新描述重写；音色和指引没给的会沿用上一版，包里写的就还是旧声音；设计来源没给的，上一版的段都去掉了，旧的不沿用，这一版就没有设计来源（报告的说明里有 `design_source_dropped`）。卡片试听那一句再交一次（`--card-line`）：不交的话，上一版的那一句是旧声音配的，照样沿用，报告提示 `card_line_stale`：

```sh
node cli.mjs make-pack <新素材.json> --previous <上一版的包目录> --drop acted --default-segment acted-2 --no-holdout --design-source <新的设计来源.json> --direction <新的音色.json> --guidance <新的指引.md> --card-line <卡片台词.txt> --card-line-expressiveness 70 --language zh --changelog "<说明>" --output <新目录> --adapter <适配器目录>
```

音色库的声音也照这三步做，过表演段（要求，`models/scene3.md`「好例子」的作者 2026-11-10 提的；这样做出来的没有人听过）：第 1 步的素材是库里这段声音（一段，5 到 20 秒，长的写 `trim` 只取几秒；库里有文字的写 `text`，没有就不写，做包转写它）；第 2 步照样配，起伏 80；第 3 步不交 `--design-source`（它不是设计出来的），报告的「还缺什么素材」里会有 `few_references`、`short_reference_total`、`language_single_reference`，不用管，不照提示再克隆几段。使用者给的录音不过表演段，照下面做一次包。

**使用者给的录音**：`--recording <录音>`（一个目录就是几段录音；带视频轨的文件也收，见上面「截来的片段」），不用先切。收录音那一刻先问一句：「这段里只有她一个人说话吗？有背景音乐或别人插话吗？有的话告诉我她单独说的是哪几秒」（她换成角色的称呼）。只有她一个人、没有背景的，照常用 `--recording` 做，不用多说。说了秒数的，照「截来的片段」写成素材，每处一段，写上 `trim`，不用 `--recording`。素材不做分离，报告里也不会有 `separation_skipped` 提醒你：她说的那几秒里还有配乐的，告诉使用者配乐会一起带进这个声音；接的适配器有 `audio-source-separation`、又要去掉配乐的，改用 `--recording`（它不收 `trim`，别人插话的声音会一起带进去）。有背景、又拿不到时间的，照原样用 `--recording` 做，告诉使用者别人插话的声音会一起带进这个声音；配乐要看做完的报告。做完看报告：`--json` 的 `report.notes` 里有 `separation_skipped`（文字输出是「注意：这次没做分离，输入要是干净的人声」；环境没有分离能力，或者给了 `--no-separate`），录音里又有配乐的，告诉使用者配乐也一起带进了声音，想去掉就交干净的录音再做一次。录多长才留得出还原度：读还原度要有效的留出录音至少 5 条（`lib/fidelity.mjs`「怎么读这份报告」第 1 点）；留出条数是真录音段数的 20%（四舍五入，`lib/pack-material.mjs` 规则 2），所以要 23 段真录音（每段 5 到 20 秒，合几分钟的录音）才留得出 5 条。做一次包就完：

`node cli.mjs make-pack --recording <录音> --output <新目录> --name <名字> --guidance <指引.md> --direction <音色.json> --sample-lines <示例台词.json> --card-line <卡片台词.txt> --card-line-expressiveness 70 --adapter <适配器目录>`，写法见「配音指引和音色标签」，`--card-line` 见「卡片试听那一句」。演法、台词和示例台词从角色卡写；没有角色卡就都不写，指引只剩「音色」一节。录音和卡片那一句（或者以后要配的台词）不是一种语言的，不问，加 `--allow-cross-language`，这一句开头写名字对 `[参考语言里的名字|台词语言里的名字]`（`references/character-voice.md`「语言和口音」）；漏了的，做包的报告里会有 `card_line_cross_language`（上面「卡片试听那一句」）。卡片试听那一句照 `references/character-voice.md`「卡片试听」写（没有角色卡的，照描述和名字写）。命令把录音切成句子，同一个采样率的句子按原来的先后并成 5 到 20 秒的段，再一段转写一次（`--dry-run` 的规划里，转写是段数），句子不逐句转写、不逐句先听；一段里可能有几种说法。并段不按语言分开：给了 `--language` 的，段的语言就是它；没给的，用这一段整段转写报的语言，报不出就从整段的文字认。所以一段录音里混着几种语言、又不给 `--language` 时，一段里可能有几种语言，段的语言照上面定；要按语言分开，先自己切好，每段写上 `language` 当素材交。每段的音色基底标签由标提示标注的调用起名，起不成的是段名（上面「标签」）。相邻的两句之间留原来的停顿，隔着别的句子的是 0.3 秒静音（规则在 `lib/make-pack-sentences.mjs` 的文件头）。默认段照「默认段和卡片试听」挑，`--default-segment` 可以点名任一句子或段；留出录音和还原度照常，不加 `--no-holdout`。留出录音的条数、费用的估算都按并好的段算。

上面几种做包都一样：`--short-name` 不问使用者，不给就用 `vp`。

**完整包和外部资源**：要把基础部分放进包里，或者片段要记成外部资源，见 `make-pack-details.md`「完整包」。

**分享文件**：要打一份带预览卡片的 `.voicepack.zip` 时，见 `make-pack-details.md`「分享文件」。

**照一个已有的包做新包（净室和查重）**：流程、查重比什么和阈值，细则在 `references/clean-room.md`「净室和查重」。
