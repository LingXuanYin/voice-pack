// SPDX-License-Identifier: Apache-2.0
//
// 台词的提示（流程层）：从一句台词本身读出两样东西，给配音和挑参考用（语种用来挑参考；舞台提示换成提示留在原位交给模型，读出的情绪、风格交给包里脚本的钩子）——
//   1 舞台提示：台词里括号中的语气说明，例如（耳语）、(angry)、*笑*、【叹气】。词表是 vocab/cues.json。
//   2 文字的语种：按文字系统认（汉字、假名、谚文、西里尔字母……）。拉丁字母认不出是英语还是法语，所以给的是一组候选。
// 配音（lib/dub.mjs）读舞台提示用的是 cuesInPlace：哪些算舞台提示同下面的「拿掉」，可它不拿掉，换成同样意思的方括号提示留在原位交给模型（规则写在它上面）。
// 只做计算，不用模型，不读文件；怎么用，见 lib/dub.mjs 和 lib/reference-pick.mjs 的文件头。
//
// 舞台提示的写法（SKILL.md 的台本标记表里的「舞台提示」；下面「括号」「强调」两条的正则写在协议核心的 protocol/lib/script-markup.mjs，预览卡片也认它们，写法改了先改这里）：
//   括号     （…）或 (…)，全角半角可以混着写；【…】；*…*。括号里最多 30 个字，超过的不是舞台提示，是台词的一部分。
//            只有开括号没有闭括号、括号里是空的，也不是舞台提示。
//            *…* 的星号和字之间不能有空白（星号里面紧挨着的字都不是空白，同下面「强调」的一颗星号）：3 * 4 * 5 里的「* 4 *」、行首的项目符号 `* 第一项 *`、
//            两边空着的 `* 笑 *`（中间是词表里的提示也一样）、一边空着的 `*笑 *` 都不是舞台提示，是台词的一部分，两种选法下都原样念，预览卡片上也原样显示（例外：前面的一颗星号跨过 [pause …]、[voice:…] 和它配成了一对，见 protocol/lib/spoken-words.mjs 文件头「舞台说明」）。
//   强调     **…**、***…***（markdown 的加粗：星号和字之间不能有空白，前后的星号一样多，多长都算）不是舞台提示，两种选法下都一样：
//            去掉星号，里面的字留着，里面有词表里的词也一样（**微笑** 是加粗的「微笑」）。
//            星号和字之间有空白的（3 * 4 * 5、行首的项目符号 `* `）不是强调，也不是舞台提示（上面「括号」），原样。
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
//                             算的：从台词里拿掉，不念出来，在那里把台词切成两段，记在 directions 里（recognized 为 true），原样记下（挑参考的报告里列着，不影响用哪一段）。
//                             不算的：括号里的字是要念的话，一个字不丢，不切段，不记进 directions，括号照原样留着；不算的 *…* 去掉星号，留下中间的字。
//                             丢内容比多念几个字糟：普通正文里常有括号和强调，「会议在 2019 年（疫情之前）举行。」不能丢了「疫情之前」。
//              'remove'       30 个字以内的括号（含 *…*，不含上面的 **…**）一律当舞台提示，拿掉，不念出来（读了「画外音」两个字出来比丢一句提示糟得多），
//                             在那里切段。括号里只要有一个词表里的词就认得出（汉字按子串：（笑话比赛）里有「笑」，也认得出），意思照读，
//                             记在 directions 里，recognized 为 true；一个词也没有的认不出，也拿掉，如实记着 recognized 为 false，
//                             调用方可以告诉用户。结构规则认出的（（认真地说））两种选法下读法一样（一个词也没有，recognized 为 false）。只给明确拿到配音台本的调用方用：变声（lib/convert.mjs）、
//                             做包时判断文本能不能原样配音（lib/make-pack-pick.mjs）；agent 配音（lib/dub.mjs）用 cuesInPlace，认法和这里一样。
//            app 生成和别的读正文的地方用默认的 'keep'。选项由 lib/reference-pick.mjs 的 pickReferences 原样传下来；这条规则只在这里写。
//   上限     不设上限：一行里认几处都认（两种选法一样；不算舞台提示的括号不计数）。每一段只带它前面自己那一段的提示（见「段带的」），
//            每个提示只在一段里，所以几万处提示的一行，内存和输出跟提示数成线性。
//   范围     readDirections 读出的每一段的情绪、风格、语速（pieces[i].hints、speed）：一个提示管从它出现的地方，到这一行结束，或者下一个同类的提示出现为止；换一行就清掉，换声音也清掉。
//            同类：情绪和风格是一类，一个新的情绪或风格提示整个换掉旧的；放慢、加快是一类。停顿不改变情绪、风格和语速，也不切断它们：「（生气）你好[pause 3s]我走了」
//            里「我走了」照样是生气的。台本标记 [pause …] 把一行切成几段时，调用方把前一段的状态（readDirections 返回的 carry）带给同一行的下一段（carried；换一行、换声音就不带）。
//            不算舞台提示的括号（'keep'）不管什么范围。配音不用这里的范围：舞台提示换成提示留在原位，由模型自己读（cuesInPlace）。
//            例外：一下子的声音（vocab/cues.json 的 oneShot：笑、叹气、咳嗽、吸一口气这类）是一件事，不是一种状态：带着它的提示（（笑）、*笑*、（开心地笑））只管紧跟在它后面、第一段要念的话，用掉以后，管着的回到它出现以前的那一份
//            （情绪、风格都回去；它出现以前没有，就是没有），不带到停顿后面的每一段。carry 的 back 记着回到哪一份：一下子的声音后面还没有要念的话时（紧接着是停顿），它连同 back 一起带给下一段。
//   段带的   每一段的 directions 只列它前面、同一行里还没挂到前一段上的提示（前一段之后、这一段之前写的）。每个提示只在一段里，
//            所以段的 directions 加起来是整段的提示数，不随段数重复。
//            整段台词的全部提示在顶层的 directions 里，按出现的次序，每个只一份。
//   意思     词表里 emotion（情绪）、style（说话的方式）、actions（对节奏的要求：停顿、放慢、加快）三类。
//            一处提示里可以既有情绪又有风格（（生气地大喊））；同一类里有几个，取最前面的一个。
//            认词：拉丁字母整词匹配、不分大小写（danger 里的 anger 不算），汉字和假名按子串匹配；重叠时取最长的（微笑是 happy，不是 laugh）。
//   停顿     （停顿）算在前一段的后面；在一行开头就算在第一段的前面。停多久：括号里写了时长的按写的时长停，没写的每个停顿的词 600 毫秒
//            （见「停顿的时长」）。挨着的几处停顿加起来，和台本标记 [pause] 一样，没有上限。放慢、加快设的是语速（speed）：一行里从它出现起，管到下一个放慢、加快或者行尾，情绪或风格变了也不清，停顿（包括 [pause …] 切开的段）也不清。配音不用它：放慢、加快在配音里只是写给模型的提示（cuesInPlace）。
//            一行里只有停顿（单独一行的（停顿 3 秒），可以夹着别的提示，没有要念的话）时，停顿放在前一句的后面（前一句可以在上一行），
//            没有前一句就放在后一句的前面，两种选法都一样；几行这样的行挨着，加起来。整段台词里一句要念的话都没有、只有停顿时，pieces 是空的，
//            停顿一共多少毫秒写在返回值的 unattachedPauseMs 里，没处可挂，调用方自己挂到相邻的一句上（lib/dub.mjs 就这么做）；有要念的话时它总是 0。
//   停顿的时长  括号里有停顿的词时，后面可以写时长，数字加单位：（停顿 2 秒）、（停顿半秒）、（停顿 500 毫秒）、(pause 500ms)、(pause for 2 seconds)。
//            数字是阿拉伯数字（可带小数，小数点前可以不写 0）或汉字数字（一、两、十二、一百二十、半）；单位是秒、秒钟、毫秒、s、ms、sec、second
//            （也认 secs、seconds、millisecond、milliseconds）；数字和单位之间可以有空白；数字前面和英文单位后面都不能紧跟字母或数字：
//            (pause x2s) 不算，(pause 2s二s)（两个时长连着写）不算，(pause 2sx) 不算，(pause 2 slowly) 也不算（s 是 slowly 的头一个字母，不是单位）。
//            按写的时长停，写多长停多长。单位的换算、取整和挨着的相加，都是台本标记 [pause 2s] 的规则：正本是 tools/markup.mjs 的文件头「停顿」，
//            代码从那里引 pauseMs，这里不再写一份。
//            一处提示里读得出的时长有几个，停顿就是它们加起来（（停顿 1 秒，停顿 2 秒）停 3 秒）；时长管整处提示：（沉默，停顿 3 秒）停 3 秒，不再加每个词的 600 毫秒。
//            没有读得出的时长，每个停顿的词 600 毫秒：没写数字（（停顿））；数字没带单位（(pause 2)：[pause 2] 是 2 毫秒，写台词的人不是这个意思，所以不当时长）；
//            不是一个确定的数（几秒、三五秒、十几秒）。不写时长的默认值和 [pause] 的不一样，两处各管各的。
//            时长只跟着停顿的词：括号里没有停顿的词时，时长不算连接成分，（笑 2 秒）整个当正文（「拿掉」下它仍是提示，2 秒不是停顿）；别的单位（分钟、次）也不算。
//            两种选法读法一样。
//
// 文字的语种（detectLanguages）：数文字系统里的字母。汉字、谚文、假名每个字按 3 个拉丁字母算（一个汉字的信息量
// 差不多是一个英文词），哪个多就是哪个，一样多取先出现的。所以中文里夹几个英文词仍是中文，英文里夹一个中文名仍是英文。
// 假名算日文。日文里汉字、假名混着写：假名至少占汉字加假名的五分之一，汉字也算日文的；不到，汉字照旧算汉字。
// 所以看的是主要的文字：一行中文里一个片假名的名字（トモ）仍是中文，一行英文里一句ありがとう仍是英文。
// 给了语言的一行，文字看不看得出不是这种语言，用 scriptFitsLanguage（配音默认不带口音那一步用，lib/cross-language.mjs 的 languageOfText）。
// 认不出（只有数字和标点）给 null。结果的 languages 是这个文字系统可能对应的主语言（汉字：zh、yue……；拉丁字母：一长串），
// 参考段的语言标签按主语言去比。主语言的写法见 primaryLanguage。外面给的语言标签（转写报的、调用方写的）整理成清单里的写法，用 normalizeLanguage
// （做包和长录音都用它）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import cues from '../vocab/cues.json' with { type: 'json' };
import { CUE_PATTERN, LANGUAGE_BLOCK_PATTERN, PHONEME_MARKER_PATTERN, TAG_PATTERN, pauseMs, pauseOutOfRange, placeOfMarker } from '../tools/markup.mjs';
import { isVoicePackError } from '../protocol/lib/errors.mjs';
import { EMPHASIS_PATTERN, LENTICULAR_DIRECTION_PATTERN, PAREN_DIRECTION_PATTERN, STAR_DIRECTION_PATTERN } from '../protocol/lib/script-markup.mjs';
import { isLanguageTag } from './language-tag.mjs';

