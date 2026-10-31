// SPDX-License-Identifier: Apache-2.0
//
// 打标签（流程层）：定每个能用的片段的最终标签 { language, emotion?, style?, energy? }，和每个标签是谁定的。
//   @capability audio-text-to-text  让听者听着打情绪、风格标签（lib/segment-tags.mjs 调它；签名见 vocab/capability-signatures.md）
// 每一项标签的来源（规矩只在这里写一遍）：
//   语言      调用方给的 > 转写报出来的 > 从文字本身认（lib/line-hints.mjs 的 detectLanguages；拉丁字母的文字认不出是哪种语言）。认不出的这一段淘汰（language_unknown），
//             在花钱打标签之前就淘汰
//   情绪、风格  调用方给的算数（给 null 是「明确没有」，不去判断）；没给（undefined）的，环境有 audio-text-to-text 就让听者听着打（lib/segment-tags.mjs），没有就不打
//   能量      靠计算：响度跟这一批的中位数比，差 3 LU 以上的算高或低；不到 3 段量得出响度，不判断
//   每个标签是谁定的记在 tagSources：'caller'、'previous'（上一版带来的段）、'transcription'、'text'、'audio-text-to-text'、'computed'
//
//   resolveLanguages(items)                            定每一段的语言，认不出的淘汰
//   tagAll(env, items, { concurrency, maxErrorRate, wait })  情绪或风格没给齐的片段，让听者打标签，返回这一步的情况（steps.tagging）：
//                                                        { status: 'not_needed', tagged, voided, blocked, notHeard, retried }、
//                                                        { status: 'skipped', capability, reason: 'capability_missing', segments, tagged, voided, blocked, notHeard, retried }、
//                                                        { status: 'done', capability, calls, tagged, voided, blocked, notHeard, retried, models }
//                                                      calls 是要打标签的段数（每段问一次）；voided 是作废的总段数（听者没听到、回答不是固定格式、回答被模型的服务商拦下）；
//                                                      blocked 是其中被服务商拦下的段数（voided 的一部分）；notHeard 是服务暂时出错、试满次数也没听成的段数；
//                                                      retried 是为暂时出错多问了几次（0 就是一次也没重试），所以这一步一共问了 calls + retried 次
//   assembleTags(items)                                把几处来的标签合成每段的最终标签
//
// 读条目的：unused、labels、previous、text、transcribedLanguage、quality（响度）、audio；写条目的：language、tagging（听者的结果，写法见 lib/segment-tags.mjs 的返回；
// 被服务商拦下的是 { status: 'voided', reason: 'provider_blocked' }）、tags、tagSources。淘汰的写 unused: { reason: 'language_unknown', details: {} }。
//
// 暂时出错的段在这一步里自己再问：每段最多问 3 次，等 5 秒、15 秒（规则的正本是 lib/call-attempts.mjs，转写、命令行和 app 用的是同一份）；
// 最多多问几次在规划里（plan.extraCalls，lib/make-pack-plan.mjs），花钱之前已经说清楚。`wait` 是等待函数（makePack 的 options.retryWait），不给就真的等。
// 被服务商拦下（provider_blocked）、回答不是固定格式的段不重试，重来还是同一个答案。
//
// 抛出的错误：没有自己的。听者暂时出错（details.transient）试满次数还没成，记成「没听成」、回答不符合固定格式或被服务商拦下（provider_blocked）记成「作废」，都不抛（lib/segment-tags.mjs）；
// 别的错原样往上抛，不重试（包括等的时候做包被取消）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { hasCapability } from '../protocol/lib/env.mjs';
import { detectLanguages } from './line-hints.mjs';
import { isLanguageTag } from './language-tag.mjs';
import { tagSegment } from './segment-tags.mjs';
import { pool } from './capability-calls.mjs';
import { MAX_ATTEMPTS } from './call-attempts.mjs';

/** 调用方给的标签算「caller」；上一版带过来的算「previous」（报告里分得清是谁定的）。 */
const givenSource = (item) => (item.previous === undefined ? 'caller' : 'previous');

