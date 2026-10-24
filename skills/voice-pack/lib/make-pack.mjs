// SPDX-License-Identifier: Apache-2.0
//
// 做包（流程层）：作者交来一组切好的片段（每段一个音频加它说的话），做包流程把它们整理成一个角色部分：
// 筛片段、打标签、挑出参考集和留出录音、做出包，再试合成、量还原度、提示还缺什么素材。
// 参考集、留出录音怎么挑，规则在 lib/pack-material.mjs 的文件头。
// 库不碰文件系统：音频是字节，写成文件、把文件读成字节是命令行层的事（cli/commands/make-pack.mjs）。
//
//   const { pack, report } = await makePack(env, input, options);
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
//         audio,        必填。{ bytes: Uint8Array, mimeType: 'audio/…' }（protocol/lib/audio-clip.mjs）。库不收路径、网址：路径是命令行层读成字节的
//         text?,        这段录音里说的原话（逐字文本）。可以不给、给空串或 null：就是「没有文本」，环境有 automatic-speech-recognition 时转写，
//                       没有就不能用（report 里写 no_text）。没有文本的片段当不了参考，也当不了留出录音
//         labels?,      调用方已经知道的标签 { language?, emotion?, style?, energy? }。给了的就是定下来的，不再判断；没给的（undefined）由流程来定：
//                       语言来自转写（没有就从文字本身认），情绪、风格让 audio-text-to-text 听着打，能量靠计算（响度跟这一组的中位数比）。
//                       值是 null 表示「明确没有」，不去判断（例如 style: null 就是没有风格标签）。language 不能是 null
//         source?,      这段是从哪来的 { recording?: 来源录音的名字, startSec?, endSec? }（切段那一步留下的）。只放进报告，不进包
//         externalUrl?  明确选了外部资源：这段音频不放进包，清单里只记这个 https:// 网址、大小和哈希（资源默认放进包里）
//       }
//     ],
//     labels?,          给所有片段的默认标签（片段自己的 labels 盖过它），写法同上；常用的是 { language: 'en' }
//     direction?,       配音指引里的结构化部分 { description?, tags?, scenes? }：tags 只能从设计词表（vocab/design.json）里选，scenes 从场景词表（vocab/scenes.json）选；
//                       写法按 lib/design-vocab.mjs 换成规范的（中文名和别名也认，清单里存的是规范写法），不在词表里的报 make_pack_input_invalid（field 是 direction.tags[1] 这样的路径）
//     guidance?,        配音指引的正文（Markdown），放进 SKILL.md 的最后一节
//     sampleLines?,     示例台词：字符串数组，原样写进清单的 sampleLines（规则见 protocol/FORMAT.md 4.4 节：最多 50 条，每条 1–500 个字符，不能只有空白；台词里可以带舞台提示，例如（耳语））。
//                       不是数组报 make_pack_input_invalid（field 是 sampleLines）；条数、长度、空白由清单检查在花钱之前报（试装，manifest_invalid）。空数组等于没写
//     designSource?,    设计来源 { description?, model?, modelVersion?, date? }：设计出来的声音、默认音色、融合出来的声音做包时写
//     files?,           角色部分的其他文件 Map<路径, Uint8Array>：读音词表 lexicon.pls、脚本、增强件……原样放进包里
//     scripts?, enhancers?   清单里登记的脚本和增强件；增强件只保证格式上能放（见下），做包不做训练
//     notes?,           前面几步（分离、切段、转写）留下的说明 [{ code, message, details? }]，原样放进报告，例如「这次没做分离，输入要是干净的人声」。details 是这条说明说的那些事实
//                       （message 里的数和名字），没有就不给；库自己给的说明都带着（lib/long-recording.mjs、lib/make-pack-loudness.mjs 的文件头写了每个 code 的 details）
//     environment?,     验证记录里「在哪个环境测的」写什么；不给就用 options.environment
//     defaultSegment?   明说哪一段当默认参考段（必须是参考集里的一段）；不给就按 lib/pack-material.mjs 的规则挑，发新版本时沿用上一版的
//
//     发新版本（给了 previous）时，另外这几项；规则的正本在 lib/pack-version.mjs 的文件头：
//     previous?,        上一版的角色部分文件 Map<路径, Uint8Array>。给了就是发新版本：包 ID 不变，版本号往上加，上一版的参考和留出录音原样带过来（保持原来的
//                       角色），segments 是新补的素材（可以是空数组：只改指引、只换参考也能发）。上一版有外部资源的话，要取回来核对，环境得有 fetch
//     version?, bump?   新版本号：明说的（要比上一版大），或者按 major、minor、patch 往上加（默认 minor）。没有 previous 时 version 是第一个版本的版本号（默认 1.0.0），bump 不能给
//     changelog?        变更说明（至少一个字符，最长 CHANGELOG_MAX，读自清单 schema，见 lib/pack-version.mjs）；不给就按变化生成一份：库自己写的是中文的，调用方要别的写法，给 options.describeChanges
//     drop?             上一版里不要了的参考或留出录音的名字 [id]
//     name 可以不给（沿用上一版的）；guidance、direction、sampleLines、designSource、scripts、enhancers、features、requires、files 给了就换掉上一版的（files 按路径合并；sampleLines 给空数组就是去掉），没给就沿用
//   }
//
// options（都可选）：
//   random          () => [0, 1) 的随机数，盲听的顺序用它（测试注入固定的）；省略用 Math.random
//   idRandom        (长度) => Uint8Array，包 ID 的随机字节（测试注入）；省略用 crypto.getRandomValues
//   now             () => Date，验证记录的日期
//   environment     验证记录里的环境名，例如适配器的名字（命令行上是 cli/adapters.mjs 的 environmentName）
//   holdoutRatio, maxHoldout, maxReferences, minHoldoutTokens, maxSynthesisChars   挑素材的参数，默认值和规则见 lib/pack-material.mjs
//   thresholds      音质检查的阈值（tools/audio-quality.mjs 的 judgeReference 的写法），省略用默认
//   loudness        调响度（规则在 lib/make-pack-loudness.mjs 的文件头）：省略或 true 用默认目标，false 不调，{ targetLufs?, peakCeilingDbfs?, limiter? } 改目标、上限和限幅器（limiter: false 关掉限幅器，回到只加增益；{ maxDb } 改最多压多少 dB）。写错抛 make_pack_input_invalid（field 是 loudness）
//   concurrency     调能力的并发数，1–8，默认 2
//   describeChanges (changes, { name }) => string：发新版本、作者又没写变更说明（input.changelog）时，用它把这次的变化写成一句话；调用方要别的语言、别的写法时给。不给就用
//                   lib/pack-version.mjs 的 changelogOf（中文，命令行就是这样）。changes 是 diffVersions 的结果（形状见 lib/pack-version.mjs，只读），name 是这一版的名字；可以是异步函数。
//                   返回值去掉两头空白，超过 CHANGELOG_MAX 个字符的截断、末尾加「…」（库自己写的也是这样）；不是字符串、或者是空白，抛 make_pack_input_invalid（field 是 describeChanges）。
//                   选项本身不是函数，在入口就抛同一个错；返回值要等挑完素材、算出变化以后才看得到，所以返回值写错是在转写、打标签之后才报。
//                   作者写了变更说明、第一个版本、什么都没变（不发新版本）时不调它；报告里 changelogSource 仍是 'generated'
//   maxErrorRate    收音校验的上限，省略用 lib/fidelity.mjs 的 DEFAULT_MAX_ERROR_RATE
//   retryWait       (毫秒) => Promise：转写、打标签暂时出错、再试之前等多久（每段最多问 3 次，等 5 秒、15 秒，规则的正本是 lib/call-attempts.mjs）；不给就真的等。
//                   app 传一个按「取消」就停的，测试传一个马上返回的。不是函数，在入口就抛 make_pack_input_invalid（field 是 retryWait）
//   textLanguage    包里 SKILL.md 骨架（各节的标题和说明）用的语言：'zh'（省略就是它）或 'en'，调用方按作者的语言给（app 里是作者做包时的界面语言，命令行是 --text-language）；
//                   试装和正式装、第一个版本和发新版本都用这一次给的，发新版本不看上一版是什么语言。别的值抛 make_pack_input_invalid（field 是 textLanguage），在花钱之前。
//                   只管骨架：「## 配音指引」这一行所有语言都一样，作者写的名字、指引、描述、变更说明原样放进去，不翻译（规则的正本是 protocol/FORMAT.md「骨架的语言」）
//   evaluate        false 就不试合成、不量还原度（默认 true）
//   dryRun          true 就只做不花钱的几步（筛片段、查哪些能用），不调任何所需能力，不做包；返回 { plan, report }
//   onPlan          (plan) => void：不花钱的几步做完、第一次调所需能力之前交给它；plan.calls 是各项能力最多要调多少次。它抛错就停，什么都不调
//
// ---------------------------------------------------------------- 返回
//
//   { pack: { id, manifest, files }, report }
//   pack      packRolePart 的结果（protocol/lib/pack.mjs）：files 是包目录里的全部文件，含清单、SKILL.md、protocol/，给了 base 还有 voice-pack/
//   report    { segments, counts, plan, steps, trial, fidelity, redo?, verification, hints, notes, version?, defaultSegment }
//             defaultSegment { id, rule, typicality?, tied?, unmeasured? }：默认参考段和挑它的规则（'author' | 'previous' | 'typical' | 'priority' | 'only'，规则 5）；
//             rule 是 'typical' 时 typicality 是每段候选和其余参考的平均相似度，tied 是和最典型的那段差不多的几段（按优先级）；
//             unmeasured 是量相似度时抛了错、这一次退回按优先级的：{ capability, error: 错误的摘要（summarizeError：code、message、details） }，没有这种情况就没有这个字段
//             segments 每一段的去向（参考、留出录音、没用上和原因；发新版本时还有 dropped）、标签和标签的来源、调响度的情况（loudness）；counts 数量；plan 各项能力最多调几次；
//             steps 转写、打标签、调响度、试合成各一步的情况；trial 试合成；fidelity 还原度（读法的正本是 lib/fidelity.mjs 的文件头）；
//             redo 有「没听成」的盲听时，按 planRedo 说明补做要调几次；verification 写进清单的那一条验证记录（没量出来是 null）；
//             hints 还缺什么素材（lib/material-hints.mjs）；notes 前几步留下的说明（input.notes），后面接着调响度这一步留下的；
//             version 发新版本时才有：{ previous, next, bump, changelogSource: 'author' | 'generated', changes, verification: { status, droppedFromPrevious } }
//   evaluation  量还原度用的那一批数据（参考、留出录音、合成出来的录音），补做「没听成」的盲听时要用；没量就是 null
//
// 抛出的错误（VoicePackError；code 小写下划线，details 里放什么在抛出处写明）：
//   make_pack_input_invalid     输入不合约定。details.field 是出问题的字段（segments[2].audio、labels.energy……），details.problem 说哪里不对
//   make_pack_no_material       没有一段能用，做不出包。details.unused 是没用上的原因和条数（{ no_text: 2, quality_rejected: 1 }）
//   make_pack_nothing_changed   发新版本，却和上一版比什么都没变（新补的素材没一段用得上、别的也没改）。details: { previous, unused }，不发空的新版本
//   make_pack_version_invalid   明说的版本号不比上一版大。details: { previous, version }
//   make_pack_previous_invalid  上一版读不了。details.reason 见 lib/pack-version.mjs 的文件头
//   make_pack_trial_mismatch    试合成规划出的段数和留出录音的条数不一样（配音把某条留出录音的文本切成了几段，或者合并了），没法把合成的音频和留出录音一条对一条地比：
//                               做包停下来，不拿对不上的东西去量还原度。details: { holdouts, units }
//   capability_result_invalid   转写（automatic-speech-recognition）的返回不合约定：不是 { text: 字符串, … }。details: { capability, problem }。
//                               别的能力的返回不合约定也是这个 code；都抛在各自的模块里（lib/make-pack-transcribe.mjs、lib/dub.mjs、lib/fidelity.mjs、lib/segment-tags.mjs）
//   另外 pack_invalid、manifest_invalid 来自 protocol/lib/pack.mjs；所需能力自己抛的错原样往上传（401 之类要让调用方看见），
//   服务暂时出错（details.transient）的那一项记在报告里，不让整件事作废。上一版的文件和它自己的清单对不上（file_modified、external_hash_mismatch……）
//   来自 lib/voice-pack.mjs（读上一版时用 verify: true），原样抛出：不在被改过的东西上发新版本。
//
// 用到的所需能力和运行时（签名都只写在 vocab/capability-signatures.md，这里不抄；缺了，只有用到它的那一步跳过，报告里写明）：
//   @capability automatic-speech-recognition  没有文本的片段转写成文本；缺了，没有文本的片段没法补文本，不能用（no_text）。
//                                  转写暂时出错（details.transient 为 true）先重试，每段最多转写 3 次（lib/call-attempts.mjs），试满了还没成才记成 transcription_failed，那一段用不上；别的错原样往上传，不重试
//   @capability audio-text-to-text 给录音打情绪、风格标签（lib/segment-tags.mjs）和盲听（lib/fidelity.mjs）；缺了，不打标签（参考集只有语言和能量标签），盲听量不了。
//                                  打标签暂时出错（details.transient 为 true）也先重试，每段最多问 3 次（同一条规则），试满了还没成才记成「没听成」（steps.tagging.notHeard，这一段没有情绪、风格标签，仍在包里）；
//                                  被服务商拦下（provider_blocked）、回答不是固定格式记作废，不重试；别的错原样往上传。盲听出错不在这里重试（lib/fidelity.mjs 有自己的补做）
//   @capability voice-cloning      试合成留出录音（走 lib/dub.mjs）；缺了不能试合成，所以不量还原度
//   @capability style-instruction  可选：环境声明有它，试合成才把配音指引通过 instructions 传给模型（lib/dub.mjs）；没有不是错误。试合成不用 text-generation：lib/make-pack-trial.mjs 的 envForTrial 把它去掉
//   @capability speaker-verification  说话人相似度、真人基线（lib/fidelity.mjs）；缺了说话人相似度量不了（盲听照做）。挑默认参考段也用它（lib/make-pack-pick.mjs）：
//                                  有它，默认段挑和其余参考平均最像的那一段（参考之间两两量，留出录音不量）；没有，就按优先级挑，报告的 defaultSegment.rule 写着是哪条。
//                                  量的时候抛的错（不是 no_speech）不往上传：这一次的默认段退回按优先级，报告的 defaultSegment.unmeasured 写明错误，做包接着做；
//                                  调用方中止（AbortError）和凭据被拒（401，或 details.halted）照旧往上传
//   ffmpeg（运行时，签名在 tools/audio-decode.mjs）  解不了 WAV 以外的音频：那一段不做音质检查、不算能量，也不调响度，按「没量过」处理
//
// ---------------------------------------------------------------- 流程，和各步的模块
//
// makePack 只管次序，一步一步调下面的模块；每一步的规则、读写条目的哪些字段、抛哪些错误，写在那一步的模块的文件头里（一个模块只为一件事改动，规则只在那里写一遍）：
//   读输入和选项      lib/make-pack-input.mjs       输入和选项写错了，在花钱之前报 make_pack_input_invalid
//   筛片段（不花钱）   lib/make-pack-screen.mjs      认格式、查重、量音质
//   试装、规划（不花钱） lib/make-pack-assemble.mjs、lib/make-pack-plan.mjs   试装一遍；算各项能力最多调几次（plan）；onPlan 和 dryRun 在这里
//   转写             lib/make-pack-transcribe.mjs  没有文本的片段转写成文本
//   打标签           lib/make-pack-tags.mjs        语言、情绪、风格、能量
//   挑参考           lib/make-pack-pick.mjs        参考集、留出录音、默认参考段（挑的规则在 lib/pack-material.mjs）
//   发新版本          lib/pack-version.mjs          读上一版、版本号、和上一版比、变更说明
//   调响度           lib/make-pack-loudness.mjs    写进包里的参考和留出录音统一到同一个响度（「调响度」的规则在它的文件头）
//   装包             lib/make-pack-assemble.mjs    把素材装成角色部分
//   试合成和还原度     lib/make-pack-trial.mjs       合成留出录音，量还原度，写验证记录
//   报告             lib/make-pack-report.mjs      每一段的去向、dryRun 和最后的 report 怎么写
// 每一段在流程里是一个条目（item）：各步读它、写它，条目有哪些字段，见 lib/make-pack-input.mjs 的文件头和各步的文件头。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { DEFAULT_MAX_ERROR_RATE } from './fidelity.mjs';
import { readPreviousVersion, nextVersion, effectiveOf, assertSomethingNew, releaseChanges } from './pack-version.mjs';
import { assertInput, readInput, readOptions, materialOptionsOf } from './make-pack-input.mjs';
import { screen } from './make-pack-screen.mjs';
import { transcribe, settleText } from './make-pack-transcribe.mjs';
import { resolveLanguages, tagAll, assembleTags } from './make-pack-tags.mjs';
import { assertDefaultUsable, pickMaterial } from './make-pack-pick.mjs';
import { adjustLoudness } from './make-pack-loudness.mjs';
import { preflight, placeMaterial, assembler } from './make-pack-assemble.mjs';
import { evaluatePack, verificationOf } from './make-pack-trial.mjs';
import { buildPlan } from './make-pack-plan.mjs';
import { dryRunOf, resultOf } from './make-pack-report.mjs';

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
  const { items, version, direction } = readInput(input, previous);
  // 版本号先定下来：明说的不对，在花钱之前就报
  const versionNumber = previous === null ? version.version : nextVersion(previous.version, { version: version.version, bump: version.bump });
  const effective = effectiveOf(input, direction, previous);
  const fresh = items.filter((item) => item.previous === undefined);
  const concurrency = settings.concurrency ?? 2;
  const maxErrorRate = settings.maxErrorRate ?? DEFAULT_MAX_ERROR_RATE;
  const materialOptions = materialOptionsOf(settings);
  const steps = {};

  // 不花钱的几步：筛片段，查出花钱之前能查出的问题，试装，规划
  await screen(env, items, { thresholds: settings.thresholds, loudness: settings.loudness });
  assertDefaultUsable(items, version.defaultSegment);
  if (previous !== null) await assertSomethingNew(previous, { effective, items, fresh, defaultSegment: version.defaultSegment }); // 花钱之前先看一眼：新补的素材一段都用不上、别的也没改，就不用往下做了
  const context = { effective, input, previous, versionNumber, changelog: version.changelog, textLanguage: settings.textLanguage };
  await preflight(items, context);
  const plan = buildPlan(env, items, settings, materialOptions);
  if (settings.dryRun === true) return dryRunOf({ plan, items, fresh, previous, versionNumber, steps, notes: input.notes });
  await settings.onPlan?.(plan); // 花钱之前：不花钱的几步都做完了，调用方在这里说明费用，抛错就停

  // 转写和打标签（调所需能力）
  steps.transcription = await transcribe(env, items, { concurrency, wait: settings.retryWait });
  settleText(items);
  resolveLanguages(items);
  steps.tagging = await tagAll(env, items, { concurrency, maxErrorRate, wait: settings.retryWait });
  assembleTags(items);

  const { chosen, roleOf } = await pickMaterial(env, items, { previous, version, materialOptions });
  // 发新版本：这一版比上一版变了什么（什么都没变就不发；变更说明作者没写就按这个生成）
  const { changes, changelog } = await releaseChanges(previous, { effective, chosen, fresh, changelog: version.changelog, describeChanges: settings.describeChanges });

  const byId = new Map(items.map((item) => [item.id, item]));
  // 调响度：量音质、算能量、打标签都是照原始音频做的，到这里才把要写进包里的参考和留出录音统一响度。后面写进包、试合成、量还原度用的都是调过的这份
  const loudness = await adjustLoudness(env, [...chosen.references, ...chosen.holdouts].map((id) => byId.get(id)), settings.loudness);
  steps.loudness = loudness.step;
  const material = placeMaterial({ chosen, byId, effective });
  const assemble = assembler({ context, changelog, material, idRandom: settings.idRandom });

  let made = await assemble();
  const evaluated = await evaluatePack(env, made, byId, { enabled: settings.evaluate, concurrency, maxErrorRate, random: settings.random, externals: material.externals });
  steps.trial = evaluated.trial;
  const verification = verificationOf(evaluated.fidelity, { environment: input.environment ?? settings.environment ?? 'unspecified', models: evaluated.trial.models ?? [], now: settings.now ?? (() => new Date()) });
  if (verification !== null) made = await assemble({ id: made.id, verification: [verification] });

  return resultOf({ made, evaluated, verification, items, fresh, chosen, roleOf, previous, version, changes, effective, byId, plan, steps, inputNotes: input.notes, loudnessNotes: loudness.notes });
}

export { DEFAULTS as MATERIAL_DEFAULTS } from './pack-material.mjs';
