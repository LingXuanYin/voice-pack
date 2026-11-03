// SPDX-License-Identifier: Apache-2.0
//
// 一段话里的停顿交给模型。规则只写在这里：app 和配音（lib/dub.mjs）都用它。
//
// 两次请求是两次独立的说话：停顿以后语气重新起头。同一个参考段、同一个语速、两边都有字，停顿在一段话里面（不是章节、空行），
// 写下的停顿（<break>）加起来不超过 maxPauseMs 的（调用方给，环境声明的；不给就不限），并成一次请求：
//   - 不超过 PUNCTUATION_PAUSE_MAX_MS，又跟在标点后面的：不写，靠标点自己的停顿（约 PUNCTUATION_PAUSE_MS，0.5 秒）；
//   - 其余：<break time="Nms"/>，N = max(BREAK_MIN_MS, 停顿 − PUNCTUATION_PAUSE_MS)；整段包 <speak>…</speak>，文字里的 & < > 转义。
// 一下子的声音（笑、叹气）：这一段带 cue（item.cue，规范名字），写成 <cue style="名字"/>（cueTag），放在 <speak> 里面、它在台词里的位置：请求的开头，或者两段话中间的缝上（在 <break> 的后面）；
// 缝上的停顿可以是 0。哪些段带 cue 由调用方定（环境声明了 cue-in-text 才有，见 vocab/capability-signatures.md）；一个缝有 cue、停顿也在上限以内，两样都写。
// <cue style="名字"/> 不是标准的 SSML：它是基础部分的写法，由所用环境的适配器译成模型自己的标签，不会原样发给模型。
// 续接（句子被标记切开、接着下一段说，没有停顿，又不并）的地方，以「，、；：」结尾的，两段之间的停顿是 JOIN_PUNCTUATION_PAUSE_SEC（0.5 秒），
// 不以标点结尾的是 0（不插静音）。app 的拼接减去两边留下的静音（joinGapOf）；配音没有音频，拼接的人直接插 JOIN_PUNCTUATION_PAUSE_MS。
//
// 这个文件只算和写，不碰音频，不认模型。能不能收 <speak> 的文字，由运行环境声明（pause-in-text，见 vocab/capability-signatures.md「怎么念」）。
// 哪两段能并（同一参考、同一语速、同一名字……）由调用方决定，用 canJoin 告诉这里（app 和配音各有自己的几条）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。

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
/** 一下子的声音在文字里的写法：规范名字（vocab/cues.json 的 oneShot：laugh、sigh）。适配器把它译成自己的写法（在 <speak> 里面，和 <break> 同一层）。 */
export const cueTag = (style) => `<cue style="${style}"/>`;

/** 一处有没有写（null、undefined 是没写；0 毫秒的停顿也是写了）。 */
const written = (mark) => mark !== undefined && mark !== null;
/** 一次请求里有没有写 <break> 或 <cue/>：有，整段包 <speak>。 */
const writesMarkup = (breaks, cues) => breaks.some(written) || cues.some(written);

/**
 * 一次请求的文字：parts 是各段的词；breaks[i]、cues[i] 是写在第 i 段前面的停顿（毫秒；null 表示不写，靠标点；第一段前面没有停顿）和一下子的声音（规范名字；null 或不给就没有）。
 * 一段前面先写停顿，再写 cue（笑在停顿之后）；第一段的 cue 写在整个请求的开头。
 * 有任何一处写了 <break> 或 <cue/>，整段包 <speak>…</speak>，词要转义；没有，就是原样接起来的词（和以前一样，不包 <speak>）。
 * 只有 cue 没有停顿时，拉丁字母、数字之间的空格留在 cue 前面。
 * @returns {string}
 */
export function renderRun(parts, breaks, cues = []) {
  const ssml = writesMarkup(breaks, cues);
  const said = (part) => (ssml ? escapeSsml(part) : part);
  let text = `${written(cues[0]) ? cueTag(cues[0]) : ''}${said(parts[0])}`;
  for (let i = 1; i < parts.length; i += 1) {
    const pause = breaks[i] ?? null;
    const cue = cues[i];
    if (pause === null && !written(cue)) {
      text = glue(text, said(parts[i]));
      continue;
    }
    // 只有 cue 的缝：两边是拉丁字母、数字时，空格留在 cue 前面（glue 本来在两个词之间放的那一个）
    const gap = pause !== null ? `<break time="${pause}ms"/>` : glue(text, said(parts[i])).length > text.length + said(parts[i]).length ? ' ' : '';
    text = `${text}${gap}${written(cue) ? cueTag(cue) : ''}${said(parts[i])}`;
  }
  return ssml ? `<speak>${text}</speak>` : text;
}

