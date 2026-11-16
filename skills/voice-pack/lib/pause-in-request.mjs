// SPDX-License-Identifier: Apache-2.0
//
// 一段话、一章一次请求（配音，lib/dub.mjs 第 5c 步）：相邻的几段并成一次请求，请求里的短停顿写在文字里；放不下一个请求的，只在边界上切，先切强的边界。一场戏一个请求（第 5a 步）里的短停顿也用这里的写法。
// 规则只写在这里，这个文件只算和写，不碰音频，不认模型。
//
// 哪几段能并：调用方用 canJoin 说哪两段能并（同一章、同一参考段、同一语速……，lib/dub.mjs 有自己的几条）；这里再加两条：
//   - 两段之间的停顿不超过 maxPauseMs（一个请求里一处停顿最多多长：环境声明的，适配器的 limits.maxPauseInRequestMs；没声明是 DEFAULT_MAX_PAUSE_IN_REQUEST_MS）。
//     长过它的停顿在那里切开：前一段的停顿记在它后面，由拼接插进对应长度的静音（lib/mix.mjs 规则 2，插多长就是多长）。是每一处各比各的，不是加起来比。
//   - 两段都有要念的字。
//   能并的连着的几段是一串。一串放得下（每一个上限都放得下：连写法、开头另加的字一起，那个上限的 measure 量出来不超过它的 max），就是一次请求，不切。
//   上限可以有几个，各量各的（配音给两个：要念的字、发出去的字，见 lib/dub.mjs 第 5c 步）；一个都没有就不因为长度切。
// 放不下时在哪里切（requestsOf）：每个缝有一个强弱（调用方用 boundary 说，BOUNDARIES 从弱到强：sentence 一行里面，paragraph 两行之间，scene 两行之间有整行只有停顿的一行，由调用方认）。
//   先在最强的那一种缝上把这一串分成几块；相邻的几块并起来放得下就并（切口越少越好）；一块自己放不下，再在它里面次一等的缝上照样分，一直到一段一段。
//   一块自己放不下而切开的，不和前后的块并：切口留在强的边界上。只有一段、还是放不下的（一句话就超过上限），照样是一次请求。
//   因为放不下才切的那一处（缝本身能并），请求上记 cutBefore（那个缝的强弱）。
// 请求里的停顿怎么写（pauseWriting）：按要的长度，在量过的几种写法里挑出来的静音最接近的那一种（PAUSE_WRITINGS，数和量法在 models/ 里配音模型的说明「停顿」一节）。
//   前一段已经以标点结尾的（隔着收尾的尖括号标签看：「<whisper>快走！</whisper>」以感叹号结尾），标点自己就停：句末的（。！？…）从 afterSentence 那一组里挑，句中的（，、；：—）从 afterClause 那一组里挑；
//   没有的，从 plain 那一组里挑。挑出来是什么都不加的，两段直接接上（中文这类不加空格，英文这类加一个，见 separator）。
//   两行之间的缝（paragraph、scene）：写法后面换一行（台本里是两段，请求里也是两行），没写停顿的要的是 0。
// 文字里方括号的提示（[小声]、[laughs]）和尖括号标签是文字的一部分，跟着各自的段原样写进请求。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { endsWrittenWithoutSpaces, writtenWithoutSpaceBetween, TRAILING_TAGS } from '../protocol/lib/word-spacing.mjs';

/**
 * 环境没声明 limits.maxPauseInRequestMs 时，一个请求里一处停顿最多多长（毫秒）：成品里每一处静音最多留这么长
 * （出处：models/scene3.md「Pause between lines」最后一条，推理代码的上限；不是 PAUSE_WRITINGS 的读数）。比它长的写不出来，在那里切开交给拼接。
 * PAUSE_WRITINGS 里有读数比它长（[pause] 量到过 780 毫秒），那是读数上下有几百毫秒的出入，不按读数调高这个默认值：调高了，长过上限的停顿会写进请求、被截短。
 */
export const DEFAULT_MAX_PAUSE_IN_REQUEST_MS = 750;

/**
 * 请求里的停顿写法，和每一种量出来的静音（毫秒，几种声音、几句一起的中位数）。三组按前一段怎么收尾分（见文件头），写法接在前一段后面；
 * cjk 是前一段以汉字、假名或它们的全角标点收尾（隔着收尾的引号、括号，protocol/lib/word-spacing.mjs 的 endsWrittenWithoutSpaces）时的写法，other 是别的
 * （英文这类，写法前后带空格；韩文的词和词之间有空格，也用它）；空串是什么都不加。
 * 出处：models/scene3.md「Pause between lines」（日期、量法、读数都在那里）。
 */
