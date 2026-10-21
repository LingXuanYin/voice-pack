// SPDX-License-Identifier: Apache-2.0
//
// 从官方地址取回官方基础部分：读版本索引、验签，再读某个版本的 zip 和它的签名，核对、验签、检查，一步一步，
// 哪一步没过就点名是哪一步，不兜底、不换别的版本。步骤照 protocol/RELEASES.md「怎么取一个版本」。
// 读索引、取 zip、核对验签这几步只在这里写一份，两个调用方各用各的入口：
//   嵌入这个库的 app 导出完整包，要「它固定用的那一版」：按版本号取（fetchOfficialVersion）。
//   补全自己读索引、按「不低于最低版本、同一个主版本」选好版本，再按条目取（readVersionIndex + fetchOfficialEntry），不再读第二遍索引。
//
//   readVersionIndex(env, trustList, options)                    读版本索引和它的签名，验签，解析
//   fetchOfficialEntry(env, trustList, entry, options)            按索引里的一个条目取那个版本的 zip，核对、验签、检查，验过才交出来；不读索引
//   fetchOfficialVersion(env, trustList, version, options)       按版本号取：读索引、找到条目，再走 fetchOfficialEntry；索引是名单外的钥匙签的，就走退路（下一段）
//   fetchOfficialVersionDirect(env, trustList, version, options) 退路：不读索引，直接取这个版本的 zip 和签名，核对、验签、检查，验过才交出来
//   isUntrustedIndexError(error)                                  readVersionIndex 抛的错是不是「索引是名单外的钥匙签的」：只有这一种可以走退路
//   verifyOfficialZip(zip, signatureText, trustList, expected)   对已经在手里的 zip 做后半截的核对（签名、内容、清单），不联网：app 缓存里的 zip 再用时走这一步
//
// 读索引：索引会被覆盖，所以读它和它的签名每次带新的 cb 参数（readPublished 的 cacheBust）：它避开的是读的一方自己的 HTTP 缓存，穿不过官方地址的 CDN
// （GitHub Pages 的 CDN 不把查询串算进缓存键，缓存十分钟；实测见 RELEASES.md「缓存」）。索引和它的签名是两个文件，各缓存各的：发布刚生效的那一阵，
// 读到「新索引配旧签名」「旧索引配新签名」（第一次发布时是新索引还没有签名）都可能，验签没过。隔 retryDelayMs 毫秒换一个新的 cb 重读一次，再不过才报错；
// 但在官方地址上换 cb 没有用，读到的多半还是缓存里的那一对，要等缓存过期（约十分钟）。签名是别的钥匙签的（signature_untrusted_key）
// 这种不是缓存造成的，不重读。版本 zip 和它的签名不可变，缓存对它们没有坏处，用原地址读。
//
// 退路（换过钥匙以后）：版本索引每发布一次就由当时的钥匙重签，所以官方换了钥匙以后，索引是新钥匙签的；换钥匙之前做的包带着的名单只有旧公钥，
// 读它就是 signature_untrusted_key。而版本 zip 和它的签名发布以后不再改，旧版本的 zip 还是旧钥匙签的，旧名单认得。所以读索引的一方
// （fetchOfficialVersion，补全）遇到 signature_untrusted_key，就不信这份索引，改成直接取自己要的那个版本的 zip（文件名照 RELEASES.md，不经索引）：
// 它的签名、里面的内容照常核对，只少了「字节数、SHA-256 要和索引里写的一样」这一步（zip 的签名已经担保了它的每个字节）。
// 要哪个版本由调用方定：app 要自己对应的那个；补全要包要求的最低版本本身（不挑索引里最高的：那一份多半是新钥匙签的，旧名单验不了）。
// 只有 signature_untrusted_key 才退；索引的别的问题（signature_invalid、signature_missing、index_invalid、读不到）都照样报错。
// 退回去以后 zip 的问题（签名不对、没有签名、取不到、内容不合格）也照样报错，不再往后退。规则和理由的正本是 RELEASES.md「私钥丢了或泄露了」，这里写程序怎么做。
//
// 错误（VoicePackError；下面是这个模块自己抛的，别的原样放过：signature_*、published_unreadable、fetch_missing、official_url_*、invalid_version、index_invalid、protocol_unsupported）：
//   official_unpublished   官方地址上还没有版本索引（404）：还没有发布过任何版本。details: { url }
//   version_unpublished    索引里没有要的版本。details: { version, available: 已发布的版本号 }，不换别的版本
//   release_invalid        取回来的这个版本不合格，details.reason 说是哪一步：
//                            zip_missing  zip 取不到（404）：索引里列了它，或者（退路）官方地址上没有这个版本的文件。details: { version, url }
//                            size         zip 的字节数和索引里写的不一样（读到比索引里写的还多就停）。details: { version, expected, actual }（读停时 actual 是 null）。
//                                         退路里没有索引可对，只有「读到比解包的总上限还多就停」这一种：expected 是 null，details.limit 是那个上限
//                            sha256       zip 的 SHA-256 和索引里写的不一样。details: { version, expected, actual }。退路里没有这一步
//                            content      zip 里的东西检查不过（含基础部分和协议核心的官方签名）。details: { version, problems }，problems 是检查报告里的问题
//                            manifest     zip 里不是基础部分，或者版本、协议版本和索引里写的对不上（退路里只核对版本）。details: { version, expected, actual, field }
//   signature_missing      版本 zip 没有签名文件，或者索引没有签名文件（重读一次以后还是没有）。details.path 是签名文件的名字
//
// 网络读取全走注入的 env.fetch（见 protocol/README.md「运行环境」）；超时、重试、读上限在 readPublished 里，readOptions 原样传给它。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError, isVoicePackError } from './errors.mjs';
import { sha256Hex } from './hash.mjs';
import { resolveLimits } from './limits.mjs';
import { officialUrlOf, officialFileUrl, baseZipName, readPublished, parseVersionIndex, VERSION_INDEX_FILE } from './releases.mjs';
import { verifyMessage, SIGNATURE_SUFFIX } from './signature.mjs';
import { createSignatureVerifier } from './official.mjs';
import { inspectShareFile } from './share.mjs';
import { parseSemver, PROTOCOL_VERSION } from './version.mjs';

