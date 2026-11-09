// SPDX-License-Identifier: Apache-2.0
//
// 命令行层读写音频文件：后缀和 MIME 类型互相换，读成 { bytes, mimeType }。Node 专有（node:fs），所以放在命令行层。
// 库的接口上不出现路径，交进去的是字节加 MIME 类型（protocol/lib/audio-clip.mjs）。
// 后缀到 MIME 类型的表只在这里写一份，别的命令问它：mimeOfFileName、AUDIO_EXTENSIONS、isAudioFileName、extensionOfMime、readAudioFile。
// 做包（make-pack）的素材和长录音另外收带视频轨的文件（VIDEO_EXTENSIONS：从视频、动画、游戏里截的片段），问 isMediaFileName、readMediaFile：
//   读成的 MIME 类型也写成 audio/ 开头的（库里的音频片段只收这种，protocol/lib/audio-clip.mjs），字节原样交给库，由做包取音轨（lib/make-pack-take-audio.mjs，要 ffmpeg）。
//   别的命令（convert、fidelity 的评测集）不收视频：它们把音频原样交给模型或拿去比，不取音轨。
//
// 抛出的错误（VoicePackError）：
//   audio_input_invalid   后缀认不出是音频，或者文件是空的。details.file、details.reason（extension | empty）
//   file_unreadable       读不了文件（来自 input.mjs 的 readBytes）
import path from 'node:path';
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { readBytes } from './input.mjs';

const MIME_OF = Object.freeze({ wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', flac: 'audio/flac' });
const EXTENSION_OF = Object.freeze({ 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/flac': 'flac', 'audio/x-flac': 'flac' });

/** 带视频轨的文件的后缀：只有做包收（见文件头），MIME 类型写成 audio/ 开头的。 */
const VIDEO_MIME_OF = Object.freeze({ mp4: 'audio/mp4', m4v: 'audio/mp4', mov: 'audio/quicktime', mkv: 'audio/x-matroska' });
/** 做包收的带视频轨的文件的后缀（不带点）。 */
export const VIDEO_EXTENSIONS = Object.freeze(Object.keys(VIDEO_MIME_OF));

/** 认得的音频后缀（不带点），给「能用的后缀有哪些」的错误说明用。 */
export const AUDIO_EXTENSIONS = Object.freeze(Object.keys(MIME_OF));

/** 文件名（或路径）的后缀对应的 MIME 类型；后缀不分大小写；认不出的（包括没有后缀）是 undefined。 */
export function mimeOfFileName(name) {
  const extension = path.extname(name).slice(1).toLowerCase();
  return Object.hasOwn(MIME_OF, extension) ? MIME_OF[extension] : undefined;
}

/** 音频的 MIME 类型对应的文件后缀（不带点）；认不出的用 bin。 */
export function extensionOfMime(mimeType) {
  return EXTENSION_OF[String(mimeType).split(';')[0].trim().toLowerCase()] ?? 'bin';
}

/** 这个文件名的后缀是不是认得的音频后缀（读一个目录、挑出里面的音频文件时用）。 */
export function isAudioFileName(name) {
  return mimeOfFileName(name) !== undefined;
}

/** 读一个音频文件：后缀认类型，读成字节。命令行里写的相对路径相对 ctx.cwd。 */
export function readAudioFile(ctx, argument) {
  return readWithMime(ctx, argument, mimeOfFileName(argument), AUDIO_EXTENSIONS);
}

/** 做包的素材和长录音：音频，或者带视频轨的文件（见文件头）。 */
export function isMediaFileName(name) {
  return isAudioFileName(name) || Object.hasOwn(VIDEO_MIME_OF, path.extname(name).slice(1).toLowerCase());
}

/** 读做包的一段素材或长录音：音频，或者带视频轨的文件（见文件头），后缀认类型，读成字节。 */
export function readMediaFile(ctx, argument) {
  const extension = path.extname(argument).slice(1).toLowerCase();
  return readWithMime(ctx, argument, mimeOfFileName(argument) ?? (Object.hasOwn(VIDEO_MIME_OF, extension) ? VIDEO_MIME_OF[extension] : undefined), [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]);
}

function readWithMime(ctx, argument, mimeType, allowed) {
  if (mimeType === undefined) {
    const extension = path.extname(argument).slice(1).toLowerCase();
    throw new VoicePackError('audio_input_invalid', `${argument} 的后缀 .${extension} 认不出是什么音频（能用的：${allowed.join('、')}）`, { details: { file: argument, reason: 'extension' } });
  }
  const bytes = readBytes(ctx, argument);
  if (bytes.length === 0) throw new VoicePackError('audio_input_invalid', `${argument} 是空文件`, { details: { file: argument, reason: 'empty' } });
  return { bytes, mimeType };
}
