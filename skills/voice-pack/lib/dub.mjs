// SPDX-License-Identifier: Apache-2.0
//
// 用音色包给一段台本配音（流程层）。
//   @capability voice-cloning       按挑中的参考合成每一句（签名在 vocab/capability-signatures.md）
//   @capability style-instruction   可选：环境声明有它，才把配音指引、这一句的说明通过 instructions 传给模型
//   @capability style-cues          可选：环境声明有它，才把这一句自己的舞台提示认出来的名字（情绪、风格）通过 cues 传给模型；语速、停顿和配音指引都不进去
//   @capability pause-in-text       可选：环境声明有它，才把段落里不超过 2.5 秒的停顿并进一次请求，写在文字里（<speak> 和 <break>，规则在 lib/pause-in-request.mjs）
//   @capability text-generation     可选：台本里没有任何提示时，让它判断每句的情绪、风格（在 lib/reference-pick.mjs 里用）
//
//   const plan   = await planDub(env, pack, script, options);   只规划，不合成：每一段话挑了哪一段参考、为什么、读音词表换了什么。不花钱：不调任何要计费的能力，
//                                                               text-generation 也不调（要判情绪的句子，plan.judge 是 { status: 'planned', capability, lines }，写明正式运行会判几句，这几句现在用默认参考）
//   const result = await dubScript(env, pack, script, options); 规划，再合成
// pack 是 lib/voice-pack.mjs 的 openVoicePack 打开的角色部分，或者几个（数组，第一个是台本开头，即第一个 [voice:] 之前用的声音；见第 1 步）。
// 库不碰文件系统：合成出来的音频是字节，写成文件是命令行层的事。
// 几个包：每一句用它那一刻的包（挑参考、读音词表、配音指引、增强件、脚本都照那个包的）；短句并段只在同一个包里并（第 5b 步）；
//   每个 unit 记着包 ID（unit.pack），plan.packs 列出几个包。只给一个包时，这两样都不出现，输出和以前一字不差。
//   text-generation 的判断按包分开调（每个包的参考集里有的标签不一样），judge 把它们合在一个对象里（status 取最要紧的一个）。
//
// 台本（script）：一个字符串（带台本标记的整段台本），或者一个数组，每项是
//   { text, labels?, instructions? }   text 是带标记的台本；labels 是调用方给这一项的标签 { language, emotion, style, energy }；
//                                      instructions 是调用方给这一项的说明（agent 读了配音指引以后想补的话）。
// options：labels（给所有项的默认标签，项自己的盖过它）、concurrency（并发数，默认 2，1–8）、maxChars（一次合成最多多少个字，
//   超过的按句子切开；默认不切）、minChars（合成能力一次至少多少个字，环境声明的；默认没有下限，见第 5b 步）、joinShort（默认 true；
//   false 就不并短句，只按下限认：试合成用，每条留出录音一段）、only（只合成这几段，编号是规划里的 units[i].index，别的标成 skipped；失败后重做用）、
//   runtimesOf（几个包时，每个包的脚本运行时：runtimesOf(pack) 返回这个包的 { 运行时名字: 函数 }；命令行层给每个包目录各建一份（cli/script-runtimes.mjs）；
//   不给就用 env.runtimes。脚本在它自己的包目录里运行，所以要分开）、
//   guidance（配音指引的正文；不给就用包里的，给 null 就不用）、onUnit（每一段做完，立刻交给它；见下）、
//   onPlan（花钱之前交给它：规划做好了，花钱之前该核对的都核对过了，一次计费的调用都还没发生。第一个参数是这份规划（判情绪之前的）；
//   第二个参数 { calls: { count, exact } } 是这次要合成几次：exact 为真就正好是 count 次，为假就是最多 count 次，因为判出来的参考可能让相邻的几句并不成一次。
//   命令行用它说明费用，抛错就什么都不做）。text-generation 的判断（计费）在 onPlan 之后才调，挑参考和并段按它的结果重算，
//   重算的内容原地换进交给 onPlan 的这同一个对象：最后返回的就是它，每一段的结果写在它的 units 上。
//
// 一句话是怎么变成合成的（顺序就是这样）：
//   1 解析台本标记（tools/markup.mjs）：章节、停顿、语速、[voice:]。[voice:名字] 对上台本给的几个包中的一个（包名或包 ID，不分大小写）：
//     对不上报 voice_unknown，对上不止一个包报 voice_ambiguous。第一个 [voice:] 之前（或者 [voice:] 是空的）用第一个包。
//     只有一个包时，别的名字报 voice_unknown：一个包只有一个声音，换声音的台本需要别的包，不悄悄用这个包去念。
//   2 读舞台提示（lib/line-hints.mjs）：括号里的（耳语）、*笑* 变成这一段的情绪、风格、停顿、语速，从要说的话里拿掉。
//     括号里词表认不出的内容（（画外音））配音时也拿掉，不念；如实记在这一段的 pick.directions 里（recognized 为 false）。
//   3 每一段挑参考（lib/reference-pick.mjs）：调用方的标签、台本里的提示、text-generation 的判断、默认参考。理由放在 units[i].pick 里。
//     text-generation 的判断是计费的，在 onPlan 之后才调（见上面的 onPlan）。
//   4 读音词表（包里的 lexicon.pls，lib/pronunciation-lexicon.mjs）：换掉要说的话里的词，只换标记之间的文字。做不到的（音素）如实报在 lexicon.unapplied。
//   5 超过 maxChars 的按句子切成几段，同一句的几段共用同一段参考。
//   5b 有下限（minChars，环境声明的；没有就跳过这一步）：一段的字数不到下限，就和后面的一段并成一段（joinShort 为 true 时），直到够下限或者没有可并的。
//     并段的规则和 app 的 fitMinLength 一样：同一个声音（台本里的声音都是这个包，voice_unknown 保证），
//     中间没有停顿（前一段没有停顿要求，后一段前面也没有），语速一样；这里还多两条，因为配音的句子各有各的说明：参考段一样（同一个声音说这句的参考，见第 3 步），
//     说明一样（第 7 步传给模型的那段话一样，不然并起来会丢掉其中一句的舞台提示）；前一段是被行内标签切开的（unit.join），不并，拼接的人要按它处理；
//     并起来的字数不超过 maxChars（给了的话）。并起来的那一段记成 joined（{ line, part } 的列表，写明并了哪几句）。
//     并完还不到下限的那一段，记成 failed（unit.error 是 { code: 'text_too_short', message: '比合成能力的下限短…', details: { chars, min } }），不调用能力，
//     不是暂时出错，所以不标 transient：别的段照常做。下限是 1 或者没有，这一步什么都不做。
//   6 脚本（lib/pack-script.mjs）：登记在 dub 功能名下的脚本，合成之前跑 text 钩子（可以改要说的话），合成之后跑 audio 钩子（可以换音频）。
//     清单里没写 feature 的脚本不属于任何功能，不运行；规划和正式运行的 notes 里都有一条 scripts_without_feature 点名它们（字段见下面「说明」），
//     说明这次没有运行和原因。
//   7 合成：voice-cloning，参数 { text, ref_audio, ref_text, instructions?, cues?, enhancers?, continues? }。
//      continues：这一段是接着下一段说的（句子被标记切开，unit.join 为 'continue'）时才有，能力不到最短字数补「，」而不是「。」（补字的规则只在适配器一处）。
//      text：unit.ssml 有的（一次请求里有停顿，pause-in-text，第 5c 步）用它，没有就是 unit.spoken。
//      拼接的人怎么处理 unit 的停顿、续接、并起来的段：写在 references/dub.md 的「拼接」，这里不重复。
//      instructions：环境有 style-instruction 才传（配音指引，加上调用方给这一项的说明和这一句的舞台提示），没有就整个不传这个键，
//      返回值里说明没传和原因。配音指引是新式（有三个小节中的任何一个）的，只传演法一节（没有演法就不传）；旧式整段；配音指引过长（超过 2000 个字）截短再传，并记一条 guidance_truncated。
//      cues：环境有 style-cues 才传，是这一句自己的 { emotion, style }（词表的规范名字）：情绪、风格：调用方在 labels 里给的先用，没给的取读这一句的舞台提示。
//      配音指引不进 cues，语速和停顿也不进（见下面「语速和停顿」）。一句分段时，一下子的声音（vocab/cues.json 的 oneShot：笑、叹气）只在第一段带，情绪、风格每段都带。
//      返回值的 units[i].cues 写明没传和原因（style_cues_missing、nothing_to_send）。
//      enhancers：包里服务 voice-cloning 的增强件，以 { id, model, modelVersion, referenceVersion, capability, load } 递给能力，load() 才读文件。
//      环境认识对应的模型就用上，并在返回里用 enhancers_used 报出用了哪几个（id）；不认识的会忽略 enhancers，照常生成。
//      这一次有没有用上增强件，写在 enhancers 里：一个都没用上、而包里有，statement 是 'enhancers_not_used'，附上没用上的增强件是哪个模型的，
//      和包的验证记录（verification），让人知道当前环境下效果会差多少。
//
// 语速和停顿：合成能力不收语速，停顿也不是合成出来的。unit.speed（0.85 放慢、1.15 加快、null 没要求）、unit.pauseBeforeMs、unit.pauseAfterMs、
// unit.join 如实记着，由拼接的人按它们处理；有语速要求时 notes 里有一条 speed_not_applied。拼接的人是拿到这些 unit、交出成品音频的那一方：命令行的使用者（自己用 ffmpeg 之类拼），
// 或者适配器（它自己把音频拼好、直接返回成品的，就是拼接的人，unit.speed 归它处理，例如变速、保持音高，不能原样丢掉）。dub 本身不把 speed 传给合成能力。
// 语速和停顿只走这些字段，不进 cues（一个概念一条路）：拼接的人按 unit 做一次。不论环境声明不声明 style-cues，都一样。
// 停顿有两个来源：台本标记 [pause …] 和舞台提示（（停顿 3 秒），一行里只有它时挂到前一句的后面，规则见 lib/line-hints.mjs）。同一处两样相加，
// 加起来不超过 PAUSE_MAX_MS（tools/markup.mjs，[pause …] 的上限）；前一句的后面加后一句的前面（同一个缝）也不超过它，超过的从后一句的前面扣。
//
// 一段失败了怎么办：能力抛的错如果标了 details.transient（服务暂时出错，约定见 vocab/capability-signatures.md），或者标了 details.textRejected
// （只和这一次的文字有关，换一句就成，同一约定），这一段记成 failed（unit.error 是 { code, message, details }），别的段照常做，整体 ok 是 false；
// 调用方可以事后用 only 重做。比下限短、并不了的那一段（第 5b 步）也记成 failed，但重做没有用，要改台本。别的错（401、参数错、参考的问题、
// 返回的形状不对……）一律停下来：不再开始新的段，等已经在做的段做完，错误原样往上抛。每一段做完（成功或失败）立刻交给 onUnit，
// 所以停下来的时候，已经做完的不会丢。
// 还有一道保护：还没有一句成功、已经有 TEXT_REJECTED_LIMIT（3）句被服务商拒了，也停下来：同样不再开始新的段、等在做的做完，然后抛 dub_text_rejected
// （details.rejected 写明被拒的段和句子）。只数服务商拒的：能力调用了服务商，服务商拒了这句的文字（details.textRejected 为 true，code 不是 capability_input_invalid）。
// 调用之前就查出来的（适配器自己的检查：空白、太长、有处理不了的字，code 是 capability_input_invalid，约定见 vocab/capability-signatures.md）不数：那是这句文字本身的问题，
// 换一句就成，只记这一句失败，别的照常做。为什么这样分：服务商拒的，原因可能是参考或别的输入（服务商的话没说拦的是哪个输入）。要是内容审核拦的是参考，
// 每一句都会这样被拒（这是推断，没有核过），所以要数，数到 3 句还没有一句成功，就停，不再白花钱。有过一句成功，参考就是能用的，之后再怎么被拒都不停：
// 台本中间一段敏感的话，不该让整份停下。中间夹着暂时出错的段，不算进这个数。
//
// 环境缺东西：规划（planDub）不抛错，只在 capabilities 和 missingRuntimes 里说明缺什么；dubScript 在花钱之前抛：
//   capability_missing  缺 voice-cloning（details.capability）
//   runtime_missing     脚本要的运行时环境没有（details: { runtime, entry, feature }）
// 只有配音用到的才报；缺 text-generation、style-instruction 都不是错误。text-generation 的回答不能用（没有文字、没有正常结束）也不是错误：
// 那几句落到默认参考，plan.judge 是 { status: 'unusable', … }，units[i].pick.judgeFailed 为 true，配音接着做（规则在 lib/reference-pick.mjs 的文件头）。
//
// 说明（返回值里的 notes：[{ code, message, details }]，规划和正式运行都有；message 是给人看的中文，details 是它说的那些事实，没有要说的数就是空对象）：
//   guidance_truncated       配音指引超过 2000 个字，截短以后才传给模型。details: { chars, max }：指引原来有多少个字、最多传多少个字
//   speed_not_applied        台本有语速要求，合成能力不收语速，要拼接的人按 unit.speed 处理。details: {}
//   scripts_without_feature  包里有没登记功能的脚本，这次没有运行。details: { scripts }，scripts 是 [{ entry, runtime }]；note.scripts 是同一份，是原来的写法，留着给已有的读者
//   short_lines_joined       有几段比合成能力的下限短，并进了相邻的句子（第 5b 步）。details: { min, units }：下限是多少个字，并成的段有几段
//
// 抛出的错误（VoicePackError；code 小写下划线，details 里放什么在抛出处写明）：
//   dub_input_invalid        输入不合约定：台本不是字符串或数组、项没有 text、only 或 maxChars 或 concurrency 不对。details.field
//   dub_nothing_to_say       台本里没有可说的话（只有标记和提示）
//   dub_text_rejected        还没有一句成功、已经有 3 句被服务商拒了（见上面「一段失败了怎么办」）：停下。details: { limit, rejected: [{ unit, line }] }，
//                            被服务商拒的段（unit，同 only 的编号）和它的句子（line，同 lines[i].index），都从 0 起
//   voice_unknown            台本里的 [voice:名字] 不是给出的包。只给一个包时 details: { voices（台本里不认识的名字）, pack: { id, name } }；
//                            几个包时 details: { voices, packs: [{ id, name }] }（给了哪些包）
//   voice_ambiguous          台本里的 [voice:名字] 对上不止一个包（几个包的名字一样）：用包 ID 指定。details: { voices, packs }
//   dub_input_invalid        同一个包给了两次（details.field 是 pack）
//   capability_result_invalid  voice-cloning 的返回不合约定（不是 { bytes, mimeType }、enhancers_used 报了没递给它的增强件）。details: { capability, problem }
//   另外 pick_input_invalid（标签不对）、lexicon_invalid、script_*、file_missing（清单里列了、包里没有）等来自各自的模块。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { hasCapability, requireCapability } from '../protocol/lib/env.mjs';
import { fromBase64 } from '../protocol/lib/bytes.mjs';
import { guidanceForModel } from '../protocol/lib/guidance-sections.mjs';
import { parseScript, SPEED, PAUSE_MAX_MS } from '../tools/markup.mjs';
import { splitSentences } from '../tools/sentences.mjs';
import { readDirections, canonicalLabel } from './line-hints.mjs';
import cues from '../vocab/cues.json' with { type: 'json' };
import { pickReferences } from './reference-pick.mjs';
import { lexiconRules, applyLexicon } from './pronunciation-lexicon.mjs';
import { assertScriptRuntimes, missingScriptRuntimes, scriptsWithoutFeature, runScript, audioForScript, HOOKS } from './pack-script.mjs';
import { readAudioResult, summarizeOffer, summarizeUse } from './enhancers.mjs';
import { isServiceError, isTextRejected, summarizeError, pool } from './capability-calls.mjs';
import { requestsOf, endsMidSentence, JOIN_PUNCTUATION_PAUSE_MS } from './pause-in-request.mjs';

