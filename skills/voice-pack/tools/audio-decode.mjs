// SPDX-License-Identifier: Apache-2.0
//
// 音频解码：把一段音频的字节解成采样值，每个声道一个 Float32Array。只做计算，不用模型。
//
// 两条路：
//   WAV    PCM 16、24、32 位整数和 32 位浮点，单声道和多声道：自己解（wav.mjs），不需要任何运行时。
//   别的   mp3、ogg、flac、m4a、webm、opus……，以及 WAV 里自己不会解的编码（8 位、ADPCM……）：
//          向运行环境要 ffmpeg（env.runtimes.ffmpeg），让它转成 32 位浮点的 WAV，再自己解。
//          环境没有 ffmpeg 就抛 runtime_missing（核心层的错误类，details.runtime 是 'ffmpeg'）；
//          只有用到 ffmpeg 的音频才会这样，自己能解的 WAV 照常。
// 判断是不是 WAV 只看文件头（RIFF/WAVE），不看扩展名和 MIME 类型；别的格式交给 ffmpeg 按内容识别。
// 文件头本身坏了的 WAV（wav_invalid）直接报错，不交给 ffmpeg 碰运气。
// 整段音频解到内存里：16 位 WAV 解出来是原来的两倍大，ffmpeg 解出来是 32 位浮点；要处理很长的录音，调用方先切。
//
// @runtime ffmpeg
//   这项运行时的签名在这里定（别的模块以后也调 ffmpeg，就在这个签名上用，不另写一份）：
//     async (args: string[], input: Uint8Array) => Uint8Array      同步的实现也行，库会 await 它的返回值
//     args    ffmpeg 的参数，字符串数组，不含程序名。参数里恰好等于 '{input}' 的那一项，换成输入文件；恰好等于 '{output}' 的那一项，换成输出文件。
//             输入和输出是管道、临时文件还是虚拟文件系统，由运行环境决定。库不假设是管道：解 m4a 这类要往回读的格式，管道不行。
//     input   输入文件的全部字节
//     返回    输出文件的全部字节
//     出错    ffmpeg 失败（退出码非 0）时抛错，错误信息里带 ffmpeg 说的话（最后几行）；库把它包成 audio_decode_failed。
//   这里用的参数是固定的：
//     -hide_banner -nostdin -v error -protocol_whitelist file -i {input} -map 0:a:0 -f wav -acodec pcm_f32le {output}
//     只读本地文件（-protocol_whitelist file：输入是不可信的字节，播放列表、拼接文件不能借 ffmpeg 去读别的路径或网址）；
//     只取第一路音频（-map 0:a:0，没有音频流就失败）；输出 32 位浮点 WAV；不改采样率和声道数，所以质量检查看到的是原来的采样率。
//
// 错误码（谁抛谁定义）：
//   audio_decode_failed   没能把这段字节解成音频。details.reason 说哪种：
//                           empty           输入是空的
//                           runtime_failed  ffmpeg 失败（不是音频、文件损坏或被截断、没有音频流……）；cause 是运行环境抛的错
//                           bad_output      ffmpeg 返回的东西不是能解析的 WAV（空的、不是字节、文件头坏了）；cause 是解析的错
//                         details.decoder 是 'ffmpeg'；输入是空的时是 null。
//   另外会原样抛出：wav_invalid（wav.mjs）、runtime_missing（核心层）、environment_invalid（核心层）。
//   decodeFailureKind(error)  把上面这些错分成三类：'runtime_missing'（这段音频要 ffmpeg，环境没有）、'undecodable'（这段音频自己解不了：
//                             audio_decode_failed、wav_invalid）、null（别的错，原样往上抛）。调用方判断解码出了什么事用它，不各自列错误码。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { requireRuntime } from '../protocol/lib/env.mjs';
import { VoicePackError, isVoicePackError } from '../protocol/lib/errors.mjs';
import { isWav, parseWav } from './wav.mjs';

const FFMPEG_ARGS = Object.freeze([
  '-hide_banner', '-nostdin', '-v', 'error',
  '-protocol_whitelist', 'file',
  '-i', '{input}',
  '-map', '0:a:0',
  '-f', 'wav', '-acodec', 'pcm_f32le',
  '{output}',
]);

const failed = (reason, decoder, message, cause) =>
  new VoicePackError('audio_decode_failed', message, { details: { reason, decoder }, cause });

// 运行环境抛的错里的话，只留一行的长度，免得 ffmpeg 一大段输出塞满信息
const said = (error) => String(error?.message ?? error).trim().slice(-400);

/**
 * 解码抛的错分哪一种：调用方（做包、查重……）按它决定怎么办，不各自再列一遍错误码。
 *   'runtime_missing'  这段音频要 ffmpeg，环境没有（runtime_missing，details.runtime 是缺的运行时）：环境的事，不是这段音频的事
 *   'undecodable'      这段音频解不了（audio_decode_failed；WAV 的文件头坏了 wav_invalid）：音频自己的事，换一段就行
 *   null               别的错（TypeError、environment_invalid、不是错误的值……）：不是解码这一步的结局，调用方原样往上抛
 * wav_unsupported（合法的 WAV、编码自己不会解）不在其中：decodeAudio 里把它交给 ffmpeg，不会让它出来。
 * @param {unknown} error
 * @returns {'runtime_missing' | 'undecodable' | null}
 */
export function decodeFailureKind(error) {
  if (isVoicePackError(error, 'runtime_missing')) return 'runtime_missing';
  if (isVoicePackError(error, 'audio_decode_failed') || isVoicePackError(error, 'wav_invalid')) return 'undecodable';
  return null;
}

/**
 * 解码一段音频。
 * @param {object|undefined} env 注入的运行环境；音频是自己能解的 WAV 时可以不给
 * @param {Uint8Array} bytes 音频文件的全部字节
 * @returns {Promise<{ decoder: 'wav'|'ffmpeg', sampleRate: number, channels: number, frames: number, samples: Float32Array[] }>}
 * @throws {TypeError} bytes 不是 Uint8Array
 * @throws {VoicePackError} audio_decode_failed、wav_invalid、runtime_missing、environment_invalid
 */
export async function decodeAudio(env, bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('音频必须是 Uint8Array（Buffer 也行）');
  if (bytes.length === 0) throw failed('empty', null, '音频是空的，没有可解码的内容');
  if (isWav(bytes)) {
    try {
      const { sampleRate, channels, frames, samples } = parseWav(bytes);
      return { decoder: 'wav', sampleRate, channels, frames, samples };
    } catch (error) {
      if (!isVoicePackError(error, 'wav_unsupported')) throw error;
      // 是合法的 WAV，只是编码自己不会解：往下交给 ffmpeg
    }
  }
  const ffmpeg = requireRuntime(env, 'ffmpeg');
  let output;
  try {
    output = await ffmpeg([...FFMPEG_ARGS], bytes);
  } catch (cause) {
    throw failed('runtime_failed', 'ffmpeg', `ffmpeg 没能解码这段音频：${said(cause)}`, cause);
  }
  try {
    const { sampleRate, channels, frames, samples } = parseWav(output); // 空的、不是字节、坏的，parseWav 都会抛，下面统一包成 bad_output
    return { decoder: 'ffmpeg', sampleRate, channels, frames, samples };
  } catch (cause) {
    throw failed('bad_output', 'ffmpeg', `ffmpeg 返回的不是能解析的 WAV：${said(cause)}`, cause);
  }
}
