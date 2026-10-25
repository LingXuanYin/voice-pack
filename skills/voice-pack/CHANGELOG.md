# Changelog / 更新记录

Each version of the base part, newest first. The top entry is the version in `manifest-fields.json`; the release notes on GitHub are the entry of that version.
基础部分每个版本改了什么，新的在前。最上面一条就是 `manifest-fields.json` 里的版本；GitHub 上的发布说明取该版本这一条。

Versions 1.0.0 to 1.0.9 were released under the product's earlier names (the skill was `cohub-voice-studio`, the release files `cohub-voice-studio-<version>.voicepack.zip`), except 1.0.3, which was never published: what it changed first shipped in 1.0.4. The published files keep those names and stay in the version index.
1.0.0 到 1.0.9 是用产品原来的名字发的（skill 叫 `cohub-voice-studio`，发布文件叫 `cohub-voice-studio-<版本>.voicepack.zip`），只有 1.0.3 没有发布过：它改的东西第一次发出去是在 1.0.4。发布过的文件名不变，仍然列在版本索引里。

## 2.0.4 — 2026-10

A voice model can have a shortest text it will speak. Where the environment declares one (the Cohub adapter: 15 characters), a dub no longer stops at a short line: adjacent short lines of the same voice, reference and speed, with no pause between them, are spoken as one; a line that is still too short is marked failed without calling the model, and the other lines go on. A trial synthesis leaves out a held-out recording that is too short: it is not synthesized, measured or billed, and the report says why. The cost plan counts only the calls that will be made.
语音模型可以有它能说的最短文字。环境声明了（Cohub 适配器：15 个字）的，配音不再因为一句短话停下：同一个声音、同一个参考、同一个语速，中间没有停顿的相邻短句并成一段念；并完还短的那一段记成没做，不调用模型，别的句子照常做。试合成里文字太短的留出录音不合成、不量、不算费用，报告里写明原因。确认费用只算真正会调用的次数。

- **A dub joins short lines, and marks one still too short as failed.** A line shorter than the minimum is joined with the next line when they share the reference and the stage-direction text, have the same speed, have no pause or inline join between them, and stay within `maxChars`. A joined unit lists the lines it holds (`joined`). A unit still too short is `failed` with the code `text_too_short`, is not sent, and is not a temporary error, so `--only` does not retry it. / **配音把短句并起来，并完还短的记成失败。** 比下限短的一句，和后面的一句共用同一个参考、同一段说明、同一个语速，中间没有停顿和行内标签，并起来不超过 `maxChars` 的，就并成一段（`joined` 写明并了哪几句）。并完还短的那一段记成 `failed`，错误码 `text_too_short`，不发给模型；它不是暂时出错，`--only` 重做没有用。
- **Trial synthesis leaves out a held-out recording that is too short.** It is not synthesized, not measured and not billed; `trial.items` gives it `status: 'skipped'`, `reason: 'too_short'`, its length and the minimum, apart from temporary errors and voided clips. / **试合成不合成文字太短的留出录音。** 不合成、不量、不算费用；`trial.items` 里它的 `status` 是 `skipped`，`reason` 是 `too_short`，写明字数和下限，和暂时出错、作废分开。
- **The minimum is declared by the environment.** An adapter gives `limits.minChars` (the Cohub adapter reads `minTextChars` of `voice-cloning` in its `capability-map.json`); `dub` and `make-pack` read it, and `adapter check` accepts it. Without it nothing changes. / **下限由环境声明。** 适配器给 `limits.minChars`（Cohub 适配器从对照表 `capability-map.json` 的 `voice-cloning` 的 `minTextChars` 读）；`dub`、`make-pack` 读它，`adapter check` 认它。没有的，什么都不变。
- **The cost plan counts only the held-out recordings that can be synthesized.** `plan.calls` and `plan.extraCalls` leave out the ones below the minimum; the count is still an upper bound, since the held-out recordings are picked after the plan. / **确认费用只算能合成的留出录音。** `plan.calls` 和 `plan.extraCalls` 不算不够下限的那几条；仍然是上界，因为留出录音是规划之后才挑的。

## 2.0.3 — 2026-10

