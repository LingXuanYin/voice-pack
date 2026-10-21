// SPDX-License-Identifier: Apache-2.0
//
// sign：给一份文件签名，写出 minisign 格式的签名文件（发布时给基础部分清单、协议核心和发布出去的 zip 签名用）。
//
//   node protocol/cli.mjs sign <文件> --key <私钥文件> [--sig <签名文件>] [--trusted-comment <一行>]
//
// 默认写到 <文件>.minisig（minisign 的默认位置：签名文件放在被签文件旁边）；签名文件已经有就换成新的（同一份内容、同一把私钥签出的字节相同，重签没有区别）。
// 相对路径按当前目录（ctx.cwd）解，和别的命令一样；签名文件所在的目录不存在就建出来，写不了报 file_unwritable（和 pack --out 一样走 cli/disk.mjs 的 writeNewFile）。
// 私钥用 PKCS8（PEM 或 DER），路径由调用方给；私钥的值不进输出、日志、错误信息。
// trusted comment 默认写 file:<文件名>；同一份内容、同一把私钥、同一个 trusted comment 签两次，字节完全相同。
import path from 'node:path';
import { SIGNATURE_SUFFIX, signMessage } from '../../lib/signature.mjs';
import { writeNewFile } from '../disk.mjs';
import { parseOptions, readFileBytes, readPrivateKeyFile } from '../signing.mjs';

export const summary = '给一份文件签名，写出 minisign 格式的签名文件（放在被签文件旁边）';
export const usage = 'sign <文件> --key <私钥文件> [--sig <签名文件>] [--trusted-comment <一行>]';

export async function run(args, ctx) {
  const options = parseOptions(args, { values: ['key', 'sig', 'trusted-comment'] });
  if (options.problem !== undefined) { ctx.stderr(`用法错误：${options.problem}\n用法：${usage}\n`); return 2; }
  const [target, ...extra] = options.positional;
  const keyFile = options.values.key;
  if (target === undefined) { ctx.stderr(`用法错误：要指定被签的文件\n用法：${usage}\n`); return 2; }
  if (extra.length > 0) { ctx.stderr(`用法错误：一次只签一个文件，多出来的是 ${extra.join(' ')}\n`); return 2; }
  if (keyFile === undefined) { ctx.stderr(`用法错误：要用 --key 指定私钥文件\n用法：${usage}\n`); return 2; }

  const file = path.resolve(ctx.cwd, target);
  const message = readFileBytes(file, '被签的文件');
  const privateKey = readPrivateKeyFile(path.resolve(ctx.cwd, keyFile));
  const signatureFile = path.resolve(ctx.cwd, options.values.sig ?? `${target}${SIGNATURE_SUFFIX}`);
  const trustedComment = options.values['trusted-comment'] ?? `file:${path.basename(target)}`;
  const signature = await signMessage(message, privateKey, { trustedComment });
  writeNewFile(signatureFile, new TextEncoder().encode(signature), { overwrite: true });

  if (ctx.json) {
    ctx.stdout(JSON.stringify({ file, signatureFile, bytes: message.length, trustedComment }) + '\n');
  } else {
    ctx.stdout(`签好了：${signatureFile}（${message.length} 字节，trusted comment：${trustedComment}）\n`);
  }
  return 0;
}