/** 一下子的声音（笑、叹气、咳嗽、吸一口气这类）：vocab/cues.json 的 oneShot 是唯一的来源，这里只读。 */
const ONE_SHOT_STYLES = new Set(cues.oneShot.style);

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
 * 一个标签的规范写法。调用方和设定给的情绪、风格（labels.emotion、labels.style）和台词里的舞台提示用同一份词表，所以 angry、愤怒、生气的、Furious 都是 angry；
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

/**
 * 整个标签就是词表里 kind 类的一个词时，返回它的规范名字；只是含着词表里的词的（惊叹里的「叹」，微笑里的「笑」）不算，返回 null。
 * 规范化同 canonicalLabel。canonicalLabel 汉字按子串认，给调用方的标签归名字用；要问「这个标签本身是不是词表里的那个词」，用这个。
 * @param {'emotion'|'style'} kind
 * @param {string} tag
 * @returns {string|null}
 */
export function wholeLabel(kind, tag) {
  if (kind !== 'emotion' && kind !== 'style') throw new TypeError(`kind 必须是 emotion 或 style，收到 ${JSON.stringify(kind)}`);
  const plain = normalizeText(tag).trim().replace(/\s+/g, ' ');
  const first = findCues(plain, [kind])[0];
  return first !== undefined && first.start === 0 && first.end === plain.length ? first.owners.find((owner) => owner.kind === kind).id : null;
}

