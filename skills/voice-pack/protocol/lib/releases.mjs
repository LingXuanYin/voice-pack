// SPDX-License-Identifier: Apache-2.0
//
// 官方地址上的发布布局：官方基础部分的每个版本放在哪、叫什么，有哪些版本，怎么读回来。
// 补全（取回官方基础部分）、嵌入这个库的 app 导出完整包、发布基础部分，三处都用这一份，布局只在这里定一次。
//
// 官方地址写在协议核心的信任名单 trust.json 里（字段 official_url），是一个目录。目录里平放四种文件：
//
//   <名字>-<版本>.voicepack.zip                          一个版本的基础部分（分享文件；和 pack 命令默认的文件名一致）。名字跟这个版本的协议主版本走（names.mjs 的表）
//   <名字>-<版本>.voicepack.zip.minisig                  它的签名（SIGNATURES.md）
//   index.json                                           版本索引：目前发布过哪些版本
//   index.json.minisig                                   它的签名
//
// 已发布的版本不可变：zip 和它的签名发布以后不会再改，同一个版本号永远是同样的字节。只有版本索引会随新版本更新。
// 版本索引（index.json）是 UTF-8 的 JSON，两个空格缩进、LF 换行、末尾一个换行（同样的内容写出同样的字节，签名才稳定）：
//
//   { "protocol": "1.0",
//     "versions": [ { "version": "1.0.0", "protocol": "1.0", "size": 361234, "sha256": "<64 位小写十六进制>" }, ... ] }
//
//   protocol        这份索引按哪一版协议写的（「主.次」）。主版本读不懂就不读，次版本比自己新的，不认识的字段忽略
//   versions[]      发布过的每个版本，按语义化版本号的优先级从小到大排，版本号不重复，不带构建信息（+）
//     protocol      这个版本的基础部分清单里的协议版本，补全时不用下载就能挑出协议主版本对得上的版本
//     size, sha256  这个版本的 zip 的字节数和 SHA-256（对 zip 文件的原始字节算）
//   索引由官方签名，签名在 index.json.minisig。读索引的人要先验签再信它（verifyMessage，用信任名单）。
//
// 这个模块只管布局、索引的读写、已发布文件的读取；验签是 signature.mjs 的事，打包是 share.mjs 的事，
// 挑哪个版本是补全的事。怎么发布，见 RELEASES.md「怎么发布」。
//
// 本模块抛的 code（含义写在抛出处）：
//   official_url_missing    信任名单里没有 official_url
//   official_url_invalid    官方地址或文件名不合格。details.field 说明是哪一处
//   invalid_version         官方版本号不能带构建信息（+）。别的版本号问题抛 version.mjs 的同名 code
//   index_invalid           版本索引读不了。details.reason：not_json、shape、protocol、version、size、sha256、duplicate_version、versions_unsorted、
//                           too_large（字节数超过 JSON 的上限，details: { size, limit }；或者列的版本超过 MAX_VERSIONS 个，没有 details）
//   protocol_unsupported    索引的协议主版本不是这一版认得的（同清单的同名 code）
//   release_conflict        同一个版本号已经发布了，内容却不一样。details: { version, reason }
//   published_unreadable    读已发布的文件失败（网络出错、超时、服务器答了 404 以外的失败）。details: { url, reason, status? }
//
// fetch 的用法（protocol/README.md 要求用到它的模块自己写明）：
//   readPublished 用注入的 env.fetch。每次请求带 AbortSignal 和超时（默认 30 秒），网络出错、超时、5xx、429 重试（默认共 3 次，间隔 1 秒起每次翻倍），
//   404 不重试：那是「还没发布」。别的失败（401、403……）也不重试，直接报。读响应用有上限的方式，超了就停。
//   缓存：公开文件前面有 CDN，缓存多久、读的一方换一个查询参数能不能穿过 CDN，看托管；官方地址（GitHub Pages）缓存十分钟，不把查询串算进缓存键（实测见 RELEASES.md「缓存」）。
//   版本索引会被覆盖，读它和它的签名要用 cacheBust，每次请求带一个新的 cb 查询参数，避开读的一方自己的 HTTP 缓存；不靠 Cache-Control 请求头（CDN 不理会，浏览器里还会多一次预检）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from './errors.mjs';
import { requireFetch } from './env.mjs';
import { toHex } from './bytes.mjs';
import { PROTOCOL_VERSION, parseSemver, compareSemver, parseProtocolVersion } from './version.mjs';
import { resolveLimits } from './limits.mjs';
import { releaseFilePrefixOf, isReadableProtocol, READABLE_PROTOCOLS_TEXT } from './names.mjs';
import { SHARE_SUFFIX } from './share.mjs';
import { readCapped } from './check.mjs';