const MAX_SIGNATURE_BYTES = 8 * 1024; // 一份签名文件只有四行（official.mjs 同一个数）
const RETRY_DELAY_MS = 3000;
const decoder = new TextDecoder('utf-8');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const fail = (code, message, details) => new VoicePackError(code, message, { details });
const invalid = (reason, message, details) => fail('release_invalid', message, { reason, ...details });

/** 读一个已发布的文件，读到的字节；取不到（404）给 null。 */
async function readFile(env, baseUrl, name, options) {
  const read = await readPublished(env, officialFileUrl(baseUrl, name), options);
  return read.found ? read.bytes : null;
}

/** 签名文件的文字；没有就抛 signature_missing。 */
function signatureText(bytes, name) {
  if (bytes === null) throw fail('signature_missing', `官方地址上没有签名文件 ${name}`, { path: name });
  return decoder.decode(bytes);
}

/**
 * 读官方的版本索引和它的签名，验签，解析。
 * @param {object} env 注入的运行环境，用它的 fetch
 * @param {object} trustList 信任名单（trust.json 的内容），官方地址在它的 official_url 里
 * @param {{ limits?: object, readOptions?: object, retryDelayMs?: number }} [options] readOptions 传给 readPublished；retryDelayMs 是验签没过时重读前等多久（默认 3000）
 * @returns {Promise<{ index: { protocol: string, versions: object[] }, keyId: string, url: string }>} 验过签的索引
 * @throws {VoicePackError} official_unpublished、signature_*、index_invalid、protocol_unsupported，以及 readPublished 的
 */
