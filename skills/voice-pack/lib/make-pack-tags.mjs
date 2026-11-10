// SPDX-License-Identifier: Apache-2.0
//
// 语言和音色基底标签（流程层，不花钱）：定每个能用的片段的语言；花钱之前查设定的默认参考（referenceTag）对不对得上；标完提示标注以后，给每段参考定音色基底标签
// （同一种语言里撞名的加序号）。每一项是谁定的也记下来，报告照写（lib/make-pack-report.mjs）。格式里这两个字段是什么，见 protocol/FORMAT.md 4.4。
//
// 语言（规矩只在这里写一遍）：
//   素材给的（段自己的 language 盖过输入的 language）> 转写报出来的 > 从文字本身认（lib/line-hints.mjs 的 detectLanguages；拉丁字母的文字认不出是哪种语言）。
//   认不出的这一段淘汰（language_unknown），在花钱挑默认段、标提示标注之前就淘汰。
//   来源（languageSource）：'material'（素材给的）、'previous'（上一版带来的段）、'transcription'、'text'（从文字认的）。
// 音色基底标签（只有参考段有；留出录音不带标签，没用上的段也不写）：
//   上一版带来的参考，是它在上一版里的标签；作者这次改了名的（input.retag，lib/make-pack-input.mjs），是改以后的标签。新段依次取：
//     1. 素材给的（段的 tag，读输入时去掉了两头空白；作者给的和库里给的不分，都是素材给的）；
//     2. 提示标注那一次调用顺带给的名字（modelTag，lib/make-pack-annotation.mjs；整理的规则在 lib/segment-annotation.mjs 的文件头）。不另调：
//        没标上提示标注（作废、重试用完、被拦下）、环境没有能听音频的模型、名字缺了或是空白、素材给了提示标注（这段不调模型），都没有这个名字；
//     3. 段的 id。
//   来源（tagSource）：'material'（素材给的；作者这次改的名也是）、'model'、'id'、'previous'。
//   撞名加序号（assignTags，在挑完参考集和留出录音、标完提示标注以后，只在参考集里做：当了留出录音的段不带标签，不占名字）：
//     有人给过的标签优先（素材给的、上一版的、作者这次改的名）：模型起的名字和段名兜底的名字，和这些撞了，不管谁在前，都由模型起名、段名兜底的那段加序号，
//     有人给过的标签不让号：设定的 referenceTag 是作者照自己给的标签写的，不能因为模型起了一样的名字，就悄悄指到另一段。别的撞名照下面的次序：
//     同一种语言（protocol/lib/manifest.mjs 的 languageKey：NFKC、小写、下划线当连字符）里，按参考集在清单里的次序，先出现的那段用原名，后面的加序号
//     （素材给的和素材给的、模型起名的和段名兜底的彼此之间都是这样）；
//     上一版带来的参考标签不改（它们排在清单前面），新加的和它撞了，新加的加序号；
//     作者这次改了名的上一版参考（几段改名先都算上再比，所以两段互换名字不撞）：和上一版没改名的撞了，改名的加序号；几段改成同一个名字，按次序后面的加序号；
//     和新加的撞了，新加的加序号。所以上一版带来的段（改名的算上）先定，加序号只看上一版带来的这几段的原名；新加的段后定，素材给了标签的先，模型起名的、段名兜底的最后；
//     上一版带来的段的标签只看上一版和这次的改名，花钱之前就定得下（carriedTags，发新版本比「变了什么」用它）；
//     序号取这种语言里还没有的最小整数，从 2 起，原名和序号之间一个半角空格（「愤怒 2」）。「还没有」是这种语言里既不是哪段参考的原名、也还没被别的段用上：
//     参考集里本来就有一段叫「愤怒 2」，撞名的「愤怒」就取「愤怒 3」；
//     长度按码点算，加上序号超过 REFERENCE_TAG_MAX（64）的，先截原名，截到加上序号正好 64。加了序号的段记下原名（renamedFrom：素材给的标签、模型给的名字或段名）。
//   标签逐字比，大小写不同就是两个（Angry 和 angry 不撞）；不同语言可以同一个标签。
// 分组用的原名（groupTagOf，挑留出录音和参考上限分组时用，规则在 lib/pack-material.mjs 的规则 3、4）：素材给的标签（加序号之前的原名），上一版带来的参考用它的标签；
//   模型给的名字、id 兜底的、上一版的留出录音没有标签，算「没有标签」（模型的名字在挑完参考集以后才有，不参与分组）。
// 设定的默认参考（referenceTag，protocol/FORMAT.md 4.4）：
//   花钱之前（assertReferenceTagsKnown）：这次的设定（给的，或者沿用上一版的）里写了 referenceTag 的，它必须是素材给的标签，或者上一版参考的标签（这次 drop 掉的不算）。
//     素材给的只算花钱之前没被筛掉的段（重复的、认不出格式的、解不了的不算），同作者点名的默认段的检查（lib/make-pack-pick.mjs）。只是某段的 id 不算，模型给的名字（花钱以后才有）不算。
//     作者改了名的上一版参考，认改以后的标签：设定引用的是旧名字，就对不上（要一起改）。
//   付费以后（assertReferenceTagsPlaced）：转写、合段以后，再在挑完参考集以后（标提示标注之前，不为做不成的包再花这份钱），设定引用的标签还得有一段
//     （例如带这个标签的段转写没成、被参考上限裁了，就没有了）：参考集里得有一段素材给的（或上一版的）标签是它。没有就停下，报是哪套设定、哪几段带着这个标签、它们怎么了。
//     参考集里有这样一段，定标签时它（几段都给了这个标签时是排在前面的那段，规矩见上）就叫这个名字：模型起名、段名兜底的段撞了它，让号的是它们。
//   被设定引用的标签在一种语言里只有一段时，这段不当留出录音、参考上限也不裁它（lib/pack-material.mjs 的选项 referencedTags）。
//
//   languageBeforeSpending(item)                 花钱之前就知道的语言（规划和花钱之前的检查用）：素材给的，或者有文本、不用转写的段从文字认出的（规则同上）；
//                                                要转写的段（转写可能报语言）、文字认不出的，是 null
//   resolveLanguages(items)                      定每一段的语言，认不出的淘汰
//   groupTagOf(item)                             分组用的原名（见上），没有标签是 undefined
//   referencedTagsOf(setups)                     设定里引用的标签（去重，按设定的次序）
//   assertReferenceTagsKnown(items, setups)      花钱之前查 referenceTag（见上）
//   assertReferenceTagsPlaced(items, setups, { referenceIds? })   付费以后查 referenceTag（见上）：不给 referenceIds 查的是还能用的段（转写、合段以后），
//                                                给了查的是参考集（挑完参考集以后）
//   assignTags(items, referenceIds)              给参考集里的每一段定音色基底标签（撞名加序号，见上）
//   carriedTags(items)                           上一版带来的参考这一版的标签（Map<段名, 标签>，改名的算上，撞名加序号同上）：不花钱，花钱之前就能算
//
// 读条目的：unused、givenLanguage、givenTag、modelTag、retagged、previous、text、transcribedLanguage、id；
// 写条目的：language（{ value, source }）；参考段的 tag（{ value, source, renamedFrom? }）。淘汰的写 unused: { reason: 'language_unknown', details: {} }。
//
// 抛出的错误：
//   make_pack_input_invalid  设定的 referenceTag 对不上（field 是 setups[<序号>].referenceTag，见上）
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { hasWords } from './make-pack-transcribe.mjs';
import { detectLanguages } from './line-hints.mjs';
import { isLanguageTag } from './language-tag.mjs';
import { invalid } from './make-pack-input.mjs';
import { REFERENCE_TAG_MAX } from './manifest-limits.mjs';
import { languageKey } from '../protocol/lib/manifest.mjs';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 语言：素材给的算「material」；上一版带过来的算「previous」（报告里分得清是谁定的）。 */
const givenSource = (item) => (item.previous === undefined ? 'material' : 'previous');

