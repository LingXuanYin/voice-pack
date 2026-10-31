// SPDX-License-Identifier: Apache-2.0
//
// unpack：把分享文件解成一个包目录。先检查，通过了才写盘；检查不过，一个文件都不写。
//
//   node protocol/cli.mjs unpack <分享文件> [--out <目录>] [--trust <信任名单.json>] [--allow-unsigned] [--json]
//
// 写到 <--out>/<包目录名>/，--out 省略就是当前目录。包目录名就是 zip 里的那个目录（角色部分是包 ID，基础部分是 voice-pack）。
// 这个目录已经存在就拒绝（file_exists），不往已有的目录里写，也就不会盖掉里面的东西。
// 只解包目录：README.md 和预览卡片 index.html 是给人看的，留在分享文件里。
// 检查和 check 命令一样（包括外部资源逐个核对：没有网络，带外部资源的包解不开；包括验签和互相校验：
// 基础部分和协议核心不是官方签名的、和角色部分对不上的，都解不开。--trust、--allow-unsigned 的意思见 check）。
//
// 退出码：0 解开了；1 检查不过（报告写到标准输出）、目标已存在、读不了分享文件；2 用法错误。
// --json：成功时输出 { directory, files, part, id?, version }；检查不过时输出整份报告。
import path from 'node:path';
import { parseManifest } from '../../lib/manifest.mjs';
import { inspectTarget, checkSettings, CHECK_OPTIONS, CHECK_USAGE } from '../checking.mjs';
import { writeDirectory } from '../disk.mjs';
import { parseOptions } from '../signing.mjs';
import { formatReport, partTitle } from '../report.mjs';

export const summary = '把分享文件解成包目录：先检查（含验签和互相校验），通过了才写盘，不覆盖已有的目录';
export const usage = `unpack <分享文件> [--out <目录>] ${CHECK_USAGE} [--json]`;

export async function run(args, ctx) {
  const options = parseOptions(args, { values: ['out', ...CHECK_OPTIONS.values], flags: CHECK_OPTIONS.flags });
  if (options.problem !== undefined) { ctx.stderr(`用法错误：${options.problem}\n用法：${usage}\n`); return 2; }
  const [target, ...extra] = options.positional;
  if (target === undefined) { ctx.stderr(`用法错误：要指定分享文件\n用法：${usage}\n`); return 2; }
  if (extra.length > 0) { ctx.stderr(`用法错误：一次只解一个，多出来的是 ${extra.join(' ')}\n用法：${usage}\n`); return 2; }

  const { kind, report, files, directory } = await inspectTarget(target, ctx, checkSettings(options));
  if (kind !== 'file') { ctx.stderr(`用法错误：unpack 要的是分享文件（.voicepack.zip），${target} 是目录；检查目录用 check\n用法：${usage}\n`); return 2; }
  if (!report.ok) {
    ctx.stdout(ctx.json ? `${JSON.stringify(report)}\n` : formatReport(report, target));
    return 1;
  }

  const dest = path.resolve(ctx.cwd, options.values.out ?? '.', directory);
  writeDirectory(dest, files);
  const manifest = parseManifest(files.get('manifest.json'));
  const summaryInfo = { directory: dest, files: files.size, part: manifest.part, ...(manifest.part === 'role' ? { id: manifest.id } : {}), version: manifest.version };
  ctx.stdout(ctx.json ? `${JSON.stringify(summaryInfo)}\n` : `已解包：${dest}（${files.size} 个文件，${partTitle(manifest.part, manifest.id, manifest.version)}）\n`);
  return 0;
}
