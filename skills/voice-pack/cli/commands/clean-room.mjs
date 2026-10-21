// SPDX-License-Identifier: Apache-2.0
//
// clean-room 命令：给净室里的做包 agent 准备输入。做新包的第一步（流程的正本是 protocol/new-pack/README.md，组装规则的正本是 lib/clean-room.mjs 的文件头）：
// 把协议核心里的抽象规格、空白模板和使用者说的属性放进一个新目录；再把这个目录交给一个新开的会话或子 agent，由它写新包的文字内容。
// 这个命令不读来源包，也不问来源包是哪个：来源包只在最后一步（make-pack 的 --source-pack）查重时才读。
//
//   node cli.mjs clean-room --output <新目录> [--tags <标签,标签>] [--scenes <场景,场景>] [--words <自己的话> | --words-file <文件>] [--language <标签>] [--designed]
//                           [--protocol <协议核心目录>] [--json]
//   node cli.mjs clean-room --output <新目录> --attributes <文件.json> [--protocol <协议核心目录>] [--json]
//
// 属性（至少给标签、场景、自己的话里的一个）：
//   --tags, --scenes    设计词表里的标签、场景词表里的场景（中文名、英文名都认），用逗号隔开（中文逗号也行）。写法见 lib/design-vocab.mjs；不在词表里的在组装之前就报
//   --words, --words-file   使用者自己的话，原样交给做包 agent：不改写，不补充。--words 是命令行里直接写的一段话，--words-file 是一个 UTF-8 的文字文件（话长、带换行时用它）。只能给一个
//   --language          语言标签，例如 zh、en、zh-CN
//   --designed          这个声音是设计出来的（不是用录音做的）：做包 agent 要写设计来源
//   --attributes        整份属性写在一个 JSON 文件里（{ tags?, scenes?, words?, language?, designed? }，键的意思同上）；不能和上面的属性选项一起给
// 选项：
//   --output            净室输入写到这个新目录。目录必须还不存在：不往已有的目录里写，也不覆盖
//   --protocol          协议核心的目录；省略时用这份基础部分自己的 protocol/（要带 new-pack/ 和 FORMAT.md，开发树里也行，不用封印）
//   --json              标准输出是一份 JSON：{ output, files, attributes }
//
// 输出：目录写在哪、里面有哪些文件、接下来怎么做（把目录交给新开的会话或子 agent；当前这个 agent 不写）。
// 退出码：0 做完；1 出错（错误码在标准错误）；2 用法错误。
//
// 抛出的错误（VoicePackError；code 小写下划线）：
//   clean_room_input_invalid        属性不合约定。details: { field, problem }（来自 lib/clean-room.mjs）
//   clean_room_protocol_incomplete  协议核心里缺要用的文件。details.missing
//   file_exists                     --output 的目录已经存在
//   file_unreadable、input_not_text 读不了 --words-file、--attributes，或者不是 UTF-8（来自 cli/input.mjs）
//   clean_room_attributes_file_invalid  --attributes 的文件不是合法的 JSON。details.file
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VoicePackError } from '../../protocol/lib/errors.mjs';
import { partName } from '../../protocol/lib/manifest.mjs';
import { readDirectory, writeDirectory } from '../../protocol/cli/disk.mjs';
import { buildCleanRoomInput } from '../../lib/clean-room.mjs';
import { parseArgs, readText, usageProblem } from '../input.mjs';

export const summary = '给净室里的做包 agent 准备输入：抽象规格、空白模板和使用者说的属性（不读来源包）';
export const usage = 'clean-room --output <新目录> [--tags <标签,标签>] [--scenes <场景,场景>] [--words <自己的话> | --words-file <文件>] [--language <标签>] [--designed] [--attributes <文件.json>] [--protocol <协议核心目录>] [--json]';

/** 命令认的选项（传给 parseArgs 的那份；--json 由 runner 取走）。用法里要都写出来，约定见 cli/input.mjs 文件头。 */
export const FLAGS = { output: 'string', tags: 'string', scenes: 'string', words: 'string', 'words-file': 'string', language: 'string', designed: 'boolean', attributes: 'string', protocol: 'string' };
const ATTRIBUTE_FLAGS = ['tags', 'scenes', 'words', 'words-file', 'language', 'designed'];
const SKILL_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const list = (text) => text.split(/[,，]/).map((item) => item.trim()).filter((item) => item !== '');

