// SPDX-License-Identifier: Apache-2.0
//
// complete：补全一个只有角色部分的包：环境里没有可用的基础部分时，从官方地址取回官方基础部分，验签，放进包里的基础部分目录（目录名跟包的协议版本走，names.mjs 的表），变成完整包。
//
//   node protocol/cli.mjs complete <包目录> [--trust <信任名单.json>] [--json]
//
// 只有协议核心时也能跑（核心层的命令）：agent 环境里只拿到一个角色部分，就是在这个包的目录里运行 node protocol/cli.mjs complete .
// 做的事，按这个次序（每一步的规则和 code 见 protocol/lib/complete.mjs 的文件头，版本怎么挑和理由见 protocol/FORMAT.md「补全」）：
//   1 读包目录；包里已经有基础部分目录并且可用：什么都不做
//   2 找环境里已有的基础部分：包旁边（同一个 skill 目录）、项目的 .agents/skills/、项目的 .claude/skills/。官方版本、协议主版本兼容、版本不低于包要求的最低版本，就直接用它，
//     不补全，一个字节都不写。环境里原有的那一份只验两份清单的签名，不重新算哈希
//   3 否则读官方地址（信任名单里的 official_url）上的版本索引，挑同一个主版本里、不低于最低版本的最高版本，下载它的 zip 和签名，验签，检查。
//     官方换过钥匙、包里的名单只有旧公钥时，版本索引（现在的钥匙签的）读不了：不挑版本，直接取包要求的最低版本本身，输出里写明（规则见 protocol/RELEASES.md「私钥丢了或泄露了」）
//   4 在临时目录里写好，对整个包再检查一遍（含验签和互相校验，外部资源也核对），最后一步才挪成基础部分目录。任何一步失败都报错，不留下半个目录，不兜底
// 每个包补进自己目录里的基础部分目录，不改环境共用的那一份：同一个环境里几个包要的版本不同，各用各的，互不干扰。
//   --trust <文件>   换一份信任名单（默认是正在运行的这份协议核心自带的 protocol/trust.json；官方地址和官方公钥都取自它）。给测试和第三方用，官方的补全不传它。
//                    没有「放过没签名的」这类选项：补全永远验签
//
// 退出码：0 补全了，或者不用补全（输出里写明是哪一种）；1 失败（报告写到标准错误，写明是哪一步）；2 用法错误。
// --json：成功时输出一行 { outcome: 'completed' | 'environment' | 'in_pack', packDir, base: { source, version, protocol, keyId, location? | url, size, sha256, indexUntrusted? }, rejected: [...], installed?, files? }，
//         失败时标准错误是一行 {"error":{"code","message","details"}}。rejected 是环境里那些没用上的基础部分和原因。indexUntrusted: { keyId } 只在走了上面第 3 步的退路时有。
import path from 'node:path';
import { completeRolePart } from '../../lib/complete.mjs';
import { describeRejection } from '../../lib/base-choice.mjs';
import { failedReport } from '../../lib/check.mjs';
import { readManifest } from '../../lib/manifest.mjs';
import { baseDirectoryOf, CURRENT_NAMES } from '../../lib/names.mjs';
import { pathKind, readDirectory } from '../disk.mjs';
import { environmentCandidates, installBasePart } from '../completing.mjs';
import { formatReport } from '../report.mjs';
import { DEFAULT_TRUST_FILE, parseOptions, readTrustListFile } from '../signing.mjs';

export const summary = '补全只有角色部分的包：环境里没有可用的基础部分时，取官方基础部分，验签，放进包里的基础部分目录（目录名跟包的协议版本走）';
export const usage = 'complete <包目录> [--trust <信任名单.json>] [--json]';

const where = (base) => (base.source === 'official' ? `官方版本 ${base.version}` : `官方版本 ${base.version}（协议 ${base.protocol}）`);

