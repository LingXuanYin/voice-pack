// SPDX-License-Identifier: Apache-2.0
//
// 还原度报告写成给人看的文字：fidelity 命令和 make-pack 命令都用它（命令之间不互相引用，所以放在这里，见 cli/input.mjs 的文件头）。
// 读法的规则（判成同一人的比例分档、有效的不到 5 条不下结论、哪几个数不是分数、作废和没听成和量不到各算几条）只在 lib/fidelity-reading.mjs 的 readReport 里，
// 这里只管把它的返回值写成文字，不另写一份阈值；报告的形状和读法的说明在 lib/fidelity.mjs 的文件头「怎么读这份报告」。app 有自己的显示，也从 readReport 来。
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
const unmeasurableLine = (item) => `${UNMEASURABLE_LABEL}${item.capability ? `（缺 ${item.capability}）` : ''}：${item.message.replace(`${UNMEASURABLE_LABEL}：`, '')}`;

const ITEM_NAME = { 'blind-listening': '盲听', 'speaker-similarity': '说话人相似度' };
/** 没听成的原因，给人看：有 HTTP 状态写状态；没有的是连接一类的错误（网络错误、超时）。 */
const reasonOf = (httpStatus) => (httpStatus === null ? '没有 HTTP 状态（网络错误或超时）' : `HTTP ${httpStatus}`);
/** 量不到的那一段录音，给人看：嵌不出声纹的是生成的录音，还是留出的真录音。 */
const WHICH_NAME = { generated: '生成的录音', holdout: '留出的录音' };
/** 一组说话人相似度之外还有几条没量到：「另有 1 条没听成、2 条量不到」。没有就是空的。 */
const alsoNotMeasured = (one) => [one.notHeard > 0 ? `${one.notHeard} 条没听成` : null, one.noSpeech > 0 ? `${one.noSpeech} 条量不到` : null].filter((part) => part !== null);
/** 作废的盲听里，被模型的服务商拦下的几条（作废的一部分，另外说明，读法第 5 点）：「其中 1 条被模型的服务商拦下」。没有就是空串。 */
const blockedWords = (one) => (one.blocked > 0 ? `其中 ${one.blocked} 条被模型的服务商拦下` : '');
/** 「作废 2 条」，有被拦下的就接上「（其中 1 条被模型的服务商拦下）」。 */
const voidedWords = (one) => `作废 ${one.voided} 条${one.blocked > 0 ? `（${blockedWords(one)}）` : ''}`;

/**
 * 给人看的报告。make-pack 命令也用它显示还原度（redoHint：补做怎么做，那边的说法和这里的 --save-report 不一样）。
 * 读法的规则（分档、哪几个数不是分数、作废和没听成和量不到各算几条）都在 lib/fidelity-reading.mjs 的 readReport 里，这里只管怎么写成文字。
 */