/**
 * 把一串段落（按说话的先后）合成几次请求。items[i] 是 { text, pause, inline, cue?, row?, endRow? }：
 *   text    这一段要说的词（调用方已经去掉了舞台提示、台本标记）
 *   pause   这一段后面的停顿（毫秒）。配音是这一段的 pauseAfterMs 加上后一段的 pauseBeforeMs（同一个缝）
 *   inline  这个停顿在一段话里面（不是章节的末尾，也不是空行接着的）。app 由切割决定，配音由章节和 join 决定
 *   cue     这一段开头的一下子的声音（规范名字）。写在它在文字里的位置：是请求的第一段，就写在请求的开头；前面还有话，写在缝上。
 *           带 cue 的缝，停顿是 0 也并（声音跟着前面的话说出来）；停顿不是 0 时照停顿的规则。不给，缝只按停顿并
 *   row、endRow  这一段从台本的哪一行开始、到哪一行结束（endRow 不给就是 row；两样都不给就当同一行）。带 cue 的缝只在同一行里并：换了行，声音就属于另一句
 * canJoin(prev, next)：调用方的条件（同一参考、同一语速、名字、续接……）；prev 是这次请求已经有的最后一段，next 是接在后面的候选。
 * max：一次请求最多多少个单位（measure 量），写了 <break>、<cue/> 的文字连标记一起算。measure 默认 UTF-16 单位。
 * maxPauseMs：一个请求里写下的停顿（<break>）加起来最多多少毫秒（环境声明的，平台文档：多个相加，总长超过上限只留前面的）；加起来超了，就在那一处切开。不给就不限；0 就是任何停顿都不并（只有带 cue 的零停顿缝能并）。
 * @returns {{ first: number, last: number, text: string, ssml: boolean, words: string, pause: number, pauseCount: number, cueCount: number }[]}
 *   first、last 是 items 的下标（含头含尾）；text 是要发出去的文字；words 是不带标记的词；pause 是最后一段后面的停顿（毫秒）；
 *   pauseCount 是并进来的缝里有停顿的有几处，cueCount 是请求里写了几处 <cue/>（开头的也算）。
 */
export function requestsOf(items, { max = Number.POSITIVE_INFINITY, canJoin, measure = (text) => text.length, maxPauseMs = Number.POSITIVE_INFINITY }) {
  const runs = [];
  items.forEach((item, index) => {
    const run = runs[runs.length - 1];
    const cue = item.cue ?? null;
    if (run) {
      const prev = items[run.last];
      const tail = run.parts[run.parts.length - 1];
      const pause = prev.pause === 0 || (prev.pause <= PUNCTUATION_PAUSE_MAX_MS && ENDS_IN_PUNCTUATION.test(tail))
        ? null
        : Math.max(BREAK_MIN_MS, Math.round(prev.pause - PUNCTUATION_PAUSE_MS));
      // 一个请求里写下的停顿（<break>）加起来不超过 maxPauseMs：平台把多个 <break> 相加，总长超过上限只留前面的。靠标点的停顿没有写，不算
      const pausable = prev.inline && prev.pause > 0 && maxPauseMs > 0 && run.breaks.reduce((sum, ms) => sum + (ms ?? 0), pause ?? 0) <= maxPauseMs;
      const sameRow = (prev.endRow ?? prev.row) === item.row;
      const joinable = cue === null ? pausable : sameRow && (prev.pause === 0 || pausable);
      if (joinable && hasWords(prev.text) && hasWords(item.text) && canJoin(prev, item)) {
        const parts = [...run.parts, item.text];
        const breaks = [...run.breaks, pause];
        const cues = [...run.cues, cue];
        if (measure(renderRun(parts, breaks, cues)) <= max) {
          run.parts = parts;
          run.breaks = breaks;
          run.cues = cues;
          if (prev.pause > 0) run.pauseCount += 1;
          if (cue !== null) run.cueCount += 1;
          run.last = index;
          return;
        }
      }
    }
    runs.push({ first: index, last: index, parts: [item.text], breaks: [null], cues: [cue], pauseCount: 0, cueCount: cue === null ? 0 : 1 });
  });
  return runs.map((run) => ({
    first: run.first,
    last: run.last,
    text: renderRun(run.parts, run.breaks, run.cues),
    ssml: writesMarkup(run.breaks, run.cues),
    words: run.parts.reduce(glue),
    pause: items[run.last].pause,
    pauseCount: run.pauseCount,
    cueCount: run.cueCount,
  }));
}
