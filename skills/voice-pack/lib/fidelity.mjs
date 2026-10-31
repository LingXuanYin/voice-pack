// SPDX-License-Identifier: Apache-2.0
//
// 还原度（流程层）：用两种方法量「用音色包生成的声音像不像角色本人」，按参考集的标签分组出报告。
//
//   说话人相似度  生成的录音和对应的留出录音之间的相似度，除以真人基线。
//                真人基线 = 同一个评测模型下，同一个人的真录音（参考和留出录音）两两之间相似度的平均。
//   盲听         把真人录音和生成的录音打乱成 X、Y 交给能听音频的模型，不告诉它哪段是真人；
//                先让它把两段话开头的 OPENING_WORDS 个词写出来，和已知文本的开头对不上就作废（只比开头：要整段原话，现成文章会被模型的服务商拦下，见 OPENING_WORDS）；
//                再问三件事（是不是同一个人、哪段是合成的、有什么区别）；
//                换序再问一遍：同一对录音 X、Y 对调再问，模型偏向某个位置，也不会把「认出合成的比例」推向一边。
//                这个比例能不能当分数，见下面「怎么读这份报告」。
//
// 需要的所需能力（调用签名都写在 vocab/capability-signatures.md，这里只标注用到哪几项）：
//   @capability speaker-verification  说话人相似度、真人基线
//   @capability audio-text-to-text    盲听
// 环境缺哪一项，只有用到它的那一项报「量不了」，并点名缺的能力；别的照常。
//
// 随机数由外部注入（options.random），测试才能固定顺序；省略时用 Math.random。
//
// 报告 measureFidelity 的形状：
//   { counts, models, baseline, overall: { holdouts, speakerSimilarity, blindListening }, groups: [...], items: [...], voided: [...], notHeard: [...], noSpeech: [...] }
//   speakerSimilarity 是 { status: 'measured', n, notHeard, noSpeech, meanSimilarity, ratio }、{ status: 'not_heard', label: '没听成', n: 0, notHeard, noSpeech }
//   （这一组的说话人相似度一条也没量出来，有没听成的）、{ status: 'no_speech', label: '量不到', n: 0, notHeard: 0, noSpeech }
//   （这一组的每一条都量不到）或「量不了」；baseline 是 { status: 'measured', value, pairs, excluded?, model? }，excluded 是没用上的真录音
//   （嵌不出声纹的，见读法第 9 点）：[{ id, role: 'reference' | 'holdout', error }]，没有这样的就没有这一项；
//   blindListening 是 { status: 'measured', trials, voided, blocked, notHeard, asks, identifiedRate, sameSpeakerRate, consistentRate, differences, ... }、
//   { status: 'voided', ... }（这一组的盲听全作废了）、{ status: 'not_heard', ... }（这一组的盲听一条有效的都没有，又有没听成的）或「量不了」。
//   voided 是作废的总条数；blocked 是其中被模型的服务商拦下的条数（voided 的一部分，不是另外的；读法第 5 点）。有效、作废、没听成加起来是这一组的留出录音条数。
//   「量不了」是 { status: 'unmeasurable', label: '量不了', reason, capability?, message }：缺能力时 reason 是 capability_missing，
//   capability 是缺的那一项；数据不够时 reason 写明原因（no_holdout_recordings、not_enough_real_recordings、baseline_not_positive）。
//   items 里每一条留出录音的 speakerSimilarity、blindListening，各是 { status: 'measured', ... }、{ status: 'voided', label: '作废', error }（只有盲听；
//   error.code 说明为什么作废：listening_check_failed、blind_answer_invalid、provider_blocked）
//   或「没听成」{ status: 'not_heard', label: '没听成', item, error: { code, message, details }, attempts }；盲听的没听成还带 firstX
//   （第一次问的时候放在 X 的是 'a' 真人还是 'b' 生成的，补做沿用它，顺序就不会因为补做而变）；
//   说话人相似度还可能是「量不到」{ status: 'no_speech', label: '量不到', item: 'speaker-similarity', which: 'generated' | 'holdout', error }
//   （哪一段嵌不出声纹，error 是能力报错的原样；没有 attempts，不能补做）。
//   voided、notHeard、noSpeech 是把各条里作废的、没听成的、量不到的摘出来的清单（notHeard 的每个元素是 { id, item, error, attempts }，
//   noSpeech 的是 { id, item, which, error }）。
//   补做：planRedo 算要补做哪几项、各要调用多少次；redoNotHeard 只对没听成的那几项重新调用，合并成一份新报告，形状同上。
//   每一项的含义见各函数的说明；怎么读这些数，见下面「怎么读这份报告」。库只给数，不设门槛，也不替人下「像不像」的结论。
//
// 显示报告（命令行、app）：lib/fidelity-reading.mjs 的 readReport(report) 把报告变成「要显示什么」的结构（每一组和总体的比值，判成同一人的次数、条数和档，
//   能不能下结论，作废、没听成、量不到各几条，模型说出来的区别原话，补做要调几次），READING_NOTES 是读法每一点的显示用语。
//   读法的规则只在那里程序化一次：命令行（cli/fidelity-report.mjs 的 renderFidelityReport）和 app 都从它显示，不各写一份阈值。
//
// 怎么读这份报告（读法只在这里写一份，显示报告的地方——命令行、app——照它写，规则的程序在 lib/fidelity-reading.mjs。读法用公开语料标定过，标定的记录不随基础部分发布，下面写的是记录里的数；
//   盲听的数用现在的提示（每段音频只写开头 OPENING_WORDS 个词）重收过（2026-10-19），下面的盲听数字以这一次为准；
//   整段转写的旧提示在 2026-10-14 收过一次，留作对照，说话人相似度的数也是 2026-10-14 收的）：
//   读法不设门槛：分数低的包照样能发布，分数不隐藏。下面的三档只是读法，不挡任何事。
//   盲听的三个结果里，只有「判成同一人的比例」能读，另外两个不是分数。
//   1. 判成同一人的比例（sameSpeakerRate）。一组留出录音一起读（报告里按标签分的每一组，和总体，各是一组）：
//        有效的留出录音不到 5 条：只列比例和条数，写明「条数不够，不下结论」。
//        比例 >= 0.7：「判成同一人」；比例 <= 0.3：「判成不是同一人」；两者之间：「说不准」。
//        「说不准」不当成好，也不当成坏，和说话人相似度的比值、模型说出来的区别（原话）一起看。
//        显示时带上次数和条数（例如「9/10 次，5 条」），不只给比例或一个词。
//      它分得开声音差得远的（不同的人、不带参考的默认声音）；对同语言同性别的另一个人只部分分得开。声音很接近的两个人，
//      模型会判成同一人，说话人相似度也分不开。所以「判成同一人」是「没发现不是本人」，不是「证明是本人」。
//      数（现在的记录，按次数）：同一个人的两段真录音 14/14 次判成同一人，用本人声音克隆的 23/24；两个人的真录音 1/16，
//      不带参考的默认声音 1/8（另用 127 对默认声音量过，123 对有效，每对问两次：判成同一人的比例 16%，95% 区间 11% 到 21%）；
//      克隆成别人声音的 14/24（95% 区间 38% 到 79%）。每组只有 12 条，换一批克隆再问，这个比例能差十几个点（旧记录 7/18，39%），
//      所以一个五条的包，这一组读成「判成同一人」的可能在 34% 上下（照这 12 条算，三、五、八条分别 20%、34%、13%；旧记录五条 7%）。
//   2. 认出合成的比例（identifiedRate）不是分数，不要按「越接近 0.5 越好」读。标定里把三种合成（用本人声音克隆的、克隆成别人声音的、
//      不带参考的默认声音）合起来，模型指对合成那一段的次数没有高于随机（32/56，Wilson 95% 区间 0.44 到 0.69，包着 0.5），所以 0.5 左右既可能是克隆得好，也可能只是模型
//      分辨不出来，这个数分不开这两种。报告照常列出，旁边写明「不是分数」。
//   3. 换序后指的还是同一段（consistentRate）只说明第 2 个数有多少是跟着声音答的、多少是跟着位置答的。不当分数读，低也不扣分。
//   4. 模型说出来的区别是原话，给人看，不计数、不打分。「合成感」「机械」这类词，模型对两段真录音也常写，不能当成被听出来的证据。
//   5. 作废：收音校验的上限 DEFAULT_MAX_ERROR_RATE（0.3）不变，依据（有音频时转写错误率的分布，没给音频时的错误率）在上面说的记录里。
//      校验只比每段音频开头的 OPENING_WORDS 个词。现在的记录（2026-10-19，就是这个提示收的）：
//      176 段转写，159 段逐字对上，错误率均值 0.02、最大 0.43，超过 0.3 的 1 段；没给音频时错误率 1.00，作废。整段转写的旧记录（2026-10-14）
//      是 124 段、均值 0.04、最大 0.25，没给音频时 0.96。换了音频和静音时的错误率另量过，量法和数不随基础部分发布。
//      作废的条数单独报，不进以上任何比例。作废有三种原因，error.code 里分得开：收音校验没过（listening_check_failed）、
//      回答不是固定格式（blind_answer_invalid）、回答被模型的服务商拦下（provider_blocked）。被拦下的另外报条数（blocked，是作废的一部分），
//      写明是被拦下，不写成「不是 JSON」：服务商拦的是这一段录音的这次问答，再问多半还是被拦（实测，整段转写的旧提示：同一批录音再问一遍，
//      上一次被拦的 49 次里 46 次又被拦；上一次问成的 261 次里 9 次这次被拦），所以记成作废，不记成没听成，补做多半没有用。
//   6. 没听成：某条的盲听或说话人相似度碰到服务出错（上游 5xx、网关超时、网络错误、超时），那一项记成「没听成」，单独报：
//      和作废是两回事（作废是模型听了、没听到；没听成是根本没问成），两者都不进任何比例，也不算分数低。
//      显示时写条数，例如「5 条里 2 条没听成，可以补做」，再列是哪几条、什么错、试了几次；有效的不到 5 条，照第 1 点只列比例和条数，
//      写「条数不够，不下结论」，补做完再读。没听成可以补做：库不自动重试（建任务和补全可能已经计费），
//      由调用方明确地要（redoNotHeard，命令行是 --redo），只重新调用没听成的那几项，调用几次事先写明（planRedo）。
//   7. 说话人相似度的比值本身就是分数，照数显示（1 表示和这个人自己的真录音之间一样像）。
//      两种方法不合成一个总分；两个对不上时，两个都照实列出，不替人选一个。
//   8. 适用范围：标定用的是朗读语料（AISHELL-1、LibriSpeech）、一个克隆模型（单段参考）、一个听者模型，用的是哪两个写在记录里；
//      每组有效的只有 4 到 12 条（盲听，按条数，现在的记录）。换了合成模型、听者或语料类型，要重新标定，这几条读法不能照搬。
//   9. 量不到：某一条的说话人相似度，生成的或留出的那一段录音里没有能嵌出声纹的语音（短到嵌不出、近乎静音；说话人验证报
//      capability_input_invalid、details.problem 是 no_speech，写法见 vocab/capability-signatures.md）。这是那一段录音自己的事，
//      不是环境坏了，也不是服务出错：那一条的说话人相似度记成「量不到」，写明是生成的还是留出的那一段、能力报的原话，单独报，
//      不进任何比例，也不算分数低。和「没听成」不同，同一段录音再量还是一样，所以不能补做（planRedo、redoNotHeard 都不算它）；
//      和「量不了」不同，它只是某一条的某一段录音，别的条照常量，整份报告照常出。显示时写条数和是哪几条，例如「6 条里 1 条量不到」。
//      留出的真录音自己嵌不出时，真人基线也不用它（报告里 baseline.excluded 记着）；剩下的真录音凑不出一对时，说话人相似度整体「量不了」。
//   10. 设计来源的包（measureFidelity 的 options.designSource 是 true，做包时清单里有 designSource）。它的素材不是真人录音，读法不一样：
//      基线是这个设计声音自己几次合成之间的一致程度（同一个设计声音的几段合成，两两之间相似度的平均），比值说的是「用这个包合成的，和这个设计声音自己有多一致」，
//      不是像不像哪个真人。所以第 1 点的三档对它不适用：盲听的「判成同一人的比例」照列数（次数、条数），但不读成档，不下结论，写明「三档读法不适用」。
//      有效的留出录音不到 5 条的，也照列数，不提示补素材（设计来源的包不给留出录音的提示，见 material-hints 文件头 designSource）。
//      清单里没有 designSource 的，照真人录音读（第 1 点到第 9 点照旧）：判不出是不是设计来源，不猜。
//
// 抛出的错误（code 小写下划线，details 里放什么在抛出处写明）：
//   fidelity_input_invalid         输入不是约定的形状（补做时，上一次的报告不是 measureFidelity 出的形状、或要补做的留出录音不在输入里，也是它）。
//                                  details.field 是出问题的字段，上一次的报告里的字段从 previous 起写
//   fidelity_text_empty            已知文本里一个词也没有，没法拿它核对转写。details.field
//   listening_check_failed         收音校验没过：模型写出来的开头和已知文本的开头对不上，说明它没听到。这次盲听作废
//   blind_answer_invalid           模型的回答不是固定格式，解析不了，不猜。这次盲听作废
//   provider_blocked               回答被模型的服务商拦下了。这个码是能力抛的（适配器认服务商的原话，写法见 vocab/capability-signatures.md 的 audio-text-to-text 一节），
//                                  库只认这个码；blindListen 原样往上抛，measureFidelity 和 redoNotHeard 接住它，那一条盲听记成作废（读法第 5 点），不往外抛
//   capability_result_invalid      所需能力的返回不是约定的形状。details.capability
//   evaluation_model_mismatch      同一次评测里同一项能力给出了不止一个模型（补做时和上一次的不一样也算）。details.capability、details.models
//   baseline_needs_two_recordings  真人基线要同一个人至少两段真录音。details.recordings 是能用的段数（嵌不出声纹的不算），
//                                  去掉过真录音的话 details.excluded 是被去掉的（measureFidelity 接住它，说话人相似度整体报「量不了」，不往外抛）
//   另外 capability_missing、audio_clip_invalid 来自 protocol/lib/env.mjs、protocol/lib/audio-clip.mjs。
//   能力在 details.transient 里标了「服务暂时出错」的错（见 vocab/capability-signatures.md「通用约定」），measureFidelity 和 redoNotHeard 不抛，
//   记成「没听成」；能力报「这段录音里没有能嵌的语音」的标准错误（读法第 9 点），同样不抛，记成「量不到」；
//   别的错（401、返回的形状不对、别的写法的 capability_input_invalid、普通的 Error……）原样往上抛，一条也不吞。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError, isVoicePackError } from '../protocol/lib/errors.mjs';
import { requireCapability } from '../protocol/lib/env.mjs';
import { assertAudioClip } from '../protocol/lib/audio-clip.mjs';
import { isServiceError, summarizeError, badResult } from './capability-calls.mjs';

