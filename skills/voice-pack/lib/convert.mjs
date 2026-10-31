// SPDX-License-Identifier: Apache-2.0
//
// 变声和唱歌（流程层）：把一段音频换成包的声音，内容、节奏、旋律不变。用到的所需能力是 voice-conversion、singing-voice-conversion。
//   @capability voice-conversion            speech：把一段语音换成包的声音（签名在 vocab/capability-signatures.md）
//   @capability singing-voice-conversion    singing：把一段歌声（人声分轨）换成包的声音
// 不是每个环境都有这两项能力，所以只有环境提供了才能用；缺了就只有变声报错（capability_missing，点名缺的是哪一项），配音等别的功能照常。
//
//   const result = await convertAudio(env, pack, audio, options);
//   audio    { bytes, mimeType }：要换声音的那段音频
//   options  kind（'speech' 默认，或 'singing'）、labels（调用方给的标签 { language, emotion, style, energy }，挑参考用；不给就用默认参考）
// 用哪一段参考：lib/reference-pick.mjs，规则同配音，只是没有台词可看，所以是调用方的标签或默认参考。挑的理由在返回值的 pick 里。
// 能力的调用参数：{ audio, ref_audio, ref_text, enhancers? }；增强件的用法见 lib/enhancers.mjs。
// 脚本（lib/pack-script.mjs）：登记在 convert 功能名下的脚本，在换声之后跑 audio 钩子（没有「要说的话」，所以没有 text 钩子）。
// 一次只换一段；一段失败的错误原样往上抛（没有「别的段」可以接着做）。
//
// 返回 { ok: true, kind, capability, pack, pick, audio: { bytes, mimeType }, model?, enhancers, scripts, verification }。
//
// 抛出的错误：
//   convert_input_invalid       kind 不对。details.field
//   audio_clip_invalid          要换的不是 { bytes, mimeType }（核心层，details.field 是 audio）
//   capability_missing          环境没有这一项变声能力
//   runtime_missing             脚本要的运行时环境没有（details: { runtime, entry, feature }），在换声之前报
//   capability_result_invalid   能力的返回不合约定（lib/enhancers.mjs）
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { requireCapability } from '../protocol/lib/env.mjs';
import { assertAudioClip } from '../protocol/lib/audio-clip.mjs';
import { fromBase64 } from '../protocol/lib/bytes.mjs';
import { pickReferences } from './reference-pick.mjs';
import { assertScriptRuntimes, runScript, audioForScript } from './pack-script.mjs';
import { readAudioResult, summarizeUse } from './enhancers.mjs';

export const FEATURE = 'convert';
const CAPABILITY_OF = Object.freeze({ speech: 'voice-conversion', singing: 'singing-voice-conversion' });

/**
 * 把一段音频换成包的声音。规则见文件头。
 * @param {object} env 注入的运行环境
 * @param {object} pack openVoicePack 打开的包
 * @param {{ bytes: Uint8Array, mimeType: string }} audio
 * @param {{ kind?: 'speech' | 'singing', labels?: object }} [options]
 */
export async function convertAudio(env, pack, audio, options = {}) {
  const kind = options.kind ?? 'speech';
  if (!Object.hasOwn(CAPABILITY_OF, kind)) throw new VoicePackError('convert_input_invalid', `kind 必须是 ${Object.keys(CAPABILITY_OF).join(' 或 ')}，收到 ${JSON.stringify(kind)}`, { details: { field: 'kind' } });
  assertAudioClip(audio, 'audio');
  const capability = CAPABILITY_OF[kind];
  const convert = requireCapability(env, capability);
  const scripts = pack.scripts(FEATURE);
  assertScriptRuntimes(env, scripts, FEATURE);

  // 变声没有台词可读；仍和配音一样明确选「拿掉」（认不出的括号是台本里的提示），免得以后给它台词时悄悄变成「保留」
  const { picks } = await pickReferences(env, pack.manifest, [{ labels: options.labels }], { unrecognized: 'remove' });
  const pick = picks[0];
  const { segment, clip } = await pack.referenceClip(pick.segmentId);
  const offers = pack.enhancers(capability);
  const call = { audio, ref_audio: clip, ref_text: segment.text };
  if (offers.length > 0) call.enhancers = offers;

  const result = await convert(call);
  const used = readAudioResult(capability, result, offers);
  let converted = { bytes: result.bytes, mimeType: result.mimeType };
  for (const entry of scripts) {
    const output = await runScript(env, pack, entry, { feature: FEATURE, hook: 'audio', unit: { kind, segment: segment.id, ...audioForScript(converted) } });
    if (output.audio !== undefined) converted = { bytes: fromBase64(output.audio), mimeType: output.mimeType ?? converted.mimeType };
  }
  return {
    ok: true,
    kind,
    capability,
    pack: { id: pack.manifest.id, name: pack.manifest.name, version: pack.manifest.version },
    pick,
    audio: converted,
    ...(typeof result.model === 'string' ? { model: result.model } : {}),
    enhancers: summarizeUse(offers, [{ enhancers: { used } }], pack.manifest.verification ?? []),
    scripts: scripts.map((entry) => ({ entry: entry.entry, runtime: entry.runtime, hooks: ['audio'] })),
    verification: pack.manifest.verification ?? [],
  };
}
