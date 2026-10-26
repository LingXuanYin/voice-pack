// SPDX-License-Identifier: Apache-2.0
//
// 适配器的检查（流程层）：纯函数，只用平台自带的 API，浏览器、Node、Bun 都能跑。收的是一个适配器工厂返回的对象
// （或者一个运行环境：形状是它的子集），不碰文件、不起进程、不加载模块——「怎么加载适配器」是命令行层的事（cli/adapters.mjs），
// `node cli.mjs adapter check` 只是在外面包一层。app 的测试可以直接调这里的函数，去验 app 自己组装的环境。
// 适配器的约定（工厂的签名、返回的形状、出错的约定、模型名从哪来）只写在 adapters/README.md，这里只实现检查，不重述。
//
//   checkAdapterShape(adapter)                  只看容器和类型：是对象、键都认识、capabilities 和 runtimes 是对象、fetch 是函数、billing、limits 和 previewCard 的写法。
//                                               命令行加载适配器时用它（不评论能力名）。→ { ok, issues }
//   checkAdapterStructure(adapter, options)     结构检查，不调用任何能力：形状，加上每项能力：名字在能力词表里，函数是函数，只是声明的写 true。
//                                               options.expect 点名要提供的能力，没有的报 capability_missing；options.vocabulary 换词表（默认用 vocab/capabilities.json）。
//                                               → { ok, issues, capabilities: [{ name, kind: 'function' | 'declaration' }], runtimes: [名字] }，列出的只是合格的那些
//   planLiveCalls(env, options)                 真调用要调哪几项、各几次，哪些不调、为什么（费用说明用它）。options.capabilities 只算点名的。
//                                               → { calls: [{ capability, times }], skipped: [{ capability, reason }] }
//                                               reason 是 SKIP_REASONS 里的一个，一个词一个意思：
//                                                 declaration   只是声明（DECLARED_CAPABILITIES），没有可调用的
//                                                 no_signature  签名表（vocab/capability-signatures.md）里还没有这一项的调用写法，没法写真调用（词表里有名字，写法由第一个用到它的人定）
//                                                 not_wired     签名表里有这一项的调用写法，但这里（RULES）还没接上它的真调用。这是这个检查的缺口，不是适配器的问题；
//                                                               现在没有这样的能力（NOT_WIRED 是空的）：表里新加了一项写法、这里一时接不上，就先列进 NOT_WIRED，测试逐项对着签名表核对
//                                                 unknown       不在能力词表里
//                                                 not_callable  值不是函数
//                                                 not_provided  点名了，环境没有
//                                               options.notWired 换掉 NOT_WIRED（测试用：真的签名表里现在没有「表里有、这里没接」的能力）
//   checkAdapterLive(env, options)              每项能力用一段很短的输入真调一次，核对返回。options.capabilities 只调点名的，options.text 换掉说的话（默认 DEFAULT_TEXT；
//                                               只有 text-to-speech 和 voice-cloning 用它，别的能力的输入是固定的，voice-design 的也是，见下），options.notWired 同上。
//                                               options.voice：要音频输入的能力用的一段人声 { bytes, mimeType, text }，text 是它念的逐字文本（voice-cloning 的 ref_text 用它）。
//                                               点名的里有要音频的、又没给 voice，抛 TypeError。
//                                               一项抛了错就记下来，别的接着查。→ { ok, issues, results: [{ capability, status: 'passed' | 'failed' | 'skipped', reason?, calls, model, elapsedMs, issues, summary? }] }
//   checkCapabilityResult(capability, result, options)   核对一项能力的一次返回（真调用用的就是它）。options.env：解码非 WAV 的音频要向它要 ffmpeg；
//                                               options.durationSeconds：调用时给的音频有多长（VAD 的区间不能超出它；不给就不查上界）。→ Promise<{ issues, model, summary }>
//
// 一个问题是 { level: 'error' | 'warning', code, message, details }。error 让 ok 变 false，warning 只提醒。code 是这一层的，谁报谁在这里写明：
//   adapter_not_object        适配器的返回值不是对象
//   adapter_key_unknown       返回值里有不认识的键。details.key
//   container_not_object      capabilities 或 runtimes 不是对象。details.key
//   fetch_not_function        fetch 不是函数
//   billing_invalid           billing 不是非空字符串
//   limits_invalid            limits 不是对象、里面有不认识的键、maxChars 不是不小于 10 的整数、minChars 不是不小于 1 的整数。details.key
//   preview_card_invalid      previewCard 不是对象、里面有不认识的键、productName 或 links 里的链接不是非空字符串。details.key
//   capability_unknown        能力名不在能力词表里（多半拼错了）。details.capability
//   capability_not_function   能力的值不是函数。details.capability
//   declaration_not_true      只是声明的能力（DECLARED_CAPABILITIES）的值不是 true。details.capability
//   runtime_not_function      运行时的值不是函数。details.runtime
//   capability_missing        options.expect 点名要提供的能力没有。details.capability
//   no_capabilities           （警告）一项能力都没有
//   call_failed               真调用时能力抛了错。details: { errorCode?, transient, status?, message }（transient 为 true 表示它标了「服务暂时出错」）
//   result_invalid            返回的形状不是签名写的那样。details: { capability, problem }
//   audio_clip_invalid        返回的音频不是 { bytes（非空）, mimeType: audio/… }。details: { field, problem }
//   audio_mime_mismatch       mimeType 说是这种格式，字节看着不是。details: { field, mimeType, actual（认出的格式，认不出是 null） }
//   audio_undecodable         音频解不开（WAV 头坏了，或 ffmpeg 说不是音频）。details.field
//   audio_empty               音频解出来一个采样都没有（长度 0）。details.field
//   enhancers_used_invalid    没有递给它增强件，返回里却报了 enhancers_used，或者它不是数组
//   model_invalid             model 不是非空字符串
//   audio_format_unverified   （警告）mimeType 不是认得的几种（wav、mp3、flac、ogg、m4a），没法核对它和字节对不对
//   audio_decode_skipped      （警告）音频不是自己能解的 WAV，环境又没有 ffmpeg，没法解码核对
//   model_missing             （警告）返回里没有 model：验证记录里就写不出这项能力用的是哪个模型
//   text_empty                （警告）文字回答是空的
//
// 每项能力的输入和返回的规则，照 vocab/capability-signatures.md 写（那里是正本）。签名表里没有写法的能力这里不猜：真调用时跳过，原因是 no_signature；
// 表里有写法而这里一时没接上的，列在 NOT_WIRED 里，跳过的原因是 not_wired（测试对着真的签名表核对：表里有写法的能力，必须是接上的、声明的或列在 NOT_WIRED 里的，
// 所以「表里有、这里没接」不会悄悄被说成「没有签名」）。
// 「只是声明的能力」的名单在 protocol/lib/env.mjs 的 DECLARED_CAPABILITIES（目前有 style-instruction 和 style-cues），这里按它认。
//
// voice-design 的真调用：输入固定，一句够长的试听文本加一句短描述，不带参考音频，不跟 options.text 走。试听文本不能是 Hello. 这样的短句（有的服务要至少 15 个字符），
// 所以不能借 options.text 的默认值；两句都只有基本平面的英文字符（有的服务处理不了增补平面的字），也远在见过的上限（试听文本 200、描述 500 个字符）以内。核对的是「返回的是音频」，
// 和别的合成能力一样（mimeType 对得上字节、解得开、长度大于 0、model 有没有）。这一项会真的花钱（一次设计请求），所以也算进调用之前的费用说明（planLiveCalls 的 calls）。
//
// 要音频输入的能力（voice-cloning、两项变声、转写、音频问答、说话人比对、分离、说话区间检测）用 options.voice：调用方给的一段人声。命令行上给的是基础部分附带的那段
// （lib/adapter-check-voice.wav，5–8 秒，一个人念一句话，逐字文本在旁边的 .json 里），这里不读文件（纯函数，app 的测试也直接调）。时长取自解码后的长度，VAD 的区间不能超出它。
// 旧的 1 秒正弦音已经不用：有的模型的克隆参考至少要 3 秒，正弦音又不是人声（历史见 CHANGELOG 2.0.5）。
//
// @capability text-to-speech
// @capability voice-cloning
// @capability voice-design
// @capability voice-conversion
// @capability singing-voice-conversion
// @capability audio-text-to-text
// @capability automatic-speech-recognition
// @capability text-generation
// @capability speaker-verification
// @capability audio-source-separation
// @capability voice-activity-detection
// @capability style-instruction
// @capability style-cues
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import defaultVocabulary from '../vocab/capabilities.json' with { type: 'json' };
import { assertAudioClip } from '../protocol/lib/audio-clip.mjs';
import { sniffAudio } from '../protocol/lib/audio.mjs';
import { DECLARED_CAPABILITIES, hasCapability } from '../protocol/lib/env.mjs';
import { isVoicePackError } from '../protocol/lib/errors.mjs';
import { decodeAudio } from '../tools/audio-decode.mjs';
import { isServiceError } from './capability-calls.mjs';

