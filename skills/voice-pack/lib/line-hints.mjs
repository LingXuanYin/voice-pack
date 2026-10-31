// SPDX-License-Identifier: Apache-2.0
//
// 台词的提示（流程层）：从一句台词本身读出两样东西，给按台词挑参考用——
//   1 舞台提示：台词里括号中的语气说明，例如（耳语）、(angry)、*笑*、【叹气】。词表是 vocab/cues.json。
//   2 文字的语种：按文字系统认（汉字、假名、谚文、西里尔字母……）。拉丁字母认不出是英语还是法语，所以给的是一组候选。
// 只做计算，不用模型，不读文件；规则的全貌见 lib/reference-pick.mjs 的文件头。
//
// 舞台提示的写法（SKILL.md 的台本标记表里的「舞台提示」）：
//   括号     （…）或 (…)，全角半角可以混着写；【…】；*…*。括号里最多 30 个字，超过的不是舞台提示，是台词的一部分。
//            只有开括号没有闭括号、括号里是空的，也不是舞台提示。
//   强调     **…**、***…***（markdown 的加粗：星号和字之间不能有空白，前后的星号一样多，多长都算）不是舞台提示，两种选法下都一样：
//            去掉星号，里面的字留着，里面有词表里的词也一样（**微笑** 是加粗的「微笑」）。
//            星号和字之间有空白的（3 * 4 * 5、行首的项目符号 `* `）不是强调，原样。
//   哪些算   括号里的内容算不算舞台提示，看调用方用 readDirections 的选项 unrecognized 选：
//              'keep'（默认）  括号里的内容要整个都是词表里的提示才算：至少有一个词表里的词，而且每个字都属于词表里的某个词，
//                             或者是连接成分：地、的、着、和、说、道、了、声，两个字的一下、起来、说话，英文的 and（整词），空白，标点和符号；
//                             括号里有停顿的词时，时长也是连接成分（见「停顿的时长」）。没认出来的字连续的一段一段单独看，
//                             两个字的连接成分要挨着写才算（「一笑下」不是「一下」）。
//                             （生气地大喊）、（生气地说）、（笑了笑）、（大笑起来）、（停顿 2 秒）、(angry and sad)、*笑* 算。
//                             （笑话比赛）里有「笑」，可是「话比赛」是别的字，不算；(the sad truth) 里有 sad，可是 the、truth 是别的字，不算；
//                             *非常搞笑* 同理。时长以外的数字、别的单位和别的字（他、人、片刻……）都不是连接成分。
//                             英文的副词（heavily、loudly……）也不是连接成分。词表里的词加副词、动词尾巴的固定写法，写成整词放进词表
//                             （vocab/cues.json）：叹了口气、压低声音、放慢语速、沉默片刻、in a whisper、sighing heavily 都是。
//                             整词里要含一个词表里原有的词，并归到和它同一类、同一个名字，「拿掉」下读出来的意思才和没有这条整词时一样。
//                             例外：整词的头或尾和另一个词重叠时，照「重叠时取最长的」，较短的那个落选（叹了口气愤：整词叹了口气盖住了气愤的「气」，
//                             气愤落选，只剩 sigh；微笑出声：整词笑出声盖住了微笑的「笑」，微笑落选，只剩 laugh）；加整词之前，把它和词表里每个词的重叠都列出来看一遍。
//                             词表里原来没有的词（sighs、quietly、深呼吸）：加进去以后，「拿掉」下原来认不出的括号变成认得出，这是目的；原来认得出的括号里，
//                             同一类的词取先出现的，所以新词排在前面会顶掉后面的（大声笑：大声是 shout，排在笑前面，读作 shout，加大声以前是 laugh）。
//                             加词之前，也把它和词表里每个词前后拼起来读一遍，把读法变了的列出来看。
//                             结构规则：括号（（…）、(…)、【…】，不含 *…*：强调的副词是正文，他*认真地*看着我）里整个写法是「副词 + 地」「副词 + 地说」「副词 + 地道」「副词 + 地说道」，
//                             副词是 2–8 个汉字（（认真地说）、（郑重地道）、（无奈地）），副词词表里认不认识都算：词表里有词就照词表读意思（（他生气地说）是 angry），
//                             一个词也没有就是没有类别的舞台提示：情绪、风格、动作都是空，directions 里 recognized 为 false。
//                             已知的取舍：名词收尾的括号（（目的地）、（发源地））写法一样，也算，不念；要念出来就别加括号。代码里在 ADVERB_CUE_RE，要改，改这一处。
//                             连接成分和整词就是这些，代码里在 CONNECTORS_RE、AND_RE、DURATION_RE 和词表里；要放宽，改这里，改这一处。
//                             算的：从台词里拿掉，不念出来，在那里把台词切成两段，记在 directions 里（recognized 为 true），用来挑参考。
//                             不算的：括号里的字是要念的话，一个字不丢，不切段，不记进 directions，括号照原样留着；不算的 *…* 去掉星号，留下中间的字。
//                             丢内容比多念几个字糟：普通正文里常有括号和强调，「会议在 2019 年（疫情之前）举行。」不能丢了「疫情之前」。
//              'remove'       30 个字以内的括号（含 *…*，不含上面的 **…**）一律当舞台提示，拿掉，不念出来（读了「画外音」两个字出来比丢一句提示糟得多），
//                             在那里切段。括号里只要有一个词表里的词就认得出（汉字按子串：（笑话比赛）里有「笑」，也认得出），意思照读，
//                             记在 directions 里，recognized 为 true；一个词也没有的认不出，也拿掉，如实记着 recognized 为 false，
//                             调用方可以告诉用户。结构规则认出的（（认真地说））两种选法下读法一样（一个词也没有，recognized 为 false）。只给明确拿到配音台本的调用方用：agent 配音（lib/dub.mjs）、变声（lib/convert.mjs）、
//                             做包时判断文本能不能原样配音（lib/make-pack-pick.mjs）。
//            app 生成和别的读正文的地方用默认的 'keep'。选项由 lib/reference-pick.mjs 的 pickReferences 原样传下来；这条规则只在这里写。
//   上限     一行里最多认 1000 处舞台提示（两种选法一样；不算舞台提示的括号不计数）。第 1001 处起，连同后面的话到这一行结束，当正文，
//            原样留着，不再认。因为每一段都带着它前面所有提示的一份清单，提示多到几万处时内存和提示数的平方成正比，进程会崩；
//            正常的台本一行里没有这么多。
//   范围     一个提示管从它出现的地方，到这一行结束，或者下一个提示出现为止；换一行就清掉。一个新的情绪或风格提示整个换掉旧的
//            （先（耳语）再（生气），后面是生气，不再是耳语）。停顿、放慢、加快不改变情绪和风格。不算舞台提示的括号（'keep'）不管什么范围。
//   意思     词表里 emotion（情绪）、style（说话的方式）、actions（对节奏的要求：停顿、放慢、加快）三类。
//            一处提示里可以既有情绪又有风格（（生气地大喊））；同一类里有几个，取最前面的一个。
//            认词：拉丁字母整词匹配、不分大小写（danger 里的 anger 不算），汉字和假名按子串匹配；重叠时取最长的（微笑是 happy，不是 laugh）。
//   停顿     （停顿）算在前一段的后面；在一行开头就算在第一段的前面。停多久：括号里写了时长的按写的时长停，没写的每个停顿的词 600 毫秒
//            （见「停顿的时长」）。挨着的几处停顿加起来，封顶，和台本标记 [pause] 一样。放慢、加快只是这一段台词的语速标记（speed）。
//            一行里只有停顿（单独一行的（停顿 3 秒），可以夹着别的提示，没有要念的话）时，停顿放在前一句的后面（前一句可以在上一行），
//            没有前一句就放在后一句的前面，两种选法都一样；几行这样的行挨着，加起来，封顶。整段台词里一句要念的话都没有、只有停顿时，pieces 是空的，
//            停顿一共多少毫秒写在返回值的 unattachedPauseMs 里，没处可挂，调用方自己挂到相邻的一句上（lib/dub.mjs 就这么做）；有要念的话时它总是 0。
//   停顿的时长  括号里有停顿的词时，后面可以写时长，数字加单位：（停顿 2 秒）、（停顿半秒）、（停顿 500 毫秒）、(pause 500ms)、(pause for 2 seconds)。
//            数字是阿拉伯数字（可带小数，小数点前可以不写 0）或汉字数字（一、两、十二、一百二十、半）；单位是秒、秒钟、毫秒、s、ms、sec、second
//            （也认 secs、seconds、millisecond、milliseconds）；数字和单位之间可以有空白；数字前面和英文单位后面都不能紧跟字母或数字：
//            (pause x2s) 不算，(pause 2s二s)（两个时长连着写）不算，(pause 2sx) 不算，(pause 2 slowly) 也不算（s 是 slowly 的头一个字母，不是单位）。
//            按写的时长停。单位的换算、取整、上限和挨着的相加封顶，都是台本标记 [pause 2s] 的规则：正本是 tools/markup.mjs 的文件头「停顿」，
//            代码从那里引 PAUSE_MAX_MS 和 pauseMs，这里不再写一份；写得比上限长，就按上限停。
//            一处提示里读得出的时长有几个，停顿就是它们加起来（（停顿 1 秒，停顿 2 秒）停 3 秒）；时长管整处提示：（沉默，停顿 3 秒）停 3 秒，不再加每个词的 600 毫秒。
//            没有读得出的时长，每个停顿的词 600 毫秒：没写数字（（停顿））；数字没带单位（(pause 2)：[pause 2] 是 2 毫秒，写台词的人不是这个意思，所以不当时长）；
//            不是一个确定的数（几秒、三五秒、十几秒）。不写时长的默认值和 [pause] 的不一样，两处各管各的。
//            时长只跟着停顿的词：括号里没有停顿的词时，时长不算连接成分，（笑 2 秒）整个当正文（「拿掉」下它仍是提示，2 秒不是停顿）；别的单位（分钟、次）也不算。
//            两种选法读法一样。
//
// 文字的语种（detectLanguages）：数文字系统里的字母。有假名就是日语；否则汉字、谚文每个字按 3 个拉丁字母算（一个汉字的信息量
// 差不多是一个英文词），哪个多就是哪个，一样多取先出现的。所以中文里夹几个英文词仍是中文，英文里夹一个中文名仍是英文。
// 认不出（只有数字和标点）给 null。结果的 languages 是这个文字系统可能对应的主语言（汉字：zh、yue……；拉丁字母：一长串），
// 参考段的语言标签按主语言去比。主语言的写法见 primaryLanguage。外面给的语言标签（转写报的、调用方写的）整理成清单里的写法，用 normalizeLanguage
// （做包和长录音都用它）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import cues from '../vocab/cues.json' with { type: 'json' };
import { PAUSE_MAX_MS, pauseMs } from '../tools/markup.mjs';
import { isLanguageTag } from './language-tag.mjs';

