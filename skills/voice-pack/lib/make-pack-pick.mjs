// SPDX-License-Identifier: Apache-2.0
//
// 挑参考（流程层）：把筛过、定了语言的片段分成参考集、留出录音和没用上的，每种语言挑出一段默认参考段。
// 哪些当参考、哪些当留出录音、默认参考段怎么挑，规则的正本是 lib/pack-material.mjs 的文件头（纯数据）；这里是它和做包的条目之间的一层：
// 把条目整理成它要的候选，把它的结论写回条目，没有一段能用、选出来的和作者明说的对不上时报错。
//
//   assertDefaultsUsable(items, defaultSegments, materialOptions)     作者点名的默认段这次当不了，在花钱之前就报：已经被淘汰了；是新补的、上一版的参考加上新补的点名的放不进参考上限；
//                                                                     两段点名的是同一种语言（花钱之前就知道语言的段才查得出，lib/make-pack-tags.mjs 的 languageBeforeSpending）
//   assertSomeUsable(env, items)                                      花钱之前就看得出一段能用的都没有（筛片段淘汰了，或者没有逐字文本、环境又不能转写）：报 make_pack_no_material，dryRun 也报
//   pickMaterial(env, items, { previous, version, materialOptions, referencedTags?, maxErrorRate?, wait? })
//                                                                     挑（异步：环境有能听音频的模型、说话人相似度时要问、要量）。返回 { chosen, roleOf }：chosen 是 chooseMaterial 的结果
//                                                                     （references、holdouts、unused、defaultSegment、defaultRule、defaultLanguage、languageDefaults，规则见 lib/pack-material.mjs 的规则 5）；
//                                                                     主语言的默认段的几项在 chosen 上，别的语言的在 chosen.languageDefaults 的各项（{ id, language, rule, ... }）上：
//                                                                     rule（defaultRule）在这里报成 'author' 或 'previous'，别的原样；模型挑的（'model'）还有 listened，问了模型没挑成的还有 unpicked，
//                                                                     量相似度出错、退回按优先级的还有 unmeasured，写法见下。roleOf 是 Map<段名, 'reference' | 'holdout'>。
//                                                                     version 是 readInput 整理的版本字段，materialOptions 是挑素材的选项；referencedTags 是设定引用的音色基底标签
//                                                                     （lib/make-pack-tags.mjs 的 referencedTagsOf，交给 chooseMaterial，规则 3、4）；maxErrorRate 是收音校验的上限，wait 是暂时出错再问之前怎么等（同 lib/call-attempts.mjs）
//   isPlainSpeech 是文本能不能原样交给配音（留出录音要拿它合成，再和原话比），不是对外的函数，规则写在它上面的说明里
//
// 每种语言各挑一段默认段（规则的正本是 lib/pack-material.mjs 的规则 5）。一种语言的默认段不是沿用的、作者没有点名、候选有几段时，按这个次序挑：
//   1. 环境有 audio-text-to-text：请能听音频的模型在这种语言的候选里挑最自然、带表演的一段（lib/default-pick.mjs），候选按优先级取前 MAX_PICK_CANDIDATES 段，交的是原始录音（调响度之前）。
//      每种语言一次调用（几种语言就问几次，一次只交一种语言的段）；暂时出错按 lib/call-attempts.mjs 的规则再问（每次最多问 MAX_ATTEMPTS 次），
//      费用估算里算着每种语言这一次和它的重试（lib/make-pack-plan.mjs）。
//      挑成了：listened 是 { candidates, why, attempts, model? }（交给它的段名、它说的理由、问了几次、模型）。
//      没挑成（回答作废、没听成，或者调用抛了下面「退回」的错）：unpicked 是 { capability: 'audio-text-to-text', candidates, status: 'voided' | 'not_heard' | 'failed',
//        reason?, errorRate?, problem?, stopReason?, error?, attempts?, model? }（status、reason 和别的几项见 lib/default-pick.mjs 的返回；failed 的 error 是错误的摘要），这种语言接着照第 2、3 条挑。
//   2. 环境有 speaker-verification：挑和其余参考平均最像的一段。只量参考之间的两两，每一对一次（几种语言合起来量一遍，量过的一对不再量）；量的是原始录音（调响度之前）。
//      报 no_speech 的那一对不算（那一段嵌不出声纹）。量的时候出了错（「退回」的那种）：这几种语言的 unmeasured 是 { capability, error }（错误的摘要，summarizeError），照第 3 条挑。
//   3. 按优先级排第一的那段。
// 问模型、量相似度时出的错分两类：调用方中止（AbortError）和凭据被拒（HTTP 401，或者适配器之后的调用带 details.halted；判法是 lib/capability-calls.mjs 的 keepsThrowing）照旧往上抛；其余的一律退回，做包接着做。
// 理由：挑默认段只是让默认段更好，不是做包必须的；这一步在花钱的转写之后，抛出去就是钱花了、包没做成。留出录音从不交给模型、从不量，挑默认段不看它们。
//
// 发新版本（previous 不是 null）时，上一版的段保持原来的角色（fixed），主语言照旧是上一版的（上一版主默认段的语言，参考集里还有这种语言的段的话），
// 每种语言的默认段沿用的条件见 lib/pack-material.mjs 的规则 5（作者这次点名的照点名，别的语言照旧沿用上一版的）。上一版带过来的段按现在的阈值可能是 reject：
// 它们不淘汰（lib/make-pack-screen.mjs），排优先级时按 warn 看；报告里的 quality 还是真实的结论。
//
// 读条目的：id、index、unused、quality、text、language、givenTag（分组用的原名，lib/make-pack-tags.mjs 的 groupTagOf）、previous、synthetic、audio（问模型、量相似度用）；
// 写条目的：unused（chooseMaterial 淘汰的：reason 是 over_limit 等，details 是 {}）。
//
// 抛出的错误（details 的写法见 lib/make-pack.mjs 文件头「抛出的错误」）：
//   make_pack_no_material    没有一段能用，做不出包。花钱之前看得出的由 assertSomeUsable 报，转写以后才看得出的（转写不出文本、认不出语言……）由 pickMaterial 报
//   make_pack_input_invalid  点名的默认段这次被淘汰了，或者新补的它进不了参考集，或者两段点名的是同一种语言（field 是 defaultSegment）；去掉以后参考集里一段都不剩（field 是 drop）
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { hasCapability } from '../protocol/lib/env.mjs';
import { CUE_PATTERN, parseScript } from '../tools/markup.mjs';
import { readDirections } from './line-hints.mjs';
import { summarizeError, keepsThrowing } from './capability-calls.mjs';
import { MAX_ATTEMPTS } from './call-attempts.mjs';
import { MAX_PICK_CANDIDATES, pickByListening } from './default-pick.mjs';
import { isNoSpeechError, speakerSimilarity, tokenizeTranscript } from './fidelity.mjs';
import { DEFAULTS, chooseMaterial, defaultCandidatesOf } from './pack-material.mjs';
import { invalid } from './make-pack-input.mjs';
import { languageBeforeSpending, groupTagOf } from './make-pack-tags.mjs';
import { languageKey, segmentLanguage } from '../protocol/lib/manifest.mjs';
import { usableItems } from './make-pack-plan.mjs';

