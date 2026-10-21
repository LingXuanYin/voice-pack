// SPDX-License-Identifier: Apache-2.0
//
// keygen：生成一把 Ed25519 钥匙，或者由已有的私钥报出它的公钥。
//
//   node protocol/cli.mjs keygen --out <私钥文件>            生成一把新钥匙，私钥写进文件（PEM，PKCS8）
//   node protocol/cli.mjs keygen --key <私钥文件>            报出这把私钥的公钥和 key id
//
// 生成官方密钥和测试用的密钥，都用这个命令。私钥文件用 --out 生成时会拒绝覆盖已有的文件，权限只给自己；文件所在的目录不存在就建出来。
// 相对路径按当前目录（ctx.cwd）解，和别的命令一样。
// 输出里只有公钥、key id 和路径，绝不打印私钥。
import path from 'node:path';
import { generateSigningKey, publicKeyOf } from '../../lib/signature.mjs';
import { parseOptions, readPrivateKeyFile, writePrivateKeyFile } from '../signing.mjs';

export const summary = '生成一把 Ed25519 钥匙，或者由私钥报出公钥（官方密钥、测试密钥都用它）';
export const usage = 'keygen --out <私钥文件> | keygen --key <私钥文件>';

export async function run(args, ctx) {
  const options = parseOptions(args, { values: ['out', 'key'] });
  if (options.problem !== undefined) {
    ctx.stderr(`用法错误：${options.problem}\n用法：${usage}\n`);
    return 2;
  }
  if (options.positional.length > 0) {
    ctx.stderr(`用法错误：keygen 不认识位置参数 ${options.positional.join(' ')}\n`);
    return 2;
  }
  const { out, key } = options.values;
  if ((out === undefined) === (key === undefined)) {
    ctx.stderr('用法错误：keygen 要么用 --out 生成新钥匙，要么用 --key 报出已有私钥的公钥\n');
    return 2;
  }

  if (out !== undefined) {
    const outFile = path.resolve(ctx.cwd, out);
    const generated = await generateSigningKey();
    writePrivateKeyFile(outFile, generated.privateKey);
    if (ctx.json) {
      ctx.stdout(JSON.stringify({ keyId: generated.keyId, publicKey: generated.publicKey, privateKeyFile: outFile }) + '\n');
    } else {
      ctx.stdout(
        [
          `私钥已写入 ${outFile}（PEM，PKCS8，权限只给自己；不要提交进 git，也不要打印出来）`,
          `key id：${generated.keyId}`,
          `公钥（放进信任名单的 keys[].public_key）：${generated.publicKey}`,
          '',
          '要交给第三方用 minisign 验签名的话，把公钥写成 .pub 文件：',
          `  第一行：untrusted comment: minisign public key ${generated.keyId}`,
          `  第二行：${generated.publicKey}`,
          '',
        ].join('\n'),
      );
    }
    return 0;
  }

  const derived = await publicKeyOf(readPrivateKeyFile(path.resolve(ctx.cwd, key)));
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ keyId: derived.keyId, publicKey: derived.publicKey }) + '\n');
  } else {
    ctx.stdout([`key id：${derived.keyId}`, `公钥：${derived.publicKey}`, ''].join('\n'));
  }
  return 0;
}
