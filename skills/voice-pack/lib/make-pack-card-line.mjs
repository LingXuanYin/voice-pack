// SPDX-License-Identifier: Apache-2.0
//
// 卡片试听那一句（流程层）：交来一句台词（agent 照这个角色的设定和角色卡写的，写法在 references/character-voice.md「卡片试听」），包做好以后用这个包自己的声音配出来，
// 写进清单的 cardLine（protocol/FORMAT.md 4.4），预览卡片放它（protocol/lib/preview-card.mjs）。它不当参考，也不是留出录音。
// 配法就是配音：交给 lib/dub.mjs 的 dubScript，不点名设定、不点名参考，所以参考、设定怎么补、舞台提示怎么读，都照配音的规矩（规则只在 lib/dub.mjs 写，这里不抄）。
// 一个请求：配音会把它配成不止一个请求的台词（长停顿、章节、太长……，在哪里切开是 lib/dub.mjs 第 5c 步的事），花钱之前就报。
// 发新版本、这次没给这一句：上一版有这一句就原样沿用（carriedCardLine，规则只在这里写）。音频放在包里的哪个路径，在 lib/make-pack-assemble.mjs。
//
//   assertCardLineSpeakable(env, stub, text, limits)   花钱之前：拿试装的包（lib/make-pack-assemble.mjs 的 preflight 返回的）规划配这一句（planDub，不花钱），
//                                                      不是正好一个能合成的请求就报错（见下）
//   voiceCardLine(env, made, text, { externals, wait, limits, previous, previousFiles, allowCrossLanguage })   用做好的包配这一句：一个请求；暂时出错照 lib/call-attempts.mjs 再来（每段最多 3 次，lib/make-pack-trial.mjs 的 envForPackDub）。
//                                                      返回 { outcome, audio }：outcome 写进报告（见下），audio 是 { text, bytes, format, seed? }（交给装包，seed 写进清单），没配成是 null。
//                                                      previous、previousFiles 同 carriedCardLine（发新版本时给，第一个版本不给）：拿来看这一次是不是用同样的请求重配（见下「seed」）
//                                                      跨语言：参考段不是这一句的语言（包里的参考是日语，这一句是英文），配出来带参考那种语言的口音。照配音的规矩（lib/dub.mjs 第 3a 步），
//                                                      不给 allowCrossLanguage: true 就不配，一次能力都不调：outcome 是 failed，error 是配音报的 dub_cross_language（details 里有参考段和两边的语言），
//                                                      提示是 card_line_cross_language（lib/material-hints.mjs），不是 card_line_failed。给了就照跨语言克隆配。
//                                                      花钱之前（assertCardLineSpeakable）不查语言：参考是哪几段、什么语言，要做完包才定
//                                                      seed：环境收 seed（seed-in-request）时，配音每个请求给同一个固定的 seed（lib/dub.mjs 第 7 步），同一个 seed 加同样的请求配出来逐样本一样，
//                                                      交同样的文字重配就救不回念错的那一句。所以这一次的请求和上一版那一句的一模一样（比法同下面沿用时的比一比：参考、请求的文字（含读音词表、
//                                                      开头补的提示、读音词表的音素）、语速、起伏，都对得上），就换一个 seed：上一版那一句的 seed 加 1（清单的 cardLine.seed；上一版没记，是 lib/dub.mjs 的 DUB_SEED 加 1），
//                                                      交给配音的是 only: [0] 加 previousSeed（规则在 lib/dub.mjs 第 7 步「seed」）。不是自动重试：只在调用方交了这一句（明说要重配）时换。
//                                                      请求不一样（换了文字、换了参考……）照旧用固定的那个。用的 seed 写进清单的 cardLine.seed（protocol/FORMAT.md 4.4）和报告
//   carriedCardLine(env, previous, made, { previousFiles, externals, limits })   发新版本、这次没给这一句：上一版的那一句沿用过来。返回 { outcome, audio }（同 voiceCardLine），
//                                                      上一版没有这一句是 null。audio 带着上一版清单里记的 seed（有的话），沿用的版本照旧记着，下一次用同样的请求重配接着加。
//                                                      规则：卡片那一句做好以后不重配，除非调用方明说要重配（交这一句，voiceCardLine）。上一版有，就原样沿用：
//                                                      台词和音频带过来，一次能力都不调，不看这一次配它会不会和上一版一样（不再要求请求一样才沿用）。
//                                                      切到另一套设定、改了读音词表、换了参考，都照旧放这一句。
//                                                      报告照样比一比：用配音的规划（planDub，不花钱）分别在上一版和这一版上配这一句，和现在的配法对不上的地方写进 reasons
//                                                      （按这个次序，名字不改：调用方按这几个名字决定要不要重配）：
//                                                        reference_changed        用的不是同一段参考（段名不一样），或者那段的录音字节、逐字稿、提示标注变了；
//                                                        request_text_changed     请求的文字不一样：读音词表换过的、请求开头补的提示（带 default 的设定的情绪、风格、能量）、读音词表的音素；
//                                                        speed_changed            要的语速不一样（带 default 的设定的 speed）；
//                                                        expressiveness_changed   要的起伏不一样（带 default 的设定的 expressiveness，写了和没写也算；配音怎么取值见 lib/dub.mjs 文件头「设定」）；
//                                                        not_one_request          有一版规划不出正好一个请求，上面几样就不比了；
//                                                        default_segment_changed  这句话的语言的默认段换了（段名不一样；找法同配音挑参考没定标签那一层，lib/reference-pick.mjs 的 defaultSegmentFor：
//                                                                                 看不出这句的语言、包里没有这种语言，比主语言的）：多半是换了声音（「换一个」），提示里写明换了声音就交 --card-line 重配。
//                                                                                 这句话的语言用各自那一版的规划认的（一版规划不出，两版都用另一版认的）。
//                                                      不比的：包里配音脚本的 text 钩子（规划时不跑）、增强件、seed。只改了它们，reasons 里没有，照样沿用。
//                                                      要按现在的配法重配（改了读音、这一句用到了那个词；直接改语速；明确要求重配；换了声音），由调用方交这一句（--card-line）。
//   limits 是 { maxChars?, minChars?, maxPauseInRequestMs? }：环境声明的合成上限，交给配音（意思见 lib/dub.mjs 的同名选项），不给就照配音的默认
//   assertCardLineSpeakable 和比一比（carriedCardLine、voiceCardLine 的「seed」）用的规划只看请求怎么切、请求里有什么，不看参考和这一句是不是一种语言：交给配音的都是 allowCrossLanguage: true
//
// 报告里的 cardLine（outcome；lib/make-pack-report.mjs 原样放进 report.cardLine，写法只在这里）：
//   { status: 'voiced', text, pick: { segmentId, tag, by }, attempts, model?, modelChange?, openingCue?, seed?, seedChange? }   配成了。pick 是配音挑的参考段、它的标签和为什么是它（lib/reference-pick.mjs 的 by），
//                                                      attempts 是合成调了几次，model 是能力报的模型，modelChange 是适配器这一次换了模型（{ from, reason }，约定在 adapters/README.md「换了模型」，
//                                                      没换就没有：写进包里的这一句是换上的模型配的，提示 card_line_model_changed），openingCue 是请求开头补的提示（lib/dub.mjs 第 7a 步，没补就没有）；
//                                                      seed 是交给合成能力的 seed（环境收 seed 才有），seedChange 是用同样的请求重配、换了 seed：{ from: 上一版的 }（见上 voiceCardLine「seed」，没换就没有）
//   { status: 'failed', text, error, attempts?, halted? }   没配成：清单里没有 cardLine，包照做。error 是错误的摘要 { code, message, details }（lib/capability-calls.mjs 的 summarizeError）；
//                                                      error.code 是 dub_cross_language 的，是参考段不是这一句的语言、没给 allowCrossLanguage（上面 voiceCardLine「跨语言」），一次都没调，没有 attempts；
//                                                      halted 为 true 是能力报凭据被拒（401）或账户停了（details.halted，lib/capability-calls.mjs 的 keepsThrowing）：要使用者先处理，提示是 card_line_halted，
//                                                      不是普通的 card_line_failed（lib/material-hints.mjs）。合成那头做完了、结果没取回的（error.details.unretrieved，lib/dub.mjs 只记这一段失败）也是 failed：
//                                                      只调了一次、不再计费，提示 card_line_failed 写明没取回、怎么手动取回（error.details.retrieve），照提示重配会再计一次费
//   { status: 'carried', text, from, reasons?, seed? }  发新版本沿用上一版的（carriedCardLine）：from 是上一版的版本号；seed 是上一版清单里记的（配它用的，没记就没有）；reasons 是和现在的配法对不上的地方（见上），
//                                                      都对得上就没有这个字段。有 reasons 提示 card_line_stale（沿用了，但和现在的配法有出入，lib/material-hints.mjs）
//   没有这一句是 { status: 'none' }
//   报告里写进包的那两种（voiced、carried）另有 audio：包里的路径（lib/make-pack-report.mjs 从清单取）；
//   还有 onCard：这段录音放进预览卡片是什么样，{ seconds, trimmed }（protocol/lib/preview-audio.mjs 的 trimAudio，上限照卡片的默认：seconds 是卡片上放的秒数，
//   FLAC、Ogg、M4A 不解析是 null；trimmed 是比录音短，卡片只放了前面一截），卡片放不下、改放默认段的是 null。截短了、放不下，提示 card_line_trimmed（lib/material-hints.mjs）
//
// 抛出的错误：
//   make_pack_input_invalid  assertCardLineSpeakable：配音规划不出正好一个能合成的请求。details: { field: 'cardLine', problem }：problem 说配成了几个请求、为什么（几行、长停顿……），
//                            或者比合成能力的下限短，或者配音的规划报的错（只有舞台提示没有话、[voice:] 指了别的声音……，原来的错误在 cause）
//   voiceCardLine 不抛 VoicePackError：钱已经花在包上了，抛出去包就扔了，要从头再花一遍；这一句没配成只记在报告里（failed），包照做。调用方中止（AbortError）和不是 VoicePackError 的错（程序的错）原样往上抛。
//   凭据被拒（401）、账户停了（details.halted）也不抛，这是做包里唯一不往上抛它们的地方（挑默认段照旧抛，lib/make-pack-pick.mjs）：这一步是包做好以后最后一次调能力，
//   之后不再调，「停下来让使用者处理」（adapters/README.md「出错的约定」第 3 条）照旧成立。它们不当成普通的「这一句没配成」：outcome 标 halted，提示 card_line_halted
//   写明要使用者先处理、不要重试，处理好以后再发新版本补上
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { isVoicePackError } from '../protocol/lib/errors.mjs';
import { hasCapability } from '../protocol/lib/env.mjs';
import { sniffAudio } from '../protocol/lib/audio.mjs';
import { trimAudio } from '../protocol/lib/preview-audio.mjs';
import { openVoicePack } from './voice-pack.mjs';
import { planDub, dubScript, DUB_SEED } from './dub.mjs';
import { defaultSegmentFor } from './reference-pick.mjs';
import { summarizeError, keepsThrowing } from './capability-calls.mjs';
import { invalid } from './make-pack-input.mjs';
import { envWithExternals, envForPackDub } from './make-pack-trial.mjs';