export const FEATURE = 'dub';
/** unit.error.code：比合成能力的下限短、并不了的那一段（第 5b 步）。make-pack 的试合成也认这个码，把它记成「没合成」，不是「暂时出错」。 */
export const TEXT_TOO_SHORT = 'text_too_short';
const GUIDANCE_MAX = 2000;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 8;
/**
 * 还没有一句成功、已经有这么多句被服务商拒了（details.textRejected，调用之前查出来的不算），就停下（文件头「一段失败了怎么办」）。依据：要是参考真被拦了，每一句都会被拒，
 * 这时最多白调这么多次；并发时，停的那一刻还在做的几句照常做完，所以实际还会多出并发数减一次。
 */
const TEXT_REJECTED_LIMIT = 3;
// 配音的台本是明确拿来配音的：30 个字以内的括号一律是提示，词表里认不出的（（画外音））、有词表里的词可是还有别的字的（（笑话比赛））也拿掉、不念
// （规则的正本是 lib/line-hints.mjs 的文件头；其他地方读到的括号，要整个都是词表里的提示才拿掉，其余当正文念）
const REMOVE_UNRECOGNIZED = Object.freeze({ unrecognized: 'remove' });
// 只规划（planDub、命令行的 --dry-run）不花钱：挑参考时不让 text-generation 判断（它收费），要判的句子在 judge 里写明，见 lib/reference-pick.mjs
const PLAN_ONLY = Object.freeze({ ...REMOVE_UNRECOGNIZED, judge: false });

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** 一处停顿的毫秒数封顶：上限和台本标记 [pause …] 的一样（tools/markup.mjs 的 PAUSE_MAX_MS），只在那里写一处。 */
const capPause = (ms) => Math.min(ms, PAUSE_MAX_MS);
const invalid = (field, message) => new VoicePackError('dub_input_invalid', message, { details: { field } });

