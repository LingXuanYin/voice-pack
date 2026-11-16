// SPDX-License-Identifier: Apache-2.0
//
// 超长的一段在句末切开（纯计算）：一段带台本的录音（设计出来的声音的表演段：照台本配出来的）比参考的上限（20 秒，tools/audio-quality.mjs 的
// REFERENCE_THRESHOLDS.duration.warnAbove）长，模型那边会把它截短、给的文字也不用了（models/scene3.md「Reference segments」）。配长了不重配：在句末切开用。
// 做包取音频那一步（lib/make-pack-take-audio.mjs）用它定切在哪。
//
//   sentenceEndCut(samples, sampleRate, script) -> endSec | null
//     samples 是单声道的采样（Float32Array），script 是这一段的台本（去掉提示的字）。返回切在第几秒（取到毫秒）；不用切（不超过上限）、切不了是 null。
//
// 规则：
//   - 要「留够做默认段的长度」：切口在 10 秒（MIN_SECONDS，references/character-voice.md「Default segment: a passage the character says naturally, with acting」：10 到 20 秒）和 20 秒之间，不短于 10 秒，不长于 20 秒。
//   - 停顿：低于这一段最响的 20 毫秒的电平 30 dB 以上、连续不短于 0.25 秒的一截静音，开头和结尾的静音不算。录音里没有句子的时间，转写也不给时间戳
//     （vocab/capability-signatures.md「automatic-speech-recognition」），所以句末按字数的比例估：台本分句（tools/sentences.mjs），每句句末的位置是
//     这句以前的字（字母和数字）占全部的比例乘整段的时长。
//   - 切在哪：10 到 20 秒之间最后一处停顿，从后往前看每个句末（最后一句的句末不算：它就是整段的结尾），估的位置不晚于那处停顿的第一个句末，
//     取离它 1.5 秒（ALIGN_SECONDS）以内的停顿里最长的（句末的停顿比逗号的长；一样长取离得近的），切在那处停顿的正中。
//     句末估得不准，所以靠停顿对齐；一个对得上的停顿都没有（一个句末也找不到停顿），或者只有一句，是 null：不切，照原样用，音质检查的 duration_long 照旧提醒。
//   - 切完留下的话（文字）不在这里定：做包照样转写切出来的这一段，逐字稿是听到的。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { windowLevels, WINDOW_SECONDS, REFERENCE_THRESHOLDS } from '../tools/audio-quality.mjs';
import { splitSentences } from '../tools/sentences.mjs';

export const MIN_SECONDS = 10;
export const MAX_SECONDS = REFERENCE_THRESHOLDS.duration.warnAbove;
const PAUSE_BELOW_DB = 30;
const PAUSE_MIN_SECONDS = 0.25;
const ALIGN_SECONDS = 1.5;

/** 停顿，按先后：{ at（正中，秒）, length（秒）}。开头、结尾的静音不算。 */
function pausesOf(samples, rate) {
  const levels = windowLevels([samples], rate);
  const size = Math.max(1, Math.round(rate * WINDOW_SECONDS));
  let loudest = -Infinity;
  for (const level of levels) if (level > loudest) loudest = level;
  const pauses = [];
  let start = null;
  for (let w = 0; w <= levels.length; w += 1) {
    const quiet = w < levels.length && levels[w] < loudest - PAUSE_BELOW_DB;
    if (quiet && start === null) start = w;
    if (!quiet && start !== null) {
      if ((w - start) * size >= PAUSE_MIN_SECONDS * rate && start > 0 && w < levels.length) pauses.push({ at: (((start + w) / 2) * size) / rate, length: ((w - start) * size) / rate });
      start = null;
    }
  }
  return pauses;
}

const lettersIn = (text) => (text.match(/[\p{L}\p{N}]/gu) ?? []).length;

export function sentenceEndCut(samples, sampleRate, script) {
  const duration = samples.length / sampleRate;
  if (duration <= MAX_SECONDS) return null;
  const pauses = pausesOf(samples, sampleRate).filter(({ at }) => at >= MIN_SECONDS && at <= MAX_SECONDS);
  if (pauses.length === 0) return null;
  const last = pauses[pauses.length - 1].at;
  const counts = splitSentences(script).map(lettersIn);
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (counts.length < 2 || total === 0) return null;
  let before = 0;
  const ends = counts.slice(0, -1).map((count) => ((before += count) / total) * duration);
  for (const end of ends.filter((at) => at <= last).reverse()) {
    const near = pauses.filter(({ at }) => Math.abs(at - end) <= ALIGN_SECONDS);
    if (near.length === 0) continue;
    const away = ({ at }) => Math.abs(at - end);
    const chosen = near.reduce((best, pause) => (pause.length > best.length || (pause.length === best.length && away(pause) < away(best)) ? pause : best));
    return Math.round(chosen.at * 1000) / 1000;
  }
  return null;
}
