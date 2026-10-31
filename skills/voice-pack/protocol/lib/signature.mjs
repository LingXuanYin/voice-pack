// SPDX-License-Identifier: Apache-2.0
//
// 官方签名和验签：基础部分的清单、协议核心、以及要发布出去的 zip，都用 Ed25519 签名；
// 运行环境只认信任名单（protocol/trust.json 的形状）里的公钥签出来的东西。
//
// 签名文件的格式是 minisign 的旧模式（算法标识 `Ed`：直接对原文做 Ed25519，不预哈希），
// 第三方装一个 minisign 就能用官方公钥验官方签名。依据、格式细节、信任名单的写法见 protocol/SIGNATURES.md。
//
//   untrusted comment: <一行说明，不参与签名>
//   <base64：算法标识 2 字节 `Ed` + key id 8 字节 + 签名 64 字节，共 74 字节>
//   trusted comment: <一行说明，参与签名>
//   <base64：global signature 64 字节，对「上一行里那 64 字节签名 + trusted comment 的字节」做 Ed25519>
//
// 公钥写成 minisign 的 .pub 文件第二行那串 base64（42 字节：`Ed` + key id 8 字节 + 公钥 32 字节）。
//
// key id 只用来在信任名单里找公钥，验签仍然是对完整公钥做 Ed25519。显示时按 minisign 的写法：
// 8 个字节按小端读成一个无符号整数，写成 16 位大写十六进制。
// 本模块生成的钥匙，key id 取公钥的 SHA-256 的前 8 个字节：私钥只存 PKCS8 文件，key id 由它推得，不用另外记。
// 别人用 minisign 自己生成的钥匙，key id 是随机的，信任名单照样认。
//
// 只用平台自带的 WebCrypto，浏览器和 Node 都能跑。环境里没有 Ed25519 就抛 ed25519_unavailable，绝不静默放行。
// 私钥的值（PKCS8 字节、种子）不写进任何 message、details、cause，也不回传给调用方以外的地方。
//
// 本模块抛的 code（都是 VoicePackError，含义写在抛出处）：
//   ed25519_unavailable             运行环境没有 Ed25519
//   private_key_invalid             私钥不是 Ed25519 的 PKCS8
//   public_key_invalid              公钥读不出来（长度、算法标识、base64）。details.field 说明是哪一处
//   key_id_invalid                  key id 不是 16 位十六进制
//   comment_invalid                 签名里的注释有换行，或者太长
//   signature_malformed             签名文件的格式不对（行数、前缀、base64、长度）。details.line 是出问题的行
//   signature_algorithm_unsupported 算法标识不是 Ed。预哈希模式（ED）要 BLAKE2b-512，平台没有，单独说明
//   trust_list_invalid              信任名单的形状不对
//   trust_list_empty                信任名单里一把公钥也没有：一律不放行
//   signature_untrusted_key         签名用的钥匙不在信任名单里。details.keyId、details.trusted
//   signature_invalid               签名和这份内容对不上（内容被改过，或者签名不是给它签的）
//   signature_comment_invalid       trusted comment 和它的签名对不上
//
// 模块约定见 protocol/README.md。
import { VoicePackError } from './errors.mjs';
import { toBase64, fromBase64, fromHex, toHex } from './bytes.mjs';

const ALG = 'Ed'; // 直接对原文签名（minisign 的旧模式）
const ALG_PREHASHED = 'ED'; // 先 BLAKE2b-512 预哈希再签；WebCrypto 没有 BLAKE2b，验不了
const KEY_ID_BYTES = 8;
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const PUBLIC_KEY_BLOCK_BYTES = 2 + KEY_ID_BYTES + PUBLIC_KEY_BYTES; // 42
const SIGNATURE_BLOCK_BYTES = 2 + KEY_ID_BYTES + SIGNATURE_BYTES; // 74
const UNTRUSTED_PREFIX = 'untrusted comment: ';
const TRUSTED_PREFIX = 'trusted comment: ';
const COMMENT_MAX_BYTES = 1000; // minisign 读第一行用 1024 字节的缓冲（含前缀和换行），这里留出余量
const DEFAULT_UNTRUSTED_COMMENT = 'signature from the voice pack signing key';
const DEFAULT_TRUSTED_COMMENT = 'voice pack official signature';
const KEY_ID_RE = /^[0-9A-Fa-f]{16}$/;