const isWordChar = /[\p{L}\p{N}\p{M}]/u;
const isSeparator = /[\p{P}\p{S}\p{Z}\p{C}]/u;
const isCjkChar = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u;
// 撇号：直的、弯的（U+2019）、修饰字母撇号（U+02BC）。特殊字符用码位拼，不在源码里直接写。
const APOSTROPHES = [0x27, 0x2019, 0x2bc].map((code) => String.fromCharCode(code));

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const mean = (numbers) => numbers.reduce((sum, value) => sum + value, 0) / numbers.length;

// ---------------------------------------------------------------- 共用的小函数

const invalid = (field, message) => new VoicePackError('fidelity_input_invalid', message, { details: { field } });

/**
 * 同一次评测只能用同一个评测模型：不同模型给的分数和判断不能互相比，拿它们做除法、算比例没有意义。
 * @param {string} capability
 * @param {Set<string>} models 这次评测里这项能力报出过的模型名
 * @throws {VoicePackError} evaluation_model_mismatch：出现了不止一个模型名。details.capability、details.models
 */
function assertSingleModel(capability, models) {
  if (models.size > 1) {
    throw new VoicePackError('evaluation_model_mismatch', `同一次评测里 ${capability} 给出了不止一个模型（${[...models].join('、')}），它们的结果不能互相比较`, {
      details: { capability, models: [...models] },
    });
  }
}

// ---------------------------------------------------------------- 文本比较（收音校验用）

/**
 * 文本规范化并分词：全角转半角、转小写；标点、符号、空白都只当分隔；撇号直接去掉（don't 就是 dont）。
 * 中文（汉字）和日文假名每个字一个词，其余文字（字母、数字）连在一起算一个词。
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeTranscript(text) {
  const normalized = String(text).normalize('NFKC').toLowerCase();
  const tokens = [];
  let word = '';
  for (const ch of normalized) {
    if (APOSTROPHES.includes(ch)) continue;
    if (isSeparator.test(ch)) {
      if (word) tokens.push(word);
      word = '';
    } else if (isCjkChar.test(ch)) {
      if (word) tokens.push(word);
      word = '';
      tokens.push(ch);
    } else if (isWordChar.test(ch)) {
      word += ch;
    } else if (word) {
      tokens.push(word);
      word = '';
    }
  }
  if (word) tokens.push(word);
  return tokens;
}

function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * 转写和已知文本的错误率：规范化分词后，编辑距离（替换、漏掉、多出各算一个）除以已知文本的词数。可以超过 1。
 * @param {string} reference 已知文本
 * @param {string} hypothesis 模型转写出来的文本
 * @returns {number}
 * @throws {VoicePackError} fidelity_input_invalid（不是字符串）、fidelity_text_empty（已知文本里一个词也没有，没法比）
 */
export function transcriptErrorRate(reference, hypothesis) {
  const { expected, heard } = tokenizePair(reference, hypothesis);
  return editDistance(expected, heard) / expected.length;
}

