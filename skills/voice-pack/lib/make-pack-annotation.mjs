// SPDX-License-Identifier: Apache-2.0
//
// 标提示标注（流程层）：挑完参考集以后，给这一版新补的每段参考定提示标注（annotatedText，写法见 lib/segment-annotation.mjs 的文件头）。
//   @capability audio-text-to-text  让能听音频的模型听着标（lib/segment-annotation.mjs 调它；签名见 vocab/capability-signatures.md）
// 每一段的提示标注从哪来（规矩只在这里写一遍）：
//   素材给了（素材里写了 annotatedText，作者给的、库里给的不分）  照给的，不调模型
//   上一版带来的段                                            照上一版的（有就有，没有就没有），不再标。要改就 --drop 那一段，再当素材重新给（换一个段名），带上新的 annotatedText
//   别的参考                                                  环境有 audio-text-to-text 就每段调一次（可以并发），没有就只存逐字稿
//   留出录音、没用上的段                                       不标
// 没标上的段（作废、重试用完、被拦下、环境没有这项能力）只存逐字稿，报告写明是哪几段、为什么；模型说说法没有变化（cues 是空的）的段也没有提示标注，但不算没标上。
// 音色基底标签的名字：素材没给标签（givenTag）的段，在同一次调用里顺带要一个短名字（nameLanguage 写，lib/segment-annotation.mjs 的文件头「答」），不另调；
//   素材给了标签的段不要名字。标上了、或者说法没有变化的段，模型给了名字就记下（modelTag），定标签用它（lib/make-pack-tags.mjs 的 assignTags）；
//   没标上的段、名字缺了或是空白的，没有 modelTag（标签用段名）。素材给了提示标注的段不调模型，也就没有名字（不为一个名字另调一次）。
//
//   needsAnnotation(item)                                   这一段要不要调模型：不是上一版带来的、素材没给提示标注。规划（lib/make-pack-plan.mjs）数的也是它
//   annotateReferences(env, items, referenceIds, { concurrency, maxErrorRate, wait, nameLanguage })   给参考集里要标的段标提示标注（nameLanguage 是名字用的语言，见上），返回这一步的情况（steps.annotation）：
//     { status: 'not_needed', given }                                    参考里没有要标的段（都是素材给了的、上一版带来的）
//     { status: 'skipped', capability, reason: 'capability_missing', segments, given, notAnnotated }   环境没有 audio-text-to-text：要标的 segments 段都只存逐字稿
//     { status: 'done', capability, calls, given, annotated, withoutCues, voided, blocked, unusable, unmatched, notHeard, retried, droppedCues, models, notAnnotated }
//   given 是素材给了提示标注的参考段数；calls 是要标的段数（每段问一次）；annotated 是标上了的；withoutCues 是模型说说法没有变化的；
//   voided 是作废的总段数，blocked（被服务商拦下）、unusable（回答没正常结束或是空的）、unmatched（提示一条都对不上原文）是其中的几种；
//   notHeard 是服务暂时出错、试满次数也没成的段数；retried 是为暂时出错多问了几次（这一步一共问了 calls + retried 次）；
//   droppedCues 是标上了的段里，找不到 before、丢掉的提示一共几条；models 是模型报的模型名；
//   notAnnotated 是没标上的段 [{ id, reason }]（按参考集的次序），reason 是作废的原因（lib/segment-annotation.mjs）、'not_heard' 或 'capability_missing'。
//
// 读条目的：id、previous、annotatedText（素材给的、上一版的）、givenTag（素材给的标签：给了就不要名字）、audio、text；
// 写条目的：annotatedText（标上了的）、modelTag（模型给的名字，见上）、annotation（这一段的结果，进报告；名字不在里面，在报告的 tag、tagSource）：
//   { status: 'given' }                                      素材给的
//   { status: 'annotated', cues, droppedCues? }              标上了
//   { status: 'no_cues' }                                    说法没有变化，没有提示
//   { status: 'voided', reason, errorRate?, problem?, stopReason?, droppedCues?, model? }   作废（model 只在回答没正常结束时带）
//   { status: 'not_heard', error, attempts }                 没听成
//   { status: 'skipped', reason: 'capability_missing' }      环境没有这项能力
// 上一版带来的段不写 annotation。
//
// 暂时出错的段在这一步里自己再问：每段最多问 3 次，等 5 秒、15 秒（规则的正本是 lib/call-attempts.mjs）；最多多问几次在规划里（plan.extraCalls），花钱之前已经说清楚。
//
// 抛出的错误：没有自己的。没标上的都记在报告里，不抛（lib/segment-annotation.mjs）；别的错原样往上抛，不重试（包括等的时候做包被取消）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { hasCapability } from '../protocol/lib/env.mjs';
import { annotateSegment } from './segment-annotation.mjs';
import { pool } from './capability-calls.mjs';
import { MAX_ATTEMPTS } from './call-attempts.mjs';

