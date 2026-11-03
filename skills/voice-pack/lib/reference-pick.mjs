// SPDX-License-Identifier: Apache-2.0
//
// 按台词挑参考（流程层）：每句话从参考集里挑情绪、风格、语言最匹配的那一段当参考。
// agent 环境里配音（lib/dub.mjs）和 app 调的是同一个函数。
//
// 输入输出都是普通数据：不碰 DOM、不碰文件系统，也不读音频（只看清单里参考段的标签）。要的能力只有一项，而且是可选的：
//   @capability text-generation  让它判断台词的情绪、风格（签名在 vocab/capability-signatures.md）。环境没有就不判断，不是错误
//
// 每一句要什么标签（这一节是「怎么说」每一项从哪取的唯一正本：lib/dub.mjs、lib/line-hints.mjs、references/dub.md、命令行 dub 都指到这里，不再各写一遍）：
//   「怎么说」的标签（情绪 emotion、风格 style、能量 energy），每一项分别按这个顺序取，取到就停（不是整组取：调用方给了其中一项，别的项照样往后看）：
//     1 调用方给的标签（line.labels）
//     2 台本标记里的提示（line.hints；没给就从 line.text 里读舞台提示，括号里的语气说明，例如（耳语）、*笑*，读法见 lib/line-hints.mjs）
//       读 line.text 时，括号里不是整个都认得的内容（词表里没有的，或者有词表里的词可是还有别的字）算不算要念的话，
//       由第四个参数 options.unrecognized 定，原样交给 readDirections：
//       不给是 'keep'（留在要念的话里，参与认语种和送去判断），配音给 'remove'（拿掉）。规则只在 lib/line-hints.mjs 的文件头写；line.hints 给了就不读 text，选项不起作用
//     3 设定里固定的标签（选项 setup 的 labels：音色包的清单里一套设定 setups，见 protocol/FORMAT.md 4.4；配音时由 lib/dub.mjs 选好是哪一套再交过来，不给就没有这一层）
//     4 环境有 text-generation：让它判断。前三层取完，「怎么说」的三项里还缺哪一项，而且这一项在这一句的候选里有可选的，
//       这一句就整句送去判（没有可念的话的除外），只能从参考集里有的标签里选。
//       有没有可选的，只在已定的项筛过以后剩下的参考段里看，筛法就是下面「怎么比」的比较（hasChoice 用的就是挑参考的 criteriaKey，不另写一套）：把这一句要的语言、和次序排在这一项前面的已定的项
//       交给比较，并列最好的那几段里，这一项的取值不都一样（没写这一项的段算一种取值），才有可选的。次序排在这一项后面的已定的项筛不掉它的候选（先比情绪、后比能量：能量定了、情绪缺，
//       情绪照样有可选的）。没有可选的，判出什么都挑不出不同的参考，不问；一句话缺的项都是这样的，就不送去。
//       缺的项，报告里照实写缺（wanted 里是 null，sources 里是 null）。
//       判断只补缺的、有可选的那几项（提示里叫 choose）：提示里每一句写明哪几项已经定了（fixed：前三层取到的项和它们的值），请模型在这个前提下选 choose 里的项，
//       所以固定了情绪，判出的风格是和这个情绪配得上的。回答里出现了没问的项（已经定了的，或者没有可选的），照旧丢掉（这不算回答有毛病，不进 judge.ignored）。
//       三项都没定、三项都问的句子，提示里只有编号和台词。提示的那一行和分批的量法用同一个函数写（judgeLine）。这是收费的调用：
//       环境声明了 text-generation 一次请求最多收多少输入（选项 maxPromptTokens）的，按它分几次发（量法和理由见 lib/input-batches.mjs），没声明就一次发完；单独超限的句子怎么办，见下 judge 一节
//       只规划、不花钱的调用方（lib/dub.mjs 的 planDub，命令行的 dub --dry-run）传选项 judge: false，不调，judge 里写明正式运行要判几句、调几次（见下）
//     5 都没有：默认参考
//   例：调用方只给了情绪、台本里写了（耳语）：情绪取调用方的，风格取台本的（两样都要）；台本里写了（耳语），设定固定了情绪：风格取台本的，情绪取设定的；
//   台本里写了（平静），设定固定的情绪是生气：这一项取台本的平静。设定只固定了情绪，台本没写别的：风格、能量缺，筛完的几段之间风格、能量有可选的，整句送去判，判断补风格和能量，情绪还是设定的；
//   三项分别由三层取到（调用方的情绪、台本的风格、设定的能量）：一项不缺，不送去判。调用方给了情绪，筛下来只剩一段（或剩下的几段风格、能量都一样）：风格、能量缺，可是没有可选的，不送去判。
//   语言 language 不走这个顺序：调用方给了就用调用方的，没给就用设定的，再没有就从文字本身认（lib/line-hints.mjs 的 detectLanguages）。
//     拉丁字母认不出是英语还是法语，给的是一组候选，所以只在参考集里恰好有一种拉丁字母语言时才起作用。
//   所以没有任何「怎么说」的标签时，语言仍然参与挑选：同一种语言里挑，其中有默认段就用默认段，没有就取这种语言里的第一段；
//   连语言也看不出来，才是纯粹的默认参考段。
//   语速、说明不在这里：它们不影响挑哪段参考，补法见 lib/dub.mjs 文件头。
//
// 怎么比：把每一段参考和要的标签逐项比，按这个次序比大小，前一项分出高低就不看后一项：
//   语言（完全一致 > 主语言一致 > 不一致） > 情绪 > 风格 > 能量 > 是不是默认段 > 在参考集里的次序
// 语言排在最前面：用另一种语言的参考克隆，音色和读音都会变差，比情绪对不上严重。没有要求的项不参与比较。
// 情绪、风格按规范化以后的写法比：大小写、全半角不论；舞台提示和标签里常见的近义词（angry、生气、愤怒……）认作同一个（vocab/cues.json）。
// 默认只用一段参考：每句话的结果里只有一个 segmentId，从不融合。留出录音从不当参考：只看 reference.segments；
// 清单里留出录音和参考共用 id 或音频文件，直接报错，不悄悄挑一个。
//
// 返回 { picks, judge }：
//   picks[i]  { index, segmentId, rule, wanted, sources, matched, missed, directions }；判断没成的句子（缺的项落到默认参考，前三层取到的项照旧）多一个 judgeFailed: true（见 judge）
//     rule      「怎么说」的标签是谁给的：'caller-labels' | 'markup-hints' | 'setup' | 'text-generation' | 'default'（前三层没有人给，判断也没补上）。几项来自不同的层时，写排在最前面的那一层（调用方、台本的提示、设定、判断；每一项各自从哪来，看 sources）
//     wanted    最终要的标签 { language, script, emotion, style, energy }，没有要求的项是 null；
//               language 是调用方（或设定）给的写法；从文字里认的，是这种文字可能的语言里参考集有的那几个（可能是空数组），不列整串（拉丁字母有四十多种语言）；
//               script 是从文字里认出的文字系统（Latin、Han、Japanese……），语言是调用方（或设定）给的就是 null；emotion、style 是规范化以后的名字
//     sources   每一项标签从哪来：'caller' | 'text'（从文字本身认的语言）| 'markup' | 'setup'（设定里固定的）| 'text-generation' | null
//               配音的 cues（lib/dub.mjs 第 7 步）读的就是 wanted.emotion、wanted.style（判断补上的也在里面），只留词表里的名字，不另取一遍
//     matched   要了、而且挑中的这一段也有的项（例如 ['language', 'emotion']）
//     missed    要了、但挑中的这一段没有的项：参考集里没有哪一段有它（例如生气的台词，参考集里没有生气的参考：['emotion']）
//     directions  台词里读到的舞台提示：这一段前面、同一行里还没挂到前一段上的（见 lib/line-hints.mjs 的文件头「段带的」）。选了 'remove' 时，认不出意思的也列着，recognized 为 false；默认的 'keep' 只列整个括号都认得的，和结构规则认出的「副词 + 地」，后者 recognized 为 false
//   judge     text-generation 这一步的情况（「要判」的句子是前三层取完还缺某一项、而且这一项有可选的句子，见上面第 4 层）：{ status: 'not_needed' | 'unavailable' | 'used' | 'unusable' | 'planned', ... }。
//             judge 里提到哪一句台词，用的都是同一种编号（选项 lineNumbers；不给就是台词在 lines 里的次序），发给模型的提示里每句台词前面方括号里的数也是它：
//             ignored[].index、tooLong.lines、truncated.lines，reason 里写的编号，都是它。这个编号（number）从 0 起；台词在 lines 里的位置叫次序（position），只在库里用；
//             命令行（cli/commands/dub.mjs）说的序号是合成的段的序号，从 1 起，是另一样东西，命令行不把 judge 里的编号原样摆给人看。
//             used 是判了：{ status: 'used', capability, model?, lines: 判了几句, calls: 发了几次请求, ignored }；calls 算上因回答被截断而对半再问的；回答分几次发的，model 取第一个报了的
//             planned 是选项 judge 给了 false、本来要判断的：{ status: 'planned', capability: 'text-generation', lines: 要发去判的句数（不含单独超限的，见 tooLong）, calls: 正式运行要发几次请求, tooLong? }，一次都没有调；
//             calls 是分批以后的次数，是下限：正式运行时回答被截断的那一批会对半再问，次数会多。
//             这几句现在落到默认参考，正式运行（judge 不给，默认 true）时挑的参考可能不一样。
//             unusable 是有句子没判成：{ status: 'unusable', capability, reason, lines: 发去判的句数（不含单独超限的）, calls, model?, error?, ignored?, tooLong?, truncated? }，有三种原因，可以同时有；
//               reason 是第一个没判成的原因，写明是哪几句（编号），没判成的那几句都落到默认参考：
//               回答不能用：回答读不出 JSON 数组的没有 error；能力报的「回答不能用」（见下面「抛出的错误」）的，error 是那个错的摘要 { code, message, details }；
//               分几次发的，只有不能用的那一次的句子没判成，别的次照常采纳，status 是 unusable（几次的汇总取最要紧的，规则是本文件导出的 combineJudges，配音有几个包时也用它）；
//               回答被截断（平台给的信号：stopReason 是 length）：这一批对半分开，两半各问一次，一直分下去，不另估每句要多少输出；分到只剩一句、单独问还是被截断的，
//               这一句没判成，truncated: { lines: 这几句的编号 }，reason、error 是那次被截断的回答的；
//               单独一句就超过一次请求的输入上限：这一句不判、不截，tooLong: { limit: 上限, lines: 这几句的编号 }。
//             不论哪种，没判成的那几句，它们的 picks[i] 标着 judgeFailed: true，配音接着做；tooLong 的句子在规划里（planned）就已经标着
//
// 选项 options（第四个参数，都可选）：unrecognized，原样交给 readDirections（见下）；setup，{ labels?: { language?, emotion?, style?, energy? } }，这一次用的一套设定里固定的标签（上面的第 3 层；写法同清单里设定的 labels）；judge，布尔值，默认 true：false 就不调 text-generation；
//   maxPromptTokens，不小于 1 的整数，text-generation 一次请求最多收多少输入（模型的事实，由环境的适配器声明，库里不写这个数；不给就不分批）；
//   lineNumbers，每句台词一个互不相同的非负整数（和 lines 一样长），judge 里提到台词时用的编号，不给就是台词在 lines 里的次序（配音有几个包时，每个包只拿到自己的几句，给的是它们在整份台本里的编号）。
//   写错（键拼错、值不对）抛 pick_input_invalid
//
// 抛出的错误（code 小写下划线，details 里放什么在抛出处写明）：
//   pick_input_invalid   输入不是约定的形状，或者清单自相矛盾。details.field 是出问题的字段（options 的写法不对时是 options）
// 环境本身不合格抛 environment_invalid。text-generation 自己抛的错原样往上传（不吞，401 之类要让调用方看见），唯一的例外是「回答不能用」：
//   回答不能用   capability_result_invalid，details.capability 是 text-generation（没有文字、没有正常结束；写法在 vocab/capability-signatures.md 的 text-generation 一节）
//                 → 不抛：judge.status 记成 unusable，判断的几句落到默认参考（judgeFailed），配音接着做（分几次发的，只有那一次的句子；被截断的，先对半分开再问，见上 judge）
//   别的错       401（凭据被拒）、输入不对（capability_input_invalid）、服务暂时出错（details.transient）……原样往上传，由调用方决定停下、重来或补做
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError, isVoicePackError } from '../protocol/lib/errors.mjs';
import { hasCapability, requireCapability } from '../protocol/lib/env.mjs';
import { canonicalLabel, detectLanguages, primaryLanguage, readDirectionOptions, readDirections } from './line-hints.mjs';
import { badResult, summarizeError } from './capability-calls.mjs';
import { askBatches, splitBatches, utf8Length } from './input-batches.mjs';