/** 适配器的返回值里认的键。 */
export const ADAPTER_KEYS = Object.freeze(['capabilities', 'runtimes', 'fetch', 'billing', 'limits', 'previewCard']);
/** limits 里认的键：maxChars（一次合成最多多少个字）、minChars（合成能力一次至少要多少个字，见 lib/dub.mjs）。 */
export const LIMIT_KEYS = Object.freeze(['maxChars', 'minChars']);
/** previewCard 里认的键，和 links 里认的键（形状同核心层 buildShareFile 的 card 选项）。 */
export const PREVIEW_CARD_KEYS = Object.freeze(['productName', 'links']);
export const PREVIEW_LINK_KEYS = Object.freeze(['open', 'make']);
/** 只是声明的能力的名单（核心层 protocol/lib/env.mjs 的那一份，原样再导出：app 的测试可以只从这里取，不用另找）。 */
export { DECLARED_CAPABILITIES };
/** 真调用跳过一项能力的原因，planLiveCalls 的 skipped[].reason 和 checkAdapterLive 的 results[].reason 取这里的一个。每个的意思写在文件头。 */
export const SKIP_REASONS = Object.freeze(['declaration', 'no_signature', 'not_wired', 'unknown', 'not_callable', 'not_provided']);
/**
 * 签名表（vocab/capability-signatures.md）里有调用写法、但这里（RULES）还没接上真调用的能力。现在没有。
 * 表里新写了一项能力的调用写法，这里一时接不上，就先列在这里：真调用跳过它，原因是 not_wired（这个检查的缺口），不是 no_signature（表里没有）。
 */
