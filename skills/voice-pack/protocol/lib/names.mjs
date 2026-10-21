// SPDX-License-Identifier: Apache-2.0
//
// 协议主版本对应的名字：哪个主版本，基础部分的目录叫什么，官方发布的 zip 叫什么，分享文件的类型标识是什么。
// 三个名字都跟协议主版本走，只在下面的 PROTOCOL_NAMES 这一张表里写一份（官方发布的文件名是 `<releaseFilePrefix>-<版本>.voicepack.zip`），
// 别处都问下面的函数，不各写一份。
//
// 2.0 把名字从产品名换成协议自己的名字（FORMAT.md「协议版本 2.0 改了什么」），1.x 已经发出去的包照旧是老名字，所以两套都认：
//   写   这一版库写的协议版本是 PROTOCOL_VERSION（version.mjs），新做的包、新打的分享文件用它的名字（CURRENT_NAMES）。
//        打已有清单的包（打包命令、官方发布）用清单自己的协议版本对应的名字，同样的目录打出同样的字节。
//   读   两套名字都认，但一个包里的名字要和它的协议版本对得上：2.0 的包里是老名字、1.x 的包里是新名字，检查不过（protocol_name_mismatch，check.mjs、share.mjs）。
//
// 函数的 protocol 参数写「主.次」的协议版本（"2.0"），或者协议主版本（整数 2）：只有主版本决定名字。
//
// 错误：
//   protocol_unsupported   协议主版本不在表里（这一版库读不了）。details: { protocol, supported }
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from './errors.mjs';
import { PROTOCOL_VERSION, parseProtocolVersion } from './version.mjs';

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

/**
 * 每个协议主版本的三个名字。releaseFilePrefix 是官方发布的 zip 文件名里版本号前面的那段：<releaseFilePrefix>-<版本>.voicepack.zip（后缀见 share.mjs 的 SHARE_SUFFIX）。
 * 新增一个主版本，在这里加一行；老的行不改不删：已经发出去的包要照旧读。
 */
export const PROTOCOL_NAMES = deepFreeze({
  1: { baseDirectory: 'cohub-voice-studio', releaseFilePrefix: 'cohub-voice-studio', shareMime: 'application/vnd.cohub.voicepack+zip' },
  2: { baseDirectory: 'voice-pack', releaseFilePrefix: 'voice-pack', shareMime: 'application/vnd.voice-pack+zip' },
});

/** 这一版库读得了的协议主版本，从小到大。 */
export const READABLE_PROTOCOL_MAJORS = Object.freeze(Object.keys(PROTOCOL_NAMES).map(Number).sort((a, b) => a - b));
/** 写进错误详情和文字里的写法：「1.x、2.x」。 */
export const READABLE_PROTOCOLS_TEXT = READABLE_PROTOCOL_MAJORS.map((major) => `${major}.x`).join('、');

/**
 * 协议版本（「主.次」的字符串）或协议主版本（整数）的主版本。
 * @throws {VoicePackError} invalid_version（字符串写得不对）；协议主版本不是整数也抛 invalid_version
 */
export function protocolMajorOf(protocol) {
  if (typeof protocol === 'number') {
    if (Number.isSafeInteger(protocol) && protocol >= 0) return protocol;
    throw new VoicePackError('invalid_version', `协议主版本要是非负整数：${JSON.stringify(protocol)}`, { details: { version: String(protocol) } });
  }
  return parseProtocolVersion(protocol).major;
}

/** 这个协议主版本是不是这一版库读得了的。 */
export const isReadableProtocol = (protocol) => {
  try { return Object.hasOwn(PROTOCOL_NAMES, protocolMajorOf(protocol)); } catch { return false; }
};

/**
 * 这个协议版本的三个名字。
 * @param {string | number} protocol 「主.次」或主版本
 * @returns {{ baseDirectory: string, releaseFilePrefix: string, shareMime: string }}
 * @throws {VoicePackError} invalid_version、protocol_unsupported（主版本这一版库读不了）
 */
export function namesOf(protocol) {
  const major = protocolMajorOf(protocol);
  if (!Object.hasOwn(PROTOCOL_NAMES, major)) {
    throw new VoicePackError('protocol_unsupported', `协议 ${protocol} 的名字这一版库不认得：只认主版本 ${READABLE_PROTOCOLS_TEXT}`, { details: { protocol: String(protocol), supported: READABLE_PROTOCOLS_TEXT } });
  }
  return PROTOCOL_NAMES[major];
}

/** 这个协议版本里，基础部分的目录名。 */
export const baseDirectoryOf = (protocol) => namesOf(protocol).baseDirectory;
/** 这个协议版本里，分享文件的类型标识（分享文件第一项 mimetype 的内容）。 */
export const shareMimeOf = (protocol) => namesOf(protocol).shareMime;
/** 这个协议版本里，官方发布的 zip 文件名里版本号前面的那段。 */
export const releaseFilePrefixOf = (protocol) => namesOf(protocol).releaseFilePrefix;

/** 这一版库写的名字：新做的包、新打的分享文件用它们（PROTOCOL_VERSION 对应的那一行）。 */
export const CURRENT_NAMES = namesOf(PROTOCOL_VERSION);

/** 认得的所有基础部分目录名（每个主版本一个）。 */
export const KNOWN_BASE_DIRECTORIES = Object.freeze(READABLE_PROTOCOL_MAJORS.map((major) => PROTOCOL_NAMES[major].baseDirectory));
/** 认得的所有类型标识（每个主版本一个）。 */
export const KNOWN_SHARE_MIMES = Object.freeze(READABLE_PROTOCOL_MAJORS.map((major) => PROTOCOL_NAMES[major].shareMime));

/** 这个基础部分目录名是哪个协议主版本的；不是任何一个认得的名字就是 null。 */
export const protocolMajorOfBaseDirectory = (name) => READABLE_PROTOCOL_MAJORS.find((major) => PROTOCOL_NAMES[major].baseDirectory === name) ?? null;
/** 这个类型标识是哪个协议主版本的；不是任何一个认得的标识就是 null。 */
export const protocolMajorOfShareMime = (mime) => READABLE_PROTOCOL_MAJORS.find((major) => PROTOCOL_NAMES[major].shareMime === mime) ?? null;
