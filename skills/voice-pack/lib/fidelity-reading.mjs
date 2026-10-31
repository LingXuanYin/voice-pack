// SPDX-License-Identifier: Apache-2.0
//
// 还原度报告的读法（流程层）：把 measureFidelity、redoNotHeard 出的报告变成「要显示什么」的结构。
// 读法的正本是 lib/fidelity.mjs 文件头「怎么读这份报告」（读法本身是文字，写在那一处）；这里是它的程序：分档、哪几个数不是分数、
// 作废、没听成和量不到各算几条，都在 readReport 里决定一次。命令行（cli/fidelity-report.mjs）和 app 都从它的返回值显示，
// 不各写一份阈值和规则。显示的措辞（中文句子、英文翻译、排版）是各自的事，这里只给数、档和说明的键。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { planRedo } from './fidelity.mjs';

/**
 * 读法第 1 点的数字：判成同一人的比例分三档，有效的不到 minTrials 条不下结论。
 * 数字和 lib/fidelity.mjs 文件头里写的一致。
 */
export const READING = Object.freeze({ minTrials: 5, same: 0.7, notSame: 0.3 });

/** 判成同一人的比例落在哪一档，每一档的名字（中文，命令行直接用；app 按档的键翻译）。 */
export const SAME_SPEAKER_TIERS = Object.freeze({
  not_enough: '条数不够，不下结论',
  same: '判成同一人',
  not_same: '判成不是同一人',
  unsure: '说不准',
  not_applicable: '三档读法不适用',
});

/**
 * 读法每一点的显示用语（中文）。键是稳定的，app 按键配英文（有一条测试核对键和 {…} 都对得上）；正文里的 {minTrials}、{same}、{notSame}
 * 是 READING 里的数，显示前用 fillReading 填，所以数字在代码里只有 READING 一处。
 * point 是这条对应 lib/fidelity.mjs 文件头「怎么读这份报告」的第几点（0 是开头那句「不设门槛」）；文件头的每一点至少有一条，
 * 这一点要保持：文件头加了一点，这里也要加。
 * 哪几条适用于一份报告，见 readReport 返回值里的 notes。
 */
export const READING_NOTES = Object.freeze({
  no_threshold: { point: 0, zh: '不设门槛：分数低的包照样能导出、能发布，分数不隐藏。下面的档只是读法，不挡任何事。' },
  same_speaker_tiers: {
    point: 1,
    zh: '「判成同一人」的比例，一组留出录音一起读：有效的不到 {minTrials} 条，只列比例和条数，不下结论；比例 ≥ {same} 读作「判成同一人」，≤ {notSame} 读作「判成不是同一人」，之间读作「说不准」。显示时带上次数和条数。',
  },
  same_speaker_meaning: { point: 1, zh: '「判成同一人」是「没发现不是本人」，不是「证明是本人」：声音很接近的两个人，模型也会判成同一人，说话人相似度也分不开。' },
  unsure: { point: 1, zh: '「说不准」不当成好，也不当成坏，和说话人相似度的比值、模型说出来的区别（原话）一起看。' },
  identified_not_score: { point: 2, zh: '认出合成的比例不是分数：标定里模型指对合成那一段的次数没有高于随机，所以 0.5 左右既可能是克隆得好，也可能只是模型分辨不出来，这个数分不开这两种。' },
  consistent_not_score: { point: 3, zh: '换序后指的还是同一段，只说明「认出合成的」那个数有多少是跟着声音答的、多少是跟着位置答的，不当分数读，低也不扣分。' },
  differences_verbatim: { point: 4, zh: '模型说出来的区别是原话，给人看，不计数、不打分；「合成感」「机械」这类词，模型对两段真录音也常写，不能当成被听出来的证据。' },
  voided_separate: { point: 5, zh: '作废的盲听（模型的转写和已知文本对不上，说明它没听到）单独报，不进以上任何比例。' },
  not_heard_separate: {
    point: 6,
    zh: '没听成（服务出错，根本没问成）和作废是两回事，单独报，都不进任何比例，也不算分数低；可以补做，补做之前先说清要调用几次。有效的不到 {minTrials} 条时，补做完再读。',
  },
  ratio_is_score: { point: 7, zh: '说话人相似度的比值本身就是分数，照数显示：1 表示和这个人自己的真录音之间一样像。' },
  two_methods: { point: 7, zh: '两种方法不合成一个总分；两个对不上时，两个都照实列出，不替人选一个。' },
  scope: { point: 8, zh: '适用范围：读法是用朗读语料、一个克隆模型（单段参考）和一个听者模型标定的；换了合成模型、听者或语料类型，要重新标定，这几条读法不能照搬。' },
  no_speech_separate: {
    point: 9,
    zh: '量不到：某一段录音里没有能嵌出声纹的语音。那一条的说话人相似度单独报，写明是生成的还是留出的那一段，不进比例；同一段录音再量还是一样，所以不能补做。别的条照常量。',
  },
  design_source: {
    point: 10,
    zh: '素材是设计来源的（设计出来的声音，没有真人录音）：基线是这个设计声音自己几次合成之间的一致程度，比值说的是包内一致的程度，不是像不像某个真人。「判成同一人」的比例照列次数和条数，三档读法不适用，不下结论。留出录音不到 {minTrials} 条时，提示再合成几句。',
  },
});