/** 核对两个输入都是字符串、已知文本里至少有一个词，分好词交回。transcriptErrorRate 和 openingErrorRate 共用。 */
function tokenizePair(reference, hypothesis) {
  for (const [name, value] of [['已知文本', reference], ['转写', hypothesis]]) {
    if (typeof value !== 'string') throw invalid(name, `${name}必须是字符串`);
  }
  const expected = tokenizeTranscript(reference);
  if (expected.length === 0) throw new VoicePackError('fidelity_text_empty', '已知文本里一个词也没有（空的，或者只有标点），没法拿它核对转写');
  return { expected, heard: tokenizeTranscript(hypothesis) };
}

/**
 * 收音校验只看开头多少个词：模型写出录音开头的这么多个词就够，不要整段原话。
 * 为什么：现成的文章（新闻朗读、书）做的包，模型的服务商会拦下「把整段原话写出来」的回答；
 * 只要开头几个词，同样的录音基本不再被拦。错一两个词仍然认得出「听到了」，换了音频、静音、没有音频的回答仍然过不了。
 * 7 是那次量出来的：5、6 个词只容得下错 1 个词（0.3 的线上），听到了的也常被作废；8 个词开始有回答被拦下；7 个词容得下错 2 个词，被拦下的也最少。
 */
export const OPENING_WORDS = 7;

/**
 * 开头的错误率：已知文本的头 OPENING_WORDS 个词，和模型写出来的头 OPENING_WORDS 个词，编辑距离除以已知文本这段开头的词数（已知文本不到这么多词，就是它全部的词数）。
 * 分词、算法同 transcriptErrorRate；模型多写了开头以外的话不看（写了全文也只比开头），少写了的每个词算错一个。
 * @param {string} reference 已知文本（整段，函数自己取开头）
 * @param {string} hypothesis 模型写出来的话（只写开头，或者写了全文，都行）
 * @returns {number} 已知文本有 OPENING_WORDS 个词以上时在 0 到 1 之间；不到这么多词时，模型多写的词也算错，可以超过 1。和 DEFAULT_MAX_ERROR_RATE 比
 * @throws {VoicePackError} fidelity_input_invalid（不是字符串）、fidelity_text_empty（已知文本里一个词也没有，没法比）
 */
export function openingErrorRate(reference, hypothesis) {
  const { expected, heard } = tokenizePair(reference, hypothesis);
  const opening = expected.slice(0, OPENING_WORDS);
  return editDistance(opening, heard.slice(0, OPENING_WORDS)) / opening.length;
}

// ---------------------------------------------------------------- 盲听

/**
 * 收音校验的默认阈值：模型写出来的开头（openingErrorRate）和已知文本的开头的错误率不超过它，才算模型听到了这段音频。
 *
 * 为什么先定 0.3：听到了的模型，对干净的几秒到几十秒语音，转写错误率通常在个位数百分点到一成多（人名、数字、同音字最容易错）；
 * 没听到的模型凭提示编出来的话，和已知文本几乎全不一样，错误率接近 1 甚至更高。0.3 离前者有余量，离后者很远。
 * 短句要小心：文本比 OPENING_WORDS 个词还短时，开头就是它的全部，错两个词（6 个词里错 2 个，0.33）就超过 0.3，所以留出录音的文本不宜太短。
 * 用公开语料标定过，2026-10-19 用现在的提示（只比开头）重收了一遍，取值不变（依据见文件头「怎么读这份报告」第 5 点）。
 */
export const DEFAULT_MAX_ERROR_RATE = 0.3;

/**
 * 问盲听三个问题用的提示：先让模型写出每段音频开头的 OPENING_WORDS 个词（收音校验用；要整段原话会被模型的服务商拦下，见 OPENING_WORDS 的说明），再问三件事。
 * 不写任何关于哪段是真人的信息，也不写已知文本。
 */
export const BLIND_PROMPT = [
  '你会听到两段音频，依次标为 X 和 Y。请只根据你听到的内容回答。',
  '',
  `先写出每段音频开头的 ${OPENING_WORDS} 个词，只写听到的字，不要改写、不要补充；中文、日文每个字算一个词，别的语言按空格分词；没有听到某段音频，就把它的转写留空。`,
  '然后回答三个问题：',
  '1. 两段是不是同一个人在说话？',
  '2. 哪一段更像是合成的（AI 生成的声音）？必须在 X 和 Y 里选一个。',
  '3. 两段在音色、口音、情绪、节奏、读音上有什么区别？用一段话说明；没有明显区别就写「没有明显区别」。',
  '',
  '只输出一个 JSON 对象，不要输出别的文字。格式如下（same_speaker 是 true 或 false，synthetic 是 "X" 或 "Y"）：',
  '{"transcript_x": "…", "transcript_y": "…", "same_speaker": true, "synthetic": "X", "differences": "…"}',
].join('\n');

// 整段回答就是一个 ``` 代码块
const FENCED = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;

/**
 * 把模型按固定格式给的回答解析出来。整段回答必须是一个 JSON 对象（可以包在一个代码块里），字段、类型、取值都对得上；
 * 对不上就报错，不猜。
 * @param {string} reply 模型回答的文字
 * @param {number} [order] 这是第几次问，写进报错里
 * @returns {{ transcriptX: string, transcriptY: string, sameSpeaker: boolean, synthetic: 'X'|'Y', differences: string }}
 * @throws {VoicePackError} blind_answer_invalid：回答不符合固定格式，这次盲听作废。details.reason 说哪里不对，details.reply 是原话的前 300 个字符，details.order 是第几次问
 */
export function parseBlindAnswer(reply, order) {
  const fail = (reason) =>
    new VoicePackError(
      'blind_answer_invalid',
      `盲听作废：${order ? `第 ${order} 次问的时候，` : ''}模型的回答不符合固定格式（${reason}），不猜，这次不算数`,
      { details: { ...(order ? { order } : {}), reason, reply: String(reply).slice(0, 300) } },
    );
  let body = String(reply).trim();
  const fenced = FENCED.exec(body);
  if (fenced) body = fenced[1].trim();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw fail('不是 JSON');
  }
  if (!isPlainObject(data)) throw fail('不是 JSON 对象');
  for (const key of ['transcript_x', 'transcript_y', 'differences']) {
    if (typeof data[key] !== 'string') throw fail(`${key} 必须是字符串`);
  }
  if (typeof data.same_speaker !== 'boolean') throw fail('same_speaker 必须是 true 或 false');
  const slot = typeof data.synthetic === 'string' ? data.synthetic.trim().toUpperCase() : '';
  if (slot !== 'X' && slot !== 'Y') throw fail('synthetic 必须是 "X" 或 "Y"');
  return { transcriptX: data.transcript_x, transcriptY: data.transcript_y, sameSpeaker: data.same_speaker, synthetic: slot, differences: data.differences };
}

function assertBlindClip(clip, name) {
  if (!isPlainObject(clip)) throw invalid(name, `${name} 必须是 { audio, text, kind }`);
  assertAudioClip(clip.audio, `${name}.audio`);
  if (typeof clip.text !== 'string') throw invalid(`${name}.text`, `${name}.text 必须是字符串（这段音频里说的话）`);
  if (tokenizeTranscript(clip.text).length === 0) {
    throw new VoicePackError('fidelity_text_empty', `${name}.text 里一个词也没有（空的，或者只有标点），没法拿它核对转写`, { details: { field: `${name}.text` } });
  }
  if (clip.kind !== 'real' && clip.kind !== 'synthetic') throw invalid(`${name}.kind`, `${name}.kind 必须是 "real" 或 "synthetic"`);
}

/** 核对盲听的选项，省略的用默认值。measureFidelity 也在开始前调它，免得量了一半才发现选项不对。 */
function normalizeBlindOptions(options) {
  const { random = Math.random, maxErrorRate = DEFAULT_MAX_ERROR_RATE, firstX, designSource = false } = options ?? {};
  if (typeof random !== 'function') throw invalid('random', 'random 必须是返回 [0, 1) 的函数');
  if (typeof maxErrorRate !== 'number' || !Number.isFinite(maxErrorRate) || maxErrorRate < 0) throw invalid('maxErrorRate', 'maxErrorRate 必须是不小于 0 的数');
  if (firstX !== undefined && firstX !== 'a' && firstX !== 'b') throw invalid('firstX', 'firstX 必须是 "a" 或 "b"（第一次问的时候放在 X 的是哪一段）');
  if (typeof designSource !== 'boolean') throw invalid('designSource', 'designSource 必须是 true 或 false（素材是不是设计出来的：清单里有 designSource 就是 true，没有就是 false，见 lib/fidelity.mjs 文件头第 10 点）');
  return { random, maxErrorRate, firstX, designSource };
}

/** 抽一次随机数，决定第一次问的时候哪一段放在 X：小于 0.5 是 a，否则是 b。 */
function drawFirstX(random) {
  const value = random();
  if (typeof value !== 'number' || !(value >= 0 && value < 1)) throw invalid('random', '注入的随机数必须返回 [0, 1) 里的数');
  return value < 0.5 ? 'a' : 'b';
}

