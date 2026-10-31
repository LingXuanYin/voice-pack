// SPDX-License-Identifier: Apache-2.0
//
// 转写（流程层）：没有文本的片段，环境有 automatic-speech-recognition 就转写补上文本（语言也记下）；没有就跳过，这些片段不能用。
//   @capability automatic-speech-recognition  签名见 vocab/capability-signatures.md
//
//   hasWords(text)                          这段文字里有没有一个词（lib/fidelity.mjs 的 tokenizeTranscript：中文按字、英文按词）；一个词都没有，就是「没有文本」
//   transcribe(env, items, { concurrency, wait }) 转写，返回这一步的情况（steps.transcription）：
//                                             { status: 'not_needed' }（没有要转写的）、
//                                             { status: 'skipped', capability, reason: 'capability_missing', segments }（环境没有转写能力，segments 是因此没法补文本的段数）、
//                                             { status: 'done', capability, transcribed, failed, retried, models }：retried 是这一步为暂时出错多调了几次（0 就是一次也没重试）
//   settleText(items)                       转写以后，给每个还能用的片段定文本是哪来的（textSource），还是没有文本的淘汰（no_text）
//
// 暂时出错的段在这一步里自己再试：每段最多转写 3 次，等 5 秒、15 秒（规则的正本是 lib/call-attempts.mjs，打标签、命令行和 app 用的是同一份）；
// 最多多调几次在规划里（plan.extraCalls，lib/make-pack-plan.mjs），花钱之前已经说清楚。`wait` 是等待函数（makePack 的 options.retryWait），不给就真的等。
//
// 读条目的：unused、previous、text、labels（language：知道就交给转写）；写条目的：text、textSource（'caller' 调用方给的、'transcription' 转写来的、'previous' 上一版带来的）、
// transcribedLanguage（转写报的语言，整理成清单的写法）。上一版带过来的段不转写。淘汰的写 unused: { reason, details }：
//   transcription_failed  试满了次数，转写还是暂时出错（details.transient），这一段用不上。details: { error, attempts }（error 是最后一次的错误摘要：code、message、details；attempts 是试了几次）
//   no_text               没有文本，也没转写出来。details: { transcribed: true }（转写过、转出来是空的）或 {}
//
// 抛出的错误：
//   capability_result_invalid  转写的返回不是 { text: 字符串, language?, model? }。details: { capability, problem }（lib/capability-calls.mjs 的 badResult）
//   转写暂时出错（details.transient 为 true）先重试，试满了次数也没成就不抛，记在片段上；别的错原样往上抛，不重试：401 之类，和环境认不了片段的语言（capability_input_invalid，details.field 是 language，规则见 vocab/capability-signatures.md）
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { hasCapability, requireCapability } from '../protocol/lib/env.mjs';
import { normalizeLanguage } from './line-hints.mjs';
import { tokenizeTranscript } from './fidelity.mjs';
import { summarizeError, badResult, pool } from './capability-calls.mjs';
import { callWithRetries } from './call-attempts.mjs';

export const hasWords = (text) => tokenizeTranscript(text).length > 0;

/** 转写：没有文本的片段，环境有 automatic-speech-recognition 就转写补上文本（语言也记下）；没有就跳过，这些片段不能用。上一版带过来的段不转写。暂时出错的段按 lib/call-attempts.mjs 的规则再试。 */
export async function transcribe(env, items, { concurrency, wait }) {
  const todo = items.filter((item) => item.unused === undefined && item.previous === undefined && !hasWords(item.text));
  if (todo.length === 0) return { status: 'not_needed' };
  if (!hasCapability(env, 'automatic-speech-recognition')) return { status: 'skipped', capability: 'automatic-speech-recognition', reason: 'capability_missing', segments: todo.length };
  const recognize = requireCapability(env, 'automatic-speech-recognition');
  const step = { status: 'done', capability: 'automatic-speech-recognition', transcribed: 0, failed: 0, retried: 0, models: [] };
  await pool(todo, concurrency, async (item) => {
    // 片段的语言知道（调用方给的：片段自己的标签，或 input.labels 里的默认）就告诉转写；不知道就不带这个键（规则的正本：vocab/capability-signatures.md 的转写一节）
    let calls = 0;
    const ask = () => {
      calls += 1;
      return recognize({ audio: item.audio, ...(item.labels.language ? { language: item.labels.language } : {}) });
    };
    const outcome = await callWithRetries(ask, { wait }); // 暂时出错就再试，试满了返回 { error }；别的错抛出来
    step.retried += calls - 1;
    if ('error' in outcome) {
      item.unused = { reason: 'transcription_failed', details: { error: summarizeError(outcome.error), attempts: outcome.attempts } };
      step.failed += 1;
      return;
    }
    const { result } = outcome;
    if (result === null || typeof result !== 'object' || typeof result.text !== 'string') throw badResult('automatic-speech-recognition', '必须返回 { text: 字符串, language?: 字符串, model?: 字符串 }');
    if (typeof result.model === 'string' && !step.models.includes(result.model)) step.models.push(result.model);
    item.text = result.text.trim();
    item.textSource = 'transcription';
    item.transcribedLanguage = normalizeLanguage(result.language);
    step.transcribed += 1;
  });
  return step;
}

/** 转写以后：每个还能用的片段，文本是上一版带来的、调用方给的，还是转写来的；一个词都没有的淘汰（no_text）。 */
export function settleText(items) {
  for (const item of items) {
    if (item.unused !== undefined) continue;
    if (item.previous !== undefined) item.textSource = 'previous';
    else if (hasWords(item.text)) item.textSource ??= 'caller';
    else item.unused = { reason: 'no_text', details: item.textSource === 'transcription' ? { transcribed: true } : {} };
  }
}
