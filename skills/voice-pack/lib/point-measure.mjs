// SPDX-License-Identifier: Apache-2.0
//
// 量一段参考录音每个点位的特征（流程层）：切语音块、每块转写一次、把块对到逐字稿的字上、算每块前面的停顿和每个分句每秒几个字，换算成提示标注里的停顿和快慢标记。
//   @capability automatic-speech-recognition  每块转写一次（签名在 vocab/capability-signatures.md）
// 只做计算和转写，不判好坏：写出来的是量到的事，好不好由听的人定。标提示标注的第二半在这里（第一半是听，lib/segment-annotation.mjs），由 lib/make-pack-annotation.mjs 接起来。
// 下面的门槛（标着「从一段参考定的」）都是从一段参考录音定的，别的声音、别的语言没有量过。
// 太短的块、转写和时长不相称、可用的块太少这几项（CHUNK_MIN_SECONDS、CHUNK_TOKENS_SLACK、CHUNK_TOKENS_PER_SECOND_MAX、ALIGN_USABLE_MIN）是从四个声音的量到的块推断的：
//   0.01 秒的尖峰被转写成一句话，0.11 秒的块被转写成十几个字，一块的回答是拒答。英文这类按词数的语言，每秒 12 个词宽得多，只拦得住编造的转写，没有在英文上量过。
//
// 怎么量（measurePoints；一段的第一步是 decodeAudio，混成单声道）：
//   先调响度：options.loudness 给了（做包用的调响度设置，lib/make-pack-loudness.mjs 的 adjustedAudio），先在内存里把这一段调到目标响度再切块、转写：下面的静音门槛是固定的电平，
//     在原电平上，小声的录音（林岚的默认段 −35.5 LUFS）字和字之间都被当成停顿，切成 11 块、写了 9 处 [short pause]；调到 −20 LUFS 是 7 块（t03 的读数）。不给（关了调响度，--no-loudness）就照原电平。
//   切块（speechChunks）：SILENCE_WINDOW_SECONDS（5 毫秒）一窗，窗里的峰值低于 SILENCE_PEAK_DBFS（-30 dBFS）算静音；连续静音 ≥ SILENCE_MIN_SECONDS（0.05 秒）才算停顿，切开前后两块；两头的静音不算停顿。
//     门槛比 tools/silence-split.mjs 严（那边切的是句，这里要切开词之间短到 0.29 秒的停顿：「却懂得｜怜香惜玉」）。
//     太短的块不是语音：短于 CHUNK_MIN_SECONDS（0.05 秒）的块在切块时就去掉，不转写，它前后两块之间的静音（前一块的末尾到后一块的开头）算成一段停顿；在两头的，那头的静音照旧不算停顿。
//     去掉以后块还多于 POINT_CHUNKS_MAX（24）就从最短的停顿起并回去，并到 24 块为止，
//     转写之前就定下来：这是规划里「转写最多调几次」的依据（lib/make-pack-plan.mjs）。
//   转写：每块两边各带 CHUNK_PADDING_SECONDS（0.06 秒，不超出录音），encodeWav 成 WAV 交 automatic-speech-recognition，这段的语言知道才带；重试照 lib/call-attempts.mjs（每块最多 3 次），
//     并发用 pool（lib/capability-calls.mjs，上限是 options.concurrency，默认 1）。一块问满次数还失败，后面的块不再开始，这一段不用量的结果。
//   对字（alignChunks）：把逐字稿（不算标点，分词同 tokenizeTranscript）单调地切成和块数一样多的几片（一片可以是空的：那块是杂音）。
//     代价是每片和这块转写的编辑距离，加上「这片的词数」和「按这块的时长分到的词数」之差乘 ALIGN_LENGTH_WEIGHT：字和时长一起算，只按时长对会放错字，短块的转写常错，光看字也不行。
//     和时长明显不相称的转写不算（transcriptUsable）：转写的词数大于 CHUNK_TOKENS_SLACK（2）+ 这块的秒数 × CHUNK_TOKENS_PER_SECOND_MAX（12）的，是模型编出来的（0.11 秒的块回了十四个字，一块回的是拒答），
//     空的转写也不算；这样的块记成转写不可用，对字时只靠时长：代价只有上面「词数之差」那一项，不算编辑距离，也不进错误率。一块编造的转写不该打穿整段。
//     逐字稿里有汉字时，一串数字一位算一个词（2024 是四个词，写成汉字的数字：转写常写成「二零二四」，也可能是 2024，两边一样折），四个词都指着这串数字在原文里的位置（measureSpans）：
//     一串数字当一个词，字数差得太多，别的字就对错了地方，快慢也算错。切口落在一串数字中间的，挪到这串数字开头（pointsOf）。逐字稿里没有汉字的，照词算。
//     转写可用的块的时长加起来，不到全部块时长的 ALIGN_USABLE_MIN（0.5），这一段不用量的结果（不对字：大半靠时长对的不算量过）。
//     总的编辑错误（转写可用的块，每片和这块转写的编辑距离加起来）除以这些块分到的词数，超过 ALIGN_ERROR_MAX（0.6）算对不上，这一段不用量的结果。短块的转写错得很厉害（「散伙」写成「撒谎」、「却」写成「去」），
//     一段切得对的参考错误率也有 0.41，所以门槛放得宽；挡的是整段对不上的（转写和这段录音无关），不是错字多的。
//   算：每块前面的停顿（这块和上一块之间的静音，秒）；一个分句每秒几个词（pointsOf）：分句是标点隔开的一小句（标点是 Unicode 的标点；句号、问号、叹号、省略号、换行算句末，别的算逗号类），
//     写出 [short pause] 的地方也算分界（见下）。块内部的词按时长平均分（块里再细就量不到了）；时长只算说话的时间，块之间的静音不算。单字的分句不算快慢。
//
// 量出来怎么换成标记（pointsOf；门槛都是从一段参考定的）：
//   逗号类标点后面停 ≥ COMMA_PAUSE_SECONDS（0.40 秒）                写 [pause]，在标点后面
//   没有标点的地方停 ≥ BARE_PAUSE_SECONDS（0.20 秒）                  写 [short pause]，写在那里，也算分句的分界
//   句末                                                              不写（句末标点自己带停顿）
//   分句每秒字数 ≥ 全段中位数 × FAST_RATIO（1.2）                     [faster]
//   分句每秒字数 ≤ 全段中位数 × SLOW_RATIO（0.85）                    [slower]
//   中文、日文按字，别的按词（同 tokenizeTranscript）；一处停顿的位置是停顿后面那个词的开头。全段中位数是能算快慢的分句（两个字以上、有时长）的每秒字数的中位数，只有不到两个分句能算时不写快慢。
//
// 量失败不挡标注，返回 { measured: false, reason, chunks, ... }，这一段只用听出来的提示（lib/segment-annotation.mjs），报告写明原因：
//   capability_missing     环境没有 automatic-speech-recognition
//   text_empty             逐字稿里一个词都没有（对不了字）
//   runtime_missing        这段音频要 ffmpeg，环境没有（tools/audio-decode.mjs 的 decodeFailureKind 是 runtime_missing）；带 error（summarizeError 的摘要）
//   undecodable            解不开音频（同上，undecodable）；带 error
//   no_speech              整段都低于静音门槛，或者只有短于 CHUNK_MIN_SECONDS 的响动，切不出一块
//   transcription_failed   有一块问满次数还是暂时出错，或者转写抛了别的错（不是 keepsThrowing 的那种）；带 error
//   not_aligned            逐字稿和这几块的转写对不上（转写可用的块太少，或者切不出一条路，或者错误率超过上限）；带 errorRate（只有对过字、错误率超过上限的才有；可用的块太少不对字，切不出一条路的也没有，都不带）
//
// 返回（measurePoints）：
//   { measured: true, chunks, pauses, paces, clauseStarts }   pauses、paces 是要写的标记 [{ at, mark, ... }]（at 是逐字稿里的 UTF-16 下标，标记写在这个字前面，mark 是方括号标记），
//                                                              pauses 另带 seconds，paces 另带 rate（每秒几个字）；clauseStarts 是每个分句开头的下标，含写出 [short pause] 的地方。
//   { measured: false, reason, chunks, ... }                  chunks 是这一段真转写过的块数（报告的 steps.annotation.chunks 加的是它）
//
// 抛出的错误：环境给的能力抛的、这里认不出的错（keepsThrowing：调用方中止、凭据被拒）、options.wait 抛的错，原样往上抛；别的都不抛（见上）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { hasCapability, requireCapability } from '../protocol/lib/env.mjs';
import { decodeAudio, decodeFailureKind } from '../tools/audio-decode.mjs';
import { encodeWav } from '../tools/wav.mjs';
import { tokenSpans, tokenizeTranscript } from './fidelity.mjs';
import { summarizeError, badResult, pool, keepsThrowing, isPlainObject } from './capability-calls.mjs';
import { callWithRetries } from './call-attempts.mjs';
import { adjustedAudio } from './make-pack-loudness.mjs';

