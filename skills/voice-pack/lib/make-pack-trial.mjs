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
//   evaluatePack(env, made, byId, { enabled, concurrency, maxErrorRate, random, externals, minChars })
//        made 是 packRolePart 做出来的包，byId 是 Map<段名, 条目>，externals 是外部资源 [{ path, url, data }]（读外部资源时不联网，用手上的字节）。
//        minChars 是合成能力一次至少要的字数（环境声明的，没有就不给）：留出录音的文字不够它的，不合成、不调用能力（见下 items）。
//        返回 { trial, fidelity, evaluation, redo }：
//          trial       steps.trial：{ status: 'done', capability, synthesized, failed, retried, models, items } 或 { status: 'skipped', reason, ... }。
//                      synthesized 是合成出来的条数（作废的也算在内）；retried 是暂时出错多合成了几次；
//                      items 每条留出录音一项：{ id, status: 'ok' | 'failed' | 'skipped', pick, model?, error?, check? }。
//                      status 是 'failed' 的只有暂时出错、试满次数还没合成出来的（trial.failed 也是它们）；'skipped' 的是文字比字数下限短的：
//                      reason 是 'too_short'，chars 是它的字数，min 是下限，没有合成，不进比值，不算费用（和暂时出错、作废分开报）。
//                      这一条的 pick 照常有（挑它的参考的理由，report 里还用它）。check 是合成出来的那一句的检查（checkSynthesized）：
//                      checked（量了，正常）、voided（作废，codes 写明为什么，带量到的静音占比和时长）、unchecked（没查到，reason 写明为什么，照旧量）
//                      reason：evaluate_false（options.evaluate 是 false）、no_holdout、capability_missing（点名 capability）、runtime_missing（点名 runtime）
//          fidelity    还原度报告（lib/fidelity.mjs 的 measureFidelity），或 { status: 'skipped', reason }（一条都没合成出来：no_generated；合成出来的都作废了：generated_voided）
//          evaluation  量还原度用的那批数据（参考、留出录音、合成出来的录音），补做「没听成」的盲听时要用；没量就是 null
//          redo        有「没听成」时，补做要调几次（lib/fidelity.mjs 的 planRedo）；没有是 null
//        合成暂时出错的，每条留出录音最多试 3 次（lib/call-attempts.mjs，envForTrial）；试满了还是出错的记在 trial.failed 里，不进评测。
//        作废的（check.status 是 voided）也不进评测；没查到的照旧量。
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
import { hasCapability, requireCapability } from '../protocol/lib/env.mjs';
import { measureFidelity, planRedo } from './fidelity.mjs';
import { openVoicePack, MIME_OF_FORMAT } from './voice-pack.mjs';
import { dubScript, TEXT_TOO_SHORT } from './dub.mjs';
import { SHORT_TEXT_MAX } from './manifest-limits.mjs';
import { callWithRetries, spent } from './call-attempts.mjs';
import { decodeAudio, decodeFailureKind } from '../tools/audio-decode.mjs';
import { measureAudio } from '../tools/audio-quality.mjs';

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
 * 合成出来的一句进还原度之前的检查线。依据是这台机器上量出来的数，量法和解码和检查用的是同一条路（measureAudio、decodeAudio）：
 *   用来对照的录音：84 条非残片（配音、走查、试合成、Neta 的克隆、语音设计、有声书；不全是音色克隆的合成，最长 26.98 秒）；
 *                   2 条残片（Neta 的 gorrath ref2；走查里的 i-openai-speech.mp3，它和同名的另一份字节相同，模型没查证），同为 40.68 秒。
 *                   这些录音没有随基础部分一起放出，没法重新量；要复现，就用 decodeAudio 解码，再用 measureAudio 量同一个文件。
 *   silenceRatio   静音占比超过它，就是「几乎全是静音」。84 条里最大 0.393；两条残片是 0.846 和 0.917。0.6 落在中间，离两边都远。
 *                  它和参考音频的 reject 线（tools/audio-quality.mjs）是同一个数，但判的是「这一句合成的话几乎没有说话」，不是参考的要求。
 *   durationRatio  时长和同一句的留出录音（做包时量过的）的比值超过它，或者不到它的倒数，就作废。8 对（一条合成的 mp3，和同一句人录的留出录音）比值 0.707 到 1.002。
 *                  残片对测试里配的 5.5 秒留出录音是 7.4 倍。2 落在两者之间，离两边都远。短的一头没有见过残片，取它的倒数对称，这是选的，不是量出来的。
 *   解不开的（环境没有 ffmpeg，又不是 WAV）：没查到，不作废，照旧量（见 checkSynthesized）。
 */
const SYNTHESIZED_LIMITS = Object.freeze({ silenceRatio: 0.6, durationRatio: 2 });

