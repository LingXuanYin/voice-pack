// SPDX-License-Identifier: Apache-2.0
//
// 还原度报告写成给人看的文字：fidelity 命令和 make-pack 命令都用它（命令之间不互相引用，所以放在这里，见 cli/input.mjs 的文件头）。
// 读法的规则（判成同一人的比例分档、有效的不到 5 条不下结论、哪几个数不是分数、作废和没听成和量不到各算几条）只在 lib/fidelity-reading.mjs 的 readReport 里，
// 这里只管把它的返回值写成文字，不另写一份阈值；报告的形状和读法的说明在 lib/fidelity.mjs 的文件头「How to read this report」。app 有自己的显示，也从 readReport 来。
//
//   renderFidelityReport(report, { redone?, redoHint? })  → 文字（末尾带换行）
//     report     measureFidelity 的结果（lib/fidelity.mjs），或补做以后合并的结果（redoNotHeard）
//     redone     补做时给 { items, calls }：这次只重新量了上一次没听成的几项、调用几次；第一行会写出来
//     redoHint   「怎么补做」那一句的写法（没给就是 fidelity 命令自己的：量的时候加 --save-report）；make-pack 的说法不一样（它存的是评测集目录），由它传进来
//   fixed2(数)  两位小数，不是有限的数写成「—」
import { readReport } from '../lib/fidelity-reading.mjs';
import { UNMEASURABLE_LABEL } from '../lib/fidelity.mjs';

export const fixed2 = (value) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '—');

/** 「量不了」一项的写法：带上缺的能力。 */
const unmeasurableLine = (item) => `${UNMEASURABLE_LABEL}${item.capability ? ` (missing ${item.capability})` : ''}: ${item.message.replace(`${UNMEASURABLE_LABEL}: `, '')}`;

const ITEM_NAME = { 'blind-listening': 'blind listening', 'speaker-similarity': 'speaker similarity' };
/** 没听成的原因，给人看：有 HTTP 状态写状态；没有的是连接一类的错误（网络错误、超时）。 */
const reasonOf = (httpStatus) => (httpStatus === null ? 'no HTTP status (network error or timeout)' : `HTTP ${httpStatus}`);
/** 量不到的那一段录音，给人看：嵌不出声纹的是生成的录音，还是留出的真录音。 */
const WHICH_NAME = { generated: 'generated recording', holdout: 'held-out recording' };
/** 一组说话人相似度之外还有几条没量到：「另有 1 条没听成、2 条量不到」。没有就是空的。 */
const alsoNotMeasured = (one) => [one.notHeard > 0 ? `${one.notHeard} not heard` : null, one.noSpeech > 0 ? `${one.noSpeech} no speech` : null].filter((part) => part !== null);
/** 作废的盲听里，被模型的服务商拦下的几条（作废的一部分，另外说明，读法第 5 点）：「其中 1 条被模型的服务商拦下」。没有就是空串。 */
const blockedWords = (one) => (one.blocked > 0 ? `of which ${one.blocked} blocked by the model's provider` : '');
/** 「作废 2 条」，有被拦下的就接上「（其中 1 条被模型的服务商拦下）」。 */
const voidedWords = (one) => `${one.voided} voided${one.blocked > 0 ? ` (${blockedWords(one)})` : ''}`;

/**
 * 给人看的报告。make-pack 命令也用它显示还原度（redoHint：补做怎么做，那边的说法和这里的 --save-report 不一样）。
 * 读法的规则（分档、哪几个数不是分数、作废和没听成和量不到各算几条）都在 lib/fidelity-reading.mjs 的 readReport 里，这里只管怎么写成文字。
 */