/** 一段录音最多切成几块（超过就并最短的停顿）。规划按它算转写的上限（lib/make-pack-plan.mjs）。 */
export const POINT_CHUNKS_MAX = 24;
/** 一次做包最多同时转写几块：取 make-pack --concurrency 的上限，平台上的并发上限没有量过。 */
export const POINT_CONCURRENCY = 8;
/** 静音门槛：5 毫秒窗的峰值低于 -30 dBFS（从一段参考定的）。 */
export const SILENCE_PEAK_DBFS = -30;
export const SILENCE_WINDOW_SECONDS = 0.005;
/** 连续静音多长才算停顿（秒，从一段参考定的）。 */
export const SILENCE_MIN_SECONDS = 0.05;
/** 每块转写时两边各带多长的音频（秒）。 */
export const CHUNK_PADDING_SECONDS = 0.06;
/** 太短的块不是语音（秒）：短于它的块在切块时就去掉，不转写，两边的静音算成一段停顿（从四段参考推断：0.01 秒的尖峰被转写成一句话）。 */
export const CHUNK_MIN_SECONDS = 0.05;
/** 转写和时长相称：转写的词数不超过 CHUNK_TOKENS_SLACK + 这块的秒数 × CHUNK_TOKENS_PER_SECOND_MAX，超过的是编造的，这块转写不可用（从四段参考推断；英文这类按词数的语言每秒说不到 12 个词，这个数宽得多，只拦得住编造，没有量过）。 */
export const CHUNK_TOKENS_SLACK = 2;
export const CHUNK_TOKENS_PER_SECOND_MAX = 12;
/** 转写可用的块的时长加起来，到全部块时长的多少以上才量（从四段参考推断）。 */
export const ALIGN_USABLE_MIN = 0.5;
/** 对字：错误率上限（从一段参考定的：切得对的那一段短块转写错了 0.41）。 */
export const ALIGN_ERROR_MAX = 0.6;
/** 对字：片的词数和按时长分到的词数之差乘多少算进代价（编辑距离的权重是 1；同样从一段参考定的）。 */
export const ALIGN_LENGTH_WEIGHT = 0.5;
/** 逗号类标点后面停多久写 [pause]（秒，从一段参考定的）。 */
export const COMMA_PAUSE_SECONDS = 0.4;
/** 没有标点的地方停多久写 [short pause]（秒，从一段参考定的）。 */
export const BARE_PAUSE_SECONDS = 0.2;
/** 分句每秒字数到全段中位数的多少倍写快（从一段参考定的）。 */
export const FAST_RATIO = 1.2;
/** 分句每秒字数到全段中位数的多少倍写慢（从一段参考定的）。 */
export const SLOW_RATIO = 0.85;