const ASR = 'automatic-speech-recognition';

/**
 * 没有一段能用、做不出包（make_pack_no_material）。unused 是每种原因的段数（{ no_text: 2, duplicate_audio: 1 }）。
 * missingCapability 是因为环境缺它才有段用不上的那项能力：有段没有逐字文本、环境又没有 automatic-speech-recognition 转写。这时说明里写怎么办；没有就不给这个键。
 */
function noMaterial(unused, missingCapability) {
  const counts = Object.entries(unused).map(([reason, count]) => `${reason} ${count} 段`).join('、');
  const remedy = missingCapability === undefined
    ? ''
    : `。没有逐字文本的 ${unused.no_text} 段要转写，这个环境没有 ${missingCapability}：接一个有 ${missingCapability} 的适配器，或者给每段配上逐字文本`;
  return new VoicePackError('make_pack_no_material', `没有一段能用，做不出包：${counts}${remedy}`, { details: { unused, ...(missingCapability === undefined ? {} : { missingCapability }) } });
}

/**
 * 花钱之前（规划之后）就看得出一段能用的都没有：能用的段（lib/make-pack-plan.mjs 的 usableItems，规划里数的是同一份）是 0。
 * 这时每一段要么筛片段淘汰了（原因照它的），要么没有逐字文本、环境又不能转写（记成 no_text，details.missingCapability 是 automatic-speech-recognition）。
 * dryRun 也报，一次能力都不调；还有能用的段就什么都不做。转写以后才知道用不上的（转写不出文本、认不出语言），还是 pickMaterial 报。
 */
