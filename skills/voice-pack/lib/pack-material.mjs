// SPDX-License-Identifier: Apache-2.0
//
// 挑素材（流程层，纯数据）：做包时，把已经筛过、打好标签的片段分成参考集、留出录音和没用上的，再挑出默认参考段。
// 不碰音频、不用模型，输入输出都是普通对象，
// 所以每一条规则都能拿数据直接测（lib/make-pack-pick.mjs 调它，流程在 lib/make-pack.mjs）。
//
//   chooseMaterial(candidates, options) -> { references, holdouts, unused, defaultSegment, defaultRule, typicality?, tied? }
//   defaultRule 写明默认段是按哪条规则挑的（规则 5）：'kept' | 'typical' | 'priority' | 'only'，没有参考时是 null。
//     'kept' 是沿用：上一版的默认段，或者作者明说的（lib/make-pack-pick.mjs 报告时分成 'previous' 和 'author'）。
//   options.similarities（可选）：{ [段名]: 数的数组 }，每段候选和其余参考的说话人相似度（只量参考之间的，留出录音一条都不算；由调用方量，见 lib/make-pack-pick.mjs）。
//
// 候选（candidates，每个是一个已经能用的片段：音质没被拒绝、有文本）：
//   { id, order, verdict: 'ok' | 'warn' | 'unchecked', durationSec: number | null, tokens: number, textChars: number, plain?: boolean, tags: { language, emotion?, style?, energy? } }
//   order 是它在输入里的次序（从 0 起，不重复）；tokens 是文本的词数（lib/fidelity.mjs 的 tokenizeTranscript：中文按字、英文按词）；
//   plain 是 false 表示文本里有台本标记或舞台提示（不给就当没有）；verdict 是音质检查的结论（unchecked：环境解不了这种格式，没量过，按 warn 看）。
//
// 规则（数值都是这份实现定的，不是实测的；改数值改 DEFAULTS 和 TYPICAL_TIE，别处不写数）：
//   1 优先级（越靠前越适合当参考）：音质结论（ok 在 warn 和 unchecked 前面）；时长离建议的参考段长度越近越好（建议的长度是音质检查的提醒线，
//     tools/audio-quality.mjs 的 REFERENCE_THRESHOLDS.duration 的 warnBelow 到 warnAbove；在区间里都算 0，区间外按差几秒算）；
//     最后看输入次序。同样的输入永远得到同样的结果，没有随机。
//   2 留出几条：不到 3 段可用时不留（参考集要有两段以上才像样，原声只有两段时都当参考）；否则 max(1, 四舍五入(总数 × holdoutRatio))，不超过
//     maxHoldout，也不超过总数减 1；holdoutRatio 是 0 就不留。新版本里，已有的留出录音算在里面：已经够了就不再留。
//   3 留出录音取哪几段：标签组 = 语言 + 情绪（没有情绪标签的算一组）。一段能当留出录音，要文本不少于 minHoldoutTokens 个词
//     （盲听的收音校验拿开头的 OPENING_WORDS 个词和已知文本的开头比；文本比这个数还短时，开头就是它的全部，短句错两个词错误率就超线，
//     见 lib/fidelity.mjs 的 openingErrorRate 和 DEFAULT_MAX_ERROR_RATE 的说明），
//     并且文本不超过 maxSynthesisChars 个字（给了才查：试合成一次装不下的，留出了也没法按原文合成）。
//     从最大的标签组开始，一组一组地轮着取，每组每一轮取一段，取这一组里优先级最低的那段能当留出录音的；一个组至少留一段做参考，
//     所以只剩一段的组不取。取够了或者所有的组都取不动了就停。
//     每个组都取不动、而一段都还没留出来时（标签打得碎，每个组都只有一段），放宽一次：只守「这种语言至少还留一段参考」，
//     从有两段以上的语言里取优先级最低的那段能当留出录音的（这时它的情绪可能一段参考也没有了：没有留出录音就量不了还原度，这个取舍偏向量得了）。
//     那一次放宽也找不到能当留出录音的，就不留：报告会提示没有留出录音（lib/material-hints.mjs 的 suggestMaterial）。
//   4 参考集：除了留出录音，剩下的都是参考；超过 maxReferences 段时，先保证每个标签组都有最好的一段，再按优先级补满，多出来的不要（over_limit）。
//     参考在清单里的次序：新做的包按优先级（好的在前，配音时同样合适的几段里取在前面的）；发新版本时，已有的在前、次序不变，新的接在后面。
//   5 默认参考段（「平常说话」，不带舞台提示的台词都用它）。候选：最常见的语言里（一样多取先出现的）、情绪是 calm 或没有标签、又没有风格标签的参考；
//     没有这样的，候选就是全部参考（defaultCandidatesOf）。发新版本时，上一版的默认段还在参考集里就沿用（'kept'）；作者明说的，也沿用（'kept'）。
//     候选只有一段：就是它（'only'）。候选有几段，而且调用方给了相似度（options.similarities）：挑平均相似度最高的一段，也就是和其余参考平均最像的一段（'typical'）；
//     和它相差不到 TYPICAL_TIE 的几段算差不多，在这几段里按优先级排第一的那段是默认段（tied 记下这几段）。
//     量不到的候选（一段相似度都没有）不参与；一段都量不到，或者没给相似度（环境没有说话人相似度），或者量的时候出错（调用方退回，见 lib/make-pack-pick.mjs）：按优先级排第一的那段（'priority'）。
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