/** 同一句的留出录音的时长（做包时 screen 量过的，lib/make-pack-screen.mjs）；没量过（或者量不出来）就是 undefined，时长那一条不比。 */
const holdoutSecondsOf = (byId, id) => {
  const quality = byId.get(id)?.quality;
  return quality?.status === 'checked' && Number.isFinite(quality.metrics?.durationSec) ? quality.metrics.durationSec : undefined;
};

/**
 * 合成出来的一句进还原度之前的检查。量法用 tools/audio-quality.mjs 的 measureAudio（只有这一份量法），解码用 tools/audio-decode.mjs 的 decodeAudio。
 * 判的是这一句自己的：不套参考音频的阈值（5–20 秒是对参考的要求，不是对一句合成的要求）。看两样：
 *   几乎全是静音：静音占比超过 SYNTHESIZED_LIMITS.silenceRatio；量不出来（一个完整的窗口都没有）也算；
 *   时长和同一句的留出录音差得离谱：超过它的 durationRatio 倍，或者不到它的倒数；留出录音没量过时长的，这一条不比。
 * 解不开（环境没有 ffmpeg 又不是 WAV，或者字节本身不是音频）：没查到（unchecked），照旧量，报告写明原因。没查到不等于有问题，所以不作废。
 * 返回 { status: 'checked' | 'voided' | 'unchecked', ... }：checked 和 voided 带 durationSec、silenceRatio（有留出录音时长的还带 holdoutSec）；
 * voided 带 codes（synthesized_mostly_silent、synthesized_too_long、synthesized_too_short）；unchecked 带 reason（runtime_missing 时带 runtime）。
 */
async function checkSynthesized(env, clip, holdoutSec) {
  let metrics;
  try {
    metrics = measureAudio(await decodeAudio(env, clip.bytes));
  } catch (error) {
    const kind = decodeFailureKind(error);
    if (kind === 'runtime_missing') return { status: 'unchecked', reason: 'runtime_missing', runtime: error.details.runtime };
    if (kind === 'undecodable') return { status: 'unchecked', reason: 'undecodable' };
    throw error;
  }
  const { durationSec, silenceRatio } = metrics;
  const codes = [];
  if (silenceRatio === null || silenceRatio > SYNTHESIZED_LIMITS.silenceRatio) codes.push('synthesized_mostly_silent');
  if (holdoutSec !== undefined) {
    const ratio = durationSec / holdoutSec;
    if (ratio > SYNTHESIZED_LIMITS.durationRatio) codes.push('synthesized_too_long');
    else if (ratio < 1 / SYNTHESIZED_LIMITS.durationRatio) codes.push('synthesized_too_short');
  }
  const measured = { durationSec, silenceRatio, ...(holdoutSec === undefined ? {} : { holdoutSec }) };
  return codes.length === 0 ? { status: 'checked', ...measured } : { status: 'voided', codes, ...measured };
}

/**
 * 试合成配音时用的环境：去掉 text-generation。挑参考的那个函数（lib/reference-pick.mjs）遇到没有「怎么说」标签、参考集又各不相同的台词，环境有 text-generation 就会拿去让模型判断，
 * 那是一次收费的调用，plan.calls 里没有它，用户确认费用时看不到；app 挑参考时本来就不给，试合成量的是 app 里会得到的，所以也不给：
 * 没标签的留出录音落到默认参考。
 *
 * 合成的调用包一层：暂时出错的就按 lib/call-attempts.mjs 的规则再来，每条留出录音最多 3 次。dub 每条只调一次合成，
 * 所以 tries 里每一项是一条留出录音用了几次；试满了还是暂时出错的那一条，错误带上次数原样交回去（spent），dub 把它记成 failed。
 */
function envForTrial(env, { wait, tries }) {
  const { 'text-generation': _judge, ...capabilities } = env.capabilities;
  const clone = requireCapability(env, 'voice-cloning');
  capabilities['voice-cloning'] = async (call) => {
    const outcome = await callWithRetries(() => clone(call), { wait });
    tries.push(outcome.attempts);
    if ('error' in outcome) throw spent(outcome.error, outcome.attempts);
    return outcome.result;
  };
  return { ...env, capabilities };
}

/**
 * 试合成加量还原度。用做出来的包，把每条留出录音的文本合成一遍（走配音的流程：按这条留出录音的标签挑参考，配音指引、读音词表照常用），
 * 再用 lib/fidelity.mjs 量。缺 voice-cloning 就不能试合成，评测也跳过；评测里缺的那一项（说话人验证、盲听）由 measureFidelity 报「量不了」。
 * 合成暂时出错的，每条留出录音照 lib/call-attempts.mjs 的规则最多试 3 次（envForTrial）；试满了还是出错的记在 trial.failed 里，不进评测；别的错误原样抛出。
 * 合成出来的每一句，量还原度之前先检查（checkSynthesized）：几乎全是静音、时长和同一句的留出录音差得离谱的作废，不进评测，报告里逐条写明；
 * 解不开的没查到，照旧量。全部作废，还原度跳过，原因 generated_voided（量不出来是因为这些录音都作废了，不写验证记录）。
 * 评测的 evaluation.holdouts 只有没作废的那几条。
 */
