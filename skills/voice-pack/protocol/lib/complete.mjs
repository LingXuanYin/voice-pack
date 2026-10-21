// SPDX-License-Identifier: Apache-2.0
//
// 补全：只有角色部分的包，在环境里找不到可用的基础部分时，把官方基础部分取回来，验签，放进包里的 voice-pack/，变成完整包。
// 规则和理由的正本是 protocol/FORMAT.md 的「补全」一节，这里写程序怎么做、抛什么。
// 属于核心层：每个部分都带着它，只拿到一个角色部分也能补全；只 import 核心层，网络读取全走注入的 env.fetch，不碰文件系统
// （读目录、写目录是命令行层的事：protocol/cli/completing.mjs）。
//
//   const result = await completeRolePart(roleFiles, { trustList, env, candidates });
//
// 做的事，按这个次序：
//   1 读角色部分的清单（要求：协议主版本 requires.protocolMajor、基础部分的最低版本 requires.baseMin）。不是角色部分、读不了，在联网之前就报错
//   2 包里已经有 voice-pack/：它可用就是完整包，什么都不做（outcome: 'in_pack'）；不可用就报错，不覆盖，不去补全
//   3 环境里已有的基础部分（candidates，按给的次序）：第一个可用的就用它，不补全（outcome: 'environment'）。「可用」的三条和为什么只验清单的签名，见 base-choice.mjs 的文件头
//   4 都没有可用的：读官方地址上的版本索引（release-fetch.mjs 的 readVersionIndex：带 cb 读，先验签再信），挑「同一个主版本里、不低于最低版本、协议主版本对得上」的最高版本
//     （base-choice.mjs 的 selectBaseVersion，语义化版本的 ^最低版本），把挑中的那一项交给 fetchOfficialEntry 取 zip 和签名、核对大小和 SHA-256、验签、检查。
//     索引只读一次。读索引、取 zip、核对验签这几步只有 release-fetch.mjs 一份，补全和 app 导出完整包共用，这里不重写。
//     退路：索引是名单外的钥匙签的（signature_untrusted_key。官方换过钥匙，包里的名单只有旧公钥，认不得现在的索引），就不信它、不挑版本，
//     改取包要求的最低版本本身（fetchOfficialVersionDirect：直接取那个版本的 zip 和签名，不经索引）：版本 zip 发布以后不再重签，旧名单认得它的签名。
//     只有 signature_untrusted_key 才退，别的读索引的问题照样报错；退回去以后 zip 的任何问题也照样报错。规则和理由见 RELEASES.md「私钥丢了或泄露了」
//   5 放进 voice-pack/ 以后，对完整的包再做一次检查和互相校验（验签、每个文件对清单、外部资源、协议版本、基础部分的版本、所需能力）：通过才算补全成功（outcome: 'completed'）
// 任何一步不过都报错，不兜底，不换别的版本。库不碰文件系统，所以失败不会留下东西；写进包里的事由命令行层做（先在临时目录里做好，最后一步再挪进去）。
// 同一个环境里几个包要的版本不同：每个包补进自己的 voice-pack/，环境共用的那一份（candidates）从来不改，所以互不干扰。
//
// 选项：
//   trustList     信任名单（protocol/trust.json 的内容，含官方地址 official_url）。用正在运行的这份协议核心自带的那份，不取被补全的包里带的（SIGNATURES.md「谁用哪份公钥」）。必须给
//   env           注入的运行环境，用它的 fetch 读官方地址和角色部分的外部资源。步骤 2、3 不联网，到步骤 4 才取
//   candidates    环境里已有的基础部分，每份 { location, manifest, signature, coreManifest, coreSignature }：位置（给人看的字符串），加基础部分的清单和签名、
//                 它里面协议核心的清单和签名（字节，没有的是 null）。别的文件补全不看
//   limits        解包上限（limits.mjs）
//   readOptions   传给 readPublished 的 { attempts, backoffMs, timeoutMs }（重试几次、间隔、每次请求的时限，见 releases.mjs）
//   retryDelayMs  读版本索引时验签没过，隔多久（毫秒）换新的 cb 重读一次（release-fetch.mjs 的默认值）
//
// 结果（outcome 说怎么补的）：
//   { outcome: 'in_pack',     base: { source: 'pack', location, version, protocol, keyId }, rejected: [] }
//   { outcome: 'environment', base: { source: 'environment', location, version, protocol, keyId }, rejected: [被跳过的环境里的基础部分，见 base-choice.mjs 的 assessBasePart] }
//   { outcome: 'completed',   base: { source: 'official', version, protocol, url, size, sha256, keyId, indexUntrusted? }, files: Map<路径, Uint8Array>, rejected: [...] }
//                             files 是要放进 voice-pack/ 的文件集（路径相对基础部分的目录），已经通过了第 4、5 步；url、size、sha256 是下载的那个 zip 的，keyId 是签这个 zip 的钥匙；
//                             indexUntrusted: { keyId } 只在走了退路时有：索引是名单外的哪把钥匙签的，没有用它，version 是包要求的最低版本本身（不是索引里挑的）；
//                             走退路时没有索引可对，size、sha256、protocol 是由下载到的 zip 算出来、读出来的
//
// 抛的 code（VoicePackError）。读官方版本那几步（4）的错误是 release-fetch.mjs 的，原样抛出来（code、details 不变），加上 details.stage 点名是哪一步
// （index：读版本索引；download：取 zip 和核对，走了退路时也是这一步），文字前面加「补全不成（…）」，原错误放在 cause 里：
//   official_unpublished    官方地址上还没有发布任何版本：没有版本索引（404）。details.url
//   release_invalid         取回来的版本不合格，details.reason 说是哪一步（release-fetch.mjs 的文件头）：zip_missing、size、sha256、content、manifest
//   signature_missing / signature_invalid / signature_untrusted_key / signature_malformed……   验签没过（signature.mjs）：索引的、zip 的都是。
//                           索引的 signature_untrusted_key 不在其中：那一种走退路（stage: download 的 zip 的验签才报）
//   published_unreadable、fetch_missing、official_url_missing、official_url_invalid、index_invalid、protocol_unsupported   读官方地址出问题（releases.mjs、env.mjs）
// 补全自己抛的：
//   base_version_unavailable   版本索引读到了，但里面没有符合要求的版本（挑版本这一步，stage: select；索引里一个版本都没列也是这一种）。
//                              details: { required: { baseMin, protocolMajor, range }, available: [{ version, protocol, excluded }] }，
//                              excluded 是这个版本为什么不能选（base-choice.mjs 的 selectBaseVersion）
//   completed_pack_invalid     补全后的整个包没过检查或互相校验（stage: whole_pack）。details.problems 是检查报告里的全部问题
//   in_pack_base_unusable      包里已经有 voice-pack/，却不能用（stage: in_pack）。details: 那一份不能用的原因（base-choice.mjs 的 assessBasePart）
//   complete_not_role_part     传进来的不是角色部分。details.part 是它自己说的种类（没有 stage，没联网）
//   manifest_missing、manifest_not_json、manifest_invalid……   角色部分的清单没有、读不了、不合格（manifest.mjs，没有 stage，没联网）
// 名单、选项的类型不对是调用方写错了，抛 TypeError。
//
// fetch 的用法（protocol/README.md 要求用到它的模块自己写明）：全走 release-fetch.mjs 和 check.mjs，它们用注入的 env.fetch：
//   版本索引和它的签名读的时候带 cacheBust（地址后面加新的 cb 参数）：它们会被覆盖，前面有 CDN（缓存多久、cb 穿不穿得过 CDN，看托管，RELEASES.md「缓存」）；
//   版本 zip 和它的签名不可变，用原地址读，让缓存起作用。角色部分的外部资源由 checkPart 逐个取回来核对。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError, isVoicePackError } from './errors.mjs';
import { assertFileSet, withPrefix } from './fileset.mjs';
import { resolveLimits } from './limits.mjs';
import { parseManifest, MANIFEST_FILE } from './manifest.mjs';
import { baseDirectoryOf } from './names.mjs';
import { checkPart } from './check.mjs';
import { createSignatureVerifier } from './official.mjs';
import { readVersionIndex, fetchOfficialEntry, fetchOfficialVersionDirect, isUntrustedIndexError } from './release-fetch.mjs';
import { officialUrlOf, officialFileUrl, baseZipName } from './releases.mjs';
import { assessBasePart, inPackCandidate, selectBaseVersion, describeRejection } from './base-choice.mjs';