/** 这一段要不要调模型标提示标注：新补的（不是上一版带来的），素材又没给。 */
export const needsAnnotation = (item) => item.previous === undefined && item.annotatedText === undefined;

/** 给参考集里要标的段标提示标注。规矩、返回、写条目的字段见文件头。 */
export async function annotateReferences(env, items, referenceIds, { concurrency, maxErrorRate, wait, nameLanguage }) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const references = referenceIds.map((id) => byId.get(id)).filter((item) => item.previous === undefined);
  for (const item of references) if (!needsAnnotation(item)) item.annotation = { status: 'given' };
  const given = references.filter((item) => !needsAnnotation(item)).length;
  const todo = references.filter(needsAnnotation);
  if (todo.length === 0) return { status: 'not_needed', given };
  if (!hasCapability(env, 'audio-text-to-text')) {
    for (const item of todo) item.annotation = { status: 'skipped', reason: 'capability_missing' };
    return { status: 'skipped', capability: 'audio-text-to-text', reason: 'capability_missing', segments: todo.length, given, notAnnotated: todo.map((item) => ({ id: item.id, reason: 'capability_missing' })) };
  }
  const step = { status: 'done', capability: 'audio-text-to-text', calls: todo.length, given, annotated: 0, withoutCues: 0, voided: 0, blocked: 0, unusable: 0, unmatched: 0, notHeard: 0, retried: 0, droppedCues: 0, models: [] };
  await pool(todo, concurrency, async (item) => {
    // 素材没给标签的段，同一次里顺带要一个名字（不另调）
    const naming = item.givenTag === undefined ? { nameLanguage } : {};
    const result = await annotateSegment(env, { audio: item.audio, text: item.text }, { maxErrorRate, attempts: MAX_ATTEMPTS, wait, onRetry: () => { step.retried += 1; }, ...naming });
    const { model, annotatedText, name, ...rest } = result;
    if (name !== undefined) item.modelTag = name;
    if (model !== undefined && !step.models.includes(model)) step.models.push(model);
    // 回答没正常结束：原因和模型都进报告；别的不带模型（模型在 models 里）
    item.annotation = result.reason === 'annotation_answer_unusable' && model !== undefined ? { ...rest, model } : rest;
    if (result.status === 'annotated') {
      item.annotatedText = annotatedText;
      step.annotated += 1;
      step.droppedCues += result.droppedCues ?? 0;
    } else if (result.status === 'no_cues') step.withoutCues += 1;
    else if (result.status === 'voided') {
      step.voided += 1;
      if (result.reason === 'provider_blocked') step.blocked += 1;
      else if (result.reason === 'annotation_answer_unusable') step.unusable += 1;
      else if (result.reason === 'cues_unmatched') step.unmatched += 1;
    } else step.notHeard += 1;
  });
  step.notAnnotated = todo.filter((item) => item.annotation.status === 'voided' || item.annotation.status === 'not_heard').map((item) => ({ id: item.id, reason: item.annotation.status === 'voided' ? item.annotation.reason : 'not_heard' }));
  return step;
}