/** 交给配音的上限：给了的才交（不给的照配音的默认）。 */
const dubLimits = ({ maxChars, minChars, maxPauseInRequestMs } = {}) => ({
  ...(maxChars === undefined || maxChars === null ? {} : { maxChars }),
  ...(minChars === undefined || minChars === null ? {} : { minChars }),
  ...(maxPauseInRequestMs === undefined || maxPauseInRequestMs === null ? {} : { maxPauseInRequestMs }),
});

/** 这一句的录音放进预览卡片是什么样（截不截、放几秒）：规则和上限只在 protocol/lib/preview-audio.mjs，这里用卡片的默认上限。放不下是 null。 */
const onCardOf = (bytes) => {
  const fit = trimAudio(bytes);
  return fit === null ? null : { seconds: fit.seconds, trimmed: fit.trimmed };
};

/** 配音把这一句配成了几个请求：说给人看（为什么不止一个，怎么改）。 */
const splitProblem = (count) => `配音会把这一句配成 ${count} 个请求（在哪里切开，见 lib/dub.mjs 第 5c 步），卡片试听要一个请求配完：去掉长停顿、章节标记和 [voice:]，或者写短一点`;

/**
 * 花钱之前：用试装的包规划配这一句（不调能力），不是正好一个能合成的请求就报 make_pack_input_invalid（field 是 cardLine）。
 * 试装的包只有一段占位的参考，设定照真的（referenceTag 拿掉了）：请求怎么切看的是台词本身、设定补的提示和上限，和参考是哪段无关。
 * stub 是 null（一段能用的素材都没有）就不查：后面照样报 make_pack_no_material。
 */
