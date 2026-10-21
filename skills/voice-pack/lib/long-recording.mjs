// SPDX-License-Identifier: Apache-2.0
//
// 长录音 →（分离）→ 切段 → 转写 → 做包要的片段列表（流程层）。做包流程的前半：作者交来一段很长的原声，流程把它整理成
// 一组切好的片段，交给 lib/make-pack.mjs 的 makePack（它的 input.segments 就是这里返回的 segments）。
//   @capability audio-source-separation       可选：有就先分出人声，再切段；没有就跳过，说明写进 notes（签名见 vocab/capability-signatures.md）
//   @capability voice-activity-detection      可选：有就用它给的说话区间切段；没有就按能量找静音（tools/silence-split.mjs）
//   @capability automatic-speech-recognition  可选：有就逐段转写，补上 text；没有，片段没有文本
//
//   const { segments, notes, report } = await prepareLongRecording(env, recording, options);
//
// 库不碰文件系统：录音是字节加 MIME 类型，写成文件、把文件读成字节是命令行层的事。整段录音解到内存里：一小时 16 kHz 的录音，
// 解出来约 230 MB（单声道，Float32），更长的先分几块。
//
// ---------------------------------------------------------------- 输入
//   recording   { audio: { bytes: Uint8Array, mimeType: 'audio/…' }, name? }
//               name 是这段录音的名字（例如文件名）：写进每一段的 source.recording；没给，source 里就没有 recording。
//   options（都可选）
//     separate     false：不分离（输入已经是干净的人声）。默认 true：环境有 audio-source-separation 就分离
//     transcribe   false：不转写。默认 true：环境有 automatic-speech-recognition 就转写
//     language     语言标签（en、zh-CN），给每一段的 labels.language，盖过转写报的，并且告诉转写这些录音说的是什么语言（转写认不了就抛 capability_input_invalid，原样往上抛）。不给：转写报了（写法合格）就把转写报的写进这一段的 labels.language；
//                  没报就不给，做包流程自己认。注意做包流程的规矩：片段自己的标签盖过 makePack 的 input.labels 里的默认值，所以转写报的语言会盖过
//                  默认语言；要让作者说的算，就传 language。转写不一定报语言（vocab/capability-signatures.md：language 可选）：拉丁字母的文字（英语……）做包流程认不出语言，要传 language
//     idPrefix     片段 id 的前缀：小写字母、数字、连字符、下划线，以字母或数字开头，最长 56 个字符。默认由 name 来：去掉扩展名，转成这种写法
//                  （My Talk (final).mp3 → my-talk-final）；转不出来（没有 name、全是中文……）用 rec。id 是「前缀-三位序号」：rec-001、rec-002……
//                  几段录音放在一起做包，id 不能重复：名字不同前缀就不同；没有名字或名字转成同一个前缀的，各自给不同的 idPrefix
//     concurrency  转写的并发数，1–8，默认 2
//     retryWait    (毫秒) => Promise：转写暂时出错、再试之前等多久（规则同 makePack 的同名选项，正本是 lib/call-attempts.mjs）；不给就真的等。不是函数就抛 long_recording_input_invalid
//     split        传给切段函数的选项（minSeconds、maxSeconds……，见 tools/silence-split.mjs 文件头）
//     onPlan       (plan) => void：切好段、第一次转写之前交给它；plan 是 { recording, separation, cutting, transcription }，
//                  transcription.calls 是要转写几次、extraCalls 是暂时出错时最多再多转写几次（每段最多再 2 次，lib/call-attempts.mjs）、seconds 是共多少秒。
//                  它抛错就停，什么都不转写（命令行用它报费用）。
//                  分离和 VAD 在这之前已经调过了：要省这两步，用 separate: false，或者环境里不给 VAD
//
// ---------------------------------------------------------------- 流程
//   1 解码     整段只解一次（tools/audio-decode.mjs：WAV 自己解，别的格式要环境的 ffmpeg）。解不开就在这里报，一项能力都没调
//   2 分离     环境有 audio-source-separation（并且没说 separate: false）：把原录音交给它，用返回的 vocals 往下走（vocals 再解一次码）。
//              是花钱、耗时的调用，不重试，出错原样往上抛。没做分离，notes 里写：这次没做分离，输入要是干净的人声
//   3 切段     环境有 voice-activity-detection：把（分离后的）录音交给它，用它给的说话区间切（tools/silence-split.mjs 的 segmentSpeechRegions，
//              合并、长度上限、硬切同按能量切）；没有：按能量切（splitBySilence）。转写的返回里没有时间戳（vocab/capability-signatures.md），所以
//              「没有 VAD 就用转写的时间戳切」做不到，改成先切、再逐段转写，文字自然对上段。段长是 5–20 秒（音质检查给的参考段长度）。
//              多个声道取平均，每段是单声道、16 位的 WAV，采样率同（分离后的）录音，内容就是录音里对应的那一截：不改电平。
//              切好以后每段编成 WAV：一段很长的录音能切出几十上百段，一口气编完要卡住主线程几百毫秒到一秒多，所以每连续做了约 YIELD_AFTER_MS（50）毫秒
//              就停下来，让事件循环转一圈（页面能画、能响应），再接着编。编出来的字节和一口气编完的一样，次序也一样。
//   4 转写     每段最多转写 3 次（规则只在 lib/call-attempts.mjs 写一份：暂时出错就等 5 秒、15 秒再来，次数按上限写进「确认费用」，见那个文件的文件头）。
//              3 次都暂时出错（details.transient）的段记下来，没有 text，别的段照做；
//              别的错（401、返回的形状不对……）停下来：不再开始新的段，等在做的做完，错误原样往上抛。
//              转写收什么格式由适配器自己负责（vocab/capability-signatures.md）：有的只收 16 kHz 单声道 16 位的 WAV，录音本身是 16 kHz 就直接送，
//              别的采样率由适配器用环境的 ffmpeg 转，环境没有 ffmpeg，转写会抛 runtime_missing（点名 ffmpeg）。
//
// 响度：这里不调，每段就是原录音的一截，电平没动过。做包流程里有「调响度」这一步，它（lib/make-pack-loudness.mjs）在量完音质和能量、
// 挑好素材以后、写进包之前，把参考和留出录音统一到目标响度（tools/loudness-normalize.mjs）。放在后面的理由原来是：音质阈值里，底噪（−40 dBFS）和太响（−10 LUFS）
// 两条线量的是绝对电平，是在没动过电平的真实录音上标定的。2026-10-15 在 90 条带标签的真实录音上试过：每条整体调到 −20 或 −23 LUFS
// 再检查（只加一个整体增益），好录音里 noise_floor_high 的误报从 0/50 变成 9–12/50（增益把安静录音的底噪一起抬高了）。逐条的结果不随基础部分发布。
// 静音占比和信噪比（原来「太小声」那条线）已经改成不随增益变的（见 tools/audio-quality.mjs 的文件头）；底噪线也改成相对的（信噪比 12 到 20 dB），太响的绝对线去掉了，
// 音质检查里已经没有随整体增益变的线，不再受这个影响。
// 能量标签也要没动过的响度（拿各段的响度和这一批的中位数比），所以这里切出来的段要保持原电平交给 makePack。
//
// ---------------------------------------------------------------- 返回
//   segments   [{ id, audio: { bytes, mimeType: 'audio/wav' }, text?, labels?, source: { recording?, startSec, endSec } }]
//              就是 makePack 的 input.segments 的形状。text 是转写出来的（没转写、转写失败、转写出来是空的，就没有这个字段）；
//              labels 只有在知道语言的时候才有（{ language }）；source 的秒数对着原录音的时间轴（分离出来的人声和原录音等长、对齐）。
//   notes      [{ code, message, details }]，原样放进 makePack 的 input.notes，进做包的报告。message 是给人看的中文；details 是这一条说的那些事实（message 里的数和名字），
//              读的人（app 用两种语言自己写句子）只读 code 和 details，不去报告的别处凑；没有可说的就是空对象。字段和 hint 的 details 一样写在这里：
//                separation_skipped     这次没做分离，输入要是干净的人声（环境没有这项能力，或者调用方说不分离）。details: { reason: 'capability_missing' | 'disabled' }，同 report.separation.reason
//                no_speech              没有找到说话的部分，没有切出片段。details: {}
//                cut_not_discernible    录音里分不出哪里是停顿（一直有背景声），只能按长度硬切（只有按能量切才有）。details: {}
//                cut_forced             有几处没有停顿，在最安静的地方硬切了。details: { count }，count 是硬切了几处
//                pieces_dropped         有几块不足最短时长的零头没有用。details: { count, seconds, shortestSeconds }：几块、一共几秒（保留一位小数）、最短要几秒
//                transcription_skipped  没转写（环境没有这项能力，或者调用方不要），片段没有文本。details: { reason: 'capability_missing' | 'disabled' }，同 report.transcription.reason
//                transcription_failed   有几段转写暂时出错，没有文本。details: { ids }，ids 是这几段的名字，全部（message 里只点前 10 个）
//                transcription_empty    有几段转写出来是空的（静音、音乐、听不清），没有文本。details: { ids }，同上
//   report     { recording, separation, cutting, transcription, segments }，给人看的细节：
//                recording      { name, durationSec, sampleRate, channels, decoder }，交进来的那段录音
//                separation     { status: 'done', model? } 或 { status: 'skipped', reason: 'capability_missing' | 'disabled' }
//                cutting        { method: 'voice-activity-detection' | 'energy', model?, segments, dropped, analysis }；dropped 和 analysis 就是
//                               tools/silence-split.mjs 返回的（丢掉了哪些块、这段录音自己的电平、阈值、硬切了几处）
//                transcription  { status: 'done', transcribed, empty, failed, retried, models } | { status: 'skipped', reason } | { status: 'not_needed' }（没有片段）；retried 是为暂时出错多转写了几次
//                segments       每段一条：{ id, startSec, endSec, durationSec, short, cut: { start, end }, transcription: 'done' | 'empty' | 'failed' | 'skipped', error? }
//                               short 是不够 5 秒的零头（够 3 秒才留着）；error 是转写最后一次失败的 { code, message, details }
//
// 抛出的错误（VoicePackError；code 小写下划线，details 里放什么在抛出处写明）：
//   long_recording_input_invalid  输入不合约定。details.field 是出问题的字段（recording.name、concurrency、split……）
//   audio_clip_invalid            recording.audio 不是 { bytes, mimeType }（核心层，details.field 是 recording.audio）
//   capability_result_invalid     能力的返回不合约定。details: { capability, problem }：
//                                   audio-source-separation：problem 是 vocals_missing
//                                   voice-activity-detection：problem 是 speech_invalid，details.index 是出问题的那一项（整个返回不对就没有）
//                                   automatic-speech-recognition：problem 是 text_missing
//   另外：audio_decode_failed、wav_invalid、runtime_missing（解码，tools/audio-decode.mjs）、environment_invalid（核心层），
//   以及所需能力自己抛的错（401 之类原样往上传；转写的暂时出错，试满 3 次还不成才不抛，记在片段上）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { hasCapability, requireCapability } from '../protocol/lib/env.mjs';
import { assertAudioClip, isAudioClip } from '../protocol/lib/audio-clip.mjs';
import { decodeAudio } from '../tools/audio-decode.mjs';
import { encodeWav } from '../tools/wav.mjs';
import { DEFAULTS as SPLIT_DEFAULTS, segmentSpeechRegions, splitBySilence } from '../tools/silence-split.mjs';
import { normalizeLanguage } from './line-hints.mjs';
import { MAX_LANGUAGE_TAG } from './language-tag.mjs';
import { summarizeError, badResult, pool } from './capability-calls.mjs';
import { callWithRetries, extraAttempts } from './call-attempts.mjs';
import { YIELD_AFTER_MS, nowMs, turnEventLoop } from './event-loop.mjs';

