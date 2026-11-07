// SPDX-License-Identifier: Apache-2.0
//
// 挑素材（流程层，纯数据）：做包时，把已经筛过、定了语言的片段分成参考集、留出录音和没用上的，再挑出默认参考段。
// 不碰音频、不用模型，输入输出都是普通对象，
// 所以每一条规则都能拿数据直接测（lib/make-pack-pick.mjs 调它，流程在 lib/make-pack.mjs）。
//
//   chooseMaterial(candidates, options) -> { references, holdouts, unused, defaultSegment, defaultRule, defaultLanguage, typicality?, tied?, languageDefaults }
//   默认段每种语言一段（规则 5）：defaultSegment 是主语言的那段（defaultLanguage 是它的语言，写法同参考段的 language），defaultRule、typicality、tied 是它的；
//   languageDefaults 是别的语言各自的：[{ id, language, rule, typicality?, tied? }]，按语言在参考集里第一次出现的次序。
//   rule（defaultRule）写明这一段是按哪条规则挑的：'kept' | 'model' | 'typical' | 'priority' | 'only'，没有参考时 defaultRule 是 null。
//     'kept' 是沿用：点名的（options.defaultSegment、options.languageDefaults：作者明说的，或者上一版的，条件见规则 5；lib/make-pack-pick.mjs 报告时分成 'author' 和 'previous'）。
//   options.picked（可选）：能听音频的模型从候选里挑的段的段名，一个，或者每种语言一个的数组（由调用方问，见 lib/make-pack-pick.mjs 和 lib/default-pick.mjs）。
//   options.similarities（可选）：{ [段名]: 数的数组 }，每段候选和其余参考的说话人相似度（只量参考之间的，留出录音一条都不算；由调用方量，见 lib/make-pack-pick.mjs）。
//   options.mainLanguage（可选）：主语言（语言标签）：参考集里有这种语言的段，它就是主语言；没给或者没有这种语言的段，按规则 5 定。
//   options.referencedTags（可选）：设定的默认参考引用的音色基底标签（protocol/FORMAT.md 4.4 的 referenceTag），规则 3、4 照顾它们（见下）。
//
// 候选（candidates，每个是一个能用的片段：有文本；音质只有 verdict 里的提醒）：
//   { id, order, verdict: 'ok' | 'warn' | 'unchecked', durationSec: number | null, tokens: number, textChars: number, plain?: boolean, synthetic?: boolean, language: string, tag?: string }
//   order 是它在输入里的次序（从 0 起，不重复）；tokens 是文本的词数（lib/fidelity.mjs 的 tokenizeTranscript：中文按字、英文按词）；
//   plain 是 false 表示文本里有台本标记或舞台提示（不给就当没有）；synthetic 是 true 表示这段是合成的（例如库里拿干净参考重生成的），不是这个人录的（不给就是真录音）：
//     它只管留出录音（规则 2、3）；当参考、当默认段，合成的和真录音不分；
//   verdict 是音质检查的结论（unchecked：环境解不了这种格式，没量过，按 warn 看）。
//   language 是这段的语言（语言标签）；tag 是分组用的原名：素材给的音色基底标签（加序号之前的），上一版带来的参考是它的标签；
//     没有（不给）就是「没有标签」：模型给的名字、id 兜底的、上一版的留出录音（lib/make-pack-tags.mjs 的 groupTagOf）。
//
// 规则（数值都是这份实现定的，不是实测的；改数值改 DEFAULTS 和 TYPICAL_TIE，别处不写数）：
//   1 优先级（越靠前越适合当参考）：音质结论（ok 在 warn 和 unchecked 前面）；时长离建议的参考段长度越近越好（建议的长度是音质检查的提醒线，
//     tools/audio-quality.mjs 的 REFERENCE_THRESHOLDS.duration 的 warnBelow 到 warnAbove；在区间里都算 0，区间外按差几秒算）；
//     最后看输入次序。同样的输入永远得到同样的结果，没有随机。
//   2 留出几条：只数真录音（synthetic 不是 true 的段）。真录音不到 3 段时不留（参考集要有两段以上才像样，原声只有两段时都当参考）；否则
//     max(1, 四舍五入(真录音数 × holdoutRatio))，不超过 maxHoldout，也不超过真录音数减 1；holdoutRatio 是 0 就不留。
//     新版本里，已有的留出录音算在里面：已经够了就不再留。
//   3 留出录音取哪几段：标签组 = 语言（按 protocol/lib/manifest.mjs 的 languageKey 比）+ 原名（tag，逐字比）；没有标签的段，同一种语言里是一组。
//     一段能当留出录音，要文本不少于 minHoldoutTokens 个词
//     （盲听的收音校验拿开头的 OPENING_WORDS 个词和已知文本的开头比；文本比这个数还短时，开头就是它的全部，短句错两个词错误率就超线，
//     见 lib/fidelity.mjs 的 openingErrorRate 和 DEFAULT_MAX_ERROR_RATE 的说明），
//     并且文本不超过 maxSynthesisChars 个字（给了才查：试合成一次装不下的，留出了也没法按原文合成），并且是真录音（synthetic 不是 true：克隆出来的没有人的录音可以量）。
//     从最大的标签组开始，一组一组地轮着取，每组每一轮取一段，取这一组里优先级最低的那段能当留出录音的；一个组至少留一段做参考，
//     所以只剩一段的组不取。取够了或者所有的组都取不动了就停。
//     每个组都取不动、而一段都还没留出来时（标签给得碎，每个组都只有一段），放宽一次：只守「这种语言至少还留一段参考」，
//     从有两段以上的语言（按 languageKey 数）里取优先级最低的那段能当留出录音的（这时它的标签可能一段参考也没有了：没有留出录音就量不了还原度，这个取舍偏向量得了）。
//     那一次放宽也找不到能当留出录音的，就不留：报告会提示没有留出录音（lib/material-hints.mjs 的 suggestMaterial）。
//     点名的默认段（新补的，见规则 5）不取：它们要当默认参考段，轮到的时候跳过，取下一段。
//     被设定引用的标签（options.referencedTags）在一种语言里只有一段的，这段也不取（放宽的那一次也不取）：它当了留出录音，设定就指不到参考了。
//   4 参考集：除了留出录音，剩下的都是参考；超过 maxReferences 段时，先保证点名的默认段（新补的）和被设定引用、在这种语言里只有一段的段（同规则 3）留住，
//     再保证每个有原名的标签组（素材给的标签）都有最好的一段，再是没有标签的组，再按优先级补满，多出来的不要（over_limit）。没给 maxReferences 就不限（DEFAULTS.maxReferences 是 Infinity）。明说的段不因为音质是 warn 或者优先级靠后被裁掉；上一版的参考已经占满上限、它进不了参考集的，
//     在花钱之前就报（lib/make-pack-pick.mjs 的 assertDefaultsUsable）。
//     参考在清单里的次序：新做的包按优先级（好的在前，配音时同样合适的几段里取在前面的）；发新版本时，已有的在前、次序不变，新的接在后面。
//   5 默认段（调用方和设定都没指定参考时，配音用这句的语言的那段；卡片试听放主语言的那段的录音）：要的是这个角色自然说出来、带表演的一段。
//     参考集里有几种语言（语言按 protocol/lib/manifest.mjs 的 languageKey 比：zh-CN、zh-cn 是同一种，zh 和 zh-CN 不是），每种语言各挑一段，下面的规则对每种语言照做一遍。
//     标了 synthetic 的段（重生成的）和真录音不分，一样能当默认段。
//     主语言：options.mainLanguage 给了、参考集里也有这种语言的段（发新版本时是上一版的主语言），就是它；不然是参考集里段最多的语言（一样多取先出现的）。
//       主语言的那段写进清单的 reference.defaultSegment，别的语言的写进 reference.languageDefaults（protocol/FORMAT.md 4.4）。点名不定主语言。
//     候选：这种语言的全部参考，按优先级排（规则 1，好的在前；defaultCandidatesOf）。默认段的音色基底标签就是它自己那段的标签。
//     沿用（'kept'，报告里分成 'author' 和 'previous'）：点名的（options.defaultSegment、options.languageDefaults，先列的在前）里有这种语言的段，就是它：
//       作者这次明说的，照点名；上一版的默认段（主语言的和别的语言的）还在参考集里，就沿用。一种语言点了几段，取先列的那段（调用方把作者明说的列在上一版的前面）。
//     沿用的段在参考集里是规则 3、4 保证的（音质 warn 也照样当，音质结论照常写在报告里）。
//     候选只有一段：就是它（'only'）。候选有几段，而且调用方给了能听音频的模型挑的那段（options.picked，在这种语言的候选里）：就是它（'model'）。
//     不然，调用方给了相似度（options.similarities）：挑平均相似度最高的一段，也就是和其余参考平均最像的一段（'typical'）；
//     和它相差不到 TYPICAL_TIE 的几段算差不多，在这几段里按优先级排第一的那段是默认段（tied 记下这几段）。
//     量不到的候选（一段相似度都没有）不参与；一段都量不到，或者没给相似度（环境没有说话人相似度），或者量的时候出错（调用方退回，见 lib/make-pack-pick.mjs）：按优先级排第一的那段（'priority'）。
//     模型挑的和相似度，调用方只给一样：先问模型（每种语言一次），问不成（作废、没听成、出错）才量相似度（lib/make-pack-pick.mjs）。
//     相似度只用来比同一个人的几段录音谁更典型，不当成分数显示（同一人两段真录音的相似度，WeSpeaker 在 12 人、336 对上标定的：均值 0.746，标准差 0.083）；
//     留出录音从不参与，挑默认段不看它们（不然量还原度的那批数据就被用来挑参考了）。
//   6 发新版本时（options.fixed）：已有的参考和留出录音保持原来的角色，不会因为多了素材就从参考变成留出，也不会反过来；
//     新的片段补进来：先补足留出录音，剩下的当参考。
//
// 抛出的错误：TypeError（输入不是约定的形状，或者选项写错了：调用方的代码写错了）。选项对不对的规则是 materialOptionProblems，做包（lib/make-pack-input.mjs）在入口上
// 用它先查一遍，用户给的选项写错了报 make_pack_input_invalid，不等到这里抛 TypeError。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { REFERENCE_THRESHOLDS } from '../tools/audio-quality.mjs';
import { languageKey } from '../protocol/lib/manifest.mjs';