export const NOT_WIRED = Object.freeze([]);

/** 真调用默认说的话。有的模型一次至少要 15 个字符，Hello. 这样的短句会被 HTTP 400 拒掉，所以不用它；options.text 可以换掉。 */
export const DEFAULT_TEXT = 'Hello, this is a check.';
/** voice-design 的固定输入（见文件头）：试听文本至少 15 个字符（见过的服务里最严的下限），描述短。 */
const DESIGN_TEXT = 'This is a short audition of a designed voice.';
const DESIGN_PROMPT = 'A calm adult woman with a warm, clear voice.';
const MIN_MAX_CHARS = 10; // 同 lib/dub.mjs 的 maxChars
const MIN_MIN_CHARS = 1; // 同 lib/dub.mjs 的 minChars：一个字也算下限
/** VAD 给的区间末尾可以比录音长这么多秒（同 lib/long-recording.mjs）。 */
const SPEECH_TOLERANCE_SECONDS = 0.05;
/** mimeType（去掉参数、小写）对应 sniffAudio 认的格式。不在表里的，没法核对字节。 */
const FORMAT_OF_MIME = Object.freeze({
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/ogg': 'ogg', 'audio/opus': 'ogg',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a',
});

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const issue = (level, code, message, details = {}) => ({ level, code, message, details });
const hasErrors = (issues) => issues.some((item) => item.level === 'error');
const mediaType = (mimeType) => String(mimeType).split(';')[0].trim().toLowerCase();
const short = (value, limit = 300) => {
  const text = String(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};
const round = (value, digits) => {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};

// ---------------------------------------------------------------- 结构检查

/** 容器和类型的问题。 */
function shapeIssues(adapter) {
  if (!isPlainObject(adapter)) {
    return [issue('error', 'adapter_not_object', `适配器的返回值要是对象：{ ${ADAPTER_KEYS.map((key) => `${key}?`).join(', ')} }（约定见 adapters/README.md）`)];
  }
  const issues = [];
  for (const key of Object.keys(adapter)) {
    if (!ADAPTER_KEYS.includes(key)) issues.push(issue('error', 'adapter_key_unknown', `返回值里有不认识的键 ${JSON.stringify(key)}（只认 ${ADAPTER_KEYS.join('、')}）`, { key }));
  }
  for (const key of ['capabilities', 'runtimes']) {
    if (adapter[key] !== undefined && !isPlainObject(adapter[key])) issues.push(issue('error', 'container_not_object', `${key} 要是对象，不是数组、字符串或别的`, { key }));
  }
  if (adapter.fetch !== undefined && typeof adapter.fetch !== 'function') issues.push(issue('error', 'fetch_not_function', 'fetch 要是函数（形同标准 fetch）'));
  if (adapter.billing !== undefined && (typeof adapter.billing !== 'string' || adapter.billing.trim() === '')) {
    issues.push(issue('error', 'billing_invalid', 'billing 要是非空字符串：一句话写明这个适配器的调用费用记在哪个账户上'));
  }
  if (adapter.limits !== undefined) {
    if (!isPlainObject(adapter.limits)) {
      issues.push(issue('error', 'limits_invalid', `limits 要是对象，例如 { maxChars: 200 }`, { key: 'limits' }));
    } else {
      for (const key of Object.keys(adapter.limits)) {
        if (!LIMIT_KEYS.includes(key)) issues.push(issue('error', 'limits_invalid', `limits 里有不认识的键 ${JSON.stringify(key)}（只认 ${LIMIT_KEYS.join('、')}）`, { key }));
      }
      const { maxChars, minChars } = adapter.limits;
      if (maxChars !== undefined && (!Number.isInteger(maxChars) || maxChars < MIN_MAX_CHARS)) {
        issues.push(issue('error', 'limits_invalid', `limits.maxChars 要是不小于 ${MIN_MAX_CHARS} 的整数（一次合成最多多少个字），收到 ${JSON.stringify(maxChars)}`, { key: 'maxChars' }));
      }
      if (minChars !== undefined && (!Number.isInteger(minChars) || minChars < MIN_MIN_CHARS)) {
        issues.push(issue('error', 'limits_invalid', `limits.minChars 要是不小于 ${MIN_MIN_CHARS} 的整数（合成能力一次至少要多少个字），收到 ${JSON.stringify(minChars)}`, { key: 'minChars' }));
      }
    }
  }
  if (adapter.previewCard !== undefined) issues.push(...previewCardIssues(adapter.previewCard));
  return issues;
}

/**
 * previewCard 的问题：{ productName?, links?: { open?, make? } }，每一项是非空字符串。形状同核心层 buildShareFile 的 card 选项；链接里的 {id} 换成包 ID，
 * 换完是不是 http 或 https 的地址，打分享文件的时候由 buildShareFile 核对（那里是正本，这里只看类型）。
 */
function previewCardIssues(card) {
  const bad = (message, key) => issue('error', 'preview_card_invalid', message, { key });
  if (!isPlainObject(card)) return [bad('previewCard 要是对象，例如 { productName: "某某", links: { open: "https://…", make: "https://…?pack={id}" } }', 'previewCard')];
  const issues = [];
  for (const key of Object.keys(card)) {
    if (!PREVIEW_CARD_KEYS.includes(key)) issues.push(bad(`previewCard 里有不认识的键 ${JSON.stringify(key)}（只认 ${PREVIEW_CARD_KEYS.join('、')}）`, key));
  }
  if (card.productName !== undefined && (typeof card.productName !== 'string' || card.productName.trim() === '')) {
    issues.push(bad('previewCard.productName 要是非空字符串（预览卡片上「在 X 里打开」里的 X）', 'productName'));
  }
  if (card.links !== undefined) {
    if (!isPlainObject(card.links)) {
      issues.push(bad('previewCard.links 要是对象：{ open?, make? }（两个入口的链接）', 'links'));
    } else {
      for (const [key, link] of Object.entries(card.links)) {
        if (!PREVIEW_LINK_KEYS.includes(key)) issues.push(bad(`previewCard.links 里有不认识的键 ${JSON.stringify(key)}（只认 ${PREVIEW_LINK_KEYS.join('、')}）`, key));
        else if (typeof link !== 'string' || link.trim() === '') issues.push(bad(`previewCard.links.${key} 要是非空字符串（链接，里面的 {id} 换成包 ID）`, key));
      }
    }
  }
  return issues;
}

const report = (issues, extra = {}) => ({ ok: !hasErrors(issues), issues, ...extra });

/**
 * 只看容器和类型，不评论能力名。命令行加载适配器时用。
 * @param {unknown} adapter 适配器工厂返回的对象
 * @returns {{ ok: boolean, issues: object[] }}
 */
export function checkAdapterShape(adapter) {
  return report(shapeIssues(adapter));
}

/**
 * 结构检查：不调用任何能力。
 * @param {unknown} adapter 适配器工厂返回的对象（或一个运行环境）
 * @param {{ vocabulary?: { capabilities: object }, expect?: string[] }} [options]
 * @returns {{ ok: boolean, issues: object[], capabilities: { name: string, kind: 'function' | 'declaration' }[], runtimes: string[] }}
 */
export function checkAdapterStructure(adapter, { vocabulary = defaultVocabulary, expect = [] } = {}) {
  const issues = shapeIssues(adapter);
  if (!isPlainObject(adapter)) return report(issues, { capabilities: [], runtimes: [] });
  const container = isPlainObject(adapter.capabilities) ? adapter.capabilities : {};
  const provided = (name) => hasCapability({ capabilities: container }, name);
  const names = Object.keys(container).filter(provided);
  const capabilities = [];
  for (const name of names) {
    const value = container[name];
    if (!Object.hasOwn(vocabulary.capabilities, name)) {
      issues.push(issue('error', 'capability_unknown', `能力名 ${JSON.stringify(name)} 不在能力词表里（vocab/capabilities.json；多半是拼错了）`, { capability: name }));
    } else if (DECLARED_CAPABILITIES.includes(name)) {
      if (value === true) capabilities.push({ name, kind: 'declaration' });
      else issues.push(issue('error', 'declaration_not_true', `${name} 只是声明，不是函数：值要写 true`, { capability: name }));
    } else if (typeof value === 'function') {
      capabilities.push({ name, kind: 'function' });
    } else {
      issues.push(issue('error', 'capability_not_function', `${name} 要是函数（收到 ${typeof value}）`, { capability: name }));
    }
  }
  if (names.length === 0) issues.push(issue('warning', 'no_capabilities', '适配器没有提供任何能力'));
  for (const name of expect) {
    if (!provided(name)) issues.push(issue('error', 'capability_missing', `适配器没有提供要求的能力 ${name}`, { capability: name }));
  }
  const runtimeContainer = isPlainObject(adapter.runtimes) ? adapter.runtimes : {};
  const runtimes = [];
  for (const name of Object.keys(runtimeContainer)) {
    const value = runtimeContainer[name];
    if (value === undefined || value === null || value === false) continue;
    if (typeof value === 'function') runtimes.push(name);
    else issues.push(issue('error', 'runtime_not_function', `运行时 ${name} 要是函数`, { runtime: name }));
  }
  return report(issues, { capabilities, runtimes });
}

// ---------------------------------------------------------------- 返回值的规则（真调用用）

/** 调用方给的人声：字节、MIME 类型、逐字文本（非空）都要有。 */
const isVoice = (voice) => isPlainObject(voice) && voice.bytes instanceof Uint8Array && typeof voice.mimeType === 'string' && typeof voice.text === 'string' && voice.text.trim() !== '';

/** 人声的时长（秒）：解码以后的长度。WAV 自己解，别的格式要环境的 ffmpeg；解不开就抛，让调用方去改给的人声。 */
async function voiceSeconds(env, bytes) {
  const decoded = await decodeAudio(env, bytes);
  return decoded.frames / decoded.sampleRate;
}

/** 核对一段返回的音频：片段的形状、mimeType 和字节对得上、能解码、长度大于 0。 */
async function audioProblems(clip, field, env) {
  try {
    assertAudioClip(clip, field);
  } catch (error) {
    return { issues: [issue('error', 'audio_clip_invalid', error.message, { field, problem: error.details?.problem })], summary: null };
  }
  const issues = [];
  const { bytes, mimeType } = clip;
  const sniffed = sniffAudio(bytes);
  const claimed = FORMAT_OF_MIME[mediaType(mimeType)] ?? null;
  if (claimed === null) {
    issues.push(issue('warning', 'audio_format_unverified', `${field} 的 mimeType ${mimeType} 不是认得的几种（${[...new Set(Object.values(FORMAT_OF_MIME))].join('、')}），没法核对它和字节对不对`, { field, mimeType }));
  } else if (sniffed === null || sniffed.format !== claimed) {
    issues.push(issue('error', 'audio_mime_mismatch', `${field} 的 mimeType 是 ${mimeType}，字节${sniffed === null ? '认不出是这种（或任何允许的）音频' : `看着是 ${sniffed.format}`}`, { field, mimeType, actual: sniffed?.format ?? null }));
  }
  const summary = { kind: 'audio', mimeType, format: sniffed?.format ?? null, bytes: bytes.length };
  try {
    const decoded = await decodeAudio(env, bytes);
    summary.sampleRate = decoded.sampleRate;
    summary.channels = decoded.channels;
    summary.durationSeconds = round(decoded.frames / decoded.sampleRate, 3);
    if (decoded.frames === 0) issues.push(issue('error', 'audio_empty', `${field} 解出来一个采样都没有（长度 0）`, { field }));
  } catch (error) {
    if (isVoicePackError(error, 'runtime_missing')) {
      issues.push(issue('warning', 'audio_decode_skipped', `${field} 不是自己能解的 WAV，环境又没有 ffmpeg，没法解码核对（只核对了 mimeType 和字节）`, { field }));
    } else {
      issues.push(issue('error', 'audio_undecodable', `${field} 解不开：${short(error?.message ?? error)}`, { field, errorCode: isVoicePackError(error) ? error.code : undefined }));
    }
  }
  return { issues, summary };
}

const invalid = (capability, problem, message) => issue('error', 'result_invalid', `${capability} 的返回不符合签名：${message}`, { capability, problem });

async function synthesisResult(capability, result, { env }) {
  const { issues, summary } = await audioProblems(result, 'result', env);
  if (isPlainObject(result) && result.enhancers_used !== undefined) {
    const used = result.enhancers_used;
    if (!Array.isArray(used) || used.length > 0) {
      issues.push(issue('error', 'enhancers_used_invalid', `${capability} 没有收到增强件，返回里却有 enhancers_used：${JSON.stringify(used)}（报了没有递给它的 id，库会抛 capability_result_invalid）`, { capability }));
    }
  }
  return { issues, summary };
}

function textResult(capability) {
  return async (result) => {
    if (!isPlainObject(result) || typeof result.text !== 'string') return { issues: [invalid(capability, 'text_missing', '要 { text: 字符串, model?: 字符串 }')], summary: null };
    const issues = result.text.trim() === '' ? [issue('warning', 'text_empty', `${capability} 的回答是空的`, { capability })] : [];
    return { issues, summary: { kind: 'text', characters: result.text.length } };
  };
}

async function transcriptionResult(capability, result) {
  if (!isPlainObject(result) || typeof result.text !== 'string') return { issues: [invalid(capability, 'text_missing', '要 { text: 字符串（可以是空串）, language?: 字符串, model?: 字符串 }')], summary: null };
  if (result.language !== undefined && (typeof result.language !== 'string' || result.language.trim() === '')) {
    return { issues: [invalid(capability, 'language_invalid', 'language 要是非空字符串（BCP 47，例如 en、zh），报不出就不带这个键')], summary: null };
  }
  return { issues: [], summary: { kind: 'text', characters: result.text.length, ...(result.language === undefined ? {} : { language: result.language }) } };
}

async function similarityResult(capability, result) {
  if (!isPlainObject(result) || typeof result.similarity !== 'number' || !Number.isFinite(result.similarity)) {
    return { issues: [invalid(capability, 'similarity_invalid', '要 { similarity: 有限的数, model?: 字符串 }')], summary: null };
  }
  return { issues: [], summary: { kind: 'number', similarity: result.similarity } };
}

async function separationResult(capability, result, { env }) {
  if (!isPlainObject(result) || result.vocals === undefined) return { issues: [invalid(capability, 'vocals_missing', '要 { vocals: {bytes, mimeType}, accompaniment?: {bytes, mimeType}, model?: 字符串 }，vocals 必有')], summary: null };
  const vocals = await audioProblems(result.vocals, 'vocals', env);
  const issues = [...vocals.issues];
  const summary = { kind: 'separation', vocals: vocals.summary };
  if (result.accompaniment !== undefined) {
    const accompaniment = await audioProblems(result.accompaniment, 'accompaniment', env);
    issues.push(...accompaniment.issues);
    summary.accompaniment = accompaniment.summary;
  }
  return { issues, summary };
}

async function speechResult(capability, result, { durationSeconds }) {
  const bad = (problem, message) => ({ issues: [invalid(capability, problem, message)], summary: null });
  if (!isPlainObject(result) || !Array.isArray(result.speech)) return bad('speech_invalid', '要 { speech: [{ start_sec, end_sec }], model?: 字符串 }');
  let previousEnd = 0;
  for (const [index, region] of result.speech.entries()) {
    if (!isPlainObject(region) || !Number.isFinite(region.start_sec) || !Number.isFinite(region.end_sec)) return bad('speech_invalid', `speech[${index}] 必须是 { start_sec, end_sec }，两个都是数（秒）`);
    if (region.start_sec < 0 || !(region.end_sec > region.start_sec)) return bad('speech_invalid', `speech[${index}] 要满足 0 <= start_sec < end_sec，收到 ${region.start_sec}–${region.end_sec}`);
    if (region.start_sec < previousEnd) return bad('speech_invalid', `speech[${index}] 和前一个区间重叠，或者没有按先后排`);
    if (durationSeconds !== undefined && region.end_sec > durationSeconds + SPEECH_TOLERANCE_SECONDS) return bad('speech_invalid', `speech[${index}] 的 end_sec（${region.end_sec}）超出了录音的时长（${durationSeconds} 秒）`);
    previousEnd = region.end_sec;
  }
  return { issues: [], summary: { kind: 'speech', regions: result.speech.length } };
}

/**
 * 每项有调用写法的能力：怎么用很短的输入调它（input），怎么核对返回（check）。参数名照 vocab/capability-signatures.md。
 * 签名表里没有写法的能力（text-to-audio、audio-watermarking、speech-to-speech、text-to-image、pronunciation-lexicon）不在这里，真调用跳过（no_signature）。
 * voice-design 的输入是固定的（文件头）：试听文本不能是 Hello. 这样的短句（有的服务要至少 15 个字符），所以不用 options.text。
 * audio: true 的要音频输入，用 options.voice 的人声（checkAdapterLive 把它交给 input 的 clip，逐字文本交给 refText）。
 */
const RULES = {
  'text-to-speech': { input: ({ text }) => ({ text }), check: (result, context) => synthesisResult('text-to-speech', result, context) },
  'voice-cloning': { audio: true, input: ({ text, clip, refText }) => ({ text, ref_audio: clip, ref_text: refText }), check: (result, context) => synthesisResult('voice-cloning', result, context) },
  'voice-design': { input: () => ({ text: DESIGN_TEXT, voice_prompt: DESIGN_PROMPT }), check: (result, context) => synthesisResult('voice-design', result, context) },
  'voice-conversion': { audio: true, input: ({ clip, refText }) => ({ audio: clip, ref_audio: clip, ref_text: refText }), check: (result, context) => synthesisResult('voice-conversion', result, context) },
  'singing-voice-conversion': { audio: true, input: ({ clip, refText }) => ({ audio: clip, ref_audio: clip, ref_text: refText }), check: (result, context) => synthesisResult('singing-voice-conversion', result, context) },
  'audio-text-to-text': { audio: true, input: ({ clip }) => ({ parts: [{ text: 'What do you hear? Answer in one short sentence.' }, { audio: clip }] }), check: textResult('audio-text-to-text') },
  'automatic-speech-recognition': { audio: true, input: ({ clip }) => ({ audio: clip }), check: (result, context) => transcriptionResult('automatic-speech-recognition', result, context) },
  'text-generation': { input: () => ({ prompt: 'Say hello in one short sentence.' }), check: textResult('text-generation') },
  'speaker-verification': { audio: true, input: ({ clip }) => ({ audio_a: clip, audio_b: clip }), check: (result, context) => similarityResult('speaker-verification', result, context) },
  'audio-source-separation': { audio: true, input: ({ clip }) => ({ audio: clip }), check: (result, context) => separationResult('audio-source-separation', result, context) },
  'voice-activity-detection': { audio: true, input: ({ clip }) => ({ audio: clip }), check: (result, context) => speechResult('voice-activity-detection', result, context) },
};

/** 有调用写法的能力名（真调用会调的那些）。 */
export const LIVE_CAPABILITIES = Object.freeze(Object.keys(RULES));

/**
 * 核对一项能力的一次返回。
 * @param {string} capability 能力名，要是 LIVE_CAPABILITIES 里的
 * @param {unknown} result 能力的返回值
 * @param {{ env?: object, durationSeconds?: number }} [options] env：解码非 WAV 的音频要向它要 ffmpeg（没有就当环境没有）；durationSeconds：调用时给的音频有多长
 * @returns {Promise<{ issues: object[], model: string | null, summary: object | null }>}
 */
export async function checkCapabilityResult(capability, result, { env = { capabilities: {}, runtimes: {} }, durationSeconds } = {}) {
  if (!Object.hasOwn(RULES, capability)) throw new TypeError(`没有 ${capability} 的返回值规则：签名表（vocab/capability-signatures.md）里没有这一项的写法，或者有、但这个检查还没接上（NOT_WIRED）`);
  const { issues, summary } = await RULES[capability].check(result, { env, durationSeconds });
  let model = null;
  if (isPlainObject(result)) {
    if (result.model === undefined) {
      issues.push(issue('warning', 'model_missing', `${capability} 的返回里没有 model：验证记录里就写不出这项能力用的是哪个模型（约定见 adapters/README.md）`, { capability }));
    } else if (typeof result.model !== 'string' || result.model.trim() === '') {
      issues.push(issue('error', 'model_invalid', `${capability} 返回的 model 要是非空字符串，收到 ${JSON.stringify(result.model)}`, { capability }));
    } else {
      model = result.model;
    }
  }
  return { issues, model, summary };
}

// ---------------------------------------------------------------- 真调用

/** 要处理的能力，按先后：给了 requested 就照它，没给就是环境里提供的全部。每项是 { capability, call } 或 { capability, skip }。 */
function liveEntries(env, requested, vocabulary = defaultVocabulary, notWired = NOT_WIRED) {
  const container = isPlainObject(env?.capabilities) ? env.capabilities : {};
  const provided = (name) => hasCapability({ capabilities: container }, name);
  const names = requested ?? Object.keys(container).filter(provided);
  return names.map((capability) => {
    if (!provided(capability)) return { capability, skip: 'not_provided' };
    if (DECLARED_CAPABILITIES.includes(capability)) return { capability, skip: 'declaration' };
    if (!Object.hasOwn(vocabulary.capabilities, capability)) return { capability, skip: 'unknown' };
    if (!Object.hasOwn(RULES, capability)) return { capability, skip: notWired.includes(capability) ? 'not_wired' : 'no_signature' };
    if (typeof container[capability] !== 'function') return { capability, skip: 'not_callable' };
    return { capability, call: container[capability] };
  });
}

/**
 * 真调用要调哪几项、各几次；哪些不调、为什么。
 * @param {object} env 适配器或运行环境
 * @param {{ capabilities?: string[], vocabulary?: { capabilities: object }, notWired?: string[] }} [options] capabilities：只算点名的；notWired：换掉 NOT_WIRED（测试用）
 * @returns {{ calls: { capability: string, times: number }[], skipped: { capability: string, reason: string }[] }}
 */
export function planLiveCalls(env, { capabilities, vocabulary, notWired } = {}) {
  const entries = liveEntries(env, capabilities, vocabulary, notWired);
  return {
    calls: entries.filter((entry) => entry.call !== undefined).map((entry) => ({ capability: entry.capability, times: 1 })),
    skipped: entries.filter((entry) => entry.skip !== undefined).map((entry) => ({ capability: entry.capability, reason: entry.skip })),
  };
}

/**
 * 每项能力用一段很短的输入真调一次，核对返回。可能花钱：调用之前由调用方说明（planLiveCalls 给出调哪几项）。
 * @param {object} env 适配器或运行环境（有 capabilities；runtimes 里的 ffmpeg 用来解码非 WAV 的返回）
 * @param {{ capabilities?: string[], text?: string, voice?: { bytes: Uint8Array, mimeType: string, text: string }, vocabulary?: { capabilities: object }, notWired?: string[] }} [options]
 *   voice：要音频输入的能力用的人声（文件头）；点名的里有要音频的又没给，抛 TypeError
 * @returns {Promise<{ ok: boolean, issues: object[], results: object[] }>}
 */
export async function checkAdapterLive(env, { capabilities, text = DEFAULT_TEXT, voice, vocabulary, notWired } = {}) {
  const shape = shapeIssues(env);
  if (hasErrors(shape)) return { ok: false, issues: shape, results: [] };
  const entries = liveEntries(env, capabilities, vocabulary, notWired);
  const audio = entries.filter((entry) => entry.call !== undefined && RULES[entry.capability].audio === true).map((entry) => entry.capability);
  if (audio.length > 0 && !isVoice(voice)) throw new TypeError(`要音频输入的能力（${audio.join('、')}）需要 options.voice：一段人声 { bytes, mimeType, text }，text 是它念的逐字文本（命令行上由 cli/commands/adapter.mjs 给）`);
  const clip = audio.length > 0 ? { bytes: voice.bytes, mimeType: voice.mimeType } : undefined;
  const durationSeconds = audio.length > 0 ? await voiceSeconds(env, voice.bytes) : undefined;
  const results = [];
  for (const entry of entries) {
    const { capability } = entry;
    if (entry.skip !== undefined) {
      results.push({ capability, status: 'skipped', reason: entry.skip, calls: 0, model: null, elapsedMs: 0, issues: [] });
      continue;
    }
    const started = Date.now();
    let result;
    try {
      result = await entry.call(RULES[capability].input({ text, clip, refText: voice?.text }));
    } catch (error) {
      const status = isVoicePackError(error) && Number.isInteger(error.details?.status) ? error.details.status : undefined;
      results.push({
        capability, status: 'failed', calls: 1, model: null, elapsedMs: Date.now() - started,
        issues: [issue('error', 'call_failed', `调用 ${capability} 抛了错：${short(error?.message ?? error)}`, {
          capability, ...(typeof error?.code === 'string' ? { errorCode: error.code } : {}), transient: isServiceError(error), ...(status === undefined ? {} : { status }), message: short(error?.message ?? error),
        })],
      });
      continue;
    }
    const checked = await checkCapabilityResult(capability, result, { env, durationSeconds });
    results.push({ capability, status: hasErrors(checked.issues) ? 'failed' : 'passed', calls: 1, model: checked.model, elapsedMs: Date.now() - started, issues: checked.issues, ...(checked.summary === null ? {} : { summary: checked.summary }) });
  }
  return { ok: results.every((result) => result.status !== 'failed'), issues: [], results };
}