const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 8;
const PREFIX_MAX = 56;
const ID_PREFIX = /^[a-z0-9][a-z0-9_-]*$/;
/** VAD 给的区间末尾可以比录音长这么多秒（舍入、帧边界造成的误差）。 */
const SPEECH_TOLERANCE_SECONDS = 0.05;
const OPTION_NAMES = ['separate', 'transcribe', 'language', 'idPrefix', 'concurrency', 'split', 'onPlan', 'retryWait'];
const RECORDING_KEYS = ['audio', 'name'];

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (field, problem) => new VoicePackError('long_recording_input_invalid', `长录音的输入不合约定（${field}）：${problem}`, { details: { field, problem } });
const round = (x, digits) => {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
};

// ---------------------------------------------------------------- 读输入

function readRecording(recording) {
  if (!isPlainObject(recording)) throw invalid('recording', '必须是 { audio: { bytes, mimeType }, name? } 对象');
  for (const key of Object.keys(recording)) {
    if (!RECORDING_KEYS.includes(key)) throw invalid(`recording.${key}`, `不认识的字段 ${JSON.stringify(key)}（只有 ${RECORDING_KEYS.join('、')}；库不收路径，文件读成字节是命令行层的事）`);
  }
  if (recording.name !== undefined && (typeof recording.name !== 'string' || recording.name.trim() === '')) throw invalid('recording.name', '必须是非空字符串（例如文件名）');
  assertAudioClip(recording.audio, 'recording.audio');
  return { audio: recording.audio, name: recording.name };
}