function attributesFromFile(ctx, file) {
  const text = readText(ctx, file);
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new VoicePackError('clean_room_attributes_file_invalid', `${file} 不是合法的 JSON（${cause.message}）`, { details: { file }, cause });
  }
}

export async function run(args, ctx) {
  const parsed = parseArgs(args, FLAGS);
  if (parsed.problem) return usageProblem(ctx, usage, parsed.problem);
  if (parsed.positional.length > 0) return usageProblem(ctx, usage, `不要位置参数，多给了：${parsed.positional.join(' ')}`);
  const { options } = parsed;
  if (options.output === undefined) return usageProblem(ctx, usage, '要给 --output <新目录>（净室输入写在这里）');
  if (options.words !== undefined && options['words-file'] !== undefined) return usageProblem(ctx, usage, '--words 和 --words-file 只能给一个');
  const given = ATTRIBUTE_FLAGS.filter((flag) => options[flag] !== undefined);
  if (options.attributes !== undefined && given.length > 0) return usageProblem(ctx, usage, `--attributes 不能和 --${given.join('、--')} 一起给：属性要么都写在文件里，要么都用选项`);
  if (options.attributes === undefined && given.length === 0) return usageProblem(ctx, usage, '要给属性：--tags、--scenes、--words（或 --words-file）里至少一个，或者 --attributes <文件.json>');

  const output = path.resolve(ctx.cwd, options.output);
  if (fs.existsSync(output)) throw new VoicePackError('file_exists', `${output} 已经存在，不往已有的目录里写：换一个新目录名`, { details: { file: output } });

  const attributes = options.attributes !== undefined
    ? attributesFromFile(ctx, options.attributes)
    : {
      ...(options.tags === undefined ? {} : { tags: list(options.tags) }),
      ...(options.scenes === undefined ? {} : { scenes: list(options.scenes) }),
      ...(options.words === undefined ? {} : { words: options.words }),
      ...(options['words-file'] === undefined ? {} : { words: readText(ctx, options['words-file']) }),
      ...(options.language === undefined ? {} : { language: options.language }),
      ...(options.designed === true ? { designed: true } : {}),
    };

  const protocolDirectory = path.resolve(ctx.cwd, options.protocol ?? path.join(SKILL_ROOT, 'protocol'));
  const { files: protocolCore, problems } = readDirectory(protocolDirectory);
  if (problems.length > 0) {
    throw new VoicePackError('clean_room_protocol_incomplete', `${partName('protocol')} ${protocolDirectory} 里有问题，不能用：${problems[0].message}${problems.length > 1 ? `（共 ${problems.length} 处）` : ''}`, { details: { missing: [], problems } });
  }
  const built = buildCleanRoomInput({ protocolCore, attributes });
  writeDirectory(output, built.files);

  const names = [...built.files.keys()];
  if (ctx.json) {
    ctx.stdout(`${JSON.stringify({ output, files: names, attributes: built.attributes }, null, 2)}\n`);
    return 0;
  }
  ctx.stdout([
    `净室输入已写到 ${output}（${names.length} 个文件）：`,
    ...names.map((name) => `  ${name}`),
    '',
    '接下来：',
    `  1. 新开一个会话或子 agent，工作目录就是 ${output}，只给它这个目录，让它照 BRIEF.md 写，写到 output/ 里。`,
    '     当前这个 agent 不要写：已经读过来源包的角色内容（比如把它装成了 skill），读到的会漏进新写的文字里。',
    '  2. 写完回来，用 make-pack 做包并查重（--source-pack 是来源包，只在这一步读；查重在花钱的几步之前，抄多了就报错停下）：',
    `     node cli.mjs make-pack <素材> --output <新目录> --name <名字> --direction ${path.join(output, 'output', 'direction.json')} --guidance ${path.join(output, 'output', 'guidance.md')} --sample-lines ${path.join(output, 'output', 'sample-lines.json')} --source-pack <来源包>`,
    '     要转写、打标签、试合成、量还原度，就再用 --adapter <名字|模块文件> 接上模型（适配器的约定见 adapters/README.md）。',
    '',
  ].join('\n'));
  return 0;
}