/**
 * 一次盲听：把一段真人录音和一段生成的录音（也可以是别的两段，见 kind）打乱成 X、Y 交给 audio-text-to-text，
 * 不告诉它哪段是真人；先让它写出两段开头的话做收音校验（只比开头 OPENING_WORDS 个词，见 openingErrorRate），再问三件事；换序再问一遍。
 *
 * 结果：
 *   asks[]            每次问的记录：order（第几次）、x 和 y（是 a 还是 b）、transcripts、errorRates、sameSpeaker、
 *                     syntheticSlot（模型说哪个位置是合成的）、picked（它指的是 a 还是 b）、differences（它说出来的区别）、model
 *   identified        两次问里认出合成那一段的次数（0–2）；两段不是「一真一假」时没有这回事，是 null
 *   sameSpeaker       两次问里判成同一个人的次数（0–2）
 *   consistent        两次指向的是同一段录音（换了位置，答案还跟着那一段走）
 *   models            用到的模型名（能力返回里带的），给验证记录用
 *
 * @capability audio-text-to-text 签名见 vocab/capability-signatures.md：({ parts: [{ text } | { audio }], ... }) -> { text, model? }
 * @param {object} env 注入的运行环境，要有 audio-text-to-text
 * @param {{ a: Clip, b: Clip }} trial 两段录音。Clip = { audio: {bytes, mimeType}, text: 这段音频里说的话, kind: 'real' | 'synthetic' }
 * @param {{ random?: () => number, maxErrorRate?: number, firstX?: 'a' | 'b' }} [options] random：返回 [0, 1) 的随机数，注入它测试才能固定顺序，省略用 Math.random；
 *   maxErrorRate：收音校验的阈值，省略用 DEFAULT_MAX_ERROR_RATE；
 *   firstX：第一次问的时候放在 X 的是 a 还是 b。给了就不抽随机数（补做沿用第一次的顺序用），省略就抽一次
 * @throws {VoicePackError} capability_missing（点名缺 audio-text-to-text）、listening_check_failed、blind_answer_invalid、provider_blocked（能力报的，原样往上抛）、
 *   capability_result_invalid，输入不对时的 fidelity_input_invalid、audio_clip_invalid、fidelity_text_empty
 */
export async function blindListen(env, trial, options = {}) {
  if (!isPlainObject(trial)) throw invalid('trial', 'trial 必须是 { a, b }');
  assertBlindClip(trial.a, 'a');
  assertBlindClip(trial.b, 'b');
  const { random, maxErrorRate, firstX } = normalizeBlindOptions(options);
  const first = firstX ?? drawFirstX(random);
  const listen = requireCapability(env, 'audio-text-to-text');

  const clips = { a: trial.a, b: trial.b };
  const orders = first === 'a' ? [['a', 'b'], ['b', 'a']] : [['b', 'a'], ['a', 'b']];
  const asks = [];
  for (const [index, [x, y]] of orders.entries()) {
    const order = index + 1;
    const reply = await listen({
      parts: [{ text: BLIND_PROMPT }, { text: '音频 X：' }, { audio: clips[x].audio }, { text: '音频 Y：' }, { audio: clips[y].audio }],
    });
    if (!isPlainObject(reply) || typeof reply.text !== 'string') throw badResult('audio-text-to-text', '必须返回 { text: 字符串, model?: 字符串 }');
    if (reply.model !== undefined && typeof reply.model !== 'string') throw badResult('audio-text-to-text', 'model 必须是字符串');
    const answer = parseBlindAnswer(reply.text, order);
    // 收音校验：每一段音频开头的转写都要和它自己的已知文本的开头对得上，对不上就是模型没听到，这次作废
    const errorRates = { x: openingErrorRate(clips[x].text, answer.transcriptX), y: openingErrorRate(clips[y].text, answer.transcriptY) };
    for (const [slot, clip] of [['X', x], ['Y', y]]) {
      const errorRate = errorRates[slot.toLowerCase()];
      if (errorRate > maxErrorRate) {
        throw new VoicePackError(
          'listening_check_failed',
          `盲听作废：第 ${order} 次问的时候，模型对音频 ${slot} 开头的转写和已知文本的开头对不上（错误率 ${errorRate.toFixed(2)}，上限 ${maxErrorRate}），说明它没有听到这段音频`,
          { details: { order, slot, clip, errorRate, maxErrorRate } },
        );
      }
    }
    asks.push({
      order,
      x,
      y,
      transcripts: { x: answer.transcriptX, y: answer.transcriptY },
      errorRates,
      sameSpeaker: answer.sameSpeaker,
      syntheticSlot: answer.synthetic,
      picked: answer.synthetic === 'X' ? x : y,
      differences: answer.differences,
      ...(reply.model === undefined ? {} : { model: reply.model }),
    });
  }
  const gradable = [trial.a.kind, trial.b.kind].filter((kind) => kind === 'synthetic').length === 1;
  for (const ask of asks) ask.identified = gradable ? clips[ask.picked].kind === 'synthetic' : null;
  const models = new Set(asks.map((ask) => ask.model).filter((model) => model !== undefined));
  assertSingleModel('audio-text-to-text', models);
  return {
    asks,
    identified: gradable ? asks.filter((ask) => ask.identified).length : null,
    sameSpeaker: asks.filter((ask) => ask.sameSpeaker).length,
    consistent: asks[0].picked === asks[1].picked,
    models: [...models],
  };
}

// ---------------------------------------------------------------- 量不了

/** 报告里「这一项没量出来」的写法：不给假分数，写明原因，缺能力时点名缺的能力。 */
export const UNMEASURABLE_LABEL = '量不了';

function unmeasurable(reason, message, capability) {
  return { status: 'unmeasurable', label: UNMEASURABLE_LABEL, reason, ...(capability === undefined ? {} : { capability }), message: `${UNMEASURABLE_LABEL}：${message}` };
}

/** 环境有没有这项能力。只认 capability_missing；环境本身不合格等其他错误照常抛出。 */
function probeCapability(env, name) {
  try {
    requireCapability(env, name);
    return { available: true };
  } catch (error) {
    if (isVoicePackError(error, 'capability_missing')) return { available: false, error };
    throw error;
  }
}

const unmeasurableForMissing = (name, error) => unmeasurable('capability_missing', error.message, name);

// ---------------------------------------------------------------- 说话人相似度

/**
 * 两段音频的说话人相似度。
 * @capability speaker-verification 签名见 vocab/capability-signatures.md：({ audio_a, audio_b }) -> { similarity, model? }
 * @param {object} env 注入的运行环境，要有 speaker-verification
 * @param {{bytes: Uint8Array, mimeType: string}} audioA
 * @param {{bytes: Uint8Array, mimeType: string}} audioB
 * @returns {Promise<{ similarity: number, model?: string }>}
 * @throws {VoicePackError} capability_missing（点名缺 speaker-verification）、audio_clip_invalid、capability_result_invalid
 */
export async function speakerSimilarity(env, audioA, audioB) {
  assertAudioClip(audioA, 'audio_a');
  assertAudioClip(audioB, 'audio_b');
  const verify = requireCapability(env, 'speaker-verification');
  const result = await verify({ audio_a: audioA, audio_b: audioB });
  if (!isPlainObject(result) || typeof result.similarity !== 'number' || !Number.isFinite(result.similarity)) {
    throw badResult('speaker-verification', '必须返回 { similarity: 有限的数, model?: 字符串 }');
  }
  if (result.model !== undefined && typeof result.model !== 'string') throw badResult('speaker-verification', 'model 必须是字符串');
  return { similarity: result.similarity, ...(result.model === undefined ? {} : { model: result.model }) };
}

/**
 * 真人基线：同一个评测模型下，同一个人的真录音两两之间的相似度，取平均。
 * 包里有几段真录音（参考和留出录音）就都用上，两两各算一次。
 * 有一段真录音里没有能嵌声纹的语音（说话人验证报 no_speech，写法见 vocab/capability-signatures.md）：基线不用它，
 * 别的真录音两两照算，这一段记在返回值的 excluded 里（带着能力报错的原样，和 recordings 里给的 role）；发现以后不再为它调用能力。
 * @param {object} env 注入的运行环境，要有 speaker-verification
 * @param {{ id: string, audio: {bytes: Uint8Array, mimeType: string}, role?: string }[]} recordings 同一个人的真录音，至少两段。
 *   role 只是原样带进 excluded（measureFidelity 给 'reference' 或 'holdout'），库不看它
 * @returns {Promise<{ status: 'measured', value: number, pairs: { a: string, b: string, similarity: number }[], excluded?: { id: string, role?: string, error: object }[], model?: string }>}
 *   excluded 只在有没用上的真录音时才有
 * @throws {VoicePackError} baseline_needs_two_recordings（不到两段，或者去掉嵌不出声纹的以后凑不出一对。details.recordings 是能用的段数，
 *   去掉过录音的话 details.excluded 是被去掉的）、evaluation_model_mismatch、capability_missing、audio_clip_invalid、capability_result_invalid
 */
