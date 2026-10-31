// SPDX-License-Identifier: Apache-2.0
//
// 查重的文字比较（流程层，纯计算）：两段文字重合多少，查重对文字比的是重合度。
// 阈值不在这里：哪些文字和哪些文字比、超过多少算太多，在 lib/duplicate-check.mjs（阈值是拿真实数据标定的，依据的数字写在那个文件头里）。这里只管「量」。
//
//   compareTexts(candidate, source, options?) -> { candidateTokens, sourceTokens, rougeL, copied }
//   tokenizeText(text)                         把文字切成词：中文按字，拉丁字母的文字按词（下面「怎么切词」）
//
// 两种量，各管一种抄法：
//
//   rougeL   ROUGE-L 的 F1（Lin 2004，https://aclanthology.org/W04-1013/）：两段词序列的最长公共子序列（不要求连续，要求次序一样）长度 LCS，
//            精确率 = LCS / 候选的词数，召回率 = LCS / 来源的词数，F1 = 2·LCS / (两边词数之和)。Self-Instruct（https://arxiv.org/abs/2212.10560）
//            丢掉和已有指令 ROUGE-L 达到 0.7 的新指令，这是先例。管「照抄，改了几个词」：整段抄、增删换几个词，F1 都还很高。
//            短的文字（一句话的描述）上它有个弱点：用同一批词描述同一类声音的两个人，没抄也会有不低的 F1（「温暖的男声，语速舒缓」对
//            「温暖的男声，语速偏慢」），所以阈值要拿真实数据标定，不能直接用 0.7。
//   copied   抄用的比例，两个方向：词组 = 连续 K 个词（K 见 SHINGLE_WORDS、SHINGLE_CHARACTERS）。
//            ratio    候选里的词组有多少个原样出现在来源里，除以候选的词组总数：候选整篇或大半是抄来源的；
//            coverage 来源里的词组有多少个原样出现在候选里，除以来源的词组总数：来源整篇（或大半）被放进了一篇更长的候选里，ratio 被候选的其余部分稀释，看不出来，coverage 看得出来。
//            都不管词组在对方里的次序，所以管「换了段落和句子的次序再抄」（ROUGE-L 的 LCS 要次序一样，次序反了就掉下来），也管夹着抄的一两段。
//            不同的人各写各的，很少碰巧写出连续 4 个词一样的词组（短语如「适合旁白与故事讲述」除外）。
//
//   为什么两种都要：ROUGE-L 有上面说的先例（Self-Instruct），但它只认次序一样的抄法；词组比例补上次序变了的和夹带的。两种各自有阈值，任何一种超过都算。
//
// 怎么切词（规则只在这里写一遍）：
//   - 先用 lib/fidelity.mjs 的 tokenizeTranscript（核对转写用的同一个）：NFKC 规范化、转小写（所以全角字母和半角一样、大小写不分），
//     标点、符号、空白都只当分隔，撇号去掉（don't 就是 dont）；汉字和日文假名每个字一个词，其余文字（拉丁字母、西里尔字母、阿拉伯字母、谚文……）连在一起是一个词。
//   - 再把泰文、老挝文、高棉文、缅甸文、藏文里连在一起的一串切成每个字一个词：这几种文字词和词之间不留空格，一整句连在一起，当一个词比较等于没比。
//   不做词干还原、不去停用词：「的」「a」「and」这样的词在两段文字里都出现，会抬高 ROUGE-L；这一点由阈值的标定一并吸收（标定用的是没去停用词的同样算法）。
//
// 返回：
//   candidateTokens、sourceTokens   两边的词数
//   rougeL    { lcs, precision, recall, f1 }；任何一边一个词也没有就是 { lcs: 0, precision: null, recall: null, f1: null }；
//             两边词数的乘积超过 options.maxCells（默认 MAX_CELLS）就不算，是 null（最长公共子序列要算这么多个格子，一份几万字的文字会算很久）
//   copied    { candidate, source, shared, ratio, sharedSource, coverage }：candidate、source 是两边的词组个数，shared 是候选的词组里原样在来源里的个数（候选里同一个词组出现几次算几个），
//             ratio = shared / candidate；sharedSource 是来源的词组里原样在候选里的个数，coverage = sharedSource / source。哪一边一个词组也凑不出来（词数不到 K），对应的比例就是 null，不假装是 0
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { tokenizeTranscript } from './fidelity.mjs';