export const DEFAULTS = Object.freeze({
  holdoutRatio: 0.2,
  maxHoldout: 6,
  maxReferences: 24,
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

/** 标签组的键：语言加情绪，没有情绪的算一组。 */
const groupKey = (candidate) => `${candidate.tags.language ?? 'und'}|${candidate.tags.emotion ?? ''}`;

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
    if (given(key) && !(Number.isInteger(options[key]) && options[key] >= 0)) add(key, '必须是不小于 0 的整数');
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
    if (candidate.tags === null || typeof candidate.tags !== 'object') throw new TypeError(`${at}.tags 必须是对象`);
  }
}

/** 这一段能不能当留出录音（规则 3）。plain 是 false 的（文本里有台本标记，配音时会被当成要求，念出来的和原话对不上）不行。 */
const canBeHoldout = (candidate, settings) =>
  candidate.plain !== false && candidate.tokens >= settings.minHoldoutTokens && (settings.maxSynthesisChars === undefined || settings.maxSynthesisChars === null || candidate.textChars <= settings.maxSynthesisChars);

/** 标签组：按组的大小从大到小，一样大的先出现的在前。每个组里的成员按优先级从好到坏排。 */
function groupsOf(ranked) {
  const groups = new Map();
  for (const candidate of ranked) {
    const key = groupKey(candidate);
    if (!groups.has(key)) groups.set(key, { key, members: [], first: candidate.order });
    const group = groups.get(key);
    group.members.push(candidate);
    group.first = Math.min(group.first, candidate.order);
  }
  return [...groups.values()].sort((a, b) => b.members.length - a.members.length || a.first - b.first);
}

/** 规则 3：从新的片段里挑出还要留出几条。返回挑中的 id 的集合。ranked 是全部候选，按优先级从好到坏。 */
function pickHoldouts(groups, ranked, { needed, isNew, settings, alreadyHeldOut }) {
  const taken = new Set();
  const heldOutIn = new Map(groups.map((group) => [group.key, group.members.filter((member) => alreadyHeldOut.has(member.id)).length]));
  const lowestEligible = (group) => [...group.members].reverse().find((member) => isNew(member) && !taken.has(member.id) && canBeHoldout(member, settings));
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
    for (const candidate of ranked) perLanguage.set(candidate.tags.language, (perLanguage.get(candidate.tags.language) ?? 0) + 1);
    const member = [...ranked].reverse().find((candidate) => isNew(candidate) && perLanguage.get(candidate.tags.language) >= 2 && canBeHoldout(candidate, settings));
    if (member !== undefined) taken.add(member.id);
  }
  return taken;
}

