// SPDX-License-Identifier: Apache-2.0
//
// 用音色包给一段台本配音（流程层）。
//   @capability voice-cloning       按挑中的参考合成每一句（签名在 vocab/capability-signatures.md）
//   @capability style-instruction   可选：环境声明有它，才把配音指引、这一句的说明通过 instructions 传给模型
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
//   超过的按句子切开；默认不切）、only（只合成这几段，编号是规划里的 units[i].index，别的标成 skipped；失败后重做用）、
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
//   6 脚本（lib/pack-script.mjs）：登记在 dub 功能名下的脚本，合成之前跑 text 钩子（可以改要说的话），合成之后跑 audio 钩子（可以换音频）。
//     清单里没写 feature 的脚本不属于任何功能，不运行；规划和正式运行的 notes 里都有一条 scripts_without_feature 点名它们（字段见下面「说明」），
//     说明这次没有运行和原因。
//   7 合成：voice-cloning，参数 { text, ref_audio, ref_text, instructions?, enhancers? }。
//      instructions：环境有 style-instruction 才传（配音指引，加上调用方给这一项的说明和这一句的舞台提示），没有就整个不传这个键，
//      返回值里说明没传和原因。配音指引过长（超过 2000 个字）截短再传，并记一条 guidance_truncated。
//      enhancers：包里服务 voice-cloning 的增强件，以 { id, model, modelVersion, referenceVersion, capability, load } 递给能力，load() 才读文件。
//      环境认识对应的模型就用上，并在返回里用 enhancers_used 报出用了哪几个（id）；不认识的会忽略 enhancers，照常生成。
//      这一次有没有用上增强件，写在 enhancers 里：一个都没用上、而包里有，statement 是 'enhancers_not_used'，附上没用上的增强件是哪个模型的，
//      和包的验证记录（verification），让人知道当前环境下效果会差多少。
//
// 语速和停顿：合成能力不收语速，停顿也不是合成出来的。unit.speed（0.85 放慢、1.15 加快、null 没要求）、unit.pauseBeforeMs、unit.pauseAfterMs、
// unit.join 如实记着，拼接的人（命令行的使用者、ffmpeg）按它们处理；有语速要求时 notes 里有一条 speed_not_applied。
// 停顿有两个来源：台本标记 [pause …] 和舞台提示（（停顿 3 秒），一行里只有它时挂到前一句的后面，规则见 lib/line-hints.mjs）。同一处两样相加，
// 加起来不超过 PAUSE_MAX_MS（tools/markup.mjs，[pause …] 的上限）；前一句的后面加后一句的前面（同一个缝）也不超过它，超过的从后一句的前面扣。
//
// 一段失败了怎么办：能力抛的错如果标了 details.transient（服务暂时出错，约定见 vocab/capability-signatures.md），这一段记成 failed
// （unit.error 是 { code, message, details }），别的段照常做，整体 ok 是 false；调用方可以事后用 only 重做。别的错（401、参数错、
// 返回的形状不对……）一律停下来：不再开始新的段，等已经在做的段做完，错误原样往上抛。每一段做完（成功或失败）立刻交给 onUnit，
// 所以停下来的时候，已经做完的不会丢。
//
// 环境缺东西：规划（planDub）不抛错，只在 capabilities 和 missingRuntimes 里说明缺什么；dubScript 在花钱之前抛：
//   capability_missing  缺 voice-cloning（details.capability）
//   runtime_missing     脚本要的运行时环境没有（details: { runtime, entry, feature }）
// 只有配音用到的才报；缺 text-generation、style-instruction 都不是错误。
//
// 说明（返回值里的 notes：[{ code, message, details }]，规划和正式运行都有；message 是给人看的中文，details 是它说的那些事实，没有要说的数就是空对象）：
//   guidance_truncated       配音指引超过 2000 个字，截短以后才传给模型。details: { chars, max }：指引原来有多少个字、最多传多少个字
//   speed_not_applied        台本有语速要求，合成能力不收语速，要拼接的人按 unit.speed 处理。details: {}
//   scripts_without_feature  包里有没登记功能的脚本，这次没有运行。details: { scripts }，scripts 是 [{ entry, runtime }]；note.scripts 是同一份，是原来的写法，留着给已有的读者
//
// 抛出的错误（VoicePackError；code 小写下划线，details 里放什么在抛出处写明）：
//   dub_input_invalid        输入不合约定：台本不是字符串或数组、项没有 text、only 或 maxChars 或 concurrency 不对。details.field
//   dub_nothing_to_say       台本里没有可说的话（只有标记和提示）
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
import { readDirections } from './line-hints.mjs';
import { pickReferences } from './reference-pick.mjs';
import { lexiconRules, applyLexicon } from './pronunciation-lexicon.mjs';
import { assertScriptRuntimes, missingScriptRuntimes, scriptsWithoutFeature, runScript, audioForScript, HOOKS } from './pack-script.mjs';
import { readAudioResult, summarizeOffer, summarizeUse } from './enhancers.mjs';
import { isServiceError, summarizeError, pool } from './capability-calls.mjs';

export const FEATURE = 'dub';
const GUIDANCE_MAX = 2000;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 8;
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
  return { concurrency, maxChars, onUnit: options.onUnit, onPlan: options.onPlan, labels: options.labels, guidance: options.guidance, only: options.only };
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
    const joined = current === '' ? sentence : `${current}${CJK_END.test(current) ? '' : ' '}${sentence}`;
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