export async function assertCardLineSpeakable(env, stub, text, limits) {
  if (stub === null) return;
  const pack = await openVoicePack(stub.files, { env });
  let plan;
  try {
    plan = await planDub(env, pack, [{ text }], { ...dubLimits(limits), allowCrossLanguage: true }); // 占位的参考，不看语言（文件头 voiceCardLine「跨语言」）
  } catch (cause) {
    if (!isVoicePackError(cause)) throw cause;
    throw Object.assign(invalid('cardLine', `配音规划不了这一句（${cause.code}）：${cause.message}`), { cause });
  }
  if (plan.units.length === 0) throw invalid('cardLine', '这一句里没有要念的字（只有标记和舞台提示）');
  if (plan.units.length > 1) throw invalid('cardLine', splitProblem(plan.units.length));
  const [unit] = plan.units;
  if (unit.status === 'failed') throw invalid('cardLine', `配音不会合成这一句（${unit.error?.code}）：${unit.error?.message}`);
}

/**
 * 用做好的包配这一句（规则见文件头）。made 是 packRolePart 做出来的包，externals 是外部资源 [{ path, url, data }]（读外部资源时不联网，用手上的字节）；
 * previous、previousFiles 是上一版（同 carriedCardLine，第一个版本不给）：用同样的请求重配时换 seed（文件头 voiceCardLine「seed」）。
 * allowCrossLanguage 是 true 时参考段不是这一句的语言也照配（文件头 voiceCardLine「跨语言」）。
 * @returns {Promise<{ outcome: object, audio: { text: string, bytes: Uint8Array, format: string, seed?: number } | null }>}
 */
