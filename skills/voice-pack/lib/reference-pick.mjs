// SPDX-License-Identifier: Apache-2.0
//
// 挑参考（流程层）：每句话用参考集里的哪一段当参考。配音（lib/dub.mjs）和变声（lib/convert.mjs）调的是同一个函数。
//
// 输入输出都是普通数据：不碰 DOM、不碰文件系统，也不读音频（只看清单里参考段的语言和音色基底标签），不调任何能力。
//
// 用哪一段，按这个顺序取，取到就停（by 写着是哪一层）：
//   1 调用方指定的音色基底标签（选项 referenceTag，by 是 'reference-tag'）：用户换过的、agent 按标签挑的，都从这里进来；
//   2 这一次用的那套设定写的默认参考（选项 setup 的 referenceTag，by 是 'setup'；protocol/FORMAT.md 4.4）；
//   3 这一句的语言的默认段（by 是 'default'）。
// 这里自己不按标签挑，也不按每句的情绪、风格、能量挑，不让模型给每句判情绪：情绪写成台本里的提示，原样随文字交给模型（lib/dub.mjs 第 2 步）；
//   按音色基底标签挑是 agent 的事（它挑好了，从第 1 层交进来）。调用方和设定给的情绪、风格、能量不影响用哪一段（它们的写法照旧查，写错照样报 pick_input_invalid）。
//
// 这一句的语言：调用方给的（line.labels.language），没有就用设定的（选项 setup 的 labels.language：这一次用的一套设定，见 protocol/FORMAT.md 4.4；
//   配音时由 lib/dub.mjs 选好是哪一套再交过来），再没有就从文字本身认（lib/line-hints.mjs 的 detectLanguages；认语种时括号里的提示不算，
//   不然中文台词里一个英文提示，整句会被认成英文）。拉丁字母认不出是英语还是法语，给的是一组候选。文字里也看不出（只有数字和标点；变声没有台词）就是没有语言。
// 语言的比法：这一句的语言和段的语言按规范化以后的写法比（protocol/lib/manifest.mjs 的 languageKey：NFKC、小写、下划线当连字符）：先找完全一致的，
//   再找语言标签的主语言部分一致的（台词是 zh、段是 zh-CN；lib/line-hints.mjs 的 primaryLanguage）；几段都对上，取参考集里排在前面的。
//   从文字认出的语言是一组候选（拉丁字母是四十多种语言，汉字有 zh、yue……）：对上的几段里有主语言的那一段就用它，没有再取参考集里排在前面的。
// 包的主语言：主默认段（reference.defaultSegment）的语言。
//
// 定了标签（第 1、2 层）以后找段，在带这个标签的几段里找：
//   这一句的语言里有（比法同上）：用它，不算跨语言；
//   这种语言里没有：用包的主语言里这个标签的那段；主语言里也没有：用这个标签在参考集里排在最前的那段。后两种是跨语言克隆（crossLanguage 是 true）。
//   没有语言：用主语言里这个标签的那段，没有就用这个标签排在最前的那段；crossLanguage 是 false（没有语言就说不上跨语言）。
//   标签逐字比（大小写不同就是两个标签，不规范化）。指定的标签参考集里一段都没有，报 reference_tag_unknown（见下面「抛出的错误」）：一句台词都没有也报，不等用到。
// 没定标签（第 3 层）：用这一句的语言的默认段。
//   每种语言的默认段（protocol/FORMAT.md 4.4）：reference.defaultSegment 是主语言的默认段，reference.languageDefaults 是别的语言各自的默认段。
//     参考集里有、却没列默认段的语言（只有一段默认段的包：上一版带来的、别的程序写的），这种语言的默认段是参考集里这种语言排在最前的那一段。
//   比法同上。都对不上，才算包里没有这种语言：用主语言的默认段跨语言克隆（crossLanguage 是 true）。没有语言，也用主语言的默认段，crossLanguage 是 false。
// 每句话只用一段参考：结果里只有一个 segmentId，从不融合。留出录音从不当参考：只看 reference.segments；
// 清单里留出录音和参考共用 id 或音频文件，直接报错，不悄悄挑一个。标成合成的段（synthetic）和真录音的段一样挑、一样写：不另加原因或标记。
//
// 返回 { picks }：
//   picks[i]  { index, segmentId, tag, by, crossLanguage, language, directions }
//     tag         用的那一段的音色基底标签（默认段也写）
//     by          为什么是这一段：'reference-tag'（调用方指定的标签）、'setup'（设定写的默认参考）、'default'（这一句的语言的默认段，或者主语言的默认段）
//     crossLanguage  true：跨语言克隆，用的那一段不是这一句的语言（定了标签、这种语言里没有这个标签的段；或者没定标签、包里没有这种语言，用了主语言的默认段）；别的都是 false
//                 这里只管挑、只管标。配音默认不跨语言克隆：一行用的参考段不是这一行的语言，配音在花钱之前停下（lib/dub.mjs 第 3a 步，一行里夹着的几个字不算）
//     language    这一句按哪种语言挑的：{ wanted, source, script }，看不出语言是 null。
//                 wanted 是调用方（或设定）给的写法；从文字里认的，是这种文字可能的语言里参考集有的那几个（可能是空数组），不列整串（拉丁字母有四十多种语言）；
//                 source 是 'caller' | 'setup' | 'text'（从文字本身认的）；script 是从文字里认出的文字系统（Latin、Han、Japanese……），语言是给的就是 null
//     directions  台词里读到的舞台提示（只是原样记下，不影响挑参考）：给了 line.directions 就是它；没给就从 text 里读，这一段前面、同一行里还没挂到前一段上的
//                 （见 lib/line-hints.mjs 的文件头「段带的」）。选了 'remove' 时，认不出意思的也列着，recognized 为 false；默认的 'keep' 只列整个括号都认得的，
//                 和结构规则认出的「副词 + 地」，后者 recognized 为 false
//
// 另外导出 speaksLanguage(manifest, segmentId, language)：参考集里的这一段和一句的语言（picks[i].language）对不对得上，比法同上面（完全一致或主语言一致）；
//   一句看不出语言（null）算对得上。合并的一场里，一个说话人整场用一段参考，这一段和他哪一轮的语言对不上，他那一场就是跨语言的（lib/dub.mjs 的 sceneUnit）。
// 另外导出 defaultSegmentFor(manifest, language)：一句的语言（picks[i].language，看不出是 null）在这个包里用哪一段默认段，就是上面「没定标签」那一层的找法，返回段名；
//   看不出语言、包里没有这种语言，是主语言的默认段。做包比卡片那一句「这句话的语言的默认段」换没换（lib/make-pack-card-line.mjs）用它，找法只写在这里。
// 另外导出 pickSetupOf(setup)：清单里的一套设定（setups 里的一项）取出挑参考读的那几个键（{ labels, referenceTag? }，就是下面选项 setup 收的写法），
//   没有设定（null、undefined）是 undefined（选项 setup 给 undefined 就是没有这一层）。配音、变声都用它把设定交进来，设定多了挑参考要读的键，只改这里。
// 另外导出 refTextOf(segment)：挑中的参考段交给模型的参考文字（能力调用的 ref_text）：有提示标注（annotatedText）就是它，没有就是逐字稿 text。
//   配音的两种调用和变声都交它（lib/dub.mjs 第 7 步、lib/convert.mjs），规则只写在这里。
//
// 选项 options（第三个参数，都可选）：unrecognized，原样交给 readDirections（只有从 text 里读舞台提示时用到）；
//   referenceTag，调用方指定的音色基底标签（不空的字符串，第 1 层）；
//   setup，{ labels?: { language?, emotion?, style?, energy? }, referenceTag? }，这一次用的一套设定里固定的标签和默认参考（写法同清单里设定的 labels、referenceTag；
//   挑参考只看 labels.language 和 referenceTag）。写错（键拼错、值不对）抛 pick_input_invalid
//
// 抛出的错误（code 小写下划线，details 里放什么在抛出处写明）：
//   pick_input_invalid     输入不是约定的形状，或者清单自相矛盾。details.field 是出问题的字段（options 的写法不对时是 options）
//   reference_tag_unknown  指定的音色基底标签（选项 referenceTag，或者设定的 referenceTag）参考集里一段都没有。
//                          details: { referenceTag, pack: { id, name }（清单的 id、name）, tags }，tags 是参考集里每种语言有哪些标签
//                          （protocol/lib/manifest.mjs 的 referenceTagsByLanguage：语言按规范化以后归在一起，写这种语言第一次出现的写法；语言、标签都按参考集里的次序）
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { languageKey, referenceTagsByLanguage } from '../protocol/lib/manifest.mjs';
import { detectLanguages, primaryLanguage, readDirectionOptions, readDirections } from './line-hints.mjs';

