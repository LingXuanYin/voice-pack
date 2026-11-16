// SPDX-License-Identifier: Apache-2.0
//
// complete：补全一个只有角色部分的包：环境里没有可用的基础部分时，从官方地址取回官方基础部分，验签，放进包里的基础部分目录（目录名跟包的协议版本走，names.mjs 的表），变成完整包。
//
//   node protocol/cli.mjs complete <包目录> [--trust <信任名单.json>] [--json]
//
// 只有协议核心时也能跑（核心层的命令）：agent 环境里只拿到一个角色部分，就是在这个包的目录里运行 node protocol/cli.mjs complete .
// 做的事，按这个次序（每一步的规则和 code 见 protocol/lib/complete.mjs 的文件头，版本怎么挑和理由见 protocol/FORMAT.md「Complete」）：
//   1 读包目录；包里已经有基础部分目录并且可用：什么都不做
//   2 找环境里已有的基础部分：包旁边（同一个 skill 目录）、项目的 .agents/skills/、项目的 .claude/skills/。官方版本、协议主版本兼容、版本不低于包要求的最低版本，就直接用它，
//     不补全，一个字节都不写。环境里原有的那一份只验两份清单的签名，不重新算哈希
//   3 否则读官方地址（信任名单里的 official_url）上的版本索引，挑同一个主版本里、不低于最低版本的最高版本，下载它的 zip 和签名，验签，检查。
//     官方换过钥匙、包里的名单只有旧公钥时，版本索引（现在的钥匙签的）读不了：不挑版本，直接取包要求的最低版本本身，输出里写明（规则见 protocol/RELEASES.md「A lost or leaked private key」）
//   4 在临时目录里写好，对整个包再检查一遍（含验签和互相校验，外部资源也核对），最后一步才挪成基础部分目录。任何一步失败都报错，不留下半个目录，不兜底
// 每个包补进自己目录里的基础部分目录，不改环境共用的那一份：同一个环境里几个包要的版本不同，各用各的，互不干扰。
// install 把包放进 .agents/skills/ 和 .claude/skills/ 两处：补全了其中一份（或者这一份早就带着基础部分），另一份还没有基础部分、别的文件逐字节一样的，
// 同一份基础部分也放进去，不再下载（protocol/cli/completing.mjs 的 twinOf）；另一份对不上的不碰。
//   --trust <文件>   换一份信任名单（默认是正在运行的这份协议核心自带的 protocol/trust.json；官方地址和官方公钥都取自它）。给测试和第三方用，官方的补全不传它。
//                    没有「放过没签名的」这类选项：补全永远验签
//
// 退出码：0 补全了，或者不用补全（输出里写明是哪一种）；1 失败（报告写到标准错误，写明是哪一步）；2 用法错误。
// --json：成功时输出一行 { outcome: 'completed' | 'environment' | 'in_pack', packDir, base: { source, version, protocol, keyId, location? | url, size, sha256, indexUntrusted? }, rejected: [...], installed?, files?, twinInstalled? }（twinInstalled：另一份放进的基础部分目录），
//         失败时标准错误是一行 {"error":{"code","message","details"}}。rejected 是环境里那些没用上的基础部分和原因。indexUntrusted: { keyId } 只在走了上面第 3 步的退路时有。
import path from 'node:path';
import { completeRolePart } from '../../lib/complete.mjs';
import { describeRejection } from '../../lib/base-choice.mjs';
import { failedReport } from '../../lib/check.mjs';
import { readManifest } from '../../lib/manifest.mjs';
import { baseDirectoryOf, CURRENT_NAMES } from '../../lib/names.mjs';
import { pathKind, readDirectory } from '../disk.mjs';
import { environmentCandidates, installBasePart, twinOf } from '../completing.mjs';
import { formatReport } from '../report.mjs';
import { DEFAULT_TRUST_FILE, parseOptions, readTrustListFile } from '../signing.mjs';

export const summary = 'Complete a pack that has only a role part: when the environment has no usable base part, fetch the official base part, verify its signature, and put it into the pack\'s base part directory (the directory name follows the pack\'s protocol version)';
export const usage = 'complete <pack-dir> [--trust <trust-list.json>] [--json]';

