# Changelog / 更新记录

Each version of the base part, newest first. The top entry is the version in `manifest-fields.json`; the release notes on GitHub are the entry of that version.
基础部分每个版本改了什么，新的在前。最上面一条就是 `manifest-fields.json` 里的版本；GitHub 上的发布说明取该版本这一条。

Versions 1.0.0 to 1.0.9 were released under the product's earlier names (the skill was `cohub-voice-studio`, the release files `cohub-voice-studio-<version>.voicepack.zip`), except 1.0.3, which was never published: what it changed first shipped in 1.0.4. The published files keep those names and stay in the version index.
1.0.0 到 1.0.9 是用产品原来的名字发的（skill 叫 `cohub-voice-studio`，发布文件叫 `cohub-voice-studio-<版本>.voicepack.zip`），只有 1.0.3 没有发布过：它改的东西第一次发出去是在 1.0.4。发布过的文件名不变，仍然列在版本索引里。

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
