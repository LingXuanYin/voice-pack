// SPDX-License-Identifier: Apache-2.0
//
// 分享文件：把一个音色包打成一个文件，或者把它打开、检查。格式见 protocol/FORMAT.md「分享文件」。
//
//   文件名     <名字>.voicepack.zip
//   内容       普通 zip，根上依次是：
//                1 mimetype            类型标识，不压缩，作为第一项：开头的几十个字节就能认出这是音色包（EPUB 的做法，EPUB 3.3）
//                2 <目录>/             包目录：完整包和只有角色部分的，目录名是包 ID；只有基础部分的，目录名是基础部分的目录名（跟协议版本走，names.mjs 的表）
//                3 index.html          预览卡片（打包时生成，没有也行；角色部分才有：基础部分里没有声音）
//                4 README.md           写给人和 agent 的说明
//   类型标识   文件名 mimetype，内容跟协议版本走（names.mjs 的表；没有换行）。开头的字节是固定的：
//              50 4B 03 04（zip 本地头）、方法 0（存储）、文件名 mimetype 在第 30 字节、内容在第 38 字节。isShareFile、detectShareMime 只看这几十个字节，两套标识都认。
//   写的时候   同样的输入写出同样的字节（zip-write.mjs）：包目录里的文件按路径的 UTF-8 字节序排，其余按上面的次序。
//   README 和预览卡片在打包时生成，不列进清单。卡片是什么、页面上有什么、怎么保证自包含，只在 preview-card.mjs 的文件头写一份；
//   这里只管它在哪、什么时候生成：buildShareFile 默认给角色部分生成一张（options.card 给产品名和两个入口的链接，false 是不要，options.indexHtml 是用现成的）。
//
// 错误（openShareFile 抛，checkShareFile 把它们放进报告）：
//   zip 本身的问题（zip_malformed、symlink_not_allowed、path_unsafe、path_conflict、too_many_members、member_too_large、
//   total_too_large……）原样抛，见 zip-read.mjs。再加：
//   share_not_voicepack     不是音色包的分享文件。details.reason：type_file_missing（第一项不是 mimetype）、
//                           type_file_wrong（内容不是认得的类型标识）、type_file_compressed（被压缩了）
//   share_layout_invalid    根上的布局不对。details.reason：missing_pack_dir、multiple_pack_dirs、unexpected_root_file（path）、
//                           readme_missing、directory_name_mismatch（directory、expected）、part_not_shareable（协议核心不单独分享）
//   protocol_name_mismatch  类型标识或基础部分的目录名和包的协议版本对不上（checkShareFile、inspectShareFile 放进报告）。details: { item: 'media_type' | 'base_directory', protocol, path, expected, actual }，规则和 code 见 check.mjs
//
// 信任边界：checkShareFile、inspectShareFile 处理从外面来的分享文件，调用方必须明确选验签的策略（verifySignature，或者 allowUnsigned: true），
// 不选就抛 signature_policy_missing，在碰分享文件的任何字节之前；mutual 默认打开。规则见 check.mjs 的文件头。
// openShareFile 只读 zip 的容器（类型标识、布局、zip 本身的安全），不查清单、哈希、签名：它交出来的文件是没验过的。所以只有本文件引用它
// （inspectShareFile 先开容器、再检查）；别的程序要分享文件里的文件，走 inspectShareFile 的 opened.files。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError, isVoicePackError } from './errors.mjs';
import { assertFileSet, withPrefix } from './fileset.mjs';
import { writeZip, readZip } from './zip.mjs';
import { compareUtf8, pathProblem, isControlChar } from './paths.mjs';
import { checkPart, failedReport, requireSignaturePolicy } from './check.mjs';
import { readManifest, parseManifest, MANIFEST_FILE } from './manifest.mjs';
import { baseDirectoryOf, shareMimeOf, KNOWN_SHARE_MIMES, protocolMajorOfBaseDirectory } from './names.mjs';
import { PROTOCOL_VERSION } from './version.mjs';
import { resolveLimits } from './limits.mjs';
import { buildPreviewCard } from './preview-card.mjs';

