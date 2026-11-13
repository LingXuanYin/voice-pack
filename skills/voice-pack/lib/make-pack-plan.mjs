// SPDX-License-Identifier: Apache-2.0
//
// 规划（流程层，不花钱）：不花钱的几步（筛片段、查重、量音质、试装）做完以后，算各项能力最多要调几次、有几段素材能用。
// 费用是在这里算出来给人看的：命令行和 app 在第一次调所需能力之前把它交给用户确认（options.onPlan），dryRun 也返回它。
//
//   buildPlan(env, items, settings, materialOptions, { pinned, cardLine })   返回 plan（cardLine：给了试听句，合成多算一次）：
//     { segments: { input, usable, withoutText, unused: { 原因: 段数 }, carried? },
//         input 是新补的段数；usable 是能用的段数（有文本，或者环境能转写，或者是上一版带来的）；withoutText 是没有文本、要转写的段数；
//         unused 是已经淘汰的段，按原因数；carried 是上一版带来的段数（发新版本才有）
//       holdouts,         最多留出几条（发新版本时不少于上一版带来的留出录音：评测要把它们都重新合成一遍）
//       capabilities,     { 能力名: 环境有没有 }
//       calls,            各项能力最多调几次：转写、挑默认段、标提示标注、合成、盲听、说话人相似度，各自怎么数的，见函数上面的说明
//       extraCalls }      除了 calls 以外，有重试规则的能力最多还会多调几次：转写、挑默认段、标提示标注和试合成，每一次（一段要转写的、一次挑默认段、一段要标的每一次听、一条留出录音）最多再试 2 次（lib/call-attempts.mjs），
//                         所以是 2 × 要转写的段数、2 ×（挑默认段的次数（每种语言一次）+ 3 × 要标提示标注的段数）、2 ×（留出录音的条数 + 试听句）（盲听那几次不在里面：盲听出错不重试）；
//                         量（lib/point-measure.mjs）的转写在 extraCalls 里算满，不在 calls 里：环境有转写也有听的能力时，每段要标的最多 POINT_CHUNKS_MAX 块、每块最多转写 3 次；别的能力出错不自动重试，这里没有它们。
//                         用户在第一次花钱之前同意的是 calls 加 extraCalls，实际调用不超过这个总数
//   是上界：转写补不出文本的、挑不出这么多留出录音的、候选只有一段的、当了留出录音不用标提示标注的，实际会少。settings 是 readOptions 的结果（用到 evaluate、minChars），
//   materialOptions 是挑素材的选项（lib/make-pack-input.mjs 的 materialOptionsOf）；pinned 是花钱之前就定了的默认段的段名：作者点名的，和发新版本时带过来的上一版的默认段
//   （沿用，lib/pack-material.mjs 的规则 5）；它们的语言不请模型挑。
//   有字数下限（settings.minChars，环境声明的）时，留出录音里文字不够下限的不合成、不算费用（lib/make-pack-trial.mjs）：合成、评测、盲听的次数只算
//   能合成的那几条（synthesizable）。挑留出录音的时候还不知道是哪几条，所以按能用的段里文字够下限的数（没有文字、要转写的算作够）：还是上界。
//
// 读条目的：unused、text、previous、givenLanguage、annotatedText、synthetic；不写条目。
//
// 抛出的错误：没有。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { hasCapability } from '../protocol/lib/env.mjs';
import { DEFAULTS, plannedHoldouts } from './pack-material.mjs';
import { hasWords } from './make-pack-transcribe.mjs';
import { extraAttempts, MAX_ATTEMPTS } from './call-attempts.mjs';
import { needsAnnotation } from './make-pack-annotation.mjs';
import { POINT_CHUNKS_MAX } from './point-measure.mjs';
import { languageBeforeSpending } from './make-pack-tags.mjs';
import { languageKey } from '../protocol/lib/manifest.mjs';