export const PAUSE_WRITINGS = Object.freeze({
  plain: Object.freeze([
    Object.freeze({ ms: 115, cjk: '', other: '' }),
    Object.freeze({ ms: 325, cjk: '，', other: ', ' }),
    Object.freeze({ ms: 780, cjk: '[pause]', other: ' [pause] ' }),
  ]),
  afterClause: Object.freeze([
    Object.freeze({ ms: 325, cjk: '', other: '' }),
    Object.freeze({ ms: 730, cjk: '[pause]', other: ' [pause] ' }),
  ]),
  afterSentence: Object.freeze([
    Object.freeze({ ms: 605, cjk: '', other: '' }),
  ]),
});

const HAS_WORDS = /[\p{L}\p{N}]/u;
/** 以句末的标点结尾（引号、括号可以在标点后面）：标点自己就停，停得长。 */
const ENDS_A_SENTENCE = /[。！？…!?.]["'”’」』）)】》]*$/u;
/** 以句中的标点结尾：标点自己就停，停得短。 */
const ENDS_A_CLAUSE = /[，、；：,;:—]["'”’」』）)】》]*$/u;

export const hasWords = (text) => HAS_WORDS.test(text);

/**
 * 两段之间要停 ms 毫秒，写在前一段后面的字（量过的写法里最接近的那一种，见 PAUSE_WRITINGS）。是空串就是不加。
 * @param {string} before 前一段的文字
 * @param {number} ms 要停多少毫秒（0 是没有停顿）
 * @returns {string}
 */
export function pauseWriting(before, ms) {
  const tail = before.trimEnd().replace(TRAILING_TAGS, ''); // 收尾的标签（</whisper>）不念：隔着它看前一段怎么收尾
  let group = PAUSE_WRITINGS.plain;
  if (ENDS_A_SENTENCE.test(tail)) group = PAUSE_WRITINGS.afterSentence;
  else if (ENDS_A_CLAUSE.test(tail)) group = PAUSE_WRITINGS.afterClause;
  const nearest = group.reduce((best, item) => (Math.abs(item.ms - ms) < Math.abs(best.ms - ms) ? item : best));
  return endsWrittenWithoutSpaces(tail) ? nearest.cjk : nearest.other;
}

/**
 * 两段之间放的字：写法（pauseWriting）；写法是空的，接的地方有一边是汉字、假名或它们的全角标点（protocol/lib/word-spacing.mjs 的 writtenWithoutSpaceBetween）的什么都不放，
 * 别的放一个空格（韩文和英文一样）。写法自己带着要的空格（英文的写法前后有空格）。before、after 是前一段、后一段（去掉了两头的空白）。
 */
function separator(before, after, writing) {
  if (writing !== '') return writing;
  return writtenWithoutSpaceBetween(before, after) ? '' : ' ';
}

/** 两段之间的缝有多强，从弱到强（见文件头「放不下时在哪里切」）：一行里面（句子之间、行里写的停顿），两行之间（段落），两行之间写了停顿（场景）。 */
export const BOUNDARIES = Object.freeze(['sentence', 'paragraph', 'scene']);

/**
 * 把一串段（按说话的先后）并成几次请求。items[i] 是 { text, pause }：
 *   text   这一段要说的字（提示在原位）
 *   pause  这一段和后一段之间的停顿（毫秒）。配音是这一段的 pauseAfterMs 加上后一段的 pauseBeforeMs（同一个缝）
 * canJoin(prev, next, head)：调用方的条件，prev、next 是相邻的两段；head 是 prev 所在的这一串的第一段（从 head 到 prev，中间的缝都并得了；prev 前面的缝并不了，head 就是 prev），
 *   调用方要看这一串里已经有什么（例如前面已经写了什么提示）时用。按次序问：先问前面的缝，再问后面的。
 * boundary(prev, next)：这个缝有多强，BOUNDARIES 里的一个，默认 'sentence'（都一样强时，就是从前往后能并就并）。paragraph、scene 的缝在请求里换一行。
 * limits：一次请求的上限，每项 { max, measure, extra? }，一次请求要每一项都放得下；默认没有，不因为长度切。
 *   max 是最多多少个单位（measure 量），连写法一起算。每一段、每个缝只量一次，一串很长的话也不把整段反复重量：一段量它自己；一个缝量两段接起来比各量各的多出来的
 *   （measure(前一段 + 缝里放的字 + 后一段) 减去两段各自的）。数码位这类能相加的，缝就是缝里放的字；只数要念的字（连着的空白算一个，两头的不算，lib/synthesis-limits.mjs）时，
 *   缝里的换行、空格单独量是 0，接起来才算得出来。extra(item)：以 item 开头的请求另外要算进这个上限的字数（例如请求开头另加的提示），默认 0。
 * maxPauseMs：一处停顿最多多长才写进请求（见文件头）。
 * @returns {{ first: number, last: number, text: string, pauseCount: number, cutBefore?: string }[]}
 *   first、last 是 items 的下标（含头含尾）；text 是要发出去的文字（各段去掉两头空白接起来）；pauseCount 是并进来的缝里有停顿（pause 大于 0）的有几处；
 *   cutBefore：这次请求和前一次之间的缝本来能并，因为放不下才切开的，是那个缝的强弱（BOUNDARIES 里的一个）；不是就没有这个键。
 */
export function requestsOf(items, { limits = [], canJoin, boundary = () => 'sentence', maxPauseMs = DEFAULT_MAX_PAUSE_IN_REQUEST_MS }) {
  const texts = items.map((item) => item.text.trim());
  // 第 i 个缝（第 i 段和第 i+1 段之间）：并不了是 null；并得了是 { level（BOUNDARIES 的下标）, between（两段之间放的字）, paused }。head 是第 i 段所在的这一串的第一段
  const seams = [];
  let head = 0;
  for (let i = 0; i + 1 < texts.length; i += 1) {
    const before = texts[i];
    if (!(items[i].pause <= maxPauseMs && hasWords(before) && hasWords(texts[i + 1]) && canJoin(items[i], items[i + 1], items[head]))) {
      seams.push(null);
      head = i + 1;
      continue;
    }
    const level = BOUNDARIES.indexOf(boundary(items[i], items[i + 1]));
    if (level === -1) throw new TypeError(`boundary must return one of ${BOUNDARIES.join(', ')}`);
    const writing = separator(before, texts[i + 1], pauseWriting(before, items[i].pause));
    seams.push({ level, between: level === 0 ? writing : `${writing.trimEnd()}\n`, paused: items[i].pause > 0 });
  }
  // 前缀和：每个上限各一份，第 a 段到第 b 段（含）并成一次请求有多大，不用重量。缝按两段接起来多出来的量（见上）
  const sized = limits.map(({ max, measure, extra = () => 0 }) => {
    const sizes = texts.map(measure);
    const textSum = [0];
    sizes.forEach((size, i) => textSum.push(textSum[i] + size));
    const seamSum = [0];
    seams.forEach((seam, i) => seamSum.push(seamSum[i] + (seam === null ? 0 : measure(texts[i] + seam.between + texts[i + 1]) - sizes[i] - sizes[i + 1])));
    return { max, sizeOf: (a, b) => extra(items[a]) + textSum[b + 1] - textSum[a] + seamSum[b] - seamSum[a] };
  });
  const fits = (a, b) => sized.every(({ max, sizeOf }) => sizeOf(a, b) <= max);

  // 一块（第 a 段到第 b 段，中间的缝都能并，最强的不超过 level）切成放得下的几次请求，规则见文件头
  const split = (a, b, level) => {
    if (a === b || level < 0 || fits(a, b)) return [[a, b]];
    const blocks = [];
    let start = a;
    for (let k = a; k < b; k += 1) {
      if (seams[k].level === level) {
        blocks.push([start, k]);
        start = k + 1;
      }
    }
    blocks.push([start, b]);
    if (blocks.length === 1) return split(a, b, level - 1);
    const out = [];
    let current = null;
    for (const [x, y] of blocks) {
      if (!fits(x, y)) {
        if (current !== null) out.push(current);
        current = null;
        out.push(...split(x, y, level - 1)); // 自己放不下：在里面次一等的缝上切，不和前后的块并
      } else if (current !== null && fits(current[0], y)) {
        current = [current[0], y];
      } else {
        if (current !== null) out.push(current);
        current = [x, y];
      }
    }
    if (current !== null) out.push(current);
    return out;
  };

  const requests = [];
  let start = 0;
  for (let i = 0; i < items.length; i += 1) {
    if (i < seams.length && seams[i] !== null) continue;
    split(start, i, BOUNDARIES.length - 1).forEach(([first, last], k) => {
      let text = texts[first];
      let pauseCount = 0;
      for (let j = first; j < last; j += 1) {
        text += seams[j].between + texts[j + 1];
        if (seams[j].paused) pauseCount += 1;
      }
      requests.push({ first, last, text, pauseCount, ...(k === 0 ? {} : { cutBefore: BOUNDARIES[seams[first - 1].level] }) });
    });
    start = i + 1;
  }
  return requests;
}
