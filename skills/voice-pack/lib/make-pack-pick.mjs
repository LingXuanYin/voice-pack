// SPDX-License-Identifier: Apache-2.0
//
// 挑参考（流程层）：把筛过、打好标签的片段分成参考集、留出录音和没用上的，挑出默认参考段。
// 哪些当参考、哪些当留出录音、默认参考段怎么挑，规则的正本是 lib/pack-material.mjs 的文件头（纯数据）；这里是它和做包的条目之间的一层：
// 把条目整理成它要的候选，把它的结论写回条目，没有一段能用、选出来的和作者明说的对不上时报错。
//
//   assertDefaultUsable(items, defaultSegment)                        作者明说的默认参考段这次已经被淘汰了，当不了：在花钱之前就报
//   pickMaterial(env, items, { previous, version, materialOptions })  挑（异步：环境有说话人相似度时要量）。返回 { chosen, roleOf }：chosen 是 chooseMaterial 的结果
//                                                                     （references、holdouts、unused、defaultSegment、defaultRule，规则见 lib/pack-material.mjs 的规则 5；
//                                                                     defaultRule 在这里报成 'author' 或 'previous'，别的原样；量相似度出错、退回按优先级的还有 unmeasured），roleOf 是 Map<段名, 'reference' | 'holdout'>。
//                                                                     version 是 readInput 整理的版本字段，materialOptions 是挑素材的选项
//   isPlainSpeech 是文本能不能原样交给配音（留出录音要拿它合成，再和原话比），不是对外的函数，规则写在它上面的说明里
//
// 挑最典型的默认参考段要的说话人相似度（env 有 speaker-verification 时）：只量参考之间的两两，每一对一次；量的是原始录音（调响度之前）。
// 报 no_speech 的那一对不算（那一段嵌不出声纹）。量的时候出的错分两类：调用方中止（AbortError）和凭据被拒（HTTP 401，或者适配器之后的调用带 details.halted）
// 照旧往上抛；其余的一律退回按优先级挑这一次的默认段，报告的 defaultSegment.unmeasured 写明能力和错误的摘要（summarizeError），做包接着做。
// 理由：挑最典型的一段只是让默认段更好，不是做包必须的；这一步在花钱的打标签之后，抛出去就是钱花了、包没做成。留出录音从不量，挑默认段不看它们。
//
// 发新版本（previous 不是 null）时，上一版的段保持原来的角色（fixed），默认参考段沿用（作者明说换的除外）。上一版带过来的段按现在的阈值可能是 reject：
// 它们不淘汰（lib/make-pack-screen.mjs），排优先级时按 warn 看；报告里的 quality 还是真实的结论。
//
// 读条目的：id、index、unused、quality、text、tags、previous、audio（相似度用）；写条目的：unused（chooseMaterial 淘汰的：reason 是 over_limit 等，details 是 {}）。
//
// 抛出的错误（details 的写法见 lib/make-pack.mjs 文件头「抛出的错误」）：
//   make_pack_no_material    没有一段能用，做不出包
//   make_pack_input_invalid  默认参考段这次被淘汰了，或者没进参考集（field 是 defaultSegment）；去掉以后参考集里一段都不剩（field 是 drop）
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError, isVoicePackError } from '../protocol/lib/errors.mjs';
import { hasCapability } from '../protocol/lib/env.mjs';
import { parseScript } from '../tools/markup.mjs';
import { readDirections } from './line-hints.mjs';
import { summarizeError } from './capability-calls.mjs';
import { isNoSpeechError, speakerSimilarity, tokenizeTranscript } from './fidelity.mjs';
import { chooseMaterial, defaultCandidatesOf } from './pack-material.mjs';
import { invalid } from './make-pack-input.mjs';

