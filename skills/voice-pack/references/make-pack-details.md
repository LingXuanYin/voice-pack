# 做音色包：主路用不到的细则

这一份是 `references/make-pack.md` 挪出来的细则：下面几节是挪过来的正文（「参考集和留出录音」里一处指针改成了文件名，那一节末尾加了「长原声的截法」），原处留了一行指针。还原度的量法和报告、增强件、响度、参考集和留出录音、发新版本的细则、读音词表、骨架的语言、完整包、分享文件都在这里。照一个已有的包做新包（净室和查重）在 `references/clean-room.md`。设计出来的声音、借来的声音和录音、用包配台本这三条主路不用读它，要查这些细则时再读（借来的参考音频超过 20 秒的，截法要读「长原声的截法」）。

## 还原度

**还原度**：用做出来的包把留出录音的文本合成一遍（每条按它自己的标签挑参考），再按 `lib/fidelity.mjs` 文件头「怎么读这份报告」量；报告里的数照原样写，分数由那里的规则算出。量不了的一项报「量不了」，缺哪项能力就点名哪项；服务暂时出错的那一项记成「没听成」，写明条数和「可以补做」，整件事照常完成；回答被模型的服务商拦下的（能力抛 `provider_blocked`），那一条盲听、那一段的标签记成「作废」，另数有几条是被拦下的，不记成「没听成」，补做也不重做它（同一段录音再问还是被拦）；某一段录音里没有能嵌声纹的语音，那一条的说话人相似度记成「量不到」（写明是生成的还是留出的那一段），不进比例，不能补做（读法第 9 点）。要补做，做包时加 `--save-evaluation <新目录>`，之后 `node cli.mjs fidelity <新目录>/evaluation.json --redo <新目录>/fidelity-report.json`；要调几次，做包的报告里已经写明（`planRedo` 算的），适配器给了费用说明时，补做的 `fidelity` 开始之前还会在标准错误里再说一遍。补做不改包里的验证记录，要更新就发新版本。收音校验没过（`listening_check_failed`：回答的开头和已知文本对不上）和回答不是固定格式（`blind_answer_invalid`）的，同样记成作废、不计入比例；补做（上面的 `fidelity` 命令）只重做「没听成」的，作废的不补做。作废的那条在报告的 `details` 里有第几次问、哪段录音、错误率。试合成（上面的第一步）暂时出错的，每条留出录音最多试 3 次，每次试都是一次合成，可能再计一次费用；报告里的 `retried` 数的是多试的次数。验证记录写在清单里：环境、模型、日期、比值（说话人相似度量不了时只有盲听，没有比值）。

## 增强件

增强件只保证格式上放得进去，做增强件要有能微调的运行环境，这里不做。

## 响度

**响度**：写进包里的参考和留出录音统一到 −20 LUFS、采样峰值不超过 −1 dBFS（和克隆流程里的参考响度是同一个数；规则和这两个常量在 `tools/loudness-normalize.mjs`，用法在 `lib/make-pack-loudness.mjs` 的文件头）。生成时每句话挑不同的参考，参考之间响度差得多，配出来的整段就会一句响一句轻，所以统一到同一个响度。音质检查、能量标签照原始音频量，调的只是放进包里的那份字节（存成 16 位 WAV）。加增益会让峰值超过上限的段（峰值比响度高 19 dB 以上，说话里有个特别响的瞬态），默认用限幅器压住过高的峰再加，最多压 6 dB，每段的 `loudness.limitedDb` 记着压了多少；压到 6 dB 还到不了目标（差 0.5 LU 以上）的，只加到能加的，报告的 `notes` 里写 `loudness_target_not_reached`，写明调完到了哪里、压了多少；上一版带来的段、外部资源、解不了的，照原样留着，报告里记 `loudness_skipped`。`--no-loudness` 关掉整个调响度，音频原样放进包里；`--no-limiter` 只关限幅器，回到只加增益（峰值太高的段到不了目标）。

## 参考集和留出录音