// ---------------------------------------------------------------- 输入

function readScript(script) {
  if (typeof script === 'string') return [{ text: script, labels: undefined, instructions: undefined }];
  if (!Array.isArray(script)) throw invalid('script', '台本必须是字符串（带台本标记的整段台本），或者数组：每项 { text, labels?, instructions? }');
  return script.map((item, index) => {
    const at = `script[${index}]`;
    const entry = typeof item === 'string' ? { text: item } : item;
    if (!isPlainObject(entry) || typeof entry.text !== 'string') throw invalid(`${at}.text`, `${at}.text 必须是字符串（这一项的台本）`);
    if (entry.instructions !== undefined && typeof entry.instructions !== 'string') throw invalid(`${at}.instructions`, `${at}.instructions 必须是字符串`);
    return { text: entry.text, labels: entry.labels, instructions: entry.instructions };
  });
}

function readOptions(options) {
  if (!isPlainObject(options)) throw invalid('options', 'options 必须是对象');
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) throw invalid('concurrency', `concurrency 必须是 1–${MAX_CONCURRENCY} 的整数`);
  const maxChars = options.maxChars ?? null;
  if (maxChars !== null && (!Number.isInteger(maxChars) || maxChars < 10)) throw invalid('maxChars', 'maxChars 必须是不小于 10 的整数');
  if (options.onUnit !== undefined && typeof options.onUnit !== 'function') throw invalid('onUnit', 'onUnit 必须是函数');
  if (options.onPlan !== undefined && typeof options.onPlan !== 'function') throw invalid('onPlan', 'onPlan 必须是函数');
  if (options.guidance !== undefined && options.guidance !== null && typeof options.guidance !== 'string') throw invalid('guidance', 'guidance 必须是字符串或 null');
  const minChars = options.minChars ?? null;
  if (minChars !== null && (!Number.isInteger(minChars) || minChars < 1)) throw invalid('minChars', 'minChars 必须是不小于 1 的整数（合成能力一次至少多少个字），或者不给');
  if (options.joinShort !== undefined && typeof options.joinShort !== 'boolean') throw invalid('joinShort', 'joinShort 必须是 true 或 false');
  if (options.runtimesOf !== undefined && typeof options.runtimesOf !== 'function') throw invalid('runtimesOf', 'runtimesOf 必须是函数：runtimesOf(pack) 返回这个包的脚本运行时');
  return { concurrency, maxChars, minChars, joinShort: options.joinShort ?? true, onUnit: options.onUnit, onPlan: options.onPlan, labels: options.labels, guidance: options.guidance, only: options.only, runtimesOf: options.runtimesOf };
}

// ---------------------------------------------------------------- 几个包

/** 给的包：一个，或者几个（数组）。统一成数组，第一个是台本开头用的声音。同一个包给了两次是输入错误。 */
function packsOf(input) {
  const packs = Array.isArray(input) ? input : [input];
  if (packs.length === 0) throw invalid('pack', '要给至少一个音色包');
  const seen = new Set();
  for (const pack of packs) {
    if (seen.has(pack.manifest.id)) throw new VoicePackError('dub_input_invalid', `包 ${pack.manifest.id} 给了两次：同一个包只给一次`, { details: { field: 'pack' } });
    seen.add(pack.manifest.id);
  }
  return packs;
}

/** 这个包的脚本要的运行时在哪个环境里：几个包时用 runtimesOf（每个包的脚本在它自己的目录里运行）；不给就是 env。 */
const envFor = (env, settings, pack) => (settings.runtimesOf === undefined ? env : { ...env, runtimes: settings.runtimesOf(pack) });

/**
 * 每一句属于哪个包（owners[i] 是第 i 句的包）：[voice:名字] 认包名或包 ID（不分大小写）；没有 [voice:] 的句子用第一个包。
 * 对不上：voice_unknown；对上不止一个包：voice_ambiguous。只有一个包时，报错和以前一字不差。
 */
function ownersOf(packs, lines, voices) {
  const keyOf = (value) => value.trim().toLowerCase();
  const matchesOf = (voice) => packs.filter((pack) => [pack.manifest.id, pack.manifest.name].some((name) => keyOf(name) === keyOf(voice)));
  const described = (pack) => `${pack.manifest.name}，${pack.manifest.id}`;
  const unknown = [...new Set(voices.filter((voice) => matchesOf(voice).length === 0))];
  if (unknown.length > 0) {
    if (packs.length === 1) {
      const [pack] = packs;
      throw new VoicePackError('voice_unknown', `台本里的 [voice:${unknown.join('、')}] 不是这个包（${pack.manifest.name}，${pack.manifest.id}）：一个包只有一个声音，换声音的台本需要别的包`, { details: { voices: unknown, pack: { id: pack.manifest.id, name: pack.manifest.name } } });
    }
    throw new VoicePackError('voice_unknown', `台本里的 [voice:${unknown.join('、')}] 不是给出的任何一个包（${packs.map((pack) => `${pack.manifest.name}（${pack.manifest.id}）`).join('、')}）：名字或包 ID 对得上才行`, { details: { voices: unknown, packs: packs.map((pack) => ({ id: pack.manifest.id, name: pack.manifest.name })) } });
  }
  const ambiguous = [...new Set(voices.filter((voice) => matchesOf(voice).length > 1))];
  if (ambiguous.length > 0) {
    throw new VoicePackError('voice_ambiguous', `台本里的 [voice:${ambiguous.join('、')}] 对上不止一个包（${matchesOf(ambiguous[0]).map(described).join('；')}）：用包 ID 指定`, { details: { voices: ambiguous, packs: matchesOf(ambiguous[0]).map((pack) => ({ id: pack.manifest.id, name: pack.manifest.name })) } });
  }
  return lines.map((line) => (line.voice === null ? packs[0] : matchesOf(line.voice)[0]));
}