export async function run(args, ctx) {
  const options = parseOptions(args, { values: ['trust'] });
  if (options.problem !== undefined) { ctx.stderr(`用法错误：${options.problem}\n用法：${usage}\n`); return 2; }
  const [target, ...extra] = options.positional;
  if (target === undefined) { ctx.stderr(`用法错误：要指定包目录\n用法：${usage}\n`); return 2; }
  if (extra.length > 0) { ctx.stderr(`用法错误：一次只补全一个，多出来的是 ${extra.join(' ')}\n用法：${usage}\n`); return 2; }

  const packDir = path.resolve(ctx.cwd, target);
  if (pathKind(packDir, '包目录') !== 'directory') { ctx.stderr(`用法错误：complete 要的是包目录，${target} 是文件；分享文件先用 unpack 解开\n用法：${usage}\n`); return 2; }
  const trustList = readTrustListFile(options.values.trust === undefined ? DEFAULT_TRUST_FILE : path.resolve(ctx.cwd, options.values.trust));

  const { files, problems } = readDirectory(packDir);
  if (problems.length > 0) {
    ctx.stdout(ctx.json ? `${JSON.stringify(failedReport(problems))}\n` : formatReport(failedReport(problems), target));
    return 1;
  }
  // 基础部分的目录名跟包自己的协议版本走；清单读不了的，按这一版库写的名字找，后面 completeRolePart 会把清单的问题报出来
  const manifestBytes = files.get('manifest.json');
  const protocol = manifestBytes === undefined ? undefined : readManifest(manifestBytes).manifest?.protocol;
  const directory = protocol === undefined ? CURRENT_NAMES.baseDirectory : baseDirectoryOf(protocol);
  const result = await completeRolePart(files, { trustList, env: ctx.env, candidates: environmentCandidates(packDir, ctx.cwd, directory) });
  const installed = result.outcome === 'completed' ? await installBasePart(packDir, result.files, { directory: result.directory }) : undefined;

  if (ctx.json) {
    ctx.stdout(`${JSON.stringify({ outcome: result.outcome, packDir, base: result.base, rejected: result.rejected, ...(installed === undefined ? {} : { installed, files: result.files.size }) })}\n`);
    return 0;
  }
  const lines = [];
  const skipped = result.rejected.map((rejection) => `没有用环境里的 ${describeRejection(rejection)}`);
  if (result.outcome === 'completed') {
    const { indexUntrusted } = result.base;
    lines.push(
      `已补全：${packDir}`,
      `  官方基础部分 ${result.base.version}（${result.files.size} 个文件）放进了 ${installed}`,
      `  取自 ${result.base.url}（${result.base.size} 字节，SHA-256 ${result.base.sha256}），zip 和里面的两份清单都是官方签名（key id ${result.base.keyId}）`,
      ...(indexUntrusted === undefined ? [] : [`  版本索引是信任名单里没有的钥匙（key id ${indexUntrusted.keyId}）签的，没有用它挑版本：退回去直接取了包要求的最低版本 ${result.base.version}（官方换过钥匙时会这样；旧版本的 zip 和签名没有变，照样验得过）`]),
      `  整个包已经重新检查过：每个文件对清单、验签、互相校验、外部资源都通过`,
      ...skipped.map((line) => `  ${line}`),
      `基础部分的命令行：node ${path.join(installed, 'cli.mjs')} help`,
    );
  } else if (result.outcome === 'environment') {
    lines.push(
      `不用补全：环境里已经有可用的基础部分 ${result.base.location}（${where(result.base)}）`,
      ...skipped.map((line) => `  ${line}`),
      `基础部分的命令行：node ${path.join(result.base.location, 'cli.mjs')} help`,
    );
  } else {
    lines.push(`不用补全：包里已经有可用的基础部分（${result.directory}/，${where(result.base)}）。要核对整个包有没有被改过，用 check`);
  }
  ctx.stdout(`${lines.join('\n')}\n`);
  return 0;
}
