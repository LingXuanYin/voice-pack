// SPDX-License-Identifier: Apache-2.0
//
// 试合成和还原度（流程层）：用做出来的包，把每条留出录音的文本合成一遍，再量还原度，写进验证记录。
// 量还原度的规则和读法，正本是 lib/fidelity.mjs 的文件头；合成走配音的流程（lib/dub.mjs）。
//   @capability voice-cloning         试合成留出录音；缺了不能试合成，所以不量还原度
//   @capability style-instruction     可选：环境声明有它，试合成才把配音指引通过 instructions 传给模型（lib/dub.mjs）；没有不是错误
//   @capability speaker-verification  说话人相似度、真人基线（lib/fidelity.mjs）；缺了说话人相似度量不了（盲听照做）
//   @capability audio-text-to-text    盲听（lib/fidelity.mjs）；缺了盲听量不了
// 试合成不用 text-generation：envForTrial 把它去掉，理由和核对见它的说明。
//
//   evaluatePack(env, made, byId, { enabled, concurrency, maxErrorRate, random, externals })
//        made 是 packRolePart 做出来的包，byId 是 Map<段名, 条目>，externals 是外部资源 [{ path, url, data }]（读外部资源时不联网，用手上的字节）。
//        返回 { trial, fidelity, evaluation, redo }：
//          trial       steps.trial：{ status: 'done', capability, synthesized, failed, models, items } 或 { status: 'skipped', reason, ... }。
//                      reason：evaluate_false（options.evaluate 是 false）、no_holdout、capability_missing（点名 capability）、runtime_missing（点名 runtime）
//          fidelity    还原度报告（lib/fidelity.mjs 的 measureFidelity），或 { status: 'skipped', reason }（没试合成、或者一条都没合成出来：no_generated）
//          evaluation  量还原度用的那批数据（参考、留出录音、合成出来的录音），补做「没听成」的盲听时要用；没量就是 null
//          redo        有「没听成」时，补做要调几次（lib/fidelity.mjs 的 planRedo）；没有是 null
//        合成暂时出错的那几条记在 trial.failed 里，不进评测。
//   verificationOf(fidelity, { environment, models, now })
//        写进清单的那一条验证记录（协议的写法，protocol/FORMAT.md「角色部分的清单」）：在哪个环境、用哪个模型、哪天测的、还原度比值、量还原度的两种办法各用的哪个模型。
//        两种评测一项都没量出来，就没有东西可记，给 null。
//
// 抛出的错误：
//   make_pack_trial_mismatch  试合成规划出的段数和留出录音的条数不一样（配音把某条留出录音的文本切成了几段，或者合并了），没法把合成的音频和留出录音一条对一条地比：
//                             做包停下来，不拿对不上的东西去量还原度。details: { holdouts, units }
//   配音、还原度的错误（lib/dub.mjs、lib/fidelity.mjs 的文件头）原样往上抛；暂时出错的记在 trial.failed 和还原度报告里，不抛
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError, isVoicePackError } from '../protocol/lib/errors.mjs';
import { hasCapability } from '../protocol/lib/env.mjs';
import { measureFidelity, planRedo } from './fidelity.mjs';
import { openVoicePack, MIME_OF_FORMAT } from './voice-pack.mjs';
import { dubScript } from './dub.mjs';
import { SHORT_TEXT_MAX } from './manifest-limits.mjs';

const clipOf = (item) => ({ bytes: item.audio.bytes, mimeType: MIME_OF_FORMAT[item.format] });
const skipped = (reason, extra = {}) => ({ trial: { status: 'skipped', reason, ...extra }, fidelity: { status: 'skipped', reason: extra.capability === undefined && extra.runtime === undefined ? reason : 'no_trial' }, evaluation: null, redo: null });

/**
 * 试合成读包的时候用的环境：外部资源的字节这里已经有了（作者可能还没把音频传到清单里那个网址），读外部资源就直接给这些字节，不联网。
 * 做法同 protocol/lib/pack.mjs 做包时的自检（那里的 stubFetch）：对得上网址的给字节，别的 404。
 */
function envWithExternals(env, externals) {
  if (externals.length === 0) return env;
  const byUrl = new Map(externals.map((entry) => [entry.url, entry.data]));
  const fetch = async (url) => {
    const data = byUrl.get(url);
    if (data === undefined) return { ok: false, status: 404 };
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
  };
  return { ...env, fetch };
}

/**
 * 试合成配音时用的环境：去掉 text-generation。挑参考的那个函数（lib/reference-pick.mjs）遇到没有「怎么说」标签、参考集又各不相同的台词，环境有 text-generation 就会拿去让模型判断，
 * 那是一次收费的调用，plan.calls 里没有它，用户确认费用时看不到；app 挑参考时本来就不给，试合成量的是 app 里会得到的，所以也不给：
 * 没标签的留出录音落到默认参考。
 */
function envForTrial(env) {
  const { 'text-generation': _judge, ...capabilities } = env.capabilities;
  return { ...env, capabilities };
}