export const DEFAULTS = Object.freeze({
  holdoutRatio: 0.2,
  maxHoldout: 6,
  // 不设上限：参考段数只受格式写明的上限（protocol/FORMAT.md：reference.segments 最多 500 项），撞上时清单检查报错（组装时才查，见 make-pack-assemble.mjs），这里不裁。
  maxReferences: Infinity,
  minHoldoutTokens: 10,
});

/**
 * 挑最典型的默认参考段时，两段的平均相似度相差不到这个数（余弦），就算差不多：按优先级（音质、时长、次序）排。
 * 依据是处理误差：同一段录音，调响度之前和之后量出的平均相似度相差 0.0010 和 0.0022（两段，一个人：zh-0770，24 段参考，WeSpeaker，2026-10-23 量的；
 * 第一段 0.7871 → 0.7849，第二段 0.6864 → 0.6854）。0.01 约是这个误差的 5 倍：差得比它小的几段，名次由调响度的误差决定，算差不多。
 * 只在这一个人上量过，别的人的误差没有量；改它改这里。
 */
export const TYPICAL_TIE = 0.01;

/** 参考建议的时长（秒）：每段 5–20 秒。就是音质检查的提醒线（tools/audio-quality.mjs 的 REFERENCE_THRESHOLDS.duration），不另写一份。 */
const SWEET = Object.freeze({ min: REFERENCE_THRESHOLDS.duration.warnBelow, max: REFERENCE_THRESHOLDS.duration.warnAbove });
const VERDICT_RANK = Object.freeze({ ok: 0, warn: 1, unchecked: 1 });