/** 签名文件放在被签文件旁边，文件名是被签文件的名字加这个后缀（minisign 的默认写法）。 */
export const SIGNATURE_SUFFIX = '.minisig';

const encoder = new TextEncoder();
const ED25519 = { name: 'Ed25519' };

function assertBytes(value, what) {
  // 只收字节：字符串会悄悄换一次编码，签的就不是文件的原始字节了
  if (!(value instanceof Uint8Array)) throw new TypeError(`${what}必须是 Uint8Array（原始字节），收到 ${typeof value}`);
  return value;
}

/** 取 WebCrypto 的 subtle。环境里没有（老浏览器、非安全上下文）就抛 ed25519_unavailable。 */
function requireSubtle() {
  const subtle = typeof globalThis.crypto === 'object' && globalThis.crypto !== null ? globalThis.crypto.subtle : undefined;
  if (subtle === undefined || subtle === null) {
    throw new VoicePackError(
      'ed25519_unavailable',
      '运行环境没有 WebCrypto（crypto.subtle）：Ed25519 签名和验签都做不了。浏览器里需要安全上下文（https 或 localhost），Node 需要 16.17 以上',
    );
  }
  return subtle;
}

/** 运行时认不出 Ed25519（老浏览器：Chrome、Edge 137 以前，Firefox 129 以前，Safari 17 以前）时统一抛这个。 */
function unavailable(cause) {
  return new VoicePackError(
    'ed25519_unavailable',
    '运行环境的 crypto.subtle 认不出 Ed25519：浏览器要 Chrome/Edge 137、Firefox 129、Safari 17 以上，Node 要 16.17 以上',
    { cause },
  );
}

const isUnsupported = (error) => error?.name === 'NotSupportedError';

/** key id 的 8 个字节写成 minisign 那样的 16 位大写十六进制（按小端读）。 */
const formatKeyId = (bytes) => toHex(bytes.slice().reverse()).toUpperCase();

function parseKeyIdText(text) {
  if (typeof text !== 'string' || !KEY_ID_RE.test(text)) {
    throw new VoicePackError('key_id_invalid', `key id 必须是 16 位十六进制，收到 ${JSON.stringify(text)}`);
  }
  return fromHex(text.toLowerCase()).reverse();
}

/** 由公钥推出 key id 的 8 个字节：SHA-256 的前 8 个字节。 */
async function deriveKeyId(publicKey) {
  return new Uint8Array(await requireSubtle().digest('SHA-256', publicKey)).slice(0, KEY_ID_BYTES);
}

/** raw 公钥 + key id 写成 minisign 的 .pub 里那串 base64。 */
function publicKeyText(keyIdBytes, publicKey) {
  const block = new Uint8Array(PUBLIC_KEY_BLOCK_BYTES);
  block[0] = ALG.charCodeAt(0);
  block[1] = ALG.charCodeAt(1);
  block.set(keyIdBytes, 2);
  block.set(publicKey, 2 + KEY_ID_BYTES);
  return toBase64(block);
}

/**
 * 读 minisign 的公钥：.pub 文件第二行那串 base64；整份 .pub 的文本（第一行注释、第二行公钥）也认。
 * @param {string} text
 * @returns {{ keyId: string, publicKey: Uint8Array }} publicKey 是 raw 的 32 字节
 * @throws {VoicePackError} public_key_invalid
 */