const STAGE_LABEL = {
  in_pack: '检查包里的基础部分',
  index: '读官方的版本索引',
  select: '挑版本',
  download: '取官方的基础部分',
  whole_pack: '检查补全后的整个包',
};

const fail = (code, stage, message, details) => new VoicePackError(code, `补全不成（${STAGE_LABEL[stage]}）：${message}`, { details: { ...details, stage } });

/** 做 work，抛出来的 VoicePackError 换成补全的：code 和 details 不变，加 details.stage 点名是哪一步，文字前面加「补全不成（…）」，原错误作为 cause。 */
async function inStage(stage, work) {
  try {
    return await work();
  } catch (error) {
    if (!isVoicePackError(error)) throw error;
    throw new VoicePackError(error.code, `补全不成（${STAGE_LABEL[stage]}）：${error.message}`, { details: { ...error.details, stage }, cause: error });
  }
}

/** 检查报告里有问题：code 是补全的，所有问题放在 details.problems，文字里写第一个。 */
function reportFailure(code, stage, report) {
  const [first] = report.problems;
  const more = report.problems.length > 1 ? `（共 ${report.problems.length} 处问题）` : '';
  return fail(code, stage, `${first.message}${more}`, { problems: report.problems });
}

const withoutVerdictFlag = ({ usable, ...rest }) => rest; // 被跳过的一项：去掉 usable: false