/** 快慢标记（照提示标注的语言写：en 用英文，别的用中文，同 lib/segment-annotation.mjs 的词表）。 */
const PACE_MARKS = { fast: '[faster]', slow: '[slower]' };

const HAS_PUNCTUATION = /\p{P}/u;
const HAS_HAN = /\p{Script=Han}/u;
const ALL_DIGITS = /^[0-9]+$/u;
const HAN_DIGITS = '零一二三四五六七八九';
const SENTENCE_END = /[。．.！!？?…⋯\r\n]/u;

/**
 * 切语音块（规则见文件头「切块」）。纯计算，不碰能力。
 * @param {Float32Array} samples 单声道
 * @param {number} sampleRate
 * @returns {{ start: number, end: number, seconds: number, gapBefore: number }[]} start、end 是采样点（end 不含），seconds 是这块的时长，gapBefore 是这块和上一块之间的静音（秒，第一块是 0）
 */
export function speechChunks(samples, sampleRate) {
  const windowSize = Math.max(1, Math.round(sampleRate * SILENCE_WINDOW_SECONDS));
  const threshold = 10 ** (SILENCE_PEAK_DBFS / 20);
  const minGap = SILENCE_MIN_SECONDS * sampleRate;
  const regions = [];
  let start = -1;
  let silentFrom = -1;
  let speechEnd = -1;
  for (let from = 0; from < samples.length; from += windowSize) {
    const to = Math.min(samples.length, from + windowSize);
    let peak = 0;
    for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(samples[i]));
    if (peak >= threshold) {
      if (start === -1) start = from;
      else if (silentFrom !== -1 && from - silentFrom >= minGap) {
        regions.push({ start, end: silentFrom });
        start = from;
      }
      silentFrom = -1;
      speechEnd = to;
    } else if (silentFrom === -1 && start !== -1) silentFrom = from;
  }
  if (start !== -1) regions.push({ start, end: speechEnd });
  // 太短的块不是语音：去掉，它前后两块（或一头）之间的静音连成一段停顿
  const kept = regions.filter((region) => (region.end - region.start) / sampleRate >= CHUNK_MIN_SECONDS);
  // 块多了：从最短的停顿并回去，并到上限为止（转写之前就定下来，规划按这个上限算）
  const dropping = new Set(kept.slice(1).map((region, i) => ({ index: i + 1, gap: region.start - kept[i].end })).sort((a, b) => a.gap - b.gap || a.index - b.index).slice(0, Math.max(0, kept.length - POINT_CHUNKS_MAX)).map((gap) => gap.index));
  const merged = [];
  kept.forEach((region, index) => {
    if (dropping.has(index)) merged[merged.length - 1].end = region.end;
    else merged.push({ ...region });
  });
  return merged.map((region, i) => ({ start: region.start, end: region.end, seconds: (region.end - region.start) / sampleRate, gapBefore: i === 0 ? 0 : (region.start - merged[i - 1].end) / sampleRate }));
}

