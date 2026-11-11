// SPDX-License-Identifier: Apache-2.0
//
// 台本的写法（流程层，纯函数）：照台本配出来的一段录音，转写听出来的字里，和台本读音一样的那几截改成台本的写法。
// 做包时素材给了 scriptText 的段用它（lib/make-pack-transcribe.mjs 的 writeFromScripts，标完提示标注以后）；别的程序要同样的结果，调这里，不另写一份。
//
//   writtenFromScript(script, heard) -> { text, fromScript }
//     script 是台本（方括号里的提示、名字不算字，去掉再比），heard 是转写听出来的字。text 是改好的字，和 heard 一样长、只换字；
//     fromScript 是改了的那几截 [{ heard, written }]，一截都没改是空数组。
//   annotationWrittenAs(annotated, heard, written) -> string | undefined
//     heard 的提示标注（去掉方括号就是 heard）里的字照 written 换（方括号原样留着）；去掉方括号和 heard 对不上，undefined。
//   readsAlike(a, b) -> boolean   两个字都是汉字、都在读音表里、读音一样（不计声调）
//   readingOf(letter) -> string | undefined
//     一个字不计声调的读音的记号：两个字读音一样，记号就一样。记号只拿来互相比，不是拼音（现在是读音表里同一个读音的第一个字），
//     换了版本可能变，别存下来跨版本比。读音表里没有的字（不是汉字、不在表里、不止一个字）是 undefined。
//     别的程序要按读音比字，用它，不直接读 lib/mandarin-readings.json；那个文件的格式或位置改了，CHANGELOG 里写明。
//
// 规则：
//   - 两边的字母和数字按次序对齐（改、加、漏的最少；读音一样的一对算半个改动）。标点、空白、换行不对齐，照听到的留着。
//   - 听到的字里连着的一截和台本不一样的字（标点或空白断开它；台本里有、没听到的字不断开它；听到了、台本里没有的字，在里面或挨着，
//     算这一截的），每个字都对上了台本的一个字，两边都是汉字，读音都一样（readsAlike），这一截整截写成台本的字：
//     「摸爬，脸刀」对台本「莫慌，镰刀」，脸 liǎn 和镰 lián 读音一样，写成「摸爬，镰刀」。
//   - 别的截整截照听到的留着，不逐字拆开：有一个字读音不一样（「摸爬」对「莫慌」：摸和莫一样，爬和慌不一样），有一个台本里没有的字
//     （「脸呀刀」对「镰刀」），有不是汉字的字，有读音表里没有的字。读音不一样的地方，分不清是配音念成了别的还是转写听错了，
//     参考的字要对得上录音里念的，所以留着听到的。
//   - 没听到的不写进去：台本里多出来的字、整句，都不加。
// 读音是每个字的第一个普通话读音（Unihan 的 kMandarin，不计声调；表和来历在 lib/mandarin-readings.json）：多音字只认第一个（了只有 le）。
// 只对中文用：别的语言没有读音依据，调用方照听到的留着（做包只对语言是 zh 的段调，lib/make-pack.mjs）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import readings from './mandarin-readings.json' with { type: 'json' };

let table;
/** 字 -> 它那一行的第一个字（同一个读音的字指到同一个字）。第一次用时建。读音表里只有汉字。 */
function readingTable() {
  if (table !== undefined) return table;
  table = new Map();
  for (const line of readings.lines) {
    const [first] = line;
    for (const letter of line) table.set(letter, first);
  }
  return table;
}

const LETTER = /[\p{L}\p{N}]/u;
const plainLetter = (letter) => letter.normalize('NFKC').toLowerCase();
const sameLetter = (a, b) => plainLetter(a) === plainLetter(b);

/** 一个字不计声调的读音的记号（文件头）：读音表里没有的（不是汉字、不止一个字）是 undefined。 */
export function readingOf(letter) {
  return readingTable().get(letter);
}

/** 两个字都是汉字、都在读音表里、读音一样（不计声调）。 */
export function readsAlike(a, b) {
  const reading = readingOf(a);
  return reading !== undefined && reading === readingOf(b);
}

/** 照台本把听到的字里读音一样的几截写成台本的写法（文件头「规则」）。 */
export function writtenFromScript(script, heard) {
  const scriptLetters = [];
  for (const [piece, cues] of script.matchAll(/((?:\[[^\]]*\][ \t]*)+)|[\p{L}\p{N}]/gu)) {
    if (cues === undefined) scriptLetters.push(piece);
  }
  const out = [...heard];
  const heardLetters = out.flatMap((letter, at) => (LETTER.test(letter) ? [{ letter, at }] : []));
  const n = heardLetters.length;
  const m = scriptLetters.length;
  const swap = (i, j) => (sameLetter(heardLetters[i].letter, scriptLetters[j]) ? 0 : readsAlike(heardLetters[i].letter, scriptLetters[j]) ? 0.5 : 1);
  // 改、加、漏最少的对法：读音一样的一对算半个改动
  const cost = Array.from({ length: n + 1 }, (_, i) => Float64Array.from({ length: m + 1 }, (__, j) => i + j));
  for (let i = 1; i <= n; i += 1) for (let j = 1; j <= m; j += 1) cost[i][j] = Math.min(cost[i - 1][j - 1] + swap(i - 1, j - 1), cost[i - 1][j] + 1, cost[i][j - 1] + 1);
  const pairs = [];
  for (let i = n, j = m; i > 0 || j > 0; ) {
    if (i > 0 && j > 0 && cost[i][j] === cost[i - 1][j - 1] + swap(i - 1, j - 1)) pairs.unshift({ i: (i -= 1), j: (j -= 1) });
    else if (i > 0 && cost[i][j] === cost[i - 1][j] + 1) pairs.unshift({ i: (i -= 1), j: null });
    else pairs.unshift({ i: null, j: (j -= 1) });
  }
  const stretches = [];
  let open = false;
  for (const pair of pairs) {
    // 台本里有、没听到的字：听到的字里没有它，这一截接着往下。听到了、台本里没有的字：算不一样，归进它所在或挨着的那一截，那一截就照听到的留着
    if (pair.i === null) continue;
    const differs = pair.j === null || !sameLetter(heardLetters[pair.i].letter, scriptLetters[pair.j]);
    if (differs && open && heardLetters[pair.i].at === heardLetters[stretches.at(-1).at(-1).i].at + 1) stretches.at(-1).push(pair);
    else if (differs) stretches.push([pair]);
    open = differs;
  }
  const fromScript = [];
  for (const stretch of stretches) {
    if (!stretch.every(({ i, j }) => j !== null && readsAlike(heardLetters[i].letter, scriptLetters[j]))) continue;
    for (const { i, j } of stretch) out[heardLetters[i].at] = scriptLetters[j];
    fromScript.push({ heard: stretch.map(({ i }) => heardLetters[i].letter).join(''), written: stretch.map(({ j }) => scriptLetters[j]).join('') });
  }
  return { text: out.join(''), fromScript };
}

/** heard 的提示标注照 written 换字（writtenFromScript 只一个字换一个字，方括号原样留着）；去掉方括号和 heard 对不上：undefined。 */
export function annotationWrittenAs(annotated, heard, written) {
  const from = [...heard];
  const to = [...written];
  let at = 0;
  let linedUp = from.length === to.length;
  const out = annotated.replace(/\[[^\]]*\]|[\s\S]/gu, (part) => {
    if (part.startsWith('[') && part.endsWith(']') && part.length > 1) return part;
    if (part !== from[at]) linedUp = false;
    return to[at++] ?? part;
  });
  return linedUp && at === from.length ? out : undefined;
}
