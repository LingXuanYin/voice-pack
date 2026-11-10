// SPDX-License-Identifier: Apache-2.0
//
// 句子合段（流程层，不花钱）：长录音的句子模式（lib/long-recording.mjs 的 sentences: true）切出来的句子，在转写之前并成段，之后一段转写一次（lib/make-pack-transcribe.mjs）。
// 句子不逐句转写，也不逐句先听。理由（2026-11-05 在开发用的转写上量过 25 句两秒以下的短句，每句给语言、不给语言各转一次）：短句没有上下文，错字多，
// 中文短句给了语言 38 个字错 18 个，多是音对字错（「散伙」写成「发火」），同一段话整段送，45 个字只错 1 个；没人说话的小块会编出一句话来
// （给了语言时，两块杂音都编出了整句），编出来的字进了逐字稿，参考的文字就和音频对不上了；逐句的请求也多。
// 一段里可能有几种说法，音色基底标签按合好的段给（lib/make-pack-tags.mjs 的 assignTags）。段的音频从它里面几句来。
//
//   mergeSentences(items)  -> { items, merged, aliases, step }
//     items      条目列表（不改）。返回的 items 里，参与并段的句子换成合好的段（放在段里第一句的位置）；没参与的原样留着（淘汰了的，报告里写着原因）
//     merged     新合成的段（条目），还没量音质：调用方要先筛（lib/make-pack-screen.mjs）再用
//     aliases    句子的名字 -> 它所在的段的名字（作者点名的默认参考段是句子的名字时用）
//     step       { sentences: 参与并段的句子数, segments: 合成的段数 }
//
// 参与并段的：筛片段没淘汰（unused）的句子。在转写之前做，所以句子还没有转写出来的文字，也还没定语言。
//
// 分组：素材给的语言（givenLanguage：作者给的 --language，或者段自己的 language；规范化以后的写法，protocol/lib/manifest.mjs 的 languageKey；没给的算一组）、采样率。
//   不同采样率的句子不并（拼起来的音频只有一个采样率）。并段不按转写报的语言分开：没给语言的录音，一段里可能混着几种语言，段的语言照下面的规矩定。
//   要按语言分开的，作者自己先切好，每段写上语言再交。
// 组内按原来的次序分段。长短是参考段的要求（音质检查的正本在 tools/audio-quality.mjs 的 REFERENCE_THRESHOLDS.duration，这里不另写一份）：5 到 20 秒。
//   · 当前的段已经够 5 秒，遇到下一句就关掉它，下一句另起一段；
//   · 当前的段不够 5 秒，加上下一句会超过 20 秒，也关掉它；
//   · 最后一段不够 5 秒的，并进前一段（并起来不超过 20 秒）；并不进去的，就是一段短的，照样留着。
//
// 段里两句怎么接（段的长短按这样算）：
//   · 原来就紧挨着的两句（同一段录音、次序相邻，并且前一句的原停顿留着，即 sentence.pauseSec 不是 null）：前一句的音频连同它后面的原停顿一起用，
//     两句之间保持原来的停顿（房间底噪，不是静音）；
//   · 其余（中间隔着别的句子，或者中间丢掉了零头，或者是两段录音接在一起）：前一句只用句子本身，后面接 0.3 秒静音（采样全是 0）。
//
// 段的音频：WAV，16 位，单声道，采样率同句子。
// 段的文字：一般是空的，做包接着把整段交给转写（一段一次，lib/make-pack-transcribe.mjs），段的文字就是整段转出来的。
//   调用方给句子带了文字、段里每一句都有字的，才把句子的文字按次序接起来当段的文字，这一段不转写。接的地方：前一句的结尾（隔着收尾的引号、括号、省略号、破折号）
//   或者后一句的开头（隔着开头的这些）是汉字、假名或它们的全角标点，就直接接；别的加一个空格，韩文和英文一样（词和词之间本来就有空格）。
//   （长录音的句子模式不转写，句子不带文字：只有调用方自己交带文字的句子才走到这里。）
//   有一句没有字，整段转写，句子带的文字不用。
// 段的提示标注（annotatedText）：段里每一句都带着素材给的提示标注、段的文字又是句子的文字接起来的，才把几句的提示标注按次序接起来（接法和文字一样），这一段不再让模型标；
//   别的情况没有（做包照常标）。一组里有的句子给了、有的没给，读输入时就报了（lib/make-pack-input.mjs 的文件头「句子」），走不到这里。
// 段是不是合成的（synthetic）：段里每一句都标了 synthetic: true 才是，不然是真录音。一组里有的标了、有的没标，同样读输入时就报了。
// 段的语言：这里不定，和别的段一样由 lib/make-pack-tags.mjs 定（转写以后）：素材给的（作者给了 --language 就是它）> 整段转写报的 > 从整段的文字认。
//   段带着段里第一句素材给的语言（givenLanguage，同一组里都一样）。
// 段的音色基底标签：段里的句子都带着同一个素材给的标签（givenTag）才有，不然没有（用段的名字，lib/make-pack-tags.mjs）。
//   长录音自己不给句子标签（lib/long-recording.mjs），所以长录音做的段一律是「没有标签」。
// 段的名字：段里第一句的名字。段的 source：{ recording?, startSec（第一句的开始）, endSec（最后一句的结束）, sentences（段里句子的名字，按次序） }，只放进报告，不进包。
//
// 读条目的：index、id、audio、text、annotatedText、givenLanguage、givenTag、source、synthetic、sentence、unused；不改原来的条目（合成的段是新的条目）。
//
// 抛出的错误：没有（句子的音频不是 WAV 的，解码的错原样往上抛）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { parseWav, encodeWav, wavInfo } from '../tools/wav.mjs';
import { REFERENCE_THRESHOLDS } from '../tools/audio-quality.mjs';
import { languageKey } from '../protocol/lib/manifest.mjs';
import { hasWords } from './make-pack-transcribe.mjs';
import { joinWritten } from '../protocol/lib/word-spacing.mjs';