/** 这块的转写能不能用（规则见文件头「对字」）：不空，词数不超过和这块时长相称的上限。 */
export const transcriptUsable = (words, seconds) => words.length > 0 && words.length <= CHUNK_TOKENS_SLACK + seconds * CHUNK_TOKENS_PER_SECOND_MAX;

/**
 * 把词单调地切成和块数一样多的几片（规则见文件头「对字」）。纯计算。
 * @param {string[]} tokens 逐字稿的词
 * @param {(string[] | null)[]} heard 每块转写的词；转写不可用的块是 null（只按时长对）
 * @param {number[]} durations 每块的时长（秒）
 * @returns {{ boundaries: number[], errorRate: number } | null} boundaries 长度是块数 + 1（boundaries[i] 到 boundaries[i+1] 是第 i 片的词的下标，首尾是 0 和词数）；errorRate 只算转写可用的块；切不出一条路是 null（极端的词数和时长差得太远）
 */
export function alignChunks(tokens, heard, durations) {
  const count = tokens.length;
  const speech = durations.reduce((sum, d) => sum + d, 0) || 1;
  const from = heard.map(() => new Int32Array(count + 1).fill(-1));
  let best = new Float64Array(count + 1).fill(Infinity);
  best[0] = 0;
  heard.forEach((words, index) => {
    const usable = words !== null;
    const estimate = (count * durations[index]) / speech;
    const limit = Math.ceil(2 * estimate) + (usable ? words.length : 0) + 8; // 一片最多多长：放宽到估计的两倍加转写的词数，够宽，只为了长文本时不算太多
    const next = new Float64Array(count + 1).fill(Infinity);
    for (let start = 0; start <= count; start++) {
      if (best[start] === Infinity) continue;
      let row = usable ? Array.from({ length: words.length + 1 }, (_, j) => j) : null;
      for (let end = start; end <= Math.min(count, start + limit); end++) {
        if (usable && end > start) {
          const current = [row[0] + 1];
          for (let j = 1; j <= words.length; j++) current[j] = Math.min(row[j] + 1, current[j - 1] + 1, row[j - 1] + (tokens[end - 1] === words[j - 1] ? 0 : 1));
          row = current;
        }
        const cost = best[start] + (usable ? row[words.length] : 0) + ALIGN_LENGTH_WEIGHT * Math.abs(end - start - estimate);
        if (cost < next[end]) {
          next[end] = cost;
          from[index][end] = start;
        }
      }
    }
    best = next;
  });
  if (best[count] === Infinity) return null;
  const boundaries = new Array(heard.length + 1);
  boundaries[heard.length] = count;
  for (let index = heard.length - 1; index >= 0; index--) boundaries[index] = from[index][boundaries[index + 1]];
  let errors = 0;
  let placed = 0; // 转写可用的块分到的词数
  heard.forEach((words, index) => {
    if (words === null) return;
    const slice = tokens.slice(boundaries[index], boundaries[index + 1]);
    errors += editDistance(slice, words);
    placed += slice.length;
  });
  return { boundaries, errorRate: errors / Math.max(1, placed) };
}