const ENERGIES = ['low', 'medium', 'high'];
const LABEL_KEYS = ['language', 'emotion', 'style', 'energy'];
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** 音色基底标签的写法（调用方指定的、设定写的）：不空的字符串。逐字比，不去空白、不规范化。 */
const isTag = (value) => typeof value === 'string' && value !== '';

const invalid = (field, message) => new VoicePackError('pick_input_invalid', message, { details: { field } });

// ---------------------------------------------------------------- 输入检查

/** 一段参考的语言（段的 language，protocol/FORMAT.md 4.4），先规范化好：比较时不用再算。 */
const segmentLanguage = (segment) => ({ key: languageKey(segment.language), primary: primaryLanguage(segment.language) });

/**
 * 读参考集。返回 all（每一段 { id, order, isMain, language, tag }，按参考集里的次序）和每种语言的默认段 defaults（规则在文件头「没定标签」，同样的写法，按参考集里的次序）。
 * 主默认段之外，languageDefaults 列了的照列；参考集里有、却没列默认段的语言，取这种语言排在最前的那一段。
 */
function readReferenceSet(manifest) {
  if (!isPlainObject(manifest) || !isPlainObject(manifest.reference)) throw invalid('reference', '要给参考集：清单里的 reference（defaultSegment 和 segments）');
  const { defaultSegment, languageDefaults = [], segments } = manifest.reference;
  if (!Array.isArray(segments) || segments.length === 0) throw invalid('reference.segments', '参考集至少要有一段参考');
  segments.forEach((segment, index) => {
    if (!isPlainObject(segment) || typeof segment.id !== 'string' || typeof segment.language !== 'string') {
      throw invalid(`reference.segments[${index}]`, `参考段 ${index} 要有 id 和 language（协议 3.x 的写法；1.x、2.x 的包的语言写在 tags 里，这一版不读）`);
    }
  });
  if (!segments.some((segment) => segment.id === defaultSegment)) {
    throw invalid('reference.defaultSegment', `默认参考段 ${JSON.stringify(defaultSegment)} 不是参考集里的一段`);
  }
  if (!Array.isArray(languageDefaults)) throw invalid('reference.languageDefaults', 'languageDefaults 必须是参考段 id 的数组');
  for (const [index, id] of languageDefaults.entries()) {
    if (!segments.some((segment) => segment.id === id)) throw invalid(`reference.languageDefaults[${index}]`, `languageDefaults 里的 ${JSON.stringify(id)} 不是参考集里的一段`);
  }
  const holdout = manifest.holdout ?? [];
  if (!Array.isArray(holdout)) throw invalid('holdout', 'holdout 必须是数组');
  const taken = new Set(segments.flatMap((segment) => [`id:${segment.id}`, ...(typeof segment.audio === 'string' ? [`audio:${segment.audio}`] : [])]));
  for (const [index, recording] of holdout.entries()) {
    if (taken.has(`id:${recording?.id}`) || (typeof recording?.audio === 'string' && taken.has(`audio:${recording.audio}`))) {
      throw invalid('holdout', `留出录音 holdout[${index}]（${recording?.id}）和参考集共用 id 或音频文件：留出录音从不当参考，清单自相矛盾`);
    }
  }
  const all = segments.map((segment, order) => ({ id: segment.id, order, isMain: segment.id === defaultSegment, language: segmentLanguage(segment), tag: segment.tag }));
  // 列了默认段的语言：主默认段的，加 languageDefaults 的（清单检查保证一种语言最多一段；别的程序写坏了，先列的算数）
  const listed = new Map();
  for (const id of [defaultSegment, ...languageDefaults]) {
    const entry = all.find((candidate) => candidate.id === id);
    const key = entry.language?.key ?? null;
    if (!listed.has(key)) listed.set(key, entry);
  }
  // 没列默认段的语言：这种语言排在最前的那一段
  for (const entry of all) if (!listed.has(entry.language?.key ?? null)) listed.set(entry.language?.key ?? null, entry);
  return { all, defaults: [...listed.values()].sort((a, b) => a.order - b.order) };
}

