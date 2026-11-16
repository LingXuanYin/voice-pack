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

export const summary = 'Generate an Ed25519 key, or report the public key of a private key (used for both the official key and test keys)';
export const usage = 'keygen --out <private key file> | keygen --key <private key file>';

export async function run(args, ctx) {
  const options = parseOptions(args, { values: ['out', 'key'] });
  if (options.problem !== undefined) {
    ctx.stderr(`Usage error: ${options.problem}\nUsage: ${usage}\n`);
    return 2;
  }
  if (options.positional.length > 0) {
    ctx.stderr(`Usage error: keygen does not take positional arguments: ${options.positional.join(' ')}\n`);
    return 2;
  }
  const { out, key } = options.values;
  if ((out === undefined) === (key === undefined)) {
    ctx.stderr('Usage error: keygen takes either --out to generate a new key or --key to report the public key of an existing private key\n');
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
          `Private key written to ${outFile} (PEM, PKCS8, readable only by you; do not commit it to git, and do not print it)`,
          `key id: ${generated.keyId}`,
          `Public key (put it in keys[].public_key of the trust list): ${generated.publicKey}`,
          '',
          'To hand the public key to a third party who verifies signatures with minisign, write it as a .pub file:',
          `  Line 1: untrusted comment: minisign public key ${generated.keyId}`,
          `  Line 2: ${generated.publicKey}`,
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
    ctx.stdout([`key id: ${derived.keyId}`, `Public key: ${derived.publicKey}`, ''].join('\n'));
  }
  return 0;
}