export async function voiceCardLine(env, made, text, { externals = [], wait, limits, previous = null, previousFiles, allowCrossLanguage = false, expressiveness } = {}) {
  const failed = (error, attempts, halted = false) => ({ outcome: { status: 'failed', text, error, ...(attempts === undefined ? {} : { attempts }), ...(halted ? { halted: true } : {}) }, audio: null });
  if (!hasCapability(env, 'voice-cloning')) return failed({ code: 'capability_missing', message: '环境没有 voice-cloning，配不了卡片试听那一句', details: { capability: 'voice-cloning' } });
  const tries = [];
  let dubbed;
  try {
    const pack = await openVoicePack(made.files, { env: envWithExternals(env, externals) });
    // 用同样的请求重配：换一个 seed（文件头 voiceCardLine「seed」）；不是同样的请求是 null，照旧用固定的
    const was = await repeatedSeed(env, { previous, previousFiles }, { made, pack, text, externals, limits, expressiveness });
    dubbed = await dubScript(envForPackDub(env, { wait, tries }), pack, [{ text, ...(expressiveness === undefined ? {} : { expressiveness }) }], { // 单独取的起伏（项自己的）盖过设定和全局值，其余照默认那套
      ...dubLimits(limits),
      ...(was === null ? {} : { only: [0], previousSeed: () => was }),
      ...(allowCrossLanguage ? { allowCrossLanguage: true } : {}), // 不给：参考段不是这一句的语言就不配（dub_cross_language，文件头 voiceCardLine「跨语言」）
      // 花钱之前（assertCardLineSpeakable 查过一遍，这里是做好的包，参考换成了真的）：不是正好一次合成就不配，一次都不调
      onPlan: (_plan, { calls }) => {
        if (calls.count !== 1) throw invalid('cardLine', splitProblem(calls.count));
      },
    });
  } catch (error) {
    if (!isVoicePackError(error)) throw error; // 调用方中止（AbortError）、程序的错
    // 凭据被拒、账户停了（keepsThrowing）：包已经做好了，不抛，标 halted（见文件头）
    return failed(summarizeError(error), tries[0], keepsThrowing(error));
  }
  const [unit] = dubbed.units;
  if (unit.status !== 'ok') return failed(unit.error, tries[0]);
  const sniffed = sniffAudio(unit.audio.bytes);
  if (sniffed === null) return failed({ code: 'card_line_audio_unrecognized', message: '合成能力返回的不是认得出的音频（wav、mp3、flac、ogg、m4a），没有写进包', details: { mimeType: unit.audio.mimeType } }, tries[0]);
  return {
    outcome: {
      status: 'voiced',
      text,
      pick: { segmentId: unit.pick.segmentId, tag: unit.pick.tag, by: unit.pick.by },
      attempts: tries[0] ?? 1,
      ...(unit.model === undefined ? {} : { model: unit.model }),
      ...(unit.modelChange === undefined ? {} : { modelChange: unit.modelChange }),
      ...(unit.openingCue === undefined ? {} : { openingCue: unit.openingCue }),
      ...(unit.seed === undefined ? {} : { seed: unit.seed }), // 环境收 seed 才有（lib/dub.mjs 第 7 步）
      ...(unit.seedChange === undefined ? {} : { seedChange: unit.seedChange }),
      ...(expressiveness === undefined ? {} : { expressiveness }), // 这一句单独取的起伏（做包时明说了才有）
      onCard: onCardOf(unit.audio.bytes),
    },
    audio: { text, bytes: unit.audio.bytes, format: sniffed.format, ...(unit.seed === undefined ? {} : { seed: unit.seed }), ...(expressiveness === undefined ? {} : { expressiveness }) },
  };
}