/** 调用方（或设定）给的标签 { language?, emotion?, style?, energy? }：写法照旧查，挑参考只用 language。 */
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
    return { text: line.text ?? '', labels: readLabels(line.labels, `${at}.labels`), directions: line.directions };
  });
}

const OPTION_KEYS = ['unrecognized', 'setup', 'referenceTag'];

/**
 * 选项：setup（这一次用的一套设定，见 readSetup）、referenceTag（调用方指定的音色基底标签），其余原样交给读舞台提示的选项（lib/line-hints.mjs 的 readDirections 的第二个参数）。
 * 现在就检查，不等到某句台词用上它；写错了不悄悄当成默认值。
 * @returns {{ setup: unknown, referenceTag: string | undefined, directions: { unrecognized: 'keep'|'remove' } }}
 */
function readOptions(options) {
  let setup;
  let referenceTag;
  let rest = options;
  if (isPlainObject(options)) {
    const unknown = Object.keys(options).find((key) => !OPTION_KEYS.includes(key));
    if (unknown !== undefined) throw invalid('options', `options 不合约定：不认识的选项 ${JSON.stringify(unknown)}：只有 ${OPTION_KEYS.join('、')}`);
    ({ setup, referenceTag, ...rest } = options);
    if (referenceTag !== undefined && !isTag(referenceTag)) throw invalid('options', 'options 不合约定：referenceTag 必须是不空的字符串（调用方指定的音色基底标签），或者不给');
  }
  try {
    return { setup, referenceTag, directions: readDirectionOptions(rest) };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw invalid('options', `options 不合约定：${error.message}`);
  }
}