const ENERGIES = ['low', 'medium', 'high'];
const LABEL_KEYS = ['language', 'emotion', 'style', 'energy'];
const MOOD_KEYS = ['emotion', 'style', 'energy'];
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const invalid = (field, message) => new VoicePackError('pick_input_invalid', message, { details: { field } });

/** 语言标签规范化：兼容分解、转小写、下划线当连字符。 */
const languageKey = (tag) => String(tag).normalize('NFKC').toLowerCase().trim().replace(/_/g, '-');

// ---------------------------------------------------------------- 输入检查

function readReferenceSet(manifest) {
  if (!isPlainObject(manifest) || !isPlainObject(manifest.reference)) throw invalid('reference', '要给参考集：清单里的 reference（defaultSegment 和 segments）');
  const { defaultSegment, segments } = manifest.reference;
  if (!Array.isArray(segments) || segments.length === 0) throw invalid('reference.segments', '参考集至少要有一段参考');
  segments.forEach((segment, index) => {
    if (!isPlainObject(segment) || typeof segment.id !== 'string' || !isPlainObject(segment.tags)) {
      throw invalid(`reference.segments[${index}]`, `参考段 ${index} 要有 id 和 tags`);
    }
  });
  if (!segments.some((segment) => segment.id === defaultSegment)) {
    throw invalid('reference.defaultSegment', `默认参考段 ${JSON.stringify(defaultSegment)} 不是参考集里的一段`);
  }
  const holdout = manifest.holdout ?? [];
  if (!Array.isArray(holdout)) throw invalid('holdout', 'holdout 必须是数组');
  const taken = new Set(segments.flatMap((segment) => [`id:${segment.id}`, ...(typeof segment.audio === 'string' ? [`audio:${segment.audio}`] : [])]));
  for (const [index, recording] of holdout.entries()) {
    if (taken.has(`id:${recording?.id}`) || (typeof recording?.audio === 'string' && taken.has(`audio:${recording.audio}`))) {
      throw invalid('holdout', `留出录音 holdout[${index}]（${recording?.id}）和参考集共用 id 或音频文件：留出录音从不当参考，清单自相矛盾`);
    }
  }
  // 每一段参考的标签，先规范化好：比较时不用再算
  const candidates = segments.map((segment, order) => ({
    id: segment.id,
    order,
    isDefault: segment.id === defaultSegment,
    language: typeof segment.tags.language === 'string' ? { key: languageKey(segment.tags.language), primary: primaryLanguage(segment.tags.language) } : null,
    emotion: typeof segment.tags.emotion === 'string' ? canonicalLabel('emotion', segment.tags.emotion) : null,
    style: typeof segment.tags.style === 'string' ? canonicalLabel('style', segment.tags.style) : null,
    energy: typeof segment.tags.energy === 'string' ? segment.tags.energy : null,
  }));
  return { defaultSegment, candidates, segments };
}