/** 词组的长度：拉丁字母这类按词切的文字，连续 4 个词一组。 */
export const SHINGLE_WORDS = 4;
/** 按字切的文字（中文、日文、泰文……），一个字比一个词少得多的信息，连续 8 个字一组（差不多是 4 个词的量）。 */
export const SHINGLE_CHARACTERS = 8;
/** ROUGE-L 最多算多少个格子（两边词数的乘积）：2500 万，一次约几十毫秒到一两百毫秒。 */
export const MAX_CELLS = 25_000_000;

// 词和词之间不留空格的文字：tokenizeTranscript 把一串连着的字母当一个词，这里再按字拆开
const NO_SPACES = /[\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}\p{scx=Tibetan}]/u;
// 一个词就是一个字的文字：用来判断整段文字是「按字切」还是「按词切」，决定词组多长
const CHARACTER = /^[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}\p{scx=Tibetan}]$/u;

/**
 * 把文字切成词：规则见文件头「怎么切词」。
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeText(text) {
  const out = [];
  for (const token of tokenizeTranscript(String(text))) {
    if (NO_SPACES.test(token)) out.push(...token);
    else out.push(token);
  }
  return out;
}

const characterShare = (tokens) => (tokens.length === 0 ? 0 : tokens.filter((token) => CHARACTER.test(token)).length / tokens.length);

/** 词序列换成整数序列（比整数比比字符串快）：两边共用一张表。 */
function toIds(a, b) {
  const ids = new Map();
  const id = (token) => {
    let n = ids.get(token);
    if (n === undefined) { n = ids.size; ids.set(token, n); }
    return n;
  };
  return [Int32Array.from(a, id), Int32Array.from(b, id)];
}

/** 最长公共子序列的长度：一行的动态规划，O(n·m) 时间，O(min(n, m)) 空间。 */
function lcsLength(first, second) {
  const [long, short] = first.length >= second.length ? [first, second] : [second, first];
  const row = new Int32Array(short.length + 1);
  for (let i = 0; i < long.length; i++) {
    const item = long[i];
    let diagonal = 0;
    for (let j = 1; j <= short.length; j++) {
      const above = row[j];
      row[j] = item === short[j - 1] ? diagonal + 1 : Math.max(above, row[j - 1]);
      diagonal = above;
    }
  }
  return row[short.length];
}

/** 一个词序列里每一组连续 size 个词，连成一个键。 */
function shingles(tokens, size) {
  const out = [];
  for (let i = 0; i + size <= tokens.length; i++) out.push(tokens.slice(i, i + size).join('\u0001'));
  return out;
}

/**
 * 候选文字和来源文字重合多少。规则、两种量的意思和返回的形状见文件头。
 * @param {string} candidate 新的文字
 * @param {string} source 来源的文字
 * @param {{ maxCells?: number }} [options]
 * @returns {{ candidateTokens: number, sourceTokens: number, rougeL: { lcs: number, precision: number | null, recall: number | null, f1: number | null } | null, copied: { candidate: number, source: number, shared: number, ratio: number | null, sharedSource: number, coverage: number | null } }}
 */
export function compareTexts(candidate, source, { maxCells = MAX_CELLS } = {}) {
  if (typeof candidate !== 'string' || typeof source !== 'string') throw new TypeError('要比的两段文字都必须是字符串');
  const a = tokenizeText(candidate);
  const b = tokenizeText(source);

  let rougeL;
  if (a.length === 0 || b.length === 0) rougeL = { lcs: 0, precision: null, recall: null, f1: null };
  else if (a.length * b.length > maxCells) rougeL = null;
  else {
    const [x, y] = toIds(a, b);
    const lcs = lcsLength(x, y);
    rougeL = { lcs, precision: lcs / a.length, recall: lcs / b.length, f1: (2 * lcs) / (a.length + b.length) };
  }

  const size = characterShare(a) > 0.5 ? SHINGLE_CHARACTERS : SHINGLE_WORDS;
  const own = shingles(a, size);
  const theirs = shingles(b, size);
  const ownSet = new Set(own);
  const theirSet = new Set(theirs);
  const shared = own.filter((key) => theirSet.has(key)).length;
  const sharedSource = theirs.filter((key) => ownSet.has(key)).length;
  const copied = {
    candidate: own.length, source: theirs.length, shared, ratio: own.length === 0 ? null : shared / own.length,
    sharedSource, coverage: theirs.length === 0 ? null : sharedSource / theirs.length,
  };
  return { candidateTokens: a.length, sourceTokens: b.length, rougeL, copied };
}