export function renderFidelityReport(report, { redone = null, redoHint = null } = {}) {
  const view = readReport(report);
  const lines = [];
  if (redone !== null) lines.push(`Redo: this run measured again only the ${redone.items} ${redone.items === 1 ? 'item' : 'items'} not heard last time (${redone.calls} ${redone.calls === 1 ? 'call' : 'calls'}); ${view.notHeard.entries.length} still not heard`);
  lines.push(`Evaluation set: ${view.counts.references} reference ${view.counts.references === 1 ? 'segment' : 'segments'}, ${view.counts.holdouts} held-out ${view.counts.holdouts === 1 ? 'recording' : 'recordings'} (${view.counts.realRecordings} real ${view.counts.realRecordings === 1 ? 'recording' : 'recordings'} in all)`);
  const models = view.models.map(({ capability, model }) => `${capability} ${model}`);
  lines.push(`Models used for evaluation: ${models.length > 0 ? models.join('; ') : 'none reported'}`);

  lines.push('', view.designSource ? 'Speaker similarity (against the design-voice baseline)' : 'Speaker similarity (against the human baseline)');
  // 设计来源的包：基线是这个设计声音自己几次合成之间的，不是真人（lib/fidelity.mjs 文件头第 10 点）
  const baselineName = view.designSource ? 'design-voice baseline' : 'human baseline';
  if (view.designSource) lines.push('  The material has a design source: the baseline is how consistent the designed voice is across several of its own syntheses; the ratio is the consistency within the pack, not how much it sounds like a real person');
  if (view.baseline.status === 'measured') lines.push(`  ${baselineName}: ${fixed2(view.baseline.value)} (${view.baseline.pairs} ${view.baseline.pairs === 1 ? 'pair' : 'pairs'} of ${view.designSource ? 'syntheses' : 'real recordings'})`);
  else lines.push(`  ${baselineName}: ${unmeasurableLine(view.baseline)}`);
  if (view.baseline.excluded.length > 0) {
    lines.push(`  Real recordings not used (no speech a voiceprint can be taken from): ${view.baseline.excluded.map((entry) => `${entry.id} (${entry.role === 'holdout' ? 'held-out recording' : 'reference'})`).join(', ')}`);
  }
  const speaker = view.overall.speakerSimilarity;
  if (speaker.status === 'measured') {
    const also = alsoNotMeasured(speaker);
    lines.push(`  ${speaker.n} ${speaker.n === 1 ? 'recording' : 'recordings'}${also.length > 0 ? ` (plus ${also.join(', ')})` : ''}: mean similarity ${fixed2(speaker.meanSimilarity)}, ratio ${fixed2(speaker.ratio)} (generated recordings / ${baselineName})`);
  } else if (speaker.status === 'not_heard') {
    lines.push(speaker.noSpeech === 0 ? `  Overall: all not heard (${speaker.notHeard}), no ratio to report` : `  Overall: none measured (${alsoNotMeasured(speaker).join(', ')}), no ratio to report`);
  } else if (speaker.status === 'no_speech') {
    lines.push(`  Overall: all no speech (${speaker.noSpeech}), no ratio to report`);
  } else {
    lines.push(`  Overall: ${unmeasurableLine(speaker)}`);
  }
  for (const item of view.items) {
    const one = item.speakerSimilarity;
    if (one?.status === 'measured') lines.push(`    ${item.id}: similarity ${fixed2(one.similarity)}, ratio ${fixed2(one.ratio)}`);
    else if (one?.status === 'not_heard') lines.push(`    ${item.id}: not heard, ${reasonOf(one.httpStatus)}`);
    else if (one?.status === 'no_speech') lines.push(`    ${item.id}: no speech, nothing a voiceprint can be taken from in the ${WHICH_NAME[one.which]}`);
  }

  lines.push('', 'Blind listening');
  const blind = view.overall.blindListening;
  if (blind.status === 'measured') {
    lines.push(`  ${blind.trials} valid, ${voidedWords(blind)}${blind.notHeard > 0 ? `, ${blind.notHeard} not heard` : ''}; each trial is asked twice, ${blind.asks} asks in all`);
    lines.push(`  Judged the same person: ${blind.sameSpeaker.count}/${blind.sameSpeaker.of} = ${fixed2(blind.sameSpeaker.rate)} (${blind.trials} valid: ${blind.sameSpeaker.label})`);
    if (view.designSource) lines.push('  Design source: the proportion "judged the same person" is listed only as counts, the three-tier reading does not apply and it is not read as a conclusion (see item 10 in the header of lib/fidelity.mjs)');
    lines.push(`  The two asks agree (same answer after the order is swapped: both "same person" or both "not the same person"): ${blind.consistent.count}/${blind.consistent.of} = ${fixed2(blind.consistent.rate)} (not a score; how to read it: see 「How to read this report」 in the header of lib/fidelity.mjs)`);
  } else if (blind.status === 'voided') {
    lines.push(`  All voided (${blind.voided}${blind.blocked > 0 ? `, ${blockedWords(blind)}` : ''}), no proportion to report`);
  } else if (blind.status === 'not_heard') {
    lines.push(blind.voided === 0 ? `  All not heard (${blind.notHeard}), no proportion to report` : `  ${blind.notHeard} not heard, ${voidedWords(blind)}, no valid trial at all, so no proportion to report`);
  } else {
    lines.push(`  Overall: ${unmeasurableLine(blind)}`);
  }
  for (const item of view.items) {
    const one = item.blindListening;
    if (one?.status === 'measured') lines.push(`    ${item.id}: judged the same person ${one.sameSpeaker}/${one.asks}, the two asks agree: ${one.consistent ? 'yes' : 'no'}`);
    else if (one?.status === 'voided') lines.push(`    ${item.id}: voided (${one.error.code})`);
    else if (one?.status === 'not_heard') lines.push(`    ${item.id}: not heard, ${reasonOf(one.httpStatus)}`);
  }

  if (view.voided.length > 0) {
    lines.push('', `Voided blind listening (${view.voided.length} ${view.voided.length === 1 ? 'trial' : 'trials'}, not counted in the proportion)`);
    for (const item of view.voided) lines.push(`  ${item.id}: ${item.error.code}: ${item.error.message}`);
  }

  if (view.notHeard.entries.length > 0) {
    lines.push('', 'Not heard (not counted in any proportion)');
    for (const { item, count, of } of view.notHeard.byItem) lines.push(`  ${ITEM_NAME[item]}: ${count} of ${of} not heard, can be redone`);
    for (const entry of view.notHeard.entries) lines.push(`    ${entry.id}: ${ITEM_NAME[entry.item]}, ${reasonOf(entry.httpStatus)}, tried ${entry.attempts} ${entry.attempts === 1 ? 'time' : 'times'}`);
    const calls = Object.entries(view.redo.calls).map(([capability, count]) => `${capability}: ${count}`).join(', ');
    lines.push(`  A redo makes more calls (${calls}; ${view.redo.total} in all) and repeats only the items that were not heard.`);
    lines.push(redoHint ?? '  How to redo: add --save-report <file> when measuring to keep the JSON report (or use --json to keep the output), then run the same command again with --redo <that file>.');
  }

  if (view.noSpeech.length > 0) {
    lines.push('', 'No speech (not counted in any proportion, and cannot be redone: measuring the same recording again gives the same result)');
    lines.push(`  ${ITEM_NAME['speaker-similarity']}: ${view.noSpeech.length} of ${view.counts.holdouts} no speech`);
    for (const entry of view.noSpeech) lines.push(`    ${entry.id}: the ${WHICH_NAME[entry.which]} has no speech a voiceprint can be taken from (${entry.error.code}: ${entry.error.message})`);
  }

  if (view.differences.length > 0) {
    lines.push('', 'Differences as the model put them (verbatim)');
    // 早先存下的报告没有分开记哪里像（whereAlike 是 null），照实写成没分开记，原话照样在哪里不像那边
    lines.push(...view.differences.slice(0, 20).map((entry) => `  ${entry.id} ask ${entry.order}: where alike: ${entry.whereAlike ?? '(the old report did not record this separately)'}; where unlike: ${entry.whereUnlike ?? '(the old report did not record this separately)'}`));
    if (view.differences.length > 20) lines.push(`  (${view.differences.length - 20} more, use --json to see all)`);
  }

  if (view.groups.length > 0) {
    lines.push('', 'Grouped by reference set label');
    const width = Math.max(...view.groups.map((group) => `${group.key}=${group.value}`.length));
    for (const group of view.groups) {
      const one = group.speakerSimilarity;
      let ratio = `similarity ${UNMEASURABLE_LABEL}`;
      if (one.status === 'measured') {
        const also = alsoNotMeasured(one);
        ratio = `ratio ${fixed2(one.ratio)}${also.length > 0 ? ` (plus ${also.join(', ')})` : ''}`;
      } else if (one.status === 'not_heard') {
        ratio = one.noSpeech === 0 ? `similarity all not heard (${one.notHeard})` : `similarity none measured (${alsoNotMeasured(one).join(', ')})`;
      } else if (one.status === 'no_speech') {
        ratio = `similarity all no speech (${one.noSpeech})`;
      }
      const heard = group.blindListening;
      let sounds = `blind listening ${UNMEASURABLE_LABEL}`;
      if (heard.status === 'measured') {
        const counted = `${heard.trials} valid${heard.notHeard > 0 ? `, ${heard.notHeard} not heard` : ''}`;
        sounds = `judged the same person ${fixed2(heard.sameSpeaker.rate)} (${counted}: ${heard.sameSpeaker.label})`;
      } else if (heard.status === 'voided') {
        sounds = `blind listening all voided (${heard.voided}${heard.blocked > 0 ? `, ${blockedWords(heard)}` : ''})`;
      } else if (heard.status === 'not_heard') {
        sounds = `blind listening all not heard (${heard.notHeard})`;
      }
      lines.push(`  ${`${group.key}=${group.value}`.padEnd(width)}  ${group.holdouts} held-out, ${group.references} ${group.references === 1 ? 'reference' : 'references'}  ${ratio}; ${sounds}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