export async function humanBaseline(env, recordings) {
  if (!Array.isArray(recordings)) throw invalid('recordings', 'recordings 必须是数组：[{ id, audio }]');
  recordings.forEach((recording, index) => {
    if (!isPlainObject(recording) || typeof recording.id !== 'string' || recording.id === '') {
      throw invalid(`recordings[${index}].id`, `recordings[${index}] 必须是 { id: 非空字符串, audio }`);
    }
    assertAudioClip(recording.audio, `recordings[${index}].audio`);
  });
  if (recordings.length < 2) {
    throw new VoicePackError('baseline_needs_two_recordings', `真人基线要同一个人至少两段真录音才能凑成一对，现在只有 ${recordings.length} 段`, { details: { recordings: recordings.length } });
  }
  const pairs = [];
  const models = new Set();
  const excludedAt = new Map(); // 第几段 -> { id, role?, error }
  for (let i = 0; i < recordings.length; i++) {
    for (let j = i + 1; j < recordings.length; j++) {
      if (excludedAt.has(i) || excludedAt.has(j)) continue;
      try {
        const { similarity, model } = await speakerSimilarity(env, recordings[i].audio, recordings[j].audio);
        pairs.push({ a: recordings[i].id, b: recordings[j].id, similarity });
        if (model !== undefined) models.add(model);
      } catch (error) {
        if (!isNoSpeechError(error)) throw error;
        // 能力一次只报一路（两路都嵌不出时先报 audio_a）：另一路还没验过，后面碰到它自己时会发现
        const at = error.details.field === 'audio_a' ? i : j;
        excludedAt.set(at, { id: recordings[at].id, ...(recordings[at].role === undefined ? {} : { role: recordings[at].role }), error: summarizeError(error) });
      }
    }
  }
  const excluded = [...excludedAt].sort(([a], [b]) => a - b).map(([, entry]) => entry);
  if (pairs.length === 0) {
    const usable = recordings.length - excluded.length;
    throw new VoicePackError(
      'baseline_needs_two_recordings',
      `真人基线要同一个人至少两段真录音才能凑成一对，现在${excluded.length > 0 ? `${recordings.length} 段里 ${excluded.length} 段没有能嵌声纹的语音，只剩` : '只有'} ${usable} 段`,
      { details: { recordings: usable, ...(excluded.length > 0 ? { excluded } : {}) } },
    );
  }
  assertSingleModel('speaker-verification', models);
  return { status: 'measured', value: mean(pairs.map((pair) => pair.similarity)), pairs, ...(excluded.length > 0 ? { excluded } : {}), ...(models.size === 1 ? { model: [...models][0] } : {}) };
}

// ---------------------------------------------------------------- 报告

function normalizeLabels(labels, where) {
  if (labels === undefined) return {};
  if (!isPlainObject(labels)) throw invalid(`${where}.labels`, `${where}.labels 必须是 { 标签名: 取值 } 对象`);
  const out = {};
  for (const [key, value] of Object.entries(labels)) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw invalid(`${where}.labels.${key}`, `${where}.labels.${key} 必须是字符串、数字或布尔值`);
    out[key] = String(value);
  }
  return out;
}

/**
 * 核对并整理报告的输入。音频必须是 { bytes, mimeType }；id 在参考和留出录音之间不能重复。
 * only：补做用。给一组留出录音的 id，就只核对这几条留出录音（原来是第几个，报错里就写第几个），参考和别的留出录音都不看。
 */
function normalizeFidelityInput(input, { only } = {}) {
  if (!isPlainObject(input)) throw invalid('input', '输入必须是 { references, holdouts } 对象');
  const { references = [], holdouts = [] } = input;
  if (!Array.isArray(references)) throw invalid('references', 'references 必须是数组');
  if (!Array.isArray(holdouts)) throw invalid('holdouts', 'holdouts 必须是数组');
  const seen = new Set();
  const take = (item, where, { needsText }) => {
    if (!isPlainObject(item)) throw invalid(where, `${where} 必须是对象`);
    if (typeof item.id !== 'string' || item.id === '') throw invalid(`${where}.id`, `${where}.id 必须是非空字符串`);
    if (seen.has(item.id)) throw invalid(`${where}.id`, `${where}.id「${item.id}」重复了：参考和留出录音的 id 不能重名`);
    seen.add(item.id);
    assertAudioClip(item.audio, `${where}.audio`);
    if (needsText) {
      if (typeof item.text !== 'string') throw invalid(`${where}.text`, `${where}.text 必须是字符串（这段音频里说的话）`);
      if (tokenizeTranscript(item.text).length === 0) {
        throw new VoicePackError('fidelity_text_empty', `${where}.text 里一个词也没有（空的，或者只有标点），没法拿它核对转写`, { details: { field: `${where}.text` } });
      }
    }
    return { id: item.id, audio: item.audio, text: item.text, labels: normalizeLabels(item.labels, where) };
  };
  const wanted = (item) => only === undefined || (isPlainObject(item) && only.has(item.id));
  return {
    references: only === undefined ? references.map((item, index) => take(item, `references[${index}]`, { needsText: false })) : [],
    holdouts: holdouts.flatMap((item, index) => {
      if (!wanted(item)) return [];
      const taken = take(item, `holdouts[${index}]`, { needsText: true });
      assertAudioClip(item.generated, `holdouts[${index}].generated`);
      return [{ ...taken, generated: item.generated }];
    }),
  };
}

// 作废：开头的转写和已知文本的开头对不上，回答不是固定格式，或回答被模型的服务商拦下（能力抛 provider_blocked）。别的错误（输入不对、401……）不算作废，照常抛出。
const VOIDING_CODES = ['listening_check_failed', 'blind_answer_invalid', 'provider_blocked'];
/** 作废里被模型的服务商拦下的那一种：另外数条数（blocked）。 */
const BLOCKED_CODE = 'provider_blocked';

// ---------------------------------------------------------------- 没听成

/** 报告里「这一项因为服务出错没做成」的写法。和「作废」「量不了」「量不到」是四回事，见文件头「怎么读这份报告」第 6、9 点。 */
export const NOT_HEARD_LABEL = '没听成';

/** 报告里「这一条的说话人相似度没有数：有一段录音里没有能嵌声纹的语音」的写法。第 9 点。 */
export const NO_SPEECH_LABEL = '量不到';

/**
 * 说话人验证报的是不是「这段录音里没有能嵌的语音」：标准写法（vocab/capability-signatures.md 的 speaker-verification 一节）是
 * capability_input_invalid，details 是 { capability: 'speaker-verification', field: 'audio_a' 或 'audio_b', problem: 'no_speech' }。
 * 库只认这一个写法：别的码（能力自己起的）、没写明是哪一路的，都不是，照常往上抛。
 * 导出给挑默认参考段用（lib/make-pack-pick.mjs）：同一个写法，同一处判断。
 */
export function isNoSpeechError(error) {
  return (
    isVoicePackError(error, 'capability_input_invalid') &&
    error.details?.capability === 'speaker-verification' &&
    error.details?.problem === 'no_speech' &&
    (error.details?.field === 'audio_a' || error.details?.field === 'audio_b')
  );
}

/**
 * 一项没听成的记录。item 是 'blind-listening' 或 'speaker-similarity'；attempts 是这一项一共试了几次（第一次量就是 1，每补做一次加 1）。
 * 库自己不重试：建任务和补全可能已经计费，要不要补做由调用方定（redoNotHeard）。
 */
const notHeardRecord = (item, error, attempts, extra = {}) => ({ status: 'not_heard', label: NOT_HEARD_LABEL, item, error: summarizeError(error), attempts, ...extra });

/** 把各条里没听成的项摘出来，按留出录音的先后，同一条里先说话人相似度、后盲听。 */
function listNotHeard(items) {
  return items.flatMap((item) =>
    ['speakerSimilarity', 'blindListening']
      .map((key) => item[key])
      .filter((part) => part?.status === 'not_heard')
      .map((part) => ({ id: item.id, item: part.item, error: part.error, attempts: part.attempts })),
  );
}

/** 把各条里盲听作废的摘出来，按留出录音的先后。 */
const listVoided = (items) => items.flatMap((item) => (item.blindListening?.status === 'voided' ? [{ id: item.id, error: item.blindListening.error }] : []));

/**
 * 一条留出录音的说话人相似度「量不到」的记录：which 是嵌不出声纹的那一段（'generated' 生成的、'holdout' 留出的），error 是能力报错的原样
 * （{ code, message, details }，summarizeError 的形状）。
 * 同一段录音再量还是一样，所以没有 attempts，补做也不算它（planRedo、redoNotHeard 都不碰）。
 */
const noSpeechRecord = (errorRecord, which) => ({ status: 'no_speech', label: NO_SPEECH_LABEL, item: 'speaker-similarity', which, error: errorRecord });

