// SPDX-License-Identifier: Apache-2.0
//
// 包里的路径：怎么排序，哪些名字不能要。清单里的路径、zip 里的成员名、命令行读到的文件名，都过这一关。
//
// 路径的写法（格式说明见 protocol/FORMAT.md「路径」）：
//   - 一律用 `/` 分隔，相对于它所在的目录，不以 `/` 开头，也不以 `/` 结尾；
//   - 按 UTF-8 字节序排序（= 按码点排，和系统语言无关；不是 JavaScript 默认的按 UTF-16 码元排，
//     那样基本平面高位的字符和 emoji 之间的顺序是反的）。
//
// 哪些名字不能要，以及每一条的理由，写在 protocol/FORMAT.md「路径」一节（那里是正本，不在这里重抄）。
// reason 是机器可读的原因，pathProblem 和 assertPackPath 都给出它，是下面的一种：
//   not_string  empty  invalid_unicode  control_char  backslash  colon  absolute  empty_segment  dot_segment
//   parent_segment  trailing_dot_or_space  reserved_name  segment_too_long  path_too_long
//
// 错误：
//   path_unsafe   assertPackPath 抛出的。details: { path, reason }，reason 是上面的一种。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from './errors.mjs';

const MAX_SEGMENT_BYTES = 255;
const MAX_PATH_BYTES = 1024;
const encoder = new TextEncoder();

// Windows 的保留设备名（Microsoft Learn「Naming Files, Paths, and Namespaces」，2026-10-14 取回原文核对）：
// CON、PRN、AUX、NUL、COM1–COM9、LPT1–LPT9，以及把 ISO 8859-1 的上标数字 ¹ ² ³ 当作数字的 COM#、LPT#；
// 后面紧跟扩展名也一样（NUL.txt 就是 NUL）。COM0、LPT0、CONIN$、CONOUT$ 不在那一页的名单里，但同样是设备名，一并挡住。
const RESERVED_NAMES = new Set(['CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$']);
const SUPERSCRIPT_DIGITS = String.fromCharCode(0xb9, 0xb2, 0xb3);
for (const digit of [...'0123456789', ...SUPERSCRIPT_DIGITS]) {
  RESERVED_NAMES.add(`COM${digit}`);
  RESERVED_NAMES.add(`LPT${digit}`);
}

/**
 * 这个码点是不是路径里不能有的「控制」字符：控制字符、DEL 和 C1 控制字符、行分隔符和段分隔符、书写方向控制符、字节序标记。
 * 它们显示出来的名字和真实的名字不一样。清理文件名的地方（share.mjs 的 shareFileName）用同一份，不另写一套。
 * @param {number} cp 码点
 */
export function isControlChar(cp) {
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) || // DEL 和 C1 控制字符
    cp === 0x61c || // 阿拉伯字母标记
    cp === 0x200e || cp === 0x200f || // 左右书写方向标记
    cp === 0x2028 || cp === 0x2029 || // 行分隔符、段分隔符
    (cp >= 0x202a && cp <= 0x202e) || // 双向文字的嵌入和覆盖
    (cp >= 0x2066 && cp <= 0x2069) || // 双向文字的隔离
    cp === 0xfeff // 字节序标记
  );
}

const utf8Length = (text) => encoder.encode(text).length;
const problem = (reason, message) => ({ reason, message });

/**
 * 按 UTF-8 字节序比较两个字符串。
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function compareUtf8(a, b) {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

/**
 * 按 UTF-8 字节序排序，给出新数组，不改原数组。
 * @param {string[]} paths
 * @returns {string[]}
 */
export function sortUtf8(paths) {
  return paths
    .map((value) => ({ value, bytes: encoder.encode(value) }))
    .sort((p, q) => {
      const n = Math.min(p.bytes.length, q.bytes.length);
      for (let i = 0; i < n; i++) {
        if (p.bytes[i] !== q.bytes[i]) return p.bytes[i] - q.bytes[i];
      }
      return p.bytes.length - q.bytes.length;
    })
    .map((item) => item.value);
}

/**
 * 这条路径能不能要。可以就给 null，不行就给 { reason, message }。
 * @param {unknown} path
 * @returns {null | { reason: string, message: string }}
 */