/** 切段选项合不合格，交给切段函数自己判断：拿一段 0 帧的音频试一下，它先读选项，写错了抛 TypeError，这里换成点名 split 的错。 */
function checkSplitOptions(split) {
  if (!isPlainObject(split)) throw invalid('split', '必须是对象，例如 { maxSeconds: 15 }');
  try {
    splitBySilence({ sampleRate: 16000, samples: [new Float32Array(0)] }, split);
  } catch (error) {
    if (error instanceof TypeError) throw invalid('split', error.message);
    throw error;
  }
}

function readOptions(options) {
  if (!isPlainObject(options)) throw invalid('options', '必须是对象');
  for (const key of Object.keys(options)) {
    if (!OPTION_NAMES.includes(key)) throw invalid(`options.${key}`, `不认识的选项 ${JSON.stringify(key)}（有：${OPTION_NAMES.join('、')}）`);
  }
  for (const key of ['separate', 'transcribe']) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw invalid(key, '必须是 true 或 false');
  }
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) throw invalid('concurrency', `必须是 1–${MAX_CONCURRENCY} 的整数`);
  if (options.idPrefix !== undefined && (typeof options.idPrefix !== 'string' || options.idPrefix.length > PREFIX_MAX || !ID_PREFIX.test(options.idPrefix))) {
    throw invalid('idPrefix', `必须是小写字母、数字、连字符、下划线，以字母或数字开头，最长 ${PREFIX_MAX} 个字符`);
  }
  const language = options.language === undefined ? undefined : normalizeLanguage(options.language);
  if (language === null) throw invalid('language', `必须是语言标签，例如 en、zh-CN（最长 ${MAX_LANGUAGE_TAG} 个字符）`);
  if (options.split !== undefined) checkSplitOptions(options.split);
  if (options.onPlan !== undefined && typeof options.onPlan !== 'function') throw invalid('onPlan', '必须是函数');
  if (options.retryWait !== undefined && typeof options.retryWait !== 'function') throw invalid('retryWait', '必须是函数 (毫秒) => Promise，转写暂时出错、再试之前等多久');
  return {
    separate: options.separate ?? true,
    transcribe: options.transcribe ?? true,
    language,
    idPrefix: options.idPrefix,
    concurrency,
    split: options.split ?? {},
    onPlan: options.onPlan,
    retryWait: options.retryWait,
  };
}