/**
 * 文本能不能原样交给配音：没有台本标记、舞台提示、换行（配音会把它们当成要求，念出来的和原话就对不上了）。
 * 读舞台提示要和配音（lib/dub.mjs）读的一样：括号里词表认不出的内容，配音也拿掉，所以明确选「拿掉」；用默认的「保留」，
 * 「He said (see Table 2) that…」会被当成原样能配音，试合成念出来的却没有括号里的字。
 */
function isPlainSpeech(text) {
  const chapters = parseScript(text);
  if (chapters.length !== 1 || chapters[0].spans.length !== 1) return false;
  const [span] = chapters[0].spans;
  if (span.voice_id !== null || span.pause_ms_after !== 0 || span.speed !== null || span.text !== text.trim()) return false;
  const { pieces, directions } = readDirections(span.text, { unrecognized: 'remove' });
  return directions.length === 0 && pieces.length === 1 && pieces[0].text === span.text;
}

/** 作者明说的默认参考段，这次已经被淘汰了（没用上）：当不了默认参考段，在花钱之前就报。 */
export function assertDefaultUsable(items, defaultSegment) {
  const wanted = defaultSegment === undefined ? undefined : items.find((item) => item.id === defaultSegment);
  if (wanted?.unused !== undefined) throw invalid('defaultSegment', `${JSON.stringify(wanted.id)} 这次没能用上（${wanted.unused.reason}），当不了默认参考段`);
}

/**
 * 每段候选和其余参考的说话人相似度（挑最典型的默认段用）。只量参考之间的：留出录音一条都不碰，不然挑参考就用上了量还原度的那批录音。
 * 每一对只量一次，次序按参考集的次序（对称）。能力报 no_speech 的那一对不算（那一段嵌不出声纹，isNoSpeechError）；别的错原样抛出来，由 pickMaterial 决定（见那里）。
 * refs 是 { id, audio }，按参考集的次序；targets 是要量的段名（候选）。返回 { [段名]: 和其余参考的相似度（数的数组，量不到的不在里面） }。
 */
async function similaritiesOf(env, refs, targets) {
  const position = new Map(refs.map((ref, index) => [ref.id, index]));
  const known = new Map(); // 'lo|hi' -> 相似度，或者 null（这一对里有一段没有能嵌的语音）
  const similar = async (i, j) => {
    const [lo, hi] = i < j ? [i, j] : [j, i];
    const key = `${lo}|${hi}`;
    if (!known.has(key)) {
      const value = await speakerSimilarity(env, refs[lo].audio, refs[hi].audio).then(
        ({ similarity }) => similarity,
        (error) => {
          if (isNoSpeechError(error)) return null;
          throw error;
        },
      );
      known.set(key, value);
    }
    return known.get(key);
  };
  const out = {};
  for (const id of targets) {
    const i = position.get(id);
    const values = [];
    for (let j = 0; j < refs.length; j++) {
      if (j === i) continue;
      const value = await similar(i, j);
      if (value !== null) values.push(value);
    }
    out[id] = values;
  }
  return out;
}

/**
 * 量相似度时抛出的错，哪些照旧往上抛、不退回按优先级：调用方中止（AbortError，人不要了），和凭据被拒（HTTP 401，或者适配器说它之后不再发请求的 details.halted：
 * 要让使用者处理，不替它再试一次，约定见 adapters/README.md「出错的约定」）。别的错都退回按优先级。
 */
const keepsThrowing = (error) => error?.name === 'AbortError' || (isVoicePackError(error) && (error.details?.status === 401 || error.details?.halted === true));

/** 报告里默认段的规则：「沿用」分成作者明说的（'author'）和上一版的（'previous'），别的原样（见 lib/pack-material.mjs 的规则 5）。 */
const ruleOf = (chosen, version) => (chosen.defaultRule === 'kept' ? (version.defaultSegment !== undefined ? 'author' : 'previous') : chosen.defaultRule);