/** 规则 4：参考超过上限时，挑出保留哪些（fixedIds 是已有的参考，一定留）。返回保留的 id 的集合。 */
function capReferences(references, groups, { cap, fixedIds }) {
  const keep = new Set(fixedIds);
  let room = cap - keep.size;
  const isFree = (candidate) => !keep.has(candidate.id);
  const covered = new Set(references.filter((candidate) => keep.has(candidate.id)).map(groupKey));
  const inReferences = new Set(references.map((candidate) => candidate.id));
  for (const group of groups) {
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

/**
 * 规则 5 的候选：最常见的语言里（一样多取先出现的）、平静（或没有情绪标签）、又没有风格的参考；没有这样的，就是全部参考。
 * references 是候选对象，按次序；返回的是新的数组（调用方可以排它，不碰 references）。
 */
export function defaultCandidatesOf(references) {
  if (references.length === 0) return [];
  const languageOf = (candidate) => candidate.tags.language ?? 'und';
  const counts = new Map();
  for (const candidate of references) counts.set(languageOf(candidate), (counts.get(languageOf(candidate)) ?? 0) + 1);
  let dominant = null;
  for (const [language, count] of counts) if (dominant === null || count > dominant.count) dominant = { language, count };
  const plain = (candidate) => (candidate.tags.emotion === undefined || candidate.tags.emotion === 'calm') && candidate.tags.style === undefined;
  const plainInDominant = references.filter((candidate) => plain(candidate) && languageOf(candidate) === dominant.language);
  return plainInDominant.length > 0 ? plainInDominant : [...references];
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * 规则 5：默认参考段。references 是参考集的候选对象（按次序）；similarities 给了，就按平均相似度挑（见文件头）。
 * 返回 { defaultSegment, defaultRule, typicality?, tied? }：typicality 是量得到的每段候选的平均相似度，tied 是和最典型的那段差不多的几段（按优先级）。
 */
function chooseDefault(references, previousDefault, similarities) {
  if (references.length === 0) return { defaultSegment: null, defaultRule: null };
  if (previousDefault !== undefined && references.some((candidate) => candidate.id === previousDefault)) return { defaultSegment: previousDefault, defaultRule: 'kept' };
  const candidates = defaultCandidatesOf(references).sort(byPriority);
  if (candidates.length === 1) return { defaultSegment: candidates[0].id, defaultRule: 'only' };
  const measured = similarities === undefined ? [] : candidates.flatMap((candidate) => (similarities[candidate.id] === undefined || similarities[candidate.id].length === 0 ? [] : [{ candidate, mean: mean(similarities[candidate.id]) }]));
  if (measured.length === 0) return { defaultSegment: candidates[0].id, defaultRule: 'priority' };
  const best = Math.max(...measured.map((entry) => entry.mean));
  const tied = measured.filter((entry) => best - entry.mean < TYPICAL_TIE).map((entry) => entry.candidate); // 次序是优先级的次序：candidates 已经排好
  return {
    defaultSegment: tied[0].id,
    defaultRule: 'typical',
    typicality: Object.fromEntries(measured.map((entry) => [entry.candidate.id, entry.mean])),
    tied: tied.map((candidate) => candidate.id),
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
 *           fixed?: Record<string, 'reference' | 'holdout'>, defaultSegment?: string, similarities?: Record<string, number[]> }} [options]
 *   fixed：发新版本时，已有的片段保持原来的角色（id -> 角色）；defaultSegment：上一版的默认段（或作者明说的）；
 *   similarities：每段候选和其余参考的说话人相似度（段名 -> 数的数组，只量参考之间的）。它只影响默认段，参考和留出录音不因此改变
 * @returns {{ references: string[], holdouts: string[], unused: { id: string, reason: 'over_limit' }[], defaultSegment: string | null,
 *             defaultRule: 'kept' | 'only' | 'typical' | 'priority' | null, typicality?: Record<string, number>, tied?: string[] }}
 *   references 按清单里的次序；holdouts 按输入次序；unused 按输入次序；defaultRule 见文件头的规则 5（'kept' 是沿用上一版的，或者作者明说的）
 */
export function chooseMaterial(candidates, options = {}) {
  const settings = resolveOptions(options);
  readCandidates(candidates);
  if (settings.similarities !== undefined) readSimilarities(settings.similarities);
  const fixed = settings.fixed ?? {};
  const roleOf = (candidate) => fixed[candidate.id];
  const isNew = (candidate) => roleOf(candidate) === undefined;
  const ranked = [...candidates].sort(byPriority);
  const groups = groupsOf(ranked);
  const total = candidates.length;

  const wanted = plannedHoldouts(total, settings);
  const alreadyHeldOut = new Set(candidates.filter((candidate) => roleOf(candidate) === 'holdout').map((candidate) => candidate.id));
  const needed = Math.max(0, wanted - alreadyHeldOut.size);
  const newHoldouts = pickHoldouts(groups, ranked, { needed, isNew, settings, alreadyHeldOut });
  const holdoutIds = new Set([...alreadyHeldOut, ...newHoldouts]);

  const references = ranked.filter((candidate) => !holdoutIds.has(candidate.id));
  const fixedReferences = references.filter((candidate) => roleOf(candidate) === 'reference');
  const keep = references.length > settings.maxReferences ? capReferences(references, groups, { cap: settings.maxReferences, fixedIds: fixedReferences.map((candidate) => candidate.id) }) : new Set(references.map((candidate) => candidate.id));

  const kept = references.filter((candidate) => keep.has(candidate.id));
  // 次序：已有的在前（按它们在输入里的次序），新的接在后面（按优先级）
  const ordered = [...kept.filter((candidate) => !isNew(candidate)).sort((a, b) => a.order - b.order), ...kept.filter(isNew)];
  const byOrder = (a, b) => a.order - b.order;
  return {
    references: ordered.map((candidate) => candidate.id),
    holdouts: candidates.filter((candidate) => holdoutIds.has(candidate.id)).sort(byOrder).map((candidate) => candidate.id),
    unused: references.filter((candidate) => !keep.has(candidate.id)).sort(byOrder).map((candidate) => ({ id: candidate.id, reason: 'over_limit' })),
    ...chooseDefault(ordered, settings.defaultSegment, settings.similarities),
  };
}