/**
 * 几个包各自的 text-generation 判断，合在一个 judge 里（一个包时就是它自己的，不动）：status 取最要紧的一个
 * （unusable > planned > used > unavailable > not_needed），lines 相加，model、reason、error 取第一个有的。
 */
function combineJudges(judges) {
  if (judges.length === 1) return judges[0];
  const rank = ['unusable', 'planned', 'used', 'unavailable', 'not_needed'];
  const status = rank.find((name) => judges.some((judge) => judge.status === name)) ?? 'not_needed';
  const first = (key) => judges.find((judge) => judge[key] !== undefined)?.[key];
  const lines = judges.reduce((sum, judge) => sum + (judge.lines ?? 0), 0);
  const ignored = judges.flatMap((judge) => judge.ignored ?? []);
  return {
    status,
    ...(status === 'not_needed' ? {} : { capability: 'text-generation' }),
    ...(lines > 0 ? { lines } : {}),
    ...(first('model') === undefined ? {} : { model: first('model') }),
    ...(first('reason') === undefined ? {} : { reason: first('reason') }),
    ...(first('error') === undefined ? {} : { error: first('error') }),
    ...(ignored.length > 0 ? { ignored } : {}),
  };
}

// ---------------------------------------------------------------- 台本 -> 一句一句

/**
 * 解析台本标记、读舞台提示，得到一句一句（每句是一段要念的话，带着自己的提示、语速、停顿）。
 * 停顿标记单独成段的（文字是空的），算在前一句后面；一开头的算在第一句前面。舞台提示里一句要念的话都没有的一段（（停顿 3 秒））也一样：
 * 它的停顿（readDirections 的 unattachedPauseMs）和这一段后面的 [pause] 一起算。
 * 同一处停顿（舞台提示的加上 [pause …] 的）相加以后封顶，上限是 tools/markup.mjs 的 PAUSE_MAX_MS；
 * 前一句的后面加后一句的前面（同一个缝）也不超过它：超过的，从后一句的前面扣。
 */
function buildLines(sources, defaults) {
  const lines = [];
  const voices = [];
  let pendingBefore = 0;
  let chapterOffset = 0;
  const addPause = (ms) => {
    if (ms <= 0) return;
    if (lines.length > 0) lines[lines.length - 1].pauseAfterMs = capPause(lines[lines.length - 1].pauseAfterMs + ms);
    else pendingBefore = capPause(pendingBefore + ms);
  };
  sources.forEach((source, sourceIndex) => {
    const labels = { ...(defaults ?? {}), ...(source.labels ?? {}) };
    const chapters = parseScript(source.text);
    chapters.forEach((chapter, chapterIndex) => {
      chapter.spans.forEach((span, spanIndex) => {
        if (span.voice_id !== null) voices.push(span.voice_id);
        const { pieces, unattachedPauseMs } = readDirections(span.text, REMOVE_UNRECOGNIZED);
        if (pieces.length === 0) {
          addPause(unattachedPauseMs);
          addPause(span.pause_ms_after);
          return;
        }
        pieces.forEach((piece, pieceIndex) => {
          const last = pieceIndex === pieces.length - 1;
          const speed = piece.speed !== null ? SPEED[piece.speed] : span.speed;
          lines.push({
            index: lines.length,
            source: sourceIndex,
            chapter: chapterOffset + chapterIndex,
            span: spanIndex,
            voice: span.voice_id,
            text: piece.text,
            labels,
            hints: { ...(piece.hints.emotion === null ? {} : { emotion: piece.hints.emotion }), ...(piece.hints.style === null ? {} : { style: piece.hints.style }) },
            directions: piece.directions,
            instructions: source.instructions,
            speed: speed ?? null,
            pauseBeforeMs: capPause(piece.pauseBeforeMs + pendingBefore), // 一开头单独成段的停顿，算在第一句前面
            pauseAfterMs: capPause(piece.pauseAfterMs + (last ? span.pause_ms_after : 0)),
            ...(last && span.join !== undefined ? { join: span.join } : {}),
          });
          pendingBefore = 0;
        });
      });
    });
    chapterOffset += chapters.length;
  });
  for (let at = 1; at < lines.length; at += 1) lines[at].pauseBeforeMs = Math.min(lines[at].pauseBeforeMs, PAUSE_MAX_MS - lines[at - 1].pauseAfterMs);
  return { lines, voices };
}

// ---------------------------------------------------------------- 分段

const CJK_END = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}。！？，、；：]$/u;
const count = (text) => [...text].length;
/** 两段要念的话接起来：前一段是中文、日文、韩文收尾或者中文标点收尾的，中间不加空格，别的加一个空格（分段和并段用同一个规则）。 */
const joinSpoken = (before, after) => `${before}${CJK_END.test(before) ? '' : ' '}${after}`;

/** 把超长的一句按逗号一类的停顿处再切；还超就硬切。 */
function breakLong(sentence, max) {
  const clauses = sentence.split(/(?<=[，,、;；:：])/);
  const out = [];
  let current = '';
  for (const clause of clauses) {
    if (current !== '' && count(current) + count(clause) > max) {
      out.push(current);
      current = '';
    }
    current += clause;
  }
  if (current !== '') out.push(current);
  return out.flatMap((piece) => {
    if (count(piece) <= max) return [piece];
    const chars = [...piece];
    const cuts = [];
    for (let at = 0; at < chars.length; at += max) cuts.push(chars.slice(at, at + max).join(''));
    return cuts;
  });
}

/** 一句话切成不超过 max 个字的几段：先按句子，再把相邻的句子并起来，装不下的才再切。 */
function partsOf(text, max) {
  if (max === null || count(text) <= max) return [text];
  const sentences = splitSentences(text).flatMap((sentence) => (count(sentence) > max ? breakLong(sentence, max) : [sentence]));
  const parts = [];
  let current = '';
  for (const sentence of sentences) {
    const joined = current === '' ? sentence : joinSpoken(current, sentence);
    if (current !== '' && count(joined) > max) {
      parts.push(current);
      current = sentence;
    } else {
      current = joined;
    }
  }
  if (current !== '') parts.push(current);
  return parts;
}

// ---------------------------------------------------------------- 短句并段（第 5b 步）

/** 能不能把 before 和后面的 after 并成一段（规则见文件头第 5b 步）。说明（instructions）和名字（cues）都要一样：并起来的段只有一份。 */
function canJoin(before, beforeStyle, after, afterStyle, max) {
  if (before.join !== undefined || before.pauseAfterMs !== 0 || after.pauseBeforeMs !== 0) return false;
  if (before.speed !== after.speed || before.pick.segmentId !== after.pick.segmentId || before.pack !== after.pack || JSON.stringify(beforeStyle) !== JSON.stringify(afterStyle)) return false;
  return max === null || count(joinSpoken(before.spoken, after.spoken)) <= max;
}