/** 把各条里说话人相似度量不到的摘出来，按留出录音的先后。 */
const listNoSpeech = (items) =>
  items.flatMap((item) => (item.speakerSimilarity?.status === 'no_speech' ? [{ id: item.id, item: item.speakerSimilarity.item, which: item.speakerSimilarity.which, error: item.speakerSimilarity.error }] : []));

// ---------------------------------------------------------------- 一条留出录音的一项怎么量（measureFidelity 和 redoNotHeard 共用）

/**
 * 一条留出录音的说话人相似度这一项：量出来了是 measured；有一段录音里没有能嵌声纹的语音是 no_speech（量不到）；
 * 碰到服务暂时出错是 not_heard（attempts：这是第几次试）；别的错误照常抛出。
 * @returns {Promise<{ speakerSimilarity: object, model?: string }>}
 */
async function measureSpeakerItem(env, holdout, baselineValue, attempts) {
  try {
    const { similarity, model } = await speakerSimilarity(env, holdout.generated, holdout.audio);
    return { speakerSimilarity: { status: 'measured', similarity, ratio: baselineValue > 0 ? similarity / baselineValue : null }, model };
  } catch (error) {
    if (isNoSpeechError(error)) return { speakerSimilarity: noSpeechRecord(summarizeError(error), error.details.field === 'audio_a' ? 'generated' : 'holdout') };
    if (!isServiceError(error)) throw error;
    return { speakerSimilarity: notHeardRecord('speaker-similarity', error, attempts) };
  }
}

/**
 * 一条留出录音的盲听这一项：量出来了是 measured；收音校验没过、回答格式不对或被模型的服务商拦下（provider_blocked）是 voided；碰到服务暂时出错是 not_heard（记着 firstX，补做时沿用）；
 * 别的错误照常抛出。被拦下的不是服务暂时出错（适配器不标 transient）：同一段录音再问还是被拦，补做也没用。
 * @returns {Promise<{ blindListening: object, models: string[] }>}
 */
async function measureBlindItem(env, holdout, { firstX, maxErrorRate }, attempts) {
  const trial = { a: { audio: holdout.audio, text: holdout.text, kind: 'real' }, b: { audio: holdout.generated, text: holdout.text, kind: 'synthetic' } };
  try {
    const result = await blindListen(env, trial, { maxErrorRate, firstX });
    return {
      blindListening: { status: 'measured', identified: result.identified, sameSpeaker: result.sameSpeaker, consistent: result.consistent, models: result.models, asks: result.asks },
      models: result.models,
    };
  } catch (error) {
    if (isServiceError(error)) return { blindListening: notHeardRecord('blind-listening', error, attempts, { firstX }), models: [] };
    if (VOIDING_CODES.some((code) => isVoicePackError(error, code))) return { blindListening: { status: 'voided', label: '作废', error: summarizeError(error) }, models: [] };
    throw error;
  }
}

// ---------------------------------------------------------------- 汇总

/**
 * 把若干条留出录音的说话人相似度合成一个总的或一组的结果。比值只按量出来的算；没听成的条数（notHeard）、量不到的条数（noSpeech）各自单独报。
 * 一条量出来的都没有：不给假的平均，也不当成 0；有没听成的，就说没听成（补做也许能量出来），否则全是量不到。
 */
function aggregateSpeaker(members, baseline) {
  const heard = members.filter((item) => item.speakerSimilarity.status === 'measured');
  const noSpeech = members.filter((item) => item.speakerSimilarity.status === 'no_speech').length;
  const notHeard = members.length - heard.length - noSpeech;
  if (heard.length === 0) {
    return noSpeech > 0 && notHeard === 0 ? { status: 'no_speech', label: NO_SPEECH_LABEL, n: 0, notHeard, noSpeech } : { status: 'not_heard', label: NOT_HEARD_LABEL, n: 0, notHeard, noSpeech };
  }
  const meanSimilarity = mean(heard.map((item) => item.speakerSimilarity.similarity));
  return { status: 'measured', n: heard.length, notHeard, noSpeech, meanSimilarity, ratio: meanSimilarity / baseline.value };
}

/**
 * 把若干条留出录音的盲听结果合成一个总的或一组的结果。
 * 认出合成的比例 = 认出合成的那一次数 / 问过的次数（每条问两次；它不是分数，别按「越接近 0.5 越好」读，见文件头「怎么读这份报告」）；
 * 判成同一人的比例 = 判成同一人的次数 / 问过的次数；前后一致的比例 = 两次指向同一段录音的条数 / 有效条数。
 * 作废的条数（voided）、没听成的条数（notHeard）各自单独报，都不计入这些比例。作废里被模型的服务商拦下的条数（blocked）另外数，是 voided 的一部分。
 * @param {{ id: string, blind: object }[]} entries blind 是每一条的盲听结果（measured、voided 或 not_heard）
 */
function aggregateBlind(entries) {
  const valid = entries.filter((entry) => entry.blind.status === 'measured');
  const voided = entries.filter((entry) => entry.blind.status === 'voided').length;
  const blocked = entries.filter((entry) => entry.blind.status === 'voided' && entry.blind.error?.code === BLOCKED_CODE).length;
  const notHeard = entries.filter((entry) => entry.blind.status === 'not_heard').length;
  // 一条有效的都没有：有没听成的，就说没听成（补做也许能量出来）；否则全是作废
  if (valid.length === 0) return { status: notHeard > 0 ? 'not_heard' : 'voided', label: notHeard > 0 ? NOT_HEARD_LABEL : '作废', trials: 0, voided, blocked, notHeard, asks: 0 };
  const total = (pick) => valid.reduce((sum, entry) => sum + pick(entry.blind), 0);
  const asks = total((blind) => blind.asks.length);
  return {
    status: 'measured',
    trials: valid.length,
    voided,
    blocked,
    notHeard,
    asks,
    identified: total((blind) => blind.identified),
    identifiedRate: total((blind) => blind.identified) / asks,
    sameSpeaker: total((blind) => blind.sameSpeaker),
    sameSpeakerRate: total((blind) => blind.sameSpeaker) / asks,
    consistent: total((blind) => (blind.consistent ? 1 : 0)),
    consistentRate: total((blind) => (blind.consistent ? 1 : 0)) / valid.length,
    differences: valid.flatMap((entry) => entry.blind.asks.map((ask) => ({ id: entry.id, order: ask.order, text: ask.differences }))),
  };
}

/** 报告里的 models：这次评测里每项能力报出的那一个模型名（没取到的不写）。 */
const modelsOf = (speakerModel, blindModel) => ({
  ...(speakerModel === undefined ? {} : { 'speaker-verification': speakerModel }),
  ...(blindModel === undefined ? {} : { 'audio-text-to-text': blindModel }),
});

/**
 * 由各条的结果拼出整份报告。measureFidelity 和 redoNotHeard 都走这里，所以补做以后的报告和一次做完的报告形状一样、顺序一样。
 * speakerUnmeasurable、blindUnmeasurable：这一类整个量不了（缺能力、没有留出录音、真人基线不够……）时的那条「量不了」，
 * 每一组和总体都报它；没有就是 null。referenceCount(key, value)：参考集里带这个标签取值的有几段。
 */
function buildReport({ counts, models, baseline, items, referenceCount, speakerUnmeasurable, blindUnmeasurable, designSource = false }) {
  const speakerOf = (members) => speakerUnmeasurable ?? aggregateSpeaker(members, baseline);
  const blindOf = (members) => blindUnmeasurable ?? aggregateBlind(members.map((item) => ({ id: item.id, blind: item.blindListening })));
  // 按标签分组：有什么标签就分什么，先按标签名、再按取值排好
  const groups = [];
  for (const key of [...new Set(items.flatMap((item) => Object.keys(item.labels)))].sort()) {
    for (const value of [...new Set(items.map((item) => item.labels[key]).filter((v) => v !== undefined))].sort()) {
      const members = items.filter((item) => item.labels[key] === value);
      groups.push({ key, value, holdouts: members.length, references: referenceCount(key, value), speakerSimilarity: speakerOf(members), blindListening: blindOf(members) });
    }
  }
  return {
    counts,
    models,
    baseline,
    designSource,
    overall: { holdouts: items.length, speakerSimilarity: speakerOf(items), blindListening: blindOf(items) },
    groups,
    items,
    voided: listVoided(items),
    notHeard: listNotHeard(items),
    noSpeech: listNoSpeech(items),
  };
}

/**
 * 真人基线，或者「量不了」：嵌不出声纹的真录音去掉以后凑不出一对，是真录音的事，不是环境坏了，说话人相似度整体报「量不了」
 * （reason: not_enough_real_recordings，说明里写着几段里几段、是哪几段嵌不出；excluded 原样带着）。别的错误照常抛出。
 * @returns {Promise<object>} humanBaseline 的返回值，或者 unmeasurable 的记录
 */
