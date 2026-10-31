// SPDX-License-Identifier: Apache-2.0
//
// check：检查一个分享文件（.voicepack.zip）或一个部分的目录（包目录、基础部分、协议核心）。
//
//   node protocol/cli.mjs check <分享文件或目录> [--trust <信任名单.json>] [--allow-unsigned] [--json]
//
// 查什么：清单对得上文件（缺的、多的、改过的），嵌着的部分各自对得上，文件名安全，没有符号链接，没有超过解包上限，
// SKILL.md 合规，音频按内容判断，外部资源逐个取回来核对哈希（没有网络就报「外部资源无法核对」）。能查的都查，一次报全。
// 分享文件还要先过 zip 这一关：第一项是类型标识，成员名不能跳出解包目录，没有符号链接，成员数量和大小在上限内。
// 同时验签和互相校验（规矩见 checking.mjs 的文件头）：
//   验签        基础部分和协议核心必须带官方签名（清单旁边的 manifest.json.minisig），不是官方的一律拒绝；角色部分不验。
//               信任名单默认是正在运行的这份协议核心自带的 protocol/trust.json，--trust 换一份（测试和第三方用）。
//   互相校验    角色部分和它带着的基础部分对一对：协议主版本兼容、基础部分不低于角色部分要求的最低版本、功能要的所需能力都在基础部分的词表里。
//   --allow-unsigned   没有签名文件的部分放过，报告里写明没验（本地开发用）；有签名文件的照验。
//
// 退出码：0 通过；1 有问题（报告写到标准输出），或者读不了要检查的东西、读不了信任名单；2 用法错误。
// --json：整份报告输出成一行 JSON（字段见 lib/check.mjs 的文件头）。
//
// 文字输出末尾，清单里有脚本没写 feature 时多一行提示，点名是哪几个：它们不属于任何功能，不会被自动运行（lib/pack-script.mjs 的文件头：设计如此）。
// 这不是问题：不影响通过与否和退出码，--json 的报告也不变（提示不是库的检查报告里的东西）。
import { readManifest, MANIFEST_FILE } from '../../lib/manifest.mjs';
import { inspectTarget, checkSettings, CHECK_OPTIONS, CHECK_USAGE } from '../checking.mjs';
import { parseOptions } from '../signing.mjs';
import { formatReport } from '../report.mjs';

export const summary = '检查一个分享文件（.voicepack.zip）或一个部分的目录：清单对得上文件、签名、互相校验、SKILL.md、音频、外部资源';
export const usage = `check <分享文件或目录> ${CHECK_USAGE} [--json]`;

const MAX_NAMED = 10; // 提示里最多点名几个脚本，其余写个数

/** 角色部分清单里登记了、却没写 feature 的脚本的入口。读不出清单、不是角色部分、没有脚本，都是没有。 */
function scriptsWithoutFeature(files) {
  const bytes = files?.get(MANIFEST_FILE);
  if (bytes === undefined) return [];
  const { manifest } = readManifest(bytes);
  if (manifest === null || manifest.part !== 'role' || !Array.isArray(manifest.scripts)) return [];
  return manifest.scripts.filter((script) => script.feature === undefined).map((script) => script.entry);
}

/** 提示那一行（以换行结尾）；没有这样的脚本就是空串。 */
function scriptNotice(entries) {
  if (entries.length === 0) return '';
  const named = entries.slice(0, MAX_NAMED).join('、') + (entries.length > MAX_NAMED ? `……等共 ${entries.length} 个` : '');
  return `  提示：清单里有 ${entries.length} 个脚本没登记功能（没写 feature），不会被自动运行：${named}。脚本登记在某个功能名下，才会随那个功能运行；要让它们自动生效，在清单里给每个脚本写上 feature\n`;
}

export async function run(args, ctx) {
  const options = parseOptions(args, CHECK_OPTIONS);
  if (options.problem !== undefined) { ctx.stderr(`用法错误：${options.problem}\n用法：${usage}\n`); return 2; }
  const [target, ...extra] = options.positional;
  if (target === undefined) { ctx.stderr(`用法错误：要指定检查什么\n用法：${usage}\n`); return 2; }
  if (extra.length > 0) { ctx.stderr(`用法错误：一次只检查一个，多出来的是 ${extra.join(' ')}\n用法：${usage}\n`); return 2; }

  const { report, files } = await inspectTarget(target, ctx, checkSettings(options));
  ctx.stdout(ctx.json ? `${JSON.stringify(report)}\n` : formatReport(report, target) + scriptNotice(scriptsWithoutFeature(files)));
  return report.ok ? 0 : 1;
}