/** 语言：素材给的 > 转写报出来的 > 从文字本身认（认得出一种主语言才算）。 */
function languageOf(item) {
  if (item.givenLanguage) return { value: item.givenLanguage, source: givenSource(item) };
  if (item.transcribedLanguage && isLanguageTag(item.transcribedLanguage)) return { value: item.transcribedLanguage, source: 'transcription' };
  const detected = item.text === '' ? null : detectLanguages(item.text);
  if (detected !== null && (detected.script !== 'Latin') && detected.languages.length > 0) return { value: detected.languages[0], source: 'text' };
  return null;
}

/** 花钱之前就知道的语言（见文件头）：素材给的，或者不用转写的段从文字认出的；不知道是 null。 */
export function languageBeforeSpending(item) {
  if (item.givenLanguage) return item.givenLanguage;
  return hasWords(item.text) ? (languageOf(item)?.value ?? null) : null;
}

/**
 * 定每一段的语言：素材给的 > 转写报的 > 从文字本身认。认不出的这一段没用上（language_unknown）。
 */
export function resolveLanguages(items) {
  for (const item of items) {
    if (item.unused !== undefined) continue;
    const language = languageOf(item);
    if (language === null) item.unused = { reason: 'language_unknown', details: {} };
    else item.language = language;
  }
}