export const SHARE_TYPE_FILE = 'mimetype';
export const SHARE_SUFFIX = '.voicepack.zip';
export const README_FILE = 'README.md';
export const INDEX_FILE = 'index.html';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
/** 认得的类型标识，和它们的字节（每个协议主版本一个，names.mjs 的表）。 */
const KNOWN_MIMES = KNOWN_SHARE_MIMES.map((mime) => ({ mime, bytes: encoder.encode(mime) }));
const TYPE_NAME_BYTES = encoder.encode(SHARE_TYPE_FILE);
const ROOT_FILES = new Set([SHARE_TYPE_FILE, README_FILE, INDEX_FILE]);

const fail = (code, message, details) => new VoicePackError(code, message, { details });
const same = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);

const UNSAFE_NAME_CHARS = new Set(['/', ':', '*', '?', '"', '<', '>', '|', String.fromCharCode(0x5c)]); // 0x5c 是反斜杠
const MAX_NAME_BYTES = 100; // 名字部分的上限，按 UTF-8 字节算：加上后缀也远在常见文件系统的 255 字节单段上限之内

/** 整理出文件名里的名字部分：不让用的字符换成连字符，空白折成一个空格，去掉首尾的空白、点和连字符，按字节截短；可能是空串。 */
function nameStem(text) {
  let replaced = '';
  let inRun = false;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (UNSAFE_NAME_CHARS.has(ch) || isControlChar(cp) || (cp >= 0xd800 && cp <= 0xdfff)) {
      if (!inRun) replaced += '-'; // 连着的不让用的字符，合成一个连字符
      inRun = true;
    } else {
      replaced += ch;
      inRun = false;
    }
  }
  const cleaned = replaced.replace(/\s+/g, ' ').trim().replace(/^[.\s-]+|[.\s-]+$/g, '');
  let capped = '';
  let bytes = 0;
  for (const ch of cleaned) {
    bytes += encoder.encode(ch).length;
    if (bytes > MAX_NAME_BYTES) break;
    capped += ch;
  }
  return capped.replace(/[.\s-]+$/, ''); // 截断以后，末尾可能又落在点、空格或连字符上
}

/**
 * 分享文件的文件名：<名字>.voicepack.zip。结果永远是一个合格的单个路径段（过 paths.mjs 的检查），在各个系统上都存得下来。
 * 名字里文件系统不让用的字符（/ \ : * ? " < > | 、控制字符等）换成连字符，去掉首尾的空白、点和连字符，名字部分最多 100 个 UTF-8 字节；
 * 什么都不剩就用 fallback（一般是包 ID，同样整理），还是什么都不剩就用 voicepack。
 * 第一个点之前是 Windows 的保留设备名（CON、NUL、COM1……）的，在它后面加一个连字符：con.voicepack.zip 在 Windows 上就是设备。
 */
export function shareFileName(name, fallback = 'voicepack') {
  const stem = nameStem(name) || nameStem(fallback) || 'voicepack';
  const file = `${stem}${SHARE_SUFFIX}`;
  if (pathProblem(file)?.reason !== 'reserved_name') return file;
  const head = file.split('.')[0];
  return `${head}-${file.slice(head.length)}`;
}

/**
 * 开头的几十个字节里的类型标识（不解压，不读 zip 的目录）：是音色包分享文件，就返回它的类型标识（认得的两套之一），不是就返回 null。
 * 只比字节，从不抛错（输入不是 Uint8Array 除外）。服务端发分享文件时，Content-Type 取它：跟着文件自己的那一个。
 * @param {Uint8Array} bytes 分享文件的开头（至少 30 + 8 + 标识的长度个字节；整个文件也行）
 * @returns {string | null}
 */
export function detectShareMime(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes 必须是 Uint8Array');
  const nameEnd = 30 + TYPE_NAME_BYTES.length;
  if (bytes.length < nameEnd) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = view.getUint32(0, true) === 0x04034b50 // 本地头的标记
    && view.getUint16(8, true) === 0 // 存储，不压缩
    && view.getUint16(26, true) === TYPE_NAME_BYTES.length
    && view.getUint16(28, true) === 0 // 没有额外字段，所以内容紧跟在文件名后面
    && same(bytes.subarray(30, nameEnd), TYPE_NAME_BYTES);
  if (!header) return null;
  const known = KNOWN_MIMES.find((candidate) => bytes.length >= nameEnd + candidate.bytes.length && same(bytes.subarray(nameEnd, nameEnd + candidate.bytes.length), candidate.bytes));
  return known?.mime ?? null;
}

/** 开头的几十个字节是不是音色包分享文件的样子（两套类型标识都认）。只比字节，从不抛错（输入不是 Uint8Array 除外）。 */
export const isShareFile = (bytes) => detectShareMime(bytes) !== null;