export function assertSomeUsable(env, items) {
  if (usableItems(env, items).length > 0) return;
  const unused = {};
  let textless = 0;
  for (const item of items) {
    if (item.unused === undefined) textless += 1;
    const reason = item.unused?.reason ?? 'no_text';
    unused[reason] = (unused[reason] ?? 0) + 1;
  }
  throw noMaterial(unused, textless > 0 ? ASR : undefined);
}

/**
 * 文本能不能原样交给配音：没有台本标记、方括号的提示、舞台说明、换行（配音会把它们当成要求、不念出来，念出来的和原话就对不上了）。
 * 读舞台提示要和配音（lib/dub.mjs）读的一样：括号里词表认不出的内容，配音也拿掉，所以明确选「拿掉」；用默认的「保留」，
 * 「He said (see Table 2) that…」会被当成原样能配音，试合成念出来的却没有括号里的字。
 */
function isPlainSpeech(text) {
  const chapters = parseScript(text);
  if (chapters.length !== 1 || chapters[0].spans.length !== 1) return false;
  const [span] = chapters[0].spans;
  if (span.voice_id !== null || span.pause_ms_after !== 0 || span.text !== text.trim() || new RegExp(CUE_PATTERN).test(span.text)) return false;
  const { pieces, directions } = readDirections(span.text, { unrecognized: 'remove' });
  return directions.length === 0 && pieces.length === 1 && pieces[0].text === span.text;
}

/**
 * 两段点名的默认段是同一种语言（按 languageKey 比），报 make_pack_input_invalid（field 是 defaultSegment）。languageOf(item) 是这一段的语言，不知道是 null（不查）。
 */
function assertOnePerLanguage(items, defaultSegments, languageOf) {
  const seen = new Map(); // 规范化以后的语言 -> 先点名的那一段
  for (const id of defaultSegments) {
    const item = items.find((entry) => entry.id === id);
    const language = item === undefined ? null : languageOf(item);
    if (language === null || language === undefined) continue;
    const key = languageKey(language);
    if (seen.has(key)) throw invalid('defaultSegment', `${JSON.stringify(seen.get(key))} 和 ${JSON.stringify(id)} 都是 ${language}：一种语言只能点名一段默认段`);
    seen.set(key, id);
  }
}

/**
 * 作者点名的默认段，这次当不了的，在花钱之前就报（field 是 defaultSegment）：
 *   这次没能用上（筛片段淘汰了：重复、解不了……）；
 *   或者是新补的，而上一版的参考加上新补的点名的已经超过参考上限：规则 4 不裁点名的，但已有的参考保持原来的角色，放不下的进不了参考集（lib/pack-material.mjs）；
 *   或者两段是同一种语言（花钱之前就知道语言的才查得出：调用方给了语言，或者有文本、从文字认得出；要转写的段，语言定了以后在 pickMaterial 里查）。
 * materialOptions 是调用方给的挑素材选项（这里只用 maxReferences；没给就是 lib/pack-material.mjs 的默认值）。
 */