// ---------------------------------------------------------------- 词表

const KINDS = ['emotion', 'style', 'actions'];
const PAUSE_MS = 600;

const normalizeText = (value) => String(value).normalize('NFKC').toLowerCase();
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 词表里的词：同一个词可以属于不同类里的不同名字（怒吼既是 emotion 的 angry，也是 style 的 shout）。 */
function buildIndex() {
  const byWord = new Map(); // 词 -> [{ kind, id }]
  for (const kind of KINDS) {
    for (const [id, words] of Object.entries(cues[kind])) {
      for (const raw of words) {
        const word = normalizeText(raw).trim();
        byWord.set(word, [...(byWord.get(word) ?? []), { kind, id }]);
      }
    }
  }
  return [...byWord].map(([word, owners]) => {
    // 只由拉丁字母、空格、连字符、撇号组成的词按整词匹配；其余（汉字、假名）按子串匹配
    const latin = /^[a-z][a-z' -]*$/.test(word);
    return { word, owners, regex: latin ? new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'gu') : null };
  });
}
const INDEX = buildIndex();

/**
 * 一小段文字里，词表里每个词出现的每个位置（重叠的也都列出来）：[{ start, end, owners }]，位置是 haystack 里的。
 * @param {string} haystack 已经 normalizeText 的文字
 * @param {string[]} onlyKinds 只找这几类
 */