// ---------------------------------------------------------------- 传给模型的说明

/** 配音指引截到上限以内。尽量在段落边界截；返回 { text, truncated }。 */
function fitGuidance(guidance) {
  if (guidance === null || count(guidance) <= GUIDANCE_MAX) return { text: guidance, truncated: false };
  const head = [...guidance].slice(0, GUIDANCE_MAX).join('');
  const cut = head.lastIndexOf('\n\n');
  return { text: (cut > GUIDANCE_MAX / 2 ? head.slice(0, cut) : head).trim(), truncated: true };
}

/** 这一句的说明：调用方给的，加上管着这一句的舞台提示（从最后一个有情绪或风格的提示起，没有就全部）。原样用作者的词。 */
function noteOf(line) {
  const last = line.directions.map((d) => d.emotion !== null || d.style !== null).lastIndexOf(true);
  const governing = line.directions.slice(Math.max(last, 0)).map((d) => d.raw);
  const parts = [line.instructions, ...governing].filter((part) => typeof part === 'string' && part.trim() !== '');
  return parts.length === 0 ? null : [...new Set(parts)].join('；');
}

// ---------------------------------------------------------------- 规划

const emptyEnhancers = (offers) => ({ offered: offers.map(summarizeOffer), used: [], notUsed: [], statement: null });

/**
 * 规划：返回 { plan, instructionTexts }。instructionTexts[i] 是第 i 段真要传给模型的说明全文（环境没有 style-instruction 或没有可传的是 null）；
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

  const offers = pack.enhancers('voice-cloning');
  const scripts = pack.scripts(FEATURE);

  const units = [];
  const instructionTexts = [];
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
      instructionTexts.push(styled ? instructions : null);
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
        speed: line.speed,
        pauseBeforeMs: first ? line.pauseBeforeMs : 0,
        pauseAfterMs: last ? line.pauseAfterMs : 0,
        ...(last && line.join !== undefined ? { join: line.join } : {}),
        status: 'planned',
        enhancers: { offered: offers.map((offer) => offer.id), used: [] },
      });
    });
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
    capabilities: { 'voice-cloning': hasCapability(env, 'voice-cloning'), 'style-instruction': styled, 'text-generation': hasCapability(env, 'text-generation') },
    notes,
    verification: pack.manifest.verification ?? [],
  };
  return { plan, instructionTexts };
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
  const { plan, instructionTexts } = await buildPlan(env, pack, script, options, { planOnly: false });
  if (plan.units.length === 0) throw new VoicePackError('dub_nothing_to_say', '台本里没有可说的话（只有标记和舞台提示）');
  if (settings.only !== undefined && (!Array.isArray(settings.only) || settings.only.some((index) => !Number.isInteger(index) || index < 0 || index >= plan.units.length))) {
    throw invalid('only', `only 必须是数组，里面是 0–${plan.units.length - 1} 的整数（规划里每一段的编号）`);
  }
  const only = settings.only === undefined ? null : new Set(settings.only);

  // 花钱之前把该有的都核对好：能力、脚本的运行时、会用到的参考音频
  const clone = requireCapability(env, 'voice-cloning');
  assertScriptRuntimes(env, pack.scripts(FEATURE), FEATURE);
  const todo = plan.units.filter((unit) => only === null || only.has(unit.index));
  for (const unit of plan.units) if (!todo.includes(unit)) unit.status = 'skipped';
  const references = new Map();
  for (const segmentId of new Set(todo.map((unit) => unit.pick.segmentId))) references.set(segmentId, await pack.referenceClip(segmentId));
  await settings.onPlan?.(plan); // 花钱之前：该核对的都核对过了，一次合成都还没发生；调用方在这里说明费用、检查输出位置，抛错就停

  const offers = pack.enhancers('voice-cloning');
  const scripts = pack.scripts(FEATURE);
  const hookUnit = (unit, spoken) => ({
    index: unit.index, line: unit.line, part: unit.part, parts: unit.parts, chapter: unit.chapter, text: spoken,
    language: unit.pick.wanted.language, emotion: unit.pick.wanted.emotion, style: unit.pick.wanted.style, segment: unit.pick.segmentId,
  });

  async function runUnit(unit) {
    let spoken = unit.spoken;
    for (const entry of scripts) {
      const output = await runScript(env, pack, entry, { feature: FEATURE, hook: 'text', unit: hookUnit(unit, spoken) });
      if (output.text !== undefined) spoken = output.text;
    }
    const { segment, clip } = references.get(unit.pick.segmentId);
    const call = { text: spoken, ref_audio: clip, ref_text: segment.text };
    if (unit.instructions.sent) call.instructions = instructionTexts[unit.index];
    if (offers.length > 0) call.enhancers = offers;

    let result;
    try {
      result = await clone(call);
    } catch (error) {
      if (isServiceError(error)) {
        unit.status = 'failed';
        unit.spoken = spoken;
        unit.error = summarizeError(error);
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
    unit.spoken = spoken;
    unit.audio = audio;
    if (typeof result.model === 'string') unit.model = result.model;
    unit.enhancers = { offered: unit.enhancers.offered, used };
    await settings.onUnit?.(unit);
  }

  await pool(todo, settings.concurrency, runUnit);

  return { ok: plan.units.every((unit) => unit.status !== 'failed'), ...plan, enhancers: summarizeUse(offers, plan.units.filter((unit) => unit.status === 'ok'), plan.verification) };
}
