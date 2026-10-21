// SPDX-License-Identifier: Apache-2.0
//
// install 命令：把一个音色包放进 agent 环境的 skill 目录：放进项目的 .agents/skills/（Codex、Gemini CLI、Cursor、OpenCode 读这里），
// 再复制一份到 .claude/skills/（Claude Code 读这里）。
//
//   node cli.mjs install <包目录|分享文件> [--project <目录>] [--trust <信任名单.json>] [--allow-unsigned] [--json]
//
// 先检查，规矩和 check 命令一模一样（protocol/cli/checking.mjs）：清单对得上文件、嵌套的部分各自对得上、SKILL.md 合规、音频按内容判断、
// 外部资源逐个核对、基础部分和协议核心验官方签名、角色部分和它带着的基础部分互相校验。通过了才写盘；检查不过，一个文件都不写，报告写到标准输出。
//   --trust <文件>      换一份信任名单（默认是正在运行的这份协议核心自带的）。给测试和第三方用。
//   --allow-unsigned    放过没有签名文件的基础部分、协议核心，输出里写明没验（本地开发用，不是官方版本）；有签名文件的照验，签得不对照样拒绝。
// 写到 <项目>/.agents/skills/<名字>/ 和 <项目>/.claude/skills/<名字>/，项目默认是当前目录。名字：角色部分（完整包）是包 ID，基础部分是它的协议版本对应的目录名（跟着协议版本走，names.mjs 的表：2.x 是 voice-pack）
// （就是 SKILL.md 的 name，也是 Agent Skills 规范要求的目录名）。
// 两处任何一处已经有同名目录就拒绝（file_exists），一处都不写，不覆盖已有的东西；第二处写失败时，把第一处也清掉（那是这一趟自己创建的）。
// 分享文件（.voicepack.zip）和目录都认；分享文件里的 README.md 和预览卡片是给人看的，不放进去。
//
// 退出码：0 放好了；1 检查不过、目标已存在、读不了；2 用法错误。
// --json：成功时输出 { id?, part, version, files, installed: [<.agents/skills/ 里的目录>, <.claude/skills/ 里的目录>], hasBase, unsigned: [没验签的部分] }。
import fs from 'node:fs';
import path from 'node:path';
import { VoicePackError } from '../../protocol/lib/errors.mjs';
import { parseManifest, partName } from '../../protocol/lib/manifest.mjs';
import { baseDirectoryOf } from '../../protocol/lib/names.mjs';
import { inspectTarget, CHECK_USAGE } from '../../protocol/cli/checking.mjs';
import { writeDirectory } from '../../protocol/cli/disk.mjs';
import { formatReport } from '../../protocol/cli/report.mjs';
import { parseArgs, usageProblem } from '../input.mjs';

export const summary = '把音色包放进环境：检查（含验签）通过后放进 .agents/skills/，再复制一份到 .claude/skills/';
export const usage = `install <包目录|分享文件> [--project <目录>] ${CHECK_USAGE} [--json]`;

/** 命令认的选项（传给 parseArgs 的那份；--json 由 runner 取走）。用法里要都写出来（--trust、--allow-unsigned 在 CHECK_USAGE 里），约定见 cli/input.mjs 文件头。 */
export const FLAGS = { project: 'string', trust: 'string', 'allow-unsigned': 'boolean' };

const LOCATIONS = [['.agents', 'skills'], ['.claude', 'skills']];

export async function run(args, ctx) {
  const parsed = parseArgs(args, FLAGS);
  if (parsed.problem || parsed.positional.length !== 1) return usageProblem(ctx, usage, parsed.problem ?? '要给一个包目录或分享文件');
  const [target] = parsed.positional;
  const project = path.resolve(ctx.cwd, parsed.options.project ?? '.');

  const { report, files } = await inspectTarget(target, ctx, { trust: parsed.options.trust, allowUnsigned: parsed.options['allow-unsigned'] === true });
  if (!report.ok) {
    ctx.stdout(ctx.json ? `${JSON.stringify(report)}\n` : formatReport(report, target));
    return 1;
  }
  const manifest = parseManifest(files.get('manifest.json'));
  if (manifest.part === 'protocol') throw new VoicePackError('pack_not_installable', '协议核心不是一个 skill，不能单独放进环境；要放角色部分（完整包）或基础部分', { details: { part: manifest.part } });
  const baseDirectory = baseDirectoryOf(manifest.protocol); // 包自己的协议版本对应的基础部分目录名
  const name = manifest.part === 'role' ? manifest.id : baseDirectory;

  const destinations = LOCATIONS.map((location) => path.join(project, ...location, name));
  for (const destination of destinations) {
    if (fs.existsSync(destination)) throw new VoicePackError('file_exists', `${destination} 已存在，不往已有的目录里写：先自己挪走旧的，或者换一个 --project`, { details: { file: destination } });
  }
  writeDirectory(destinations[0], files);
  try {
    writeDirectory(destinations[1], files);
  } catch (error) {
    fs.rmSync(destinations[0], { recursive: true, force: true }); // 这一趟自己创建的，上面确认过它原来不存在
    throw error;
  }

  const hasBase = manifest.part === 'role' && [...files.keys()].some((key) => key.startsWith(`${baseDirectory}/`));
  // --allow-unsigned 放过的：没有签名文件、所以没验的部分（根上的是基础部分自己）
  const unsigned = report.signatures.filter((entry) => entry.skipped === 'unsigned').map((entry) => (entry.part === '' ? baseDirectory : entry.part));
  if (ctx.json) {
    ctx.stdout(`${JSON.stringify({ ...(manifest.part === 'role' ? { id: manifest.id } : {}), part: manifest.part, version: manifest.version, files: files.size, installed: destinations, hasBase, unsigned })}\n`);
    return 0;
  }
  const lines = [
    `已放进环境：${manifest.part === 'role' ? `${manifest.name}（${manifest.id} ${manifest.version}）` : `${partName(manifest.part)} ${manifest.version}`}，${files.size} 个文件`,
    `  ${destinations[0]}（Codex、Gemini CLI、Cursor、OpenCode 读这里）`,
    `  ${destinations[1]}（Claude Code 读这里）`,
  ];
  if (unsigned.length > 0) lines.push(`没有签名的部分，没验：${unsigned.join('、')}。这不是官方版本（--allow-unsigned，本地开发用）`);
  if (manifest.part === 'role') {
    lines.push(hasBase
      ? `下一步，给台本配音：node ${path.join(destinations[0], baseDirectory, 'cli.mjs')} dub ${destinations[0]} <台本文件> --out <输出目录> [--adapter <适配器>]（模型从适配器接进来，见基础部分 SKILL.md 的「接自己的模型」）`
      : `这个包没有基础部分（${baseDirectory}/），配音之前要先补全，见它的 SKILL.md 里讲补全的那一节`); // 不写节标题：骨架的标题跟着作者的语言走，英文的包里没有中文标题
  }
  ctx.stdout(`${lines.join('\n')}\n`);
  return 0;
}