export function parsePublicKey(text) {
  const bad = (message, details, cause) => new VoicePackError('public_key_invalid', message, { details, cause });
  if (typeof text !== 'string') throw bad('公钥必须是字符串（minisign 的 .pub 里第二行那串 base64）', { field: 'public_key' });
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  const value = lines.length >= 2 ? lines[1] : (lines[0] ?? '');
  let block;
  try {
    block = fromBase64(value);
  } catch (cause) {
    throw bad('公钥不是合法的 base64（应该是 minisign 的 .pub 里第二行那串）', { field: 'public_key' }, cause);
  }
  if (block.length !== PUBLIC_KEY_BLOCK_BYTES) {
    throw bad(`公钥应该是 ${PUBLIC_KEY_BLOCK_BYTES} 字节（算法标识 + key id + 公钥），收到 ${block.length} 字节`, { field: 'public_key', bytes: block.length });
  }
  const algorithm = String.fromCharCode(block[0], block[1]);
  if (algorithm !== ALG) {
    throw bad(`只认算法标识 ${ALG} 的公钥（Ed25519，直接对原文签名），收到 ${JSON.stringify(algorithm)}`, { field: 'public_key', algorithm });
  }
  return { keyId: formatKeyId(block.slice(2, 2 + KEY_ID_BYTES)), publicKey: block.slice(2 + KEY_ID_BYTES) };
}

/**
 * 读信任名单（protocol/trust.json 的形状；app 自己带的一份也是这个形状）并检查。
 * 名单里每一把公钥都能验签。换了密钥以后，旧公钥继续留在名单里，旧版本的签名就照样能验。
 *
 * @param {{ version: string, keys: Array<{ public_key: string, comment?: string }> }} trustList
 *   version 是「主.次」，keys 是公钥数组；其他字段（例如官方地址）这里不管，原样放过
 * @returns {{ version: string, keys: Array<{ keyId: string, publicKey: string, comment?: string }> }}
 *   publicKey 保持 minisign 的 base64 写法
 * @throws {VoicePackError} trust_list_invalid
 */
export function parseTrustList(trustList) {
  const bad = (message, details) => new VoicePackError('trust_list_invalid', message, { details });
  if (trustList === null || typeof trustList !== 'object' || Array.isArray(trustList)) {
    throw bad('信任名单必须是一个对象：{ version, keys: [...] }', { field: 'trust_list' });
  }
  if (typeof trustList.version !== 'string' || !/^\d+\.\d+$/.test(trustList.version)) {
    throw bad('信任名单要有版本号，写法是「主.次」', { field: 'version' });
  }
  if (!Array.isArray(trustList.keys)) throw bad('信任名单要有 keys 数组（可以是空的）', { field: 'keys' });
  const seen = new Set();
  const keys = trustList.keys.map((entry, index) => {
    const field = `keys[${index}].public_key`;
    if (entry === null || typeof entry !== 'object' || typeof entry.public_key !== 'string') {
      throw bad(`信任名单第 ${index + 1} 项要有 public_key（minisign 的 .pub 里那串 base64）`, { field });
    }
    let parsed;
    try {
      parsed = parsePublicKey(entry.public_key);
    } catch (cause) {
      throw bad(`信任名单第 ${index + 1} 项的 public_key 读不出来：${cause.message}`, { field });
    }
    if (seen.has(parsed.keyId)) throw bad(`信任名单里有两把 key id 相同的公钥（${parsed.keyId}），分不清该用哪把`, { field, keyId: parsed.keyId });
    seen.add(parsed.keyId);
    const key = { keyId: parsed.keyId, publicKey: publicKeyText(parseKeyIdText(parsed.keyId), parsed.publicKey) };
    if (typeof entry.comment === 'string') key.comment = entry.comment;
    return key;
  });
  return { version: trustList.version, keys };
}

/**
 * 导入 PKCS8 私钥。失败只说「私钥不对」，不回显它的内容。
 * @returns {Promise<{ key: CryptoKey, publicKey: Uint8Array }>}
 */