// ---------------------------------------------------------------- 舞台提示

// 舞台说明和强调的正则写在协议核心（protocol/lib/script-markup.mjs：核心层的预览卡片也认它们），写法照上面文件头「舞台提示的写法」。
// 舞台说明三种，三个捕获组依次是（…）(…)、*…*、【…】里的字（m[2] 是星号的：结构规则不用在它上面）。
// *…* 和一颗星号的强调同一条规矩（STAR_DIRECTION_PATTERN 就是 SINGLE_STAR_PATTERN）：星号里面紧挨着的不是空白，所以 3 * 4 * 5、* 笑 * 不是舞台说明。
const DIRECTION_RE = new RegExp([PAREN_DIRECTION_PATTERN, STAR_DIRECTION_PATTERN, LENTICULAR_DIRECTION_PATTERN].join('|'), 'gu');
// 强调（markdown），头尾不能是空白，所以项目符号 `* ` 和乘号 `3 * 4 * 5` 不会和别的星号配成一对；前后的星号一样多，所以挨着的两个 *笑**哭*
// 是两对，不会被配成 *笑** 和 哭*。两种写法，按出现的先后各认各的：
//   加粗  两颗或三颗星号，不限长度（加粗从来不是舞台提示，用不着 30 个字的界）；里面不含星号，所以每个起点最多扫到下一颗星号，处理时间和长度成正比
//   一颗  1–30 个字，和括号一样：这个长度以内的才可能是舞台提示，更长的是台词的一部分；星号最多认一颗，一长串星号（分隔线）里每个起点只试几步
// 三个捕获组依次是加粗的星号、加粗里的字、一颗星号里的字。
const EMPHASIS_RE = new RegExp(EMPHASIS_PATTERN, 'gu');
const LINE_BREAK_RE = /\r\n|[\r\n]/;
/** 认不出的括号内容怎么处理（选项 unrecognized）：'keep' 留在要念的话里（默认），'remove' 拿掉。规则见文件头。 */
const UNRECOGNIZED = Object.freeze(['keep', 'remove']);
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