function readLabels(raw, at) {
  const labels = {};
  if (raw === undefined) return labels;
  if (!isPlainObject(raw)) throw invalid(at, `${at} 必须是对象：{ language?, emotion?, style?, energy? }`);
  for (const key of LABEL_KEYS) {
    const value = raw[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') throw invalid(`${at}.${key}`, `${at}.${key} 必须是字符串`);
    if (key === 'energy' && !ENERGIES.includes(value)) throw invalid(`${at}.energy`, `${at}.energy 必须是 ${ENERGIES.join('、')} 之一`);
    labels[key] = value;
  }
  return labels;
}

function readLines(lines) {
  if (!Array.isArray(lines)) throw invalid('lines', 'lines 必须是数组：每一句台词一个 { text, labels? }');
  return lines.map((line, index) => {
    const at = `lines[${index}]`;
    if (!isPlainObject(line)) throw invalid(at, `${at} 必须是一个对象`);
    if (line.text !== undefined && typeof line.text !== 'string') throw invalid(`${at}.text`, `${at}.text 必须是字符串`);
    if (line.directions !== undefined && !Array.isArray(line.directions)) throw invalid(`${at}.directions`, `${at}.directions 必须是数组`);
    return {
      text: line.text ?? '',
      labels: readLabels(line.labels, `${at}.labels`),
      hints: line.hints === undefined ? undefined : readLabels(line.hints, `${at}.hints`),
      directions: line.directions,
    };
  });
}

const OPTION_KEYS = ['unrecognized', 'judge', 'maxPromptTokens', 'lineNumbers', 'setup'];

/**
 * 选项：judge（是否调 text-generation，默认是）、maxPromptTokens（text-generation 一次请求最多收多少输入；不给就不分批）、setup（这一次用的一套设定，见 readSetup），其余原样交给读舞台提示的选项（lib/line-hints.mjs 的 readDirections 的第二个参数）。
 * 现在就检查，不等到某句台词用上它；写错了不悄悄当成默认值。
 * lineNumbers（每句台词在整份台本里的编号，见 readLineNumbers）这里只取出来，长度对不对要等读了台词才知道。
 * @returns {{ judge: boolean, maxPromptTokens: number | null, lineNumbers: unknown, setup: unknown, directions: { unrecognized: 'keep'|'remove' } }}
 */
function readOptions(options) {
  let judge = true;
  let maxPromptTokens = null;
  let lineNumbers;
  let setup;
  let rest = options;
  if (isPlainObject(options)) {
    const unknown = Object.keys(options).find((key) => !OPTION_KEYS.includes(key));
    if (unknown !== undefined) throw invalid('options', `options 不合约定：不认识的选项 ${JSON.stringify(unknown)}：只有 ${OPTION_KEYS.join('、')}`);
    if (Object.hasOwn(options, 'judge')) {
      ({ judge, ...rest } = options);
      if (typeof judge !== 'boolean') throw invalid('options', `options 不合约定：judge 必须是 true 或 false，收到 ${JSON.stringify(judge)}`);
    }
    if (Object.hasOwn(options, 'maxPromptTokens')) {
      ({ maxPromptTokens, ...rest } = rest);
      if (!Number.isInteger(maxPromptTokens) || maxPromptTokens < 1) throw invalid('options', `options 不合约定：maxPromptTokens 必须是不小于 1 的整数，收到 ${JSON.stringify(maxPromptTokens)}`);
    }
    if (Object.hasOwn(options, 'lineNumbers')) ({ lineNumbers, ...rest } = rest);
    if (Object.hasOwn(options, 'setup')) ({ setup, ...rest } = rest);
  }
  try {
    return { judge, maxPromptTokens, lineNumbers, setup, directions: readDirectionOptions(rest) };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw invalid('options', `options 不合约定：${error.message}`);
  }
}

/**
 * 这一次用的一套设定里固定的标签（选项 setup，文件头第 3 层）：{ labels?: { language?, emotion?, style?, energy? } }，labels 的写法同台词的 labels。不给就没有这一层。
 * 设定的别的字段（语速、说明）不在这里：和挑参考无关，由 lib/dub.mjs 用。
 */
function readSetup(raw) {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) throw invalid('options', 'options 不合约定：setup 必须是对象：{ labels?: { language?, emotion?, style?, energy? } }');
  const unknown = Object.keys(raw).find((key) => key !== 'labels');
  if (unknown !== undefined) throw invalid('options', `options 不合约定：setup 里不认识的键 ${JSON.stringify(unknown)}：只有 labels`);
  return readLabels(raw.labels, 'options.setup.labels');
}

