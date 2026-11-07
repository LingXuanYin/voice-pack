// SPDX-License-Identifier: Apache-2.0
//
// 变声和唱歌（流程层）：把一段音频换成包的声音，内容、节奏、旋律不变。用到的所需能力是 voice-conversion、singing-voice-conversion。
//   @capability voice-conversion            speech：把一段语音换成包的声音（签名在 vocab/capability-signatures.md）
//   @capability singing-voice-conversion    singing：把一段歌声（人声分轨）换成包的声音
// 不是每个环境都有这两项能力，所以只有环境提供了才能用；缺了就只有变声报错（capability_missing，点名缺的是哪一项），配音等别的功能照常。
//
//   const result = await convertAudio(env, pack, audio, options);
//   audio    { bytes, mimeType }：要换声音的那段音频
//   options  kind（'speech' 默认，或 'singing'）、labels（调用方给的标签 { language, emotion, style, energy }；挑参考只看 language）、
//            referenceTag（调用方指定的音色基底标签，不空的字符串）、onPlan（花钱之前交给它，见下面）
// 用哪一段参考：lib/reference-pick.mjs，取的顺序和定了标签以后怎么找段，都同配音：调用方指定的标签（referenceTag，by 是 'reference-tag'）
//   → 包里默认设定（setups 里带 default 的那一套）写的 referenceTag（by 是 'setup'）→ 这句语言的默认段（by 是 'default'）。
//   只是没有台词可看，所以这句的语言是调用方给的 labels.language，没给就用默认设定的 labels.language，再没有就是没有语言
//   （定了标签：主语言里这个标签的段，主语言里没有就用这个标签排在最前的那段；没定标签：主语言的默认段；都不算跨语言）。
//   情绪、风格、能量不影响用哪一段。
//   返回值的 pick 写法同配音的 units[i].pick：{ index, segmentId, tag, by, crossLanguage, language, directions }。
//   指定的标签参考集里一段都没有，报 reference_tag_unknown（details 同配音），在调用能力之前。
// 能力的调用参数：{ audio, ref_audio, ref_text, enhancers? }。ref_text 同配音（lib/reference-pick.mjs 的 refTextOf）。
//   增强件的用法见 lib/enhancers.mjs。
// onPlan(pick, { capability })：该核对的都核对过了（能力、脚本要的运行时、用哪一段参考），计费的调用一次都还没有。命令行在这里说明费用；它抛错就什么都不做。
// 脚本（lib/pack-script.mjs）：登记在 convert 功能名下的脚本，在换声之后跑 audio 钩子（没有「要说的话」，所以没有 text 钩子）。
// 一次只换一段；一段失败的错误原样往上抛（没有「别的段」可以接着做）。
//
// 返回 { ok: true, kind, capability, pack, pick, audio: { bytes, mimeType }, model?, enhancers, scripts, verification }。
//
// 抛出的错误：
//   convert_input_invalid       kind、referenceTag、onPlan 不对。details.field
//   reference_tag_unknown       指定的音色基底标签（referenceTag，或者默认设定的 referenceTag）参考集里一段都没有（lib/reference-pick.mjs，
//                               details: { referenceTag, pack, tags }），在调用能力之前
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
import { pickReferences, pickSetupOf, refTextOf } from './reference-pick.mjs';
import { assertScriptRuntimes, runScript, audioForScript } from './pack-script.mjs';
import { readAudioResult, summarizeUse } from './enhancers.mjs';

export const FEATURE = 'convert';
const CAPABILITY_OF = Object.freeze({ speech: 'voice-conversion', singing: 'singing-voice-conversion' });

/**
 * 把一段音频换成包的声音。规则见文件头。
 * @param {object} env 注入的运行环境
 * @param {object} pack openVoicePack 打开的包
 * @param {{ bytes: Uint8Array, mimeType: string }} audio
 * @param {{ kind?: 'speech' | 'singing', labels?: object, referenceTag?: string, onPlan?: (pick: object, info: { capability: string }) => unknown }} [options]
 */
export async function convertAudio(env, pack, audio, options = {}) {
  const kind = options.kind ?? 'speech';
  if (!Object.hasOwn(CAPABILITY_OF, kind)) throw new VoicePackError('convert_input_invalid', `kind 必须是 ${Object.keys(CAPABILITY_OF).join(' 或 ')}，收到 ${JSON.stringify(kind)}`, { details: { field: 'kind' } });
  if (options.referenceTag !== undefined && (typeof options.referenceTag !== 'string' || options.referenceTag === '')) {
    throw new VoicePackError('convert_input_invalid', 'referenceTag 必须是不空的字符串（音色基底标签），或者不给', { details: { field: 'referenceTag' } });
  }
  if (options.onPlan !== undefined && typeof options.onPlan !== 'function') throw new VoicePackError('convert_input_invalid', 'onPlan 必须是函数', { details: { field: 'onPlan' } });
  assertAudioClip(audio, 'audio');
  const capability = CAPABILITY_OF[kind];
  const convert = requireCapability(env, capability);
  const scripts = pack.scripts(FEATURE);
  assertScriptRuntimes(env, scripts, FEATURE);

  // 包里的默认设定（带 default 的那一套）：它的语言和默认参考补在调用方没给的那一层上
  const setup = (pack.manifest.setups ?? []).find((entry) => entry.default === true);
  // 变声没有台词可读；仍和配音一样明确选「拿掉」（认不出的括号是台本里的提示），免得以后给它台词时悄悄变成「保留」
  const { picks } = pickReferences(pack.manifest, [{ labels: options.labels }], { unrecognized: 'remove', setup: pickSetupOf(setup), referenceTag: options.referenceTag });
  const pick = picks[0];
  const { segment, clip } = await pack.referenceClip(pick.segmentId);
  const offers = pack.enhancers(capability);
  const call = { audio, ref_audio: clip, ref_text: refTextOf(segment) };
  if (offers.length > 0) call.enhancers = offers;

  await options.onPlan?.(pick, { capability });
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
