// SPDX-License-Identifier: Apache-2.0
//
// 进程适配器的线上格式：编码一个请求，读懂程序写回的一行，把程序报的错变成 VoicePackError。纯函数，只用平台自带的 API，浏览器和 Node 都能跑。
// 进程协议本身（有哪些消息、每个字段的意思、什么时候出错）的正本只有 README.md（本目录），这里实现它，不重述；起进程、等回应、超时是 cli/session.mjs 的事。
//
//   encodeRequest({ id, capability, params })   一个请求 → 一行 JSON（只含 ASCII，不带换行）。音频片段 { bytes, mimeType } 的 bytes 换成 Base64；
//                                               params 里的 enhancers 不传（增强件是要 load() 读的函数，传不过去）
//   parseProgramLine(line)                      程序写的一行 → { kind: 'noise' }（不是进程协议的消息：日志之类，忽略）
//                                               | { kind: 'ready', capabilities, info }
//                                               | { kind: 'response', id, ok: true, result } | { kind: 'response', id, ok: false, error }
//                                               | { kind: 'invalid', id?, problem }（是进程协议的消息，但写得不对）
//   decodeClips(value)                          把返回值里的 { bytes: Base64, mimeType } 换回 { bytes: Uint8Array, mimeType }（任意深度）
//   programError(error, capability)             程序回的 error → VoicePackError
//   PROTOCOL_VERSION                            现在是 1
//
// 抛出的错误（VoicePackError）：
//   process_request_invalid   请求编不出来：params 里有裸的 Uint8Array（音频要写成 { bytes, mimeType }）、循环引用、BigInt。details.capability、problem
//   process_program_error     程序回的 error.code 不合 code 的写法（小写字母、数字、下划线，字母开头）时用它；原来的 code 在 details.programCode
//   程序自己报的合格的 code 原样用，不在这里定义。
import { toBase64, fromBase64 } from '../../protocol/lib/bytes.mjs';
import { VoicePackError } from '../../protocol/lib/errors.mjs';

export const PROTOCOL_VERSION = 1;

const CODE_RE = /^[a-z][a-z0-9_]*$/;
const NON_ASCII = new RegExp(`[${String.fromCharCode(0x80)}-${String.fromCharCode(0xffff)}]`, 'g');
const BACKSLASH = String.fromCharCode(92);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** JSON 文字里的非 ASCII 字符换成 反斜杠 u 加四位十六进制（按 UTF-16 单元换，代理对换成两个，JSON 解码器会把它们合回去）：程序的标准输入不管是什么编码都读得对。 */
const toAscii = (json) => json.replace(NON_ASCII, (char) => `${BACKSLASH}u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** 音频片段：有 Uint8Array 的 bytes 和字符串的 mimeType。 */
const isClip = (value) => isPlainObject(value) && value.bytes instanceof Uint8Array && typeof value.mimeType === 'string';

export function encodeRequest({ id, capability, params }) {
  const { enhancers, ...rest } = isPlainObject(params) ? params : {};
  void enhancers; // 增强件不传：它是要 load() 才读得到内容的函数
  const replacer = (key, value) => {
    if (isClip(value)) return { ...value, bytes: toBase64(value.bytes) };
    if (value instanceof Uint8Array) {
      throw new VoicePackError('process_request_invalid', `${capability} 的参数里${key === '' ? '' : ` ${key}`} 是裸的字节：音频要写成 { bytes, mimeType }`, { details: { capability, problem: 'bare_bytes', field: key } });
    }
    return value;
  };
  try {
    return toAscii(JSON.stringify({ id, capability, params: rest }, replacer));
  } catch (cause) {
    if (cause instanceof VoicePackError) throw cause;
    throw new VoicePackError('process_request_invalid', `${capability} 的参数编不成 JSON：${cause?.message ?? cause}`, { details: { capability, problem: 'not_json' }, cause });
  }
}

function readyOf(value) {
  if (value.protocol !== PROTOCOL_VERSION) {
    return { kind: 'invalid', problem: `ready 里的 protocol 要是 ${PROTOCOL_VERSION}，收到 ${JSON.stringify(value.protocol)}` };
  }
  const { capabilities } = value;
  if (!Array.isArray(capabilities) || capabilities.some((name) => typeof name !== 'string' || name === '')) {
    return { kind: 'invalid', problem: 'ready 里的 capabilities 要是能力名的数组（非空字符串）' };
  }
  return { kind: 'ready', capabilities: [...new Set(capabilities)], info: value.info };
}

function responseOf(value) {
  const { id } = value;
  if (typeof value.ok !== 'boolean') return { kind: 'invalid', id, problem: '回应里要有 ok（true 或 false）' };
  if (value.ok) {
    if (!isPlainObject(value.result)) return { kind: 'invalid', id, problem: 'ok 为 true 时，result 要是对象' };
    return { kind: 'response', id, ok: true, result: value.result };
  }
  const { error } = value;
  if (!isPlainObject(error) || typeof error.code !== 'string' || error.code === '') {
    return { kind: 'invalid', id, problem: 'ok 为 false 时，error 要是对象，里面要有非空字符串的 code' };
  }
  return { kind: 'response', id, ok: false, error };
}

export function parseProgramLine(line) {
  const text = String(line).trim();
  if (text === '' || text[0] !== '{') return { kind: 'noise' };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'noise' };
  }
  if (!isPlainObject(value)) return { kind: 'noise' };
  if (value.event !== undefined) return value.event === 'ready' ? readyOf(value) : { kind: 'noise' }; // 不认识的事件忽略：以后可以加
  if (!Object.hasOwn(value, 'id')) return { kind: 'noise' }; // 没有 id 也没有 event：程序自己的结构化日志
  return responseOf(value);
}

/** 返回值里的 { bytes: Base64, mimeType } 换回字节。Base64 写得不对抛 invalid_base64（核心层的错），由调用方接住说明是哪个能力。 */
export function decodeClips(value) {
  if (Array.isArray(value)) return value.map(decodeClips);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = decodeClips(item);
  if (typeof value.bytes === 'string' && typeof value.mimeType === 'string') out.bytes = fromBase64(value.bytes);
  return out;
}

export function programError(error, capability) {
  const code = CODE_RE.test(error.code) ? error.code : 'process_program_error';
  const message = typeof error.message === 'string' && error.message !== '' ? error.message : `程序报了错 ${error.code}`;
  const { transient, ...given } = isPlainObject(error.details) ? error.details : {};
  void transient; // 只认 error 上的 transient，details 里夹带的不算
  const details = { ...given, capability };
  if (code !== error.code) details.programCode = error.code;
  if (error.transient === true) details.transient = true;
  return new VoicePackError(code, message, { details });
}