export function pathProblem(path) {
  if (typeof path !== 'string') return problem('not_string', '路径必须是字符串');
  if (path === '') return problem('empty', '路径是空的');
  for (const ch of path) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) return problem('invalid_unicode', '路径里有孤立的代理码元，编码成 UTF-8 以后会变成别的字符');
    if (isControlChar(cp)) return problem('control_char', `路径里有控制字符或书写方向控制符（U+${cp.toString(16).toUpperCase().padStart(4, '0')}）`);
    if (ch === '\\') return problem('backslash', '路径里有反斜杠：Windows 把它当目录分隔符，Linux 不是，路径一律用 /');
    if (ch === ':') return problem('colon', '路径里有冒号：Windows 的盘符和备用数据流都用它');
  }
  if (path.startsWith('/')) return problem('absolute', '路径以 / 开头，是绝对路径');
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '') return problem('empty_segment', '路径里有空的一段（连着两个 /，或者以 / 结尾）');
    if (segment === '.') return problem('dot_segment', '路径里有 . 这一段');
    if (segment === '..') return problem('parent_segment', '路径里有 .. 这一段，会跳出所在的目录');
    if (segment.endsWith('.') || segment.endsWith(' ')) return problem('trailing_dot_or_space', `「${segment}」以点或空格结尾：Windows 会悄悄去掉它们，写下去的名字和读出来的不一样`);
    const stem = segment.split('.')[0].toUpperCase();
    if (RESERVED_NAMES.has(stem)) return problem('reserved_name', `「${segment}」是 Windows 的保留设备名`);
    if (utf8Length(segment) > MAX_SEGMENT_BYTES) return problem('segment_too_long', `有一段超过 ${MAX_SEGMENT_BYTES} 个 UTF-8 字节`);
  }
  if (utf8Length(path) > MAX_PATH_BYTES) return problem('path_too_long', `整条路径超过 ${MAX_PATH_BYTES} 个 UTF-8 字节`);
  return null;
}

/**
 * 路径不能要就抛 path_unsafe。
 * @param {unknown} path
 * @throws {VoicePackError} path_unsafe  details: { path, reason }
 */
export function assertPackPath(path) {
  const found = pathProblem(path);
  if (found) {
    throw new VoicePackError('path_unsafe', `路径 ${JSON.stringify(path)} 不能要：${found.message}`, {
      details: { path: typeof path === 'string' ? path : String(path), reason: found.reason },
    });
  }
}

/**
 * 在大小写不敏感、或者会把组合字符统一成同一种写法的文件系统（Windows、macOS）上，会落到同一个文件的两个名字，
 * 有同一个 key。检查一个部分的文件时，key 重复就是冲突。
 * @param {string} path
 * @returns {string}
 */
export function collisionKey(path) {
  return path.normalize('NFC').toLowerCase();
}

/**
 * 在一组文件路径里找第一处会在磁盘上互相覆盖的冲突，没有就给 null。三种：
 *   duplicate           完全重名
 *   case_collision      collisionKey 相同（大小写、Unicode 写法不同，在 Windows 和 macOS 上是同一个文件）
 *   file_dir_conflict   一个路径是文件，另一个路径又要把它当目录（a 和 a/b）
 * 给出的 path 是后出现的那个，other 是先出现的。
 * @param {string[]} paths 已经过 pathProblem 检查的文件路径（不含目录条目）
 * @returns {null | { kind: string, path: string, other: string }}
 */
export function findPathConflict(paths) {
  const files = new Map(); // collisionKey -> 先出现的路径
  const dirs = new Map(); // collisionKey -> 把它当目录用的那个路径
  for (const path of paths) {
    const key = collisionKey(path);
    if (files.has(key)) {
      const other = files.get(key);
      return { kind: other === path ? 'duplicate' : 'case_collision', path, other };
    }
    if (dirs.has(key)) return { kind: 'file_dir_conflict', path, other: dirs.get(key) };
    files.set(key, path);
    const segments = key.split('/');
    for (let i = 1; i < segments.length; i++) {
      const prefix = segments.slice(0, i).join('/');
      if (files.has(prefix)) return { kind: 'file_dir_conflict', path, other: files.get(prefix) };
      if (!dirs.has(prefix)) dirs.set(prefix, path);
    }
  }
  return null;
}
