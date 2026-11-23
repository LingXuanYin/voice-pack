// SPDX-License-Identifier: Apache-2.0
//
// 标提示标注（流程层）：挑完参考集以后，给这一版新补的每段参考定提示标注（annotatedText，写法见 lib/segment-annotation.mjs 的文件头）。
//   @capability audio-text-to-text            让能听音频的模型听着标，每段听一次，只听录音（lib/segment-annotation.mjs 调它；签名见 vocab/capability-signatures.md）
//   @capability automatic-speech-recognition  量录音的停顿（lib/point-measure.mjs 调它）；环境没有这项能力只用听的结果，不算没标上。合成的段不量
// 每一段的提示标注从哪来（规矩只在这里写一遍）：
//   素材给了（素材里写了 annotatedText，作者给的、库里给的不分）  照给的，不调模型
//   文字是台本的段（素材只给了 scriptText、台本念出来有字：lib/make-pack-input.mjs）  标注由写台本的一方写：台本里的提示和停顿（lib/script-annotation.mjs），台本没写、或者放不进文字的，就是不带提示的台本。不听、不量、不调模型；报告里 source 是 'script'
//   别的合成段（素材标了 synthetic: true）                        合成的一方没给标注就是没有提示：不听、不量、不调模型；报告里是 { status: 'no_cues', source: 'synthetic' }
//   上一版带来的段                                            照上一版的（有就有，没有就没有），不再标。要改就 --drop 那一段，再当素材重新给（换一个段名），带上新的 annotatedText
//   别的参考（录音）                                          环境有 audio-text-to-text 就每段听一次（段可以并发），没有就只存逐字稿
//   留出录音、没用上的段                                       不标
// 没标上的段（作废、重试用完、被拦下、环境没有这项能力）只存逐字稿，报告写明是哪几段、为什么；模型说说法没有变化（cues 是空的）的段也没有提示标注，但不算没标上。
// 音色基底标签的名字：素材没给标签（givenTag）的段，在同一次调用里顺带要一个短名字（nameLanguage 写，lib/segment-annotation.mjs 的文件头「答」），不另调；
//   素材给了标签的段不要名字。标上了、或者说法没有变化的段，模型给了名字就记下（modelTag），定标签用它（lib/make-pack-tags.mjs 的 assignTags）；
//   没标上的段、名字缺了或是空白的，没有 modelTag（标签用段名）。素材给了提示标注的段不调模型，也就没有名字（不为一个名字另调一次）。
//
//   needsAnnotation(item)                                   这一段要不要调模型：是录音（没给台本、文字不是台本、没标 synthetic）、不是上一版带来的、素材没给提示标注。规划（lib/make-pack-plan.mjs）数的也是它
//   annotateReferences(env, items, referenceIds, { concurrency, maxErrorRate, wait, nameLanguage, loudness })   给参考集里要标的段标提示标注（loudness 是调响度的设置，量停顿先调到目标响度（lib/point-measure.mjs 文件头「先调响度」），null 或不给照原电平；nameLanguage 是名字用的语言，见上；情绪词表、快慢标记也用它，素材给了标签的段一样），返回这一步的情况（steps.annotation）：
//     { status: 'not_needed', given, fromScript }                                    参考里没有要标的段（都是素材给了的、上一版带来的）
//     { status: 'skipped', capability, reason: 'capability_missing', segments, given, fromScript, notAnnotated }   环境没有 audio-text-to-text：要标的 segments 段都只存逐字稿
//     { status: 'done', capability, calls, chunks, measured, notMeasured, given, fromScript, annotated, withoutCues, openingMismatched, voided, blocked, unusable, unmatched, notHeard, retried, droppedCues, models, notAnnotated }
//   given 是素材给了提示标注的参考段数（台本带的也算在内，annotation.source 是 'script'）；fromScript 是其中台本带的段数（不调模型，人看的输出分开写）；calls 是听了几次（一段一次，重试在 retried 里）；chunks 是量的时候转写了几块（重试不算）；
//   measured、notMeasured 是听成了的段里，量上了几段、量失败只用听的结果的有几段（原因在每段的 annotation.measureReason）；annotated 是标上了的；withoutCues 是模型说说法没有变化的（量出来也没有要写的）；
//   openingMismatched 是标上了（或说法没有变化）、但模型写的开头对不上逐字稿的段数：不作废，提示只按 before 在逐字稿里找到的地方放（lib/segment-annotation.mjs 文件头「收音校验」），每段的 annotation.openingErrorRate 是错误率；
//   voided 是作废的总段数，blocked（被服务商拦下）、unusable（回答没正常结束或是空的）、unmatched（提示一条都对不上原文）是其中的几种；
//   notHeard 是服务暂时出错、试满次数也没成的段数；retried 是听的时候为暂时出错多问了几次（听的这一步一共问了 calls + retried 次）；
//   droppedCues 是标上了的段里，找不到 before、丢掉的提示一共几条；models 是模型报的模型名；
//   notAnnotated 是没标上的段 [{ id, reason }]（按参考集的次序），reason 是作废的原因（lib/segment-annotation.mjs）、'not_heard' 或 'capability_missing'。
//
// 读条目的：id、previous、annotatedText（素材给的、上一版的、台本的）、annotationSource（台本的提示是 'script'）、givenTag（素材给的标签：给了就不要名字）、audio、text；
// 写条目的：annotatedText（标上了的）、modelTag（模型给的名字，见上）、annotation（这一段的结果，进报告；名字不在里面，在报告的 tag、tagSource）：
//   { status: 'given' }                                      素材给的（台本的是 { status: 'given', source: 'script' }）
//   { status: 'no_cues', source: 'script' | 'synthetic' }    合成段，没有提示标注（台本太长放不下，或者合成的一方没给）
//   { status: 'annotated', cues, droppedCues?, openingErrorRate?, measured, measureReason?, measureErrorRate? }   标上了（cues 是听出来写进去的提示条数；openingErrorRate 只在开头对不上时有）
//   { status: 'no_cues', openingErrorRate?, measured, measureReason?, measureErrorRate? }       说法没有变化，量出来也没有要写的，没有提示
//   { status: 'voided', reason, errorRate?, problem?, stopReason?, droppedCues?, model?, measured: false }   作废（model 只在回答没正常结束时带）
//   { status: 'not_heard', error, attempts, measured: false }               没听成
//   measured 是这一段写没写量出来的停顿；measureReason 是量失败的原因（lib/point-measure.mjs 的文件头）；measureErrorRate 只在原因是 not_aligned 又对过字时有（可用的块太少没对字，切不出一条路的也没有），是对字的错误率。
//   { status: 'skipped', reason: 'capability_missing' }      环境没有这项能力
// 上一版带来的段不写 annotation。
//
// 暂时出错的段在这一步里自己再问：听最多问 3 次，等 5 秒、15 秒（规则的正本是 lib/call-attempts.mjs）；最多多问几次在规划里（plan.extraCalls），花钱之前已经说清楚。
// 量（lib/point-measure.mjs）和听同时做，转写每块最多 3 次，块数和重试的上限也在 plan.extraCalls 里。
//
// 抛出的错误：没有自己的。没标上的都记在报告里，不抛（lib/segment-annotation.mjs）；别的错原样往上抛，不重试（包括等的时候做包被取消）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { hasCapability } from '../protocol/lib/env.mjs';
import { annotateSegment } from './segment-annotation.mjs';
import { measurePoints, POINT_CONCURRENCY } from './point-measure.mjs';
import { pool } from './capability-calls.mjs';
import { MAX_ATTEMPTS } from './call-attempts.mjs';
import { isLanguageTag } from './language-tag.mjs';