/**
 * 配音会怎么配这一句（planDub，不花钱）：那一个请求里决定配出来什么样的几样，和这句话的语言（pick.language，lib/reference-pick.mjs 的写法，比默认段用）。
 * 规划不出正好一个能合成的请求是 null。audioOf(段) 是这一段参考的录音字节。
 */
async function plannedRequest(env, pack, text, limits, audioOf, expressiveness) {
  let plan;
  try {
    plan = await planDub(env, pack, [{ text, ...(expressiveness === undefined ? {} : { expressiveness }) }], { ...dubLimits(limits), allowCrossLanguage: true }); // 比的是请求，不看语言（文件头 limits 下面那一条）
  } catch (error) {
    if (!isVoicePackError(error)) throw error;
    return null;
  }
  if (plan.units.length !== 1 || plan.units[0].status === 'failed') return null;
  const [unit] = plan.units;
  const segment = pack.manifest.reference.segments.find((candidate) => candidate.id === unit.pick.segmentId);
  return {
    reference: { id: segment.id, audio: audioOf(segment), text: segment.text, annotatedText: segment.annotatedText ?? null },
    text: JSON.stringify({ spoken: unit.spoken, cue: unit.openingCue?.added === true ? unit.openingCue.cue : null, phonemes: unit.phonemes ?? [] }),
    speed: unit.speed ?? null,
    expressiveness: unit.expressiveness ?? null,
    language: unit.pick.language ?? null,
  };
}

const sameBytes = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((byte, i) => byte === b[i]);
const sameReference = (a, b) => a.id === b.id && sameBytes(a.audio, b.audio) && a.text === b.text && a.annotatedText === b.annotatedText;
/** 上一版（readPreviousVersion 读出来的）、这一版（做好的包和外部资源）里一段参考的录音字节：plannedRequest 的 audioOf。 */
const previousAudio = (previous) => (segment) => previous.segments.find((entry) => entry.id === segment.id)?.audio.bytes;
const madeAudio = (made, externals) => (segment) => made.files.get(segment.audio) ?? externals.find((entry) => entry.path === segment.audio)?.data;