// Markdown 里的作者文字：折成一行，转义会被当成记号的字符
const md = (text) => String(text).replace(/\s+/g, ' ').trim().replace(/[\\`*_{}[\]<>#|~!]/g, '\\$&');

/**
 * 生成 README.md（写给人和 agent）：这是什么、预览卡片怎么打开、在 app 里怎么导入、在 agent 环境里怎么用。中英文各一份。
 * @param {object} manifest 角色部分或基础部分的清单
 * @param {{ fileName?: string, hasCard?: boolean }} [options] hasCard：这个分享文件里有没有预览卡片，默认有（角色部分打包时默认生成）；没有就不提它
 */
export function buildReadme(manifest, options = {}) {
  const protocol = manifest.protocol ?? PROTOCOL_VERSION;
  const baseDirectory = baseDirectoryOf(protocol); // 基础部分的目录名、类型标识都跟清单自己的协议版本走
  const fileName = options.fileName ?? shareFileName(manifest.name ?? manifest.id ?? baseDirectory);
  if (manifest.part === 'role') {
    const dir = manifest.id;
    const hasCard = options.hasCard ?? true;
    return [
      `# ${md(manifest.name)}`,
      '',
      `这是一个音色包（voice pack）：「${md(manifest.name)}」的声音。包 ID \`${dir}\`，版本 ${manifest.version}。`,
      `A voice pack: the voice "${md(manifest.name)}". Pack ID \`${dir}\`, version ${manifest.version}.`,
      '',
      '## 这个文件是什么 / What this file is',
      '',
      `\`${fileName}\` 是一个普通的 zip，可以用任何解压工具打开。里面有：`,
      '',
      `- \`${dir}/\`：音色包本体，是一个标准的 Agent Skill 目录，入口是 \`SKILL.md\``,
      `- \`mimetype\`：类型标识（zip 的第一项，不压缩），内容是 \`${shareMimeOf(protocol)}\``,
      '- `README.md`：这份说明',
      ...(hasCard ? ['- `index.html`：预览卡片，见下面'] : []),
      '',
      ...(hasCard ? [
        '## 预览卡片 / Preview card',
        '',
        '解压后双击 `index.html`，用浏览器打开：能看到名字，听一小段试听，有验证记录时还能看到还原度。这一页自带一切，不联网，不运行脚本。它在打包时生成，不在清单里，不参与检查；声音本体是上面那个目录。',
        'Unzip, then double-click `index.html` to open it in a browser: it shows the name, plays a short audition and, when there are verification records, shows the fidelity. The page carries everything it needs, does not go online and runs no scripts. It is made when the pack is made, is not listed in the manifest and takes no part in any check; the voice itself is the directory above.',
        '',
      ] : []),

      '## 在 app 里导入 / Import in an app',
      '',
      '在支持音色包的 app 里找到「导入」，选这个文件。导入时会检查每个文件和清单是否一致，不一致会说明是哪个文件。',
      'In an app that supports voice packs, find "Import" and pick this file. Every file is checked against the manifest on import; a mismatch names the file.',
      '',
      '## 在 agent 环境里使用 / Use in an agent environment',
      '',
      `1. 解压，把目录 \`${dir}/\` 放进项目的 \`.agents/skills/\`（Codex、Gemini CLI、Cursor、OpenCode 等读这里），再复制一份到 \`.claude/skills/\`（Claude Code 读这里）。目录里有基础部分（\`${baseDirectory}/\`）时，用它的放进环境命令一次做完这两步，并且先检查，命令见 \`${baseDirectory}/SKILL.md\` 的「用音色包配音和变声」一节。`,
      `2. 让 agent 读 \`${dir}/SKILL.md\`：里面写了这是谁的声音、能拿来做什么、配音指引。`,
      `3. 给台本配音：用基础部分的配音命令，命令的写法见 \`${baseDirectory}/SKILL.md\` 的「用音色包配音和变声」一节；用这个包配音要留意的，见 \`${dir}/SKILL.md\`。`,
      `4. 目录里没有 \`${baseDirectory}/\`（基础部分）时，需要先补全，见 \`${dir}/SKILL.md\` 里讲补全的那一节。`,
      '5. 检查这个包有没有被改过：在解压出来的目录里运行 `node protocol/cli.mjs check .`。',
      '',
      `1. Unzip it and put the directory into the project's \`.agents/skills/\` (read by Codex, Gemini CLI, Cursor, OpenCode and others), plus a copy in \`.claude/skills/\` (read by Claude Code). When the base part is inside (\`${baseDirectory}/\`), its install command does both and checks first; the command is written in the section "用音色包配音和变声" of \`${baseDirectory}/SKILL.md\`.`,
      `2. Ask your agent to read \`${dir}/SKILL.md\`.`,
      `3. To dub a script: use the base part's dub command; how to write it is in the section "用音色包配音和变声" of \`${baseDirectory}/SKILL.md\`. What to keep in mind when dubbing with this pack is in \`${dir}/SKILL.md\`.`,
      `4. If \`${baseDirectory}/\` (the base part) is missing, complete it first; see the section about completion in \`${dir}/SKILL.md\`.`,
      '5. To verify the pack has not been modified, run `node protocol/cli.mjs check .` inside the unzipped directory.',
      '',
    ].join('\n');
  }
  return [
    `# ${baseDirectory} 基础部分 / base part`,
    '',
    `这是音色包的基础部分（\`${baseDirectory}/\`），版本 ${manifest.version}：通用的流程、协议核心、词表、环境适配层和官方小工具，不含任何具体的声音。`,
    `The base part of voice packs (\`${baseDirectory}/\`), version ${manifest.version}: shared flows, the protocol core, vocabularies, environment adapters and official tools. It contains no voice.`,
    '',
    `\`${fileName}\` 是一个普通的 zip。解压后把 \`${baseDirectory}/\` 放进 \`.agents/skills/\`，再复制一份到 \`.claude/skills/\`；入口是 \`SKILL.md\`。`,
    'It is a plain zip. Unzip it, put the directory into `.agents/skills/` and copy it into `.claude/skills/`; the entry point is `SKILL.md`.',
    '',
  ].join('\n');
}

