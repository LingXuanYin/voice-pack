// SPDX-License-Identifier: Apache-2.0
//
// verify：验一份文件的签名。默认用协议核心自带的信任名单（protocol/trust.json）：只认名单里的公钥。
//
//   node protocol/cli.mjs verify <文件> [--sig <签名文件>] [--trust <信任名单.json>]
//
// 默认的签名文件是 <文件>.minisig。--trust 只给测试和第三方用（换一份名单来验）；官方的验证不传它。相对路径按当前目录（ctx.cwd）解，和别的命令一样。
// 名单为空时一律不放行（报 trust_list_empty），不是「没有名单就不查」。
// 通过：退出 0，输出是谁签的（key id）和 trusted comment；不通过：退出 1，报 code。
import path from 'node:path';
import { SIGNATURE_SUFFIX, verifyMessage } from '../../lib/signature.mjs';
import { DEFAULT_TRUST_FILE, parseOptions, readFileBytes, readTrustListFile } from '../signing.mjs';

export const summary = 'Verify the signature of a file, accepting only public keys in the trust list (by default the one bundled with the protocol core)';
export const usage = 'verify <file> [--sig <signature-file>] [--trust <trust-list.json>]';

export async function run(args, ctx) {
  const options = parseOptions(args, { values: ['sig', 'trust'] });
  if (options.problem !== undefined) { ctx.stderr(`Usage error: ${options.problem}\nUsage: ${usage}\n`); return 2; }
  const [target, ...extra] = options.positional;
  if (target === undefined) { ctx.stderr(`Usage error: give the file to verify\nUsage: ${usage}\n`); return 2; }
  if (extra.length > 0) { ctx.stderr(`Usage error: verify takes one file at a time; the extra argument is ${extra.join(' ')}\n`); return 2; }

  const message = readFileBytes(path.resolve(ctx.cwd, target), 'file to verify');
  const signatureFile = path.resolve(ctx.cwd, options.values.sig ?? `${target}${SIGNATURE_SUFFIX}`);
  const signature = new TextDecoder('utf-8').decode(readFileBytes(signatureFile, 'signature file'));
  const trust = readTrustListFile(options.values.trust === undefined ? DEFAULT_TRUST_FILE : path.resolve(ctx.cwd, options.values.trust));
  const verified = await verifyMessage(message, signature, trust);

  if (ctx.json) {
    ctx.stdout(JSON.stringify({ file: target, keyId: verified.keyId, trustedComment: verified.trustedComment }) + '\n');
  } else {
    ctx.stdout(`Signature verified: ${target}\nkey id: ${verified.keyId}\ntrusted comment: ${verified.trustedComment}\n`);
  }
  return 0;
}