function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(row[j] + 1, current[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = current;
  }
  return row[b.length];
}

/** 中位数（没有数是 null）。 */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * 一段逐字稿里标点隔开的分句的开头（UTF-16 下标，第一个词的开头算第一句的开头）。切分句的规矩在文件头「算」；写出 [short pause] 的地方（extra）也算分界，这里一起并进去。
 * @param {string} text
 * @param {number[]} [extra]
 * @returns {number[]} 从小到大，不重复
 */
export function clauseStartsOf(text, extra = []) {
  const spans = tokenSpans(text);
  if (spans.length === 0) return [];
  const starts = new Set([spans[0].start, ...extra]);
  for (let i = 1; i < spans.length; i++) if (HAS_PUNCTUATION.test(text.slice(spans[i - 1].end, spans[i].start))) starts.add(spans[i].start);
  return [...starts].sort((a, b) => a - b);
}

/** 对字、算快慢用的词：tokenSpans，逐字稿有汉字时一串数字拆成一位一个词（见文件头「对字」）；拆出来的带 number（这串数字第一位的下标）。 */
export function measureSpans(text) {
  const spans = tokenSpans(text);
  if (!HAS_HAN.test(text)) return spans;
  const expanded = [];
  for (const span of spans) {
    if (!ALL_DIGITS.test(span.token)) expanded.push(span);
    else {
      const number = expanded.length;
      for (const digit of span.token) expanded.push({ token: HAN_DIGITS[digit], start: span.start, end: span.end, number });
    }
  }
  return expanded;
}

/** 转写的词照逐字稿一样折：逐字稿有汉字时，一串数字拆成一位一个汉字数字。 */
const heardTokens = (heard, text) => (HAS_HAN.test(text) ? heard.flatMap((token) => (ALL_DIGITS.test(token) ? [...token].map((digit) => HAN_DIGITS[digit]) : [token])) : heard);

/**
 * 给定分句的开头，返回一个函数：逐字稿里一个位置算第几个分句。位置落在标点上（before 从标点起抄的）算它后面那个词的分句。
 * @param {string} text
 * @param {number[]} clauseStarts clauseStartsOf 的结果
 * @returns {(at: number) => number}
 */