Trial synthesis now tries a temporary service error again, as transcription and tagging do: up to 3 tries for each held-out recording, waiting 5 s and then 15 s before the next try, with the extra tries counted in the confirm-cost line. Before fidelity is measured, each synthesized clip is checked: a clip that is almost all silence, or whose length is more than twice, or less than half, that of its held-out recording of the same sentence, is voided. A voided clip is left out of the ratio and reported with its reason and the measured numbers.
试合成碰到服务暂时出错，现在会像转写、打标签一样再试：每条留出录音最多试 3 次，第 2 次之前等 5 秒，第 3 次之前等 15 秒；多出来的次数也写进确认费用。量还原度之前先检查合成出来的每一句：几乎全是静音，或者时长超过同一句的留出录音的两倍、不到它的一半，就作废。作废的不进比值，报告里写明是哪一句、为什么，以及量到的静音占比和时长。

- **Trial synthesis tries a temporary service error again.** Up to 3 tries for each held-out recording (`lib/call-attempts.mjs`); the extra tries are in `plan.extraCalls` and in the confirm-cost line. A recording that still fails after 3 tries stays in `trial.failed`, out of the evaluation. / **试合成暂时出错，会再试。** 每条留出录音最多 3 次（`lib/call-attempts.mjs`）；多出来的次数在 `plan.extraCalls` 里，确认费用那一行也写。试满 3 次还是出错的，仍记在 `trial.failed` 里，不进评测。
- **A synthesized clip is checked before its fidelity is measured.** Silence above 60% of the clip, or a length more than twice or less than half that of the same sentence's held-out recording, voids it (`checkSynthesized` in `lib/make-pack-trial.mjs`). Voided clips are not in the ratio and are reported one by one; when all are voided the fidelity is not measured, with the reason `generated_voided`. A clip the environment cannot decode is not checked and is measured as before. / **量还原度之前先检查合成出来的每一句。** 静音占比超过六成，或者时长超过同一句的留出录音的两倍、不到它的一半，就作废（`lib/make-pack-trial.mjs` 的 `checkSynthesized`）。作废的不进比值，逐条报告；全部作废时还原度没量，原因是 `generated_voided`。环境解不开的不查，照旧量。

## 2.0.2 — 2026-10

A dub no longer stops when the judge's answer cannot be used: those lines fall back to the default reference and the report says which. And when the environment can measure speaker similarity, the default reference segment (the one lines without a stage direction are spoken with) is now the segment most like the person's other references; before, it was the first by quality, length and order, whatever it sounded like.
判断台词怎么说的回答不能用（没有文字，或者没有正常结束）时，配音不再停下：这几句落到默认参考，报告里写明是哪几句。环境能量说话人相似度的时候，默认参考段（不带舞台提示的台词都用它）改成和这个人的其他参考平均最像的那一段；以前是按音质、时长、次序排第一的那段，不管它像不像这个人。

- **An empty judge answer no longer stops the whole dub.** `pickReferences` used to let the `capability_result_invalid` from `text-generation` through, so one unusable answer aborted the dub. It now records `judge.status` as `unusable` with the error, gives those lines the default reference and marks each of their picks `judgeFailed: true`; `dub.json` and the printed summary show which lines fell back. Errors that are not about the answer (401, bad input, a temporary service error) still stop the dub, as before. / **判断的回答是空的，整次配音不再停下。** 以前 `text-generation` 报的 `capability_result_invalid` 原样往上传，一句回答不能用，配音就停了。现在 `judge.status` 记成 `unusable`，写明是什么错，这几句落到默认参考，它们每一句的 `picks[i].judgeFailed` 为 true；`dub.json` 和命令行的输出里看得出是哪几句。401、输入不对、服务暂时出错照旧往上抛。
- **Text generation reports an unusable answer as `capability_result_invalid`.** An answer with no text, or one that did not end normally, is reported with the shared code and `details.capability` set to `text-generation`, and `details.problem` says which (`text_missing` or `stop_reason`). The contract is in `vocab/capability-signatures.md`, under `text-generation`. / **文字生成的回答不能用，报 `capability_result_invalid`。** 回答没有文字、或者没有正常结束，用共用的 code 报，`details.capability` 是 `text-generation`，`details.problem` 写是哪一种（`text_missing` 或 `stop_reason`）。约定写在 `vocab/capability-signatures.md` 的 `text-generation` 一节。
- **The default segment is the most typical one.** Among the calm, unstyled references of the most common language, the one whose mean speaker similarity to the other references is highest. Segments whose means differ by less than 0.01 count as about the same, and the first of them by quality, length and input order is taken. Held-out recordings are never used to choose it. Without speaker similarity the rule is as before. / **默认参考段挑最典型的那一段**：在最常见语言里平静、没有风格的参考中，和其余参考的平均说话人相似度最高的那一段。平均值相差不到 0.01 的几段算差不多，在它们里面按音质、时长、次序排第一的那段。留出录音从不参与挑选。环境没有说话人相似度的，照原来的规则。
- **The report says which rule chose the default.** `report.defaultSegment` gives `rule` (`typical`, `priority`, `only`, `author` or `previous`); for `typical` it also gives each candidate's mean similarity and the segments that count as about the same. The app makes packs by the same rule, with its on-device speaker model, which it loads before the make starts. / **报告写明默认段是按哪条规则挑的**：`report.defaultSegment` 的 `rule` 是 `typical`、`priority`、`only`、`author` 或 `previous`；`typical` 时还有每段候选的平均相似度和差不多的几段。app 做包走的是同一套规则，用它本机的说话人模型，做包开始前就载入。
- **A failed similarity measurement no longer stops the make.** An error other than a caller's abort or a rejected credential (HTTP 401) makes the default fall back to the old rule, and `report.defaultSegment.unmeasured` says why. / **量相似度出错，做包接着做。**抛了别的错（不是调用方中止，也不是凭据被拒的 401），默认段退回原来的规则，报告的 `unmeasured` 写明原因。