async function baselineOrUnmeasurable(env, real) {
  try {
    return await humanBaseline(env, real);
  } catch (error) {
    if (!isVoicePackError(error, 'baseline_needs_two_recordings') || !Array.isArray(error.details?.excluded)) throw error;
    const { recordings: usable, excluded } = error.details;
    const which = excluded.map((entry) => entry.id).join('、');
    return { ...unmeasurable('not_enough_real_recordings', `真人基线要同一个人至少两段真录音，现在 ${real.length} 段里 ${excluded.length} 段（${which}）没有能嵌声纹的语音，只剩 ${usable} 段`), excluded };
  }
}

/**
 * 量还原度，出一份报告。两种方法都量，缺哪项评测能力，那一项就报「量不了」并点名缺的能力，别的照常。
 *
 * 说话人相似度：生成的录音和对应的留出录音之间的相似度，除以真人基线。
 * 盲听：见 blindListen。收音校验没过、回答不是固定格式、或回答被模型的服务商拦下（provider_blocked）的那一条作废，记在 voided 里，不计入比例，别的条照常。
 * 单条服务出错不让整份报告作废：某条留出录音的盲听或说话人相似度碰到服务暂时出错（能力在 details.transient 里标出来的，见 lib/capability-calls.mjs 的 isServiceError），
 *   这一项记成「没听成」（notHeard）：写明是哪项、错误码、试了几次，不计入任何比例，接着做下一条。库不自动重试
 *   （建任务和补全可能已经计费），要补做由调用方用 planRedo 看要花多少次调用，再用 redoNotHeard 只补做没听成的那几项。
 *   别的错误（缺能力的 capability_missing 除外，它在开始前就变成「量不了」）照常抛出：输入不对、401、返回的形状不对、没标成服务暂时出错的……
 * 某一段录音里没有能嵌声纹的语音（说话人验证报标准的 no_speech，见读法第 9 点）不是环境坏了：那一条的说话人相似度记成「量不到」
 *   （noSpeech，写明是生成的还是留出的那一段），不进比例，不能补做，别的条照常量。留出的真录音自己嵌不出时真人基线也不用它（baseline.excluded）；
 *   参考录音嵌不出也一样；剩下的真录音凑不出一对时，说话人相似度整体「量不了」（not_enough_real_recordings），盲听照做。
 * 分组：按留出录音的标签（情绪、风格、语言、能量等，有什么标签就分什么）一组一组报，每组带着参考集里有几段这个标签取值。
 *
 * @param {object} env 注入的运行环境：speaker-verification、audio-text-to-text 各自可选
 * @param {{
 *   references: { id: string, audio: AudioClip, text?: string, labels?: Record<string, string|number|boolean> }[],
 *   holdouts: { id: string, audio: AudioClip, text: string, labels?: Record<string, string|number|boolean>, generated: AudioClip }[],
 * }} input
 *   references：参考集里的真人原声；holdouts：留出录音，generated 是用这个包把 text 合成出来的录音。labels 是标签。
 * @param {{ random?: () => number, maxErrorRate?: number }} [options] random：每条盲听抽一次，决定第一次问的时候谁在 X；maxErrorRate：收音校验的阈值
 * @returns {Promise<object>} 报告，形状见文件头
 */
export async function measureFidelity(env, input, options = {}) {
  const { references, holdouts } = normalizeFidelityInput(input);
  const blindOptions = normalizeBlindOptions(options);
  // role 只是让基线说得清哪一段真录音没用上（humanBaseline 的 excluded），库不看它
  const real = [
    ...references.map(({ id, audio }) => ({ id, audio, role: 'reference' })),
    ...holdouts.map(({ id, audio }) => ({ id, audio, role: 'holdout' })),
  ];
  const verifier = probeCapability(env, 'speaker-verification');
  const listener = probeCapability(env, 'audio-text-to-text');
  const items = holdouts.map((holdout) => ({ id: holdout.id, labels: holdout.labels, speakerSimilarity: null, blindListening: null }));
  let speakerModel;
  let blindModel;

  // ---- 说话人相似度：真人基线 + 每一条生成的录音和它的留出录音的相似度
  let baseline;
  let speakerUnmeasurable = null;
  if (!verifier.available) {
    baseline = speakerUnmeasurable = unmeasurableForMissing('speaker-verification', verifier.error);
  } else if (holdouts.length === 0) {
    baseline = speakerUnmeasurable = unmeasurable('no_holdout_recordings', '没有留出录音，没有东西可以拿生成的录音去比');
  } else if (real.length < 2) {
    baseline = speakerUnmeasurable = unmeasurable('not_enough_real_recordings', `真人基线要同一个人至少两段真录音，现在只有 ${real.length} 段`);
  } else {
    baseline = await baselineOrUnmeasurable(env, real);
    if (baseline.status === 'unmeasurable') {
      speakerUnmeasurable = baseline;
    } else {
      // 基线没用上的留出录音是真录音自己嵌不出声纹：它那一条就是量不到，不再为它调用能力
      const silentHoldouts = new Map((baseline.excluded ?? []).filter((entry) => entry.role === 'holdout').map((entry) => [entry.id, entry.error]));
      const seenModels = new Set(baseline.model === undefined ? [] : [baseline.model]);
      for (const [index, holdout] of holdouts.entries()) {
        if (silentHoldouts.has(holdout.id)) {
          items[index].speakerSimilarity = noSpeechRecord(silentHoldouts.get(holdout.id), 'holdout');
          continue;
        }
        const { speakerSimilarity: part, model } = await measureSpeakerItem(env, holdout, baseline.value, 1);
        if (model !== undefined) seenModels.add(model);
        assertSingleModel('speaker-verification', seenModels);
        items[index].speakerSimilarity = part;
      }
      if (seenModels.size === 1) speakerModel = [...seenModels][0];
      if (!(baseline.value > 0)) speakerUnmeasurable = unmeasurable('baseline_not_positive', `真人基线是 ${baseline.value}，不是正数，没法拿它当分母`);
    }
  }

  // ---- 盲听：一条一条来，作废的、没听成的那一条记下来，其余照常
  let blindUnmeasurable = null;
  if (!listener.available) {
    blindUnmeasurable = unmeasurableForMissing('audio-text-to-text', listener.error);
  } else if (holdouts.length === 0) {
    blindUnmeasurable = unmeasurable('no_holdout_recordings', '没有留出录音，没有东西可以盲听');
  } else {
    const seenModels = new Set();
    for (const [index, holdout] of holdouts.entries()) {
      // 每条抽一次，出不出错都抽，后面的条的顺序才不会因为前面出错而变；抽到的记在没听成的记录里，补做时沿用
      const firstX = drawFirstX(blindOptions.random);
      const { blindListening: part, models } = await measureBlindItem(env, holdout, { firstX, maxErrorRate: blindOptions.maxErrorRate }, 1);
      models.forEach((model) => seenModels.add(model));
      assertSingleModel('audio-text-to-text', seenModels);
      items[index].blindListening = part;
    }
    if (seenModels.size === 1) blindModel = [...seenModels][0];
  }

  return buildReport({
    counts: { references: references.length, holdouts: holdouts.length, realRecordings: real.length },
    models: modelsOf(speakerModel, blindModel),
    baseline,
    items,
    referenceCount: (key, value) => references.filter((ref) => ref.labels[key] === value).length,
    speakerUnmeasurable,
    blindUnmeasurable,
    designSource: blindOptions.designSource,
  });
}

// ---------------------------------------------------------------- 补做没听成的

/** 一条盲听问几次：每条问两遍（换序再问一遍），和 blindListen 里的两种顺序对应。 */
const ASKS_PER_TRIAL = 2;
/** 一条里的每一项，用到哪项所需能力。 */
const CAPABILITY_OF = { 'blind-listening': 'audio-text-to-text', 'speaker-similarity': 'speaker-verification' };
/** 一条里的两个位置，各自放哪一项、可能是什么状态。 */
const REPORT_SLOTS = {
  speakerSimilarity: { item: 'speaker-similarity', statuses: ['measured', 'not_heard', 'no_speech'] },
  blindListening: { item: 'blind-listening', statuses: ['measured', 'voided', 'not_heard'] },
};

/**
 * 核对上一次的报告是 measureFidelity 出的形状（只核对要用到的），原样交回。
 * forRedo：补做要用的更多（基线、分组、总体、模型名），多核对几处；只算要补做什么（planRedo）时只看 items。
 * @throws {VoicePackError} fidelity_input_invalid：不是约定的形状。details.field 是出问题的字段，从 previous 起写
 */
