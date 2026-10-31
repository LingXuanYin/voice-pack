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
//
// 抛出的错误（VoicePackError）：
//   duplicate_check_source_invalid  来源包读不了。details.reason：
//                                     unreadable  路径不存在，或者读不了
//                                     unopenable  路径在，但打不开：不是合法的分享文件，或者目录里有问题（符号链接、特殊文件、超过上限）。details.codes 是检查给的问题的 code
//                                   同一个 code，lib/duplicate-check.mjs 里的 reason 是 manifest_missing、manifest_unreadable、not_role_part
import { VoicePackError, isVoicePackError } from '../protocol/lib/errors.mjs';
import { inspectTarget } from '../protocol/cli/checking.mjs';

/** 读来源包的文件集。规则见文件头。 */
export async function readSourcePack(ctx, argument) {
  let inspected;
  try {
    inspected = await inspectTarget(argument, ctx, { allowUnsigned: true });
  } catch (error) {
    if (isVoicePackError(error, 'file_unreadable')) {
      throw new VoicePackError('duplicate_check_source_invalid', '来源包读不了：--source-pack 给的路径不存在，或者没有权限读', { details: { reason: 'unreadable' } });
    }
    throw error;
  }
  if (inspected.files === null) {
    const codes = [...new Set(inspected.report.problems.map((problem) => problem.code))];
    throw new VoicePackError('duplicate_check_source_invalid', `来源包打不开：不是合法的分享文件，或者目录里有问题（${codes.join('、') || '原因不明'}）`, { details: { reason: 'unopenable', codes } });
  }
  return inspected.files;
}

const MEASURE = { rougeLF1: 'ROUGE-L F1', copiedRatio: '抄用比例', copiedCoverage: '来源被带走的比例' };

/** 查重通过时给人看的几行。 */
export function describeDuplicateCheck(report) {
  const lines = [];
  const { text, audio, thresholds } = report;
  const highestText = text.highest === null
    ? ''
    : `，离阈值最近的是 ${text.highest.item}（${Object.entries(MEASURE).map(([key, name]) => `${name} ${text.highest[key]}`).join('，')}；阈值 ${thresholds.text.rougeLF1}、${thresholds.text.copiedShare}）`;
  lines.push(`查重：通过。文字比了 ${text.compared} 项${highestText}`);
  const tooShort = text.skipped.filter((item) => item.reason === 'too_short');
  if (tooShort.length > 0) lines.push(`  没比的文字：${tooShort.map((item) => item.item).join('、')}（不到 ${thresholds.text.minTokens} 个词，太短，各写各的也容易撞）`);
  const highestAudio = audio.highest === null ? '' : `，复用最多的是 ${audio.highest.item}（${audio.highest.reusedSeconds} 秒，一共 ${audio.highest.totalSeconds} 秒；阈值 ${thresholds.audio.reusedSeconds} 秒）`;
  lines.push(`  录音查了 ${audio.checked} 段（来源包里有 ${audio.sourceClips} 段能比）${highestAudio}`);
  if (audio.unchecked.length > 0) lines.push(`  没查到的录音：${audio.unchecked.map((clip) => `${clip.item}（${clip.reason === 'decode_unavailable' ? '要 ffmpeg 才解得开，这里没有' : '解不开'}）`).join('、')}`);
  const missing = Object.entries(audio.sourceUnchecked).map(([reason, count]) => `${count} 段${{ external: '在包外面（外部资源）', decode_unavailable: '要 ffmpeg 才解得开，这里没有', decode_failed: '解不开' }[reason] ?? reason}`);
  if (missing.length > 0) lines.push(`  来源包里没法比的录音：${missing.join('；')}`);
  return lines;
}