## 2.0.1 — 2026-10

Some mp3 files that failed to decode now decode: the temporary input file is no longer named `.bin`.
有的 mp3 原来解不开，现在能解：临时输入文件不再叫 `.bin`。

- **ffmpeg no longer guesses the format from `.bin`.** The file handed to ffmpeg is named after the container its bytes really hold (`.wav`, `.mp3`, `.flac`, `.ogg` or `.m4a`); when the container is not recognised it has no extension and ffmpeg reads the content. Before, the `.bin` name made ffmpeg read the file as binary text, and an mp3 with a long zero-padded ID3 tag failed with "Stream map '' matches no streams". The output format is still given by `-f`. / **ffmpeg 不再靠 `.bin` 后缀猜格式**：交给 ffmpeg 的文件按字节实际是什么容器起名（`.wav`、`.mp3`、`.flac`、`.ogg`、`.m4a`），认不出的不带后缀，由 ffmpeg 按内容认。以前 `.bin` 后缀让 ffmpeg 把文件当成二进制文本（bin）来读，ID3 标签后面有大段零填充的 mp3 因此报 `Stream map '' matches no streams`，解不开。输出格式照旧由 `-f` 给。

## 2.0.0 — 2026-10

The first release that installs anywhere: the base part now has its own name, its own repository and its own address, and no longer depends on any one platform.
第一个能装在哪里都行的正式版：基础部分有了自己的名字、自己的仓库和自己的地址，不再依赖某一个平台。