**参考集和留出录音**：规则只有一份，在 `lib/pack-material.mjs` 的文件头；留出录音从不当参考，数值是起始值，没拿真实的包校准过。音质检查用 `tools/` 里的阈值，不合格的片段不进包，报告点名原因。同样的音频字节只留一份（`duplicate_audio`）；发新版本时，上一版里的段是调过响度存的，新补的同一段录音也认得出来。`--default-segment <段名>` 明说默认参考段，新包和发新版本都能给：段名是这次素材里的一段（或上一版的参考），它不会被挑成留出录音，也不会被参考上限裁掉（规则和理由在那个文件头）。没给 `--default-segment` 时，默认段按 `lib/pack-material.mjs` 的规则 5 挑（规则和理由在那个文件头；参考集里有真录音，就只从真录音里挑，标了合成的不挑）。留出录音：不到 3 段可用的真录音时不留（标了 `synthetic` 的克隆不算），否则留真录音数的 20%（至少 1 段，最多 6 段，不超过真录音数减 1）；按「语言加情绪」分组，一组一组轮着取，取文字不少于 10 个词、优先级最低的那段，每组至少留一段做参考。作者明说的默认段不留出。`--no-holdout` 不留出录音：能用的段都进参考集（超过上限的照常裁掉），报告不给 `no_holdout`、`holdouts_few`，规划里没有试合成。设计出来的声音、库里借来的声音做包时加它（见 `make-pack.md`「设计出来的声音怎么做包」）。发新版本时，上一版已有的留出录音照旧带过来，要去掉用 `--drop`。

**长原声的截法**：库里借来的参考音频长于 20 秒时，截下来的那一截当克隆的参考，不进素材，不进包（`intro` 是克隆出来的，不截）。截哪一段照切段的结果定，不靠听：

1. `node cli.mjs make-pack --recording <录音> --name <名字> --dry-run --json`：不花钱，不调能力，不写文件。读 `recordings[0].segments`：每段有 `startSec`、`endSec`、`durationSec`；`cut.start`、`cut.end` 是 `pause`（停顿）、`edge`（录音的头或尾）或 `forced`（硬切，切在说话中间）。这里只用它的秒数，截的是原录音。
2. 从前往后找第一截 10 到 20 秒的：可以是一段，也可以是相邻几段连起来（从前一段的 `startSec` 到后一段的 `endSec`，中间的停顿照留）。截的两头和中间都不能是 `forced`；连起来的每处停顿（前段的 `endSec` 到后段的 `startSec`）不超过 1.5 秒，超过的不连。
3. 一截都找不到的，问使用者用哪一段（哪一秒到哪一秒，或者他截一段交来），不自己猜。
4. 截下来，写到 `audio/<段名>.wav`（只在备素材时用）。录音是 WAV 的，在基础部分的目录里跑（只用 `tools/wav.mjs`，不要 ffmpeg）。录音和输出都写绝对路径（素材目录就是素材里 `audio/` 所在的那一层）：命令里的相对路径按当前目录算，会落进基础部分的目录里。`writeFileSync` 不建目录，先建好 `audio/`：

   ```
   mkdir -p <素材目录的绝对路径>/audio
   node -e "const fs = require('node:fs'); const [from, to, start, end] = process.argv.slice(1); import('./tools/wav.mjs').then(({ parseWav, encodeWav }) => { const wav = parseWav(new Uint8Array(fs.readFileSync(from))); const [a, b] = [start, end].map((sec) => Math.round(Number(sec) * wav.sampleRate)); fs.writeFileSync(to, encodeWav({ sampleRate: wav.sampleRate, samples: wav.samples.map((c) => c.slice(a, b)) })); });" <录音的绝对路径> <素材目录的绝对路径>/audio/<段名>.wav <开始秒> <结束秒>
   ```

   不是 WAV 的，要环境里有 ffmpeg：`ffmpeg -i <录音的绝对路径> -ss <开始秒> -to <结束秒> -c:a pcm_s16le <素材目录的绝对路径>/audio/<段名>.wav`。
