// SPDX-License-Identifier: Apache-2.0
//
// 官方版本：基础部分和协议核心只认官方签名的。这里把信任名单做成 checkPart 的验签钩子（verifySignature 选项），
// 命令行的 check、pack、unpack 和 app 都用它；签名本身的格式和验签在 signature.mjs，信任名单的写法见 protocol/SIGNATURES.md。
//
//   const verifySignature = createSignatureVerifier(trustList);
//   const report = await checkPart(files, { verifySignature });   // mutual 在 checkPart 上默认就开
//
// 信任边界上的入口（checkPart、checkShareFile、inspectShareFile）要调用方明确选验签的策略：给这里造的 verifySignature，
// 或者明确写 allowUnsigned: true；两样都不给就抛 signature_policy_missing（规则见 check.mjs 的文件头）。
// allowUnsigned 是那些入口的选项，不在这里：这里造的验签函数永远是严格的，没有签名文件的基础部分、协议核心一律 signature_missing。
// 要「验签，但放过没有签名文件的」（命令行的 --allow-unsigned），两个一起给：{ verifySignature, allowUnsigned: true }。
//
// trustList      信任名单（protocol/trust.json 的形状）。建的时候就检查，形状不对抛 trust_list_invalid，不留到验的时候。
//                用哪一份名单是调用方的事：命令行用正在运行的这份协议核心自带的 protocol/trust.json，app 用自己带的，服务端用部署的那份基础部分自带的；
//                这里不从被检查的包里取名单（包里的名单是包的作者写的，不能拿它来认包）。
//
// 钩子对每个部分怎么办（check.mjs 对每个读懂了清单的部分调一次）：
//   角色部分        不验，返回 { ok: true, skipped: 'role' }。作者身份交给社区账号；签名文件有没有、写什么，都不影响检查。
//   基础部分、协议核心   清单旁边必须有 manifest.json.minisig，是名单里某把公钥签的，签的就是这份清单的字节：
//                  通过 { ok: true, keyId }；其余 { ok: false, code, message, details }。
//                  清单对着文件的哈希，所以一份对的签名等于担保了清单列出的每一个文件；
//                  清单改了而签名没换，或者换成了别的钥匙签的，都过不了。
//
// 失败的 code：
//   signature_missing   基础部分或协议核心没有签名文件。details: { path: 应该有的签名文件的完整路径 }
//   其余是 signature.mjs 验签抛的（signature_malformed、signature_algorithm_unsupported、trust_list_empty、signature_untrusted_key、
//   signature_invalid、signature_comment_invalid、ed25519_unavailable……），含义见那里；details.path 都加上了签名文件的完整路径。
//   程序错误（不是 VoicePackError）照常抛出去，不吞。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { isVoicePackError } from './errors.mjs';
import { verifyMessage, parseTrustList } from './signature.mjs';
import { MANIFEST_FILE, SIGNATURE_FILE, partName } from './manifest.mjs';

// 一份签名文件只有四行，几百个字节（trusted comment 最长 1000 字节）。大得离谱的不去解析
const MAX_SIGNATURE_BYTES = 8 * 1024;
const decoder = new TextDecoder('utf-8');

const join = (prefix, name) => (prefix === '' ? name : `${prefix}/${name}`);

/**
 * @param {{ version: string, keys: Array<{ public_key: string }> }} trustList
 * @returns {(call: { kind: string, part: string, manifest: Uint8Array, signature: Uint8Array | null }) => Promise<object>}
 * @throws {VoicePackError} trust_list_invalid
 */
export function createSignatureVerifier(trustList) {
  // 名单在建的时候就读一份下来，以后验签用这一份：调用方之后再改手里的对象，不影响已经建好的验签函数
  const parsed = parseTrustList(trustList); // 形状不对现在就抛
  const trusted = Object.freeze({ version: parsed.version, keys: Object.freeze(parsed.keys.map((key) => Object.freeze({ public_key: key.publicKey }))) });

  return async function verifySignature({ kind, part, manifest, signature }) {
    if (kind === 'role') return { ok: true, skipped: 'role' };

    const label = partName(kind);
    const path = join(part, SIGNATURE_FILE);
    const manifestPath = join(part, MANIFEST_FILE);
    if (signature === null) {
      return { ok: false, code: 'signature_missing', message: `${label}（${manifestPath}）没有签名文件 ${path}：基础部分和协议核心只认官方签名`, details: { path } };
    }
    if (signature.length > MAX_SIGNATURE_BYTES) {
      return { ok: false, code: 'signature_malformed', message: `${path}：签名文件的格式不对（${signature.length} 字节，签名文件只有几百个字节）`, details: { path, bytes: signature.length } };
    }
    try {
      const verified = await verifyMessage(manifest, decoder.decode(signature), trusted);
      return { ok: true, keyId: verified.keyId };
    } catch (error) {
      if (!isVoicePackError(error)) throw error;
      return { ok: false, code: error.code, message: `${path}：${error.message}`, details: { ...error.details, path } };
    }
  };
}