export const OFFICIAL_URL_FIELD = 'official_url';
export const VERSION_INDEX_FILE = 'index.json';

const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const fail = (code, message, details, cause) => new VoicePackError(code, message, { details, ...(cause === undefined ? {} : { cause }) });

/**
 * 官方地址：https，一个目录（以 / 结尾），不带用户名口令、查询串、片段。写成什么就是什么，不做规范化。
 * @throws {VoicePackError} official_url_invalid
 */
function validateOfficialUrl(value) {
  const invalid = (why) => fail('official_url_invalid', `官方地址不合格（${why}）：${JSON.stringify(value)}`, { field: OFFICIAL_URL_FIELD, reason: why });
  if (typeof value !== 'string') throw invalid('不是字符串');
  let url;
  try { url = new URL(value); } catch { throw invalid('读不成地址'); }
  if (url.protocol !== 'https:') throw invalid('不是 https');
  if (url.username !== '' || url.password !== '') throw invalid('不能带用户名口令');
  if (value.includes('?') || value.includes('#')) throw invalid('不能带查询串或片段');
  if (!value.endsWith('/')) throw invalid('要以 / 结尾，它是一个目录');
  if (url.href !== value) throw invalid('要写成规范的样子（小写的主机名、只用 ASCII）');
  return value;
}

/**
 * 从信任名单（trust.json 解析出来的对象）里取官方地址。
 * @param {unknown} trustList
 * @returns {string} 以 / 结尾的 https 地址
 * @throws {VoicePackError} official_url_missing、official_url_invalid
 */
export function officialUrlOf(trustList) {
  const value = trustList !== null && typeof trustList === 'object' ? trustList[OFFICIAL_URL_FIELD] : undefined;
  if (value === undefined) throw fail('official_url_missing', `信任名单里没有 ${OFFICIAL_URL_FIELD}：不知道官方基础部分放在哪里`, { field: OFFICIAL_URL_FIELD });
  return validateOfficialUrl(value);
}

/**
 * 一个版本的基础部分 zip 叫什么：<名字>-<版本>.voicepack.zip。名字跟这个版本的协议主版本走（names.mjs 的表）。
 * protocol 是这个版本的协议版本：读索引、补全传索引条目自己的 protocol（同一份索引里 1.0.x 和 2.0.0 的名字不一样）；
 * 省略就是这一版库写的协议版本（PROTOCOL_VERSION），发布自己刚做的版本时用。
 * 版本号要是语义化版本号，并且不带构建信息（+）：构建信息不参与版本的优先级，两个只差构建信息的版本会得到两个名字，却算同一个版本。
 * @param {string} version
 * @param {string | number} [protocol] 「主.次」，或协议主版本
 * @throws {VoicePackError} invalid_version、protocol_unsupported（这个协议主版本这一版库读不了）
 */
export function baseZipName(version, protocol = PROTOCOL_VERSION) {
  const parsed = parseSemver(version);
  if (parsed.build.length > 0) throw fail('invalid_version', `官方版本号不能带构建信息（+）：${JSON.stringify(version)}`, { version, reason: 'build_metadata' });
  return `${releaseFilePrefixOf(protocol)}-${version}${SHARE_SUFFIX}`;
}

/**
 * 官方地址上一个文件的地址。
 * @param {string} officialUrl 官方地址（officialUrlOf 的结果）
 * @param {string} fileName 文件名，只用字母、数字、点、下划线、连字符，不含目录
 * @throws {VoicePackError} official_url_invalid
 */
export function officialFileUrl(officialUrl, fileName) {
  validateOfficialUrl(officialUrl);
  if (typeof fileName !== 'string' || !FILE_NAME_RE.test(fileName)) throw fail('official_url_invalid', `文件名不合格：${JSON.stringify(fileName)}`, { field: 'file_name', reason: 'file_name' });
  return `${officialUrl}${fileName}`;
}

// ---------------------------------------------------------------- 版本索引

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_VERSIONS = 10000; // 一份索引最多列这么多个版本：恶意的索引撑不爆内存
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

const indexProblem = (reason, message, extra = {}) => fail('index_invalid', `版本索引不合格：${message}`, { reason, ...extra });
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 索引里一项的检查；返回只含已知字段的新对象。 */
function checkEntry(value, where) {
  if (!isObject(value)) throw indexProblem('shape', `${where} 不是对象`);
  const { version, protocol, size, sha256 } = value;
  let parsed = null;
  try { parsed = parseSemver(version); } catch { /* 下面统一报 */ }
  if (parsed === null || parsed.build.length > 0) throw indexProblem('version', `${where} 的版本号要是不带构建信息（+）的语义化版本号，这里是 ${JSON.stringify(version)}`, { version });
  try { parseProtocolVersion(protocol); } catch { throw indexProblem('protocol', `${where} 的协议版本要写成「主.次」，这里是 ${JSON.stringify(protocol)}`, { version }); }
  if (!Number.isSafeInteger(size) || size < 0) throw indexProblem('size', `${where} 的 size 要是非负整数，这里是 ${JSON.stringify(size)}`, { version });
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) throw indexProblem('sha256', `${where} 的 sha256 要写成 64 位小写十六进制`, { version });
  return { version, protocol, size, sha256 };
}