/**
 * 试合成加量还原度。用做出来的包，把每条留出录音的文本合成一遍（走配音的流程：按这条留出录音的标签挑参考，配音指引、读音词表照常用），
 * 再用 lib/fidelity.mjs 量。缺 voice-cloning 就不能试合成，评测也跳过；评测里缺的那一项（说话人验证、盲听）由 measureFidelity 报「量不了」。
 * 合成暂时出错的那几条记在 trial.failed 里，不进评测；别的错误原样抛出。
 */
export async function evaluatePack(env, made, byId, { enabled, concurrency, maxErrorRate, random, externals }) {
  if (enabled === false) return skipped('evaluate_false');
  const { manifest, files } = made;
  const holdouts = manifest.holdout ?? [];
  if (holdouts.length === 0) return skipped('no_holdout');
  if (!hasCapability(env, 'voice-cloning')) return skipped('capability_missing', { capability: 'voice-cloning' });

  const pack = await openVoicePack(files, { env: envWithExternals(env, externals) });
  let dubbed;
  try {
    dubbed = await dubScript(envForTrial(env), pack, holdouts.map((entry) => ({ text: entry.text, labels: entry.tags })), { concurrency });
  } catch (error) {
    if (isVoicePackError(error, 'runtime_missing')) return skipped('runtime_missing', { runtime: error.details.runtime });
    throw error;
  }
  if (dubbed.units.length !== holdouts.length) {
    throw new VoicePackError('make_pack_trial_mismatch', `试合成的结果和留出录音对不上：${holdouts.length} 条留出录音，配音规划出了 ${dubbed.units.length} 段`, { details: { holdouts: holdouts.length, units: dubbed.units.length } });
  }
  const items = dubbed.units.map((unit, index) => ({
    id: holdouts[index].id,
    status: unit.status,
    pick: { segmentId: unit.pick.segmentId, rule: unit.pick.rule, matched: unit.pick.matched, missed: unit.pick.missed },
    ...(unit.model === undefined ? {} : { model: unit.model }),
    ...(unit.status === 'failed' ? { error: unit.error } : {}),
  }));
  const models = [...new Set(dubbed.units.filter((unit) => unit.status === 'ok').map((unit) => unit.model).filter((model) => typeof model === 'string'))];
  const trial = {
    status: 'done',
    capability: 'voice-cloning',
    synthesized: items.filter((item) => item.status === 'ok').length,
    failed: items.filter((item) => item.status === 'failed').map((item) => ({ id: item.id, error: item.error })),
    models,
    items,
  };
  const evaluation = {
    references: manifest.reference.segments.map((entry) => ({ id: entry.id, audio: clipOf(byId.get(entry.id)), text: entry.text, labels: entry.tags })),
    holdouts: holdouts.flatMap((entry, index) => (dubbed.units[index].status === 'ok' ? [{ id: entry.id, audio: clipOf(byId.get(entry.id)), text: entry.text, labels: entry.tags, generated: dubbed.units[index].audio }] : [])),
  };
  if (evaluation.holdouts.length === 0) return { trial, fidelity: { status: 'skipped', reason: 'no_generated' }, evaluation: null, redo: null };
  const fidelity = await measureFidelity(env, evaluation, { ...(random === undefined ? {} : { random }), maxErrorRate });
  return { trial, fidelity, evaluation, redo: fidelity.notHeard.length > 0 ? planRedo(fidelity) : null };
}

/**
 * 验证记录：在哪个环境、用哪个模型、哪天测的、还原度多少、量还原度的两种办法各用的哪个模型（协议的写法，protocol/FORMAT.md「角色部分的清单」）。
 * 两种评测一项都没量出来，就没有东西可记，给 null。清单里比值的位置只有比值，所以盲听量出来了而说话人相似度量不了，fidelity 里没有 ratio。
 * measuredBy 是 { speakerVerification?, blindListening? }：各是这一种办法量还原度时用的模型名（评测报告里 models 记着，取自能力返回里的 model）。
 * 这种办法没量出来的、能力没报模型的，不写那个键；两个都没有就不写 measuredBy。
 */
export function verificationOf(fidelity, { environment, models, now }) {
  if (fidelity.overall === undefined) return null;
  const speaker = fidelity.overall.speakerSimilarity;
  const blind = fidelity.overall.blindListening;
  if (speaker.status !== 'measured' && blind.status !== 'measured') return null;
  const ratio = speaker.status === 'measured' && Number.isFinite(speaker.ratio) && speaker.ratio >= 0 ? speaker.ratio : undefined;
  const nameOf = (part, name) => (part.status === 'measured' && typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, SHORT_TEXT_MAX) : undefined);
  const speakerVerification = nameOf(speaker, fidelity.models['speaker-verification']);
  const blindListening = nameOf(blind, fidelity.models['audio-text-to-text']);
  const measuredBy = { ...(speakerVerification === undefined ? {} : { speakerVerification }), ...(blindListening === undefined ? {} : { blindListening }) };
  return {
    environment,
    model: models.length > 0 ? models.join(', ').slice(0, SHORT_TEXT_MAX) : 'unknown',
    date: now().toISOString().slice(0, 10),
    fidelity: { ...(ratio === undefined ? {} : { ratio }), ...(Object.keys(measuredBy).length === 0 ? {} : { measuredBy }) },
  };
}