function occurrencesIn(haystack, onlyKinds) {
  const found = [];
  for (const entry of INDEX) {
    let at = haystack.indexOf(entry.word);
    if (at === -1) continue; // 绝大多数词不在这段文字里：先用 indexOf 筛掉，不去建正则的迭代器（一行里有几万处括号时，这里是大头）
    const owners = onlyKinds === KINDS ? entry.owners : entry.owners.filter((owner) => onlyKinds.includes(owner.kind));
    if (owners.length === 0) continue;
    if (entry.regex !== null) {
      for (const m of haystack.matchAll(entry.regex)) found.push({ start: m.index, end: m.index + entry.word.length, owners });
    } else {
      for (; at !== -1; at = haystack.indexOf(entry.word, at + 1)) found.push({ start: at, end: at + entry.word.length, owners });
    }
  }
  return found;
}

/** 同一处有几个词重叠时取最长的（一样长取靠前的），按出现位置排好。 */
function longestFirst(found) {
  const byLength = [...found].sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const taken = [];
  for (const candidate of byLength) {
    if (!taken.some((other) => candidate.start < other.end && other.start < candidate.end)) taken.push(candidate);
  }
  return taken.sort((a, b) => a.start - b.start);
}

/**
 * 在一小段文字里找词表里的词。同一处有几个词重叠时取最长的；返回按出现位置排好的 [{ start, end, owners }]。
 * @param {string} text
 * @param {string[]} [onlyKinds] 只找这几类
 */