/** 能用的段：筛片段没淘汰的，而且有文本、或者环境能转写、或者是上一版带来的（没有文本又转写不了的用不上）。buildPlan 和 lib/make-pack-assemble.mjs 的 assertFitsFormat 数的是同一份。 */
export const usableItems = (env, items) => items.filter((item) => item.unused === undefined && (hasWords(item.text) || item.previous !== undefined || hasCapability(env, 'automatic-speech-recognition')));

/**
 * 挑默认段最多问几次（见文件头「挑默认段」）：每种语言一次，pinned 的语言不问，只有一段的语言不问；不知道语言的段（要转写的）按最多算。
 * usable 是能用的段，pinned 是花钱之前就定了的默认段的段名。
 */
function defaultPicksOf(usable, pinned) {
  const languageOf = new Map(usable.map((item) => [item.id, languageBeforeSpending(item)]));
  const pinnedLanguages = new Set(pinned.map((id) => languageOf.get(id)).filter((language) => language !== null && language !== undefined).map(languageKey));
  const counts = new Map();
  let unknown = 0;
  for (const item of usable) {
    const language = languageOf.get(item.id);
    if (language === null) unknown += 1;
    else if (!pinnedLanguages.has(languageKey(language))) counts.set(languageKey(language), (counts.get(languageKey(language)) ?? 0) + 1);
  }
  const many = [...counts.values()].filter((count) => count >= 2).length;
  const single = [...counts.values()].filter((count) => count === 1).length;
  const filled = Math.min(single, unknown); // 只有一段的语言，补一段不知道语言的就要问一次
  return many + filled + Math.floor((unknown - filled) / 2); // 剩下的不知道语言的，每两段算一种新的语言
}

/**
 * 不花钱的几步做完以后，各项能力最多要调几次。是上界：转写补不出文本的、挑不出这么多留出录音的，实际会少。
 *   转写      没有文本的片段，一段一次；暂时出错的段每段最多再转写 2 次，那几次不在 calls 里，在 extraCalls 里（lib/call-attempts.mjs）
 *   挑默认段  每种语言一次（lib/make-pack-pick.mjs）：默认段花钱之前没定（pinned 里没有这种语言的段）、能用的段里这种语言有两段以上的，请能听音频的模型挑一次；暂时出错最多再问 2 次，
 *             在 extraCalls 里。语言是花钱之前就知道的（lib/make-pack-tags.mjs 的 languageBeforeSpending）；要转写才知道语言的段，按最多算：
 *             先补给只有一段的语言（每种补一段，就多问一次），剩下的每两段算一种新的语言（defaultPicksOf）
 *   标提示标注  每段参考听一次（lib/segment-annotation.mjs；lib/make-pack-annotation.mjs）：挑参考集之前不知道哪几段当参考，所以数能用的段里要标的（新补的、素材没给提示标注的），
 *             不超过参考上限（maxReferences）；当了留出录音的不标，实际会少。暂时出错的最多再问 2 次，在 extraCalls 里（lib/call-attempts.mjs）。
 *             量停顿和快慢的转写：每段最多 POINT_CHUNKS_MAX 块（lib/point-measure.mjs），重试算在内，全在 extraCalls 里，calls 不算
 *   合成      每条能合成的留出录音（文字够字数下限的，没有下限就是全部）一次，给了试听句再加一次（lib/make-pack-card-line.mjs）；暂时出错的每一条最多再合成 2 次，
 *             那几次在 extraCalls 里（lib/call-attempts.mjs）
 *   盲听      每条留出录音问两遍（lib/fidelity.mjs）
 *   说话人相似度  真录音（参考加留出录音）两两算一次，再加每条留出录音和它合成出来的录音比一次；挑最典型的默认段另加参考之间两两算一次
 *                 （参考最多是能用的段数和 maxReferences 里小的那个；默认段沿用的其实不算，这里按最多算）
 */
