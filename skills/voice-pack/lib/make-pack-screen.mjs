// SPDX-License-Identifier: Apache-2.0
//
// 筛片段（流程层，不花钱）：对着每一段的音频字节，认格式、查重、量音质，淘汰用不上的。
// 音质怎么量、怎么判，正本是 tools/audio-quality.mjs（阈值和依据在它的文件头）。
//
//   screen(env, items, { thresholds, loudness })   就地改条目，返回 Promise<void>。thresholds 是音质检查的阈值（judgeReference 的写法，省略用默认），
//                                                  loudness 是 readOptions 补全的调响度设置（发新版本查重用，见下）
//
// 读条目的：id、audio、previous；写条目的：format（认出的格式）、sha256、quality（音质检查留下的几个量和结论，status 是 'checked'；
// 环境没有 ffmpeg 又不是 WAV 的、上一版带来的又解不了的，status 是 'unchecked'，不做音质检查也不淘汰）。淘汰的写 unused: { reason, details? }：
//   audio_unrecognized  认不出是哪种音频。details: { mimeType }
//   duplicate_audio     和前面一段是同一段音频（字节的哈希一样）。details: { sameAs }
//   quality_rejected    音质检查不过。details: { codes }（拒绝的那几条原因的 code）
//   audio_undecodable   解不了。details: { code }
// 上一版带过来的段（item.previous）只量一遍音质（给优先级和能量的基准用），不淘汰：发新版本不因为现在的阈值换了就悄悄丢掉原来的参考。
// 它们排在前面，新补的和它们字节一样就是重复（sameAs 是上一版里的那一段）。
// 发新版本查重：上一版里的段是调过响度存进包的（lib/make-pack-loudness.mjs），新补的要是同一段录音，原始字节对不上它，所以新补的再按这次的调响度设置调一遍，
// 调出来的字节也拿去比（调的结果是确定的）；这次关了调响度，就按默认的目标比：上一版多半是默认目标调的。
//
// 不一口气占住线程：新补的每一段都要解码、调响度、编 WAV、算哈希，一百来段就是一秒多，循环里的 await 在浏览器里不让事件循环转
// （crypto.subtle.digest 对小输入在调用里就算完），页面会整整卡一秒多。所以每连续做了约 YIELD_AFTER_MS（50）毫秒，就在下一段开始之前、下一段调响度之前，
// 让事件循环转一圈（lib/event-loop.mjs）。结论和次序不变，只是中间让出过；连续的活不到 50 毫秒的（段数少）一次都不让。
//
// 抛出的错误：没有自己的 code。音质检查和解码（tools/audio-quality.mjs、tools/audio-decode.mjs）抛的、不是「环境没有 ffmpeg」「解不了」的错，原样往上抛。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { sniffAudio } from '../protocol/lib/audio.mjs';
import { sha256Hex } from '../protocol/lib/hash.mjs';
import { checkAudioQuality } from '../tools/audio-quality.mjs';
import { decodeFailureKind } from '../tools/audio-decode.mjs';
import { loudnessOptions } from '../tools/loudness-normalize.mjs';
import { adjustedClip } from './make-pack-loudness.mjs';
import { YIELD_AFTER_MS, nowMs, turnEventLoop } from './event-loop.mjs';

/** 音质检查报告里留下的那几个量（不带整个 metrics 的细枝末节），够人看、够回头查。 */
const KEPT_METRICS = ['durationSec', 'sampleRate', 'channels', 'peakDbfs', 'silenceRatio', 'noiseFloorDbfs', 'loudnessLufs', 'snrDb'];

/** 音质检查报告里留下的部分。 */
function summarizeQuality(result) {
  return { status: 'checked', decoder: result.decoder, verdict: result.verdict, usable: result.usable, metrics: Object.fromEntries(KEPT_METRICS.map((key) => [key, result.metrics[key]])), reasons: result.reasons };
}

/**
 * 认格式、查重、量音质。每一段的结论写在条目上：条目被淘汰就带 unused: { reason, details? }。
 * 上一版带过来的段（item.previous）只量一遍音质（给优先级和能量的基准用），不淘汰：发新版本不因为现在的阈值换了就悄悄丢掉原来的参考；
 * 它们排在前面，新补的和它们字节一样就是重复（sameAs 是上一版里的那一段）。
 * @returns {Promise<void>}
 */
export async function screen(env, items, { thresholds, loudness }) {
  const seen = new Map();
  // 发新版本：上一版里的段是调过响度存进包的，新补的要是和其中一段是同一段录音，原始字节对不上它。
  // 所以新补的再按响度设置调一遍，调出来的字节也拿去比（调的结果是确定的）。这次关了调响度，就按默认的目标比：上一版多半是默认目标调的
  const twins = items.some((item) => item.previous !== undefined) ? (loudness ?? loudnessOptions()) : null;
  // 连续做了 YIELD_AFTER_MS 毫秒就让事件循环转一圈，再接着做。只在两件事之间让，一件事做到一半不让
  let busySince = nowMs();
  const breathe = async () => {
    if (nowMs() - busySince < YIELD_AFTER_MS) return;
    await turnEventLoop();
    busySince = nowMs();
  };
  for (const item of items) {
    await breathe();
    const carried = item.previous !== undefined;
    const sniffed = sniffAudio(item.audio.bytes);
    if (sniffed === null) {
      item.unused = { reason: 'audio_unrecognized', details: { mimeType: item.audio.mimeType } };
      continue;
    }
    item.format = sniffed.format;
    item.sha256 = await sha256Hex(item.audio.bytes);
    if (seen.has(item.sha256) && !carried) {
      item.unused = { reason: 'duplicate_audio', details: { sameAs: seen.get(item.sha256) } };
      continue;
    }
    if (!seen.has(item.sha256)) seen.set(item.sha256, item.id);
    try {
      const result = await checkAudioQuality(env, item.audio.bytes, { thresholds });
      item.quality = summarizeQuality(result);
      if (!result.usable && !carried) item.unused = { reason: 'quality_rejected', details: { codes: result.reasons.filter((reason) => reason.severity === 'reject').map((reason) => reason.code) } };
    } catch (error) {
      const kind = decodeFailureKind(error);
      if (kind === 'runtime_missing') item.quality = { status: 'unchecked', reason: 'runtime_missing', runtime: error.details.runtime };
      else if (kind === 'undecodable') {
        if (carried) item.quality = { status: 'unchecked', reason: 'audio_undecodable', code: error.code };
        else item.unused = { reason: 'audio_undecodable', details: { code: error.code } };
      } else throw error;
    }
    if (twins !== null && !carried && item.unused === undefined) {
      await breathe(); // 调响度是这个循环里最重的一步（一段十几毫秒），前面量音质又花了一点，到了点就先让
      const adjusted = await adjustedClip(env, item.audio.bytes, twins);
      const hash = adjusted.audio === undefined || adjusted.audio === null ? null : await sha256Hex(adjusted.audio.bytes);
      if (hash !== null && seen.has(hash)) item.unused = { reason: 'duplicate_audio', details: { sameAs: seen.get(hash) } };
    }
  }
}