function findCues(text, onlyKinds = KINDS) {
  return longestFirst(occurrencesIn(normalizeText(text), onlyKinds));
}

/**
 * 一个标签的规范写法。参考段的标签（emotion、style）和台词里的舞台提示用同一份词表，所以 angry、愤怒、生气的、Furious 都是 angry；
 * 词表里没有的，只做规范化（兼容分解、转小写、去两头空白、连续空白折成一个）。不跨类认：emotion 里写了风格的词（whisper），只规范化。
 * @param {'emotion'|'style'} kind
 * @param {string} tag
 * @returns {string}
 */
export function canonicalLabel(kind, tag) {
  if (kind !== 'emotion' && kind !== 'style') throw new TypeError(`kind 必须是 emotion 或 style，收到 ${JSON.stringify(kind)}`);
  const plain = normalizeText(tag).trim().replace(/\s+/g, ' ');
  const first = findCues(plain, [kind])[0];
  return first === undefined ? plain : first.owners.find((owner) => owner.kind === kind).id;
}

// ---------------------------------------------------------------- 舞台提示

const DIRECTION_RE = /[（(]([^()（）]{1,30})[)）]|\*([^*\n]{1,30})\*|【([^【】]{1,30})】/gu;
// 强调（markdown），头尾不能是空白，所以项目符号 `* ` 和乘号 `3 * 4 * 5` 不会和别的星号配成一对；前后的星号一样多，所以挨着的两个 *笑**哭*
// 是两对，不会被配成 *笑** 和 哭*。两种写法，按出现的先后各认各的：
//   加粗  两颗或三颗星号，不限长度（加粗从来不是舞台提示，用不着 30 个字的界）；里面不含星号，所以每个起点最多扫到下一颗星号，处理时间和长度成正比
//   一颗  1–30 个字，和括号一样：这个长度以内的才可能是舞台提示，更长的是台词的一部分；星号最多认一颗，一长串星号（分隔线）里每个起点只试几步
const EMPHASIS_RE = /(\*{2,3})([^\s*](?:[^*\n]*[^\s*])?)\1|\*([^\s*](?:[^*\n]{0,28}[^\s*])?)\*/gu;
const LINE_BREAK_RE = /\r\n|[\r\n]/;
/** 认不出的括号内容怎么处理（选项 unrecognized）：'keep' 留在要念的话里（默认），'remove' 拿掉。规则见文件头。 */
const UNRECOGNIZED = Object.freeze(['keep', 'remove']);
/** 一行里最多认几处舞台提示，超过的部分当正文。理由和规则见文件头。 */
const MAX_DIRECTIONS_PER_LINE = 1000;
/**
 * 连接成分：舞台提示的词和词之间可以夹的字和词（规则见文件头「哪些算」）：单个的字（地、的、着、和、说、道、了、声）、空白、标点和符号，
 * 加上两个字的一下、起来、说话；英文的 and 另外按整词认（AND_RE），停顿的时长另外认（DURATION_RE）。
 */
const CONNECTORS_RE = /^(?:[\s\p{P}\p{S}地的着和说道了声]|一下|起来|说话)*$/u;
const AND_RE = /(?<![\p{L}\p{N}])and(?![\p{L}\p{N}])/gu;
/**
 * 结构规则（规则见文件头「哪些算」）：括号里整个写法是「副词 + 地」「副词 + 地说」「副词 + 地道」「副词 + 地说道」，副词是 2–8 个汉字
 * （（认真地说）、（郑重地道）、（无奈地）），不管副词词表里认不认识，都是舞台提示。
 */