/**
 * 每句台词报给调用方的编号：判情绪的记录（judge）里提到哪一句，用的是它；发给模型的提示里每句台词前面方括号里的数也是它，所以模型回答里的 index、
 * judge.ignored 的 index、judge.tooLong.lines、judge.truncated.lines 是同一种编号。不给就是台词在 lines 里的次序。
 * 配音（lib/dub.mjs）一份台本有几个包时，每个包只拿到自己的那几句，给的是这几句在整份台本里的编号（lines[i].index）。
 */
function readLineNumbers(raw, count) {
  if (raw === undefined) return Array.from({ length: count }, (_, index) => index);
  if (!Array.isArray(raw) || raw.length !== count || raw.some((number) => !Number.isInteger(number) || number < 0) || new Set(raw).size !== count) {
    throw invalid('options', `options 不合约定：lineNumbers 必须是 ${count} 个互不相同的非负整数（每句台词一个编号），收到 ${JSON.stringify(raw)}`);
  }
  return raw;
}

// ---------------------------------------------------------------- 比较

/** 语言的比较：2 完全一致，1 主语言一致，0 不一致（或者这一段没写语言）。wanted 是 { key, primaries }。 */
function languageScore(wanted, candidate) {
  if (candidate.language === null) return 0;
  if (wanted.key !== null && wanted.key === candidate.language.key) return 2;
  return wanted.primaries.includes(candidate.language.primary) ? 1 : 0;
}

/** 这一段在某个「怎么说」的项上对不对得上要求。 */
const moodHit = (candidate, wanted, key) => candidate[key] !== null && candidate[key] === wanted[key];

/** 要了的那几项的键（语言，再是情绪、风格、能量），逐项比大小；没有要求的项不参与。 */
function criteriaKey(candidate, wanted) {
  const key = [];
  if (wanted.language !== null) key.push(languageScore(wanted.language, candidate));
  for (const mood of MOOD_KEYS) if (wanted[mood] !== null) key.push(moodHit(candidate, wanted, mood) ? 1 : 0);
  return key;
}

/** 比较用的键：要了的项，再是是不是默认段、在参考集里的次序。 */
const compareKey = (candidate, wanted) => [...criteriaKey(candidate, wanted), candidate.isDefault ? 1 : 0, -candidate.order];

