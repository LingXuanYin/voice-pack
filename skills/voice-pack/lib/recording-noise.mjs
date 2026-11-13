// SPDX-License-Identifier: Apache-2.0
//
// 录音的底噪和闷当场说清（流程层，不花钱）：用录音做声音时，录音的底噪和闷会原样被克隆进每一句；做包时量出来，满足下面任一条就写一条说明，
// 说听起来会怎样，给两条更好的路：换一段干净的录音，或者改用设计出来的声音。设计出来的声音不报。
//
//   recordingNoiseNote(fresh, { designed })   fresh 是这一版新补的段（lib/make-pack.mjs 筛片段以后的条目），designed 是这一版有设计来源。
//                                             返回一条说明 { code: 'recording_noisy', message, details }，不用说就是 null
//
// 数的是新补的、没被淘汰的、真录音（不是 synthetic）的段；有设计来源（设计出来的声音，做包时写 --design-source）的不数。满足任一条就说：
//   底噪   信噪比（音质检查已经量好的 snrDb，tools/audio-quality.mjs：整体响度减最安静的一成窗口的电平，说话比背景高多少 dB）的中位数低于 RECORDING_NOISE_LINE_DB（25 dB）
//   闷     最低的采样率不高于 NARROW_SAMPLE_RATE（16 kHz）：8 kHz 以上没有声音，克隆出来一定闷，不用量别的
// 说明里只写满足了的那一条。details: { segments（数了几段）, belowLine（其中信噪比低于线的有几段）, snrDb（中位数）, lineDb, sampleRate? }，sampleRate 只在采样率这一条满足时有。
// 在规划之前算，所以预演（--dry-run）和真做的 report.notes 都有，而且在花钱之前（lib/make-pack.mjs 的 onPlan 也交给调用方：命令行的文字输出写到标准错误，--json 时不写，只在报告里）。
//
// 信噪比这条线的依据（2026-11-12，t03、t11 的读数，音质检查的 snrDb 口径；线很贴，只有这几批读数）：
//   林岚的原录音（AISHELL 说话人 0770，16 kHz 新闻朗读）按能量切出的 10 段：16.6 到 28.6 dB，中位数 23；t03 用 measure.py（说话 95% 分位减最安静的 5%）量整段原录音是 24 到 35 dB，口径不同，差 6 到 8 dB。
//   设计出来的声音（flash 试听和表演段，3 个角色各 3 次，共 18 条）：47.5 到 77.5 dB；measure.py 量是 55 到 85 dB。设计出来的声音不靠这条线，有设计来源的本来就不报。
//   「好录音约 28 dB」量的是 tools/audio-quality.mjs 文件头里「存下的 90 条真实录音」里好的 40 条（音频不在手上，只留了读数）的信噪比中位数；
//   同一处另有 296 条真实干净的单句朗读（AISHELL-1 168 条、LibriSpeech 128 条，12 位说话人，16 kHz）：信噪比最低 12.9 dB，36 条低于 20 dB。林岚就是这一类语料的录音，中位数 23，比那 40 条的 28 低 5 dB。
//   线放在 25 dB：比林岚的中位数高 2，比好录音的中位数低 3。余量很小，只有林岚一段录音和那 40 条的中位数；没有在别的真人录音上量过。信噪比在 25 到 28 dB 上下的录音说不说，不该靠这条线断定：
//   闷是确定的，所以采样率那一条单独留着。线放得更高（试过 40 dB），棚外的好录音几乎每一段都会被说一句，这条说明就没有用了。
//   说的是事实（说话比底噪高多少、采样率多少），好不好由使用者听、由使用者定，说明不拦做包。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { median } from './point-measure.mjs';

/** 说话比底噪高多少 dB（音质检查的 snrDb）的中位数低于这条线，就说底噪。依据见文件头。 */
export const RECORDING_NOISE_LINE_DB = 25;
/** 采样率不高于它，8 kHz 以上没有声音，克隆出来会闷。 */
const NARROW_SAMPLE_RATE = 16000;

export function recordingNoiseNote(fresh, { designed }) {
  if (designed) return null;
  const measured = fresh.filter((item) => item.unused === undefined && item.synthetic !== true && item.quality?.status === 'checked' && typeof item.quality.metrics.snrDb === 'number');
  if (measured.length === 0) return null;
  const snrDb = Math.round(median(measured.map((item) => item.quality.metrics.snrDb)) * 10) / 10;
  const lowest = Math.min(...measured.map((item) => item.quality.metrics.sampleRate));
  const noisy = snrDb < RECORDING_NOISE_LINE_DB;
  const narrow = lowest <= NARROW_SAMPLE_RATE;
  if (!noisy && !narrow) return null;
  const belowLine = measured.filter((item) => item.quality.metrics.snrDb < RECORDING_NOISE_LINE_DB).length;
  const what = measured.length === 1 ? 'this recording' : `this batch of recordings (${measured.length} segments)`;
  const says = [
    noisy ? `${what} has speech only ${snrDb} dB above the noise (${measured.length === 1 ? '' : 'median; '}a designed voice is 47 dB or more); the noise is cloned into the voice as it is, and every line carries it` : null,
    narrow ? `${measured.length === 1 ? 'the' : 'the lowest'} sample rate is ${lowest} Hz, with nothing above 8 kHz, so the voice that is made will sound muffled` : null,
  ].filter((part) => part !== null);
  const sentence = says.join('; ');
  return {
    code: 'recording_noisy',
    message: `${sentence[0].toUpperCase()}${sentence.slice(1)}. Better routes: use a cleaner recording, or use a designed voice (references/make-pack.md「Making a pack from a designed voice」)`,
    details: { segments: measured.length, belowLine, snrDb, lineDb: RECORDING_NOISE_LINE_DB, ...(narrow ? { sampleRate: lowest } : {}) },
  };
}
