// SPDX-License-Identifier: Apache-2.0
//
// 包里的脚本（流程层）：照清单登记的入口和运行时直接运行：
//   运行环境完全信任脚本：直接运行，不让用户确认，不隔离，也不限制权限（安全靠社区的审核）。清单里只登记入口和运行时，不声明权限。
//   环境缺脚本要的运行时，用到这个脚本的功能就报错（只有这个功能，别的功能照常）。
//   不做事后检查，不去发现脚本改过什么。
// 这个模块只管「怎么叫脚本、怎么读它的回答」，不管脚本里写什么；叫它的时机由用到它的功能定（lib/dub.mjs、lib/convert.mjs）。
//
// 哪个脚本属于哪个功能：清单里脚本登记的 feature。一个功能只跑登记在自己名下的脚本；没登记功能的脚本不属于任何功能，
// 不会被自动运行（包的配音指引可以告诉 agent 手动怎么用它）。功能名就是清单 features 里的名字：配音是 dub，变声是 convert。
//
// 运行时：脚本的 runtime 字段是运行环境 env.runtimes 里的名字（node、python……，写法同 protocol/FORMAT.md「运行时」）。
// 脚本运行时的签名（env.runtimes[<runtime>] 是这样一个函数；ffmpeg 那一类的签名另见 tools/audio-decode.mjs）：
//   async ({ entry, input }) => string | Uint8Array
//     entry   清单里登记的入口，相对角色部分的目录（例如 scripts/denoise.mjs）。运行时在包目录里运行它。
//     input   写进脚本标准输入的 UTF-8 文字（一份 JSON，见下）。
//     返回    脚本写到标准输出的内容（UTF-8）。脚本以非零退出码结束、起不来、超时，运行时就抛错；这里包成 script_failed。
// 库不起进程：运行时由命令行层提供（cli/script-runtimes.mjs），测试里用假的。
//
// 脚本的约定（写给包作者，base SKILL.md 里也有）。脚本从标准输入读一份 JSON，往标准输出写一份 JSON（或者什么都不写）：
//   输入  { protocol: 1, feature, hook, pack: { id, name, version }, unit: {…} }
//         hook 是 text（合成之前，每一段要说的话；unit 带 index、line、part、parts、chapter、text、language？、emotion？、style？）
//         或 audio（合成之后，每一段的音频；unit 带同样的字段，加 mimeType 和 audio，audio 是 Base64）。
//         同一个脚本在两个钩子里都会被叫到；对这次钩子没什么要做的就什么都不输出，或者输出 {}。
//   输出  text 钩子：{ "text": "改写后的话" }（非空字符串）。audio 钩子：{ "audio": "<Base64>", "mimeType": "audio/wav" }（mimeType 可省，省略沿用原来的）。
//         空输出或 {} 是「不改」。别的键、不是 JSON 对象的输出，一律报错（script_output_invalid），不悄悄忽略：忽略了，作者写的处理就默默不起作用了。
//   同一个功能有几个脚本时，按清单里的先后一个接一个运行，后一个收到的是前一个改过的结果。
//
// 抛出的错误（VoicePackError；code 小写下划线）：
//   runtime_missing         环境没有脚本要的运行时（来自核心层，这里补上 details.entry、feature）。details: { runtime, entry, feature }
//   script_failed           脚本没跑成（运行时抛了错）。details: { entry, runtime, hook, feature }，原始错误在 cause
//   script_output_invalid   脚本的输出不合约定。details: { entry, runtime, hook, feature, reason }，reason 是
//                           not_json | not_object | unknown_key（另有 key）| text_invalid | audio_invalid | mime_invalid
//   脚本文件和清单对不对得上，不在这里查：进入环境时检查过一次（进来以后不再复查），运行时按清单登记的入口直接运行。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError, isVoicePackError } from '../protocol/lib/errors.mjs';
import { requireRuntime } from '../protocol/lib/env.mjs';
import { toBase64, fromBase64 } from '../protocol/lib/bytes.mjs';
import { assertAudioClip } from '../protocol/lib/audio-clip.mjs';

export const SCRIPT_PROTOCOL = 1;
/** 每个钩子允许脚本回答哪些键。 */
const ALLOWED = Object.freeze({ text: ['text'], audio: ['audio', 'mimeType'] });
export const HOOKS = Object.freeze(Object.keys(ALLOWED));

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const decoder = new TextDecoder('utf-8');

/** 清单里没登记功能（没写 feature）的脚本：[{ entry, runtime }]。它们不属于任何功能，不会被自动运行；功能的报告用它点名这些脚本。scripts 是 pack.scripts() 给的。 */
export function scriptsWithoutFeature(scripts) {
  return scripts.filter((script) => script.feature === undefined).map(({ entry, runtime }) => ({ entry, runtime }));
}