/** 两段并成一段：要念的话接起来；停顿和 join 跟着两头的位置走；记下并了哪几句（joined）。原文 text 同一句的几段（分段的）不重复。 */
function joinedUnit(before, after) {
  const members = before.joined ?? [{ line: before.line, part: before.part }];
  return {
    ...before,
    spoken: joinSpoken(before.spoken, after.spoken),
    text: before.line === after.line ? before.text : joinSpoken(before.text, after.text),
    pauseAfterMs: after.pauseAfterMs,
    joined: [...members, { line: after.line, part: after.part }],
    ...(after.join === undefined ? {} : { join: after.join }),
  };
}

/**
 * 短句并段：前一段不到下限，就并进后面的一段，直到够下限或者没有可并的（和 app 的 fitMinLength 一样的走法）。styles 是每一段要传给模型的（{ instructions, cues }），跟着段走。
 * @returns {{ units: object[], styles: object[] }} 段的编号按并完以后的次序重排（index）
 */
function joinShortUnits(units, styles, { min, max }) {
  const out = [];
  const outStyles = [];
  units.forEach((unit, at) => {
    const last = out.length - 1;
    if (last >= 0 && count(out[last].spoken) < min && canJoin(out[last], outStyles[last], unit, styles[at], max)) {
      out[last] = joinedUnit(out[last], unit);
      return;
    }
    out.push({ ...unit });
    outStyles.push(styles[at]);
  });
  return { units: out.map((unit, index) => ({ ...unit, index })), styles: outStyles };
}

/** 比下限短、并不了的那一段的错。不是暂时出错：不标 transient，不重做（见文件头第 5b 步）。 */
const tooShortError = (spoken, min) => ({
  code: TEXT_TOO_SHORT,
  message: `这一段比合成能力的下限短：只有 ${count(spoken)} 个字，下限是 ${min} 个字，没有合成`,
  details: { chars: count(spoken), min },
});

/** 还没有一句成功、已经有 TEXT_REJECTED_LIMIT 句被服务商拒了（文件头「一段失败了怎么办」）：停下。rejected 是被服务商拒的段，按被拒的次序。 */
const textRejectedStop = (rejected) =>
  new VoicePackError('dub_text_rejected', `已经有 ${rejected.length} 句被服务商拒了，而且还没有一句成功：这可能不是这些句子的文字的问题，是参考或别的输入被拦了（那样每一句都会被拒）。已经停下，不再开始新的句子；已经做完的段照常交给 onUnit，被拒的段和句子见 details.rejected`, {
    details: { limit: TEXT_REJECTED_LIMIT, rejected: rejected.map((unit) => ({ unit: unit.index, line: unit.line })) },
  });
/**
 * 调用之前就查出来的文字错（适配器自己的检查：空白、太长、有处理不了的字；code 是 capability_input_invalid，约定见 vocab/capability-signatures.md）：
 * 那是这句文字本身的问题，不是服务商拒的，所以不计数（文件头「一段失败了怎么办」）。
 */
const checkedBeforeCall = (error) => error.code === 'capability_input_invalid';

// ---------------------------------------------------------------- 传给模型的说明

/** 配音指引截到上限以内。尽量在段落边界截；返回 { text, truncated }。 */
function fitGuidance(guidance) {
  if (guidance === null || count(guidance) <= GUIDANCE_MAX) return { text: guidance, truncated: false };
  const head = [...guidance].slice(0, GUIDANCE_MAX).join('');
  const cut = head.lastIndexOf('\n\n');
  return { text: (cut > GUIDANCE_MAX / 2 ? head.slice(0, cut) : head).trim(), truncated: true };
}

/** 管着这一句的舞台提示：从最后一个有情绪或风格的提示起，没有就全部。配音指引（noteOf）用的是这一批。 */
function governingOf(line) {
  const last = line.directions.map((d) => d.emotion !== null || d.style !== null).lastIndexOf(true);
  return line.directions.slice(Math.max(last, 0));
}

/** 这一句的说明：调用方给的，加上管着这一句的舞台提示（governingOf）。原样用作者的词。 */
function noteOf(line) {
  const parts = [line.instructions, ...governingOf(line).map((d) => d.raw)].filter((part) => typeof part === 'string' && part.trim() !== '');
  return parts.length === 0 ? null : [...new Set(parts)].join('；');
}

// ---------------------------------------------------------------- 这一句自己的名字（style-cues）

// cues.json 是唯一的来源：规范名字就是它的键，一下子的声音（oneShot）也在那里标。这里只读，不另写一份。
const CUE_EMOTIONS = new Set(Object.keys(cues.emotion));
const CUE_STYLES = new Set(Object.keys(cues.style));
const ONE_SHOT_STYLES = new Set(cues.oneShot.style);

/** 调用方给这一项的标签（labels.emotion、labels.style）：规范化以后是词表里的名字才用，认不出的不用（不猜）。 */
function labelCue(kind, value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const name = canonicalLabel(kind, value);
  return (kind === 'emotion' ? CUE_EMOTIONS : CUE_STYLES).has(name) ? name : null;
}

/**
 * 这一句自己的名字（cues，见 vocab/capability-signatures.md「怎么念」）。
 * 情绪、风格：调用方在 labels 里给的（规范化以后认得出的）先用，和挑参考一样；没给的取读这一句的舞台提示时的状态（line.hints，和 readDirections 的读法一样）。
 * 语速和停顿不在这里：它们是 unit.speed、unit.pauseBeforeMs、unit.pauseAfterMs，由拼接的人做一次（见文件头「语速和停顿」）。
 * part 是第几段（从 1 数）：一下子的声音（oneShot）只在第一段带；情绪、风格（不是一下子的）每段都带。配音指引不进来：这里只看这一句。
 * @param {object} line 台本的一句（buildLines 的结果，带 hints、labels）
 * @param {number} part
 * @returns {{ emotion: string|null, style: string|null }}
 */
function cuesOf(line, part) {
  const emotion = labelCue('emotion', line.labels.emotion) ?? line.hints.emotion ?? null;
  let style = labelCue('style', line.labels.style) ?? line.hints.style ?? null;
  if (part === 1) return { emotion, style };
  if (style !== null && ONE_SHOT_STYLES.has(style)) style = null;
  return { emotion, style };
}

// ---------------------------------------------------------------- 规划

const emptyEnhancers = (offers) => ({ offered: offers.map(summarizeOffer), used: [], notUsed: [], statement: null });

/**
 * 5c：段落内部的停顿（不超过 2.5 秒）并进一次请求，写在文字里。只在环境声明了 pause-in-text 时做（那样它才收 <speak> 的文字）。
 * 停顿怎么写（<break>、靠标点、整段包 <speak>、转义）是 lib/pause-in-request.mjs 的；这里只决定哪两段能并：
 *   同一章；前一段不是空行（join）接着的；同一个参考段；同一个语速；说明和名字一样（一个请求只有一套，放在前面）；
 *   名字里没有一下子的声音（笑、叹气）：标签要写在各自的字前面，一个请求放不下两套，而且笑、叹气标签在 <speak> 里能不能出声没有测出明确的结论，保守不并。
 * 包里登记了配音脚本的不并：text 钩子要看到每一句的原话（几个包时，只看这一句所在的包有没有脚本）。
 * 并起来的段：unit.spoken 是原话的词（不带标记），unit.ssml 是发出去的文字（有 <break> 才有）；unit.joined 写明并了哪几句；停顿在它的两头
 * （unit.pauseBeforeMs、unit.pauseAfterMs），中间的已经在文字里，拼接的人不再插静音。
 * @returns {{ units: object[], styles: object[], joins: number }} joins 是并了几处（一句并进前一句算一处）
 */