/** id 的前缀：名字去掉扩展名，小写，不是 [a-z0-9_-] 的连成一片换成一个连字符，去掉两头的连字符；转不出来用 rec。 */
function prefixOf(name) {
  if (name === undefined) return 'rec';
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const slug = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, PREFIX_MAX).replace(/-+$/, '');
  return slug === '' ? 'rec' : slug;
}

// ---------------------------------------------------------------- 解码、分离、切段

/** 多个声道取平均，得到单声道。单声道原样用，不复制。 */
function toMono(samples) {
  if (samples.length === 1) return samples[0];
  const frames = samples[0].length;
  const mono = new Float32Array(frames);
  for (const channel of samples) for (let i = 0; i < frames; i++) mono[i] += channel[i];
  for (let i = 0; i < frames; i++) mono[i] /= samples.length;
  return mono;
}

/** VAD 的返回：{ speech: [{ start_sec, end_sec }] }，按先后排、互不重叠、不超过录音的时长。不合格就抛，不猜。 */
function readSpeech(result, durationSec) {
  const bad = (message, index) => badResult('voice-activity-detection', 'speech_invalid', message, index === undefined ? {} : { index });
  if (!isPlainObject(result) || !Array.isArray(result.speech)) throw bad('必须返回 { speech: [{ start_sec, end_sec }], model? }');
  let previousEnd = 0;
  result.speech.forEach((region, index) => {
    if (!isPlainObject(region) || !Number.isFinite(region.start_sec) || !Number.isFinite(region.end_sec)) throw bad(`speech[${index}] 必须是 { start_sec, end_sec }，两个都是数（秒）`, index);
    if (region.start_sec < 0 || !(region.end_sec > region.start_sec)) throw bad(`speech[${index}] 要满足 0 <= start_sec < end_sec，收到 ${region.start_sec}–${region.end_sec}`, index);
    if (region.start_sec < previousEnd) throw bad(`speech[${index}] 和前一个区间重叠，或者没有按先后排`, index);
    if (region.end_sec > durationSec + SPEECH_TOLERANCE_SECONDS) throw bad(`speech[${index}] 的 end_sec（${region.end_sec}）超出了录音的时长（${round(durationSec, 3)} 秒）`, index);
    previousEnd = region.end_sec;
  });
  return result.speech;
}