const ADVERB_CUE_RE = /^\p{Script=Han}{2,8}地(?:说道|说|道)?$/u;
/**
 * 停顿的时长：数字加单位，数字和单位之间可以有空白（规则见文件头「停顿的时长」）。在 normalizeText 以后的文字上认，所以全角数字、大写字母已经是半角、小写。
 * 四个捕获组：1 阿拉伯数字（可带小数；小数点前可以不写 0，但前面不能是点、字母或数字：.5s 是 0.5 秒，...5s 是省略号后面的 5 秒）、
 * 2 汉字数字（一串数字字，是不是一个确定的数由 hanNumber 定）、3 毫秒的单位、4 秒的单位。
 * 数字前面不能紧跟字母或数字：x2s 不是时长，2s二s 也不是两个时长连着写。
 * 英文单位后面不能紧跟字母或数字：2sx 不是时长，(pause 2 slowly) 里的 s 是 slowly 的头一个字母，也不是单位。
 */
const DURATION_RE = /(?<![0-9a-z])(?:([0-9]+(?:[.][0-9]+)?|(?<![.])[.][0-9]+)|([零〇一二两三四五六七八九十百千半几]+))\s*(?:(毫秒|(?:milliseconds?|ms)(?![0-9a-z]))|(秒钟|秒|(?:seconds?|secs?|s)(?![0-9a-z])))/gu;
const HAN_DIGITS = Object.freeze({ 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 });
const HAN_PLACES = Object.freeze({ 十: 10, 百: 100, 千: 1000 });

/**
 * 汉字数字读成数：一、两、十二、二十、一百二十、一百零五、一千零五、半（0.5）。不是一个确定的数给 null：几（几秒）、两个数字连着（三五、一两）、
 * 百和千前面没有数字、零后面直接是位（一千零十）、位的大小倒着写（一十一百）、半和别的字混着写，还有口语里省了位的写法（一百二：指一百二十，
 * 也可以读成一百零二，有歧义）。十前面没有数字当一十（十二是 12）；零在位和位之间只是占位（一百零五是 105）。
 * @param {string} text
 * @returns {number|null}
 */
function hanNumber(text) {
  if (text === '半') return 0.5;
  let total = 0;
  let digit = null; // 刚读到、还没有乘位的个位数
  let place = Infinity; // 已经读到的最小的位：位一个比一个小，一百二十，不是二十一百
  let bare = false; // 末尾的个位数直接跟在百或千后面（一百二）：有歧义，不当一个确定的数
  for (const ch of text) {
    if (ch in HAN_DIGITS) {
      if (digit !== null && !(digit === 0 && total > 0)) return null; // 两个数字连着：三五
      bare = digit === null && place >= 100 && place !== Infinity;
      digit = HAN_DIGITS[ch];
    } else if (ch in HAN_PLACES) {
      const times = digit ?? (ch === '十' ? 1 : null);
      if (HAN_PLACES[ch] >= place || times === null || times === 0) return null; // 位要一个比一个小；百和千前面要有数字；零后面不能直接是位
      total += times * HAN_PLACES[ch];
      place = HAN_PLACES[ch];
      digit = null;
      bare = false;
    } else return null;
  }
  return bare ? null : total + (digit ?? 0);
}

/** 一处时长写的毫秒数（单位的换算、取整、上限是台本标记 [pause …] 的，用 tools/markup.mjs 的 pauseMs）；写的不是一个确定的数给 null。 */
function durationMs(match) {
  const number = match[1] ?? hanNumber(match[2]);
  return number === null ? null : pauseMs(String(number), match[3] !== undefined ? 'ms' : 's');
}

/**
 * 括号里的内容读出什么：
 *   meaning   词表里的意思：{ emotion, style, actions }，emotion、style 各取最前面的一个，重叠的词取最长的；
 *   whole     整个都是舞台提示：至少有一个词表里的词，而且每个字都属于词表里的某个词，或者是连接成分
 *             （括号里有停顿的词时，时长也算；没认出来的字连续的一段一段单独看，不拼在一起看：「一笑下」里的「一」和「下」不是「一下」）；
 *             或者符合结构规则（structural 为真时才用，见 ADVERB_CUE_RE）：词表里的词有没有都行，meaning 照词表读，一个词都没有就是空的（没有类别）。
 *   durations 括号里有停顿的词时，写的时长：读得出的一个一个列出毫秒数（见 durationMs）；没有停顿的词、或没写时长，是空的。
 * @param {string} inner
 * @param {boolean} [structural] 用不用结构规则：括号（（…）、(…)、【…】）用，*…* 不用（强调的副词是正文：他*慢慢地*走）
 */