/** 语言：调用方给的 > 转写报出来的 > 从文字本身认（认得出一种主语言才算）。 */
function languageOf(item) {
  if (item.labels.language) return { value: item.labels.language, source: givenSource(item) };
  if (item.transcribedLanguage && isLanguageTag(item.transcribedLanguage)) return { value: item.transcribedLanguage, source: 'transcription' };
  const detected = item.text === '' ? null : detectLanguages(item.text);
  if (detected !== null && (detected.script !== 'Latin') && detected.languages.length > 0) return { value: detected.languages[0], source: 'text' };
  return null;
}

/** 能量：响度跟这一批的中位数比，差 3 LU 以上的算高或低；不到 3 段量得出响度，不判断。 */
const ENERGY_STEP_LU = 3;
const MIN_FOR_ENERGY = 3;
function energyLabels(items) {
  const loud = items.filter((item) => typeof item.quality?.metrics?.loudnessLufs === 'number');
  if (loud.length < MIN_FOR_ENERGY) return new Map();
  const sorted = loud.map((item) => item.quality.metrics.loudnessLufs).sort((a, b) => a - b);
  const middle = sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return new Map(loud.map((item) => {
    const level = item.quality.metrics.loudnessLufs;
    return [item.id, level >= middle + ENERGY_STEP_LU ? 'high' : level <= middle - ENERGY_STEP_LU ? 'low' : 'medium'];
  }));
}

/**
 * 定每一段的语言：调用方给的 > 转写报的 > 从文字本身认。认不出的这一段没用上（language_unknown），在花钱打标签之前就淘汰。
 */
export function resolveLanguages(items) {
  for (const item of items) {
    if (item.unused !== undefined) continue;
    const language = languageOf(item);
    if (language === null) item.unused = { reason: 'language_unknown', details: {} };
    else item.language = language;
  }
}

/** 每个能用的片段的最终标签：调用方给的算数，没给的补上（语言来自转写或文字，能量来自计算，情绪和风格来自 audio-text-to-text）。 */
export function assembleTags(items) {
  const energy = energyLabels(items.filter((item) => item.unused === undefined));
  for (const item of items) {
    if (item.unused !== undefined) continue;
    const sources = { language: item.language.source };
    const tags = { language: item.language.value };
    for (const key of ['emotion', 'style']) {
      const given = item.labels[key];
      const heard = item.tagging?.status === 'tagged' ? item.tagging[key] : undefined;
      if (given) {
        tags[key] = given;
        sources[key] = givenSource(item);
      } else if (given === undefined && heard) {
        tags[key] = heard;
        sources[key] = 'audio-text-to-text';
      }
    }
    const given = item.labels.energy;
    if (given) {
      tags.energy = given;
      sources.energy = givenSource(item);
    } else if (given === undefined && energy.has(item.id)) {
      tags.energy = energy.get(item.id);
      sources.energy = 'computed';
    }
    item.tags = tags;
    item.tagSources = sources;
  }
}

/** 打标签：情绪、风格没给齐的片段，让听者听着打。结果写在条目的 tagging 上。暂时出错的段按 lib/call-attempts.mjs 的规则再问。 */
export async function tagAll(env, items, { concurrency, maxErrorRate, wait }) {
  const todo = items.filter((item) => item.unused === undefined && (item.labels.emotion === undefined || item.labels.style === undefined));
  if (todo.length === 0) return { status: 'not_needed', tagged: 0, voided: 0, blocked: 0, notHeard: 0, retried: 0 };
  if (!hasCapability(env, 'audio-text-to-text')) return { status: 'skipped', capability: 'audio-text-to-text', reason: 'capability_missing', segments: todo.length, tagged: 0, voided: 0, blocked: 0, notHeard: 0, retried: 0 };
  const step = { status: 'done', capability: 'audio-text-to-text', calls: todo.length, tagged: 0, voided: 0, blocked: 0, notHeard: 0, retried: 0, models: [] };
  await pool(todo, concurrency, async (item) => {
    const result = await tagSegment(env, { audio: item.audio, text: item.text }, { maxErrorRate, attempts: MAX_ATTEMPTS, wait, onRetry: () => { step.retried += 1; } });
    const { model, ...rest } = result;
    if (model !== undefined && !step.models.includes(model)) step.models.push(model);
    item.tagging = rest;
    if (result.status === 'tagged') step.tagged += 1;
    else if (result.status === 'voided') {
      step.voided += 1;
      if (result.reason === 'provider_blocked') step.blocked += 1;
    } else step.notHeard += 1;
  });
  return step;
}