// ---------------------------------------------------------------- 转写

/**
 * 逐段转写。`language`：调用方说了录音的语言就告诉转写（options.language），没说就不带这个键（规则的正本：vocab/capability-signatures.md 的转写一节）。
 * 暂时出错就按 lib/call-attempts.mjs 的规则再来（`wait` 是等待，不给就真的等）；返回 { models, retried }，retried 是为暂时出错多转写了几次。
 */
async function transcribeAll(env, items, { concurrency, language, wait }) {
  const recognize = requireCapability(env, 'automatic-speech-recognition');
  const models = new Set();
  let retried = 0;
  await pool(items, concurrency, async (item) => {
    const outcome = await callWithRetries(() => recognize({ audio: item.audio, ...(language === undefined ? {} : { language }) }), { wait });
    retried += outcome.attempts - 1;
    if ('error' in outcome) {
      item.transcription = 'failed';
      item.error = summarizeError(outcome.error);
      return;
    }
    const { result } = outcome;
    if (!isPlainObject(result) || typeof result.text !== 'string') throw badResult('automatic-speech-recognition', 'text_missing', '必须返回 { text: 字符串, language?: 字符串, model?: 字符串 }');
    if (typeof result.model === 'string') models.add(result.model);
    const text = result.text.trim();
    if (text === '') {
      item.transcription = 'empty';
      return;
    }
    item.transcription = 'done';
    item.text = text;
    item.language = normalizeLanguage(result.language);
  });
  return { models: [...models].sort(), retried };
}

// ---------------------------------------------------------------- 提醒（notes）

const idsText = (items) => items.slice(0, 10).map((item) => item.id).join('、') + (items.length > 10 ? ` 等共 ${items.length} 段` : '');

function cuttingNotes({ method, cut, items, shortestSeconds }) {
  const notes = [];
  const droppedShort = cut.dropped.filter((d) => d.reason === 'too_short');
  if (items.length === 0 && droppedShort.length === 0) notes.push({ code: 'no_speech', message: '没有找到说话的部分，没有切出片段', details: {} });
  else if (method === 'energy' && cut.analysis.discernible === false && cut.analysis.regions > 0) notes.push({ code: 'cut_not_discernible', message: '录音里分不出哪里是停顿（一直有背景声），只能按长度硬切，切点可能落在话中间', details: {} });
  else if (cut.analysis.forcedCuts > 0) notes.push({ code: 'cut_forced', message: `有 ${cut.analysis.forcedCuts} 处没有停顿，在最安静的地方硬切了（可能切在词中间）`, details: { count: cut.analysis.forcedCuts } });
  if (droppedShort.length > 0) {
    const seconds = round(droppedShort.reduce((sum, d) => sum + d.durationSec, 0), 1);
    notes.push({ code: 'pieces_dropped', message: `${droppedShort.length} 块不足 ${shortestSeconds} 秒的零头没有用（共 ${seconds} 秒）`, details: { count: droppedShort.length, seconds, shortestSeconds } });
  }
  return notes;
}