const durationDistance = (seconds) => (seconds === null || seconds === undefined ? 0 : seconds < SWEET.min ? SWEET.min - seconds : seconds > SWEET.max ? seconds - SWEET.max : 0);

/** 比较两个候选的优先级：好的在前。 */
const byPriority = (a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] || durationDistance(a.durationSec) - durationDistance(b.durationSec) || a.order - b.order;

/** 标签组的键：规范化以后的语言加原名，没有标签的算一组（规则 3）。 */
const groupKey = (candidate) => JSON.stringify([keyOfLanguage(candidate), candidate.tag ?? null]);

/** 规则 2：一共 total 段可用时，最多留出几条（还要看有几段能当留出录音）。给 makePack 的规划用。 */
export function plannedHoldouts(total, options = {}) {
  const settings = resolveOptions(options);
  return total < 3 || settings.holdoutRatio === 0 ? 0 : Math.min(settings.maxHoldout, Math.max(1, Math.round(total * settings.holdoutRatio)), total - 1);
}

/**
 * 选项里不合约定的地方：[{ field, message }]，field 是选项的名字，没有问题就是空数组。undefined 等于没给。
 * 规则只在这里写一遍：chooseMaterial 和 plannedHoldouts 照它抛 TypeError（调用方的代码写错了）；
 * 做包（lib/make-pack-input.mjs）在花钱之前照它报 make_pack_input_invalid，点名是哪个选项。
 */
