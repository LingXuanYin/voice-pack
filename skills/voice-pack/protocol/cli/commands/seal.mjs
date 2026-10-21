// SPDX-License-Identifier: Apache-2.0
//
// seal：给一个部分的目录生成清单 manifest.json（列出里面每个文件的路径、大小、SHA-256）。
// 做包、发版本的最后一步前先 seal，再 pack。
//
//   node protocol/cli.mjs seal <部分目录> --part <role|base|protocol> [--version <x.y.z>] [--fields <描述.json>]
//                              [--short-name <英文短名>] [--text-language <zh|en>] [--json]
//
// 清单里除 files 以外的字段，按这个次序取，后面的盖掉前面的：
//   1. 目录里已有的清单（同一种部分才算）：重新 seal 就是刷新文件列表和哈希，包 ID、版本这些原样沿用；
//   2. --fields 指的 JSON 文件（字段见 protocol/FORMAT.md「清单」）；
//   3. --part、--version。
//   protocol  协议核心：--version 就够了（protocol 字段省略就用这一版库的协议版本）。
//   base      基础部分：同上。里面嵌着的 protocol/ 要先 seal。
//   role      角色部分：第一次 seal 时 --fields 要给全（名字、版本、变更说明、做包时用的基础部分版本、对基础部分的要求、功能、参考集……）。
//             包 ID 不给、目录里也没有旧清单，就现生成：英文短名取 --fields 里的 shortName 或 --short-name，都没有就用 vp。
//             目录里没有 SKILL.md 就生成骨架（frontmatter 合规，六节：谁的声音、能拿来做什么、需要哪个版本的基础部分、
//             没有基础部分时怎么补全、怎么做新包、配音指引），写进目录；有就原样留着。
//             骨架的语言跟着调用方给的 --text-language（zh 或 en），不给就是中文：这个命令行只有一种语言的说明，
//             所以语言是调用方说了算，不看环境变量或系统语言。只管生成的骨架；目录里已有 SKILL.md 时用不上，值写错了照样报用法错误。
//             「## 配音指引」这一行两种语言都原样写，规则见 protocol/FORMAT.md「骨架的语言」。
//             里面嵌着的 protocol/（和 voice-pack/）要先 seal。
//
// 先在内存里生成并检查（清单对文件、SKILL.md、音频、外部资源，和 check 命令的一样；不验签、不做互相校验：被封的部分此时还没有签名，
// 用的是库的 selfCheckPart），都通过了才写盘。检查不过：什么都不写，报告写到标准输出。
// 写的只有三样：manifest.json（清单每次重新生成，旧的被换掉）、没有 SKILL.md 时生成的 SKILL.md、
// 以及清单旁边那份已经作废的签名（manifest.json.minisig：清单变了，旧签名就对不上了，留着只会误导，所以删掉；要签名就再签一次）。
// 目录里的其他文件一概不动。
//
// 退出码：0 生成了；1 检查不过、描述文件有问题、读写失败；2 用法错误。
// 错误（退出 1，报告里是 code）：
//   fields_invalid   --fields 指的文件不是合法的 UTF-8 JSON，或者内容不是一个 JSON 对象。details: { file }
//   manifest_invalid 描述里的字段不合格，含类型不对（features 写成了字符串之类）和嵌套太深；details.problems 是完整的问题清单。什么都不写
//   file_unreadable  读不了目录或 --fields 的文件（cli/disk.mjs、cli/signing.mjs）
//   还有 cli/disk.mjs 的 file_unwritable。检查不过的不是错误：报告写到标准输出，退出 1。
// --json：成功时输出 { directory, part, files, skillMd: 'generated' | 'kept' | null, id?, signatureRemoved }；检查不过时输出整份报告。
import fs from 'node:fs';
import path from 'node:path';
import { VoicePackError } from '../../lib/errors.mjs';
import { sealPart } from '../../lib/seal.mjs';
import { selfCheckPart, failedReport } from '../../lib/check.mjs';
import { createPackId } from '../../lib/pack.mjs';
import { buildRoleSkillMd, TEXT_LANGUAGES } from '../../lib/skill-md.mjs';
import { MANIFEST_FILE, SIGNATURE_FILE, PART_KINDS, readManifest } from '../../lib/manifest.mjs';
import { checkOptions } from '../checking.mjs';
import { readDirectory, writeNewFile, pathKind } from '../disk.mjs';
import { parseOptions, readFileBytes } from '../signing.mjs';
import { formatReport, partTitle } from '../report.mjs';

export const summary = '给一个部分的目录生成清单 manifest.json（先检查，通过了才写；角色部分没有 SKILL.md 时生成骨架）';
export const usage = 'seal <部分目录> --part <role|base|protocol> [--version <x.y.z>] [--fields <描述.json>] [--short-name <英文短名>] [--text-language <zh|en>] [--json]';

const SKILL_FILE = 'SKILL.md';