function readCue(inner, structural = false) {
  const haystack = normalizeText(inner);
  const found = occurrencesIn(haystack, KINDS);
  const meaning = { emotion: null, style: null, actions: [] };
  const durations = [];
  for (const cue of longestFirst(found)) {
    for (const { kind, id } of cue.owners) {
      if (kind === 'actions') meaning.actions.push(id);
      else if (meaning[kind] === null) meaning[kind] = id;
    }
  }
  const adverbial = structural && ADVERB_CUE_RE.test(haystack);
  if (found.length === 0) return { meaning, whole: adverbial, durations };
  const covered = new Uint8Array(haystack.length);
  for (const { start, end } of found) covered.fill(1, start, end);
  for (const m of haystack.matchAll(AND_RE)) covered.fill(1, m.index, m.index + 'and'.length);
  if (meaning.actions.includes('pause')) {
    for (const m of haystack.matchAll(DURATION_RE)) {
      covered.fill(1, m.index, m.index + m[0].length);
      const ms = durationMs(m);
      if (ms !== null) durations.push(ms);
    }
  }
  let whole = true;
  let run = ''; // 连续没认出来的字
  for (let at = 0; at <= haystack.length && whole; at += 1) {
    if (at < haystack.length && covered[at] === 0) run += haystack[at];
    else {
      whole = CONNECTORS_RE.test(run);
      run = '';
    }
  }
  return { meaning, whole: whole || adverbial, durations };
}

/** 一处提示要停多少毫秒：写了读得出的时长，就是它们加起来；没写，每个停顿的词 600 毫秒。没有停顿的词是 0。规则见文件头「停顿的时长」。 */
function pauseOf(meaning, durations) {
  const words = meaning.actions.filter((action) => action === 'pause').length;
  if (words === 0) return 0;
  return durations.length > 0 ? durations.reduce((sum, ms) => sum + ms, 0) : words * PAUSE_MS;
}

/** 词表里认得出这一处提示的意思吗（情绪、风格、动作，有一样就算）：括号里有一个词表里的词就是。 */
const isRecognized = (meaning) => meaning.emotion !== null || meaning.style !== null || meaning.actions.length > 0;

/**
 * 检查 readDirections 的选项，补上默认值。lib/reference-pick.mjs 的 pickReferences 也用它检查自己的选项（同一个选项，一路传下去）。
 * @param {{ unrecognized?: 'keep'|'remove' }} [options]
 * @returns {{ unrecognized: 'keep'|'remove' }}
 * @throws {TypeError} 选项不是对象、有不认识的键、unrecognized 不是 'keep' 或 'remove'：不悄悄当成默认值（配音靠它选「拿掉」，键写错了不能悄悄变成「保留」）
 */
export function readDirectionOptions(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError("选项必须是对象：{ unrecognized?: 'keep' | 'remove' }");
  for (const key of Object.keys(options)) if (key !== 'unrecognized') throw new TypeError(`不认识的选项 ${JSON.stringify(key)}：只有 unrecognized（'keep' 或 'remove'）`);
  const unrecognized = options.unrecognized === undefined ? 'keep' : options.unrecognized;
  if (!UNRECOGNIZED.includes(unrecognized)) throw new TypeError(`unrecognized 必须是 'keep' 或 'remove'，收到 ${JSON.stringify(options.unrecognized)}`);
  return { unrecognized };
}

/**
 * 一行里 markdown 的强调去掉星号、留下中间的字：*非常*、**非常**、***非常***。规则见文件头。
 * 两颗以上星号是强调（加粗），从不是舞台提示，里面有词表里的词也一样，两种选法都一样。
 * 一颗星号：「拿掉」时一律当舞台提示，原样留给后面读；「保留」时整个是词表里的提示（*笑*）才是舞台提示，原样留给后面读，其余是强调。
 * @param {string} line
 * @param {'keep'|'remove'} unrecognized
 */
function withoutEmphasis(line, unrecognized) {
  return line.replace(EMPHASIS_RE, (whole, stars, boldInner, inner) => {
    if (stars !== undefined) return boldInner;
    if (unrecognized === 'remove') return whole;
    return readCue(inner).whole ? whole : inner;
  });
}

