// SPDX-License-Identifier: Apache-2.0
//
// 用音色包给一段台本配音（流程层）。
//   @capability voice-cloning       按挑中的参考合成每一句（签名在 vocab/capability-signatures.md）
//   @capability style-instruction   可选：环境声明有它，才把配音指引、这一句的说明通过 instructions 传给模型
//   @capability style-cues          可选：环境声明有它，才把这一句自己的舞台提示认出来的名字（情绪、风格）通过 cues 传给模型；语速、停顿和配音指引都不进去
//   @capability text-generation     可选：台本里没有任何提示时，让它判断每句的情绪、风格（在 lib/reference-pick.mjs 里用）
//
//   const plan   = await planDub(env, pack, script, options);   只规划，不合成：每一段话挑了哪一段参考、为什么、读音词表换了什么。不花钱：不调任何要计费的能力，
//                                                               text-generation 也不调（要判情绪的句子，plan.judge 是 { status: 'planned', capability, lines }，写明正式运行会判几句，这几句现在用默认参考）
//   const result = await dubScript(env, pack, script, options); 规划，再合成
// pack 是 lib/voice-pack.mjs 的 openVoicePack 打开的角色部分。库不碰文件系统：合成出来的音频是字节，写成文件是命令行层的事。
//
// 台本（script）：一个字符串（带台本标记的整段台本），或者一个数组，每项是
//   { text, labels?, instructions? }   text 是带标记的台本；labels 是调用方给这一项的标签 { language, emotion, style, energy }；
//                                      instructions 是调用方给这一项的说明（agent 读了配音指引以后想补的话）。
// options：labels（给所有项的默认标签，项自己的盖过它）、concurrency（并发数，默认 2，1–8）、maxChars（一次合成最多多少个字，
//   超过的按句子切开；默认不切）、minChars（合成能力一次至少多少个字，环境声明的；默认没有下限，见第 5b 步）、joinShort（默认 true；
//   false 就不并短句，只按下限认：试合成用，每条留出录音一段）、only（只合成这几段，编号是规划里的 units[i].index，别的标成 skipped；失败后重做用）、
//   guidance（配音指引的正文；不给就用包里的，给 null 就不用）、onUnit（每一段做完，立刻交给它；见下）、
//   onPlan（规划好、该核对的都核对过、还没开始合成的时候交给它；命令行用它说明费用，抛错就不合成。交出去的 plan 就是最后返回的那份，
//   后面每一段的结果会写在它的 units 上）。
//
// 一句话是怎么变成合成的（顺序就是这样）：
//   1 解析台本标记（tools/markup.mjs）：章节、停顿、语速、[voice:]。[voice:名字] 的名字必须是这个包（名字或包 ID，不分大小写），
//     别的名字报 voice_unknown：一个包只有一个声音，换声音的台本需要别的包，不悄悄用这个包去念。
//   2 读舞台提示（lib/line-hints.mjs）：括号里的（耳语）、*笑* 变成这一段的情绪、风格、停顿、语速，从要说的话里拿掉。
//     括号里词表认不出的内容（（画外音））配音时也拿掉，不念；如实记在这一段的 pick.directions 里（recognized 为 false）。
//   3 每一段挑参考（lib/reference-pick.mjs）：调用方的标签、台本里的提示、text-generation 的判断、默认参考。理由放在 units[i].pick 里。
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
//   7 合成：voice-cloning，参数 { text, ref_audio, ref_text, instructions?, cues?, enhancers? }。
//      instructions：环境有 style-instruction 才传（配音指引，加上调用方给这一项的说明和这一句的舞台提示），没有就整个不传这个键，
//      返回值里说明没传和原因。配音指引过长（超过 2000 个字）截短再传，并记一条 guidance_truncated。
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
//   voice_unknown            台本里的 [voice:名字] 不是这个包。details: { voices（台本里不认识的名字）, pack: { id, name } }
//   capability_result_invalid  voice-cloning 的返回不合约定（不是 { bytes, mimeType }、enhancers_used 报了没递给它的增强件）。details: { capability, problem }
//   另外 pick_input_invalid（标签不对）、lexicon_invalid、script_*、file_missing（清单里列了、包里没有）等来自各自的模块。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { hasCapability, requireCapability } from '../protocol/lib/env.mjs';
import { fromBase64 } from '../protocol/lib/bytes.mjs';
import { parseScript, SPEED, PAUSE_MAX_MS } from '../tools/markup.mjs';
import { splitSentences } from '../tools/sentences.mjs';
import { readDirections, canonicalLabel } from './line-hints.mjs';
import cues from '../vocab/cues.json' with { type: 'json' };
import { pickReferences } from './reference-pick.mjs';
import { lexiconRules, applyLexicon } from './pronunciation-lexicon.mjs';
import { assertScriptRuntimes, missingScriptRuntimes, scriptsWithoutFeature, runScript, audioForScript, HOOKS } from './pack-script.mjs';
import { readAudioResult, summarizeOffer, summarizeUse } from './enhancers.mjs';
import { isServiceError, isTextRejected, summarizeError, pool } from './capability-calls.mjs';

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
  return { concurrency, maxChars, minChars, joinShort: options.joinShort ?? true, onUnit: options.onUnit, onPlan: options.onPlan, labels: options.labels, guidance: options.guidance, only: options.only };
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
  if (before.speed !== after.speed || before.pick.segmentId !== after.pick.segmentId || JSON.stringify(beforeStyle) !== JSON.stringify(afterStyle)) return false;
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
 * 规划：返回 { plan, styles }。styles[i] 是第 i 段真要传给模型的 { instructions, cues }（环境没有 style-instruction 时 instructions 是 null，没有 style-cues 时 cues 是 null）；
 * 全文可能很长，不放进每一段的记录里，只有合成的人拿它。planOnly 为真时（planDub）不调任何要计费的能力。
 */