/** 索引的检查：协议版本、每一项、不重复、从小到大排。返回只含已知字段的新对象。 */
function checkIndex(value) {
  if (!isObject(value)) throw indexProblem('shape', '根上要是一个对象');
  let major;
  try { major = parseProtocolVersion(value.protocol).major; } catch { throw indexProblem('protocol', `protocol 要写成「主.次」，这里是 ${JSON.stringify(value.protocol)}`); }
  if (!isReadableProtocol(major)) throw fail('protocol_unsupported', `版本索引的协议主版本是 ${major}，这一版只认得 ${READABLE_PROTOCOLS_TEXT}`, { protocol: value.protocol, supported: READABLE_PROTOCOLS_TEXT });
  if (!Array.isArray(value.versions)) throw indexProblem('shape', 'versions 要是数组');
  if (value.versions.length > MAX_VERSIONS) throw indexProblem('too_large', `列了 ${value.versions.length} 个版本，上限 ${MAX_VERSIONS}`);
  const versions = value.versions.map((item, i) => checkEntry(item, `versions[${i}]`));
  for (let i = 1; i < versions.length; i++) {
    const order = compareSemver(versions[i - 1].version, versions[i].version);
    if (order === 0) throw indexProblem('duplicate_version', `版本 ${versions[i].version} 列了不止一次`, { version: versions[i].version });
    if (order > 0) throw indexProblem('versions_unsorted', `${versions[i - 1].version} 排在 ${versions[i].version} 前面：要按版本号从小到大排`, { version: versions[i].version });
  }
  return { protocol: value.protocol, versions };
}

/**
 * 读版本索引。读之前先验签（signature.mjs 的 verifyMessage，对着这份字节）：这里只管内容合不合格，不管是不是官方签的。
 * @param {Uint8Array} bytes index.json 的原始字节
 * @param {{ limits?: object }} [options]
 * @returns {{ protocol: string, versions: { version: string, protocol: string, size: number, sha256: string }[] }}
 * @throws {VoicePackError} index_invalid、protocol_unsupported
 */
export function parseVersionIndex(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes 必须是 Uint8Array');
  const { maxJsonBytes } = resolveLimits(options.limits);
  if (bytes.length > maxJsonBytes) throw indexProblem('too_large', `${bytes.length} 字节，超过 JSON 的上限 ${maxJsonBytes} 字节`, { size: bytes.length, limit: maxJsonBytes });
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw indexProblem('not_json', '不能带字节序标记');
  let value;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch (cause) {
    throw fail('index_invalid', '版本索引不合格：不是合法的 UTF-8 JSON', { reason: 'not_json' }, cause);
  }
  return checkIndex(value);
}

/**
 * 把版本索引写成字节：两个空格缩进、LF、末尾一个换行，键和每一项的字段按固定的次序。写之前同样检查。
 * @throws {VoicePackError} index_invalid、protocol_unsupported
 */
export function serializeVersionIndex(index) {
  return encoder.encode(`${JSON.stringify(checkIndex(index), null, 2)}\n`);
}

/**
 * 往索引里加一个版本，返回新的索引（不改传进来的）。
 * 已经有这个版本、内容一样：什么都不变（added 是 false），部署重跑就是这样；内容不一样：已发布的版本不可变，抛 release_conflict。
 * @param {object | null} index 现有的索引；第一次发布时传 null
 * @param {{ version: string, protocol: string, size: number, sha256: string }} newEntry
 * @returns {{ index: object, added: boolean }}
 * @throws {VoicePackError} index_invalid、protocol_unsupported、release_conflict
 */
export function addVersionToIndex(index, newEntry) {
  const current = checkIndex(index ?? { protocol: PROTOCOL_VERSION, versions: [] });
  const added = checkEntry(newEntry, '新的版本');
  const existing = current.versions.find((item) => item.version === added.version);
  if (existing !== undefined) {
    if (existing.protocol === added.protocol && existing.size === added.size && existing.sha256 === added.sha256) return { index: current, added: false };
    throw fail('release_conflict', `版本 ${added.version} 已经发布过了，内容却不一样：已发布的版本不可变，改了内容就要换版本号`, { version: added.version, reason: 'index_entry_differs', published: existing, new: added });
  }
  const versions = [...current.versions, added].sort((a, b) => compareSemver(a.version, b.version));
  return { index: { protocol: PROTOCOL_VERSION, versions }, added: true }; // 加了版本，索引就是这一版库重写的：写它自己的协议版本，不照抄老索引的
}