export function materialOptionProblems(options) {
  const problems = [];
  const given = (key) => options[key] !== undefined;
  const add = (field, message) => problems.push({ field, message });
  if (given('holdoutRatio') && !(typeof options.holdoutRatio === 'number' && options.holdoutRatio >= 0 && options.holdoutRatio <= 1)) add('holdoutRatio', '必须是 0 到 1 之间的数');
  for (const key of ['maxHoldout', 'maxReferences', 'minHoldoutTokens']) {
    // maxReferences 可以是 Infinity：不限，DEFAULTS 里就是它（做包时参考段数不设上限）
    const unlimited = key === 'maxReferences' && options[key] === Infinity;
    if (given(key) && !unlimited && !(Number.isInteger(options[key]) && options[key] >= 0)) add(key, '必须是不小于 0 的整数');
  }
  if (Number.isInteger(options.maxReferences) && options.maxReferences === 0) add('maxReferences', '必须不小于 1（参考集至少要有一段）');
  if (given('maxSynthesisChars') && options.maxSynthesisChars !== null && !(Number.isInteger(options.maxSynthesisChars) && options.maxSynthesisChars >= 1)) add('maxSynthesisChars', '必须是正整数（或 null：不限）');
  return problems;
}

function resolveOptions(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('options 必须是对象');
  const [problem] = materialOptionProblems(options);
  if (problem !== undefined) throw new TypeError(`${problem.field} ${problem.message}`);
  return { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) };
}

function readCandidates(candidates) {
  if (!Array.isArray(candidates)) throw new TypeError('candidates 必须是数组');
  const ids = new Set();
  for (const [index, candidate] of candidates.entries()) {
    const at = `candidates[${index}]`;
    if (candidate === null || typeof candidate !== 'object') throw new TypeError(`${at} 必须是对象`);
    if (typeof candidate.id !== 'string' || candidate.id === '') throw new TypeError(`${at}.id 必须是非空字符串`);
    if (ids.has(candidate.id)) throw new TypeError(`${at}.id「${candidate.id}」重复了`);
    ids.add(candidate.id);
    if (!(candidate.verdict in VERDICT_RANK)) throw new TypeError(`${at}.verdict 必须是 ok、warn、unchecked 之一`);
    if (!Number.isInteger(candidate.order)) throw new TypeError(`${at}.order 必须是整数`);
    if (typeof candidate.language !== 'string' || candidate.language === '') throw new TypeError(`${at}.language 必须是语言标签（非空字符串）`);
    if (candidate.tag !== undefined && (typeof candidate.tag !== 'string' || candidate.tag === '')) throw new TypeError(`${at}.tag 必须是非空字符串，或者不给（没有标签）`);
  }
}

