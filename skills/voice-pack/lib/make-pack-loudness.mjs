// SPDX-License-Identifier: Apache-2.0
//
// 调响度（流程层）：写进包里的参考和留出录音统一到同一个响度。怎么调的正本是 tools/loudness-normalize.mjs；
// 调哪几段、什么情况不调、报告里记什么，规则只在这里写一遍（lib/make-pack.mjs 的文件头指到这里）：
//
// 为什么调：生成时每句话挑不同的参考，参考之间响度差得多，配出来的整段就会一句响一句轻。所以写进包里的参考和留出录音统一到同一个响度，
// 对所有输入都做（options.loudness 可以关）。怎么调（整体响度、采样峰值、增益怎么取）的正本在 tools/loudness-normalize.mjs：默认目标是 REFERENCE_LOUDNESS_LUFS（参考音频的目标响度，
// 产品里只有这一个数），采样峰值不超过 PEAK_CEILING_DBFS；降增益不受限制；加增益会让峰值超过上限的（峰值比响度高 19 dB 以上的录音），默认用预读限幅器压住过高的峰再加（最多压 LIMITER_MAX_DB，
// 参数和依据都在 tools/loudness-normalize.mjs 的文件头「限幅器」），压到最多还是到不了目标的，只加到能加的，没到目标，在 notes 里写明差多少、压了多少（loudness_target_not_reached）。
//   先量后调：音质检查、能量（响度跟这一批的中位数比）、打标签，都是照原始音频做的，调响度在这些之后、写进包之前，所以不影响它们；报告里每段的 quality 是原始的，
//   loudness 记着调之前、调之后的响度、峰值、增益和限幅压了多少 dB（limitedDb；没限幅是 0）。steps.loudness 记着这次的目标、上限和限幅器（limiter：{ maxDb }，关了是 null），
//   数一数各状态的段数（adjusted、peakLimited、unchanged、skipped、carried），limiterUsed 是其中限幅压过的段数。
//   写进包里的、试合成用的参考和量还原度用的留出录音，都是调过的那份字节（试合成和包里的一致）。
//   存成 16 位 PCM 的 WAV（tools/wav.mjs），路径的扩展名是 .wav；原来是 24 位、浮点或 mp3 的也一样。
//   不调的（各自记在条目的 loudness 上，notes 里的 loudness_skipped 点名）：上一版带过来的段（字节要和上一版一样，不重调）；外部资源（包里只记网址、大小、哈希，
//   文件在作者那里）；解不了的（没有 ffmpeg 的环境里的 mp3 等）；太短或几乎无声、量不出响度的。已经在目标上、峰值也没超的，原样放进去（unchanged）。
//   发新版本时查重：上一版里的段是调过响度存的，新补的要是同一段录音（原始字节），字节对不上，所以新补的段也按这次的目标（这次关了就按默认的）调一遍，
//   调出来的字节也拿去比（目标、上限、限幅器都按这次的）。上一版是用别的设置调的（别的目标、上限，或者限幅器的设置不同、限幅动过的段字节就不一样），就比不出来。
//
//   adjustLoudness(env, items, settings)   这一步：items 是要放进包里的段（参考和留出录音），settings 是 lib/make-pack-input.mjs 的 readOptions 补全的
//                                          loudness（{ targetLufs, peakCeilingDbfs, limiter }，关掉是 null）；返回 { step, notes }：
//                                          step 是 steps.loudness（关掉是 { status: 'skipped', reason: 'disabled' }），notes 是下面两种说明
//   adjustedClip(env, bytes, settings)     一段音频调到目标响度以后的样子（解码、调、存成 16 位 PCM 的 WAV）；发新版本时筛片段（lib/make-pack-screen.mjs）查重也用它
//
// 说明（notes：[{ code, message, details }]）。message 是给人看的中文；details 是它说的那些事实，读的人（app 用两种语言自己写句子）只读 code 和 details，
// 不去 steps.loudness 和每段的 loudness 里凑；数都和那里的是同一些：
//   loudness_target_not_reached    有几段限幅压到最多还是没调到目标响度。details: { targetLufs, peakCeilingDbfs, limiter, segments }：
//                                  目标响度、采样峰值上限、限幅器（{ maxDb } 或 null：关着），和没到目标的每一段 { id, beforeLufs, afterLufs, gainDb, limitedDb }
//                                  （调之前的响度、调之后的响度、加了多少 dB、限幅压了多少 dB；限幅器关着是 0）
//   loudness_skipped               有几段没调，包里是原来的音频。details: { segments }，每一段 { id, reason }，reason 就是这一段 loudness.reason：
//                                  external 外部资源、runtime_missing 解码要的工具这个环境没有、audio_undecodable 解不了、unmeasurable 太短或几乎无声
//
// 读条目的：id、audio、externalUrl、previous；写条目的：audio 和 format（调过的：16 位 PCM 的 WAV）、loudness（{ status, gainDb, limitedDb, beforeLufs, afterLufs,
// beforePeakDbfs, afterPeakDbfs }；没调的是 { status: 'skipped', reason } 或 { status: 'carried' }）。
//
// 抛出的错误：没有自己的 code。解码失败里「环境没有 ffmpeg」「解不了」记成这一段不调（skipped），别的错（tools/audio-decode.mjs）原样往上抛。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { decodeAudio, decodeFailureKind } from '../tools/audio-decode.mjs';
import { encodeWav } from '../tools/wav.mjs';
import { normalizeLoudness, ceilingForPcm16 } from '../tools/loudness-normalize.mjs';