async function buildPlan(env, pack, script, options, { planOnly }) {
  const settings = readOptions(options);
  const sources = readScript(script);
  const { lines, voices } = buildLines(sources, settings.labels);

  const names = new Set([pack.manifest.id, pack.manifest.name].map((name) => name.trim().toLowerCase()));
  const strangers = [...new Set(voices.filter((voice) => !names.has(voice.trim().toLowerCase())))];
  if (strangers.length > 0) {
    throw new VoicePackError('voice_unknown', `台本里的 [voice:${strangers.join('、')}] 不是这个包（${pack.manifest.name}，${pack.manifest.id}）：一个包只有一个声音，换声音的台本需要别的包`, { details: { voices: strangers, pack: { id: pack.manifest.id, name: pack.manifest.name } } });
  }

  const notes = [];
  const { picks, judge } = await pickReferences(env, pack.manifest, lines.map((line) => ({ text: line.text, labels: line.labels, hints: line.hints, directions: line.directions })), planOnly ? PLAN_ONLY : REMOVE_UNRECOGNIZED);

  const lexicon = await pack.lexicon();
  const { rules, unapplied } = lexicon === null ? { rules: [], unapplied: [] } : lexiconRules(lexicon);
  const applied = new Map();

  const rawGuidance = settings.guidance === undefined ? await pack.guidance() : settings.guidance;
  const guidance = fitGuidance(rawGuidance);
  if (guidance.truncated) notes.push({ code: 'guidance_truncated', message: `配音指引有 ${count(rawGuidance)} 个字，超过 ${GUIDANCE_MAX}，截短以后才传给模型`, details: { chars: count(rawGuidance), max: GUIDANCE_MAX } });
  const styled = hasCapability(env, 'style-instruction');
  const cued = hasCapability(env, 'style-cues');

  const offers = pack.enhancers('voice-cloning');
  const scripts = pack.scripts(FEATURE);

  let units = [];
  let styles = []; // 每一段要传给模型的：{ instructions（style-instruction 的说明全文，或 null）, cues（style-cues 的，或 null） }，跟着段走
  for (const line of lines) {
    const replaced = applyLexicon(line.text, rules);
    for (const replacement of replaced.replacements) {
      const seen = applied.get(replacement.term);
      applied.set(replacement.term, seen === undefined ? { ...replacement } : { ...seen, count: seen.count + replacement.count });
    }
    const note = noteOf(line);
    const instruction = [guidance.text, note].filter((part) => part !== null && part !== '');
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
        pick: picks[line.index],
        instructions: !styled ? { sent: false, reason: 'style_instruction_missing' } : instructions === null ? { sent: false, reason: 'nothing_to_send' } : { sent: true, ...(note === null ? {} : { line: note }) },
        cues: !cued ? { sent: false, reason: 'style_cues_missing' } : !cueNames ? { sent: false, reason: 'nothing_to_send' } : { sent: true, ...partCues },
        speed: line.speed,
        pauseBeforeMs: first ? line.pauseBeforeMs : 0,
        pauseAfterMs: last ? line.pauseAfterMs : 0,
        ...(last && line.join !== undefined ? { join: line.join } : {}),
        status: 'planned',
        enhancers: { offered: offers.map((offer) => offer.id), used: [] },
      });
    });
  }
  // 5b：有下限的，短句并段，并不了的那一段记成 failed（不调用能力，见文件头）。没有下限就什么都不做
  if (settings.minChars !== null) {
    const grouped = settings.joinShort ? joinShortUnits(units, styles, { min: settings.minChars, max: settings.maxChars }) : { units, styles };
    units = grouped.units;
    styles = grouped.styles;
    for (const unit of units) if (count(unit.spoken) < settings.minChars) { unit.status = 'failed'; unit.error = tooShortError(unit.spoken, settings.minChars); }
    const joined = units.filter((unit) => unit.joined !== undefined).length;
    if (joined > 0) notes.push({ code: 'short_lines_joined', message: `有 ${joined} 段是把比合成能力的下限（${settings.minChars} 个字）短的句子和相邻的句子并在一起合成的（同一个参考、同一个说明、同一个语速，中间没有停顿）`, details: { min: settings.minChars, units: joined } });
  }
  if (units.some((unit) => unit.speed !== null)) notes.push({ code: 'speed_not_applied', message: '合成能力不收语速：unit.speed 记着台本要求的语速（0.85 放慢、1.15 加快），拼接时按它处理', details: {} });
  const unregistered = scriptsWithoutFeature(pack.scripts());
  if (unregistered.length > 0) {
    notes.push({
      code: 'scripts_without_feature',
      message: `包里有 ${unregistered.length} 个脚本没有登记功能（清单里没写 feature）：${unregistered.map((item) => `${item.entry}（${item.runtime}）`).join('、')}；没登记功能的脚本不属于任何功能，配音只运行登记在 ${FEATURE} 名下的脚本，所以这次没有运行它们（要让配音运行，作者要在清单里把它们登记到 ${FEATURE} 名下；也可以照包的配音指引手动运行）`,
      scripts: unregistered,
      details: { scripts: unregistered },
    });
  }

  const plan = {
    pack: { id: pack.manifest.id, name: pack.manifest.name, version: pack.manifest.version },
    lines: lines.map(({ index, source, chapter, span, voice, text, labels }) => ({ index, source, chapter, span, voice, text, labels })),
    units,
    judge,
    lexicon: { applied: [...applied.values()], unapplied },
    guidance: { present: rawGuidance !== null && rawGuidance !== undefined, chars: rawGuidance ? count(rawGuidance) : 0, truncated: guidance.truncated },
    enhancers: emptyEnhancers(offers),
    scripts: scripts.map((entry) => ({ entry: entry.entry, runtime: entry.runtime, hooks: [...HOOKS] })),
    missingRuntimes: missingScriptRuntimes(env, scripts, FEATURE),
    capabilities: { 'voice-cloning': hasCapability(env, 'voice-cloning'), 'style-instruction': styled, 'style-cues': cued, 'text-generation': hasCapability(env, 'text-generation') },
    notes,
    verification: pack.manifest.verification ?? [],
  };
  return { plan, styles };
}