function readPreviousReport(report, { forRedo = false } = {}) {
  const where = 'previous';
  if (!isPlainObject(report)) throw invalid(where, '上一次的报告必须是 measureFidelity 出的报告对象');
  if (!Array.isArray(report.items)) throw invalid(`${where}.items`, '上一次的报告缺 items（每条留出录音的结果）：它是 measureFidelity 出的报告吗');
  const seen = new Set();
  report.items.forEach((item, index) => {
    const at = `${where}.items[${index}]`;
    if (!isPlainObject(item) || typeof item.id !== 'string' || item.id === '') throw invalid(`${at}.id`, `${at}.id 必须是非空字符串`);
    if (seen.has(item.id)) throw invalid(`${at}.id`, `${at}.id「${item.id}」重复了`);
    seen.add(item.id);
    if (forRedo && !isPlainObject(item.labels)) throw invalid(`${at}.labels`, `${at}.labels 必须是 { 标签名: 取值 } 对象`);
    for (const [key, slot] of Object.entries(REPORT_SLOTS)) {
      const part = item[key];
      if (part === null) continue;
      if (!isPlainObject(part) || !slot.statuses.includes(part.status)) throw invalid(`${at}.${key}.status`, `${at}.${key}.status 必须是 ${slot.statuses.join('、')} 之一，或者整项是 null`);
      if (part.status !== 'not_heard') continue;
      if (part.item !== slot.item) throw invalid(`${at}.${key}.item`, `${at}.${key} 是没听成的记录，item 必须是 "${slot.item}"`);
      if (!isPlainObject(part.error)) throw invalid(`${at}.${key}.error`, `${at}.${key}.error 必须是没听成的原因（{ code, message, details }）`);
      if (!Number.isInteger(part.attempts) || part.attempts < 1) throw invalid(`${at}.${key}.attempts`, `${at}.${key}.attempts 必须是不小于 1 的整数（这一项试了几次）`);
      if (part.firstX !== undefined && part.firstX !== 'a' && part.firstX !== 'b') throw invalid(`${at}.${key}.firstX`, `${at}.${key}.firstX 必须是 "a" 或 "b"`);
    }
  });
  if (forRedo) {
    for (const key of ['counts', 'models', 'baseline', 'overall']) {
      if (!isPlainObject(report[key])) throw invalid(`${where}.${key}`, `上一次的报告缺 ${key}：它是 measureFidelity 出的报告吗`);
    }
    if (!Array.isArray(report.groups)) throw invalid(`${where}.groups`, '上一次的报告缺 groups（按标签分的组）：它是 measureFidelity 出的报告吗');
    for (const key of Object.keys(REPORT_SLOTS)) {
      if (!isPlainObject(report.overall[key])) throw invalid(`${where}.overall.${key}`, `上一次的报告缺 overall.${key}`);
    }
    const needsBaseline = report.items.some((item) => item.speakerSimilarity?.status === 'not_heard');
    if (needsBaseline && !(report.baseline.status === 'measured' && Number.isFinite(report.baseline.value))) {
      throw invalid(`${where}.baseline`, '有说话人相似度没听成，但上一次的报告里没有量出来的真人基线：补做要拿它当分母');
    }
  }
  return report;
}

/** 从各条里算出要补做什么、各要调用多少次。 */
function planOf(items) {
  const entries = listNotHeard(items).map(({ id, item, attempts }) => ({ id, item, attempts }));
  const calls = {};
  for (const { item } of entries) {
    const capability = CAPABILITY_OF[item];
    calls[capability] = (calls[capability] ?? 0) + (item === 'blind-listening' ? ASKS_PER_TRIAL : 1);
  }
  return { items: entries, calls, total: Object.values(calls).reduce((sum, count) => sum + count, 0) };
}

/**
 * 补做没听成的那几项要花多少次调用：事先算清楚，调用方决定要不要补做、什么时候补做。只是算一算，不调用任何能力，不改报告。
 * @param {object} report 上一次的报告（measureFidelity 或 redoNotHeard 出的，存成 JSON 再读回来的也行）
 * @returns {{ items: { id: string, item: 'blind-listening' | 'speaker-similarity', attempts: number }[], calls: Record<string, number>, total: number }}
 *   items：要补做的项，按留出录音的先后，同一条里先说话人相似度、后盲听，attempts 是已经试了几次；
 *   calls：每项所需能力要调用几次（一条盲听 2 次，一条说话人相似度 1 次；一次也不用的能力不列）；total：合计
 * @throws {VoicePackError} fidelity_input_invalid：报告不是约定的形状
 */
export function planRedo(report) {
  return planOf(readPreviousReport(report).items);
}

/**
 * 补做：输入上一次的报告，只对没听成的那几项重新调用，输出合并以后的新报告。上一次的报告不改。
 * 已经量出来的、作废的、量不了的都原样保留，真人基线也不重算；补做成功的项和一次全成功的结果一样（顺序沿用第一次问的，
 * 所以同样的录音、同样的听者给出同样的回答时，合并以后的报告和一次做完的报告一模一样）；补做又失败的还是没听成，attempts 加 1。
 * 库不替调用方重试，也不会自己再补做一遍：调用几次由调用方定，先用 planRedo 看要花多少次。
 *
 * 要求：
 *   - input 里要有每一条要补做的留出录音（按 id 对上），用第一次那几条同样的录音和文本，和第一次那条生成的录音（generated）；
 *     别的留出录音和 references 不看，所以只给要补做的那几条也行。
 *   - 同一次评测只能用同一个评测模型：补做时能力报出的模型名和上一次不一样，抛 evaluation_model_mismatch。
 *   - options 同 measureFidelity，maxErrorRate 要和第一次一样（报告里没记，由调用方保证）。没听成的盲听记着第一次的顺序，不再抽随机数。
 *   - 先核对输入、再查缺不缺能力（缺的点名，抛 capability_missing），都过了才调用，不白花钱。
 *
 * @param {object} env 注入的运行环境：补做盲听要 audio-text-to-text，补做说话人相似度要 speaker-verification
 * @param {{ holdouts: object[] }} input 同 measureFidelity 的 input
 * @param {object} previous 上一次的报告
 * @param {{ random?: () => number, maxErrorRate?: number }} [options]
 * @returns {Promise<object>} 合并以后的新报告，形状同 measureFidelity
 * @throws {VoicePackError} fidelity_input_invalid（报告或输入不对，要补做的留出录音不在 input 里）、capability_missing、
 *   evaluation_model_mismatch，补做时的其他错误同 measureFidelity：没标成服务暂时出错的照常抛出，401 立即停
 */
export async function redoNotHeard(env, input, previous, options = {}) {
  readPreviousReport(previous, { forRedo: true });
  const blindOptions = normalizeBlindOptions(options);
  const report = structuredClone(previous);
  const plan = planOf(report.items);
  if (plan.total === 0) return report;

  const wanted = new Set(plan.items.map((entry) => entry.id));
  const byId = new Map(normalizeFidelityInput(input, { only: wanted }).holdouts.map((holdout) => [holdout.id, holdout]));
  for (const id of wanted) {
    if (!byId.has(id)) throw invalid('holdouts', `要补做的留出录音「${id}」不在给的 holdouts 里：补做要用第一次量的那几条同样的录音、文本和生成的录音`);
  }
  for (const capability of Object.keys(plan.calls)) requireCapability(env, capability);

  const speakerModels = new Set(report.models['speaker-verification'] === undefined ? [] : [report.models['speaker-verification']]);
  const blindModels = new Set(report.models['audio-text-to-text'] === undefined ? [] : [report.models['audio-text-to-text']]);
  // 说话人相似度先、盲听后，和 measureFidelity 的先后一样
  for (const item of report.items) {
    const record = item.speakerSimilarity;
    if (record?.status !== 'not_heard') continue;
    const { speakerSimilarity: part, model } = await measureSpeakerItem(env, byId.get(item.id), report.baseline.value, record.attempts + 1);
    if (model !== undefined) speakerModels.add(model);
    assertSingleModel('speaker-verification', speakerModels);
    item.speakerSimilarity = part;
  }
  for (const item of report.items) {
    const record = item.blindListening;
    if (record?.status !== 'not_heard') continue;
    const firstX = record.firstX ?? drawFirstX(blindOptions.random);
    const { blindListening: part, models } = await measureBlindItem(env, byId.get(item.id), { firstX, maxErrorRate: blindOptions.maxErrorRate }, record.attempts + 1);
    models.forEach((model) => blindModels.add(model));
    assertSingleModel('audio-text-to-text', blindModels);
    item.blindListening = part;
  }

  return buildReport({
    counts: report.counts,
    models: modelsOf(speakerModels.size === 1 ? [...speakerModels][0] : undefined, blindModels.size === 1 ? [...blindModels][0] : undefined),
    baseline: report.baseline,
    items: report.items,
    referenceCount: (key, value) => report.groups.find((group) => group.key === key && group.value === value)?.references ?? 0,
    // 整类量不了的（缺能力、没有留出录音、基线不够）原样带过来
    speakerUnmeasurable: report.overall.speakerSimilarity.status === 'unmeasurable' ? report.overall.speakerSimilarity : null,
    blindUnmeasurable: report.overall.blindListening.status === 'unmeasurable' ? report.overall.blindListening : null,
    // 补做沿用上一次的读法：设计来源的还是设计来源的（补做的报告和做完的一样）
    designSource: report.designSource === true,
  });
}

// ---------------------------------------------------------------- 随机数

/**
 * 确定性的伪随机数（mulberry32）：随机数由外部注入的场合用它固定顺序，例如命令行的 --seed，或标定时要复现一次盲听。
 * @param {number} seed 32 位整数
 * @returns {() => number} 每次返回 [0, 1) 里的数
 */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