- **New name: `voice-pack`.** The skill, its directory and the release files (`voice-pack-<version>.voicepack.zip`) all use it. / **新名字 `voice-pack`**：skill、它的目录、发布文件（`voice-pack-<版本>.voicepack.zip`）都用这个名字。
- **Two ways to install.** Any agent: `npx skills add LingXuanYin/voice-pack`. Claude Code: `/plugin marketplace add LingXuanYin/voice-pack`, then `/plugin install voice-pack@voice-pack`. / **两种装法**：别的 agent 用 `npx skills add LingXuanYin/voice-pack`；Claude Code 用 `/plugin marketplace add LingXuanYin/voice-pack`，再 `/plugin install voice-pack@voice-pack`。
- **Decoupled from any platform.** The only official adapter is `process`, which talks to your own program over standard input and output. An adapter for any other service lives in its own directory and plugs in with `--adapter <directory>`. / **和平台解耦**：官方的适配器只剩 `process`，它经标准输入输出和你自己的程序说话；别的服务的适配器放在它自己的目录里，命令行上用 `--adapter <目录>` 接进来。
- **Protocol 2.0.** The base part directory inside a pack is named `voice-pack`, and the share file's type identifier is `application/vnd.voice-pack+zip`. New packs are written this way. Programs that speak protocol 1.0 refuse a 2.0 pack at their version check. / **协议 2.0**：包里基础部分的目录叫 `voice-pack`，分享文件的类型标识是 `application/vnd.voice-pack+zip`，新做的包都这样写；只认协议 1.0 的程序读 2.0 的包，会在版本检查那里拒绝。
- **Old packs still work.** A 1.x pack (base part directory `cohub-voice-studio`, type identifier `application/vnd.cohub.voicepack+zip`) is read as before: it is checked, read, completed and unpacked, with its signature verified as before. When it needs a 1.x base part that is not on your machine, that version is fetched from the official address and verified against the official signature, as before. / **老包照常能用**：1.x 的包（基础部分目录 `cohub-voice-studio`，类型标识 `application/vnd.cohub.voicepack+zip`）照旧读：能检查、读、补全、拆开，签名照样验。需要的 1.x 基础部分你机器上没有时，照旧从官方地址取，用官方签名验过。
- **New official address:** `https://lingxuanyin.github.io/voice-pack/releases/`. The signed files of the published 1.x versions (1.0.0 to 1.0.9, except 1.0.3, which was never published) are carried over unchanged and stay in the version index; the public key is the same. The old address keeps working for programs already installed. / **官方地址换了**：`https://lingxuanyin.github.io/voice-pack/releases/`。已发布的 1.x 版本（1.0.0 到 1.0.9，没有 1.0.3，它没有发布过）的签名文件原样搬过来，仍然列在版本索引里，公钥没变；老地址照旧在，给已经装在外面的老版本用。
- **Tagging survives a hiccup.** While making a pack, when the listening model fails with a temporary error on a segment, that segment is tried again (at most 3 times, after 5 s and then 15 s) instead of being left without tags. The extra tries are counted in the cost you agree to before the first call. An answer the provider blocks is still not retried. / **打标签碰上暂时出错不再丢标签**：做包时，听者在某一段上暂时出错，这一段会再试（最多 3 次，第 2、3 次之前等 5 秒、15 秒），不再直接没有标签；多试的次数算在开始前请你确认的费用里。被服务商拦下的回答照旧不重试。

## 1.0.9 — 2026-10

- Transcription retries inside the same make: a segment is transcribed at most 3 times when the failure is temporary (after 5 s, then 15 s). Only after the third failure is it recorded as failed. The cost note and the dry-run plan show the cap on extra calls. / 做包时转写在同一次里重试：暂时出错的段最多转写 3 次（第 2、3 次之前等 5 秒、15 秒），第三次还失败才记成失败；费用说明和试运行的计划里写出多试次数的上限。

## 1.0.8 — 2026-10

- `adapter check --live` now also tries voice design once, with a fixed audition text and a short description. / `adapter check --live` 现在也会试一次声音设计（固定的试音文字和一句简短描述）。
- The check's skip reasons are told apart: "the signature table has no entry" and "this checker is not wired to it" are two different reasons, each with its own sentence. / 检查跳过的原因分开说：「签名表里没有这一项」和「检查器没接上这一项」是两个原因，各有一句话。

## 1.0.7 — 2026-10

- Documentation only: the product reference names where the voice design limits are written. / 只改文档：产品说明里写明声音设计的限制记在哪个文件。

## 1.0.6 — 2026-10

- Voice design is a capability the adapter provides, with its limits written down; the docs and the live check follow. / 声音设计成为适配器提供的一项能力，限制写明了；文档和实机检查跟着更新。

## 1.0.5 — 2026-10

- Screening new recordings against a voice's existing pack no longer holds the page for over a second on a long recording: the loop gives the browser a breath about every 50 ms. Results and order are unchanged. / 给已有音色包的声音加新素材时，查重不再让页面在长录音上卡住一秒多：循环大约每 50 毫秒让浏览器喘一口气，结果和顺序不变。

## 1.0.4 — 2026-10