function pausesInRequest(env, units, styles, { max, hasScripts }) {
  if (!hasCapability(env, 'pause-in-text') || units.every((unit) => hasScripts(unit))) return { units, styles, joins: 0 };
  const oneShot = (at) => styles[at].cues !== null && ONE_SHOT_STYLES.has(styles[at].cues.style);
  const sameStyle = (a, b) => JSON.stringify(styles[a]) === JSON.stringify(styles[b]);
  // 一个缝的停顿：前一段的后面，加上后一段的前面（buildLines 已经把它封顶在 PAUSE_MAX_MS 以内）
  const items = units.map((unit, at) => ({ text: unit.spoken, pause: at + 1 < units.length ? unit.pauseAfterMs + units[at + 1].pauseBeforeMs : unit.pauseAfterMs, inline: true, at }));
  const requests = requestsOf(items, {
    max,
    measure: count,
    canJoin: (prev, next) => {
      const a = units[prev.at];
      const b = units[next.at];
      return a.status === 'planned' && b.status === 'planned' && a.join === undefined && a.chapter === b.chapter && a.pack === b.pack
        && a.pick.segmentId === b.pick.segmentId && a.speed === b.speed && sameStyle(prev.at, next.at)
        && !oneShot(prev.at) && !oneShot(next.at) && !hasScripts(a) && !hasScripts(b);
    },
  });
  let joins = 0;
  const out = [];
  const outStyles = [];
  for (const request of requests) {
    const members = units.slice(request.first, request.last + 1);
    outStyles.push(styles[request.first]);
    if (members.length === 1) { out.push(members[0]); continue; }
    joins += members.length - 1;
    const head = members[0];
    const last = members[members.length - 1];
    const text = members.reduce((acc, member, k) => (k === 0 || member.line === members[k - 1].line ? acc : joinSpoken(acc, member.text)), head.text);
    out.push({
      ...head,
      text,
      spoken: request.words,
      ...(request.ssml ? { ssml: request.text } : {}),
      pauseAfterMs: last.pauseAfterMs,
      joined: members.flatMap((member) => member.joined ?? [{ line: member.line, part: member.part }]),
      ...(last.join === undefined ? {} : { join: last.join }),
    });
  }
  return { units: out.map((unit, index) => ({ ...unit, index })), styles: outStyles, joins };
}


/**
 * 规划：返回 { plan, styles, unmergedCount }。styles[i] 是第 i 段真要传给模型的 { instructions, cues }（环境没有 style-instruction 时 instructions 是 null，没有 style-cues 时 cues 是 null）；
 * 全文可能很长，不放进每一段的记录里，只有合成的人拿它。askJudge 为假时（planDub，以及 dubScript 的第一遍）不调任何要计费的能力。
 * unmergedCount 是并段（5b、5c）之前的段数：并段只会把几段并成一段，所以它是合成次数的上限。
 */