/**
 * 4 取官方的基础部分：读版本索引、挑版本、取这一个版本；索引是名单外的钥匙签的，就退回到包要求的最低版本本身（文件头第 4 步）。
 * @returns {Promise<{ fetched: object, entry: object, indexUntrusted?: { keyId: string } }>} fetched 是 release-fetch.mjs 交出来的，entry 是取的那个版本的 { version, protocol, size, sha256 }
 */
async function fetchOfficialBase(env, trustList, requires, fetchOptions) {
  let index;
  try {
    ({ index } = await inStage('index', () => readVersionIndex(env, trustList, fetchOptions)));
  } catch (error) {
    if (!isUntrustedIndexError(error)) throw error;
    // 官方版本号不带构建信息，构建信息又不参与版本的优先级：最低版本 1.0.0+b1 要的就是 1.0.0
    const minimum = requires.baseMin.split('+')[0];
    const fetched = await inStage('download', () => fetchOfficialVersionDirect(env, trustList, minimum, { ...fetchOptions, protocol: requires.protocolMajor }));
    return { fetched, entry: fetched.entry, indexUntrusted: { keyId: error.details.keyId } };
  }
  const { entry, considered } = selectBaseVersion(index, requires);
  if (entry === null) {
    const wanted = { baseMin: requires.baseMin, protocolMajor: requires.protocolMajor, range: `^${requires.baseMin}` };
    const have = considered.length === 0 ? '版本索引里一个版本都没有列' : `现有的版本是 ${considered.map((item) => `${item.version}（协议 ${item.protocol}）`).join('、')}`;
    throw fail('base_version_unavailable', 'select', `角色部分要的基础部分是协议主版本 ${wanted.protocolMajor}、${wanted.range}（同一个主版本里不低于 ${wanted.baseMin}），官方地址上没有符合的：${have}`, { required: wanted, available: considered });
  }
  return { fetched: await inStage('download', () => fetchOfficialEntry(env, trustList, entry, fetchOptions)), entry };
}

/**
 * 补全一个角色部分（全部流程见文件头）。
 * @param {Map<string, Uint8Array>} roleFiles 角色部分的文件集（含 manifest.json，也含它自带的 protocol/；路径相对角色部分的目录）
 * @param {{ trustList: object, env?: object, candidates?: object[], limits?: object, readOptions?: object, retryDelayMs?: number }} options
 * @returns {Promise<{ outcome: 'in_pack' | 'environment' | 'completed', base: object, rejected: object[], files?: Map<string, Uint8Array> }>}
 */