- Also carries the change listed under 1.0.3 below: 1.0.3 was never published on its own. / 也带着下面 1.0.3 条目里的改动：1.0.3 没有单独发布过。
- The scene vocabulary's ids are now part of what a published version promises: later versions may add scenes but never remove, rename or move an id, because packs and community records store them. The names shown to people may still change. / 场景词表的 id 成了发布版本的承诺：以后的版本可以加场景，但不会删除、改名或挪动 id，因为包和社区记录里存着它们；给人看的名字仍然可以改。
- The recording quality check judges silence and quietness against the recording's own loudness, so a clean recording made quietly is no longer flagged and a loud, noisy one no longer passes. A new signal-to-noise figure, `snrDb`, comes with the codes `snr_low` (under 12 dB) and `snr_too_low` (under 6 dB), which replace `loudness_low` and `loudness_too_low`. The `quality` command prints `snrDb`, and the make-pack report keeps it for every segment. / 录音质量检查改按录音自身的响度判断静音和太轻：安静录下的干净录音不再被标出来，响而嘈杂的也不再放过。新加信噪比 `snrDb`，配两个代码：`snr_low`（低于 12 dB）和 `snr_too_low`（低于 6 dB），替掉 `loudness_low` 和 `loudness_too_low`。`quality` 命令打出信噪比，做包报告每段都记着它。
- When the model's provider blocks an answer (its content filter replies with its own notice), the answer is reported as blocked (`provider_blocked`) instead of "not in the fixed format". Blocked answers are not retried. Fidelity counts them apart among the voided ones, and make-pack's tagging line tells them from unreadable answers. / 模型的服务商拦下回答时（它的内容过滤回的是自己的通知），这个回答报成被拦下（`provider_blocked`），不再报「不是固定格式」。被拦下的不重试。还原度在作废的里面单独数出被拦下的，做包的打标签那一行把它们和读不懂的回答分开。
- A role part's `SKILL.md` skeleton can be written in English: `make-pack --text-language en`, or `seal --text-language en` (the library option is `textLanguage`). Chinese stays the default, byte for byte what it was. The guidance marker is the same in every language, so earlier base parts read an English pack's guidance too. / 角色部分的 `SKILL.md` 骨架可以写成英文：`make-pack --text-language en`，或者 `seal --text-language en`（库里的选项是 `textLanguage`）。默认照旧是中文，逐字节和原来一样。配音指引的标记在各种语言里都一样，更早的基础部分也读得出英文包的指引。
- Preparing a long recording no longer holds the page while it encodes the cut segments (before, 0.4 to 1.7 s at a time): the loop gives the event loop a turn about every 50 ms. The segments' bytes, order and ids are unchanged. / 准备长录音时，编码切好的段不再让页面卡住（以前一次卡 0.4 到 1.7 秒）：循环大约每 50 毫秒让出一次。各段的字节、顺序和 id 都不变。

## 1.0.3 — not published / 没有发布过

- **Never published.** The version index has no 1.0.3 and there is no 1.0.3 file; the change below first shipped in 1.0.4 (protocol core 1.0.1). / **没有发布过**：版本索引里没有 1.0.3，也没有 1.0.3 的文件；下面这条改动第一次发出去是在 1.0.4（协议核心 1.0.1）。
- The protocol core no longer writes the base part's command-line usage into the role part's `SKILL.md`, the share file's README or its documents; they say what to do and point at the base part's `SKILL.md`, where the usage is written once. Protocol core 1.0.1. / 协议核心不再把基础部分的命令行用法写进角色部分的 `SKILL.md`、分享文件的 README 和它的文档；它们说该做什么，并指向基础部分的 `SKILL.md`，用法只在那里写一处。协议核心 1.0.1。

## 1.0.2 — 2026-10

- The rule that says which service failures are temporary has its own file, so the callers that retry share one rule. No change in behavior. / 判断哪些服务失败属于暂时出错的规则有了自己的文件，需要重试的调用方共用这一条；行为没变。

## 1.0.1 — 2026-10

- A generation task that fails at the service provider with a 5xx error (for example 502 or 504) is now treated as temporary. Before, one such failure stopped a whole dubbing run or lost the pack being made; now that one sentence is recorded as a temporary failure and the rest goes on. / 生成任务在服务商那边以 5xx（比如 502、504）失败，现在算暂时出错。以前一次这样的失败会让整个配音中断、让正在做的包写不出来；现在只把那一句记成暂时失败，其余照常。

## 1.0.0 — 2026-10

- The first signed release: the base part (flow, protocol core, vocabularies, adapter layer) published at the official address with a signed list of files and a signed version index, so any program can fetch it and verify it against the official public key. / 第一个签名的版本：基础部分（流程、协议核心、词表、适配器层）发布在官方地址，带签名的文件清单和签名的版本索引，任何程序都能取下来，用官方公钥验。