async function loadPrivateKey(privateKey) {
  assertBytes(privateKey, '私钥');
  const subtle = requireSubtle();
  const invalid = () => new VoicePackError('private_key_invalid', '私钥不是 Ed25519 的 PKCS8 私钥（DER 字节；PEM 文本由命令行层先转成 DER）');
  let key;
  try {
    // extractable 要为 true：只有导出 JWK 才取得到公钥（PKCS8 里的公钥是可选的，OpenSSL 生成的多半没有）
    key = await subtle.importKey('pkcs8', privateKey, ED25519, true, ['sign']);
  } catch (error) {
    throw isUnsupported(error) ? unavailable(error) : invalid();
  }
  let jwk;
  try {
    jwk = await subtle.exportKey('jwk', key);
  } catch (error) {
    throw isUnsupported(error) ? unavailable(error) : invalid();
  }
  if (typeof jwk?.x !== 'string') throw invalid();
  let publicKey;
  try {
    publicKey = fromBase64(jwk.x.replace(/-/g, '+').replace(/_/g, '/')); // JWK 用 base64url
  } catch {
    throw invalid();
  }
  if (publicKey.length !== PUBLIC_KEY_BYTES) throw invalid();
  return { key, publicKey };
}

/**
 * 生成一把签名用的钥匙。生成官方密钥、测试里生成测试密钥都用它。
 * @returns {Promise<{ privateKey: Uint8Array, publicKey: string, keyId: string }>}
 *   privateKey：PKCS8（DER）字节，由调用方写进文件，权限只给自己，别打印；
 *   publicKey：minisign 的 .pub 里那串 base64，可以放进信任名单；
 *   keyId：16 位大写十六进制
 * @throws {VoicePackError} ed25519_unavailable
 */
export async function generateSigningKey() {
  const subtle = requireSubtle();
  let pair;
  try {
    pair = await subtle.generateKey(ED25519, true, ['sign', 'verify']);
  } catch (error) {
    throw isUnsupported(error) ? unavailable(error) : error;
  }
  const privateKey = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const keyIdBytes = await deriveKeyId(raw);
  return { privateKey, publicKey: publicKeyText(keyIdBytes, raw), keyId: formatKeyId(keyIdBytes) };
}

/**
 * 由私钥推出它的公钥（minisign 写法）和 key id。官方私钥由维护者保管，放在哪里不是协议的一部分；要写进信任名单的是这里推出来的公钥。
 * @param {Uint8Array} privateKey PKCS8（DER）
 * @returns {Promise<{ publicKey: string, keyId: string }>}
 * @throws {VoicePackError} private_key_invalid、ed25519_unavailable
 */
export async function publicKeyOf(privateKey) {
  const { publicKey } = await loadPrivateKey(privateKey);
  return publicKeyFromRaw(publicKey);
}

/**
 * 把 raw 公钥（WebCrypto `exportKey('raw')` 给出的 32 字节）写成 minisign 的写法，key id 按公钥推：
 * SHA-256 的前 8 个字节。信任名单里放的是这种写法；官方公钥是以 raw 的形式交来的，用它转成名单里的那一项。
 * 同一个 raw 公钥永远得到同一个结果，所以名单里的那一项随时可以从 raw 公钥重新算出来核对。
 * @param {Uint8Array} rawPublicKey 32 字节
 * @returns {Promise<{ publicKey: string, keyId: string }>}
 * @throws {VoicePackError} public_key_invalid、ed25519_unavailable
 */
export async function publicKeyFromRaw(rawPublicKey) {
  assertBytes(rawPublicKey, '公钥');
  if (rawPublicKey.length !== PUBLIC_KEY_BYTES) {
    throw new VoicePackError('public_key_invalid', `Ed25519 的 raw 公钥是 ${PUBLIC_KEY_BYTES} 字节，收到 ${rawPublicKey.length} 字节`, { details: { field: 'public_key', bytes: rawPublicKey.length } });
  }
  const keyIdBytes = await deriveKeyId(rawPublicKey);
  return { publicKey: publicKeyText(keyIdBytes, rawPublicKey), keyId: formatKeyId(keyIdBytes) };
}

function checkComment(text, what) {
  if (typeof text !== 'string') throw new TypeError(`${what}必须是字符串`);
  if (/[\r\n]/.test(text)) throw new VoicePackError('comment_invalid', `${what}不能有换行`, { details: { comment: what } });
  const bytes = encoder.encode(text).length;
  if (bytes > COMMENT_MAX_BYTES) {
    throw new VoicePackError('comment_invalid', `${what}太长了：最多 ${COMMENT_MAX_BYTES} 字节，收到 ${bytes} 字节`, { details: { comment: what, bytes } });
  }
  if (bytes === 0) throw new VoicePackError('comment_invalid', `${what}不能是空的`, { details: { comment: what } });
  return text;
}