export async function readVersionIndex(env, trustList, options = {}) {
  const { limits: given, readOptions = {}, retryDelayMs = RETRY_DELAY_MS } = options;
  const limits = resolveLimits(given);
  const baseUrl = officialUrlOf(trustList);
  const indexName = VERSION_INDEX_FILE;
  const sigName = `${indexName}${SIGNATURE_SUFFIX}`;
  const read = { ...readOptions, cacheBust: true };

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await sleep(retryDelayMs);
    const indexBytes = await readFile(env, baseUrl, indexName, { ...read, maxBytes: limits.maxJsonBytes });
    if (indexBytes === null) throw fail('official_unpublished', `官方地址上还没有发布任何版本（没有 ${indexName}）：${officialFileUrl(baseUrl, indexName)}`, { url: officialFileUrl(baseUrl, indexName) });
    try {
      const sig = signatureText(await readFile(env, baseUrl, sigName, { ...read, maxBytes: MAX_SIGNATURE_BYTES }), sigName);
      const verified = await verifyMessage(indexBytes, sig, trustList);
      return { index: parseVersionIndex(indexBytes, { limits }), keyId: verified.keyId, url: officialFileUrl(baseUrl, indexName) };
    } catch (error) {
      // 新索引配旧签名（或还没有签名）是发布刚生效时缓存造成的暂时现象，值得重读一次；别的都不是缓存造成的
      if (isVoicePackError(error, 'signature_invalid') || isVoicePackError(error, 'signature_missing')) { lastError = error; continue; }
      throw error;
    }
  }
  throw lastError;
}

/**
 * 对一个在手里的官方基础部分 zip 做核对：它的签名、里面的东西（含基础部分和协议核心的官方签名）、它说自己是哪个版本。不联网。
 * @param {Uint8Array} zip
 * @param {string} signature zip 的签名文件的文字
 * @param {object} trustList
 * @param {{ version?: string, protocol?: string, limits?: object }} [expected] 给了 version、protocol 就核对 zip 里的基础部分是不是这一版
 * @returns {Promise<{ files: Map<string, Uint8Array>, manifest: object, keyId: string }>} files 是基础部分目录里的文件（含 manifest.json、签名、protocol/）
 * @throws {VoicePackError} signature_*、release_invalid（content、manifest）
 */
export async function verifyOfficialZip(zip, signature, trustList, expected = {}) {
  const limits = resolveLimits(expected.limits);
  const verified = await verifyMessage(zip, signature, trustList);
  const { opened, report } = await inspectShareFile(zip, { verifySignature: createSignatureVerifier(trustList), limits });
  if (!report.ok || opened === null) {
    const [first] = report.problems;
    throw invalid('content', `这个版本的基础部分检查不过：${first.message}${report.problems.length > 1 ? `（共 ${report.problems.length} 处问题）` : ''}`, { version: expected.version ?? null, problems: report.problems });
  }
  const part = report.parts.find((item) => item.part === '');
  const mismatch = (field, want, got) => invalid('manifest', `zip 里的${field === 'kind' ? '不是基础部分' : `基础部分的${field === 'version' ? '版本号和要的不一样' : '协议版本和版本索引里写的不一样'}`}（要 ${want}，实际 ${got}）`, { version: expected.version ?? null, field, expected: want, actual: got });
  if (part === undefined || part.kind !== 'base') throw mismatch('kind', 'base', part?.kind ?? '什么都没有');
  if (expected.version !== undefined && part.version !== expected.version) throw mismatch('version', expected.version, part.version);
  if (expected.protocol !== undefined && part.protocol !== expected.protocol) throw mismatch('protocol', expected.protocol, part.protocol);
  return { files: opened.files, manifest: { part: 'base', version: part.version, protocol: part.protocol }, keyId: verified.keyId };
}

/**
 * readVersionIndex 抛的错，是不是「索引是名单外的钥匙签的」（signature_untrusted_key）。这一种，也只有这一种，读索引的一方可以退回去，
 * 直接取自己要的那个版本（文件头「退路」）；别的索引问题（签名对不上、没有签名、读不懂、读不到）都不是。
 * @param {unknown} error
 */
export const isUntrustedIndexError = (error) => isVoicePackError(error, 'signature_untrusted_key');

/**
 * 取回官方基础部分的一个指定版本，验过才交出来：读索引、找到这个版本的条目，再交给 fetchOfficialEntry 取 zip。
 * 索引是名单外的钥匙签的（官方换过钥匙，这份名单还不认新钥匙），就退回去直接取这个版本（fetchOfficialVersionDirect，文件头「退路」），
 * 返回值里多一项 indexUntrusted: { keyId }，说明索引没用上、是谁签的。
 * @param {object} env 注入的运行环境，用它的 fetch
 * @param {object} trustList 信任名单
 * @param {string} version 要的版本号（语义化版本号，不带构建信息）
 * @param {{ limits?: object, readOptions?: object, retryDelayMs?: number, protocol?: string | number }} [options] 同 readVersionIndex；protocol 只在退路里用（没有索引，文件名要知道这个版本的协议版本；省略就是这一版库写的协议版本）
 * @returns {Promise<{ version: string, entry: object, files: Map<string, Uint8Array>, manifest: object, keyId: string, zip: Uint8Array, signature: string, indexUntrusted?: { keyId: string } }>} 同 fetchOfficialEntry
 * @throws {VoicePackError} 见文件头
 */