/** 读 --fields 指的 JSON 文件：要是一个对象。 */
function readFields(file) {
  const bytes = readFileBytes(file, '描述文件');
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new VoicePackError('fields_invalid', `描述文件不是合法的 UTF-8 JSON：${file}`, { details: { file: String(file) }, cause });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new VoicePackError('fields_invalid', `描述文件的内容要是一个 JSON 对象：${file}`, { details: { file: String(file) } });
  return value;
}

export async function run(args, ctx) {
  const options = parseOptions(args, { values: ['part', 'version', 'fields', 'short-name', 'text-language'] });
  if (options.problem !== undefined) { ctx.stderr(`用法错误：${options.problem}\n用法：${usage}\n`); return 2; }
  const [target, ...extra] = options.positional;
  if (target === undefined) { ctx.stderr(`用法错误：要指定部分的目录\n用法：${usage}\n`); return 2; }
  if (extra.length > 0) { ctx.stderr(`用法错误：一次只 seal 一个，多出来的是 ${extra.join(' ')}\n用法：${usage}\n`); return 2; }
  const part = options.values.part;
  if (part === undefined || !PART_KINDS.includes(part)) { ctx.stderr(`用法错误：--part 要给 ${PART_KINDS.join('、')} 之一${part === undefined ? '' : `，收到 ${JSON.stringify(part)}`}\n用法：${usage}\n`); return 2; }
  const textLanguage = options.values['text-language'];
  if (textLanguage !== undefined && !TEXT_LANGUAGES.includes(textLanguage)) { ctx.stderr(`用法错误：--text-language 要给 ${TEXT_LANGUAGES.join('、')} 之一（生成的 SKILL.md 骨架用的语言），收到 ${JSON.stringify(textLanguage)}\n用法：${usage}\n`); return 2; }

  const full = path.resolve(ctx.cwd, target);
  if (pathKind(full, '部分的目录') !== 'directory') { ctx.stderr(`用法错误：seal 要的是部分的目录，${target} 是文件\n用法：${usage}\n`); return 2; }
  const given = options.values.fields === undefined ? {} : readFields(path.resolve(ctx.cwd, options.values.fields));
  const { shortName, ...givenFields } = given;

  const { files, problems } = readDirectory(full);
  if (problems.length > 0) {
    const report = failedReport(problems);
    ctx.stdout(ctx.json ? `${JSON.stringify(report)}\n` : formatReport(report, target));
    return 1;
  }

  const existing = files.has(MANIFEST_FILE) ? readManifest(files.get(MANIFEST_FILE)).manifest : null;
  const carried = existing !== null && existing.part === part ? { ...existing } : {};
  delete carried.files; // 文件列表每次按目录里现有的文件重新生成
  const fields = { ...carried, ...givenFields, part };
  if (options.values.version !== undefined) fields.version = options.values.version;

  let skillMd = null;
  if (part === 'role') {
    if (fields.id === undefined) fields.id = createPackId(options.values['short-name'] ?? shortName);
    if (files.has(SKILL_FILE)) skillMd = 'kept';
    else {
      files.set(SKILL_FILE, new TextEncoder().encode(buildRoleSkillMd(fields, { textLanguage })));
      skillMd = 'generated';
    }
  }

  const hadSignature = files.has(SIGNATURE_FILE);
  const sealed = await sealPart(files, fields);
  const report = await selfCheckPart(sealed, { ...checkOptions(ctx), part }); // 自检：被封的部分此时还没有签名，不验签（check.mjs）
  if (!report.ok) {
    ctx.stdout(ctx.json ? `${JSON.stringify(report)}\n` : formatReport(report, target));
    return 1;
  }

  writeNewFile(path.join(full, MANIFEST_FILE), sealed.get(MANIFEST_FILE), { overwrite: true });
  if (skillMd === 'generated') writeNewFile(path.join(full, SKILL_FILE), sealed.get(SKILL_FILE));
  if (hadSignature) fs.rmSync(path.join(full, SIGNATURE_FILE), { force: true });

  const listed = report.parts[0]?.files ?? 0;
  const info = { directory: full, part, files: listed, skillMd, ...(part === 'role' ? { id: fields.id } : {}), signatureRemoved: hadSignature };
  if (ctx.json) ctx.stdout(`${JSON.stringify(info)}\n`);
  else {
    ctx.stdout([
      `已生成清单：${path.join(full, MANIFEST_FILE)}（${partTitle(part, fields.id, fields.version)}，列了 ${listed} 个文件）`,
      ...(skillMd === 'generated' ? [`已生成 SKILL.md 骨架：${path.join(full, SKILL_FILE)}（${textLanguage === 'en' ? '最后一节「配音指引」下面是空的' : '最后一节「配音指引」是一段提示'}，要作者自己写）`] : []),
      ...(hadSignature ? [`已删除作废的签名：${path.join(full, SIGNATURE_FILE)}（清单变了，旧签名对不上；要签名就再签一次）`] : []),
      '',
    ].join('\n'));
  }
  return 0;
}