/**
 * 这一次用的一套设定（选项 setup）：{ labels?: { language?, emotion?, style?, energy? }, referenceTag? }，labels 的写法同台词的 labels，referenceTag 是设定写的默认参考（音色基底标签）。
 * 不给就没有设定这一层。设定的别的字段（语速、说明）不在这里：和挑参考无关，由 lib/dub.mjs 用。
 * @returns {{ labels: object, referenceTag: string | undefined }}
 */
function readSetup(raw) {
  if (raw === undefined) return { labels: {}, referenceTag: undefined };
  if (!isPlainObject(raw)) throw invalid('options', 'options 不合约定：setup 必须是对象：{ labels?: { language?, emotion?, style?, energy? }, referenceTag? }');
  const unknown = Object.keys(raw).find((key) => key !== 'labels' && key !== 'referenceTag');
  if (unknown !== undefined) throw invalid('options', `options 不合约定：setup 里不认识的键 ${JSON.stringify(unknown)}：只有 labels、referenceTag`);
  if (raw.referenceTag !== undefined && !isTag(raw.referenceTag)) throw invalid('options', 'options 不合约定：setup.referenceTag 必须是不空的字符串（设定写的默认参考），或者不给');
  return { labels: readLabels(raw.labels, 'options.setup.labels'), referenceTag: raw.referenceTag };
}

/** 指定的标签参考集里一段都没有：reference_tag_unknown，列出每种语言有哪些标签（写法见文件头）。 */
function tagUnknown(manifest, referenceTag) {
  const tags = referenceTagsByLanguage(manifest.reference.segments);
  const listed = tags.map((group) => `${group.language}：${group.tags.join('、')}`).join('；');
  return new VoicePackError('reference_tag_unknown', `包 ${manifest.name}（${manifest.id}）的参考集里没有音色基底标签 ${JSON.stringify(referenceTag)}：${listed === '' ? '这个包的参考段都没有标签' : `有 ${listed}`}（标签逐字比，大小写不同就是两个标签）`, {
    details: { referenceTag, pack: { id: manifest.id, name: manifest.name }, tags },
  });
}

// ---------------------------------------------------------------- 一句台词的语言

/**
 * 一句台词的语言：调用方 -> 设定 -> 文字（规则在文件头）。台词的 directions 给了，text 就是拿掉舞台提示以后要念的话；没给就从 text 里读舞台提示，括号里的不算。
 * @returns {{ language: { key: string|null, primaries: string[], shown: string|string[], source: string, script: string|null } | null, directions: object[] }}
 */
function languageOf(line, directionOptions, setupLabels) {
  const read = line.directions === undefined ? readDirections(line.text, directionOptions) : null;
  const directions = line.directions ?? read.directions;
  const given = line.labels.language !== undefined ? [line.labels.language, 'caller'] : setupLabels.language !== undefined ? [setupLabels.language, 'setup'] : null;
  if (given !== null) return { language: { key: languageKey(given[0]), primaries: [primaryLanguage(given[0])], shown: given[0], source: given[1], script: null }, directions };
  const detected = detectLanguages(read === null ? line.text : read.pieces.map((piece) => piece.text).join(' '));
  if (detected === null) return { language: null, directions };
  return { language: { key: null, primaries: detected.languages.map(primaryLanguage), shown: detected.languages, source: 'text', script: detected.script }, directions };
}