/**
 * 一处时长写的毫秒数（单位的换算、取整是台本标记 [pause …] 的，用 tools/markup.mjs 的 pauseMs）；写的不是一个确定的数给 null。
 * marker：括号的原文，时长超出一份 WAV 能装的时报错时说是哪一个舞台提示（没有就不说）。
 */
function durationMs(match, marker) {
  const number = match[1] ?? hanNumber(match[2]);
  return number === null ? null : pauseMs(String(number), match[3] !== undefined ? 'ms' : 's', marker === null ? undefined : { marker });
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
 * @param {string|null} [marker] 括号连原文（时长超出一份 WAV 能装的时报错说是哪一个舞台提示）；没有就不说
 */
function readCue(inner, structural = false, marker = null) {
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
      const ms = durationMs(m, marker);
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
    return readCue(inner, false, whole).whole ? whole : inner;
  });
}

/**
 * 读台词里的舞台提示：把台词按提示切成几段，每段带着生效的情绪和风格。规则见文件头。
 * @param {string} text
 * @param {{ unrecognized?: 'keep'|'remove' }} [options]
 *   unrecognized 括号里不是整个都认得的内容怎么处理：'keep'（默认）留在要念的话里，不切段，不算舞台提示；'remove' 拿掉，只给明确拿到配音台本的调用方用
 * @param {{ emotion: string|null, style: string|null, speed: 'slow'|'fast'|null, gap: object[], hasPiece: boolean, back: { emotion: string|null, style: string|null }|null }|null} [carried]
 *   前一段在同一行里留下的状态（上一次调用的 carry）：第一行接着它读，情绪、风格、放慢或加快、还没挂上的提示都带过来。
 *   换行的、换声音的一段不传（null）：一行从头算。
 * @param {{ script?: string }} [where] script：这段台词所在的整份台本（没规范化的原文）。只用来说清报错的位置：舞台提示里的停顿装不下一份 WAV（pause_out_of_range）时，
 *   报错的 details 里有这个提示在台本里的行和列（tools/markup.mjs 的 placeOfMarker：第一次写它的地方）；不给就只有提示的原文，行和列是 null。
 * @returns {{
 *   pieces: { text: string, hints: { emotion: string|null, style: string|null }, directions: object[], speed: 'slow'|'fast'|null, line: number, pauseBeforeMs: number, pauseAfterMs: number }[],
 *   directions: { raw: string, recognized: boolean, emotion: string|null, style: string|null, actions: string[], line: number }[],
 *   unattachedPauseMs: number,
 *   headPauseMs: number,
 *   carry: { emotion: string|null, style: string|null, speed: 'slow'|'fast'|null, gap: object[], hasPiece: boolean, back: { emotion: string|null, style: string|null }|null }
 * }} unattachedPauseMs：整段台词里一句要念的话都没有（pieces 是空的）、只有停顿时，这些停顿一共多少毫秒，没处可挂；有要念的话时总是 0。
 *   headPauseMs：第一行开头、前一段（carried 里的）后面的停顿，挂在前一段后面，不挂在这里的第一段前面（carried 有前一段时才可能有）。
 *   carry：最后一行读完时的状态，给同一行的下一段接着读；hasPiece 是同一行里前面有没有一段要念的话；back 是一下子的声音（笑、叹气）还没有被一段话用掉时（后面紧接着是停顿），用掉以后情绪、风格回到哪一份，没有等着用掉的就是 null。
 */
