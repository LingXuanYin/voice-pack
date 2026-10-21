// SPDX-License-Identifier: Apache-2.0
//
// check、pack、unpack 共用的检查：把命令行给的路径（分享文件或目录）读进来，按库的检查走一遍：
// 每个部分各自对得上清单、验签、互相校验。命令行层的东西（读文件、读目录、读信任名单）在这里，检查本身都在库里（lib/check.mjs、lib/share.mjs、lib/official.mjs）。
//
// 验签和互相校验默认就开，不用命令各自去开。库的入口（checkPart、checkShareFile、inspectShareFile）要调用方明确选验签的策略，
// 不选就抛 signature_policy_missing（规则见 lib/check.mjs 的文件头）：这里就是命令行的那一次明确选择，永远给验签函数。
//   信任名单   默认是正在运行的这份协议核心自带的 protocol/trust.json（DEFAULT_TRUST_FILE）。不是被检查的包里带的那份：
//              包里的名单是包的作者写的，不能拿来认这个包。--trust <文件> 换一份名单，给测试和第三方用。
//   基础部分、协议核心   必须带官方签名；角色部分不验（作者身份交给社区账号）。
//   --allow-unsigned     加上库的 allowUnsigned: true：只放过「没有签名文件」的部分，报告里写明没验；有签名文件的照验。本地开发用，不是关掉验签。
//   互相校验   角色部分和它带着的基础部分对一对：协议主版本、基础部分的版本、所需能力（lib/mutual.mjs）。
//
// CHECK_OPTIONS 是 check、pack、unpack 这三个命令共有的选项（parseOptions 的 spec 合并进各自的），checkSettings(options) 把解析结果变成 inspectTarget 的设置。
//
// checkOptions(ctx)
//   传给库的检查的选项里和验签无关的那一份：只有注入的运行环境（外部资源的核对用它的 fetch）。seal 用它，交给库内部的自检（lib/check.mjs 文件头）：
//   被封的部分此时还没签名，不验签、不做互相校验。check、pack、unpack 不用它，走 inspectTarget。
//
// inspectTarget(target, ctx, settings)
//   路径是分享文件：读字节，库的 inspectShareFile（先过 zip 这一关，再查包目录里的部分）。
//   路径是目录：读成文件集（符号链接、特殊文件、超过上限的当成问题报，不再往下查），再 checkPart。
//   settings 是 { trust?, allowUnsigned? }（checkSettings 的结果）；不给就是默认：官方名单、不放过没签名的。
//   返回 { kind, report, files, directory }：files 是读到的文件集（读不出来是 null），directory 是包目录的名字
//   （分享文件里的那个目录名；目录就是它自己的名字）。报告不通过时 files 也可能有：写不写盘由调用方决定。
//   读不了路径（不存在、没权限）抛 file_unreadable；读不了信任名单抛 file_unreadable、trust_list_invalid。
import path from 'node:path';
import { checkPart, failedReport } from '../lib/check.mjs';
import { createSignatureVerifier } from '../lib/official.mjs';
import { inspectShareFile } from '../lib/share.mjs';
import { pathKind, readDirectory } from './disk.mjs';
import { DEFAULT_TRUST_FILE, readFileBytes, readTrustListFile } from './signing.mjs';

/** check、pack、unpack 共有的选项，合并进各自 parseOptions 的 spec。 */
export const CHECK_OPTIONS = Object.freeze({ values: Object.freeze(['trust']), flags: Object.freeze(['allow-unsigned']) });
/** 写在这三个命令的 usage 里的那一段。 */
export const CHECK_USAGE = '[--trust <信任名单.json>] [--allow-unsigned]';

/** parseOptions 的结果 -> inspectTarget 的设置。 */
export function checkSettings(options) {
  return { trust: options.values.trust, allowUnsigned: options.flags.has('allow-unsigned') };
}

export function checkOptions(ctx) {
  return { env: ctx.env };
}

/**
 * 验签加互相校验的检查选项。信任名单读不出来就抛，不退回「不验」。
 * 这一处就是命令行对「验签的策略」的明确选择（lib/check.mjs 的入口不选就报错）：永远给验签函数；--allow-unsigned 再加上入口的
 * allowUnsigned: true，意思是「验签，但放过没有签名文件的部分」。
 */
function verifyingOptions(ctx, { trust, allowUnsigned = false } = {}) {
  const trustList = readTrustListFile(trust === undefined ? DEFAULT_TRUST_FILE : path.resolve(ctx.cwd, trust));
  return { ...checkOptions(ctx), mutual: true, verifySignature: createSignatureVerifier(trustList), allowUnsigned };
}

export async function inspectTarget(target, ctx, settings = {}) {
  const options = verifyingOptions(ctx, settings);
  const full = path.resolve(ctx.cwd, target);
  const kind = pathKind(full, '要检查的路径');
  if (kind === 'file') {
    const { opened, report } = await inspectShareFile(readFileBytes(full, '分享文件'), options);
    return { kind, report, files: opened?.files ?? null, directory: opened?.directory ?? null };
  }
  const { files, problems } = readDirectory(full);
  if (problems.length > 0) return { kind, report: failedReport(problems, options), files: null, directory: path.basename(full) };
  return { kind, report: await checkPart(files, options), files, directory: path.basename(full) };
}