/** 一段参考和这一句的语言：2 完全一致，1 主语言一致，0 不一致（或者这一段没写语言）。 */
function languageScore(language, candidate) {
  if (candidate.language === null) return 0;
  if (language.key !== null && language.key === candidate.language.key) return 2;
  return language.primaries.includes(candidate.language.primary) ? 1 : 0;
}

/**
 * 在几段候选（按参考集里的次序）里找这一句的语言的那段（比法在文件头「语言的比法」）：完全一致的先，主语言一致的后；几段都对上，取参考集里排在前面的
 * （从文字认出的一组候选，对上的里有 preferred 就用它）。一段都对不上是 null。
 */
function inLanguage(candidates, language, preferred) {
  const best = Math.max(0, ...candidates.map((candidate) => languageScore(language, candidate)));
  if (best === 0) return null;
  const matched = candidates.filter((candidate) => languageScore(language, candidate) === best);
  if (language.source === 'text' && preferred !== undefined && matched.includes(preferred)) return preferred;
  return matched[0];
}

/**
 * 没定标签：这一句用哪一段默认段（规则在文件头「没定标签」）。defaults 是每种语言的默认段（readReferenceSet），按参考集里的次序。
 * @returns {{ candidate: object, crossLanguage: boolean }}
 */
function chooseDefault(defaults, language) {
  const main = defaults.find((candidate) => candidate.isMain);
  if (language === null) return { candidate: main, crossLanguage: false };
  const found = inLanguage(defaults, language, main);
  return found === null ? { candidate: main, crossLanguage: true } : { candidate: found, crossLanguage: false };
}

/**
 * 定了标签：这一句用这个标签的哪一段（规则在文件头「定了标签」）。all 是参考集的每一段（readReferenceSet），tag 是参考集里有的标签。
 * @returns {{ candidate: object, crossLanguage: boolean }}
 */
function chooseTagged(all, tag, language) {
  const tagged = all.filter((candidate) => candidate.tag === tag);
  const main = all.find((candidate) => candidate.isMain);
  const inMain = tagged.find((candidate) => candidate.language.key === main.language.key);
  const fallback = inMain ?? tagged[0]; // 这种语言里没有（或者没有语言）：主语言里的，再没有就是排在最前的
  if (language === null) return { candidate: fallback, crossLanguage: false };
  const found = inLanguage(tagged, language, inMain);
  return found === null ? { candidate: fallback, crossLanguage: true } : { candidate: found, crossLanguage: false };
}

/**
 * 报告里的 language.wanted。调用方给的原样给；从文字里认出的，只列「这种文字可能是哪些语言」里参考集有的那几个：
 * 拉丁字母可能是四十多种语言，整串放进每一句的报告里没有用，只会让报告胀大。一个都没有就是空数组；认出的文字系统另外写在 language.script。
 */
function shownLanguage(language, segments) {
  if (language.source !== 'text') return language.shown;
  const inReferenceSet = new Set(segments.filter((segment) => segment.language !== null).map((segment) => segment.language.primary));
  return language.shown.filter((name) => inReferenceSet.has(primaryLanguage(name)));
}

// ---------------------------------------------------------------- 公开接口

/**
 * 给每一句台词挑一段参考。规则见文件头。
 * @param {object} manifest 角色部分的清单，或者至少带着 reference（和 holdout）的对象；报 reference_tag_unknown 时用它的 id、name 点名是哪个包
 * @param {{ text?: string, labels?: { language?: string, emotion?: string, style?: string, energy?: 'low'|'medium'|'high' }, directions?: object[] }[]} lines
 *   台词。labels 是调用方给的标签（挑参考只看 language）；directions 是切开台词以后每一段读到的舞台提示（配音流程给，这时 text 已经是要念的话；不给就从 text 里读舞台提示）
 * @param {{ unrecognized?: 'keep'|'remove', referenceTag?: string, setup?: { labels?: { language?: string, emotion?: string, style?: string, energy?: 'low'|'medium'|'high' }, referenceTag?: string } }} [options]
 *   unrecognized：括号里不是整个都认得的内容（词表里没有的，或者有词表里的词可是还有别的字）怎么处理，原样交给 lib/line-hints.mjs 的 readDirections（只有从 text 里读舞台提示时用到）。
 *   不给就是默认的 'keep'；配音明确给 'remove'。规则只在 lib/line-hints.mjs 的文件头写。referenceTag：调用方指定的音色基底标签（第 1 层）；
 *   setup：这一次用的一套设定里固定的标签和默认参考（readSetup，挑参考只看 labels.language 和 referenceTag）；不给就没有这一层
 * @returns {{ picks: object[] }}
 * @throws {VoicePackError} pick_input_invalid（options 不对时 details.field 是 options）、reference_tag_unknown
 */