5. 这一截不写进素材，照「库里借来的声音」克隆。

## 发新版本的细则

上一版的参考和留出录音保持原来的角色，新补的接在后面；`--drop` 去掉不要的段，`--default-segment` 换默认参考段（见「参考集和留出录音」）。段名不能和上一版重复，去掉的也不行：去掉了 `intro`，新版本就不能再叫 `intro`。

验证记录不带过来：这一版重新量，没量出来就没有。什么都没变，命令报 `make_pack_nothing_changed` 并且不发版本。包里记下做包时用的基础部分版本（`--base-version`，默认取这份基础部分自己的），不记来源包。

## 读音词表

**读音词表**：`--lexicon <文件.pls>` 放 W3C PLS 格式的读音词表，只换要说的话里的词，台本标记原样保留。两种写法：`<alias>` 用别的写法替换要念的词（所有适配器都生效）；`<phoneme>` 标音素，字母表名必须是 `x-pinyin`（PLS 规定非 `ipa` 的字母表要用 `x-` 开头的名字；适配器把它译成自己服务的写法），词条只能是汉字，`ph` 是拼音加数字声调：每个汉字一个音节，声调 1 到 5（5 是轻声），音节用空格分开，个数和词里的汉字数相等（`银行` 写 `yin2 hang2`）；拼音里的 ü 写成 `v`（`lü3` 写成 `lv3`）。词条写整词：词条按字面在台词里找，写单字（例如「曾」）会连带改掉含这个字的每个词，「曾经」「不曾」也会念成 zēng。例子：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<lexicon version="1.0" xmlns="http://www.w3.org/2005/01/pronunciation-lexicon" alphabet="x-pinyin" xml:lang="zh-CN">
  <lexeme><grapheme>曾小雨</grapheme><phoneme>zeng1 xiao3 yu3</phoneme></lexeme>
  <lexeme><grapheme>银行</grapheme><phoneme>yin2 hang2</phoneme></lexeme>
  <lexeme><grapheme>Mira</grapheme><alias>Meera</alias></lexeme>
</lexicon>
```

音素只在环境声明了 `phoneme-in-text` 的时候才用；哪些环境声明它、在哪些能力上有效、没测过的范围，看所用适配器的说明。没有声明的环境，音素一律报在 `lexicon.unapplied`（`reason` 是 `phoneme`），和没有拼音这一项时一样；声明了的环境里，音节数或写法对不上的报 `phoneme_format`（`problem` 是 `term`、`count` 或 `form`）；其他字母表（例如 `ipa`）照旧不用。

## 骨架的语言

**骨架的语言**：做出来的包里 `SKILL.md` 的骨架（各节的标题和说明）默认是中文；给英文作者做英文包，加 `--text-language en`（只有 `zh`、`en` 两个值，别的是用法错误，退出 2）。只管骨架：「## 配音指引」这一行所有语言都一样，`--name`、`--guidance`、`--direction` 里写的字原样放进包，不翻译；任何语言的包，读回来的指引都一样。发新版本用这一次给的语言，不看上一版是什么语言。规则的正本是 `protocol/FORMAT.md` 的「骨架的语言」。

## 完整包

**完整包**：给了 `--base <基础部分目录>` 就放进 `voice-pack/`，不给就只有角色部分（带协议核心 `protocol/`）。资源默认放进包里，片段写了 `externalUrl` 才记成外部资源（清单里只有网址、大小、哈希）。增强件的细则在 `references/make-pack-details.md`「增强件」。

## 分享文件

**分享文件**：做包时加 `--share-file <分享文件>`，包写出来以后再打一份 `.voicepack.zip`，里面带预览卡片（`index.html`）。卡片上「在 X 里打开」和「做一个你自己的」两个入口由接进来的适配器给出（适配器背后的产品提供），命令不自己造链接；没有适配器给，卡片上就没有入口。这一步不验签，分发之前用 `check` 查一遍。