/** 分组用的原名：素材给的标签；上一版的参考是它的标签；模型给的名字、id 兜底的、上一版的留出录音是 undefined（「没有标签」）。 */
export const groupTagOf = (item) => (item.previous === 'holdout' ? undefined : item.givenTag);

/** 设定里引用的标签（写了 referenceTag 的），去重，按设定的次序。 */
export const referencedTagsOf = (setups) => [...new Set((setups ?? []).filter((setup) => isPlainObject(setup) && setup.referenceTag !== undefined).map((setup) => setup.referenceTag))];

/** 这次的设定里每一套写了 referenceTag 的：[{ index, name, tag }]。 */
const referencesOf = (setups) => (setups ?? []).flatMap((setup, index) => (isPlainObject(setup) && setup.referenceTag !== undefined ? [{ index, name: setup.name, tag: setup.referenceTag }] : []));

/** 标签列成给人看的样子：「平常」「愤怒」，没有就是「没有」。 */
const listed = (tags) => (tags.length === 0 ? '没有' : tags.map((tag) => `「${tag}」`).join(''));

/**
 * 花钱之前：设定的 referenceTag 必须是素材给的标签，或者上一版参考的标签（见文件头）。
 * @param {object[]} items 条目（筛过片段：重复的、认不出格式的、解不了的已经写了 unused）
 * @param {object[] | undefined} setups 这次的设定（给的，或者沿用上一版的）
 * @throws {VoicePackError} make_pack_input_invalid（field 是 setups[<序号>].referenceTag）
 */
export function assertReferenceTagsKnown(items, setups) {
  const known = [...new Set(items.filter((item) => item.unused === undefined && groupTagOf(item) !== undefined).map(groupTagOf))];
  for (const { index, name, tag } of referencesOf(setups)) {
    if (typeof tag === 'string' && known.includes(tag)) continue;
    throw invalid(`setups[${index}].referenceTag`, `设定 ${JSON.stringify(name)} 的默认参考 ${JSON.stringify(tag)} 不是素材给的音色基底标签，也不是上一版参考的标签（这次用得上的有：${listed(known)}；段的名字不算，去掉的段不算）`);
  }
}

/**
 * 付费以后：设定引用的标签还有没有一段（见文件头）。比的都是分组用的原名（素材给的、上一版的标签）：不给 referenceIds 查还能用的段，给了查参考集。
 * 对不上就停下，点名设定和带这个标签的段、它们怎么了。
 * @throws {VoicePackError} make_pack_input_invalid（field 是 setups[<序号>].referenceTag）
 */
export function assertReferenceTagsPlaced(items, setups, { referenceIds } = {}) {
  const inSet = referenceIds === undefined ? null : new Set(referenceIds);
  for (const { index, name, tag } of referencesOf(setups)) {
    const holders = items.filter((item) => groupTagOf(item) === tag);
    const placed = holders.some((item) => item.unused === undefined && (inSet === null || inSet.has(item.id)));
    if (placed) continue;
    const why = holders.map((item) => `${item.id}：${item.unused?.reason ?? '没进参考集'}`).join('、');
    throw invalid(`setups[${index}].referenceTag`, `设定 ${JSON.stringify(name)} 的默认参考 ${JSON.stringify(tag)} 这次没有一段参考带着它（带这个标签的段：${why || '没有'}），包里的设定就会指到不存在的参考，做包停下`);
  }
}

/** 一段参考加序号之前的原名：素材给的（上一版的）标签，再是模型给的名字，再是段的 id（见文件头）。 */
const nameOf = (item) => item.givenTag ?? item.modelTag ?? item.id;