/**
 * 这一段能不能当留出录音（规则 3）。plain 是 false 的（文本里有台本标记，配音时会被当成要求，念出来的和原话对不上）不行；
 * synthetic 是 true 的（克隆出来的，不是这个人录的）也不行：留出录音是拿来和这个人的真录音比的。
 */
const canBeHoldout = (candidate, settings) =>
  candidate.synthetic !== true && candidate.plain !== false && candidate.tokens >= settings.minHoldoutTokens && (settings.maxSynthesisChars === undefined || settings.maxSynthesisChars === null || candidate.textChars <= settings.maxSynthesisChars);

/** 标签组：按组的大小从大到小，一样大的先出现的在前。每个组里的成员按优先级从好到坏排。tagged 是这一组有没有原名（素材给的标签）。 */
function groupsOf(ranked) {
  const groups = new Map();
  for (const candidate of ranked) {
    const key = groupKey(candidate);
    if (!groups.has(key)) groups.set(key, { key, tagged: candidate.tag !== undefined, members: [], first: candidate.order });
    const group = groups.get(key);
    group.members.push(candidate);
    group.first = Math.min(group.first, candidate.order);
  }
  return [...groups.values()].sort((a, b) => b.members.length - a.members.length || a.first - b.first);
}

/** 规则 3：从新的片段里挑出还要留出几条。返回挑中的 id 的集合。ranked 是全部候选，按优先级从好到坏；named 是不挑的段（点名的默认段、被设定引用的独一段，id 的集合）。 */
function pickHoldouts(groups, ranked, { needed, isNew, settings, alreadyHeldOut, named }) {
  const taken = new Set();
  const heldOutIn = new Map(groups.map((group) => [group.key, group.members.filter((member) => alreadyHeldOut.has(member.id)).length]));
  const lowestEligible = (group) => [...group.members].reverse().find((member) => isNew(member) && !named.has(member.id) && !taken.has(member.id) && canBeHoldout(member, settings));
  while (taken.size < needed) {
    let progressed = false;
    for (const group of groups) {
      if (taken.size >= needed) break;
      if (group.members.length - heldOutIn.get(group.key) < 2) continue; // 一个组至少留一段做参考
      const member = lowestEligible(group);
      if (member === undefined) continue;
      taken.add(member.id);
      heldOutIn.set(group.key, heldOutIn.get(group.key) + 1);
      progressed = true;
    }
    if (!progressed) break;
  }
  // 放宽一次：一段都没留出来（标签组都只有一段）。只守「这种语言至少还留一段参考」
  if (taken.size === 0 && alreadyHeldOut.size === 0 && needed > 0) {
    const perLanguage = new Map();
    for (const candidate of ranked) perLanguage.set(keyOfLanguage(candidate), (perLanguage.get(keyOfLanguage(candidate)) ?? 0) + 1);
    const member = [...ranked].reverse().find((candidate) => isNew(candidate) && !named.has(candidate.id) && perLanguage.get(keyOfLanguage(candidate)) >= 2 && canBeHoldout(candidate, settings));
    if (member !== undefined) taken.add(member.id);
  }
  return taken;
}

/**
 * 规则 4：参考超过上限时，挑出保留哪些（fixedIds 是已有的参考，一定留；named 是点名的默认段（新补的）和被设定引用的独一段，id 的集合，排在别的前面留住，位子不够就留不住）。
 * 接着每个有原名的标签组留最好的一段，再是没有标签的组，再按优先级补满。返回保留的 id 的集合。
 */
function capReferences(references, groups, { cap, fixedIds, named }) {
  const keep = new Set(fixedIds);
  let room = cap - keep.size;
  const isFree = (candidate) => !keep.has(candidate.id);
  for (const namedCandidate of references.filter((candidate) => named.has(candidate.id) && isFree(candidate))) {
    if (room <= 0) break;
    keep.add(namedCandidate.id);
    room -= 1;
  }
  const covered = new Set(references.filter((candidate) => keep.has(candidate.id)).map(groupKey));
  const inReferences = new Set(references.map((candidate) => candidate.id));
  for (const group of [...groups.filter((entry) => entry.tagged), ...groups.filter((entry) => !entry.tagged)]) {
    if (room <= 0) break;
    if (covered.has(group.key)) continue;
    const best = group.members.find((member) => inReferences.has(member.id) && isFree(member));
    if (best !== undefined) {
      keep.add(best.id);
      covered.add(group.key);
      room -= 1;
    }
  }
  for (const candidate of references) {
    if (room <= 0) break;
    if (isFree(candidate)) {
      keep.add(candidate.id);
      room -= 1;
    }
  }
  return keep;
}