/** 签名 64 字节 + trusted comment 的字节，global signature 签的就是这一串。 */
function commentMessage(signature, trustedComment) {
  const comment = encoder.encode(trustedComment);
  const out = new Uint8Array(signature.length + comment.length);
  out.set(signature, 0);
  out.set(comment, signature.length);
  return out;
}

/**
 * 给一段字节签名，返回 minisign 的签名文件文本（四行，末尾有换行）。
 *
 * 同一份内容、同一把私钥、同样的 trusted comment，签两次得到的字节完全相同：Ed25519 是确定性的，
 * trusted comment 里默认不带时间戳。发布时可以先和已经发布的文件比字节，再决定要不要写。
 *
 * @param {Uint8Array} message 要签的原始字节（清单、zip……）
 * @param {Uint8Array} privateKey PKCS8（DER）私钥
 * @param {{ trustedComment?: string, untrustedComment?: string }} [options]
 *   trustedComment 参与签名，是这份签名自己的说明（命令行默认写 `file:<文件名>`）；
 *   untrustedComment 不参与签名，只是给人看
 * @returns {Promise<string>}
 * @throws {VoicePackError} private_key_invalid、comment_invalid、ed25519_unavailable
 */
export async function signMessage(message, privateKey, options = {}) {
  assertBytes(message, '要签名的内容');
  const untrusted = checkComment(options.untrustedComment ?? DEFAULT_UNTRUSTED_COMMENT, '不参与签名的说明（untrusted comment）');
  const trusted = checkComment(options.trustedComment ?? DEFAULT_TRUSTED_COMMENT, 'trusted comment');
  const { key, publicKey } = await loadPrivateKey(privateKey);
  const keyIdBytes = await deriveKeyId(publicKey);
  const subtle = requireSubtle();

  const signature = new Uint8Array(await subtle.sign(ED25519, key, message));
  const globalSignature = new Uint8Array(await subtle.sign(ED25519, key, commentMessage(signature, trusted)));

  const block = new Uint8Array(SIGNATURE_BLOCK_BYTES);
  block[0] = ALG.charCodeAt(0);
  block[1] = ALG.charCodeAt(1);
  block.set(keyIdBytes, 2);
  block.set(signature, 2 + KEY_ID_BYTES);
  return [UNTRUSTED_PREFIX + untrusted, toBase64(block), TRUSTED_PREFIX + trusted, toBase64(globalSignature), ''].join('\n');
}

/**
 * 解析 minisign 的签名文件文本。
 * @throws {VoicePackError} signature_malformed、signature_algorithm_unsupported
 */
function parseSignature(text) {
  const malformed = (message, details, cause) => new VoicePackError('signature_malformed', message, { details, cause });
  if (typeof text !== 'string') throw new TypeError(`签名文件的内容必须是字符串，收到 ${typeof text}`);
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop(); // 末尾的空行不算
  if (lines.length !== 4) {
    throw malformed(`签名文件应该是四行（untrusted comment、签名、trusted comment、它的签名），收到 ${lines.length} 行`, { lines: lines.length });
  }
  const [first, second, third, fourth] = lines;
  if (!first.startsWith(UNTRUSTED_PREFIX)) throw malformed(`签名文件第 1 行要以 ${JSON.stringify(UNTRUSTED_PREFIX)} 开头`, { line: 1 });
  if (!third.startsWith(TRUSTED_PREFIX)) throw malformed(`签名文件第 3 行要以 ${JSON.stringify(TRUSTED_PREFIX)} 开头`, { line: 3 });
  const decode = (value, line, expected) => {
    let bytes;
    try {
      bytes = fromBase64(value.trim());
    } catch (cause) {
      throw malformed(`签名文件第 ${line} 行不是合法的 base64`, { line }, cause);
    }
    if (bytes.length !== expected) throw malformed(`签名文件第 ${line} 行应该是 ${expected} 字节，收到 ${bytes.length} 字节`, { line, bytes: bytes.length });
    return bytes;
  };
  const block = decode(second, 2, SIGNATURE_BLOCK_BYTES);
  const globalSignature = decode(fourth, 4, SIGNATURE_BYTES);
  const algorithm = String.fromCharCode(block[0], block[1]);
  if (algorithm === ALG_PREHASHED) {
    throw new VoicePackError(
      'signature_algorithm_unsupported',
      `这份签名用的是预哈希模式（算法标识 ${ALG_PREHASHED}）：它要 BLAKE2b-512，WebCrypto 没有这个哈希，验不了。请用 minisign -S -l（旧模式，算法标识 ${ALG}）重新签`,
      { details: { algorithm } },
    );
  }
  if (algorithm !== ALG) {
    throw new VoicePackError('signature_algorithm_unsupported', `认不出签名的算法标识 ${JSON.stringify(algorithm)}（只认 ${ALG}）`, { details: { algorithm } });
  }
  return {
    keyId: formatKeyId(block.slice(2, 2 + KEY_ID_BYTES)),
    signature: block.slice(2 + KEY_ID_BYTES),
    globalSignature,
    trustedComment: third.slice(TRUSTED_PREFIX.length),
    untrustedComment: first.slice(UNTRUSTED_PREFIX.length),
  };
}

