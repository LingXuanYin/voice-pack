// SPDX-License-Identifier: Apache-2.0
//
// 句子合段（流程层，不花钱）：长录音的句子模式（lib/long-recording.mjs 的 sentences: true）切出来的句子，每句已经打过情绪标签
// （lib/make-pack-tags.mjs 的 tagAll，每句听一次），这里按情绪把句子并成段。段的音频、文字、标签都从它里面几句来，不再听一遍：
// 打标签的次数等于句数。段是在打标签之后才合成的（makePack 的次序），所以 tagAll 不会再听它。
//
//   mergeSentences(items)  -> { items, merged, aliases, step }
//     items      条目列表（不改）。返回的 items 里，参与并段的句子换成合好的段（放在段里第一句的位置）；没参与的原样留着（淘汰了的，报告里写着原因）
//     merged     新合成的段（条目），还没量音质：调用方要先筛（lib/make-pack-screen.mjs）再用
//     aliases    句子的名字 -> 它所在的段的名字（作者点名的默认参考段是句子的名字时用）
//     step       { sentences: 参与并段的句子数, segments: 合成的段数 }
//
// 参与并段的：没有淘汰（unused）的句子。听不出情绪的（回答作废、服务暂时出错试满了、听了说没有）也参与，只是它们的情绪是「没有」。
// 情绪：调用方给了的（labels.emotion）盖过听出来的（tagging.emotion），同 lib/make-pack-tags.mjs 的 assembleTags。
//
// 分组：语言、采样率、情绪。没有情绪的句子单独一组，不和有情绪的并：听不出的句子不会被归到某一种情绪里。
// 组内按原来的次序分段。长短是参考段的要求（音质检查的正本在 tools/audio-quality.mjs 的 REFERENCE_THRESHOLDS.duration，这里不另写一份）：5 到 20 秒。
//   · 当前的段已经够 5 秒，遇到下一句就关掉它，下一句另起一段；
//   · 当前的段不够 5 秒，加上下一句会超过 20 秒，也关掉它；
//   · 最后一段不够 5 秒的，并进前一段（并起来不超过 20 秒）；并不进去的，就是一段短的，照样留着。
//
// 段里两句怎么接（段的长短按这样算）：
//   · 原来就紧挨着的两句（同一段录音、次序相邻，并且前一句的原停顿留着，即 sentence.pauseSec 不是 null）：前一句的音频连同它后面的原停顿一起用，
//     两句之间保持原来的停顿（房间底噪，不是静音）；
//   · 其余（中间隔着别的句子，或者中间丢掉了零头）：前一句只用句子本身，后面接 0.3 秒静音（采样全是 0）。
//
// 段的音频：WAV，16 位，单声道，采样率同句子。段的文字：句子的文字按次序接起来，两头都是中日韩字符就直接接，否则中间加一个空格。
// 段的标签：语言是组里的语言；情绪是组里的情绪（没有情绪的组没有）；风格是组里的句子都一样才有。段的 tagging 写成听者的结果的样子
//   （{ status: 'tagged', emotion?, style? }），所以 assembleTags 从它取情绪和风格，来源记作 audio-text-to-text。
//   没有情绪、风格的段：几句的听的结果一样（都没听成、都作废、都没有标签）就照那一个 tagging（报告里看得到没听成和作废），否则没有 tagging。
// 段的名字：段里第一句的名字。段的 source：{ recording?, startSec（第一句的开始）, endSec（最后一句的结束）, sentences（段里句子的名字，按次序） }，只放进报告，不进包。
//
// 读条目的：index、id、audio、text、textSource、language、labels、tagging、source、sentence、unused；不改原来的条目（合成的段是新的条目）。
//
// 抛出的错误：没有（句子的音频不是 WAV 的，解码的错原样往上抛）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { parseWav, encodeWav, wavInfo } from '../tools/wav.mjs';
import { REFERENCE_THRESHOLDS } from '../tools/audio-quality.mjs';

/** 句子之间不相邻时插进去的静音（秒）。 */
const SILENCE_SECONDS = 0.3;
const { warnBelow: MIN_SECONDS, warnAbove: MAX_SECONDS } = REFERENCE_THRESHOLDS.duration;
/** 中日韩字符（含全角标点）：两头都是它的，接的时候不加空格。范围：CJK 标点和假名、统一汉字、谚文音节、兼容汉字、全角字符。 */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

/** 是不是句子（长录音的句子模式切出来的片段）。 */
export const isSentence = (item) => item.sentence !== undefined;

/** 原来紧挨着的两句：同一段录音、次序相邻，前一句的原停顿留着。 */
const adjacent = (a, b) => b.index === a.index + 1 && a.source?.recording === b.source?.recording && a.sentence.pauseSec !== null;

/** 一段有多长（秒）：句子本身，加上句与句之间的停顿（原停顿，或者 0.3 秒静音）。最后一句后面没有。和 composeAudio 出来的音频一样长。 */
function secondsOf(list) {
  return list.reduce((total, m, i) => {
    const next = list[i + 1];
    if (next === undefined) return total + m.sentence.bodySec;
    return total + m.sentence.bodySec + (adjacent(m, next) ? m.sentence.pauseSec : SILENCE_SECONDS);
  }, 0);
}