export async function evaluatePack(env, made, byId, { enabled, concurrency, maxErrorRate, random, externals, wait, minChars }) {
  if (enabled === false) return skipped('evaluate_false');
  const { manifest, files } = made;
  const holdouts = manifest.holdout ?? [];
  if (holdouts.length === 0) return skipped('no_holdout');
  if (!hasCapability(env, 'voice-cloning')) return skipped('capability_missing', { capability: 'voice-cloning' });

  const pack = await openVoicePack(files, { env: envWithExternals(env, externals) });
  const tries = [];
  let dubbed;
  try {
    // joinShort: false，每条留出录音一段：短的不并进邻居（并了就对不上留出录音），不够下限的记成 text_too_short，不合成
    dubbed = await dubScript(envForTrial(env, { wait, tries }), pack, holdouts.map((entry) => ({ text: entry.text, labels: entry.tags })), { concurrency, minChars, joinShort: false });
  } catch (error) {
    if (isVoicePackError(error, 'runtime_missing')) return skipped('runtime_missing', { runtime: error.details.runtime });
    throw error;
  }
  if (dubbed.units.length !== holdouts.length) {
    throw new VoicePackError('make_pack_trial_mismatch', `试合成的结果和留出录音对不上：${holdouts.length} 条留出录音，配音规划出了 ${dubbed.units.length} 段`, { details: { holdouts: holdouts.length, units: dubbed.units.length } });
  }
  // 合成出来的每一句，量还原度之前先检查：几乎全是静音、时长和同一句的留出录音差得离谱的，作废，不进比值
  const checks = [];
  for (const [index, unit] of dubbed.units.entries()) {
    checks.push(unit.status === 'ok' ? await checkSynthesized(env, unit.audio, holdoutSecondsOf(byId, holdouts[index].id)) : undefined);
  }
  const items = dubbed.units.map((unit, index) => {
    const pick = { segmentId: unit.pick.segmentId, rule: unit.pick.rule, matched: unit.pick.matched, missed: unit.pick.missed };
    // 文字不够字数下限：没合成，不是暂时出错（那是 failed），原因和字数写明
    if (unit.status === 'failed' && unit.error?.code === TEXT_TOO_SHORT) return { id: holdouts[index].id, status: 'skipped', reason: 'too_short', chars: unit.error.details.chars, min: unit.error.details.min, pick };
    return {
      id: holdouts[index].id,
      status: unit.status,
      pick,
      ...(unit.model === undefined ? {} : { model: unit.model }),
      ...(unit.status === 'failed' ? { error: unit.error } : {}),
      ...(checks[index] === undefined ? {} : { check: checks[index] }),
    };
  });
  const models = [...new Set(dubbed.units.filter((unit) => unit.status === 'ok').map((unit) => unit.model).filter((model) => typeof model === 'string'))];
  const trial = {
    status: 'done',
    capability: 'voice-cloning',
    synthesized: items.filter((item) => item.status === 'ok').length,
    failed: items.filter((item) => item.status === 'failed').map((item) => ({ id: item.id, error: item.error })),
    retried: tries.reduce((total, count) => total + count - 1, 0), // 为暂时出错多合成了几次（每条留出录音的次数减 1）
    models,
    items,
  };
  // 进比值的：合成出来、又没有作废的（没查到的照旧进）
  const measuredAt = (index) => dubbed.units[index].status === 'ok' && checks[index].status !== 'voided';
  const evaluation = {
    references: manifest.reference.segments.map((entry) => ({ id: entry.id, audio: clipOf(byId.get(entry.id)), text: entry.text, labels: entry.tags })),
    holdouts: holdouts.flatMap((entry, index) => (measuredAt(index) ? [{ id: entry.id, audio: clipOf(byId.get(entry.id)), text: entry.text, labels: entry.tags, generated: dubbed.units[index].audio }] : [])),
  };
  if (evaluation.holdouts.length === 0) {
    // 合成出来的都作废了（每一条都被拦下）和一条都没合成出来，原因不一样：前者写「合成出来的录音都作废了」
    const reason = items.some((item) => item.check?.status === 'voided') ? 'generated_voided' : 'no_generated';
    return { trial, fidelity: { status: 'skipped', reason }, evaluation: null, redo: null };
  }
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