/** 这份包目录（Map）属于哪个目录名：角色部分是包 ID，基础部分是它的协议版本对应的基础部分目录名（names.mjs 的表）。读不出就抛 share_layout_invalid。 */
function directoryFor(manifest) {
  if (manifest.part === 'role') return manifest.id;
  if (manifest.part === 'base') return baseDirectoryOf(manifest.protocol);
  throw fail('share_layout_invalid', '协议核心不单独分享：要分享的是角色部分或基础部分', { reason: 'part_not_shareable' });
}

/** 打包时生成的预览卡片（HTML 的字节）。基础部分里没有声音，不生成；card 是 false 就是不要。 */
function generatedCard(manifest, packFiles, card) {
  if (manifest.part !== 'role' || card === false) return undefined;
  return encoder.encode(buildPreviewCard(manifest, { ...card, files: packFiles }));
}

/**
 * 把一个包（角色部分的完整文件集，或基础部分的）打成分享文件。
 * @param {Map<string, Uint8Array>} packFiles 包目录里的文件，含 manifest.json
 * @param {{ card?: false | { productName?: string, links?: { open?: string, make?: string }, audio?: object }, indexHtml?: Uint8Array, readme?: string, limits?: object }} [options]
 *   card：角色部分打包时默认生成一张预览卡片（根上的 index.html），这里给卡片的选项（产品名、两个入口的链接、试听的上限，含义见 preview-card.mjs 的 buildPreviewCard），
 *   false 是不要卡片；基础部分没有卡片。indexHtml：用现成的卡片，盖过生成的。readme：省略就按清单生成（里面提不提卡片，看这个文件里有没有卡片）
 * @returns {Uint8Array}
 * @throws {VoicePackError} manifest_invalid 等（清单不合格）、share_layout_invalid（part_not_shareable）、card_link_invalid（卡片的链接不对：不打出这个文件）、zip-write.mjs 的错误（超过上限等）
 */