async function buildPlan(env, packInput, script, options, { askJudge }) {
  const settings = readOptions(options);
  const packs = packsOf(packInput);
  const many = packs.length > 1;
  const sources = readScript(script);
  const { lines, voices } = buildLines(sources, settings.labels);
  const owners = ownersOf(packs, lines, voices);
  const named = (pack, message) => (many ? `${pack.manifest.name}：${message}` : message); // 几个包时，说明里点名是哪个包

  const notes = [];
  const styled = hasCapability(env, 'style-instruction');
  const cued = hasCapability(env, 'style-cues');
  // 每个包各自的：挑参考（text-generation 的判断也在这里；计费的那一次在 askJudge 时才调）、读音词表、配音指引、增强件、脚本
  const perPack = new Map();
  for (const pack of packs) {
    const own = lines.filter((line) => owners[line.index] === pack);
    const { picks: picked, judge } = await pickReferences(env, pack.manifest, own.map((line) => ({ text: line.text, labels: line.labels, hints: line.hints, directions: line.directions })), askJudge ? REMOVE_UNRECOGNIZED : PLAN_ONLY);
    const picks = new Map(own.map((line, k) => [line.index, { ...picked[k], index: line.index }]));
    const lexicon = await pack.lexicon();
    const { rules, unapplied } = lexicon === null ? { rules: [], unapplied: [] } : lexiconRules(lexicon);
    const rawGuidance = settings.guidance === undefined ? await pack.guidance() : settings.guidance;
    // 新式指引（有三个小节中的任何一个）只交演法，没有演法就什么都不交；旧式（三个都没有）整段交（guidanceForModel）。要在拼之前取：下面 instruction 把说明和舞台提示接在指引后面，
    // 等适配器在拼好的串里取，演法之后的说明会被切掉，或被并进演法。
    const sentGuidance = guidanceForModel(rawGuidance) ?? rawGuidance;
    const guidance = fitGuidance(sentGuidance);
    if (guidance.truncated) notes.push({ code: 'guidance_truncated', message: named(pack, `配音指引有 ${count(sentGuidance)} 个字，超过 ${GUIDANCE_MAX}，截短以后才传给模型`), details: { chars: count(sentGuidance), max: GUIDANCE_MAX } });
    perPack.set(pack, { own, judge, picks, rules, unapplied, rawGuidance, guidance, offers: pack.enhancers('voice-cloning'), scripts: pack.scripts(FEATURE) });
  }

  const applied = new Map(); // 读音词表换了什么：同一个词、同一个读法的次数加起来（几个包的词表里一样的词，读法不同的分开记）
  let units = [];
  let styles = []; // 每一段要传给模型的：{ instructions（style-instruction 的说明全文，或 null）, cues（style-cues 的，或 null） }，跟着段走
  for (const line of lines) {
    const owner = owners[line.index];
    const mine = perPack.get(owner);
    const replaced = applyLexicon(line.text, mine.rules);
    for (const replacement of replaced.replacements) {
      const key = `${replacement.term}\u0000${replacement.say}`;
      const seen = applied.get(key);
      applied.set(key, seen === undefined ? { ...replacement } : { ...seen, count: seen.count + replacement.count });
    }
    const note = noteOf(line);
    const instruction = [mine.guidance.text, note].filter((part) => part !== null && part !== '');
    const instructions = instruction.length === 0 ? null : instruction.join('\n\n');
    const parts = partsOf(replaced.text, settings.maxChars);
    parts.forEach((spoken, partIndex) => {
      const first = partIndex === 0;
      const last = partIndex === parts.length - 1;
      const partCues = cuesOf(line, partIndex + 1);
      const cueNames = partCues.emotion !== null || partCues.style !== null;
      styles.push({ instructions: styled ? instructions : null, cues: cued && cueNames ? partCues : null });
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
        instructions: !styled ? { sent: false, reason: 'style_instruction_missing' } : instructions === null ? { sent: false, reason: 'nothing_to_send' } : { sent: true, ...(note === null ? {} : { line: note }) },
        cues: !cued ? { sent: false, reason: 'style_cues_missing' } : !cueNames ? { sent: false, reason: 'nothing_to_send' } : { sent: true, ...partCues },
        speed: line.speed,
        pauseBeforeMs: first ? line.pauseBeforeMs : 0,
        pauseAfterMs: last ? line.pauseAfterMs : 0,
        ...(last && line.join !== undefined ? { join: line.join } : {}),
        status: 'planned',
        enhancers: { offered: mine.offers.map((offer) => offer.id), used: [] },
        ...(many ? { pack: owner.manifest.id } : {}),
      });
    });
  }
  const unmergedCount = units.length; // 并段之前的段数：并段只会合并，所以它是合成次数的上限（dubScript 用来说费用）
  // 5b：有下限的，短句并段，并不了的那一段记成 failed（不调用能力，见文件头）。没有下限就什么都不做
  if (settings.minChars !== null) {
    const grouped = settings.joinShort ? joinShortUnits(units, styles, { min: settings.minChars, max: settings.maxChars }) : { units, styles };
    units = grouped.units;
    styles = grouped.styles;
    for (const unit of units) if (count(unit.spoken) < settings.minChars) { unit.status = 'failed'; unit.error = tooShortError(unit.spoken, settings.minChars); }
    const joined = units.filter((unit) => unit.joined !== undefined).length;
    if (joined > 0) notes.push({ code: 'short_lines_joined', message: `有 ${joined} 段是把比合成能力的下限（${settings.minChars} 个字）短的句子和相邻的句子并在一起合成的（同一个参考、同一个说明、同一个语速，中间没有停顿）`, details: { min: settings.minChars, units: joined } });
  }
  // 5c：段落内部的停顿并进一次请求（只在环境声明了 pause-in-text 时，见 pausesInRequest）
  const hasScripts = (unit) => perPack.get(ownerOfUnit(packs, unit)).scripts.length > 0;
  const paused = pausesInRequest(env, units, styles, { max: settings.maxChars ?? Number.POSITIVE_INFINITY, hasScripts });
  units = paused.units;
  styles = paused.styles;
  if (paused.joins > 0) notes.push({ code: 'pauses_in_request', message: `有 ${paused.joins} 处停顿并进了一次请求（写在文字里：<speak> 和 <break>，或者标点），这几处的停顿不再交给拼接的人`, details: { joins: paused.joins } });
  // 续接的段（unit.join）照旧两次请求，以「，、；：」结尾的，两段之间停 0.5 秒（这一处的 pauseAfterMs 定成 500；不以标点结尾的是 0）
  for (const unit of units) if (unit.join === 'continue' && unit.pauseAfterMs === 0 && endsMidSentence(unit.spoken)) unit.pauseAfterMs = JOIN_PUNCTUATION_PAUSE_MS;
  if (units.some((unit) => unit.speed !== null)) notes.push({ code: 'speed_not_applied', message: '合成能力不收语速：unit.speed 记着台本要求的语速（0.85 放慢、1.15 加快），拼接时按它处理', details: {} });
  // 包里没登记功能的脚本：每个包各自说（几个包时点名是哪个包）
  for (const pack of packs) {
    const unregistered = scriptsWithoutFeature(pack.scripts());
    if (unregistered.length > 0) {
      notes.push({
        code: 'scripts_without_feature',
        message: named(pack, `包里有 ${unregistered.length} 个脚本没有登记功能（清单里没写 feature）：${unregistered.map((item) => `${item.entry}（${item.runtime}）`).join('、')}；没登记功能的脚本不属于任何功能，配音只运行登记在 ${FEATURE} 名下的脚本，所以这次没有运行它们（要让配音运行，作者要在清单里把它们登记到 ${FEATURE} 名下；也可以照包的配音指引手动运行）`),
        scripts: unregistered,
        details: { scripts: unregistered },
      });
    }
  }

  // 要用到脚本运行时的包：几个包时只看这次真用到的（没有句子的包，不要它的运行时）
  const inUse = packsInUse(packs, units);
  const lexiconUnapplied = packs.flatMap((pack) => perPack.get(pack).unapplied);
  const plan = {
    pack: packInfo(packs[0]),
    lines: lines.map(({ index, source, chapter, span, voice, text, labels }) => ({ index, source, chapter, span, voice, text, labels })),
    units,
    judge: combineJudges(packs.map((pack) => perPack.get(pack).judge)),
    lexicon: { applied: [...applied.values()], unapplied: many ? uniqueJson(lexiconUnapplied) : lexiconUnapplied },
    guidance: guidanceSummary(packs.map((pack) => ({ rawGuidance: perPack.get(pack).rawGuidance, truncated: perPack.get(pack).guidance.truncated }))),
    enhancers: emptyEnhancers(mergedOffers(packs.map((pack) => perPack.get(pack).offers))),
    scripts: packs.flatMap((pack) => perPack.get(pack).scripts.map((entry) => ({ entry: entry.entry, runtime: entry.runtime, hooks: [...HOOKS], ...(many ? { pack: pack.manifest.id } : {}) }))),
    missingRuntimes: inUse.flatMap((pack) => missingScriptRuntimes(envFor(env, settings, pack), perPack.get(pack).scripts, FEATURE).map((item) => (many ? { ...item, pack: pack.manifest.id } : item))),
    capabilities: { 'voice-cloning': hasCapability(env, 'voice-cloning'), 'style-instruction': styled, 'style-cues': cued, 'pause-in-text': hasCapability(env, 'pause-in-text'), 'text-generation': hasCapability(env, 'text-generation') },
    notes,
    verification: many ? packs.flatMap((pack) => pack.manifest.verification ?? []) : (packs[0].manifest.verification ?? []),
    ...(many ? { packs: packs.map(packInfo) } : {}),
  };
  return { plan, styles, unmergedCount };
}

/**
 * 只规划，不合成，也不调任何要计费的能力（text-generation 判情绪是收费的：台本里有没带提示的句子时，judge 是 planned，写明正式运行会判几句）。
 * 规则和返回值见文件头。pack 可以是一个包，也可以是几个（数组，第一个是台本开头用的声音）。
 * @returns {Promise<object>} { pack, lines, units, judge, lexicon, guidance, enhancers, scripts, missingRuntimes, capabilities, notes, verification }（几个包时还有 packs）
 */
export async function planDub(env, pack, script, options = {}) {
  return (await buildPlan(env, pack, script, options, { askJudge: false })).plan;
}

// ---------------------------------------------------------------- 合成

/**
 * 规划，再合成。规则、选项和返回值见文件头。
 * @returns {Promise<object>} planDub 的返回值，加上 ok；units[i] 多了 status（ok / failed / skipped）、audio（{ bytes, mimeType }）、model、error，
 *   enhancers 是这一次的实际情况（用上了哪几个，没用上的有哪些）
 */