export function readDirections(text, options, carried = null, where = {}) {
  try {
    return readDirectionsOf(text, options, carried);
  } catch (error) {
    throw withPlace(error, where?.script);
  }
}

/** 舞台提示的停顿装不下一份 WAV 的报错：台本给了，就补上这个提示在台本里的行和列；找不到位置、不是这个错的原样往上抛。 */
function withPlace(error, script) {
  if (script === undefined || !isVoicePackError(error, 'pause_out_of_range')) return error;
  const { marker, line } = error.details;
  if (typeof marker !== 'string' || line !== null) return error;
  const place = placeOfMarker(script, marker);
  return place === null ? error : pauseOutOfRange({ marker, place });
}

function readDirectionsOf(text, options, carried) {
  if (typeof text !== 'string') throw new TypeError('台词必须是字符串');
  const { unrecognized } = readDirectionOptions(options);
  const pieces = [];
  const directions = [];
  let waiting = 0; // 前面还没有一句、等着挂到后一句前面的停顿：一行里只有停顿，又没有前一句
  let headPauseMs = 0; // 第一行开头的停顿，挂在 carried 里的前一段后面
  /** @type {{ emotion: string|null, style: string|null, speed: 'slow'|'fast'|null, gap: object[], hasPiece: boolean, back: { emotion: string|null, style: string|null }|null }|null} */
  let carry = null;
  const lines = text.split(LINE_BREAK_RE);
  lines.forEach((original, lineNumber) => {
    const line = withoutEmphasis(original, unrecognized);
    // 第一行接着前一段说的同一行（carried）；其余各行是新的一行，从头算
    const before = lineNumber === 0 && carried !== null ? carried : null;
    let state = { emotion: before?.emotion ?? null, style: before?.style ?? null };
    let back = before?.back ?? null; // 一下子的声音（笑、叹气……）出现了、还没有被一段话用掉：用掉以后 state 回到这一份（它出现以前管着的情绪和风格）
    let speed = before?.speed ?? null;
    let pendingPause = 0;
    let gap = before !== null ? [...before.gap] : []; // 这一段前面、同一行里还没挂到前一段上的提示（前一段之后、这一段之前写的）
    let hasPiece = before !== null && before.hasPiece; // 同一行里前面有没有一段要念的话（前一段也算）
    let last = 0;
    const push = (chunk) => {
      const spoken = chunk.trim();
      if (spoken === '') return;
      pieces.push({ text: spoken, hints: { ...state }, directions: gap, speed, line: lineNumber, pauseBeforeMs: pendingPause + waiting, pauseAfterMs: 0 });
      gap = [];
      pendingPause = 0;
      waiting = 0;
      hasPiece = true;
      if (back !== null) { // 一下子的声音只管紧跟着它的这一段：这一段用掉了它，后面的段回到它出现以前管着的
        state = back;
        back = null;
      }
    };
    for (const m of line.matchAll(DIRECTION_RE)) {
      const words = (m[1] ?? m[2] ?? m[3]).trim();
      if (words === '') continue; // 括号里只有空白：不是提示，留在台词里
      const { meaning, whole, durations } = readCue(words, m[2] === undefined, m[0]); // 结构规则只管括号，不管 *…*（m[2]）；m[0] 是括号连原文，报错时说是哪一个
      if (unrecognized === 'keep' && !whole) continue; // 整个不是舞台提示（词表里的提示，或者「副词 + 地」的写法）：不动，留在要念的话里，不切段，不记
      push(line.slice(last, m.index));
      last = m.index + m[0].length;
      const direction = { raw: words, recognized: isRecognized(meaning), emotion: meaning.emotion, style: meaning.style, actions: meaning.actions, line: lineNumber };
      directions.push(direction);
      gap.push(direction);
      if (meaning.emotion !== null || meaning.style !== null) {
        // 带一下子的声音的提示：它自己那一段照旧（和别的情绪、风格提示一样换掉旧的），用掉以后回到它出现以前管着的；还有一个没用掉的，回到的还是更早的那一份。别的情绪、风格提示：整个换掉旧的，也不再有等着用掉的
        const oneShot = meaning.style !== null && ONE_SHOT_STYLES.has(meaning.style);
        back = oneShot ? (back ?? { ...state }) : null;
        state = { emotion: meaning.emotion, style: meaning.style };
      }
      for (const action of meaning.actions) if (action === 'slow' || action === 'fast') speed = action;
      const pause = pauseOf(meaning, durations);
      if (pause > 0) {
        // 停顿算在前一段后面；挨着的几处加起来（和台本标记 [pause] 一样，没有上限）
        const previous = pieces.length > 0 && pieces[pieces.length - 1].line === lineNumber ? pieces[pieces.length - 1] : null;
        if (previous !== null) previous.pauseAfterMs += pause;
        else if (before !== null && before.hasPiece && pieces.length === 0) headPauseMs += pause; // 前一段（前面的调用里）后面的停顿
        else pendingPause += pause;
      }
    }
    push(line.slice(last));
    // 这一行没有要念的话，停顿还没处挂：整行只有提示（（停顿 3 秒））。放在前一句后面（前一句可以在上一行）；没有前一句，等后一句，放在它前面
    if (pendingPause > 0) {
      if (pieces.length > 0) pieces[pieces.length - 1].pauseAfterMs += pendingPause;
      else waiting += pendingPause;
    }
    if (lineNumber === lines.length - 1) carry = { emotion: state.emotion, style: state.style, speed, gap, hasPiece, back };
  });
  return { pieces, directions, unattachedPauseMs: waiting, headPauseMs, carry };
}

