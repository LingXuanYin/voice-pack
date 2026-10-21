// SPDX-License-Identifier: Apache-2.0
//
// 增强件的使用情况（流程层）：配音（lib/dub.mjs）和变声（lib/convert.mjs）共用。
// 增强件是只对某个模型有效、在那个模型上还原度更高的文件（微调权重、LoRA、RVC 或 SVC 模型、说话人嵌入），包不依赖它。
// 做法：包里服务这项能力的增强件，以 { id, model, modelVersion, referenceVersion, capability, load } 递给能力（load() 才读文件；文件和清单对不对得上，进入环境时检查过，这里不再算）。
// 能力是环境提供的，只有它知道自己跑的是哪个模型：认识对应的模型就 await load() 用上，并在返回里用 enhancers_used 报出用了哪几个（id）；
// 不认识的就忽略 enhancers，照常生成。库据此汇总「这一次有没有用上增强件」，没用上要明说，并附上包的验证记录，让人知道当前环境下效果会差多少。
// 能力的签名（含 enhancers 参数和 enhancers_used 返回值）写在 vocab/capability-signatures.md。
//
// 抛出的错误：
//   capability_result_invalid   能力的返回不合约定：不是 { bytes, mimeType }，或者 enhancers_used 报了没有递给它的增强件。
//                               details: { capability, problem: 'audio_missing' | 'enhancers_used_invalid', unknown? }
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { isAudioClip } from '../protocol/lib/audio-clip.mjs';
import { badResult } from './capability-calls.mjs';

/** 增强件的说明（不带 load），放进返回值给人看。 */
export const summarizeOffer = ({ id, model, modelVersion, capability, referenceVersion }) => ({ id, model, modelVersion, capability, referenceVersion });

/**
 * 核对一项能力返回的音频，读出它报的 enhancers_used。
 * @param {string} capability 能力名（写进报错）
 * @param {unknown} result 能力的返回值
 * @param {{ id: string }[]} offers 递给它的增强件
 * @returns {string[]} 用上的增强件 id
 */
export function readAudioResult(capability, result, offers) {
  if (!isAudioClip(result)) throw badResult(capability, 'audio_missing', '要 { bytes: Uint8Array（非空）, mimeType: audio/…, model? }');
  const used = result.enhancers_used ?? [];
  const offered = new Set(offers.map((offer) => offer.id));
  const unknown = Array.isArray(used) ? used.filter((id) => !offered.has(id)) : null;
  if (unknown === null || unknown.length > 0) {
    throw new VoicePackError('capability_result_invalid', `所需能力 ${capability} 报了没有递给它的增强件：enhancers_used 要是递给它的增强件的 id（${[...offered].join('、') || '这次没有递'}）`, { details: { capability, problem: 'enhancers_used_invalid', unknown: unknown ?? used } });
  }
  return used;
}

/**
 * 汇总这一次的增强件使用情况。
 * @param {{ id: string }[]} offers 递给能力的增强件
 * @param {{ enhancers: { used: string[] } }[]} finished 做完了的段（配音的每一段；变声只有一段）
 * @param {object[]} verification 包的验证记录（清单里的 verification）
 * @returns {{ offered: object[], used: string[], notUsed: object[], statement: 'enhancers_not_used' | null, verification?: object[] }}
 *   一个都没用上、而包里有、又确实做出了东西，statement 是 'enhancers_not_used'，并带着 verification
 */
export function summarizeUse(offers, finished, verification) {
  const used = [...new Set(finished.flatMap((item) => item.enhancers.used))];
  const missed = offers.length > 0 && finished.length > 0 && used.length === 0;
  return {
    offered: offers.map(summarizeOffer),
    used,
    notUsed: offers.filter((offer) => !used.includes(offer.id)).map(summarizeOffer),
    statement: missed ? 'enhancers_not_used' : null,
    ...(missed ? { verification } : {}),
  };
}