export async function dubScript(env, pack, script, options = {}) {
  const settings = readOptions(options);
  const packs = packsOf(pack);
  const ownerOf = (unit) => ownerOfUnit(packs, unit);
  // 第一遍：不调任何计费的能力（判情绪也不调），只为了定规划、交给 onPlan 说费用。判情绪在 onPlan 之后的第二遍里才调
  const draft = await buildPlan(env, packs, script, options, { askJudge: false });
  if (draft.plan.units.length === 0) throw new VoicePackError('dub_nothing_to_say', '台本里没有可说的话（只有标记和舞台提示）');
  // 编号是并段之后的（units[i].index，并段会重新编号）。花钱之前按第一遍的段数查；第二遍的并段可能不一样（判出来的参考不同），
  // 所以第二遍之后再按它的段数查一次，还没开始合成
  const checkOnly = (length) => {
    if (settings.only !== undefined && (!Array.isArray(settings.only) || settings.only.some((index) => !Number.isInteger(index) || index < 0 || index >= length))) {
      throw invalid('only', `only 必须是数组，里面是 0–${length - 1} 的整数（规划里每一段的编号）`);
    }
  };
  checkOnly(draft.plan.units.length);
  const only = settings.only === undefined ? null : new Set(settings.only);
  const chosen = (index) => only === null || only.has(index);

  // 花钱之前把该有的都核对好：能力、脚本的运行时（判情绪也是花钱的，所以在它之前）
  const clone = requireCapability(env, 'voice-cloning');
  for (const owner of packsInUse(packs, draft.plan.units)) assertScriptRuntimes(envFor(env, settings, owner), owner.scripts(FEATURE), FEATURE);
  // 不做的几段标成 skipped，在 onPlan 之前（onPlan 看到的就是这个状态）
  for (const unit of draft.plan.units) if (unit.status === 'planned' && !chosen(unit.index)) unit.status = 'skipped';
  // 要合成几次。判情绪还没调的时候，并段要等它的结果，只能说上限：每个选中的编号最多选中一段，所以不会多于并段之前的段数，也不会多于选中的编号个数；
  // 不判情绪的，规划就是最后的，次数是准的
  const calls = draft.plan.judge.status === 'planned'
    ? { count: only === null ? draft.unmergedCount : Math.min(only.size, draft.unmergedCount), exact: false }
    : { count: draft.plan.units.filter((unit) => unit.status === 'planned').length, exact: true };
  await settings.onPlan?.(draft.plan, { calls }); // 花钱之前：该核对的都核对过了，一次计费的调用都还没发生；调用方在这里说明费用、检查输出位置，抛错就停

  // 第二遍：判情绪（计费）在这里调，挑参考和并段按它的结果定。交出去的那一份（draft.plan）就是最后返回的：内容整个换成第二遍的，对象不换
  const second = await buildPlan(env, packs, script, options, { askJudge: true });
  checkOnly(second.plan.units.length);
  const plan = Object.assign(draft.plan, second.plan);
  const { styles } = second;
  // 规划里已经记成 failed 的（比下限短、并不了的）不调用能力：不进要做的，也不标成 skipped
  const todo = plan.units.filter((unit) => unit.status === 'planned' && chosen(unit.index));
  for (const unit of plan.units) if (unit.status === 'planned' && !todo.includes(unit)) unit.status = 'skipped';
  // 参考按（哪个包，哪一段）取一次：几个包的参考段 id 可能一样，所以带上包 ID
  const referenceKey = (unit) => `${unit.pack ?? ''}\u0000${unit.pick.segmentId}`;
  const references = new Map();
  for (const unit of todo) {
    if (!references.has(referenceKey(unit))) references.set(referenceKey(unit), await ownerOf(unit).referenceClip(unit.pick.segmentId));
  }
  for (const unit of plan.units) if (unit.status === 'failed') await settings.onUnit?.(unit); // 规划时就做完的（比下限短）：交出去，和别的段一样

  const hookUnit = (unit, spoken) => ({
    index: unit.index, line: unit.line, part: unit.part, parts: unit.parts, chapter: unit.chapter, text: spoken,
    language: unit.pick.wanted.language, emotion: unit.pick.wanted.emotion, style: unit.pick.wanted.style, segment: unit.pick.segmentId,
  });

  // 连着被拒的保护（TEXT_REJECTED_LIMIT，见文件头）：rejected 记服务商拒的段（调用之前查出来的不记）；还没有一句成功、被拒够了，就 stopped，之后开始的段都不做
  const rejected = [];
  let succeeded = false;
  let stopped = false;
  async function runUnit(unit) {
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
    if (settings.minChars !== null && count(spoken) < settings.minChars) {
      unit.status = 'failed';
      unit.spoken = spoken;
      unit.error = tooShortError(spoken, settings.minChars);
      await settings.onUnit?.(unit);
      return;
    }
    const { segment, clip } = references.get(referenceKey(unit));
    const call = { text: unit.ssml ?? spoken, ref_audio: clip, ref_text: segment.text };
    if (unit.join === 'continue') call.continues = true; // 续接的段：能力补字时补「，」
    if (unit.instructions.sent) call.instructions = styles[unit.index].instructions;
    if (unit.cues.sent) call.cues = styles[unit.index].cues;
    if (offers.length > 0) call.enhancers = offers;

    let result;
    try {
      result = await clone(call);
    } catch (error) {
      if (isServiceError(error) || isTextRejected(error)) {
        unit.status = 'failed';
        unit.spoken = spoken;
        unit.error = summarizeError(error);
        if (isTextRejected(error) && !checkedBeforeCall(error)) { // 服务商拒的这一句才数；调用之前查出来的只记这一句失败（见 checkedBeforeCall）
          rejected.push(unit);
          if (!succeeded && rejected.length >= TEXT_REJECTED_LIMIT) stopped = true; // 在 await onUnit 之前记下，这之后开始的段都不做
        }
        await settings.onUnit?.(unit);
        return;
      }
      throw error;
    }
    const used = readAudioResult('voice-cloning', result, offers);
    let audio = { bytes: result.bytes, mimeType: result.mimeType };
    for (const entry of scripts) {
      const output = await runScript(runtimes, owner, entry, { feature: FEATURE, hook: 'audio', unit: { ...hookUnit(unit, spoken), ...audioForScript(audio) } });
      if (output.audio !== undefined) audio = { bytes: fromBase64(output.audio), mimeType: output.mimeType ?? audio.mimeType };
    }
    unit.status = 'ok';
    succeeded = true;
    unit.spoken = spoken;
    unit.audio = audio;
    if (typeof result.model === 'string') unit.model = result.model;
    unit.enhancers = { offered: unit.enhancers.offered, used };
    await settings.onUnit?.(unit);
  }

  await pool(todo, settings.concurrency, runUnit);
  if (stopped) throw textRejectedStop(rejected); // 在做的几段都做完了（pool 等它们），再抛

  const finished = plan.units.filter((unit) => unit.status === 'ok');
  return { ok: plan.units.every((unit) => unit.status !== 'failed'), ...plan, enhancers: summarizeUse(mergedOffers(packs.map((pack) => pack.enhancers('voice-cloning'))), finished, plan.verification) };
}

// ---------------------------------------------------------------- 几个包：小工具（一个包时各自都是原来的样子）

/** 段属于哪个包：unit.pack 只在几个包时才有；没有就是给的那一个（第一个）。 */
function ownerOfUnit(packs, unit) {
  if (unit.pack === undefined) return packs[0];
  const owner = packs.find((pack) => pack.manifest.id === unit.pack);
  if (owner === undefined) throw new Error(`段 ${unit.index} 记着的包 ${unit.pack} 不在这次给的包里`);
  return owner;
}

/** 用到的包：一个包时就是它；几个包时只要有句子在它里面的（没有句子的包，不要它的运行时）。 */
function packsInUse(packs, units) {
  if (packs.length === 1) return packs;
  return packs.filter((pack) => units.some((unit) => ownerOfUnit(packs, unit) === pack));
}

/** 一个包的身份（plan.pack，几个包时还有 plan.packs 里的每一项）。 */
const packInfo = (pack) => ({ id: pack.manifest.id, name: pack.manifest.name, version: pack.manifest.version });

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
 * 配音指引的概况（plan.guidance）。entries 是每个包一项 { rawGuidance, truncated }：一个包时就是原来的 { present, chars, truncated }；
 * 几个包时 present 和 truncated 取任一个有的，chars 相加。
 */
function guidanceSummary(entries) {
  return {
    present: entries.some((entry) => entry.rawGuidance !== null && entry.rawGuidance !== undefined),
    chars: entries.reduce((sum, entry) => sum + (entry.rawGuidance ? count(entry.rawGuidance) : 0), 0),
    truncated: entries.some((entry) => entry.truncated),
  };
}

/** 几个包各自声明的增强件合在一起，按 id 去重（同一个 id 只留第一个）；一个包时原样返回它的那一份。 */
function mergedOffers(lists) {
  if (lists.length === 1) return lists[0];
  const seen = new Map();
  for (const list of lists) for (const offer of list) if (!seen.has(offer.id)) seen.set(offer.id, offer);
  return [...seen.values()];
}