export function assertDefaultsUsable(items, defaultSegments, materialOptions = {}) {
  const wanted = defaultSegments.map((id) => items.find((item) => item.id === id)).filter((item) => item !== undefined);
  const gone = wanted.find((item) => item.unused !== undefined);
  if (gone !== undefined) throw invalid('defaultSegment', `${JSON.stringify(gone.id)} 这次没能用上（${gone.unused.reason}），当不了默认参考段`);
  const cap = materialOptions.maxReferences ?? DEFAULTS.maxReferences;
  const previousReferences = items.filter((item) => item.previous === 'reference' && item.unused === undefined).length;
  const fresh = wanted.filter((item) => item.previous === undefined);
  if (fresh.length > 0 && previousReferences + fresh.length > cap) {
    const left = fresh.slice(Math.max(0, cap - previousReferences)).map((item) => JSON.stringify(item.id)).join('、');
    throw invalid('defaultSegment', `${left} 是这次新补的，上一版的参考（${previousReferences} 段）加上新补的点名的超过了参考上限（${cap} 段），进不了参考集，当不了默认参考段`);
  }
  assertOnePerLanguage(items, defaultSegments, languageBeforeSpending);
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

/** 报告里默认段的规则：「沿用」分成作者点名的（'author'）和上一版的（'previous'），别的原样（见 lib/pack-material.mjs 的规则 5）。 */
const ruleOf = (id, rule, authored) => (rule === 'kept' ? (authored.has(id) ? 'author' : 'previous') : rule);

/**
 * 请能听音频的模型从 ids（按优先级）里挑默认段。返回 lib/default-pick.mjs 的结果；调用抛了 keepsThrowing 之外的错，返回 { status: 'failed', error: 错误的摘要 }。
 */
async function askListener(env, ids, byId, { maxErrorRate, wait }) {
  try {
    return await pickByListening(env, ids.map((id) => ({ audio: byId.get(id).audio, text: byId.get(id).text })), { maxErrorRate, attempts: MAX_ATTEMPTS, wait });
  } catch (error) {
    if (keepsThrowing(error)) throw error;
    return { status: 'failed', error: summarizeError(error) };
  }
}

/**
 * 挑参考集和留出录音，把没用上的原因写回条目；规则见 lib/pack-material.mjs。
 * 默认段：先按优先级挑一遍；每种语言的默认段不是沿用的、作者没有点名、候选有几段的，再照文件头的次序重挑：先问能听音频的模型（askListener，每种语言一次），
 * 没有这项能力或者没挑成，再量参考之间的相似度（similaritiesOf），按平均相似度挑。参考和留出录音在几遍里一样（模型挑的、相似度都不影响它们）。
 */
export async function pickMaterial(env, items, { previous, version, materialOptions, referencedTags = [], maxErrorRate, wait }) {
  const usable = items.filter((item) => item.unused === undefined);
  if (usable.length === 0) {
    const unused = {};
    for (const item of items) unused[item.unused.reason] = (unused[item.unused.reason] ?? 0) + 1;
    throw noMaterial(unused);
  }
  // 语言到这里都定了（转写以后）：两段点名的是同一种语言，花钱之前没查出来的（要转写的段），这里报
  assertOnePerLanguage(usable, version.defaultSegments, (item) => item.language.value);

  const candidates = usable.map((item) => ({
    id: item.id,
    order: item.index,
    // 音质结论只有 ok 和 warn（tools/audio-quality.mjs）；上一版带过来的段也不淘汰（见 screen），排优先级时就用它
    verdict: item.quality?.status === 'checked' ? item.quality.verdict : 'unchecked',
    durationSec: item.quality?.metrics?.durationSec ?? null,
    tokens: tokenizeTranscript(item.text).length,
    textChars: [...item.text].length,
    plain: isPlainSpeech(item.text),
    synthetic: item.synthetic === true,
    language: item.language.value,
    ...(groupTagOf(item) === undefined ? {} : { tag: groupTagOf(item) }),
  }));
  const before = previous?.manifest.reference;
  const options = {
    ...materialOptions,
    // 发新版本：上一版的段保持原来的角色，主语言照旧是上一版主默认段的语言（参考集里还有这种语言的段的话，pack-material 的规则 5）
    ...(previous === null ? {} : {
      fixed: Object.fromEntries(usable.filter((item) => item.previous !== undefined).map((item) => [item.id, item.previous])),
      mainLanguage: segmentLanguage(before.segments.find((segment) => segment.id === before.defaultSegment)),
    }),
    // 点名的默认段：作者这次点名的在前，上一版的（主语言的和别的语言的）在后；一种语言取先列的那段（还在参考集里的话，pack-material 的规则 5）
    languageDefaults: [...version.defaultSegments, ...(previous === null ? [] : [before.defaultSegment, ...(before.languageDefaults ?? [])])],
    // 设定引用的标签：在一种语言里只有一段的，不当留出录音、参考上限不裁（pack-material 的规则 3、4）
    ...(referencedTags.length === 0 ? {} : { referencedTags }),
  };
  const authored = new Set(version.defaultSegments);
  const entriesOf = (result) => [{ id: result.defaultSegment, language: result.defaultLanguage, rule: result.defaultRule }, ...result.languageDefaults];
  // 作者点名了的语言不重挑：点名的就是它（不在参考集里，下面就报错，不先去问、去量）
  const named = new Set(usable.filter((item) => authored.has(item.id)).map((item) => languageKey(item.language.value)));
  const stillOpen = (result) => new Set(entriesOf(result).filter((entry) => entry.rule === 'priority' && !named.has(languageKey(entry.language))).map((entry) => languageKey(entry.language)));
  let chosen = chooseMaterial(candidates, options);
  const extra = new Map(); // 规范化以后的语言 -> { listened? , unpicked?, unmeasured? }
  const note = (key, fields) => extra.set(key, { ...(extra.get(key) ?? {}), ...fields });
  // 按优先级挑的（不是点名的、不是沿用的、候选不止一段）才重挑
  let open = stillOpen(chosen);
  if (open.size > 0) {
    const byId = new Map(usable.map((item) => [item.id, item]));
    const candidateOf = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    // 每种语言的候选，按优先级（同 pack-material 的规则 5）
    const groups = defaultCandidatesOf(chosen.references.map((id) => candidateOf.get(id))).filter((group) => open.has(languageKey(group.language)));
    const picked = [];
    if (hasCapability(env, 'audio-text-to-text')) {
      for (const group of groups) {
        const asked = group.candidates.slice(0, MAX_PICK_CANDIDATES).map((candidate) => candidate.id);
        const { status, ...outcome } = await askListener(env, asked, byId, { maxErrorRate, wait });
        if (status === 'picked') {
          picked.push(asked[outcome.index]);
          note(languageKey(group.language), { listened: { candidates: asked, why: outcome.why, attempts: outcome.attempts, ...(outcome.model === undefined ? {} : { model: outcome.model }) } });
        } else {
          note(languageKey(group.language), { unpicked: { capability: 'audio-text-to-text', candidates: asked, status, ...outcome } });
        }
      }
      if (picked.length > 0) chosen = chooseMaterial(candidates, { ...options, picked });
    }
    open = stillOpen(chosen);
    if (open.size > 0 && hasCapability(env, 'speaker-verification')) {
      const refs = chosen.references.map((id) => ({ id, audio: byId.get(id).audio }));
      const targets = groups.filter((group) => open.has(languageKey(group.language))).flatMap((group) => group.candidates.map((candidate) => candidate.id));
      let similarities = null;
      try {
        similarities = await similaritiesOf(env, refs, targets);
      } catch (error) {
        if (keepsThrowing(error)) throw error;
        const unmeasured = { capability: 'speaker-verification', error: summarizeError(error) };
        for (const key of open) note(key, { unmeasured });
      }
      if (similarities !== null) chosen = chooseMaterial(candidates, { ...options, picked, similarities });
    }
  }
  if (chosen.references.length === 0) throw invalid('drop', '去掉以后参考集里一段都不剩：至少要留一段参考');
  const defaults = new Set(entriesOf(chosen).map((entry) => entry.id));
  const missing = version.defaultSegments.find((id) => !defaults.has(id));
  if (missing !== undefined) throw invalid('defaultSegment', `${JSON.stringify(missing)} 这次没进参考集，当不了默认参考段`);
  for (const dropped of chosen.unused) items.find((item) => item.id === dropped.id).unused = { reason: dropped.reason, details: {} };
  const roleOf = new Map([...chosen.references.map((id) => [id, 'reference']), ...chosen.holdouts.map((id) => [id, 'holdout'])]);
  const mainExtra = extra.get(languageKey(chosen.defaultLanguage)) ?? {};
  return {
    chosen: {
      ...chosen,
      defaultRule: ruleOf(chosen.defaultSegment, chosen.defaultRule, authored),
      ...mainExtra,
      languageDefaults: chosen.languageDefaults.map((entry) => ({ ...entry, rule: ruleOf(entry.id, entry.rule, authored), ...(extra.get(languageKey(entry.language)) ?? {}) })),
    },
    roleOf,
  };
}