export function pickReferences(manifest, lines, options) {
  const { all, defaults } = readReferenceSet(manifest);
  const input = readLines(lines);
  const settings = readOptions(options);
  const setup = readSetup(settings.setup);
  // 第 1、2 层：调用方指定的标签，没有再看设定写的默认参考；都没有是 null（第 3 层，默认段）
  const wanted = settings.referenceTag !== undefined ? { tag: settings.referenceTag, by: 'reference-tag' } : setup.referenceTag !== undefined ? { tag: setup.referenceTag, by: 'setup' } : null;
  if (wanted !== null && !all.some((candidate) => candidate.tag === wanted.tag)) throw tagUnknown(manifest, wanted.tag);
  const picks = input.map((line, index) => {
    const { language, directions } = languageOf(line, settings.directions, setup.labels);
    const { candidate, crossLanguage } = wanted === null ? chooseDefault(defaults, language) : chooseTagged(all, wanted.tag, language);
    return {
      index,
      segmentId: candidate.id,
      tag: candidate.tag,
      by: wanted === null ? 'default' : wanted.by,
      crossLanguage,
      language: language === null ? null : { wanted: shownLanguage(language, all), source: language.source, script: language.script },
      directions,
    };
  });
  return { picks };
}

/**
 * 参考集里的一段（segmentId）和一句的语言（pickReferences 返回的 picks[i].language）对不对得上：完全一致或主语言一致（比法见文件头）。
 * 一句看不出语言（null）算对得上：没有语言就说不上跨语言。合并的一场里一个说话人整场用一段参考，lib/dub.mjs 用它看他哪一轮跨了语言。
 * @param {object} manifest 角色部分的清单
 * @param {string} segmentId 参考集里的一段
 * @param {{ wanted: string | string[], source: string } | null} language picks[i].language
 * @returns {boolean}
 * @throws {VoicePackError} pick_input_invalid（清单不对，或者 segmentId 不是参考集里的一段）
 */
export function speaksLanguage(manifest, segmentId, language) {
  const { all } = readReferenceSet(manifest);
  const segment = all.find((candidate) => candidate.id === segmentId);
  if (segment === undefined) throw invalid('segmentId', `${JSON.stringify(segmentId)} 不是参考集里的一段`);
  if (language === null) return true;
  return languageScore(languageOfPick(language), segment) > 0;
}

/**
 * 一句的语言在这个包里用哪一段默认段（文件头「没定标签」那一层的找法）：返回段名。看不出语言（null）、包里没有这种语言，是主语言的默认段。
 * @param {object} manifest 角色部分的清单
 * @param {{ wanted: string | string[], source: string } | null} language picks[i].language
 * @returns {string}
 * @throws {VoicePackError} pick_input_invalid（清单不对）
 */
export function defaultSegmentFor(manifest, language) {
  const { defaults } = readReferenceSet(manifest);
  return chooseDefault(defaults, language === null ? null : languageOfPick(language)).candidate.id;
}

/**
 * 清单里的一套设定取出挑参考读的键（文件头「另外导出 pickSetupOf」）：{ labels, referenceTag? }，就是 readSetup 收的写法；没有设定是 undefined。
 * @param {{ labels?: object, referenceTag?: string } | null | undefined} setup 清单 setups 里的一项
 * @returns {{ labels?: object, referenceTag?: string } | undefined}
 */
export function pickSetupOf(setup) {
  if (setup === null || setup === undefined) return undefined;
  return { labels: setup.labels, ...(setup.referenceTag === undefined ? {} : { referenceTag: setup.referenceTag }) };
}

/** 参考段交给模型的参考文字（ref_text，文件头「另外导出 refTextOf」）：有提示标注（annotatedText）就是它，没有就是逐字稿。 */
export const refTextOf = (segment) => segment.annotatedText ?? segment.text;

/** picks[i].language（报告里的写法）换回比语言用的写法（languageOf 返回的那种）：从文字认的是一组候选，给的是一种。 */
const languageOfPick = (language) => (language.source === 'text'
  ? { key: null, primaries: language.wanted.map(primaryLanguage), source: 'text' }
  : { key: languageKey(language.wanted), primaries: [primaryLanguage(language.wanted)], source: language.source });