export function clauseFinder(text, clauseStarts) {
  const spans = tokenSpans(text);
  return (at) => {
    const position = spans.find((span) => span.end > at)?.start ?? at;
    let clause = 0;
    for (let i = 0; i < clauseStarts.length; i++) if (clauseStarts[i] <= position) clause = i;
    return clause;
  };
}

/**
 * 量到的块和对好的字换算成要写的标记（规则见文件头「量出来怎么换成标记」）。纯计算。
 * @param {string} text
 * @param {{ seconds: number, gapBefore: number }[]} chunks
 * @param {number[]} boundaries alignChunks 的 boundaries
 * @returns {{ pauses: { at: number, mark: string, seconds: number }[], paces: { at: number, mark: string, rate: number }[], clauseStarts: number[] }}
 */
export function pointsOf(text, chunks, boundaries) {
  const spans = measureSpans(text);
  const count = spans.length;
  const snap = (boundary) => (boundary < count ? spans[boundary].number ?? boundary : boundary); // 切口落在一串数字中间的，挪到这串数字开头
  boundaries = boundaries.map(snap);
  const gaps = new Map(); // 词的下标（这个词前面停了）-> 最长的那次停顿
  chunks.forEach((chunk, index) => {
    const token = boundaries[index];
    if (index === 0 || token === 0 || token >= count) return;
    gaps.set(token, Math.max(gaps.get(token) ?? 0, chunk.gapBefore));
  });
  const pauses = [];
  const shortBreaks = [];
  for (const [token, seconds] of [...gaps].sort((a, b) => a[0] - b[0])) {
    const gap = text.slice(spans[token - 1].end, spans[token].start);
    if (SENTENCE_END.test(gap)) continue; // 句末不写
    if (HAS_PUNCTUATION.test(gap)) {
      if (seconds >= COMMA_PAUSE_SECONDS) pauses.push({ at: spans[token].start, mark: '[pause]', seconds });
    } else if (seconds >= BARE_PAUSE_SECONDS) {
      pauses.push({ at: spans[token].start, mark: '[short pause]', seconds });
      shortBreaks.push(spans[token].start);
    }
  }
  const clauseStarts = clauseStartsOf(text, shortBreaks);
  // 每个词分到的时长：块内部按词数平均分（空的块没有词，时长不算给谁）
  const seconds = new Float64Array(count);
  chunks.forEach((chunk, index) => {
    const from = boundaries[index];
    const to = boundaries[index + 1];
    for (let token = from; token < to; token++) seconds[token] = chunk.seconds / (to - from);
  });
  // 分句的每秒字数：两个字以上、有时长的才算
  const clauseOfToken = spans.map((span) => {
    let clause = 0;
    for (let i = 0; i < clauseStarts.length; i++) if (clauseStarts[i] <= span.start) clause = i;
    return clause;
  });
  const clauses = clauseStarts.map(() => ({ tokens: 0, seconds: 0 }));
  clauseOfToken.forEach((clause, token) => {
    clauses[clause].tokens += 1;
    clauses[clause].seconds += seconds[token];
  });
  const rates = clauses.map((clause) => (clause.tokens >= 2 && clause.seconds > 0 ? clause.tokens / clause.seconds : null));
  const rated = rates.filter((rate) => rate !== null);
  const middle = rated.length >= 2 ? median(rated) : null;
  const paces = [];
  if (middle !== null) {
    rates.forEach((rate, clause) => {
      if (rate === null) return;
      if (rate >= middle * FAST_RATIO) paces.push({ at: clauseStarts[clause], mark: PACE_MARKS.fast, rate });
      else if (rate <= middle * SLOW_RATIO) paces.push({ at: clauseStarts[clause], mark: PACE_MARKS.slow, rate });
    });
  }
  return { pauses, paces, clauseStarts };
}

/**
 * 量一段录音（规则见文件头）。
 * @param {object} env 注入的运行环境
 * @param {{ audio: { bytes: Uint8Array, mimeType: string }, text: string, language?: string }} segment
 * @param {{ concurrency?: number, wait?: (ms: number) => Promise<void>, loudness?: { targetLufs: number, peakCeilingDbfs: number, limiter: { maxDb: number } | null } | null }} [options] loudness：先调响度再量（见文件头「先调响度」），不给或 null 就照原电平
 * @returns {Promise<object>} 见文件头「返回」
 */