/** 调响度这一步跳过某一段的原因，写进报告说明里的话。 */
const LOUDNESS_SKIP_WHY = {
  external: '外部资源：文件在作者那里，包里只记网址、大小和哈希，调了就对不上了',
  runtime_missing: '解码要 ffmpeg，这个环境没有',
  audio_undecodable: '解不了',
  unmeasurable: '太短或几乎无声，量不出响度',
};
const signed = (db) => `${db > 0 ? '+' : ''}${db}`;

/**
 * 一段音频调到目标响度以后的样子：解码、调（含限幅）、存成 16 位 PCM 的 WAV。调响度（unifyLoudness）和发新版本时查重（screen）用同一份，同一段录音调出来的字节一样（目标、上限、限幅器同样）。
 * 写成 16 位整数要四舍五入，所以调的时候峰值上限里留出一个刻度（tools/loudness-normalize.mjs 的 ceilingForPcm16），写出去的文件的采样峰值才不会超过上限。
 * @returns {Promise<{ skipped: string, details?: object } | { result: object, audio: { bytes: Uint8Array, mimeType: string } | null }>}
 *   skipped：没法调。runtime_missing 解码要 ffmpeg 而环境没有；audio_undecodable 解不了；unmeasurable 太短或几乎无声，量不出响度。
 *   audio 是 null：不用动（已经在目标上，峰值也没超上限）
 */
export async function adjustedClip(env, bytes, { targetLufs, peakCeilingDbfs, limiter }) {
  let decoded;
  try {
    decoded = await decodeAudio(env, bytes);
  } catch (error) {
    const kind = decodeFailureKind(error);
    if (kind === 'runtime_missing') return { skipped: 'runtime_missing', details: { runtime: error.details.runtime } };
    if (kind === 'undecodable') return { skipped: 'audio_undecodable', details: { code: error.code } };
    throw error;
  }
  const result = normalizeLoudness({ sampleRate: decoded.sampleRate, samples: decoded.samples }, { targetLufs, peakCeilingDbfs: ceilingForPcm16(peakCeilingDbfs), limiter });
  if (result.status === 'unmeasurable') return { skipped: 'unmeasurable' };
  return { result, audio: result.status === 'unchanged' ? null : { bytes: encodeWav(result.audio, { encoding: 'pcm16' }), mimeType: 'audio/wav' } };
}

/**
 * 把写进包里的参考和留出录音统一到目标响度（怎么调见 tools/loudness-normalize.mjs）。
 * 生成时每句话挑不同的参考，参考之间响度差得多，配出来的整段就会一句响一句轻。
 * 在量完音质和能量、打完标签以后做：这些都是照原始音频量的，调的只是放进包里的那份字节（条目的 audio 和 format 换成调过的，存成 16 位 PCM 的 WAV）。
 * 不动的：上一版带过来的段（字节要和上一版一样）、外部资源（包里只记网址和哈希）、解不了或量不出响度的段；各自在条目的 loudness 上记原因。
 * 加增益会让峰值超过上限的段，默认用限幅器压住过高的峰（每段的 loudness.limitedDb 记着压了多少）；压到最多还是到不了目标的（peak_limited），没到目标，写进说明（loudness_target_not_reached）。
 * @param {object} env
 * @param {object[]} items 要放进包里的段（参考和留出录音）
 * @param {{ targetLufs: number, peakCeilingDbfs: number, limiter: { maxDb: number } | null }} settings readLoudness 补全的设置
 * @returns {Promise<{ step: object, notes: { code: string, message: string, details: object }[] }>}
 */
