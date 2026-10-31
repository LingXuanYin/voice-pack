// SPDX-License-Identifier: Apache-2.0
//
// 给一个部分生成清单：列出目录里的每一个文件（路径、大小、SHA-256），写成 manifest.json。
// 清单和哈希的写法：路径用 /，按 UTF-8 字节序排序；哈希按原始字节算，不转换换行；清单列出所在目录里除它自己和它的签名以外的每一个文件，
// 子目录里另有清单的（基础部分、协议核心）交给那份清单管。所以这里算哈希前不看文件内容的任何「格式」，拿到什么字节就算什么字节。
//
// 一个部分的文件是 Map<路径, Uint8Array>，路径相对于这个部分的目录（manifest.json 在根上）。
//
// 重新生成清单会让原来的签名作废，所以返回的文件集里不带旧的签名文件（manifest.json.minisig）；要签名再签一次（用 sign 命令）。
//
// 错误：沿用 manifest.mjs 的（清单字段不合格抛 manifest_invalid 等）、paths.mjs 的 path_unsafe。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { sha256Hex } from './hash.mjs';
import { VoicePackError } from './errors.mjs';
import { assertFileSet } from './fileset.mjs';
import { compareUtf8, assertPackPath } from './paths.mjs';
import { MANIFEST_FILE, SIGNATURE_FILE, PART_KINDS, isManagedPath, foreignBaseDirectory, serializeManifest } from './manifest.mjs';
import { baseDirectoryOf, isReadableProtocol } from './names.mjs';
import { PROTOCOL_VERSION } from './version.mjs';

/** 清单里字段的规范次序：同样的内容写出同样的字节。没列在这里的字段排在后面，按名字排。 */
const KEY_ORDER = ['protocol', 'part', 'id', 'name', 'version', 'changelog', 'madeWith', 'requires', 'features', 'reference', 'holdout', 'direction', 'sampleLines', 'enhancers', 'scripts', 'runtimes', 'verification', 'designSource', 'externals', 'files'];

/** 这一个部分的清单要管的路径：不是清单、不是签名、不在交给子部分管的目录里。（定义在 manifest.mjs，这里转出来方便用。） */
export { isManagedPath };

/**
 * 列出要写进清单的文件：{ path, size, sha256 }，按路径的 UTF-8 字节序排。
 * @param {Map<string, Uint8Array>} files
 * @param {'role' | 'base' | 'protocol'} part
 * @param {string} [protocol] 这个部分的协议版本（角色部分用它定基础部分的目录名）；省略就是这一版库的协议版本
 * @throws {VoicePackError} protocol_name_mismatch（角色部分里有另一套协议的基础部分目录：不把它悄悄当成角色部分自己的文件）
 */
export async function describeFiles(files, part, givenProtocol = PROTOCOL_VERSION) {
  assertFileSet(files);
  // 协议版本写得不合格、或者这一版库读不了的：不在这里报，交给后面写清单时的检查（manifest_invalid、protocol_unsupported）；这里两套基础部分目录名都躲开
  const protocol = isReadableProtocol(givenProtocol) ? givenProtocol : undefined;
  if (!PART_KINDS.includes(part)) throw new TypeError(`part 要是 role、base、protocol 之一，收到 ${JSON.stringify(part)}`);
  if (part === 'role' && protocol !== undefined) {
    const foreign = foreignBaseDirectory(files.keys(), protocol);
    if (foreign !== null) {
      throw new VoicePackError('protocol_name_mismatch', `${foreign}/ 是基础部分的目录名，但不是协议 ${protocol} 用的名字：这个协议里基础部分叫 ${baseDirectoryOf(protocol)}。要封的是协议 ${protocol} 的角色部分，就把它改名；它是别的协议版本的包，就在 fields 里写那个协议版本`, { details: { item: 'base_directory', protocol, path: foreign, expected: baseDirectoryOf(protocol), actual: foreign } });
    }
  }
  const paths = [...files.keys()].filter((path) => isManagedPath(path, part, protocol)).sort(compareUtf8);
  for (const path of paths) assertPackPath(path);
  return Promise.all(paths.map(async (path) => ({ path, size: files.get(path).length, sha256: await sha256Hex(files.get(path)) })));
}

/**
 * 给一个部分生成 manifest.json，返回「原来的文件 + 新清单」的新文件集（不改传进来的）。
 * @param {Map<string, Uint8Array>} files 这个部分的文件。清单和签名如果已经在里面，清单被换掉，签名被去掉
 * @param {object} fields 清单里除 files 以外的字段。protocol 省略时用这一版库的协议版本；part 必须给
 * @returns {Promise<Map<string, Uint8Array>>}
 * @throws {VoicePackError} manifest_invalid（字段不合格，或语义规则不过，见 manifest.mjs）
 */
export async function sealPart(files, fields) {
  assertFileSet(files);
  if (fields === null || typeof fields !== 'object') throw new TypeError('fields 必须是对象');
  const merged = { protocol: PROTOCOL_VERSION, ...fields };
  const listed = await describeFiles(files, fields.part, merged.protocol);
  merged.files = listed;
  const known = KEY_ORDER.filter((key) => Object.hasOwn(merged, key));
  const rest = Object.keys(merged).filter((key) => !KEY_ORDER.includes(key)).sort();
  const manifest = Object.fromEntries([...known, ...rest].map((key) => [key, merged[key]]));
  const sealed = new Map(files);
  sealed.delete(SIGNATURE_FILE);
  sealed.set(MANIFEST_FILE, serializeManifest(manifest));
  return sealed;
}