export async function fetchOfficialVersion(env, trustList, version, options = {}) {
  baseZipName(version, options.protocol); // 版本号不合格在这里就抛 invalid_version，不先去联网
  let index;
  try {
    ({ index } = await readVersionIndex(env, trustList, options));
  } catch (error) {
    if (!isUntrustedIndexError(error)) throw error;
    return { ...(await fetchOfficialVersionDirect(env, trustList, version, options)), indexUntrusted: { keyId: error.details.keyId } };
  }
  const entry = index.versions.find((item) => item.version === version);
  if (entry === undefined) {
    throw fail('version_unpublished', `官方地址上没有基础部分的 ${version} 版（已发布：${index.versions.map((item) => item.version).join('、') || '没有'}）：不换别的版本`, { version, available: index.versions.map((item) => item.version) });
  }
  return fetchOfficialEntry(env, trustList, entry, options);
}

/** 版本索引里的一项要是这个样子：不是的就是调用方的程序错误（条目该来自 readVersionIndex 验过签的索引）。 */
function assertEntry(entry) {
  const ok = entry !== null && typeof entry === 'object' && typeof entry.version === 'string' && typeof entry.protocol === 'string'
    && Number.isSafeInteger(entry.size) && entry.size >= 0 && typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256);
  if (!ok) throw new TypeError('条目必须是版本索引里的一项：{ version, protocol, size, sha256 }（来自 readVersionIndex 验过签的索引）');
}

/**
 * 读一个版本的 zip 和它的签名，核对，验过才交出来：fetchOfficialEntry 和 fetchOfficialVersionDirect 共用这一份。
 * 给了 entry（索引里的一项），字节数、SHA-256、基础部分的协议版本都对着它；没给（退路：没有可信的索引），这三样没有可对的，zip 自己的签名、里面的内容、版本号照常核对。
 */
async function downloadVersion(env, trustList, version, entry, options) {
  const { limits: given, readOptions = {} } = options;
  const limits = resolveLimits(given);
  // 文件名跟这个版本的协议主版本走（names.mjs 的表）：有索引条目就用条目自己的协议版本；退路里没有索引，由调用方说（options.protocol），省略就是这一版库写的协议版本
  const zipName = baseZipName(version, entry === null ? options.protocol ?? PROTOCOL_VERSION : entry.protocol);
  const baseUrl = officialUrlOf(trustList);
  const url = officialFileUrl(baseUrl, zipName);
  const maxBytes = entry === null ? limits.maxTotalBytes : Math.min(entry.size, limits.maxTotalBytes);
  let zip;
  try {
    zip = await readFile(env, baseUrl, zipName, { ...readOptions, maxBytes });
  } catch (error) {
    if (isVoicePackError(error, 'published_unreadable') && error.details.reason === 'too_large') {
      throw entry === null
        ? invalid('size', `${zipName} 比解包的总上限（${maxBytes} 字节）还大`, { version, expected: null, actual: null, limit: maxBytes })
        : invalid('size', `${zipName} 比版本索引里写的（${entry.size} 字节）大`, { version, expected: entry.size, actual: null });
    }
    throw error;
  }
  if (zip === null) throw invalid('zip_missing', entry === null ? `官方地址上没有 ${zipName}（404）：${url}` : `版本索引列了 ${version}，${zipName} 却取不到（404）：${url}`, { version, url });
  if (entry !== null) {
    if (zip.length !== entry.size) throw invalid('size', `${zipName} 是 ${zip.length} 字节，版本索引里写的是 ${entry.size} 字节`, { version, expected: entry.size, actual: zip.length });
    const digest = await sha256Hex(zip);
    if (digest !== entry.sha256) throw invalid('sha256', `${zipName} 的 SHA-256 和版本索引里写的不一样`, { version, expected: entry.sha256, actual: digest });
  }

  const signature = signatureText(await readFile(env, baseUrl, `${zipName}${SIGNATURE_SUFFIX}`, { ...readOptions, maxBytes: MAX_SIGNATURE_BYTES }), `${zipName}${SIGNATURE_SUFFIX}`);
  const verified = await verifyOfficialZip(zip, signature, trustList, { version, protocol: entry?.protocol, limits: given });
  return { zip, signature, verified };
}