/**
 * 只规划，不合成，也不调任何要计费的能力（text-generation 判情绪是收费的：台本里有没带提示的句子时，judge 是 planned，写明正式运行会判几句）。
 * 规则和返回值见文件头。
 * @returns {Promise<object>} { pack, lines, units, judge, lexicon, guidance, enhancers, scripts, missingRuntimes, capabilities, notes, verification }
 */
export async function planDub(env, pack, script, options = {}) {
  return (await buildPlan(env, pack, script, options, { planOnly: true })).plan;
}

// ---------------------------------------------------------------- 合成

/**
 * 规划，再合成。规则、选项和返回值见文件头。
 * @returns {Promise<object>} planDub 的返回值，加上 ok；units[i] 多了 status（ok / failed / skipped）、audio（{ bytes, mimeType }）、model、error，
 *   enhancers 是这一次的实际情况（用上了哪几个，没用上的有哪些）
 */
export async function dubScript(env, pack, script, options = {}) {
  const settings = readOptions(options);
  const { plan, styles } = await buildPlan(env, pack, script, options, { planOnly: false });
  if (plan.units.length === 0) throw new VoicePackError('dub_nothing_to_say', '台本里没有可说的话（只有标记和舞台提示）');
  if (settings.only !== undefined && (!Array.isArray(settings.only) || settings.only.some((index) => !Number.isInteger(index) || index < 0 || index >= plan.units.length))) {
    throw invalid('only', `only 必须是数组，里面是 0–${plan.units.length - 1} 的整数（规划里每一段的编号）`);
  }
  const only = settings.only === undefined ? null : new Set(settings.only);

  // 花钱之前把该有的都核对好：能力、脚本的运行时、会用到的参考音频
  const clone = requireCapability(env, 'voice-cloning');
  assertScriptRuntimes(env, pack.scripts(FEATURE), FEATURE);
  // 规划里已经记成 failed 的（比下限短、并不了的）不调用能力：不进要做的，也不标成 skipped
  const todo = plan.units.filter((unit) => unit.status === 'planned' && (only === null || only.has(unit.index)));
  for (const unit of plan.units) if (unit.status === 'planned' && !todo.includes(unit)) unit.status = 'skipped';
  const references = new Map();
  for (const segmentId of new Set(todo.map((unit) => unit.pick.segmentId))) references.set(segmentId, await pack.referenceClip(segmentId));
  await settings.onPlan?.(plan); // 花钱之前：该核对的都核对过了，一次合成都还没发生；调用方在这里说明费用、检查输出位置，抛错就停
  for (const unit of plan.units) if (unit.status === 'failed') await settings.onUnit?.(unit); // 规划时就做完的（比下限短）：交出去，和别的段一样

  const offers = pack.enhancers('voice-cloning');
  const scripts = pack.scripts(FEATURE);
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
    let spoken = unit.spoken;
    for (const entry of scripts) {
      const output = await runScript(env, pack, entry, { feature: FEATURE, hook: 'text', unit: hookUnit(unit, spoken) });
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
    const { segment, clip } = references.get(unit.pick.segmentId);
    const call = { text: spoken, ref_audio: clip, ref_text: segment.text };
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
      const output = await runScript(env, pack, entry, { feature: FEATURE, hook: 'audio', unit: { ...hookUnit(unit, spoken), ...audioForScript(audio) } });
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

  return { ok: plan.units.every((unit) => unit.status !== 'failed'), ...plan, enhancers: summarizeUse(offers, plan.units.filter((unit) => unit.status === 'ok'), plan.verification) };
}