export function buildShareFile(packFiles, options = {}) {
  assertFileSet(packFiles);
  const manifestBytes = packFiles.get(MANIFEST_FILE);
  if (manifestBytes === undefined) throw fail('manifest_missing', `包里没有 ${MANIFEST_FILE}：先用 sealPart 生成清单`, { path: MANIFEST_FILE });
  const manifest = parseManifest(manifestBytes, { limits: options.limits });
  const directory = directoryFor(manifest);
  const indexHtml = options.indexHtml ?? generatedCard(manifest, packFiles, options.card);
  const readme = options.readme ?? buildReadme(manifest, { hasCard: indexHtml !== undefined });
  const entries = [{ name: SHARE_TYPE_FILE, data: encoder.encode(shareMimeOf(manifest.protocol)) }]; // 类型标识跟清单自己的协议版本走
  for (const [path, data] of [...withPrefix(directory, packFiles)].sort((a, b) => compareUtf8(a[0], b[0]))) entries.push({ name: path, data });
  if (indexHtml !== undefined) entries.push({ name: INDEX_FILE, data: indexHtml });
  entries.push({ name: README_FILE, data: encoder.encode(readme) });
  return writeZip(entries, { limits: options.limits });
}

/**
 * 打开分享文件：认类型标识，认根上的布局，取出包目录里的文件。
 * 只读容器：不查清单、哈希、签名，交出来的文件是没验过的，所以只有本文件引用它；别的程序要里面的文件，走 inspectShareFile。
 * @param {Uint8Array} bytes
 * @param {{ limits?: object }} [options]
 * @returns {Promise<{ directory: string, files: Map<string, Uint8Array>, readme: string | null, indexHtml: Uint8Array | null, mime: string }>}
 *   directory 是 zip 里包目录的名字；files 是包目录里的文件（含 manifest.json），路径相对包目录；mime 是文件自己的类型标识（认得的两套之一，对不对得上包的协议版本，是 inspectShareFile 的事）
 * @throws {VoicePackError} zip 的问题（见 zip-read.mjs）、share_not_voicepack、share_layout_invalid
 */
export async function openShareFile(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes 必须是 Uint8Array');
  const limits = resolveLimits(options.limits);
  const { entries } = await readZip(bytes, { limits });

  const first = entries.reduce((best, entry) => (best === null || entry.offset < best.offset ? entry : best), null);
  if (first === null || first.name !== SHARE_TYPE_FILE) throw fail('share_not_voicepack', `不是音色包：zip 的第一项应该是 ${SHARE_TYPE_FILE}，这里是 ${first === null ? '（空的）' : JSON.stringify(first.name)}`, { reason: 'type_file_missing', first: first?.name ?? null });
  if (first.method !== 0) throw fail('share_not_voicepack', `不是音色包：${SHARE_TYPE_FILE} 必须是不压缩的，这样读开头几十个字节就能认出来`, { reason: 'type_file_compressed' });
  const known = KNOWN_MIMES.find((candidate) => same(first.data, candidate.bytes));
  if (known === undefined) throw fail('share_not_voicepack', `不是音色包：${SHARE_TYPE_FILE} 的内容应该是 ${KNOWN_SHARE_MIMES.join(' 或 ')}`, { reason: 'type_file_wrong' });

  const directories = new Set();
  const root = new Map();
  const inside = new Map();
  for (const entry of entries) {
    const slash = entry.name.indexOf('/');
    if (slash === -1) {
      if (!ROOT_FILES.has(entry.name)) throw fail('share_layout_invalid', `根上多了一个不该有的文件 ${JSON.stringify(entry.name)}：根上只有 ${[...ROOT_FILES].join('、')} 和包目录`, { reason: 'unexpected_root_file', path: entry.name });
      root.set(entry.name, entry.data);
    } else {
      directories.add(entry.name.slice(0, slash));
      inside.set(entry.name, entry.data);
    }
  }
  if (directories.size === 0) throw fail('share_layout_invalid', '根上没有包目录', { reason: 'missing_pack_dir' });
  if (directories.size > 1) throw fail('share_layout_invalid', `根上有 ${directories.size} 个目录（${[...directories].sort(compareUtf8).map((d) => JSON.stringify(d)).join('、')}），应该只有一个包目录`, { reason: 'multiple_pack_dirs', directories: [...directories].sort(compareUtf8) });
  if (!root.has(README_FILE)) throw fail('share_layout_invalid', `根上没有 ${README_FILE}`, { reason: 'readme_missing' });

  const [directory] = directories;
  const files = new Map([...inside].map(([name, data]) => [name.slice(directory.length + 1), data]));
  let readme = null;
  try { readme = decoder.decode(root.get(README_FILE)); } catch { /* README 不是 UTF-8 也不影响包本身，当作没有可读的说明 */ }
  return { directory, files, readme, indexHtml: root.get(INDEX_FILE) ?? null, mime: known.mime };
}