export async function measurePoints(env, { audio, text, language }, { concurrency = 1, wait, loudness } = {}) {
  const notMeasured = (reason, chunks = 0, details = {}) => ({ measured: false, reason, chunks, ...details });
  const spans = measureSpans(text);
  if (spans.length === 0) return notMeasured('text_empty');
  if (!hasCapability(env, 'automatic-speech-recognition')) return notMeasured('capability_missing');
  let decoded;
  try {
    decoded = await decodeAudio(env, audio.bytes);
  } catch (error) {
    const kind = decodeFailureKind(error);
    if (kind === null) throw error;
    return notMeasured(kind, 0, { error: summarizeError(error) });
  }
  const samples = loudness === undefined || loudness === null ? decoded.samples : adjustedAudio(decoded, loudness).audio.samples;
  const mono = new Float32Array(decoded.frames);
  for (let i = 0; i < decoded.frames; i++) {
    let sum = 0;
    for (let channel = 0; channel < decoded.channels; channel++) sum += samples[channel][i];
    mono[i] = sum / decoded.channels;
  }
  const chunks = speechChunks(mono, decoded.sampleRate);
  if (chunks.length === 0) return notMeasured('no_speech');
  const recognize = requireCapability(env, 'automatic-speech-recognition');
  const padding = Math.round(CHUNK_PADDING_SECONDS * decoded.sampleRate);
  // options.wait 抛的错（调用方不等了）和能力抛的错分开：前者原样往上抛
  let waitFailure = null;
  const waiting = wait === undefined ? undefined : async (ms) => {
    try {
      await wait(ms);
    } catch (error) {
      waitFailure = error;
      throw error;
    }
  };
  const heard = new Array(chunks.length);
  let failure = null;
  let started = 0;
  await pool(chunks, concurrency, async (chunk, index) => {
    if (failure !== null) return;
    started += 1;
    const clip = { bytes: encodeWav({ sampleRate: decoded.sampleRate, samples: [mono.slice(Math.max(0, chunk.start - padding), Math.min(mono.length, chunk.end + padding))] }), mimeType: 'audio/wav' };
    const ask = async () => {
      const result = await recognize({ audio: clip, ...(language ? { language } : {}) });
      if (!isPlainObject(result) || typeof result.text !== 'string') throw badResult('automatic-speech-recognition', 'text_missing', 'must return { text: string, language?: string, model?: string }');
      return result;
    };
    let outcome;
    try {
      outcome = await callWithRetries(ask, { wait: waiting });
    } catch (error) {
      if (error === waitFailure || keepsThrowing(error)) throw error;
      failure ??= { error };
      return;
    }
    if ('error' in outcome) {
      failure ??= { error: outcome.error };
      return;
    }
    const words = heardTokens(tokenizeTranscript(outcome.result.text), text);
    heard[index] = transcriptUsable(words, chunk.seconds) ? words : null;
  });
  if (failure !== null) return notMeasured('transcription_failed', started, { error: summarizeError(failure.error) });
  const durations = chunks.map((chunk) => chunk.seconds);
  const usableSeconds = durations.reduce((sum, seconds, index) => sum + (heard[index] === null ? 0 : seconds), 0);
  if (usableSeconds < ALIGN_USABLE_MIN * durations.reduce((sum, seconds) => sum + seconds, 0)) return notMeasured('not_aligned', chunks.length);
  const aligned = alignChunks(spans.map((span) => span.token), heard, durations);
  if (aligned === null) return notMeasured('not_aligned', chunks.length);
  if (aligned.errorRate > ALIGN_ERROR_MAX) return notMeasured('not_aligned', chunks.length, { errorRate: aligned.errorRate });
  return { measured: true, chunks: chunks.length, ...pointsOf(text, chunks, aligned.boundaries) };
}