/** 组内分段（规则见文件头）。members 是同一组的句子，按原来的次序。返回 [[句子, …], …]。 */
function segmentsOf(members) {
  const out = [];
  let current = [];
  for (const m of members) {
    if (current.length === 0) {
      current = [m];
      continue;
    }
    if (secondsOf(current) >= MIN_SECONDS || secondsOf([...current, m]) > MAX_SECONDS) {
      out.push(current);
      current = [m];
    } else current.push(m);
  }
  if (current.length === 0) return out;
  const previous = out.at(-1);
  if (previous !== undefined && secondsOf(current) < MIN_SECONDS && secondsOf([...previous, ...current]) <= MAX_SECONDS) out[out.length - 1] = [...previous, ...current];
  else out.push(current);
  return out;
}

/** 句子的情绪：调用方给的盖过听出来的（同 assembleTags）。给了 null（明确没有）或者都没有，就是 undefined。 */
function emotionOf(item) {
  if (item.labels.emotion !== undefined) return item.labels.emotion || undefined;
  return item.tagging?.status === 'tagged' ? item.tagging.emotion : undefined;
}

/** 句子的风格（同 emotionOf）。 */
function styleOf(item) {
  if (item.labels.style !== undefined) return item.labels.style || undefined;
  return item.tagging?.status === 'tagged' ? item.tagging.style : undefined;
}

/** 组的键：语言、采样率、情绪（没有情绪的是空的）。 */
const keyOf = (item) => JSON.stringify([item.language.value, wavInfo(item.audio.bytes).sampleRate, emotionOf(item) ?? '']);

/** 两头都是中日韩字符就直接接，否则中间加一个空格；空的文字跳过。 */
function joinText(texts) {
  return texts
    .filter((text) => text !== '')
    .reduce((acc, text) => (acc === '' ? text : CJK.test(acc.at(-1)) && CJK.test(text.charAt(0)) ? `${acc}${text}` : `${acc} ${text}`), '');
}

/** 一段的音频（WAV 字节）：相邻的整段（句子加原停顿），不相邻的句子本身加静音（见文件头「段里两句怎么接」）。 */
function composeAudio(list, rate) {
  const parts = [];
  list.forEach((m, i) => {
    const next = list[i + 1];
    const samples = parseWav(m.audio.bytes).samples[0];
    if (next !== undefined && adjacent(m, next)) parts.push(samples);
    else {
      parts.push(samples.subarray(0, Math.round(m.sentence.bodySec * rate)));
      if (next !== undefined) parts.push(new Float32Array(Math.round(SILENCE_SECONDS * rate)));
    }
  });
  const out = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return encodeWav({ sampleRate: rate, samples: [out] });
}

/** 一段的条目（见文件头「段的标签」「段的名字」「段的 source」）。 */
function mergedItem(list) {
  const first = list[0];
  const last = list.at(-1);
  const emotion = emotionOf(first);
  const styles = list.map(styleOf);
  const style = styles.every((value) => value === styles[0]) ? styles[0] : undefined;
  const sameOutcome = list.every((m) => m.tagging?.status === first.tagging?.status);
  const tagging = emotion !== undefined || style !== undefined ? { status: 'tagged', ...(emotion === undefined ? {} : { emotion }), ...(style === undefined ? {} : { style }) } : sameOutcome && first.tagging !== undefined ? { ...first.tagging } : undefined;
  return {
    index: first.index,
    id: first.id,
    audio: { bytes: composeAudio(list, wavInfo(first.audio.bytes).sampleRate), mimeType: 'audio/wav' },
    text: joinText(list.map((m) => m.text)),
    textSource: first.textSource,
    language: first.language,
    labels: { ...first.labels },
    ...(tagging === undefined ? {} : { tagging }),
    source: {
      ...(first.source?.recording === undefined ? {} : { recording: first.source.recording }),
      startSec: first.source?.startSec,
      endSec: last.source?.endSec,
      sentences: list.map((m) => m.id),
    },
    externalUrl: null,
  };
}

/**
 * 句子合段。见文件头。
 * @param {object[]} items 条目（句子已经转写、定了语言、打过情绪标签）
 */
export function mergeSentences(items) {
  const usable = items.filter((item) => isSentence(item) && item.unused === undefined);
  const groups = new Map();
  for (const sentence of usable) {
    const key = keyOf(sentence);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sentence);
  }
  const headOf = new Map(); // 段的第一句 -> 合成的段
  const inside = new Set(); // 参与并段的句子
  const aliases = new Map();
  const merged = [];
  for (const members of groups.values()) {
    for (const list of segmentsOf(members)) {
      const item = mergedItem(list);
      merged.push(item);
      headOf.set(list[0], item);
      for (const m of list) {
        inside.add(m);
        aliases.set(m.id, item.id);
      }
    }
  }
  const out = [];
  for (const item of items) {
    if (!inside.has(item)) out.push(item);
    else if (headOf.has(item)) out.push(headOf.get(item));
  }
  return { items: out, merged, aliases, step: { sentences: usable.length, segments: merged.length } };
}