/** 这一段要不要调模型标提示标注：新补的录音（不是上一版带来的，没给台本，文字不是台本，没标 synthetic），素材又没给。合成段的标注由合成的一方写。 */
export const needsAnnotation = (item) => item.previous === undefined && item.annotatedText === undefined && item.scriptText === undefined && item.textSource !== 'script' && item.synthetic !== true;

/** 给参考集里要标的段标提示标注。规矩、返回、写条目的字段见文件头。 */
export async function annotateReferences(env, items, referenceIds, { concurrency, maxErrorRate, wait, nameLanguage, loudness }) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const references = referenceIds.map((id) => byId.get(id)).filter((item) => item.previous === undefined);
  for (const item of references) {
    if (needsAnnotation(item)) continue;
    item.annotation = item.annotatedText === undefined
      ? { status: 'no_cues', source: item.textSource === 'script' || item.scriptText !== undefined ? 'script' : 'synthetic' }
      : { status: 'given', ...(item.annotationSource === undefined ? {} : { source: item.annotationSource }) };
  }
  const given = references.filter((item) => item.annotatedText !== undefined).length;
  const fromScript = references.filter((item) => item.annotationSource === 'script').length;
  const todo = references.filter(needsAnnotation);
  if (todo.length === 0) return { status: 'not_needed', given, fromScript };
  if (!hasCapability(env, 'audio-text-to-text')) {
    for (const item of todo) item.annotation = { status: 'skipped', reason: 'capability_missing' };
    return { status: 'skipped', capability: 'audio-text-to-text', reason: 'capability_missing', segments: todo.length, given, fromScript, notAnnotated: todo.map((item) => ({ id: item.id, reason: 'capability_missing' })) };
  }
  // 块并发转写；段也是并发的，这一段分到的是总数除以同时在标的段数，同时调转写的不超过 POINT_CONCURRENCY
  const chunkConcurrency = Math.max(1, Math.floor(POINT_CONCURRENCY / Math.min(concurrency, todo.length)));
  const step = { status: 'done', capability: 'audio-text-to-text', calls: 0, chunks: 0, measured: 0, notMeasured: 0, given, fromScript, annotated: 0, withoutCues: 0, openingMismatched: 0, voided: 0, blocked: 0, unusable: 0, unmatched: 0, notHeard: 0, retried: 0, droppedCues: 0, models: [] };
  await pool(todo, concurrency, async (item) => {
    // 素材没给标签的段，同一次里顺带要一个名字（不另调）
    const naming = item.givenTag === undefined ? { nameLanguage } : {};
    // 量这段（和听同时，lib/segment-annotation.mjs）：语言知道才带（素材给的，或者转写报的），同 lib/make-pack-transcribe.mjs；
    const language = item.givenLanguage ?? (isLanguageTag(item.transcribedLanguage) ? item.transcribedLanguage : item.textSource === 'script' && isLanguageTag(item.language?.value) ? item.language.value : undefined);
    const measure = () => measurePoints(env, { audio: item.audio, text: item.text, language }, { concurrency: chunkConcurrency, wait, loudness });
    const result = await annotateSegment(env, { audio: item.audio, text: item.text }, { maxErrorRate, attempts: MAX_ATTEMPTS, wait, onRetry: () => { step.retried += 1; }, measure, ...naming });
    const { model, annotatedText, name, chunks, ...rest } = result;
    step.calls += 1;
    step.chunks += chunks;
    if (result.status === 'annotated' || result.status === 'no_cues') {
      if (result.measured) step.measured += 1;
      else step.notMeasured += 1;
      if (result.openingErrorRate !== undefined) step.openingMismatched += 1;
    }
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