/** 这个功能的脚本里，环境缺运行时的那些：[{ runtime, entry, feature }]。不抛错，让规划能把缺什么摆出来。 */
export function missingScriptRuntimes(env, scripts, feature) {
  const missing = [];
  for (const script of scripts) {
    try {
      requireRuntime(env, script.runtime);
    } catch (error) {
      if (!isVoicePackError(error, 'runtime_missing')) throw error;
      missing.push({ runtime: script.runtime, entry: script.entry, feature });
    }
  }
  return missing;
}

/** 缺运行时就抛 runtime_missing，点名运行时、脚本、功能。在花钱之前调用。 */
export function assertScriptRuntimes(env, scripts, feature) {
  const [first] = missingScriptRuntimes(env, scripts, feature);
  if (first !== undefined) {
    throw new VoicePackError('runtime_missing', `运行环境没有提供运行时 ${first.runtime}：包里的脚本 ${first.entry} 要用它，${feature} 功能不能运行，其他功能照常`, { details: first });
  }
}

/** 钩子里给脚本的音频字段：把 { bytes, mimeType } 变成 JSON 能装的。 */
export function audioForScript(clip) {
  return { mimeType: clip.mimeType, audio: toBase64(clip.bytes) };
}

/**
 * 运行一个脚本的一个钩子，返回它的输出（对象，空输出是 {}）。已经按钩子核对过键。
 * @param {object} env 注入的运行环境
 * @param {{ manifest: object }} pack openVoicePack 打开的包（取包的 id、名字、版本告诉脚本）
 * @param {{ entry: string, runtime: string }} script 清单里登记的脚本
 * @param {{ feature: string, hook: 'text' | 'audio', unit: object }} call
 */
export async function runScript(env, pack, script, { feature, hook, unit }) {
  if (!Object.hasOwn(ALLOWED, hook)) throw new TypeError(`钩子必须是 ${HOOKS.join(' 或 ')}，收到 ${JSON.stringify(hook)}`);
  const runtime = requireRuntime(env, script.runtime);
  const where = { entry: script.entry, runtime: script.runtime, hook, feature };
  const request = { protocol: SCRIPT_PROTOCOL, feature, hook, pack: { id: pack.manifest.id, name: pack.manifest.name, version: pack.manifest.version }, unit };

  let stdout;
  try {
    stdout = await runtime({ entry: script.entry, input: JSON.stringify(request) });
  } catch (cause) {
    if (isVoicePackError(cause)) throw cause;
    throw new VoicePackError('script_failed', `包里的脚本 ${script.entry}（${script.runtime}，${hook} 钩子）没有跑成：${cause?.message ?? cause}`, { details: where, cause });
  }
  const invalid = (reason, message, extra = {}) => new VoicePackError('script_output_invalid', `脚本 ${script.entry}（${hook} 钩子）的输出不合约定：${message}`, { details: { ...where, reason, ...extra } });

  const raw = typeof stdout === 'string' ? stdout : stdout instanceof Uint8Array ? decoder.decode(stdout) : null;
  if (raw === null) throw invalid('not_json', '运行时要返回字符串或字节');
  if (raw.trim() === '') return {};
  let output;
  try {
    output = JSON.parse(raw);
  } catch {
    throw invalid('not_json', '不是 JSON');
  }
  if (!isPlainObject(output)) throw invalid('not_object', '要是一个 JSON 对象（什么都不改就输出 {}）');
  for (const key of Object.keys(output)) {
    if (!ALLOWED[hook].includes(key)) throw invalid('unknown_key', `${hook} 钩子不认识键 ${JSON.stringify(key)}（认得：${ALLOWED[hook].join('、')}）`, { key });
  }
  if (hook === 'text' && 'text' in output && (typeof output.text !== 'string' || output.text.trim() === '')) throw invalid('text_invalid', 'text 要是非空字符串');
  if (hook === 'audio') {
    if ('mimeType' in output && (typeof output.mimeType !== 'string' || !/^audio\//i.test(output.mimeType))) throw invalid('mime_invalid', 'mimeType 要是 audio/ 开头的类型');
    if ('audio' in output) {
      try {
        const bytes = fromBase64(output.audio);
        assertAudioClip({ bytes, mimeType: output.mimeType ?? 'audio/wav' });
      } catch {
        throw invalid('audio_invalid', 'audio 要是非空的 Base64 字符串');
      }
    } else if ('mimeType' in output) {
      throw invalid('audio_invalid', '只给了 mimeType 没给 audio');
    }
  }
  return output;
}