async function unifyLoudness(env, items, settings) {
  const { targetLufs, peakCeilingDbfs, limiter } = settings;
  const step = { status: items.length === 0 ? 'not_needed' : 'done', targetLufs, peakCeilingDbfs, limiter, adjusted: 0, peakLimited: 0, limiterUsed: 0, unchanged: 0, skipped: 0, carried: 0 };
  for (const item of items) {
    const skip = (reason, extra = {}) => {
      item.loudness = { status: 'skipped', reason, ...extra };
      step.skipped += 1;
    };
    if (item.previous !== undefined) {
      item.loudness = { status: 'carried' };
      step.carried += 1;
      continue;
    }
    if (item.externalUrl !== null) {
      skip('external');
      continue;
    }
    const adjusted = await adjustedClip(env, item.audio.bytes, settings);
    if (adjusted.skipped !== undefined) {
      skip(adjusted.skipped, adjusted.details);
      continue;
    }
    const { result } = adjusted;
    item.loudness = {
      status: result.status,
      gainDb: result.gainDb,
      limitedDb: result.limitedDb,
      beforeLufs: result.before.loudnessLufs,
      afterLufs: result.after.loudnessLufs,
      beforePeakDbfs: result.before.peakDbfs,
      afterPeakDbfs: result.after.peakDbfs,
    };
    if (adjusted.audio === null) {
      step.unchanged += 1;
      continue;
    }
    if (result.status === 'peak_limited') step.peakLimited += 1;
    else step.adjusted += 1;
    if (result.limitedDb > 0) step.limiterUsed += 1;
    item.audio = adjusted.audio;
    item.format = 'wav';
  }
  const notes = [];
  const limited = items.filter((item) => item.loudness?.status === 'peak_limited');
  if (limited.length > 0) {
    // 限幅器开着：限幅量最多 maxDb，调完还差得多（多半是压到了最多），说明里写出压了多少、上限是多少；关着：增益是加到峰值顶到上限为止
    const reason = limiter === null ? '增益只用到这里' : `限幅最多压 ${limiter.maxDb} dB，调完还是差得多`;
    const pressed = (item) => (limiter === null ? '' : `，限幅压了 ${item.loudness.limitedDb} dB`);
    notes.push({
      code: 'loudness_target_not_reached',
      message: `${limited.length} 段没调到目标响度 ${targetLufs} LUFS：为了采样峰值不超过 ${peakCeilingDbfs} dBFS，${reason}（${limited.map((item) => `${item.id}：${item.loudness.beforeLufs} → ${item.loudness.afterLufs} LUFS，${signed(item.loudness.gainDb)} dB${pressed(item)}`).join('、')}）。这几段的响度和别的段不一样，用它们当参考，配出来的整段里音量会不齐`,
      details: {
        targetLufs,
        peakCeilingDbfs,
        limiter: limiter === null ? null : { maxDb: limiter.maxDb },
        segments: limited.map((item) => ({ id: item.id, beforeLufs: item.loudness.beforeLufs, afterLufs: item.loudness.afterLufs, gainDb: item.loudness.gainDb, limitedDb: item.loudness.limitedDb })),
      },
    });
  }
  const left = items.filter((item) => item.loudness?.status === 'skipped');
  if (left.length > 0) {
    notes.push({
      code: 'loudness_skipped',
      message: `${left.length} 段没调响度，包里是原来的音频：${left.map((item) => `${item.id}（${LOUDNESS_SKIP_WHY[item.loudness.reason]}）`).join('、')}`,
      details: { segments: left.map((item) => ({ id: item.id, reason: item.loudness.reason })) },
    });
  }
  return { step, notes };
}

/** 调响度这一步：settings 是 readOptions 补全的设置，null 是关掉了（没有说明，steps.loudness 写 skipped）。 */
export async function adjustLoudness(env, items, settings) {
  if (settings === null) return { step: { status: 'skipped', reason: 'disabled' }, notes: [] };
  return unifyLoudness(env, items, settings);
}
