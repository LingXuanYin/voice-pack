// SPDX-License-Identifier: Apache-2.0
//
// 一段话里的停顿交给模型。规则只写在这里：app 和配音（lib/dub.mjs）都用它。
//
// 两次请求是两次独立的说话：停顿以后语气重新起头。同一个参考段、同一个语速、两边都有字，停顿在一段话里面（不是章节、空行），
// 不超过 PAUSE_IN_REQUEST_MAX_MS 的，并成一次请求：
//   - 不超过 PUNCTUATION_PAUSE_MAX_MS，又跟在标点后面的：不写，靠标点自己的停顿（约 PUNCTUATION_PAUSE_MS，0.5 秒）；
//   - 其余：<break time="Nms"/>，N = max(BREAK_MIN_MS, 停顿 − PUNCTUATION_PAUSE_MS)；整段包 <speak>…</speak>，文字里的 & < > 转义。
// 续接（句子被标记切开、接着下一段说，没有停顿，又不并）的地方，以「，、；：」结尾的，两段之间的停顿是 JOIN_PUNCTUATION_PAUSE_SEC（0.5 秒），
// 不以标点结尾的是 0（不插静音）。app 的拼接减去两边留下的静音（joinGapOf）；配音没有音频，拼接的人直接插 JOIN_PUNCTUATION_PAUSE_MS。
//
// 这个文件只算和写，不碰音频，不认模型。能不能收 <speak> 的文字，由运行环境声明（pause-in-text，见 vocab/capability-signatures.md「怎么念」）。
// 哪两段能并（同一参考、同一语速、同一名字……）由调用方决定，用 canJoin 告诉这里（app 和配音各有自己的几条）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。

/** 一处停顿不超过这么多毫秒，才并进一次请求（2 秒以内量过，2.5 秒是上限）。 */
export const PAUSE_IN_REQUEST_MAX_MS = 2500;
/** 不超过这么多毫秒、又跟在标点后面的停顿，不写：标点自己停（约 PUNCTUATION_PAUSE_MS）。 */
export const PUNCTUATION_PAUSE_MAX_MS = 700;
/** 标点自己停的时间（毫秒），写 <break> 时从停顿里扣掉它。 */
export const PUNCTUATION_PAUSE_MS = 500;
/** 写出来的 <break> 最短多少毫秒。 */
export const BREAK_MIN_MS = 200;
/** 续接处、以「，、；：」结尾的两段之间的停顿（秒）：同一模型一次请求里的逗号停顿量到 0.48–0.54 秒。配音用毫秒，见下面。 */
export const JOIN_PUNCTUATION_PAUSE_SEC = 0.5;
export const JOIN_PUNCTUATION_PAUSE_MS = Math.round(JOIN_PUNCTUATION_PAUSE_SEC * 1000);

const HAS_WORDS = /[\p{L}\p{N}]/u;
/** 以标点结尾（引号、括号可以在标点后面）：这种停顿靠标点。 */
const ENDS_IN_PUNCTUATION = /[，。！？；：…、,.!?;:]["'”’」』）)】》]*$/u;
/** 以句中的标点结尾：续接处要停 JOIN_PUNCTUATION_PAUSE_SEC。 */
const ENDS_MID_SENTENCE = /[，、；：,;:]["'”’」』）)】》]*$/u;

export const hasWords = (text) => HAS_WORDS.test(text);
/** 说完这一段，接着下一段的停顿是句中的（以「，、；：」结尾，前后空白不算）。 */
export const endsMidSentence = (words) => ENDS_MID_SENTENCE.test(words.trimEnd());
/** 两个请求的词接起来：拉丁字母、数字之间留一个空格（解析器已经去掉了标记边上的空格），别的直接接。 */
export const glue = (a, b) => (/[A-Za-z0-9,.!?;:]$/.test(a) && /^[A-Za-z0-9]/.test(b) ? `${a} ${b}` : a + b);
/** 文字里的 & < > 转义（写进 <speak> 的文字）。 */
export const escapeSsml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 一次请求的文字：parts 是各段的词，breaks[i] 是第 i 段和第 i+1 段之间的停顿（毫秒；null 表示不写，靠标点）。
 * 有任何一处写了 <break>，整段包 <speak>…</speak>，词要转义；没有，就是原样接起来的词（和以前一样，不包 <speak>）。
 * @returns {string}
 */
export function renderRun(parts, breaks) {
  const ssml = breaks.some((pause) => pause !== null);
  const said = (part) => (ssml ? escapeSsml(part) : part);
  let text = said(parts[0]);
  for (let i = 1; i < parts.length; i += 1) {
    const pause = breaks[i - 1];
    text = pause === null ? glue(text, said(parts[i])) : `${text}<break time="${pause}ms"/>${said(parts[i])}`;
  }
  return ssml ? `<speak>${text}</speak>` : text;
}

/**
 * 把一串段落（按说话的先后）合成几次请求。items[i] 是 { text, pause, inline }：
 *   text    这一段要说的词（调用方已经去掉了舞台提示、台本标记；app 的 text 带着它的标签，标签算在词里）
 *   pause   这一段后面的停顿（毫秒）。配音是这一段的 pauseAfterMs 加上后一段的 pauseBeforeMs（同一个缝）
 *   inline  这个停顿在一段话里面（不是章节的末尾，也不是空行接着的）。app 由切割决定，配音由章节和 join 决定
 * canJoin(prev, next)：调用方的条件（同一参考、同一语速、名字、续接……）；prev 是这次请求已经有的最后一段，next 是接在后面的候选。
 * max：一次请求最多多少个单位（measure 量），写了 <break> 的文字连标记一起算。measure 默认 UTF-16 单位（app 的 chunkMax 也是这样数的）。
 * @returns {{ first: number, last: number, text: string, ssml: boolean, words: string, pause: number }[]}
 *   first、last 是 items 的下标（含头含尾）；text 是要发出去的文字；words 是不带标记的词；pause 是最后一段后面的停顿（毫秒）。
 */
export function requestsOf(items, { max = Number.POSITIVE_INFINITY, canJoin, measure = (text) => text.length }) {
  const runs = [];
  items.forEach((item, index) => {
    const run = runs[runs.length - 1];
    if (run) {
      const prev = items[run.last];
      if (prev.inline && prev.pause > 0 && prev.pause <= PAUSE_IN_REQUEST_MAX_MS && hasWords(prev.text) && hasWords(item.text) && canJoin(prev, item)) {
        const tail = run.parts[run.parts.length - 1];
        const pause = prev.pause <= PUNCTUATION_PAUSE_MAX_MS && ENDS_IN_PUNCTUATION.test(tail)
          ? null
          : Math.max(BREAK_MIN_MS, Math.round(prev.pause - PUNCTUATION_PAUSE_MS));
        const parts = [...run.parts, item.text];
        const breaks = [...run.breaks, pause];
        if (measure(renderRun(parts, breaks)) <= max) {
          run.parts = parts;
          run.breaks = breaks;
          run.last = index;
          return;
        }
      }
    }
    runs.push({ first: index, last: index, parts: [item.text], breaks: [] });
  });
  return runs.map((run) => ({
    first: run.first,
    last: run.last,
    text: renderRun(run.parts, run.breaks),
    ssml: run.breaks.some((pause) => pause !== null),
    words: run.parts.reduce(glue),
    pause: items[run.last].pause,
  }));
}