/** 原名加序号：「愤怒 2」。加上序号超过 REFERENCE_TAG_MAX 个码点的，先截原名（按码点）。 */
function numbered(name, n) {
  const suffix = ` ${n}`;
  const room = REFERENCE_TAG_MAX - [...suffix].length;
  const points = [...name];
  return `${points.length > room ? points.slice(0, room).join('') : name}${suffix}`;
}

/** 新补的段的标签来源：素材给的、模型给的名字、段名（见文件头）。 */
const freshSource = (item) => (item.givenTag !== undefined ? 'material' : item.modelTag !== undefined ? 'model' : 'id');

/**
 * 一种语言里各段参考的标签（撞名加序号，规则见文件头）：members 是这种语言的参考，按清单里的次序（上一版带来的在前）。
 * 上一版带来的段先定：没改名的照旧，改了名的再按次序定，加序号只看上一版带来的这几段的原名；新补的段后定，加序号看这种语言里全部参考的原名：
 * 先定素材给了标签的，再定模型起名的和段名兜底的（这两种让号：和有人给过的标签撞了，不管谁在前，都是它们加序号）。各自按清单里的次序。
 * 所以上一版带来的段的标签只看上一版的段和这次的改名，花钱之前就定得下（carriedTags）。
 * @returns {Map<object, { value: string, source: string, renamedFrom?: string }>} 条目 -> 标签
 */
function tagsInLanguage(members) {
  const tags = new Map();
  const used = new Set();
  const place = (item, source, originals, { keep = false } = {}) => {
    const name = nameOf(item);
    if (keep || !used.has(name)) {
      // 上一版没改名的段标签不改；别的段原名还没被用上，就用原名
      used.add(name);
      tags.set(item, { value: name, source });
      return;
    }
    let n = 2;
    while (originals.has(numbered(name, n)) || used.has(numbered(name, n))) n += 1;
    const value = numbered(name, n);
    used.add(value);
    tags.set(item, { value, source, renamedFrom: name });
  };
  const carried = members.filter((item) => item.previous !== undefined);
  const carriedNames = new Set(carried.map(nameOf));
  for (const item of carried.filter((entry) => entry.retagged !== true)) place(item, 'previous', carriedNames, { keep: true });
  for (const item of carried.filter((entry) => entry.retagged === true)) place(item, 'material', carriedNames); // 作者这次改的名：来源算素材给的
  const allNames = new Set(members.map(nameOf)); // 这种语言里各段的原名：序号不取它们
  const fresh = members.filter((entry) => entry.previous === undefined);
  for (const item of fresh.filter((entry) => entry.givenTag !== undefined)) place(item, 'material', allNames);
  for (const item of fresh.filter((entry) => entry.givenTag === undefined)) place(item, freshSource(item), allNames); // 模型起的名字、段名：让号
  return tags;
}

/** 按语言分组（protocol/lib/manifest.mjs 的 languageKey），组里保持给的次序。 */
function byLanguage(entries, languageOfItem) {
  const groups = new Map();
  for (const item of entries) {
    const key = languageKey(languageOfItem(item));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()];
}

/**
 * 给参考集里的每一段定音色基底标签：撞名加序号（规则见文件头）。referenceIds 是参考集，按清单里的次序（上一版带来的在前）。
 * 写条目的 tag：{ value, source, renamedFrom? }。留出录音、没用上的段不写。
 */
export function assignTags(items, referenceIds) {
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const members of byLanguage(referenceIds.map((id) => byId.get(id)), (item) => item.language.value)) {
    for (const [item, tag] of tagsInLanguage(members)) item.tag = tag;
  }
}

/**
 * 上一版带来的参考这一版的标签（作者改的名算上，撞名加序号同 assignTags）：花钱之前就定得下（见 tagsInLanguage），发新版本比「变了什么」用它（lib/pack-version.mjs）。
 * 上一版的参考都留在参考集里（lib/pack-material.mjs 的规则 6），次序是条目的次序。
 * @returns {Map<string, string>} 段名 -> 标签
 */
export function carriedTags(items) {
  const carried = items.filter((item) => item.previous === 'reference');
  const tags = new Map();
  for (const members of byLanguage(carried, (item) => item.givenLanguage)) {
    for (const [item, tag] of tagsInLanguage(members)) tags.set(item.id, tag.value);
  }
  return tags;
}
