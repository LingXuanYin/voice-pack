// SPDX-License-Identifier: Apache-2.0
//
// 签名命令（keygen、sign、verify）的共用部分：读写私钥文件（PKCS8 的 PEM 或 DER）、读信任名单、解析 --选项。
// 这是命令行层（protocol/cli/ 里），可以用 node:fs；核心层的程序（protocol/lib/）不碰文件系统。
//
// 私钥文件：PKCS8。写出来是 PEM（`-----BEGIN PRIVATE KEY-----`，和 `openssl genpkey -algorithm ed25519` 一样，可以互相读）；
// 读的时候 PEM 和 DER 都认。私钥的值（文件内容、解码后的字节）绝不进输出、日志、错误信息：
// 读文件失败只说路径和原因，解析失败只说「不是私钥」，底层错误不作为 cause 带出去。
//
// 本文件抛的 code：
//   file_unreadable    读不了文件（私钥、信任名单、被签的文件、签名文件）。details.file、details.what
//   file_unwritable    写不了私钥文件（含建不出它所在的目录）
//   file_exists        私钥文件已存在，不覆盖
//   private_key_invalid  私钥文件不是 Ed25519 的 PKCS8（PEM 的外壳坏了、base64 坏了）
//   trust_list_invalid   信任名单不是合法的 JSON（形状不对由 lib/signature.mjs 的 parseTrustList 报同一个 code）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VoicePackError } from '../lib/errors.mjs';
import { fromBase64, toBase64 } from '../lib/bytes.mjs';

const PEM_LABEL = 'PRIVATE KEY';
const NL = '\n';

/** 协议核心自带的信任名单：protocol/trust.json，里面是官方公钥和官方地址（格式和用法见 SIGNATURES.md）。 */
export const DEFAULT_TRUST_FILE = fileURLToPath(new URL('../trust.json', import.meta.url));

/**
 * 解析命令的选项。名字不带 `--` 前缀；值选项后面必须跟一个值；布尔选项不跟值；其余是位置参数。
 * 有问题不抛错，返回 { problem }：runner 只认它自己的用法错误，命令拿到 problem 自己打印并返回退出码 2。
 * @param {string[]} args
 * @param {{ values?: string[], flags?: string[] }} spec
 * @returns {{ positional: string[], values: Record<string, string>, flags: Set<string>, problem?: string }}
 */
export function parseOptions(args, { values = [], flags = [] } = {}) {
  const out = { positional: [], values: {}, flags: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { out.positional.push(...args.slice(i + 1)); break; }
    if (!arg.startsWith('--')) { out.positional.push(arg); continue; }
    const name = arg.slice(2);
    if (values.includes(name)) {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) return { ...out, problem: `选项 --${name} 后面要跟一个值` };
      if (name in out.values) return { ...out, problem: `选项 --${name} 重复了` };
      out.values[name] = args[++i];
    } else if (flags.includes(name)) {
      out.flags.add(name);
    } else {
      return { ...out, problem: `未知选项 ${arg}` };
    }
  }
  return out;
}

/** 读文件。读不到抛 file_unreadable，只带路径和系统给的原因，不带内容，也不带底层错误（私钥文件的内容可能在里面）。 */
export function readFileBytes(file, what) {
  try {
    return new Uint8Array(fs.readFileSync(file));
  } catch (cause) {
    throw new VoicePackError('file_unreadable', `读不了${what}：${file}（${cause?.code ?? '未知原因'}）`, { details: { file: String(file), what } });
  }
}

/**
 * 读 PKCS8 私钥文件。PEM（有 BEGIN PRIVATE KEY 那一行）和 DER 都认。
 * @returns {Uint8Array} PKCS8 的 DER 字节
 * @throws {VoicePackError} file_unreadable、private_key_invalid
 */
export function readPrivateKeyFile(file) {
  const bytes = readFileBytes(file, '私钥文件');
  const invalid = () => new VoicePackError('private_key_invalid', `私钥文件不是 Ed25519 的 PKCS8 私钥：${file}`, { details: { file: String(file) } });
  const text = new TextDecoder('utf-8').decode(bytes);
  if (!text.includes('-----BEGIN')) return bytes; // 当 DER 用；不对的话 signature.mjs 导入时会报 private_key_invalid
  const match = text.match(new RegExp(`-----BEGIN ${PEM_LABEL}-----([\\s\\S]*?)-----END ${PEM_LABEL}-----`));
  if (match === null) throw invalid();
  try {
    return fromBase64(match[1]);
  } catch {
    throw invalid();
  }
}

/** PKCS8 的 DER 字节写成 PEM 文本（64 列折行，和 OpenSSL 一致）。 */
export function privateKeyToPem(der) {
  const body = toBase64(der).match(/.{1,64}/g) ?? [];
  return [`-----BEGIN ${PEM_LABEL}-----`, ...body, `-----END ${PEM_LABEL}-----`, ''].join(NL);
}

/**
 * 写私钥文件：已经存在就拒绝（换钥匙是件严肃的事，不悄悄覆盖）；权限只给自己（0600，Windows 上这个模式没有意义）。
 * 用 'wx' 打开，「检查存在」和「创建」是同一步，不会被抢先。
 * @throws {VoicePackError} file_exists、file_unwritable
 */
export function writePrivateKeyFile(file, der) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  } catch (cause) {
    // 建不出它所在的目录（路径上有一段是文件、没有权限……）：目录的事，不是私钥文件已经存在，不报 file_exists
    throw new VoicePackError('file_unwritable', `写不了私钥文件：${file}，建不出它所在的目录（${cause?.code ?? '未知原因'}）`, { details: { file: String(file) } });
  }
  try {
    fs.writeFileSync(file, privateKeyToPem(der), { flag: 'wx', mode: 0o600 });
  } catch (cause) {
    if (cause?.code === 'EEXIST') {
      throw new VoicePackError('file_exists', `${file} 已存在，不覆盖：确实要换钥匙就先自己挪走旧的`, { details: { file: String(file) } });
    }
    throw new VoicePackError('file_unwritable', `写不了私钥文件：${file}（${cause?.code ?? '未知原因'}）`, { details: { file: String(file) } });
  }
}

/**
 * 读信任名单（JSON 文件）。形状由 lib/signature.mjs 的 parseTrustList 检查。
 * @throws {VoicePackError} file_unreadable、trust_list_invalid
 */
export function readTrustListFile(file) {
  const bytes = readFileBytes(file, '信任名单');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new VoicePackError('trust_list_invalid', `信任名单不是合法的 JSON：${file}`, { details: { file: String(file), field: 'trust_list' }, cause });
  }
}