function transcriptionNotes(step, items) {
  const notes = [];
  if (step.status === 'skipped') {
    notes.push({ code: 'transcription_skipped', message: step.reason === 'disabled' ? '这次没转写（调用方不要），片段没有文本' : '环境没有转写能力（automatic-speech-recognition），片段没有文本，补上文本才能当参考', details: { reason: step.reason } });
    return notes;
  }
  const failed = items.filter((item) => item.transcription === 'failed');
  const empty = items.filter((item) => item.transcription === 'empty');
  if (failed.length > 0) notes.push({ code: 'transcription_failed', message: `${failed.length} 段转写暂时出错（服务暂时不可用），这几段没有文本：${idsText(failed)}`, details: { ids: failed.map((item) => item.id) } });
  if (empty.length > 0) notes.push({ code: 'transcription_empty', message: `${empty.length} 段没有转写出文字（静音、音乐或听不清）：${idsText(empty)}`, details: { ids: empty.map((item) => item.id) } });
  return notes;
}

// ---------------------------------------------------------------- 主流程

/**
 * 把一段长录音整理成做包要的片段列表。输入、流程、返回见文件头。
 * @param {object} env 注入的运行环境（capabilities、runtimes）
 * @param {{ audio: { bytes: Uint8Array, mimeType: string }, name?: string }} recording
 * @param {object} [options]
 * @returns {Promise<{ segments: object[], notes: { code: string, message: string, details: object }[], report: object }>}
 * @throws {VoicePackError} long_recording_input_invalid、audio_clip_invalid、capability_result_invalid、解码的错、所需能力抛的错
 */