// ---------------------------------------------------------------- 配音：舞台说明换成提示，留在原位

/** 文字里的提示（方括号，语法见 tools/markup.mjs 的文件头「提示」）。 */
const CUE_RE = new RegExp(CUE_PATTERN, 'g');
/** 文字里的尖括号标签和音素标记（tools/markup.mjs 的文件头「尖括号标签」）。 */
const TAG_RE = new RegExp(TAG_PATTERN, 'g');
const PHONEME_MARKER_RE = new RegExp(PHONEME_MARKER_PATTERN, 'g');
const LANGUAGE_BLOCK_RE = new RegExp(LANGUAGE_BLOCK_PATTERN, 'g');
/** 音素标记、一对语言标签连同它包住的字，在 wordsOf 里换成的一个字（U+FFFC）：不是字母，认语种、估念多长都不算它，可这一截有要念的词。 */
const PHONEME_WORD = String.fromCodePoint(0xfffc);
/**
 * 去掉提示（方括号里的）和尖括号标签以后要念的字：认语种、挑参考用，配音（lib/dub.mjs）也用它看一截文字里有没有要念的字、估念多长（lib/speech-length.mjs）。
 * 成对的标签只去掉标签，包住的字留着（<whisper>快走</whisper> 是「快走」）。一个音素标记换成一个 U+FFFC：它是一个要念的词，可写的是音素，
 * 字母不是这句话的文字（中文句子里的 chong2 不能让这句认成拉丁字母）。一对语言标签连同它包住的字（<japanese>ありがとう</japanese>）也换成一个 U+FFFC：
 * 包住的是另一种语言的字，不是这句话的语言（中文句子里的一句日文不能让这句认成日文）；估念多长时少算了它们，只会往短里估。去掉以后留下的连续空格并成一个。
 */
export const wordsOf = (text) => text.replace(CUE_RE, '').replace(LANGUAGE_BLOCK_RE, PHONEME_WORD).replace(PHONEME_MARKER_RE, PHONEME_WORD).replace(TAG_RE, '').replace(/[ \t]{2,}/g, ' ').trim();
/** 舞台说明写成的提示：括号里的字放进方括号；字里的方括号去掉（不然会提前结束这个提示）。 */
const cueOf = (words) => `[${words.replace(/[[\]]/g, '')}]`;