const where = (base) => (base.source === 'official' ? `official version ${base.version}` : `official version ${base.version} (protocol ${base.protocol})`);

export async function run(args, ctx) {
  const options = parseOptions(args, { values: ['trust'] });
  if (options.problem !== undefined) { ctx.stderr(`Usage error: ${options.problem}\nUsage: ${usage}\n`); return 2; }
  const [target, ...extra] = options.positional;
  if (target === undefined) { ctx.stderr(`Usage error: give the pack directory\nUsage: ${usage}\n`); return 2; }
  if (extra.length > 0) { ctx.stderr(`Usage error: complete takes one pack at a time; the extra argument is ${extra.join(' ')}\nUsage: ${usage}\n`); return 2; }

  const packDir = path.resolve(ctx.cwd, target);
  if (pathKind(packDir, 'pack directory') !== 'directory') { ctx.stderr(`Usage error: complete takes a pack directory, but ${target} is a file; unpack a share file with unpack first\nUsage: ${usage}\n`); return 2; }
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
  // install 放的另一份（.agents/skills 和 .claude/skills 各一份）：补全了这一份、或者这一份早就带着基础部分，另一份还没有的，放进同一份基础部分（completing.mjs 的 twinOf）
  let twinInstalled;
  if (result.outcome !== 'environment') {
    const twin = twinOf(packDir, files, directory);
    const baseFiles = result.outcome === 'completed'
      ? result.files
      : new Map([...files].filter(([file]) => file.startsWith(`${directory}/`)).map(([file, bytes]) => [file.slice(directory.length + 1), bytes]));
    if (twin !== null && baseFiles.size > 0) twinInstalled = await installBasePart(twin, baseFiles, { directory });
  }

  if (ctx.json) {
    ctx.stdout(`${JSON.stringify({ outcome: result.outcome, packDir, base: result.base, rejected: result.rejected, ...(installed === undefined ? {} : { installed, files: result.files.size }), ...(twinInstalled === undefined ? {} : { twinInstalled }) })}\n`);
    return 0;
  }
  const lines = [];
  const skipped = result.rejected.map((rejection) => `Did not use the environment's ${describeRejection(rejection)}`);
  if (result.outcome === 'completed') {
    const { indexUntrusted } = result.base;
    lines.push(
      `Completed: ${packDir}`,
      `  Official base part ${result.base.version} (${result.files.size} files) was put into ${installed}`,
      `  Fetched from ${result.base.url} (${result.base.size} bytes, SHA-256 ${result.base.sha256}); the zip and both manifests inside it carry the official signature (key id ${result.base.keyId})`,
      ...(indexUntrusted === undefined ? [] : [`  The version index was signed by a key that is not in the trust list (key id ${indexUntrusted.keyId}), so it was not used to pick a version: fell back to fetching the lowest version the pack requires, ${result.base.version}, directly (this happens when the official key has been replaced; the zip and signature of the old version are unchanged and still verify)`]),
      `  The whole pack was checked again: every file passed against the manifest, signature verification, mutual verification and external resources`,
      ...skipped.map((line) => `  ${line}`),
      `Command line of the base part: node ${path.join(installed, 'cli.mjs')} help`,
    );
  } else if (result.outcome === 'environment') {
    lines.push(
      `Nothing to complete: the environment already has a usable base part ${result.base.location} (${where(result.base)})`,
      ...skipped.map((line) => `  ${line}`),
      `Command line of the base part: node ${path.join(result.base.location, 'cli.mjs')} help`,
    );
  } else {
    lines.push(`Nothing to complete: the pack already has a usable base part (${result.directory}/, ${where(result.base)}). To check that the whole pack has not been modified, use check`);
  }
  if (twinInstalled !== undefined) lines.push(`The other install copy also got the same base part: ${twinInstalled} (apart from the base part, every file in the other copy is identical to this one; nothing was downloaded again)`);
  ctx.stdout(`${lines.join('\n')}\n`);
  return 0;
}
