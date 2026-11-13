// SPDX-License-Identifier: Apache-2.0
//
// 命令行层读「来源包」（--source-pack），再把查重的结果写成给人看的几行。查重本身在 lib/duplicate-check.mjs，流程的正本是 protocol/new-pack/README.md。
//
// readSourcePack(ctx, argument) → Map<路径, Uint8Array>
//   argument 是目录，或者分享文件（.zip）。读成角色部分的文件集，交给 lib/duplicate-check.mjs 的 materialOfPack。
//   来源包只为「比一比」而读，不是拿它当包用：不验签、不联网，检查报告说不通过（哈希对不上、没有签名……）也照样取文件来比——查重不是信任判断。
//   读不出文件才报错（路径不存在、不是分享文件、目录里有符号链接或超过上限）。
//   来源包的标识（路径、分享文件里的包目录名、包 ID）不往外传：返回里只有文件集，抛的错里也没有路径、文件名和检查报告的说明文字（说明文字可能带来源包里的文件名），只有问题的 code。
//   分享文件走 protocol/cli/checking.mjs 的 inspectTarget（openShareFile 只准 share.mjs 用），所以也会过一遍检查，只是结果不看。
//
// describeDuplicateCheck(report) → string[]
//   把 checkDuplicates 的返回（通过时的那一份）写成几行：比了什么、最接近阈值的一项、没查到的。不出现来源包的任何标识（返回里本来就没有）。
//   录音有没比的（新包的解不开、来源包里的没法比），结论行写「文字通过；录音没比全」，不写「通过」；要 ffmpeg 才解得开的，写上装法。
//
// 抛出的错误（VoicePackError）：
//   duplicate_check_source_invalid  来源包读不了。details.reason：
//                                     unreadable  路径不存在，或者读不了
//                                     unopenable  路径在，但打不开：不是合法的分享文件，或者目录里有问题（符号链接、特殊文件、超过上限）。details.codes 是检查给的问题的 code
//                                   同一个 code，lib/duplicate-check.mjs 里的 reason 是 manifest_missing、manifest_unreadable、not_role_part
import { VoicePackError, isVoicePackError } from '../protocol/lib/errors.mjs';
import { inspectTarget } from '../protocol/cli/checking.mjs';
import { FFMPEG_INSTALL } from '../protocol/lib/env.mjs';

/** 读来源包的文件集。规则见文件头。 */
export async function readSourcePack(ctx, argument) {
  let inspected;
  try {
    inspected = await inspectTarget(argument, ctx, { allowUnsigned: true });
  } catch (error) {
    if (isVoicePackError(error, 'file_unreadable')) {
      throw new VoicePackError('duplicate_check_source_invalid', 'The source pack cannot be read: the path given to --source-pack does not exist, or there is no permission to read it', { details: { reason: 'unreadable' } });
    }
    throw error;
  }
  if (inspected.files === null) {
    const codes = [...new Set(inspected.report.problems.map((problem) => problem.code))];
    throw new VoicePackError('duplicate_check_source_invalid', `The source pack cannot be opened: it is not a valid share file, or something in the directory is wrong (${codes.join(', ') || 'reason unknown'})`, { details: { reason: 'unopenable', codes } });
  }
  return inspected.files;
}

const MEASURE = { rougeLF1: 'ROUGE-L F1', copiedRatio: 'copied ratio', copiedCoverage: 'share of the source taken away' };

/** 查重通过时给人看的几行。 */
export function describeDuplicateCheck(report) {
  const lines = [];
  const { text, audio, thresholds } = report;
  const highestText = text.highest === null
    ? ''
    : `, the closest to the threshold is ${text.highest.item} (${Object.entries(MEASURE).map(([key, name]) => `${name} ${text.highest[key]}`).join(', ')}; thresholds ${thresholds.text.rougeLF1}, ${thresholds.text.copiedShare})`;
  const comparedText = `${text.compared} text ${text.compared === 1 ? 'item' : 'items'}`;
  // 录音有没比的（新包的解不开，或者来源包里的没法比）：结论不写「通过」，只说文字过了（lib/duplicate-check.mjs：解不了的记在 unchecked 里，不假装查过了）
  const audioPartial = audio.unchecked.length > 0 || Object.keys(audio.sourceUnchecked).length > 0;
  lines.push(audioPartial
    ? `Duplicate check: text passed; audio was not fully compared (which segments and why are listed below), so the audio half does not count as checked. ${comparedText} compared${highestText}`
    : `Duplicate check: passed. ${comparedText} compared${highestText}`);
  const tooShort = text.skipped.filter((item) => item.reason === 'too_short');
  if (tooShort.length > 0) lines.push(`  Text not compared: ${tooShort.map((item) => item.item).join(', ')} (under ${thresholds.text.minTokens} words, too short: even independently written texts easily coincide)`);
  const highestAudio = audio.highest === null ? '' : `, the most reuse is in ${audio.highest.item} (${audio.highest.reusedSeconds} s of ${audio.highest.totalSeconds} s; threshold ${thresholds.audio.reusedSeconds} s)`;
  lines.push(`  Recordings checked: ${audio.checked} ${audio.checked === 1 ? 'segment' : 'segments'} (${audio.sourceClips} in the source pack can be compared)${highestAudio}`);
  if (audio.unchecked.length > 0) {
    const needsFfmpeg = audio.unchecked.some((clip) => clip.reason === 'decode_unavailable');
    lines.push(`  Recordings not checked: ${audio.unchecked.map((clip) => `${clip.item} (${clip.reason === 'decode_unavailable' ? 'ffmpeg is needed to decode it, and it is not available here' : 'cannot be decoded'})`).join(', ')}${needsFfmpeg ? `; install ffmpeg and run again to compare them (${FFMPEG_INSTALL})` : ''}`);
  }
  const missing = Object.entries(audio.sourceUnchecked).map(([reason, count]) => `${count} ${count === 1 ? 'segment' : 'segments'}: ${{ external: 'outside the pack (external resources)', decode_unavailable: 'ffmpeg is needed to decode, and it is not available here', decode_failed: 'cannot be decoded' }[reason] ?? reason}`);
  if (missing.length > 0) lines.push(`  Recordings in the source pack that cannot be compared: ${missing.join('; ')}`);
  return lines;
}