/**
 * 配音读台词（lib/dub.mjs）：舞台说明换成同样意思的提示，留在它原来的位置交给模型；读成停顿的照旧是停顿。规则只在这里写：
 *   哪些算舞台说明   同上面「括号」和「哪些算」的「拿掉」：30 个字以内的（…）、(…)、【…】、*…*（**…** 是强调，去掉星号，字照念；
 *                    星号和字之间有空白的 3 * 4 * 5、* 笑 * 不是舞台说明，原样交给模型）。
 *   换成提示         括号里的字原样写进方括号，放在括号原来的位置：「（耳语）过来，*笑*我告诉你」是「[耳语]过来，[笑]我告诉你」。前后的字一个不动，不在那里切开。
 *                    方括号本来就是提示（tools/markup.mjs 的文件头「提示」），原样留着；放慢、加快、笑、叹气、咳嗽、吸一口气……都一样，只是写给模型的一句话，配音不另外处理。
 *   停顿             括号里有停顿的词（词表 actions 的 pause：（停顿 2 秒）、（沉默）……；呼吸、咳嗽这类一下子的声音不在里面，是上面的提示）的，是停顿，不写进文字：在那里切开（同一段话里短的，配音再并回一次请求，见 lib/dub.mjs 第 5c 步），时长和挂法同上面「停顿」
 *                    （算在前一段的后面；一行开头的算在后一段前面；跨过 [pause …] 的同一行，挂在前一段后面，见 headPauseMs）。时长是 0 的，什么都不留，也不切开。
 *                    括号里有停顿的词、又有情绪或风格的（（叹了口气，停顿 2 秒）），也只是停顿：情绪和风格不写进文字。
 *   一段             两处切开的地方（停顿、换行）之间要交给模型的文字，去掉两头空白；是空的不算一段。段里只有提示、没有字的（一行只写了（生气））也是一段，
 *                    words 是空串，由调用方决定接到哪里（lib/dub.mjs 把它接到下一段的开头）。
 *   整行只有停顿     pauseLines 列出整行只有读成停顿的舞台说明（时长大于 0）和空白的行号（同 piece.line）；第一行接着 carried 里的前一段的，不算整行。
 *                    配音认场景的边界用它（lib/dub.mjs 第 5c 步）：停顿写在一行的行尾、行首的，不在这里。
 *   脚本钩子的情绪   hints 是这一段里第一个有情绪或风格的舞台说明；没有就是同一行前面最近的一个（跨过 [pause …] 接着算，换一行、换声音就清掉）。
 *                    只给 lib/dub.mjs 的 moodOf（包里脚本的钩子）用：不挑参考，也不交给模型。
 *                    一下子的声音（vocab/cues.json 的 oneShot：笑、叹气、咳嗽、吸一口气这类）只算它所在的那一段，不带到后面；方括号里的提示不读。
 * @param {string} text 一段台词（tools/markup.mjs 解析出的一个 span 的文字）
 * @param {{ mood: { emotion: string|null, style: string|null }, hasPiece: boolean, gap: object[] }|null} [carried] 同一行前一段（[pause …] 之前）留下的状态（上一次调用的 carry）；换一行、换声音的一段不传
 * @param {{ script?: string }} [where] 同 readDirections：舞台说明里的停顿装不下一份 WAV 时，报错里补上它在台本里的行和列
 * @returns {{
 *   pieces: { text: string, words: string, hints: { emotion: string|null, style: string|null }, directions: object[], line: number, pauseBeforeMs: number, pauseAfterMs: number }[],
 *   directions: object[], unattachedPauseMs: number, headPauseMs: number,
 *   carry: { mood: { emotion: string|null, style: string|null }, hasPiece: boolean, gap: object[] }, pauseLines: number[]
 * }} text 是交给模型的文字（提示在原位）；words 是去掉所有提示（方括号里的）以后要念的字；directions 同 readDirections（这一段前面和里面的舞台说明）；
 *   unattachedPauseMs、headPauseMs 同 readDirections。
 */
export function cuesInPlace(text, carried = null, where = {}) {
  try {
    return cuesInPlaceOf(text, carried);
  } catch (error) {
    throw withPlace(error, where?.script);
  }
}