export async function completeRolePart(roleFiles, options) {
  assertFileSet(roleFiles);
  if (options === null || typeof options !== 'object') throw new TypeError('options 要是对象，至少要有 trustList');
  const { trustList, env, candidates = [], limits: given, readOptions, retryDelayMs } = options;
  if (!Array.isArray(candidates)) throw new TypeError('candidates 要是数组');
  const limits = resolveLimits(given);

  // 1 角色部分的清单：里面写了对基础部分的要求
  const manifestBytes = roleFiles.get(MANIFEST_FILE);
  if (manifestBytes === undefined) throw new VoicePackError('manifest_missing', `角色部分里没有 ${MANIFEST_FILE}：补全要先读它里面对基础部分的要求`, { details: { path: MANIFEST_FILE } });
  const role = parseManifest(manifestBytes, { limits });
  if (role.part !== 'role') throw new VoicePackError('complete_not_role_part', `补全的对象是角色部分，这份清单说它是 ${role.part}`, { details: { part: role.part } });
  const { requires } = role;
  const directory = baseDirectoryOf(role.protocol); // 基础部分放在包里的哪个目录，跟角色部分自己的协议版本走（names.mjs 的表）
  const verifySignature = createSignatureVerifier(trustList);
  const rejected = [];
  const summary = (source, verdict) => ({ source, location: verdict.location, version: verdict.version, protocol: verdict.protocol, keyId: verdict.keyId });

  // 2 包里已经有基础部分目录：它是完整包。可用就什么都不做；不可用不覆盖，也不去补全
  if ([...roleFiles.keys()].some((path) => path.startsWith(`${directory}/`))) {
    const verdict = await assessBasePart(inPackCandidate(roleFiles, role.protocol), requires, verifySignature);
    if (verdict.usable) return { outcome: 'in_pack', directory, base: summary('pack', verdict), rejected };
    throw fail('in_pack_base_unusable', 'in_pack', `${describeRejection(withoutVerdictFlag(verdict))}。不覆盖包里已有的东西：要重新补全，先把它移走`, withoutVerdictFlag(verdict));
  }

  // 3 环境里已有的基础部分：第一个可用的就用它
  for (const candidate of candidates) {
    const verdict = await assessBasePart(candidate, requires, verifySignature);
    if (verdict.usable) return { outcome: 'environment', directory, base: summary('environment', verdict), rejected };
    rejected.push(withoutVerdictFlag(verdict));
  }

  // 4 官方地址：版本索引（先验签）、挑版本、取这一个版本；索引是名单外的钥匙签的就退回到最低版本本身
  const { fetched, entry, indexUntrusted } = await fetchOfficialBase(env, trustList, requires, { limits: given, readOptions, retryDelayMs });

  // 5 补全是角色部分进环境的那一刻，放进基础部分目录以后对完整的包再检查一遍：每个文件对清单、验签、互相校验、外部资源
  const whole = new Map([...roleFiles, ...withPrefix(directory, fetched.files)]);
  const report = await checkPart(whole, { verifySignature, env, limits });
  if (!report.ok) throw reportFailure('completed_pack_invalid', 'whole_pack', report);
  if (!report.mutual.checked) throw fail('completed_pack_invalid', 'whole_pack', `基础部分放进 ${directory}/ 以后互相校验没做成（${report.mutual.reason}）：它没有落在该在的位置，补全没有成功`, { reason: 'mutual_not_checked', mutual: report.mutual, problems: [] });
  return {
    outcome: 'completed',
    directory,
    base: { source: 'official', version: entry.version, protocol: entry.protocol, url: officialFileUrl(officialUrlOf(trustList), baseZipName(entry.version, entry.protocol)), size: entry.size, sha256: entry.sha256, keyId: fetched.keyId, ...(indexUntrusted === undefined ? {} : { indexUntrusted }) },
    files: fetched.files,
    rejected,
  };
}