/**
 * 按版本索引里的一个条目取回那个版本的基础部分 zip，验过才交出来：字节数、SHA-256 对着条目，zip 自己的签名，zip 里的内容，基础部分的版本和协议版本对着条目。
 * **不读索引**：条目必须来自 readVersionIndex 返回的、已经验过签的索引（补全自己读索引、自己选版本，再用这个入口取，不该再读一遍）。
 * 条目本身不核对来源，调用方给什么就核对什么：拿一个没验过的条目来，核对的就是没验过的东西。
 * @param {object} env 注入的运行环境，用它的 fetch
 * @param {object} trustList 信任名单
 * @param {{ version: string, protocol: string, size: number, sha256: string }} entry 版本索引里的一项
 * @param {{ limits?: object, readOptions?: object }} [options] readOptions 传给 readPublished
 * @returns {Promise<{ version: string, entry: object, files: Map<string, Uint8Array>, manifest: object, keyId: string, zip: Uint8Array, signature: string }>}
 *   files 是基础部分目录里的文件；zip 和 signature 是下载的原件（调用方要缓存的话存这两样，再用时走 verifyOfficialZip）
 * @throws {TypeError} 条目不是索引里的一项的样子
 * @throws {VoicePackError} invalid_version（条目的版本号不合格）、release_invalid、signature_*、published_unreadable、fetch_missing、official_url_*
 */
export async function fetchOfficialEntry(env, trustList, entry, options = {}) {
  assertEntry(entry);
  const { zip, signature, verified } = await downloadVersion(env, trustList, entry.version, entry, options);
  return { version: entry.version, entry, files: verified.files, manifest: verified.manifest, keyId: verified.keyId, zip, signature };
}

/**
 * 退路：不读索引，直接取这个版本的基础部分 zip 和它的签名，验过才交出来（文件头「退路」：索引是名单外的钥匙签的，换过钥匙以后旧名单读不了它）。
 * 和 fetchOfficialEntry 一样核对 zip 自己的签名、里面的内容（含基础部分和协议核心的官方签名）、基础部分的版本号；少的是字节数、SHA-256、协议版本
 * 要和索引里写的一样：没有可信的索引可对，而 zip 的签名已经担保了它的每个字节。协议主版本合不合，在放进包里以后对整个包做互相校验时查。
 * 返回值同 fetchOfficialEntry；entry 是由下载到的字节算出来的（{ version, protocol, size, sha256 }），不是索引里的那一项。
 * 谁能调：只在 readVersionIndex 抛了 isUntrustedIndexError 的错以后，由读索引的一方（fetchOfficialVersion、补全）来调。
 * @param {object} env 注入的运行环境，用它的 fetch
 * @param {object} trustList 信任名单
 * @param {string} version 要的版本号（语义化版本号，不带构建信息）
 * @param {{ limits?: object, readOptions?: object, protocol?: string | number }} [options] readOptions 传给 readPublished；protocol 是这个版本的协议版本（「主.次」或主版本）：文件名跟它走，没有索引可看，省略就是这一版库写的协议版本
 * @throws {VoicePackError} invalid_version、protocol_unsupported、release_invalid（zip_missing、size、content、manifest）、signature_*、published_unreadable、fetch_missing、official_url_*
 */
export async function fetchOfficialVersionDirect(env, trustList, version, options = {}) {
  const { zip, signature, verified } = await downloadVersion(env, trustList, version, null, options);
  const entry = { version, protocol: verified.manifest.protocol, size: zip.length, sha256: await sha256Hex(zip) };
  return { version, entry, files: verified.files, manifest: verified.manifest, keyId: verified.keyId, zip, signature };
}