function cuesInPlaceOf(text, carried) {
  if (typeof text !== 'string') throw new TypeError('台词必须是字符串');
  const pauseLines = [];
  const pieces = [];
  const directions = [];
  let waiting = 0; // 前面还没有一段、等着挂到后一段前面的停顿
  let headPauseMs = 0; // 第一行开头的停顿，挂在 carried 里的前一段后面
  let carry = null;
  const lines = text.split(LINE_BREAK_RE);
  lines.forEach((original, lineNumber) => {
    const line = withoutEmphasis(original, 'remove');
    const before = lineNumber === 0 && carried !== null ? carried : null;
    let mood = before?.mood ?? { emotion: null, style: null }; // 同一行里最近的情绪、风格（一下子的声音不算）
    let hasPiece = before?.hasPiece ?? false;
    let pendingPause = 0;
    let sent = ''; // 这一段攒下的文字（提示在原位）
    let own = before !== null ? [...before.gap] : []; // 这一段前面和里面的舞台说明
    let startMood = { ...mood };
    let last = 0;
    let linePause = 0; // 这一行里读成停顿、时长大于 0 的舞台说明加起来
    const push = () => {
      const content = sent.trim();
      sent = '';
      if (content === '') return;
      const first = own.find((direction) => direction.emotion !== null || direction.style !== null);
      pieces.push({ text: content, words: wordsOf(content), hints: first === undefined ? startMood : { emotion: first.emotion, style: first.style }, directions: own, line: lineNumber, pauseBeforeMs: pendingPause + waiting, pauseAfterMs: 0 });
      own = [];
      pendingPause = 0;
      waiting = 0;
      hasPiece = true;
      startMood = { ...mood };
    };
    for (const m of line.matchAll(DIRECTION_RE)) {
      const words = (m[1] ?? m[2] ?? m[3]).trim();
      if (words === '') continue; // 括号里只有空白：不是舞台说明，留在台词里
      const { meaning, durations } = readCue(words, m[2] === undefined, m[0]);
      sent += line.slice(last, m.index);
      last = m.index + m[0].length;
      const direction = { raw: words, recognized: isRecognized(meaning), emotion: meaning.emotion, style: meaning.style, actions: meaning.actions, line: lineNumber };
      directions.push(direction);
      if (meaning.actions.includes('pause')) {
        const pause = pauseOf(meaning, durations);
        if (pause > 0) {
          linePause += pause;
          push();
          const previous = pieces.length > 0 && pieces[pieces.length - 1].line === lineNumber ? pieces[pieces.length - 1] : null;
          if (previous !== null) previous.pauseAfterMs += pause;
          else if (before !== null && before.hasPiece && pieces.length === 0) headPauseMs += pause;
          else pendingPause += pause;
        }
      } else sent += cueOf(words);
      own.push(direction);
      const oneShot = meaning.style !== null && ONE_SHOT_STYLES.has(meaning.style);
      if (meaning.emotion !== null || (meaning.style !== null && !oneShot)) mood = { emotion: meaning.emotion, style: oneShot ? null : meaning.style };
    }
    sent += line.slice(last);
    push();
    // 整行只有停顿（读成停顿的舞台说明和空白）：这一行没有出一段。第一行接着前一段（carried）的，不是整行
    if (linePause > 0 && before === null && !pieces.some((piece) => piece.line === lineNumber)) pauseLines.push(lineNumber);
    if (pendingPause > 0) {
      if (pieces.length > 0) pieces[pieces.length - 1].pauseAfterMs += pendingPause;
      else waiting += pendingPause;
    }
    if (lineNumber === lines.length - 1) carry = { mood, hasPiece, gap: own };
  });
  return { pieces, directions, unattachedPauseMs: waiting, headPauseMs, carry, pauseLines };
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
/** 一个汉字、谚文字或假名的信息量，按几个拉丁字母算。 */
const WEIGHT = { Han: 3, Hangul: 3, Japanese: 3 };
/** 假名至少占汉字加假名的几分之一（这里是五分之一），汉字才算日文的（文件头「文字的语种」）。 */
const KANA_SHARE = 5;
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
 * @returns {{ script: string, languages: string[] } | null} script 是文字系统（Han、Latin……，假名和算日文的汉字是 Japanese）；languages 是可能的主语言；认不出给 null
 */
export function detectLanguages(text) {
  if (typeof text !== 'string') throw new TypeError('文字必须是字符串');
  const counts = new Map();
  let kana = 0;
  let han = 0;
  for (const ch of text) {
    if (!/[\p{L}\p{Nl}]/u.test(ch)) continue;
    const found = SCRIPT_TESTS.find(([, test]) => test.test(ch))?.[0];
    if (found === undefined) continue;
    const script = found === 'Hiragana' || found === 'Katakana' ? 'Japanese' : found;
    if (script === 'Japanese') kana += 1;
    if (script === 'Han') han += 1;
    counts.set(script, (counts.get(script) ?? 0) + (WEIGHT[script] ?? 1));
  }
  // 假名占得够多，是日文：汉字也算日文的（文件头「文字的语种」）
  if (kana > 0 && han > 0 && kana * KANA_SHARE >= kana + han) {
    counts.set('Japanese', counts.get('Japanese') + counts.get('Han'));
    counts.delete('Han');
  }
  // Map 保持先出现的在前面，所以一样多时取先出现的
  let best = null;
  for (const [script, weight] of counts) if (best === null || weight > best.weight) best = { script, weight };
  return best === null ? null : { script: best.script, languages: [...LANGUAGES_OF[best.script]] };
}

/**
 * 文字认出的结果（detectLanguages 返回的）和一个给的语言标签对不对得上：给的语言的主语言在这种文字可能的语言里；日文也写汉字，汉字对得上日语。
 * 给的语言哪种文字的候选里都没有（这里不认识它），算对得上：认不出的不说对不上。
 * @param {{ script: string, languages: string[] }} detected
 * @param {string} tag
 * @returns {boolean}
 */
export function scriptFitsLanguage(detected, tag) {
  const primary = primaryLanguage(tag);
  if (detected.languages.includes(primary) || (detected.script === 'Han' && primary === 'ja')) return true;
  return !Object.values(LANGUAGES_OF).some((languages) => languages.includes(primary));
}
