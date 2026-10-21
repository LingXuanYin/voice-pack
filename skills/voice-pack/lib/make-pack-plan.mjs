// SPDX-License-Identifier: Apache-2.0
//
// 规划（流程层，不花钱）：不花钱的几步（筛片段、查重、量音质、试装）做完以后，算各项能力最多要调几次、有几段素材能用。
// 费用是在这里算出来给人看的：命令行和 app 在第一次调所需能力之前把它交给用户确认（options.onPlan），dryRun 也返回它。
//
//   buildPlan(env, items, settings, materialOptions)   返回 plan：
//     { segments: { input, usable, withoutText, unused: { 原因: 段数 }, carried? },
//         input 是新补的段数；usable 是能用的段数（有文本，或者环境能转写，或者是上一版带来的）；withoutText 是没有文本、要转写的段数；
//         unused 是已经淘汰的段，按原因数；carried 是上一版带来的段数（发新版本才有）
//       holdouts,         最多留出几条（发新版本时不少于上一版带来的留出录音：评测要把它们都重新合成一遍）
//       capabilities,     { 能力名: 环境有没有 }
//       calls,            各项能力最多调几次：转写、打标签、合成、盲听、说话人相似度，各自怎么数的，见函数上面的说明
//       extraCalls }      除了 calls 以外，有重试规则的能力最多还会多调几次：转写和打标签，每段最多再问 2 次（lib/call-attempts.mjs），
//                         所以是 2 × 要转写的段数、2 × 要打标签的段数（盲听那几次不在里面：盲听出错不重试）；别的能力出错不自动重试，这里没有它们。
//                         用户在第一次花钱之前同意的是 calls 加 extraCalls，实际调用不超过这个总数
//   是上界：转写补不出文本的、标签定下来的、挑不出这么多留出录音的，实际会少。settings 是 readOptions 的结果（用到 evaluate），
//   materialOptions 是挑素材的选项（lib/make-pack-input.mjs 的 materialOptionsOf）。
//
// 读条目的：unused、text、previous、labels；不写条目。
//
// 抛出的错误：没有。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { hasCapability } from '../protocol/lib/env.mjs';
import { plannedHoldouts } from './pack-material.mjs';
import { hasWords } from './make-pack-transcribe.mjs';
import { extraAttempts } from './call-attempts.mjs';

/**
 * 不花钱的几步做完以后，各项能力最多要调几次。是上界：转写补不出文本的、标签定下来的、挑不出这么多留出录音的，实际会少。
 *   转写      没有文本的片段，一段一次；暂时出错的段每段最多再转写 2 次，那几次不在 calls 里，在 extraCalls 里（lib/call-attempts.mjs）
 *   打标签    情绪或风格没给齐的片段，一段一次；暂时出错的段每段最多再问 2 次，那几次不在 calls 里，在 extraCalls 里（lib/call-attempts.mjs），盲听的不算
 *   合成      每条留出录音一次
 *   盲听      每条留出录音问两遍（lib/fidelity.mjs）
 *   说话人相似度  真录音（参考加留出录音）两两算一次，再加每条留出录音和它合成出来的录音比一次
 */
export function buildPlan(env, items, settings, materialOptions) {
  const candidates = items.filter((item) => item.unused === undefined);
  const can = (capability) => hasCapability(env, capability);
  const textless = candidates.filter((item) => !hasWords(item.text) && item.previous === undefined);
  const usable = candidates.filter((item) => hasWords(item.text) || item.previous !== undefined || can('automatic-speech-recognition'));
  const taggable = usable.filter((item) => item.labels.emotion === undefined || item.labels.style === undefined);
  // 发新版本：上一版的留出录音都带着，评测要把它们都重新合成一遍，所以最少是它们的条数
  const carriedHoldouts = candidates.filter((item) => item.previous === 'holdout').length;
  const holdouts = Math.max(plannedHoldouts(usable.length, materialOptions), carriedHoldouts);
  const evaluating = settings.evaluate !== false && holdouts > 0;
  const unused = {};
  for (const item of items) if (item.unused !== undefined) unused[item.unused.reason] = (unused[item.unused.reason] ?? 0) + 1;
  return {
    segments: { input: items.filter((item) => item.previous === undefined).length, usable: usable.length, withoutText: textless.length, unused, ...(items.some((item) => item.previous !== undefined) ? { carried: items.filter((item) => item.previous !== undefined).length } : {}) },
    holdouts,
    capabilities: Object.fromEntries(['automatic-speech-recognition', 'audio-text-to-text', 'voice-cloning', 'speaker-verification'].map((name) => [name, can(name)])),
    calls: {
      'automatic-speech-recognition': can('automatic-speech-recognition') ? textless.length : 0,
      'audio-text-to-text': can('audio-text-to-text') ? taggable.length + (evaluating ? 2 * holdouts : 0) : 0,
      'voice-cloning': evaluating && can('voice-cloning') ? holdouts : 0,
      'speaker-verification': evaluating && can('voice-cloning') && can('speaker-verification') ? (usable.length * (usable.length - 1)) / 2 + holdouts : 0,
    },
    extraCalls: {
      'automatic-speech-recognition': can('automatic-speech-recognition') ? extraAttempts(textless.length) : 0,
      'audio-text-to-text': can('audio-text-to-text') ? extraAttempts(taggable.length) : 0,
    },
  };
}