export function buildPlan(env, items, settings, materialOptions, { pinned = [], cardLine = false } = {}) {
  const candidates = items.filter((item) => item.unused === undefined);
  const can = (capability) => hasCapability(env, capability);
  const textless = candidates.filter((item) => !hasWords(item.text) && item.previous === undefined);
  const usable = usableItems(env, items);
  // 标提示标注：每段参考听一次。挑参考之前按能用的段里要标的数，不超过参考上限（见上面）
  const annotating = Math.min(usable.filter(needsAnnotation).length, materialOptions?.maxReferences ?? DEFAULTS.maxReferences);
  // 发新版本：上一版的留出录音都带着，评测要把它们都重新合成一遍，所以最少是它们的条数
  const carriedHoldouts = candidates.filter((item) => item.previous === 'holdout').length;
  // 留出录音只从真录音里挑（挑素材的规则 2 只数真录音，见 lib/pack-material.mjs），所以估计也只数真录音
  const holdouts = Math.max(plannedHoldouts(usable.filter((item) => item.synthetic !== true).length, materialOptions), carriedHoldouts);
  const evaluating = settings.evaluate !== false && holdouts > 0;
  // 留出录音里能合成的（文字够字数下限的，见文件头；没有下限就是全部）：合成、盲听、相似度只对这几条做
  const minChars = settings.minChars ?? null;
  const synthesizable = minChars === null ? holdouts : Math.min(holdouts, usable.filter((item) => !hasWords(item.text) || [...item.text].length >= minChars).length);
  // 挑最典型的默认段：参考之间两两量（参考最多是能用的段数和参考上限里小的那个）
  const referenceCap = Math.min(usable.length, materialOptions?.maxReferences ?? DEFAULTS.maxReferences);
  const typicalPairs = can('speaker-verification') ? (referenceCap * (referenceCap - 1)) / 2 : 0;
  // 挑默认段：每种语言一次（候选只有一段的语言不问，默认段花钱之前就定了的语言不问）
  const defaultPicks = can('audio-text-to-text') ? defaultPicksOf(usable, pinned) : 0;
  // 试听句：给了就是一次合成（lib/make-pack-card-line.mjs），暂时出错的再试的余量同试合成
  const cardLineCalls = cardLine && can('voice-cloning') ? 1 : 0;
  const unused = {};
  for (const item of items) if (item.unused !== undefined) unused[item.unused.reason] = (unused[item.unused.reason] ?? 0) + 1;
  return {
    segments: { input: items.filter((item) => item.previous === undefined).length, usable: usable.length, withoutText: textless.length, unused, ...(items.some((item) => item.previous !== undefined) ? { carried: items.filter((item) => item.previous !== undefined).length } : {}) },
    holdouts,
    capabilities: Object.fromEntries(['automatic-speech-recognition', 'audio-text-to-text', 'voice-cloning', 'speaker-verification'].map((name) => [name, can(name)])),
    calls: {
      'automatic-speech-recognition': can('automatic-speech-recognition') ? textless.length : 0,
      'audio-text-to-text': can('audio-text-to-text') ? defaultPicks + annotating + (evaluating ? 2 * synthesizable : 0) : 0,
      'voice-cloning': (evaluating && can('voice-cloning') ? synthesizable : 0) + cardLineCalls,
      'speaker-verification': (evaluating && can('voice-cloning') && can('speaker-verification') ? (usable.length * (usable.length - 1)) / 2 + synthesizable : 0) + typicalPairs,
    },
    extraCalls: {
      'automatic-speech-recognition': can('automatic-speech-recognition') ? extraAttempts(textless.length) + (can('audio-text-to-text') ? annotating * POINT_CHUNKS_MAX * MAX_ATTEMPTS : 0) : 0,
      'audio-text-to-text': can('audio-text-to-text') ? extraAttempts(defaultPicks + annotating) : 0,
      'voice-cloning': extraAttempts((evaluating && can('voice-cloning') ? synthesizable : 0) + cardLineCalls),
    },
  };
}