export async function prepareLongRecording(env, recording, options = {}) {
  const input = readRecording(recording);
  const settings = readOptions(options);
  const canSeparate = hasCapability(env, 'audio-source-separation');
  const canDetect = hasCapability(env, 'voice-activity-detection');
  const canTranscribe = hasCapability(env, 'automatic-speech-recognition');

  // 1 解码：整段只解一次。解不开，在花钱之前就报
  const original = await decodeAudio(env, input.audio.bytes);
  const report = {
    recording: { name: input.name ?? null, durationSec: round(original.frames / original.sampleRate, 3), sampleRate: original.sampleRate, channels: original.channels, decoder: original.decoder },
  };

  // 2 分离：往下用的是（分离后的）这一份
  let work = { clip: input.audio, decoded: original };
  if (!settings.separate) report.separation = { status: 'skipped', reason: 'disabled' };
  else if (!canSeparate) report.separation = { status: 'skipped', reason: 'capability_missing' };
  else {
    const result = await requireCapability(env, 'audio-source-separation')({ audio: input.audio });
    if (!isPlainObject(result) || !isAudioClip(result.vocals)) throw badResult('audio-source-separation', 'vocals_missing', '必须返回 { vocals: { bytes, mimeType }, accompaniment?, model? }：vocals 是分出来的人声');
    work = { clip: result.vocals, decoded: await decodeAudio(env, result.vocals.bytes) };
    report.separation = { status: 'done', ...(typeof result.model === 'string' ? { model: result.model } : {}) };
  }

  // 3 切段
  const { sampleRate } = work.decoded;
  const mono = toMono(work.decoded.samples);
  const audio = { sampleRate, samples: [mono] };
  let method = 'energy';
  let model;
  let cut;
  let busySince; // 这一口气连续的同步活从什么时候开始算：切段也算在里面（它自己要一百多毫秒，用掉了额度，编第一段之前就先让出）
  if (canDetect) {
    const result = await requireCapability(env, 'voice-activity-detection')({ audio: work.clip });
    const regions = readSpeech(result, work.decoded.frames / sampleRate);
    busySince = nowMs();
    cut = segmentSpeechRegions(audio, regions, settings.split);
    method = 'voice-activity-detection';
    if (typeof result.model === 'string') model = result.model;
  } else {
    busySince = nowMs();
    cut = splitBySilence(audio, settings.split);
  }
  work = null;

  // 每段编成 WAV：一段一段编，编每一段之前看一眼，连续做过 YIELD_AFTER_MS 了就让事件循环转一圈再接着编（编完最后一段不让：后面的步骤自己会等）。
  // 结果（字节、次序）和一口气 map 完的一样。
  const prefix = settings.idPrefix ?? prefixOf(input.name);
  const width = Math.max(3, String(cut.segments.length).length);
  const items = [];
  for (const [index, seg] of cut.segments.entries()) {
    if (nowMs() - busySince >= YIELD_AFTER_MS) {
      await turnEventLoop();
      busySince = nowMs();
    }
    items.push({
      id: `${prefix}-${String(index + 1).padStart(width, '0')}`,
      seg,
      audio: { bytes: encodeWav({ sampleRate, samples: [mono.subarray(seg.startSample, seg.endSample)] }), mimeType: 'audio/wav' },
      transcription: 'skipped',
    });
  }
  const totalSeconds = round(items.reduce((sum, item) => sum + item.seg.durationSec, 0), 3);
  report.cutting = { method, ...(model === undefined ? {} : { model }), segments: items.length, dropped: cut.dropped, analysis: cut.analysis };

  // 转写要调几次：计划交出去，调用方可以在这里拦住
  let transcription;
  if (items.length === 0) transcription = { status: 'not_needed' };
  else if (!settings.transcribe) transcription = { status: 'skipped', reason: 'disabled' };
  else if (!canTranscribe) transcription = { status: 'skipped', reason: 'capability_missing' };
  else transcription = { status: 'done' };
  const calls = transcription.status === 'done' ? items.length : 0;
  if (settings.onPlan !== undefined) {
    await settings.onPlan({
      recording: report.recording,
      separation: report.separation,
      cutting: { method, ...(model === undefined ? {} : { model }), segments: items.length, totalSeconds },
      transcription: { calls, extraCalls: extraAttempts(calls), seconds: calls === 0 ? 0 : totalSeconds },
    });
  }

  // 4 转写
  if (transcription.status === 'done') {
    const { models, retried } = await transcribeAll(env, items, { concurrency: settings.concurrency, language: settings.language, wait: settings.retryWait });
    const count = (state) => items.filter((item) => item.transcription === state).length;
    transcription = { status: 'done', transcribed: count('done'), empty: count('empty'), failed: count('failed'), retried, models };
  }
  report.transcription = transcription;

  const labelsOf = (item) => {
    const language = settings.language ?? item.language ?? null;
    return language === null ? {} : { labels: { language } };
  };
  const segments = items.map((item) => ({
    id: item.id,
    audio: item.audio,
    ...(item.text === undefined ? {} : { text: item.text }),
    ...labelsOf(item),
    source: { ...(input.name === undefined ? {} : { recording: input.name }), startSec: item.seg.startSec, endSec: item.seg.endSec },
  }));
  report.segments = items.map((item) => ({
    id: item.id,
    startSec: item.seg.startSec,
    endSec: item.seg.endSec,
    durationSec: item.seg.durationSec,
    short: item.seg.short,
    cut: item.seg.cut,
    transcription: item.transcription,
    ...(item.error === undefined ? {} : { error: item.error }),
  }));

  const notes = [];
  if (report.separation.status === 'skipped') notes.push({ code: 'separation_skipped', message: '这次没做分离，输入要是干净的人声', details: { reason: report.separation.reason } });
  notes.push(...cuttingNotes({ method, cut, items, shortestSeconds: settings.split.shortestSeconds ?? SPLIT_DEFAULTS.shortestSeconds }));
  notes.push(...transcriptionNotes(transcription, items));
  return { segments, notes, report };
}