// ---------------------------------------------------------------- 读已发布的文件

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const unreadable = (url, reason, message, extra = {}, cause) => fail('published_unreadable', `读不了 ${url}：${message}`, { url, reason, ...extra }, cause);

/** 避开缓存用的查询参数：每次请求带一个新的随机值，读的一方自己的 HTTP 缓存把它当成另一个条目，源站不看它。CDN 算不算它是另一个缓存条目，看托管（RELEASES.md「缓存」）。 */
export const CACHE_BUST_PARAM = 'cb';

function bustCache(url) {
  const busted = new URL(url);
  busted.searchParams.set(CACHE_BUST_PARAM, toHex(globalThis.crypto.getRandomValues(new Uint8Array(8))));
  return busted.href;
}

/**
 * 请求一次。返回 { kind: 'found', bytes } | { kind: 'absent' } | { kind: 'retry', error } | { kind: 'fatal', error }；不抛错。
 * url 是给人看的地址（报错里写它），requestUrl 是真正请求的地址。
 */
async function requestOnce(doFetch, url, requestUrl, { headers, maxBytes, timeoutMs }) {
  const controller = new AbortController();
  let timer;
  const work = (async () => {
    const response = await doFetch(requestUrl, { signal: controller.signal, ...(headers === undefined ? {} : { headers }) });
    const status = response?.status ?? null;
    if (status === 404) return { kind: 'absent' };
    if (response?.ok !== true) {
      const error = unreadable(url, 'status', `服务器返回 ${status ?? '（没有响应）'}`, { status });
      return { kind: status === null || status >= 500 || status === 429 ? 'retry' : 'fatal', error };
    }
    const read = await readCapped(response, maxBytes);
    if (read.tooLarge) return { kind: 'fatal', error: unreadable(url, 'too_large', `比上限 ${maxBytes} 字节大`, { limit: maxBytes }) };
    return { kind: 'found', bytes: read.bytes };
  })().catch((cause) => ({ kind: 'retry', error: unreadable(url, 'network', `网络出错（${cause?.message ?? cause}）`, {}, cause) }));
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: 'retry', error: unreadable(url, 'timeout', `${timeoutMs} 毫秒内没有读完`, { timeoutMs }) });
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读官方地址上已发布的一个文件。
 * @param {object} env 注入的运行环境，用它的 fetch
 * @param {string} url 文件的地址（officialFileUrl 的结果）
 * @param {{ maxBytes?: number, timeoutMs?: number, attempts?: number, backoffMs?: number, headers?: Record<string, string>, cacheBust?: boolean }} [options]
 *   maxBytes 读到多少字节就算太大（默认是单个成员的上限）；timeoutMs 每次请求的时限（默认 30000）；attempts 最多试几次（默认 3）；
 *   backoffMs 第一次重试前等多久，之后每次翻倍（默认 1000）；headers 额外的请求头（默认没有：浏览器跨域读公开文件时，自定义头会触发预检）；
 *   cacheBust 每次请求在地址后面加一个 cb 查询参数（值是新的随机数），避开读的一方自己的 HTTP 缓存；穿不穿得过 CDN 看托管（官方地址的 CDN 不把查询串算进缓存键，穿不过，
 *   RELEASES.md「缓存」）。读版本索引时要用：它会被覆盖。版本 zip 和它的签名不可变，不用（用了每次都回源站，缓存白设了）。报错里写的地址不带 cb
 * @returns {Promise<{ found: false } | { found: true, bytes: Uint8Array }>} 404 是 { found: false }：还没发布
 * @throws {VoicePackError} fetch_missing；published_unreadable（读不出来：重试用完了，或者遇到不重试的失败，或者太大）
 */
export async function readPublished(env, url, options = {}) {
  const doFetch = requireFetch(env);
  const { maxBytes = resolveLimits().maxMemberBytes, timeoutMs = 30000, attempts = 3, backoffMs = 1000, headers, cacheBust = false } = options;
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1 && backoffMs > 0) await sleep(backoffMs * 2 ** (attempt - 2));
    const outcome = await requestOnce(doFetch, url, cacheBust ? bustCache(url) : url, { headers, maxBytes, timeoutMs });
    if (outcome.kind === 'found') return { found: true, bytes: outcome.bytes };
    if (outcome.kind === 'absent') return { found: false };
    last = outcome.error;
    if (outcome.kind === 'fatal') throw last;
  }
  throw fail(last.code, last.message, { ...last.details, attempts }, last.cause);
}