/**
 * 读台词里的舞台提示：把台词按提示切成几段，每段带着生效的情绪和风格。规则见文件头。
 * @param {string} text
 * @param {{ unrecognized?: 'keep'|'remove' }} [options]
 *   unrecognized 括号里不是整个都认得的内容怎么处理：'keep'（默认）留在要念的话里，不切段，不算舞台提示；'remove' 拿掉，只给明确拿到配音台本的调用方用
 * @returns {{
 *   pieces: { text: string, hints: { emotion: string|null, style: string|null }, directions: object[], speed: 'slow'|'fast'|null, line: number, pauseBeforeMs: number, pauseAfterMs: number }[],
 *   directions: { raw: string, recognized: boolean, emotion: string|null, style: string|null, actions: string[], line: number }[],
 *   unattachedPauseMs: number
 * }} unattachedPauseMs：整段台词里一句要念的话都没有（pieces 是空的）、只有停顿时，这些停顿一共多少毫秒，没处可挂；有要念的话时总是 0
 */
export function readDirections(text, options) {
  if (typeof text !== 'string') throw new TypeError('台词必须是字符串');
  const { unrecognized } = readDirectionOptions(options);
  const pieces = [];
  const directions = [];
  let waiting = 0; // 前面还没有一句、等着挂到后一句前面的停顿：一行里只有停顿，又没有前一句
  text.split(LINE_BREAK_RE).forEach((original, lineNumber) => {
    const line = withoutEmphasis(original, unrecognized);
    let state = { emotion: null, style: null };
    let speed = null;
    let pendingPause = 0;
    let lineDirections = []; // 这一行里到目前为止读到的提示
    let last = 0;
    const push = (chunk) => {
      const spoken = chunk.trim();
      if (spoken === '') return;
      pieces.push({ text: spoken, hints: { ...state }, directions: [...lineDirections], speed, line: lineNumber, pauseBeforeMs: Math.min(pendingPause + waiting, PAUSE_MAX_MS), pauseAfterMs: 0 });
      pendingPause = 0;
      waiting = 0;
    };
    for (const m of line.matchAll(DIRECTION_RE)) {
      const raw = (m[1] ?? m[2] ?? m[3]).trim();
      if (raw === '') continue; // 括号里只有空白：不是提示，留在台词里
      const { meaning, whole, durations } = readCue(raw, m[2] === undefined); // 结构规则只管括号，不管 *…*（m[2]）
      if (unrecognized === 'keep' && !whole) continue; // 整个不是舞台提示（词表里的提示，或者「副词 + 地」的写法）：不动，留在要念的话里，不切段，不记
      if (lineDirections.length >= MAX_DIRECTIONS_PER_LINE) break; // 超过上限：从这一处起到行尾当正文，不再认
      push(line.slice(last, m.index));
      last = m.index + m[0].length;
      const direction = { raw, recognized: isRecognized(meaning), emotion: meaning.emotion, style: meaning.style, actions: meaning.actions, line: lineNumber };
      directions.push(direction);
      lineDirections.push(direction);
      if (meaning.emotion !== null || meaning.style !== null) state = { emotion: meaning.emotion, style: meaning.style };
      for (const action of meaning.actions) if (action === 'slow' || action === 'fast') speed = action;
      const pause = pauseOf(meaning, durations);
      if (pause > 0) {
        // 停顿算在前一段后面；挨着的几处加起来，封顶，和台本标记 [pause] 一样
        const previous = pieces.length > 0 && pieces[pieces.length - 1].line === lineNumber ? pieces[pieces.length - 1] : null;
        if (previous !== null) previous.pauseAfterMs = Math.min(previous.pauseAfterMs + pause, PAUSE_MAX_MS);
        else pendingPause = Math.min(pendingPause + pause, PAUSE_MAX_MS);
      }
    }
    push(line.slice(last));
    // 这一行没有要念的话，停顿还没处挂：整行只有提示（（停顿 3 秒））。放在前一句后面（前一句可以在上一行）；没有前一句，等后一句，放在它前面
    if (pendingPause > 0) {
      if (pieces.length > 0) pieces[pieces.length - 1].pauseAfterMs = Math.min(pieces[pieces.length - 1].pauseAfterMs + pendingPause, PAUSE_MAX_MS);
      else waiting = Math.min(waiting + pendingPause, PAUSE_MAX_MS);
    }
  });
  return { pieces, directions, unattachedPauseMs: waiting };
}

// ---------------------------------------------------------------- 文字的语种