/**
 * 这一次配这一句，是不是用同样的请求重配上一版那一句（文件头 voiceCardLine「seed」）：是就返回上一版那一句用的 seed（清单没记是 DUB_SEED），配音拿它加 1；
 * 不是（第一个版本、上一版没有这一句、哪一版规划不出正好一个请求、参考或请求的文字或语速对不上）是 null。比法同 carriedCardLine 的比一比，一次能力都不调。
 */
async function repeatedSeed(env, { previous, previousFiles }, { made, pack, text, externals, limits, expressiveness }) {
  if (previous === null || previous.cardLine === null || previousFiles === undefined) return null;
  const before = await plannedRequest(env, await openVoicePack(previousFiles, { env }), previous.cardLine.text, limits, previousAudio(previous), previous.cardLine.expressiveness);
  if (before === null) return null;
  const now = await plannedRequest(env, pack, text, limits, madeAudio(made, externals), expressiveness);
  if (now === null || !sameReference(before.reference, now.reference) || before.text !== now.text || before.speed !== now.speed || before.expressiveness !== now.expressiveness) return null;
  return previous.cardLine.seed ?? DUB_SEED;
}

/**
 * 发新版本、这次没给卡片试听那一句：上一版的那一句原样沿用，比一比和现在的配法对不对得上（规则见文件头）。
 * previous 是 lib/pack-version.mjs 的 readPreviousVersion 读出来的上一版（第一个版本是 null），previousFiles 是上一版的文件（makePack 的 input.previous）；
 * made 是这一版做好的包（packRolePart 的结果，还没写验证记录和这一句），externals 是这一版的外部资源 [{ path, url, data }]。
 * @returns {Promise<{ outcome: object, audio: { text: string, bytes: Uint8Array, format: string, seed?: number } } | null>}
 */
export async function carriedCardLine(env, previous, made, { previousFiles, externals = [], limits } = {}) {
  if (previous === null || previous.cardLine === null) return null;
  const { text, bytes, format, seed, expressiveness } = previous.cardLine;
  // 这一句单独取过起伏的：两边都按它规划，起伏就不算对不上（这个值是明说要的，不跟着设定和全局值走）
  const before = await plannedRequest(env, await openVoicePack(previousFiles, { env }), text, limits, previousAudio(previous), expressiveness);
  const now = await plannedRequest(env, await openVoicePack(made.files, { env: envWithExternals(env, externals) }), text, limits, madeAudio(made, externals), expressiveness);
  // 这句话的语言：各用各自那一版的规划认的；一版规划不出，两版都用另一版认的（都规划不出是 null，比主语言的默认段）
  const languageBefore = before?.language ?? now?.language ?? null;
  const languageNow = now?.language ?? before?.language ?? null;
  const reasons = [
    ...(before === null || now === null
      ? ['not_one_request']
      : [
          ...(sameReference(before.reference, now.reference) ? [] : ['reference_changed']),
          ...(before.text === now.text ? [] : ['request_text_changed']),
          ...(before.speed === now.speed ? [] : ['speed_changed']),
          ...(before.expressiveness === now.expressiveness ? [] : ['expressiveness_changed']),
        ]),
    ...(defaultSegmentFor(previous.manifest, languageBefore) === defaultSegmentFor(made.manifest, languageNow) ? [] : ['default_segment_changed']),
  ];
  return {
    outcome: { status: 'carried', text, from: previous.version, ...(reasons.length === 0 ? {} : { reasons }), ...(seed === undefined ? {} : { seed }), onCard: onCardOf(bytes) },
    audio: { text, bytes, format, ...(seed === undefined ? {} : { seed }), ...(expressiveness === undefined ? {} : { expressiveness }) }, // seed、单独取的起伏跟着这一句走：下一次用同样的请求重配，seed 按它加 1
  };
}
