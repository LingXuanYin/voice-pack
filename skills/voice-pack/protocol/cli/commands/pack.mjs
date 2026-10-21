// SPDX-License-Identifier: Apache-2.0
//
// pack：把一个部分的目录打成分享文件（.voicepack.zip）。目录要已经有清单（先用 seal 生成）。先检查，通过了才打包。
//
//   node protocol/cli.mjs pack <部分目录> [--out <分享文件>] [--product-name <名字>] [--open-link <地址>] [--make-link <地址>] [--trust <信任名单.json>] [--allow-unsigned] [--json]
//
// <部分目录> 是角色部分的包目录（完整包或只有角色部分的）或基础部分的目录。里面有符号链接、特殊文件、超过上限的，
// 或者检查不过（清单对不上文件、SKILL.md 不合规、音频是伪装的、外部资源核对不过、签名不对、和基础部分对不上……），都不打包，报告写到标准输出。
// 检查和 check 命令一样，包括验签和互相校验（--trust、--allow-unsigned 的意思见 check）：打出去的包，收的一方也会这样检查，
// 所以基础部分和协议核心要先签名（sign 命令）再打包；签名在 seal 之后、pack 之前。
// 分享文件里的目录名由清单定：角色部分用包 ID，基础部分用它的协议版本对应的目录名（names.mjs 的表），和源目录叫什么无关。
// 同样的目录打出同样的字节：报出来的 sha256 在不同系统、不同运行时上都一样。
//
// 预览卡片：角色部分的分享文件里默认带一张（index.html，打包时生成，不列进清单；是什么、页面上有什么见 lib/preview-card.mjs 的文件头）。三个选项给它：
//   --product-name <名字>   「在 <名字> 里打开」里的产品名；不给，这个入口就叫「打开」
//   --open-link <地址>      「在 <名字> 里打开」的链接；不给就没有这个入口
//   --make-link <地址>      「做一个你自己的」的链接；不给就没有这个入口
//   地址里的 {id} 换成包 ID（按 URL 组件的规则编码）；换完必须是 http 或 https 的地址，不是就退出 1（card_link_invalid），不写出任何文件。
//   核心层的命令行不认识任何适配器，产品的名字和入口只能在这里给，不给就没有入口（通用层不写死任何产品）。官方产品要给的值写在它的产品契约里，
//   官方适配器的 reference/product-contract.md 里有可以直接抄的命令行写法。基础部分没有卡片：这三个选项对它不起作用。
//
// --out 是分享文件的路径，省略就写到当前目录，文件名 <名字>.voicepack.zip（角色部分用显示名，基础部分用
// <基础部分的目录名>-<版本>，和官方发布的文件名一致）。文件已经存在就拒绝（file_exists），不覆盖。
//
// 退出码：0 打好了；1 检查不过、目标已存在、读不了、卡片的链接不对；2 用法错误。
// --json：成功时输出 { file, bytes, sha256, part, id?, version }；检查不过时输出整份报告。
import path from 'node:path';
import { sha256Hex } from '../../lib/hash.mjs';
import { parseManifest } from '../../lib/manifest.mjs';
import { releaseFilePrefixOf } from '../../lib/names.mjs';
import { buildShareFile, shareFileName } from '../../lib/share.mjs';
import { inspectTarget, checkSettings, CHECK_OPTIONS, CHECK_USAGE } from '../checking.mjs';
import { writeNewFile } from '../disk.mjs';
import { parseOptions } from '../signing.mjs';
import { formatReport } from '../report.mjs';

export const summary = '把一个部分的目录打成分享文件（.voicepack.zip）：先检查（含验签和互相校验），通过了才打包，同样的目录打出同样的字节';
export const usage = `pack <部分目录> [--out <分享文件>] [--product-name <名字>] [--open-link <地址>] [--make-link <地址>] ${CHECK_USAGE} [--json]`;

export async function run(args, ctx) {
  const options = parseOptions(args, { values: ['out', 'product-name', 'open-link', 'make-link', ...CHECK_OPTIONS.values], flags: CHECK_OPTIONS.flags });
  if (options.problem !== undefined) { ctx.stderr(`用法错误：${options.problem}\n用法：${usage}\n`); return 2; }
  const [target, ...extra] = options.positional;
  if (target === undefined) { ctx.stderr(`用法错误：要指定部分的目录\n用法：${usage}\n`); return 2; }
  if (extra.length > 0) { ctx.stderr(`用法错误：一次只打一个，多出来的是 ${extra.join(' ')}\n用法：${usage}\n`); return 2; }

  const { kind, report, files } = await inspectTarget(target, ctx, checkSettings(options));
  if (kind !== 'directory') { ctx.stderr(`用法错误：pack 要的是部分的目录，${target} 是文件；检查分享文件用 check，解开用 unpack\n用法：${usage}\n`); return 2; }
  if (!report.ok) {
    ctx.stdout(ctx.json ? `${JSON.stringify(report)}\n` : formatReport(report, target));
    return 1;
  }

  const manifest = parseManifest(files.get('manifest.json'));
  if (manifest.part === 'protocol') {
    ctx.stderr('用法错误：协议核心不单独分享：要打包的是角色部分或基础部分的目录\n');
    return 2;
  }
  const card = { productName: options.values['product-name'], links: { open: options.values['open-link'], make: options.values['make-link'] } };
  const bytes = buildShareFile(files, { card });
  const defaultName = manifest.part === 'role' ? shareFileName(manifest.name, manifest.id) : shareFileName(`${releaseFilePrefixOf(manifest.protocol)}-${manifest.version}`);
  const file = path.resolve(ctx.cwd, options.values.out ?? defaultName);
  writeNewFile(file, bytes);
  const sha256 = await sha256Hex(bytes);
  const info = { file, bytes: bytes.length, sha256, part: manifest.part, ...(manifest.part === 'role' ? { id: manifest.id } : {}), version: manifest.version };
  ctx.stdout(ctx.json ? `${JSON.stringify(info)}\n` : `已打包：${file}（${bytes.length} 字节，sha256 ${sha256}）\n`);
  return 0;
}