/** 主语言的别名：参考段的语言标签可能写三个字母的 ISO 639-3，和两个字母的要认成同一个。 */
const LANGUAGE_ALIASES = { zho: 'zh', chi: 'zh', cmn: 'zh', eng: 'en', jpn: 'ja', kor: 'ko', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', spa: 'es', rus: 'ru', ita: 'it', por: 'pt' };

/**
 * 语言标签的主语言：第一段，小写；三个字母的 ISO 639-3 写法归到两个字母的（cmn、zho 都是 zh）。zh-CN、zh-Hans、zh 的主语言都是 zh。
 * @param {string} tag
 * @returns {string}
 */
export function primaryLanguage(tag) {
  const primary = normalizeText(tag).trim().split(/[-_]/)[0];
  return LANGUAGE_ALIASES[primary] ?? primary;
}

/**
 * 外面给的语言标签（转写报的、调用方写的）整理成清单里的写法：两头的空白去掉；写法不合格（lib/language-tag.mjs 的 isLanguageTag）给 null；
 * 整个就是三个字母的 ISO 639-3（cmn、eng）并且有对应的两个字母的，归到两个字母的（zh、en），没有对应的（yue）原样；带区域的（cmn-CN）原样。
 * @param {unknown} tag
 * @returns {string | null}
 */
export function normalizeLanguage(tag) {
  if (typeof tag !== 'string' || !isLanguageTag(tag.trim())) return null;
  const text = tag.trim();
  const primary = primaryLanguage(text);
  return /^[A-Za-z]{3}$/.test(text) && primary.length === 2 ? primary : text;
}

const SCRIPT_TESTS = [
  ['Hiragana', /\p{Script=Hiragana}/u],
  ['Katakana', /\p{Script=Katakana}/u],
  ['Hangul', /\p{Script=Hangul}/u],
  ['Han', /\p{Script=Han}/u],
  ['Latin', /\p{Script=Latin}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Arabic', /\p{Script=Arabic}/u],
  ['Devanagari', /\p{Script=Devanagari}/u],
  ['Thai', /\p{Script=Thai}/u],
  ['Greek', /\p{Script=Greek}/u],
  ['Hebrew', /\p{Script=Hebrew}/u],
];
/** 一个汉字或谚文字的信息量，按几个拉丁字母算。 */
const WEIGHT = { Han: 3, Hangul: 3 };
const LANGUAGES_OF = {
  Han: ['zh', 'yue', 'wuu', 'nan', 'hak'],
  Japanese: ['ja'],
  Hangul: ['ko'],
  Cyrillic: ['ru', 'uk', 'bg', 'sr', 'be', 'kk', 'mk', 'mn', 'ky', 'tg'],
  Arabic: ['ar', 'fa', 'ur', 'ps', 'ug', 'sd'],
  Devanagari: ['hi', 'mr', 'ne', 'sa'],
  Thai: ['th'],
  Greek: ['el'],
  Hebrew: ['he', 'yi'],
  Latin: ['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'sv', 'da', 'no', 'nb', 'nn', 'fi', 'pl', 'cs', 'sk', 'sl', 'hr', 'ro', 'hu', 'tr', 'id', 'ms', 'vi', 'tl', 'fil', 'ca', 'eu', 'gl', 'is', 'et', 'lv', 'lt', 'sq', 'af', 'sw', 'ga', 'cy', 'mt', 'la', 'eo'],
};

/**
 * 按文字本身认语种。
 * @param {string} text
 * @returns {{ script: string, languages: string[] } | null} script 是文字系统（Han、Latin……，有假名就是 Japanese）；languages 是可能的主语言；认不出给 null
 */
export function detectLanguages(text) {
  if (typeof text !== 'string') throw new TypeError('文字必须是字符串');
  const counts = new Map();
  let kana = 0;
  for (const ch of text) {
    if (!/[\p{L}\p{Nl}]/u.test(ch)) continue;
    const script = SCRIPT_TESTS.find(([, test]) => test.test(ch))?.[0];
    if (script === undefined) continue;
    if (script === 'Hiragana' || script === 'Katakana') {
      kana += 1;
      continue;
    }
    counts.set(script, (counts.get(script) ?? 0) + (WEIGHT[script] ?? 1));
  }
  if (kana > 0) return { script: 'Japanese', languages: [...LANGUAGES_OF.Japanese] };
  // Map 保持先出现的在前面，所以一样多时取先出现的
  let best = null;
  for (const [script, weight] of counts) if (best === null || weight > best.weight) best = { script, weight };
  return best === null ? null : { script: best.script, languages: [...LANGUAGES_OF[best.script]] };
}