/** 句子之间不相邻时插进去的静音（秒）。 */
const SILENCE_SECONDS = 0.3;
const { warnBelow: MIN_SECONDS, warnAbove: MAX_SECONDS } = REFERENCE_THRESHOLDS.duration;

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

/** 组的键：素材给的语言（规范化以后的写法，没给是 null）、采样率。 */
const keyOf = (item) => JSON.stringify([item.givenLanguage ? languageKey(item.givenLanguage) : null, wavInfo(item.audio.bytes).sampleRate]);

/** 几句的文字按次序接起来（规矩在文件头「段的文字」，程序在 protocol/lib/word-spacing.mjs 的 joinWritten）；空的文字跳过。 */
const joinText = (texts) => texts.filter((text) => text !== '').reduce(joinWritten, '');

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

/** 一段的条目（见文件头「段的文字」「段的提示标注」「段是不是合成的」「段的语言」「段的名字」「段的 source」）。 */
function mergedItem(list) {
  const first = list[0];
  const last = list.at(-1);
  const sameTag = list.every((m) => m.givenTag === first.givenTag);
  const text = list.every((m) => hasWords(m.text)) ? joinText(list.map((m) => m.text)) : ''; // 一般是空的：整段转写
  const annotated = text !== '' && list.every((m) => m.annotatedText !== undefined); // 段的文字是句子接起来的，提示标注才跟着接（不然整段转写，对不上）
  return {
    index: first.index,
    id: first.id,
    audio: { bytes: composeAudio(list, wavInfo(first.audio.bytes).sampleRate), mimeType: 'audio/wav' },
    text,
    ...(annotated ? { annotatedText: joinText(list.map((m) => m.annotatedText)) } : {}),
    givenLanguage: first.givenLanguage,
    givenTag: sameTag ? first.givenTag : undefined,
    source: {
      ...(first.source?.recording === undefined ? {} : { recording: first.source.recording }),
      startSec: first.source?.startSec,
      endSec: last.source?.endSec,
      sentences: list.map((m) => m.id),
    },
    externalUrl: null,
    synthetic: list.every((m) => m.synthetic === true),
  };
}

/**
 * 句子合段。见文件头。
 * @param {object[]} items 条目（筛过片段，还没转写）
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