function isBetter(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * 一句台词缺的某一项（mood）在参考集里有没有可选的：把排在它前面的要求（语言，和次序在它前面的、已经定了的「怎么说」的项）交给挑参考自己的比较，
 * 筛下来并列最好的那几段里，这一项的取值不都一样，才有可选的（判出哪个值，挑中的参考就可能不同）。比较的规则只有 criteriaKey / isBetter 这一处，这里不另写。
 * 排在它后面的已定的项筛不掉它的候选：次序在前的项先比（例如能量定了、情绪缺：情绪先比，所以四段里情绪不同，就有可选的）。
 */
function hasChoice(candidates, wanted, mood) {
  const before = { language: wanted.language, emotion: null, style: null, energy: null };
  for (const key of MOOD_KEYS.slice(0, MOOD_KEYS.indexOf(mood))) before[key] = wanted[key];
  const keyed = candidates.map((candidate) => ({ candidate, key: criteriaKey(candidate, before) }));
  const best = keyed.reduce((top, { key }) => (isBetter(key, top) ? key : top), keyed[0].key);
  const tied = keyed.filter(({ key }) => !isBetter(best, key));
  return new Set(tied.map(({ candidate }) => candidate[mood])).size >= 2;
}

function choose(candidates, wanted) {
  let best = null;
  for (const candidate of candidates) {
    const key = compareKey(candidate, wanted);
    if (best === null || isBetter(key, best.key)) best = { candidate, key };
  }
  return best.candidate;
}

/** 挑中的这一段在每个要了的项上有没有对上。没对上，是因为参考集里没有哪一段对得上（挑的时候已经尽力了）。 */
function explain(candidate, wanted) {
  const matched = [];
  const missed = [];
  if (wanted.language !== null) (languageScore(wanted.language, candidate) > 0 ? matched : missed).push('language');
  for (const mood of MOOD_KEYS) if (wanted[mood] !== null) (moodHit(candidate, wanted, mood) ? matched : missed).push(mood);
  return { matched, missed };
}

// ---------------------------------------------------------------- 一句台词要什么标签

/** 这句台词真正要念的话：拿掉舞台提示以后的文字（配音流程切开以后交过来的 text 已经是拿掉的）。认不出的括号内容算不算要念的话，看选项 unrecognized。 */
const spokenOf = (line, directionOptions) => (line.hints !== undefined ? line.text : readDirections(line.text, directionOptions).pieces.map((piece) => piece.text).join(' '));

/** 台词里读到的第一个有情绪或风格的舞台提示。 */
function firstMood(directions) {
  const found = directions.find((direction) => direction.emotion !== null || direction.style !== null);
  return found === undefined ? {} : { ...(found.emotion === null ? {} : { emotion: found.emotion }), ...(found.style === null ? {} : { style: found.style }) };
}

/** 「怎么说」的一项从哪一层来，对应 picks[i].rule 里的名字；排在前面的层优先。 */
const RULE_OF_SOURCE = [['caller', 'caller-labels'], ['markup', 'markup-hints'], ['setup', 'setup']];

/**
 * 一句台词要的标签：「怎么说」的三项，每一项分别按 调用方 -> 台本标记 -> 设定 的顺序看，取到就停（text-generation 的判断由调用的地方补：三项里还缺哪一项，这一句就要判，判断只补缺的项）；
 * 语言单独认：调用方 -> 设定 -> 文字。规则的正本在文件头。
 * @returns {{ wanted: object, sources: object, rule: string, directions: object[], missing: string[] }} missing：前三层取完还缺的项（情绪、风格、能量里没有来源的）
 */
function wantedFor(line, directionOptions, setupLabels) {
  const read = line.hints === undefined && line.directions === undefined ? readDirections(line.text, directionOptions) : null;
  const directions = line.directions ?? read?.directions ?? [];
  const wanted = { language: null, emotion: null, style: null, energy: null };
  const sources = { language: null, emotion: null, style: null, energy: null };

  const markupMood = line.hints !== undefined ? line.hints : firstMood(directions);
  for (const key of MOOD_KEYS) {
    const [value, source] = line.labels[key] !== undefined ? [line.labels[key], 'caller']
      : markupMood[key] !== undefined ? [markupMood[key], 'markup']
        : setupLabels[key] !== undefined ? [setupLabels[key], 'setup'] : [undefined, null];
    if (value === undefined) continue;
    wanted[key] = key === 'energy' ? value : canonicalLabel(key, value);
    sources[key] = source;
  }
  const rule = RULE_OF_SOURCE.find(([source]) => MOOD_KEYS.some((key) => sources[key] === source))?.[1] ?? 'default';

  const given = line.labels.language !== undefined ? [line.labels.language, 'caller'] : setupLabels.language !== undefined ? [setupLabels.language, 'setup'] : null;
  if (given !== null) {
    wanted.language = { key: languageKey(given[0]), primaries: [primaryLanguage(given[0])], shown: given[0] };
    sources.language = given[1];
  } else {
    // 认语种时括号里的提示不算：不然中文台词里一个英文提示，整句会被认成英文（认不出的括号内容选了「保留」，它是要念的话，就算）
    const detected = detectLanguages(read === null ? spokenOf(line, directionOptions) : read.pieces.map((piece) => piece.text).join(' '));
    if (detected !== null) {
      wanted.language = { key: null, primaries: detected.languages.map(primaryLanguage), shown: detected.languages, script: detected.script };
      sources.language = 'text';
    }
  }
  return { wanted, sources, rule, directions, missing: MOOD_KEYS.filter((key) => wanted[key] === null) };
}

/** 前三层已经定下来的项 { emotion?, style?, energy? }（规范化以后的值）：提示里写给模型，让它在这个前提下选缺的项。 */
const fixedOf = (plan) => Object.fromEntries(MOOD_KEYS.filter((key) => plan.sources[key] !== null).map((key) => [key, plan.wanted[key]]));

// ---------------------------------------------------------------- 让 text-generation 判断

/** 参考集里「怎么说」的每一项有哪些取值（按标签原来的写法，去重）：请模型从这里选。 */
function labelChoices(candidates, segments) {
  const choices = { emotion: [], style: [], energy: [] };
  for (const mood of MOOD_KEYS) {
    for (const [index, candidate] of candidates.entries()) {
      const raw = segments[index].tags[mood];
      if (typeof raw === 'string' && !choices[mood].some((item) => item.canonical === candidate[mood])) choices[mood].push({ raw, canonical: candidate[mood] });
    }
  }
  return choices;
}

/** 提示里写已定的值：一般的词原样写，带别的字符（换行、竖线……）的用 JSON 引起来，免得破坏提示的行。 */
const shownValue = (value) => (/^[\p{L}\p{N}_-]+$/u.test(value) ? value : JSON.stringify(value));

/**
 * 一句台词在提示里的那一行。分批量的就是它（splitJudgeRequests），所以提示和量用同一个函数写。
 * 三项都没定、三项都问：只有编号和台词。否则后面接着写 fixed（前三层已经定了的项）和 choose（要模型选的项），用竖线隔开。
 * item：{ number, text, fixed: { emotion?, style?, energy? }, ask: 要选的项（情绪、风格、能量里的几项） }。
 */
function judgeLine(item) {
  const fixed = MOOD_KEYS.filter((key) => item.fixed[key] !== undefined).map((key) => `${key}=${shownValue(item.fixed[key])}`);
  const notes = fixed.length === 0 && item.ask.length === MOOD_KEYS.length ? [] : [...(fixed.length === 0 ? [] : [`fixed: ${fixed.join(', ')}`]), `choose: ${item.ask.join(', ')}`];
  return [`[${item.number}] ${JSON.stringify(item.text)}`, ...notes].join(' | ');
}

function buildJudgePrompt(choices, items) {
  const shown = (mood) => (choices[mood].length > 0 ? choices[mood].map((item) => item.raw).join(', ') : '（没有）');
  return [
    '你是配音导演。下面是一个声音的参考录音上有的标签，和要配音的台词。请为每句台词判断该用哪种参考：emotion（情绪）、style（风格）、energy（能量）各选一个。只能从给出的取值里选；判断不了、或者没有特别的要求，就填 null。',
    '有的台词后面带着 fixed 和 choose：fixed 是已经定了的项，不要改；请在这个前提下，只选 choose 里的项（例如情绪已经定了，风格要和这个情绪配得上）。没带的台词，三项都选。',
    'You are a dubbing director. Below are the labels the reference recordings of one voice carry, and the lines to be dubbed. For each line choose emotion, style and energy, using only the values listed; use null when you cannot tell or there is nothing special.',
    'Some lines are followed by fixed and choose: the fixed items are already decided, do not change them; choose only the items listed in choose, so that they fit the fixed ones (for example a style that suits an emotion already fixed). For lines without them, choose all three.',
    '',
    '参考集里有的标签 / Labels in the reference set:',
    `- emotion: ${shown('emotion')}`,
    `- style: ${shown('style')}`,
    `- energy: ${shown('energy')}`,
    '',
    '台词 / Lines:',
    ...items.map(judgeLine),
    '',
    '只输出一个 JSON 数组，不要别的文字。每句台词一个对象，index 是台词前面方括号里的数字，只写要选的项。Output only a JSON array, one object per line; index is the number in square brackets; write only the items to choose:',
    '[{"index": 0, "emotion": null, "style": null, "energy": null}]',
  ].join('\n');
}

/** 读判断的回答：整段是 JSON 数组，或者包在一个代码块里，或者夹在别的话中间。读不出来给 null。 */
function parseJudgeReply(text) {
  const candidates = [text.trim()];
  const fenced = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(text.trim());
  if (fenced !== null) candidates.push(fenced[1].trim());
  const from = text.indexOf('[');
  const to = text.lastIndexOf(']');
  if (from !== -1 && to > from) candidates.push(text.slice(from, to + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (Array.isArray(value)) return value;
    } catch {
      // 换下一种读法
    }
  }
  return null;
}

/**
 * 能力报的「回答不能用」：没有文字、没有正常结束。适配器按约定报 capability_result_invalid，details.capability 是 text-generation
 * （约定写在 vocab/capability-signatures.md 的 text-generation 一节）。这一类的错不往上传，别的错照旧往上传。
 */
const isUnusableAnswer = (error) => isVoicePackError(error, 'capability_result_invalid') && error.details?.capability === 'text-generation';

/** 回答不能用里的一种：回答被截断（details.problem 是 stop_reason，details.stopReason 是 length，约定在 vocab/capability-signatures.md 的 text-generation 一节）。 */
const isCutShort = (error) => isUnusableAnswer(error) && error.details?.problem === 'stop_reason' && error.details?.stopReason === 'length';

/**
 * 待判的台词分成几次请求，量法和理由见 lib/input-batches.mjs。提示 = 固定的说明 + 每句台词一行（行与行之间一个换行），所以一句台词占它那一行的字节数加行尾的换行，不重建提示。
 * limit 是 null（环境没声明一次请求的上限）：一次装下全部。
 */
const splitJudgeRequests = (choices, pending, limit) => splitBatches(pending, { limit, fixed: utf8Length(buildJudgePrompt(choices, [])), bytesOf: (item) => utf8Length(judgeLine(item)) + 1, glue: 0 });

/** 回答不能用的两样记录：错的摘要和一句原因，写进 judge 的 reason、error。 */
const unusableByError = (error) => ({ reason: `回答不能用，不猜：${error.message}`, error: summarizeError(error) });

/**
 * 问一批，读回答：读得出的是 { answer: { entries, model } }；回答不能用的是 { unusable: { reason, error?, model? } }，这一批的句子落到默认参考，接着问下一批。
 * 回答被截断的错往上抛，由 askBatches 对半分开再问；别的错原样往上传（见文件头）。
 */
async function askJudge(env, choices, batch) {
  let reply;
  try {
    reply = await requireCapability(env, 'text-generation')({ prompt: buildJudgePrompt(choices, batch) });
  } catch (error) {
    if (isUnusableAnswer(error) && !isCutShort(error)) return { unusable: unusableByError(error) };
    throw error;
  }
  if (!isPlainObject(reply) || typeof reply.text !== 'string') throw badResult('text-generation', 'text_missing', '要 { text: 字符串 }');
  const model = typeof reply.model === 'string' ? reply.model : undefined;
  const entries = parseJudgeReply(reply.text);
  return entries === null ? { unusable: { reason: '回答不是一个 JSON 数组，不猜', model } } : { answer: { entries, model } };
}

/**
 * 采纳一批的回答：判出来的标签、来源、理由就地写进 plans。只采纳问了的项（item.ask）：这一句前三层已经取到的项、没有可选的项，回答里说什么都不采纳，也不算回答有毛病，不进 ignored。
 * 别的不采纳的（编号对不上、取值不在参考集里……）不猜，如实返回，进 judge.ignored。
 * 模型回答里的 index 是提示里方括号中的台词编号（number），不是台词在 lines 里的次序（position）。
 */
function adoptAnswer(batch, entries, choices, plans) {
  const byNumber = new Map(batch.map((item) => [item.number, item]));
  const answered = new Set();
  const ignored = [];
  for (const entry of entries) {
    if (!isPlainObject(entry) || !Number.isInteger(entry.index)) {
      ignored.push({ reason: '不是 { index, … } 对象' });
      continue;
    }
    const number = entry.index;
    if (!byNumber.has(number) || answered.has(number)) {
      ignored.push({ index: number, reason: byNumber.has(number) ? '同一句台词答了不止一次，只采纳第一次' : '台词的编号对不上' });
      continue;
    }
    answered.add(number);
    const { position, ask } = byNumber.get(number);
    const plan = plans[position];
    for (const mood of MOOD_KEYS) {
      const value = entry[mood];
      if (!ask.includes(mood)) continue; // 没问的项（前三层已经取到的，或者没有可选的），回答里写了也不采纳
      if (value === undefined || value === null || value === '') continue;
      const canonical = typeof value === 'string' ? (mood === 'energy' ? value : canonicalLabel(mood, value)) : null;
      if (canonical === null || !choices[mood].some((item) => item.canonical === canonical)) {
        ignored.push({ index: number, field: mood, value, reason: '取值不在参考集里' });
        continue;
      }
      plan.wanted[mood] = canonical;
      plan.sources[mood] = 'text-generation';
      if (plan.rule === 'default') plan.rule = 'text-generation'; // 前三层有人给的，理由写排在最前的那一层（文件头 rule）
    }
  }
  return ignored;
}

/**
 * 前三层取完还缺「怎么说」的某一项、而且这一项有可选的台词（hasChoice），让 text-generation 判断，判断只补缺的、有可选的项（提示里写明已定的项，文件头第 4 层）。就地改 plans（判出来的标签、来源、理由），返回 judge 的情况。
 * 台词整句送去，不截字数；环境声明了一次请求的输入上限（limit）就按它分批发（splitJudgeRequests），没声明就一次装下全部。
 * allowCall 是 false 就一次都不调（那是收费的调用）：要判断、环境也有这项能力的，返回 planned、要判几句和要调几次。
 */
async function runJudge(env, set, input, plans, directionOptions, allowCall, limit, numbers) {
  const choices = labelChoices(set.candidates, set.segments);
  // position 是台词在 lines 里的次序，number 是报给调用方和模型的编号（readLineNumbers）。
  // ask 是要问模型的项：前三层取完还缺、而且这一句的候选里这一项有可选的（hasChoice：已定的项筛过以后剩下的参考段里取值不都一样）；一项都没有，这一句不送去判。fixed 是已经定了的项，写在提示里
  const pending = plans.flatMap((plan, position) => {
    const ask = plan.missing.filter((key) => hasChoice(set.candidates, plan.wanted, key));
    if (ask.length === 0) return [];
    const text = spokenOf(input[position], directionOptions).trim();
    return text === '' ? [] : [{ position, number: numbers[position], text, ask, fixed: fixedOf(plan) }];
  });
  if (pending.length === 0) return { status: 'not_needed' };
  if (!hasCapability(env, 'text-generation')) return { status: 'unavailable', capability: 'text-generation' };
  const { batches, tooLong } = splitJudgeRequests(choices, pending, limit);
  // 单独一句就超过上限的（规则在文件头 judge 一节）：规划时就标上，它判不成是已知的
  for (const { item } of tooLong) plans[item.position].judgeFailed = true;
  const tooLongLines = tooLong.map(({ item }) => item.number);
  const judged = pending.length - tooLong.length; // 发去判的句数：单独超限的不在里面
  if (!allowCall) return { status: 'planned', capability: 'text-generation', lines: judged, calls: batches.length, ...(tooLong.length === 0 ? {} : { tooLong: { limit, lines: tooLongLines } }) };

  // 每一批各自问、各自读：回答不能用的那一批，它的句子落到默认参考（judgeFailed），别的批照常采纳，配音接着做。别的错原样往上传（见文件头）。
  // 回答被截断（平台给的信号）的那一批对半分开再问；分到一句还被截断，这一句判不成，记在 truncated 里
  const { results, calls } = await askBatches(batches, {
    ask: (batch) => askJudge(env, choices, batch),
    isCut: isCutShort,
    whenCutAlone: (batch, error) => ({ unusable: { ...unusableByError(error), cutAlone: true } }),
  });
  const answered = results.filter(({ result }) => result.answer !== undefined);
  const failed = results.filter(({ result }) => result.unusable !== undefined);
  for (const { batch } of failed) for (const item of batch) plans[item.position].judgeFailed = true;

  // 每一批、每个单独超限的句子各是一份 judge，汇总照 combineJudges（几个包的汇总是同一条规则）：有一批不能用、或有句子没判成，status 就是 unusable；
  // reason 说第一个没判成的原因：有一批回答不能用就是它的，没有就是句子单独超过上限（哪几句、上限是多少，同样写在 tooLong 里）
  const parts = [
    ...answered.map(({ batch, result }) => ({ status: 'used', model: result.answer.model, lines: batch.length, ignored: adoptAnswer(batch, result.answer.entries, choices, plans) })),
    ...failed.map(({ batch, result: { unusable } }) => ({
      status: 'unusable', reason: unusable.reason, error: unusable.error, model: unusable.model, lines: batch.length,
      ...(unusable.cutAlone === true ? { truncated: { lines: batch.map((item) => item.number) } } : {}),
    })),
    ...(tooLong.length === 0 ? [] : [{ status: 'unusable', reason: `编号 ${tooLongLines.join('、')} 的台词，单独就超过一次请求的输入上限（${limit}），不判，也不截`, lines: 0, tooLong: { limit, lines: tooLongLines } }]),
  ];
  const merged = combineJudges(parts);
  // lines 是发去判的句数（combineJudges 把 0 省掉）；calls 含被截断的；判成了的，ignored 总有，没有不采纳的就是空数组
  return { ...merged, lines: judged, calls, ...(merged.status === 'used' ? { ignored: merged.ignored ?? [] } : {}) };
}

/**
 * 几份 text-generation 的判断合成一份 judge：一份台本有几个包时每个包一份（lib/dub.mjs，只有一个包时不合，用它自己的），一个包里分几批发时每批一份（runJudge）。
 * status 取最要紧的一个（unusable > planned > used > unavailable > not_needed），lines、calls 相加，ignored、tooLong.lines、truncated.lines 接在一起
 * （台词的编号是台词自己的，可以直接接；上限是同一个环境的同一个数），model 取第一个有的，reason 和跟着它的 error 取第一个有 reason 的。
 */
export function combineJudges(judges) {
  const rank = ['unusable', 'planned', 'used', 'unavailable', 'not_needed'];
  const status = rank.find((name) => judges.some((judge) => judge.status === name)) ?? 'not_needed';
  const first = (key) => judges.find((judge) => judge[key] !== undefined)?.[key];
  const failed = judges.find((judge) => judge.reason !== undefined);
  const lines = judges.reduce((sum, judge) => sum + (judge.lines ?? 0), 0);
  const calls = judges.reduce((sum, judge) => sum + (judge.calls ?? 0), 0);
  const ignored = judges.flatMap((judge) => judge.ignored ?? []);
  const tooLong = judges.flatMap((judge) => judge.tooLong?.lines ?? []);
  const truncated = judges.flatMap((judge) => judge.truncated?.lines ?? []);
  return {
    status,
    ...(status === 'not_needed' ? {} : { capability: 'text-generation' }),
    ...(lines > 0 ? { lines } : {}),
    ...(calls > 0 ? { calls } : {}),
    ...(first('model') === undefined ? {} : { model: first('model') }),
    ...(failed === undefined ? {} : { reason: failed.reason }),
    ...(failed?.error === undefined ? {} : { error: failed.error }),
    ...(ignored.length > 0 ? { ignored } : {}),
    ...(tooLong.length > 0 ? { tooLong: { limit: first('tooLong').limit, lines: tooLong } } : {}),
    ...(truncated.length > 0 ? { truncated: { lines: truncated } } : {}),
  };
}

// ---------------------------------------------------------------- 公开接口

/**
 * 报告里的 wanted.language。调用方给的原样给；从文字里认出的，只列「这种文字可能是哪些语言」里参考集有的那几个：
 * 拉丁字母可能是四十多种语言，整串放进每一句的报告里没有用，只会让报告胀大。一个都没有就是空数组（语言没匹配上，也会写在 missed 里）；
 * 认出的文字系统另外写在 wanted.script。
 */
function shownLanguage(language, candidates) {
  if (language === null || language.script === undefined) return language === null ? null : language.shown;
  const inReferenceSet = new Set(candidates.filter((candidate) => candidate.language !== null).map((candidate) => candidate.language.primary));
  return language.shown.filter((name) => inReferenceSet.has(primaryLanguage(name)));
}

/**
 * 给每一句台词挑一段参考。规则和比较的办法见文件头。
 * @param {object} env 注入的运行环境（只在要让 text-generation 判断时用到）
 * @param {object} manifest 角色部分的清单，或者至少带着 reference（和 holdout）的对象
 * @param {{ text?: string, labels?: { language?: string, emotion?: string, style?: string, energy?: 'low'|'medium'|'high' }, hints?: { emotion?: string, style?: string }, directions?: object[] }[]} lines
 *   台词。labels 是调用方给的标签；hints 是切开台词以后每一段生效的提示（配音流程给；不给就从 text 里读舞台提示）；directions 只是原样放进结果
 * @param {{ unrecognized?: 'keep'|'remove', judge?: boolean, maxPromptTokens?: number, lineNumbers?: number[], setup?: { labels?: { language?: string, emotion?: string, style?: string, energy?: 'low'|'medium'|'high' } } }} [options] unrecognized：括号里不是整个都认得的内容（词表里没有的，或者有词表里的词可是还有别的字）怎么处理，原样交给 lib/line-hints.mjs 的 readDirections（只有从 text 里读舞台提示时用到；
 *   台词自带 hints 的，text 已经切开，不起作用）。不给就是默认的 'keep'；配音明确给 'remove'。规则只在 lib/line-hints.mjs 的文件头写。
 *   judge：false 就不调 text-generation（它收费），要判断的台词落到默认参考，judge.status 是 'planned'。不给就是 true。
 *   maxPromptTokens：text-generation 一次请求最多收多少输入；给了就按它分批发（splitJudgeRequests），不给就一次发完。
 *   lineNumbers：judge 里提到台词时用的编号（readLineNumbers），不给就是台词的次序。
 *   setup：这一次用的一套设定里固定的标签（文件头「每一句要什么标签」的第 3 层，readSetup）；不给就没有这一层
 * @returns {Promise<{ picks: object[], judge: object }>}
 * @throws {VoicePackError} pick_input_invalid（options 不对时 details.field 是 options）、capability_result_invalid（text-generation 的返回不是 { text }）
 */
export async function pickReferences(env, manifest, lines, options) {
  const set = readReferenceSet(manifest);
  const input = readLines(lines);
  const settings = readOptions(options);
  const directionOptions = settings.directions;
  const setupLabels = readSetup(settings.setup);
  const plans = input.map((line) => wantedFor(line, directionOptions, setupLabels));
  const numbers = readLineNumbers(settings.lineNumbers, input.length);
  const judge = await runJudge(env, set, input, plans, directionOptions, settings.judge, settings.maxPromptTokens, numbers);
  const picks = plans.map((plan, index) => {
    const candidate = choose(set.candidates, plan.wanted);
    const { matched, missed } = explain(candidate, plan.wanted);
    return {
      index,
      segmentId: candidate.id,
      rule: plan.rule,
      wanted: { language: shownLanguage(plan.wanted.language, set.candidates), script: plan.wanted.language?.script ?? null, emotion: plan.wanted.emotion, style: plan.wanted.style, energy: plan.wanted.energy },
      sources: plan.sources,
      matched,
      missed,
      directions: plan.directions,
      ...(plan.judgeFailed === true ? { judgeFailed: true } : {}),
    };
  });
  return { picks, judge };
}