/** 把说明正文里的 {minTrials}、{same}、{notSame} 换成 READING 里的数。 */
export const fillReading = (text) => Object.entries(READING).reduce((out, [name, value]) => out.replaceAll(`{${name}}`, String(value)), text);

/**
 * 读法第 1 点：一组留出录音的「判成同一人的比例」读成哪一档。
 * 设计来源的包（读法第 10 点）不读成档：基线是设计声音自己的一致程度，不是像不像某个真人，三档对它不适用，档是 not_applicable，不下结论。
 * @param {{ trials: number, rate: number }} one trials 是有效的条数（不含作废的、没听成的），rate 是判成同一人的比例
 * @param {{ designSource?: boolean }} [options] designSource 是 true 时不分档
 * @returns {{ tier: 'not_enough' | 'same' | 'not_same' | 'unsure' | 'not_applicable', label: string, canConclude: boolean }}
 */
export function readSameSpeaker({ trials, rate }, { designSource = false } = {}) {
  if (trials < READING.minTrials) {
    const tier = 'not_enough';
    return { tier, label: SAME_SPEAKER_TIERS[tier], canConclude: false };
  }
  if (designSource) return { tier: 'not_applicable', label: SAME_SPEAKER_TIERS.not_applicable, canConclude: false };
  const tier = rate >= READING.same ? 'same' : rate <= READING.notSame ? 'not_same' : 'unsure';
  return { tier, label: SAME_SPEAKER_TIERS[tier], canConclude: true };
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * 一项「没量出来」的写法：状态、中文的名字（作废、没听成、量不到、量不了）、整类量不了时的原因（缺哪项能力、数据不够……）。
 * 量出来的（measured）没有 label。
 */
const headOf = ({ status, label, reason, capability, message }) => ({
  status,
  ...(label === undefined ? {} : { label }),
  ...(reason === undefined ? {} : { reason }),
  ...(capability === undefined ? {} : { capability }),
  ...(message === undefined ? {} : { message }),
});

/**
 * 一组（总体或某个标签取值）的盲听：有效、作废、没听成各几条，三个结果各是几次或几条。
 * 作废里被模型的服务商拦下的另外数（blocked，是 voided 的一部分；早先存下的报告没有这个数，按 0 算）。
 * 一条有效的都没有（全部作废、全部没听成、量不了）时没有比例可读，三个结果都是 null。
 *   sameSpeaker  判成同一人：读法第 1 点，读成一档（tier、label、canConclude）。这是盲听里唯一能读的
 *   identified   认出合成的：读法第 2 点，不是分数（isScore: false）
 *   consistent   换序后指的还是同一段：读法第 3 点，不是分数（isScore: false）
 */
function blindListeningView(blind, { designSource = false } = {}) {
  const head = headOf(blind);
  const none = { sameSpeaker: null, identified: null, consistent: null };
  if (blind.status === 'unmeasurable') return { ...head, ...none };
  const counts = { trials: blind.trials, voided: blind.voided, blocked: blind.blocked ?? 0, notHeard: blind.notHeard, asks: blind.asks };
  if (blind.status !== 'measured') return { ...head, ...counts, ...none };
  return {
    ...head,
    ...counts,
    sameSpeaker: { count: blind.sameSpeaker, of: blind.asks, rate: blind.sameSpeakerRate, ...readSameSpeaker({ trials: blind.trials, rate: blind.sameSpeakerRate }, { designSource }) },
    identified: { count: blind.identified, of: blind.asks, rate: blind.identifiedRate, isScore: false },
    consistent: { count: blind.consistent, of: blind.trials, rate: blind.consistentRate, isScore: false },
  };
}

/** 模型说出来的区别（读法第 4 点）：原话，按留出录音的先后、每条按问的先后，一个字不改。给人看，不计数、不打分。 */
const differencesOf = (items) =>
  items.flatMap((item) => (item.blindListening?.status === 'measured' ? item.blindListening.asks.map((ask) => ({ id: item.id, order: ask.order, text: ask.differences })) : []));

/**
 * 一组（总体或某个标签取值）的说话人相似度：量到几条、没听成几条、量不到几条，平均相似度和比值。
 * 比值只按量到的算，本身就是分数（读法第 7 点，isScore: true）。一条量到的都没有，不给平均和比值。
 */
function speakerSimilarityView(speaker) {
  const head = headOf(speaker);
  if (speaker.status === 'unmeasurable') return head;
  const counts = { n: speaker.n, notHeard: speaker.notHeard, noSpeech: speaker.noSpeech ?? 0 };
  if (speaker.status !== 'measured') return { ...head, ...counts };
  return { ...head, ...counts, meanSimilarity: speaker.meanSimilarity, ratio: speaker.ratio, isScore: true };
}

/** 真人基线：量出来的给数和用了几对真录音；没用上的真录音（excluded）原样带着；量不了的点名原因。 */
function baselineView(baseline) {
  const excluded = baseline.excluded ?? [];
  if (baseline.status !== 'measured') return { ...headOf(baseline), excluded };
  return { status: 'measured', value: baseline.value, pairs: Array.isArray(baseline.pairs) ? baseline.pairs.length : null, excluded };
}

const REQUIRED_PARTS = ['counts', 'models', 'baseline', 'overall'];

/** 核对要读的东西是 measureFidelity 出的报告的形状（只核对要用到的）。 */
function assertReport(report) {
  const fail = (field, message) => new VoicePackError('fidelity_input_invalid', message, { details: { field } });
  if (!isPlainObject(report)) throw fail('report', '要读的必须是 measureFidelity 出的报告对象');
  for (const key of REQUIRED_PARTS) {
    if (!isPlainObject(report[key])) throw fail(`report.${key}`, `要读的报告缺 ${key}：它是 measureFidelity 出的报告吗`);
  }
  for (const key of ['speakerSimilarity', 'blindListening']) {
    if (!isPlainObject(report.overall[key])) throw fail(`report.overall.${key}`, `要读的报告缺 overall.${key}`);
  }
  for (const key of ['groups', 'items']) {
    if (!Array.isArray(report[key])) throw fail(`report.${key}`, `要读的报告缺 ${key}：它是 measureFidelity 出的报告吗`);
  }
}

const groupView = (group, { designSource = false } = {}) => ({
  key: group.key,
  value: group.value,
  holdouts: group.holdouts,
  references: group.references,
  speakerSimilarity: speakerSimilarityView(group.speakerSimilarity),
  blindListening: blindListeningView(group.blindListening, { designSource }),
});

/** 一件出的事：错误码、原文。完整的（details）留在报告里。 */
const errorOf = (error) => ({ code: error.code, message: error.message });

/** 服务暂时出错的 HTTP 状态，没有的（连接断了、超时）是 null：显示时写「HTTP 502」或「没有 HTTP 状态（网络错误或超时）」。 */
const statusOf = (error) => (Number.isInteger(error.details?.status) ? error.details.status : null);

/** 一条留出录音的说话人相似度：量到了给相似度和比值；量不到写明哪一段嵌不出；没听成写明错误和试了几次。 */
function speakerItemView(one) {
  if (one === null || one === undefined) return null;
  if (one.status === 'measured') return { status: 'measured', similarity: one.similarity, ratio: one.ratio, isScore: true };
  if (one.status === 'no_speech') return { status: 'no_speech', label: one.label, which: one.which, error: errorOf(one.error) };
  return { status: 'not_heard', label: one.label, attempts: one.attempts, httpStatus: statusOf(one.error), error: errorOf(one.error) };
}

/** 一条留出录音的盲听：量到了给两次的结果（认出合成、判成同一人各几次，换序后指的还是不是同一段）；作废、没听成写明错误。 */
function blindItemView(one) {
  if (one === null || one === undefined) return null;
  if (one.status === 'measured') return { status: 'measured', asks: one.asks.length, identified: one.identified, sameSpeaker: one.sameSpeaker, consistent: one.consistent };
  if (one.status === 'voided') return { status: 'voided', label: one.label, error: errorOf(one.error) };
  return { status: 'not_heard', label: one.label, attempts: one.attempts, httpStatus: statusOf(one.error), error: errorOf(one.error) };
}

/**
 * 每一项的清单：作废的（读法第 5 点）、没听成的（第 6 点，可以补做）、量不到的（第 9 点，补做也没用），
 * 各自单独报，都不进任何比例。没听成的还分项写「6 条里几条」，和补做要调用几次（planRedo 算的）。
 */
function listsOf(report, items) {
  const voided = items.flatMap((item) => (item.blindListening?.status === 'voided' ? [{ id: item.id, item: 'blind-listening', error: errorOf(item.blindListening.error) }] : []));
  const entries = items.flatMap((item) =>
    [['speaker-similarity', item.speakerSimilarity], ['blind-listening', item.blindListening]]
      .filter(([, part]) => part?.status === 'not_heard')
      .map(([name, part]) => ({ id: item.id, item: name, attempts: part.attempts, httpStatus: statusOf(part.error), error: errorOf(part.error) })),
  );
  const byItem = ['blind-listening', 'speaker-similarity'].flatMap((name) => {
    const count = entries.filter((entry) => entry.item === name).length;
    return count === 0 ? [] : [{ item: name, count, of: report.counts.holdouts }];
  });
  const noSpeech = items.flatMap((item) => (item.speakerSimilarity?.status === 'no_speech' ? [{ id: item.id, item: 'speaker-similarity', which: item.speakerSimilarity.which, error: errorOf(item.speakerSimilarity.error) }] : []));
  return { voided, notHeard: { entries, byItem }, noSpeech, redo: planRedo(report) };
}

/**
 * 读法的每一条说明适用不适用于这份报告：量到了盲听才有「判成同一人」的档、两个不是分数的数；有说不准的组才要解释「说不准」；
 * 有模型说的区别、作废的、没听成的、量不到的才各要一条；量到了说话人相似度才要说比值是分数；不设门槛、两种方法不合成、适用范围总是要的。
 * 按 READING_NOTES 的先后（也就是文件头的先后）列全部，applies 说这份报告用不用得上。
 */
function notesOf({ overall, groups, baseline, differences, voided, notHeard, noSpeech, designSource }) {
  const blindViews = [overall, ...groups].map((one) => one.blindListening).filter((one) => one.status === 'measured');
  // 设计来源的包：三档读法（点 1 的三条说明）和「说不准」都不适用；点 10 适用
  const tiered = !designSource && blindViews.length > 0;
  const applies = {
    no_threshold: true,
    same_speaker_tiers: tiered,
    same_speaker_meaning: tiered,
    unsure: !designSource && blindViews.some((one) => one.sameSpeaker.tier === 'unsure'),
    identified_not_score: blindViews.length > 0,
    consistent_not_score: blindViews.length > 0,
    differences_verbatim: differences.length > 0,
    voided_separate: voided.length > 0,
    not_heard_separate: notHeard.entries.length > 0,
    ratio_is_score: overall.speakerSimilarity.status === 'measured',
    two_methods: true,
    scope: true,
    no_speech_separate: noSpeech.length > 0 || baseline.excluded.length > 0,
    design_source: designSource,
  };
  return Object.entries(READING_NOTES).map(([key, { point }]) => ({ key, point, applies: applies[key] === true }));
}

/**
 * 把一份还原度报告变成「要显示什么」的结构。只读，不改报告；返回值是纯数据，能存成 JSON。
 * @param {object} report measureFidelity 或 redoNotHeard 出的报告（存成 JSON 再读回来的也行）
 * @returns {object}
 * @throws {VoicePackError} fidelity_input_invalid：不是报告的形状。details.field（每一项的核对按 planRedo 的口径，字段名从 previous 起写）
 */
export function readReport(report) {
  assertReport(report);
  const items = report.items;
  const designSource = report.designSource === true;
  const view = {
    counts: report.counts,
    models: Object.entries(report.models).map(([capability, model]) => ({ capability, model })),
    baseline: baselineView(report.baseline),
    designSource,
    overall: { holdouts: report.overall.holdouts, speakerSimilarity: speakerSimilarityView(report.overall.speakerSimilarity), blindListening: blindListeningView(report.overall.blindListening, { designSource }) },
    groups: report.groups.map((group) => groupView(group, { designSource })),
    items: items.map((item) => ({ id: item.id, labels: item.labels, speakerSimilarity: speakerItemView(item.speakerSimilarity), blindListening: blindItemView(item.blindListening) })),
    differences: differencesOf(items),
    ...listsOf(report, items),
  };
  return { ...view, notes: notesOf(view) };
}