/** 一个候选的语言（规范化以后的写法，比较用）。 */
function keyOfLanguage(candidate) {
  return languageKey(candidate.language);
}

/**
 * 参考按语言分组（规则 5）：[{ key, language, members }]，key 是规范化以后的写法，language 是这种语言在参考集里第一次出现时的写法，members 按清单里的次序；
 * 组按语言在参考集里第一次出现的次序。
 */
function languageGroupsOf(references) {
  const groups = new Map();
  for (const candidate of references) {
    const key = keyOfLanguage(candidate);
    if (!groups.has(key)) groups.set(key, { key, language: candidate.language, members: [] });
    groups.get(key).members.push(candidate);
  }
  return [...groups.values()];
}

/** 主语言（规则 5）：mainLanguage 给了、参考集里有这种语言的段，就是它；不然是段最多的语言（一样多取先出现的）。groups 是 languageGroupsOf 的结果。 */
function mainGroupOf(groups, mainLanguage) {
  const wanted = mainLanguage === undefined ? undefined : groups.find((group) => group.key === languageKey(mainLanguage));
  if (wanted !== undefined) return wanted;
  let main = null;
  for (const group of groups) if (main === null || group.members.length > main.members.length) main = group;
  return main;
}

/**
 * 规则 5 的候选，每种语言一组：这种语言的全部参考。合成的和真录音不分。
 * references 是候选对象，按清单里的次序；返回 [{ language, candidates }]（language 是这种语言在参考集里第一次出现时的写法，candidates 是新的数组，按优先级排，好的在前），
 * 按语言在参考集里第一次出现的次序，不碰 references。
 */
export function defaultCandidatesOf(references) {
  return languageGroupsOf(references).map((group) => ({ language: group.language, candidates: [...group.members].sort(byPriority) }));
}

/**
 * 被设定引用、在一种语言里只有一段的候选（规则 3、4 照顾它们）：referencedTags 里的标签，按 规范化以后的语言 + 原名 数，这一组只有一段的，就是那一段。返回 id 的集合。
 */