/**
 * 检查一个分享文件，并把打开的结果一起交出来（unpack 要先查、通过了再写盘，不想打开两遍）。
 * 信任边界上的入口：调用方要明确选验签的策略（verifySignature，或者 allowUnsigned: true），不选就抛 signature_policy_missing，
 * 在碰分享文件的任何字节之前；mutual 默认打开。规则见 check.mjs 的文件头。
 * 策略选了以后不抛错（输入不是 Uint8Array 除外）：zip 或布局的问题放进报告，那时没法再往下查，报告里只有这一条，opened 是 null。
 * @param {Uint8Array} bytes
 * @param {object} options 同 checkPart（limits、env、verifySignature、allowUnsigned、mutual）
 * @returns {Promise<{ opened: object | null, report: { ok: boolean, problems: object[], parts: object[], signatures: object[], mutual: object, directory?: string } }>}
 * @throws {VoicePackError} signature_policy_missing
 */
export async function inspectShareFile(bytes, options = {}) {
  return inspectWithPolicy(bytes, requireSignaturePolicy(options, 'inspectShareFile'));
}

async function inspectWithPolicy(bytes, options) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes 必须是 Uint8Array');
  let opened;
  try {
    opened = await openShareFile(bytes, { limits: options.limits });
  } catch (error) {
    if (!isVoicePackError(error)) throw error;
    return { opened: null, report: failedReport([{ code: error.code, message: error.message, part: '', details: { ...error.details } }], options) };
  }
  const report = await checkPart(opened.files, { ...options, part: undefined });
  report.directory = opened.directory;
  const read = opened.files.has(MANIFEST_FILE) ? readManifest(opened.files.get(MANIFEST_FILE), { limits: options.limits }) : null;
  if (read?.manifest) {
    if (read.manifest.part === 'protocol') {
      report.problems.unshift({ code: 'share_layout_invalid', message: '协议核心不单独分享：要分享的是角色部分或基础部分', part: '', details: { reason: 'part_not_shareable' } });
    } else {
      const { protocol } = read.manifest;
      const expected = directoryFor(read.manifest);
      if (opened.directory !== expected) {
        // 基础部分的包目录叫的是另一套协议的名字：名字和协议版本对不上；叫的是任何一套都不是的名字：还是布局不对
        if (read.manifest.part === 'base' && protocolMajorOfBaseDirectory(opened.directory) !== null) {
          report.problems.unshift({ code: 'protocol_name_mismatch', message: `包目录叫 ${JSON.stringify(opened.directory)}，协议 ${protocol} 里基础部分的目录叫 ${JSON.stringify(expected)}`, part: '', details: { item: 'base_directory', protocol, path: opened.directory, expected, actual: opened.directory } });
        } else {
          report.problems.unshift({ code: 'share_layout_invalid', message: `包目录叫 ${JSON.stringify(opened.directory)}，应该叫 ${JSON.stringify(expected)}（${read.manifest.part === 'role' ? '包 ID' : '基础部分的目录名'}）`, part: '', details: { reason: 'directory_name_mismatch', directory: opened.directory, expected } });
        }
      }
      const expectedMime = shareMimeOf(protocol);
      if (opened.mime !== expectedMime) {
        report.problems.unshift({ code: 'protocol_name_mismatch', message: `类型标识是 ${opened.mime}，协议 ${protocol} 的分享文件里要写 ${expectedMime}`, part: '', details: { item: 'media_type', protocol, path: SHARE_TYPE_FILE, expected: expectedMime, actual: opened.mime } });
      }
    }
  }
  report.ok = report.problems.length === 0;
  return { opened, report };
}

/**
 * 检查一个分享文件：先看它是不是合格的音色包 zip（类型标识、布局、zip 本身的安全），再按 checkPart 检查包目录里的部分。
 * 信任边界上的入口，规矩同 inspectShareFile：验签的策略不选就抛 signature_policy_missing，mutual 默认打开。
 * @param {Uint8Array} bytes
 * @param {object} options 同 checkPart（limits、env、verifySignature、allowUnsigned、mutual）
 * @returns {Promise<{ ok: boolean, problems: object[], parts: object[], signatures: object[], mutual: object, directory?: string }>} 报告，形状见 inspectShareFile
 * @throws {VoicePackError} signature_policy_missing
 */
export async function checkShareFile(bytes, options = {}) {
  return (await inspectWithPolicy(bytes, requireSignaturePolicy(options, 'checkShareFile'))).report;
}