/**
 * 验签：内容 + 签名文件文本 + 信任名单。通过就返回是谁签的，不通过就抛错。
 *
 * 只认信任名单里的公钥：按签名里的 key id 去名单里找，找不到就是「不是官方签名」。
 * 名单为空时一律不放行。
 *
 * @param {Uint8Array} message 被签文件的原始字节
 * @param {string} signatureText 签名文件的内容
 * @param {{ version: string, keys: Array<{ public_key: string }> }} trustList 信任名单（trust.json 的形状）
 * @returns {Promise<{ keyId: string, trustedComment: string, untrustedComment: string }>}
 * @throws {VoicePackError} signature_malformed、signature_algorithm_unsupported、trust_list_invalid、trust_list_empty、
 *   signature_untrusted_key、signature_invalid、signature_comment_invalid、ed25519_unavailable
 */
export async function verifyMessage(message, signatureText, trustList) {
  assertBytes(message, '要验签的内容');
  const parsed = parseSignature(signatureText);
  const { keys } = parseTrustList(trustList);
  if (keys.length === 0) {
    throw new VoicePackError('trust_list_empty', '信任名单里一把公钥也没有，认不出官方签名，一律不放行', { details: { keyId: parsed.keyId } });
  }
  const candidate = keys.find((key) => key.keyId === parsed.keyId);
  if (candidate === undefined) {
    throw new VoicePackError(
      'signature_untrusted_key',
      `签名用的钥匙（key id ${parsed.keyId}）不在信任名单里：这不是官方签名`,
      { details: { keyId: parsed.keyId, trusted: keys.map((key) => key.keyId) } },
    );
  }
  const subtle = requireSubtle();
  let publicKey;
  try {
    publicKey = await subtle.importKey('raw', parsePublicKey(candidate.publicKey).publicKey, ED25519, false, ['verify']);
  } catch (error) {
    if (isUnsupported(error)) throw unavailable(error);
    throw new VoicePackError('public_key_invalid', `信任名单里 key id ${candidate.keyId} 的公钥读不出来`, { details: { keyId: candidate.keyId }, cause: error });
  }
  if (!(await subtle.verify(ED25519, publicKey, parsed.signature, message))) {
    throw new VoicePackError('signature_invalid', '签名和这份内容对不上：内容被改过，或者这份签名不是给它签的', { details: { keyId: parsed.keyId } });
  }
  if (!(await subtle.verify(ED25519, publicKey, parsed.globalSignature, commentMessage(parsed.signature, parsed.trustedComment)))) {
    throw new VoicePackError('signature_comment_invalid', 'trusted comment 和它的签名对不上：签名文件被改过', { details: { keyId: parsed.keyId } });
  }
  return { keyId: parsed.keyId, trustedComment: parsed.trustedComment, untrustedComment: parsed.untrustedComment };
}