function referencedSingles(candidates, referencedTags) {
  const counts = new Map();
  for (const candidate of candidates) if (candidate.tag !== undefined && referencedTags.includes(candidate.tag)) counts.set(groupKey(candidate), (counts.get(groupKey(candidate)) ?? 0) + 1);
  return new Set(candidates.filter((candidate) => counts.get(groupKey(candidate)) === 1).map((candidate) => candidate.id));
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * 规则 5：一种语言的默认段。members 是这种语言的参考（按次序）；pinned 是点名的（作者明说的或上一版的，在这种语言里的第一段），给了就是它；
 * picked（段名的数组）里有一段在候选里，就是它；不然 similarities 给了，就按平均相似度挑（见文件头）。
 * 返回 { id, rule, typicality?, tied? }：typicality 是量得到的每段候选的平均相似度，tied 是和最典型的那段差不多的几段（按优先级）。
 */
function chooseDefaultIn(members, { pinned, picked, similarities }) {
  if (pinned !== undefined) return { id: pinned, rule: 'kept' };
  const [{ candidates }] = defaultCandidatesOf(members);
  if (candidates.length === 1) return { id: candidates[0].id, rule: 'only' };
  const chosenByModel = candidates.find((candidate) => picked.includes(candidate.id));
  if (chosenByModel !== undefined) return { id: chosenByModel.id, rule: 'model' };
  const measured = similarities === undefined ? [] : candidates.flatMap((candidate) => (similarities[candidate.id] === undefined || similarities[candidate.id].length === 0 ? [] : [{ candidate, mean: mean(similarities[candidate.id]) }]));
  if (measured.length === 0) return { id: candidates[0].id, rule: 'priority' };
  const best = Math.max(...measured.map((entry) => entry.mean));
  const tied = measured.filter((entry) => best - entry.mean < TYPICAL_TIE).map((entry) => entry.candidate); // 次序是优先级的次序：candidates 已经排好
  return { id: tied[0].id, rule: 'typical', typicality: Object.fromEntries(measured.map((entry) => [entry.candidate.id, entry.mean])), tied: tied.map((candidate) => candidate.id) };
}

/**
 * 规则 5：每种语言的默认段。references 是参考集的候选对象（按次序）；pins 是点名的段名（作者明说的在前，上一版的在后）；picked 是模型挑的段名（数组）。
 * 返回 { defaultSegment, defaultRule, defaultLanguage, typicality?, tied?, languageDefaults }（见文件头）；没有参考时 defaultSegment、defaultRule、defaultLanguage 是 null，languageDefaults 是空数组。
 */
function chooseDefaults(references, { pins, picked, similarities, mainLanguage }) {
  if (references.length === 0) return { defaultSegment: null, defaultRule: null, defaultLanguage: null, languageDefaults: [] };
  const groups = languageGroupsOf(references);
  const main = mainGroupOf(groups, mainLanguage);
  const pinnedIn = (group) => pins.find((id) => group.members.some((candidate) => candidate.id === id));
  const chosen = new Map(groups.map((group) => [group, { language: group.language, ...chooseDefaultIn(group.members, { pinned: pinnedIn(group), picked, similarities }) }]));
  const { id, rule, language, ...measured } = chosen.get(main);
  return {
    defaultSegment: id,
    defaultRule: rule,
    defaultLanguage: language,
    ...measured,
    languageDefaults: groups.filter((group) => group !== main).map((group) => chosen.get(group)),
  };
}

/** options.similarities 的写法：{ 段名: 有限的数的数组 }。不合约定抛 TypeError（调用方的代码写错了）。 */
function readSimilarities(similarities) {
  if (similarities === null || typeof similarities !== 'object' || Array.isArray(similarities)) throw new TypeError('similarities 必须是对象：段名 -> 和其余参考的相似度（数的数组）');
  for (const [id, values] of Object.entries(similarities)) {
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) throw new TypeError(`similarities.${id} 必须是有限的数的数组`);
  }
}

/**
 * 挑素材。规则见文件头。
 * @param {object[]} candidates 可用的片段
 * @param {{ holdoutRatio?: number, maxHoldout?: number, maxReferences?: number, minHoldoutTokens?: number, maxSynthesisChars?: number | null,
 *           fixed?: Record<string, 'reference' | 'holdout'>, defaultSegment?: string, languageDefaults?: string[], mainLanguage?: string,
 *           picked?: string | string[], similarities?: Record<string, number[]>, referencedTags?: string[] }} [options]
 *   fixed：发新版本时，已有的片段保持原来的角色（id -> 角色）；defaultSegment、languageDefaults：点名的默认段（作者明说的，没说就是上一版的；沿用，规则 5），
 *   一种语言最多照一段（先列的算数：defaultSegment 在前）。点名的要是这次新补的（不在 fixed 里），规则 3、4 不挑它们做留出录音，参考上限也不裁它们
 *   （上一版的默认段本来就在 fixed 里，不受影响）；mainLanguage：主语言（规则 5）；
 *   picked：能听音频的模型挑的段名（一个，或者每种语言一个）；similarities：每段候选和其余参考的说话人相似度（段名 -> 数的数组，只量参考之间的）。这两项只影响默认段，参考和留出录音不因此改变；
 *   referencedTags：设定引用的音色基底标签（规则 3、4）
 * @returns {{ references: string[], holdouts: string[], unused: { id: string, reason: 'over_limit' }[], defaultSegment: string | null,
 *             defaultRule: 'kept' | 'only' | 'model' | 'typical' | 'priority' | null, defaultLanguage: string | null, typicality?: Record<string, number>, tied?: string[],
 *             languageDefaults: { id: string, language: string, rule: string, typicality?: Record<string, number>, tied?: string[] }[] }}
 *   references 按清单里的次序；holdouts 按输入次序；unused 按输入次序；defaultRule 和 languageDefaults 的 rule 见文件头的规则 5（'kept' 是沿用上一版的，或者作者明说的）
 */