export function renderFidelityReport(report, { redone = null, redoHint = null } = {}) {
  const view = readReport(report);
  const lines = [];
  if (redone !== null) lines.push(`补做：这次只重新量了上一次没听成的 ${redone.items} 项（调用 ${redone.calls} 次），现在还剩 ${view.notHeard.entries.length} 项没听成`);
  lines.push(`评测集：参考 ${view.counts.references} 段，留出录音 ${view.counts.holdouts} 条（真录音共 ${view.counts.realRecordings} 段）`);
  const models = view.models.map(({ capability, model }) => `${capability} ${model}`);
  lines.push(`评测用的模型：${models.length > 0 ? models.join('；') : '没有取到'}`);

  lines.push('', view.designSource ? '说话人相似度（跟设计声音的基线比）' : '说话人相似度（跟真人基线比）');
  // 设计来源的包：基线是这个设计声音自己几次合成之间的，不是真人（lib/fidelity.mjs 文件头第 10 点）
  const baselineName = view.designSource ? '设计声音的基线' : '真人基线';
  if (view.designSource) lines.push('  素材是设计来源：基线是这个设计声音自己几次合成之间的一致程度，比值是包内一致的程度，不是像不像某个真人');
  if (view.baseline.status === 'measured') lines.push(`  ${baselineName}：${fixed2(view.baseline.value)}（${view.baseline.pairs} 对${view.designSource ? '合成' : '真录音'}）`);
  else lines.push(`  ${baselineName}：${unmeasurableLine(view.baseline)}`);
  if (view.baseline.excluded.length > 0) {
    lines.push(`  没用上的真录音（里面没有能嵌声纹的语音）：${view.baseline.excluded.map((entry) => `${entry.id}（${entry.role === 'holdout' ? '留出录音' : '参考'}）`).join('、')}`);
  }
  const speaker = view.overall.speakerSimilarity;
  if (speaker.status === 'measured') {
    const also = alsoNotMeasured(speaker);
    lines.push(`  ${speaker.n} 条${also.length > 0 ? `（另有 ${also.join('、')}）` : ''}：平均相似度 ${fixed2(speaker.meanSimilarity)}，比值 ${fixed2(speaker.ratio)}（生成的录音 / ${baselineName}）`);
  } else if (speaker.status === 'not_heard') {
    lines.push(speaker.noSpeech === 0 ? `  总体：全部没听成（${speaker.notHeard} 条），没有比值可报` : `  总体：一条也没量到（${alsoNotMeasured(speaker).join('，')}），没有比值可报`);
  } else if (speaker.status === 'no_speech') {
    lines.push(`  总体：全部量不到（${speaker.noSpeech} 条），没有比值可报`);
  } else {
    lines.push(`  总体：${unmeasurableLine(speaker)}`);
  }
  for (const item of view.items) {
    const one = item.speakerSimilarity;
    if (one?.status === 'measured') lines.push(`    ${item.id}：相似度 ${fixed2(one.similarity)}，比值 ${fixed2(one.ratio)}`);
    else if (one?.status === 'not_heard') lines.push(`    ${item.id}：没听成，${reasonOf(one.httpStatus)}`);
    else if (one?.status === 'no_speech') lines.push(`    ${item.id}：量不到，${WHICH_NAME[one.which]}里没有能嵌声纹的语音`);
  }

  lines.push('', '盲听');
  const blind = view.overall.blindListening;
  if (blind.status === 'measured') {
    lines.push(`  有效 ${blind.trials} 条，${voidedWords(blind)}${blind.notHeard > 0 ? `，没听成 ${blind.notHeard} 条` : ''}；每条问两遍，共 ${blind.asks} 次`);
    lines.push(`  认出合成的那一段：${blind.identified.count}/${blind.identified.of} = ${fixed2(blind.identified.rate)}${blind.identified.isScore ? '' : '（不是分数，怎么读见 lib/fidelity.mjs 文件头「怎么读这份报告」）'}`);
    lines.push(`  判成同一个人：${blind.sameSpeaker.count}/${blind.sameSpeaker.of} = ${fixed2(blind.sameSpeaker.rate)}（${blind.trials} 条有效：${blind.sameSpeaker.label}）`);
    if (view.designSource) lines.push('  设计来源：「判成同一个人」的比例只列次数和条数，三档读法不适用，不读成结论（见 lib/fidelity.mjs 文件头第 10 点）');
    lines.push(`  换序后指的还是同一段：${blind.consistent.count}/${blind.consistent.of} = ${fixed2(blind.consistent.rate)}`);
  } else if (blind.status === 'voided') {
    lines.push(`  全部作废（${blind.voided} 条${blind.blocked > 0 ? `，${blockedWords(blind)}` : ''}），没有比例可报`);
  } else if (blind.status === 'not_heard') {
    lines.push(blind.voided === 0 ? `  全部没听成（${blind.notHeard} 条），没有比例可报` : `  没听成 ${blind.notHeard} 条，${voidedWords(blind)}，一条有效的都没有，没有比例可报`);
  } else {
    lines.push(`  总体：${unmeasurableLine(blind)}`);
  }
  for (const item of view.items) {
    const one = item.blindListening;
    if (one?.status === 'measured') lines.push(`    ${item.id}：认出 ${one.identified}/${one.asks}，判成同一人 ${one.sameSpeaker}/${one.asks}，换序后指的是同一段：${one.consistent ? '是' : '否'}`);
    else if (one?.status === 'voided') lines.push(`    ${item.id}：作废（${one.error.code}）`);
    else if (one?.status === 'not_heard') lines.push(`    ${item.id}：没听成，${reasonOf(one.httpStatus)}`);
  }

  if (view.voided.length > 0) {
    lines.push('', `作废的盲听（${view.voided.length} 条，不计入比例）`);
    for (const item of view.voided) lines.push(`  ${item.id}：${item.error.code}：${item.error.message}`);
  }

  if (view.notHeard.entries.length > 0) {
    lines.push('', '没听成（不进任何比例）');
    for (const { item, count, of } of view.notHeard.byItem) lines.push(`  ${ITEM_NAME[item]}：${of} 条里 ${count} 条没听成，可以补做`);
    for (const entry of view.notHeard.entries) lines.push(`    ${entry.id}：${ITEM_NAME[entry.item]}，${reasonOf(entry.httpStatus)}，试了 ${entry.attempts} 次`);
    const calls = Object.entries(view.redo.calls).map(([capability, count]) => `${capability} ${count} 次`).join('、');
    lines.push(`  补做会再调用 ${calls}（共 ${view.redo.total} 次），只重新调用没听成的这几项。`);
    lines.push(redoHint ?? '  怎么补做：量的时候加 --save-report <文件> 存下 JSON 报告（或者用 --json 存输出），之后同一个命令再加 --redo <那个文件>。');
  }

  if (view.noSpeech.length > 0) {
    lines.push('', '量不到（不进任何比例，不能补做：同一段录音再量还是一样）');
    lines.push(`  ${ITEM_NAME['speaker-similarity']}：${view.counts.holdouts} 条里 ${view.noSpeech.length} 条量不到`);
    for (const entry of view.noSpeech) lines.push(`    ${entry.id}：${WHICH_NAME[entry.which]}里没有能嵌声纹的语音（${entry.error.code}：${entry.error.message}）`);
  }

  if (view.differences.length > 0) {
    lines.push('', '模型说出来的区别（原话）');
    lines.push(...view.differences.slice(0, 20).map((entry) => `  ${entry.id} 第 ${entry.order} 次：${entry.text}`));
    if (view.differences.length > 20) lines.push(`  （还有 ${view.differences.length - 20} 条，用 --json 看全部）`);
  }

  if (view.groups.length > 0) {
    lines.push('', '按参考集的标签分组');
    const width = Math.max(...view.groups.map((group) => `${group.key}=${group.value}`.length));
    for (const group of view.groups) {
      const one = group.speakerSimilarity;
      let ratio = `相似度${UNMEASURABLE_LABEL}`;
      if (one.status === 'measured') {
        const also = alsoNotMeasured(one);
        ratio = `比值 ${fixed2(one.ratio)}${also.length > 0 ? `（另 ${also.join('、')}）` : ''}`;
      } else if (one.status === 'not_heard') {
        ratio = one.noSpeech === 0 ? `相似度全没听成（${one.notHeard} 条）` : `相似度一条也没量到（${alsoNotMeasured(one).join('，')}）`;
      } else if (one.status === 'no_speech') {
        ratio = `相似度全量不到（${one.noSpeech} 条）`;
      }
      const heard = group.blindListening;
      let sounds = `盲听${UNMEASURABLE_LABEL}`;
      if (heard.status === 'measured') {
        const counted = `${heard.trials} 条有效${heard.notHeard > 0 ? `、${heard.notHeard} 条没听成` : ''}`;
        sounds = `认出合成 ${fixed2(heard.identified.rate)}，判成同一人 ${fixed2(heard.sameSpeaker.rate)}（${counted}：${heard.sameSpeaker.label}）`;
      } else if (heard.status === 'voided') {
        sounds = `盲听全作废（${heard.voided} 条${heard.blocked > 0 ? `，${blockedWords(heard)}` : ''}）`;
      } else if (heard.status === 'not_heard') {
        sounds = `盲听全没听成（${heard.notHeard} 条）`;
      }
      lines.push(`  ${`${group.key}=${group.value}`.padEnd(width)}  留出 ${group.holdouts} 条，参考 ${group.references} 段  ${ratio}；${sounds}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