/**
 * 挑参考集和留出录音，把没用上的原因写回条目；规则见 lib/pack-material.mjs。
 * 默认参考段：先按优先级挑一遍；默认段不是沿用的、作者没有明说的、环境有 speaker-verification、候选有几段的，再量参考之间的相似度（similaritiesOf），
 * 按平均相似度重挑默认段。参考和留出录音在两遍里一样（相似度不影响它们），量的是调响度之前的原始录音。
 * 量的时候抛了错（keepsThrowing 之外的）：这一次的默认段就是按优先级挑的那段，返回的 chosen.unmeasured 写明能力和错误的摘要（summarizeError），做包接着做。
 */
export async function pickMaterial(env, items, { previous, version, materialOptions }) {
  const usable = items.filter((item) => item.unused === undefined);
  if (usable.length === 0) {
    const unused = {};
    for (const item of items) unused[item.unused.reason] = (unused[item.unused.reason] ?? 0) + 1;
    throw new VoicePackError('make_pack_no_material', `没有一段能用，做不出包：${Object.entries(unused).map(([reason, count]) => `${reason} ${count} 段`).join('、')}`, { details: { unused } });
  }

  const candidates = usable.map((item) => ({
    id: item.id,
    order: item.index,
    // 上一版带过来的段按现在的阈值可能是 reject：它们不淘汰（见 screen），排优先级时按 warn 看；报告里的 quality 还是真实的结论
    verdict: item.quality?.status === 'checked' ? (item.quality.verdict === 'reject' ? 'warn' : item.quality.verdict) : 'unchecked',
    durationSec: item.quality?.metrics?.durationSec ?? null,
    tokens: tokenizeTranscript(item.text).length,
    textChars: [...item.text].length,
    plain: isPlainSpeech(item.text),
    tags: item.tags,
  }));
  const options = {
    ...materialOptions,
    // 发新版本：上一版的段保持原来的角色，默认参考段沿用（明说换的除外）
    ...(previous === null ? {} : { fixed: Object.fromEntries(usable.filter((item) => item.previous !== undefined).map((item) => [item.id, item.previous])) }),
    defaultSegment: version.defaultSegment ?? previous?.manifest.reference.defaultSegment,
  };
  let chosen = chooseMaterial(candidates, options);
  let unmeasured = null;
  // 作者明说的默认段不挑（明说的就是它：不在参考集里，下面就报错，不先去量）
  if (chosen.defaultRule === 'priority' && version.defaultSegment === undefined && hasCapability(env, 'speaker-verification')) {
    const byId = new Map(usable.map((item) => [item.id, item]));
    const candidateOf = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const refs = chosen.references.map((id) => ({ id, audio: byId.get(id).audio }));
    const targets = defaultCandidatesOf(chosen.references.map((id) => candidateOf.get(id))).map((candidate) => candidate.id);
    let similarities = null;
    try {
      similarities = await similaritiesOf(env, refs, targets);
    } catch (error) {
      if (keepsThrowing(error)) throw error;
      unmeasured = { capability: 'speaker-verification', error: summarizeError(error) };
    }
    if (similarities !== null) chosen = chooseMaterial(candidates, { ...options, similarities });
  }
  if (chosen.references.length === 0) throw invalid('drop', '去掉以后参考集里一段都不剩：至少要留一段参考');
  if (version.defaultSegment !== undefined && chosen.defaultSegment !== version.defaultSegment) {
    throw invalid('defaultSegment', `${JSON.stringify(version.defaultSegment)} 这次没进参考集（新补的段按规则当了留出录音，或者超过了参考的上限），当不了默认参考段`);
  }
  for (const dropped of chosen.unused) items.find((item) => item.id === dropped.id).unused = { reason: dropped.reason, details: {} };
  const roleOf = new Map([...chosen.references.map((id) => [id, 'reference']), ...chosen.holdouts.map((id) => [id, 'holdout'])]);
  return { chosen: { ...chosen, defaultRule: ruleOf(chosen, version), ...(unmeasured === null ? {} : { unmeasured }) }, roleOf };
}