export function chooseMaterial(candidates, options = {}) {
  const settings = resolveOptions(options);
  readCandidates(candidates);
  if (settings.similarities !== undefined) readSimilarities(settings.similarities);
  const picked = settings.picked === undefined ? [] : [settings.picked].flat();
  if (picked.some((id) => typeof id !== 'string')) throw new TypeError('picked 必须是段名（字符串），或者段名的数组');
  if (settings.defaultSegment !== undefined && typeof settings.defaultSegment !== 'string') throw new TypeError('defaultSegment 必须是段名（字符串）');
  const pins = [...(settings.defaultSegment === undefined ? [] : [settings.defaultSegment]), ...(settings.languageDefaults ?? [])];
  if (pins.some((id) => typeof id !== 'string')) throw new TypeError('languageDefaults 必须是段名的数组');
  if (settings.mainLanguage !== undefined && typeof settings.mainLanguage !== 'string') throw new TypeError('mainLanguage 必须是语言标签（字符串）');
  const referencedTags = settings.referencedTags ?? [];
  if (!Array.isArray(referencedTags) || referencedTags.some((tag) => typeof tag !== 'string')) throw new TypeError('referencedTags 必须是标签（字符串）的数组');
  const fixed = settings.fixed ?? {};
  const roleOf = (candidate) => fixed[candidate.id];
  const isNew = (candidate) => roleOf(candidate) === undefined;
  // 点名的默认段（要是这次新补的），和被设定引用、在这种语言里只有一段的段：不挑成留出录音，参考上限也不裁它们（规则 3、4）
  const singles = referencedSingles(candidates, referencedTags);
  const named = new Set(candidates.filter((candidate) => ((pins.includes(candidate.id) || singles.has(candidate.id)) && isNew(candidate))).map((candidate) => candidate.id));
  const ranked = [...candidates].sort(byPriority);
  const groups = groupsOf(ranked);
  const total = candidates.filter((candidate) => candidate.synthetic !== true).length; // 「够不够留出」只数真录音（规则 2）

  const wanted = plannedHoldouts(total, settings);
  const alreadyHeldOut = new Set(candidates.filter((candidate) => roleOf(candidate) === 'holdout').map((candidate) => candidate.id));
  const needed = Math.max(0, wanted - alreadyHeldOut.size);
  const newHoldouts = pickHoldouts(groups, ranked, { needed, isNew, settings, alreadyHeldOut, named });
  const holdoutIds = new Set([...alreadyHeldOut, ...newHoldouts]);

  const references = ranked.filter((candidate) => !holdoutIds.has(candidate.id));
  const fixedReferences = references.filter((candidate) => roleOf(candidate) === 'reference');
  const keep = references.length > settings.maxReferences ? capReferences(references, groups, { cap: settings.maxReferences, fixedIds: fixedReferences.map((candidate) => candidate.id), named }) : new Set(references.map((candidate) => candidate.id));

  const kept = references.filter((candidate) => keep.has(candidate.id));
  // 次序：已有的在前（按它们在输入里的次序），新的接在后面（按优先级）
  const ordered = [...kept.filter((candidate) => !isNew(candidate)).sort((a, b) => a.order - b.order), ...kept.filter(isNew)];
  const byOrder = (a, b) => a.order - b.order;
  return {
    references: ordered.map((candidate) => candidate.id),
    holdouts: candidates.filter((candidate) => holdoutIds.has(candidate.id)).sort(byOrder).map((candidate) => candidate.id),
    unused: references.filter((candidate) => !keep.has(candidate.id)).sort(byOrder).map((candidate) => ({ id: candidate.id, reason: 'over_limit' })),
    ...chooseDefaults(ordered, { pins, picked, similarities: settings.similarities, mainLanguage: settings.mainLanguage }),
  };
}
