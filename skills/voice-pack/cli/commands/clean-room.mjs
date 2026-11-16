// SPDX-License-Identifier: Apache-2.0
//
// clean-room 命令：给净室里的做包 agent 准备输入。做新包的第一步（流程的正本是 protocol/new-pack/README.md，组装规则的正本是 lib/clean-room.mjs 的文件头）：
// 把协议核心里的抽象规格、空白模板和使用者说的属性放进一个新目录；再把这个目录交给一个新开的会话或子 agent，由它写新包的文字内容。
// 这个命令不读来源包，也不问来源包是哪个：来源包只在最后一步（make-pack 的 --source-pack）查重时才读。
//
//   node cli.mjs clean-room --output <新目录> [--name <角色名>] [--tags <标签,标签>] [--words <自己的话> | --words-file <文件>] [--language <标签>] [--designed]
//                           [--protocol <协议核心目录>] [--json]
//   node cli.mjs clean-room --output <新目录> --attributes <文件.json> [--protocol <协议核心目录>] [--json]
//
// 属性（至少给标签、自己的话里的一个）：
//   --name              角色的名字：写作的 agent 把它写在试听句的开头（protocol/new-pack/README.md「Sample lines」）
//   --tags              设计词表里的标签（中文名、英文名、别名都认），用逗号隔开（中文逗号也行）。写法见 lib/design-vocab.mjs；不在词表里的在组装之前就报
//   --words, --words-file   使用者自己的话，原样交给做包 agent：不改写，不补充。--words 是命令行里直接写的一段话，--words-file 是一个 UTF-8 的文字文件（话长、带换行时用它）。只能给一个
//   --language          语言标签，例如 zh、en、zh-CN
//   --designed          这个声音是设计出来的（不是用录音做的）：只记在属性里，做包 agent 不因此写设计来源（设计来源由调用方给，见 protocol/new-pack/README.md「Design source」）
//   --attributes        整份属性写在一个 JSON 文件里（{ name?, tags?, words?, language?, designed? }，键的意思同上）；不能和上面的属性选项一起给
// 选项：
//   --output            净室输入写到这个新目录。目录必须还不存在：不往已有的目录里写，也不覆盖
//   --protocol          协议核心的目录；省略时用这份基础部分自己的 protocol/（要带 new-pack/ 和 FORMAT.md，开发树里也行，不用封印）
//   --json              标准输出是一份 JSON：{ output, files, attributes }
//
// 输出：目录写在哪、里面有哪些文件、接下来怎么做（能开子 agent 的自己开；不能开的告诉使用者具体怎么做；当前这个 agent 不写；--designed 的把设计、临时的包、带表演的那段、正式的包的命令写全）。
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
import { designedPackSteps } from '../../lib/designed-pack-steps.mjs';
import { parseArgs, readText, usageProblem } from '../input.mjs';

export const summary = 'Prepare the input for the pack-making agent in the clean room: the abstract spec, the blank templates and the attributes the user gave (does not read the source pack)';
export const usage = 'clean-room --output <new directory> [--name <role name>] [--tags <tag,tag>] [--words <own words> | --words-file <file>] [--language <tag>] [--designed] [--attributes <file.json>] [--protocol <protocol core directory>] [--json]';

/** 命令认的选项（传给 parseArgs 的那份；--json 由 runner 取走）。用法里要都写出来，约定见 cli/input.mjs 文件头。 */
export const FLAGS = { output: 'string', name: 'string', tags: 'string', words: 'string', 'words-file': 'string', language: 'string', designed: 'boolean', attributes: 'string', protocol: 'string' };
const ATTRIBUTE_FLAGS = ['name', 'tags', 'words', 'words-file', 'language', 'designed'];
const SKILL_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const list = (text) => text.split(/[,，]/).map((item) => item.trim()).filter((item) => item !== '');

function attributesFromFile(ctx, file) {
  const text = readText(ctx, file);
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new VoicePackError('clean_room_attributes_file_invalid', `${file} is not valid JSON (${cause.message})`, { details: { file }, cause });
  }
}

/** 写完文字以后的几步（文件头「输出」）。--designed 的把设计和后面几步的命令写全；录音的是一条做包命令。 */
function nextSteps(output, designed) {
  const file = (name) => path.join(output, 'output', name);
  const adapter = '--adapter <adapter>';
  if (!designed) {
    return [
      '  2. When the writing is done, come back and make the pack with make-pack, which also runs the duplicate check (--source-pack is the source pack, read only in this step; the duplicate check runs before the steps that cost money and stops with an error if too much was copied):',
      `     node cli.mjs make-pack <material> --output <new directory> --name <name> --direction ${file('direction.json')} --guidance ${file('guidance.md')} --sample-lines ${file('sample-lines.json')} --card-line ${file('card-line.txt')} --source-pack <source pack>`,
      '     To transcribe, pick the default segment, annotate cues, run test synthesis and measure fidelity, also attach a model with --adapter <name|module file> (see adapters/README.md for the adapter contract).',
    ];
  }
  return [
    '  2. When the writing is done, come back and design the voice. Write the description from the user\'s words (references/character-voice.md「A designed voice: the description」), pick one or two lines from output/sample-lines.json as the design audition text, and remove the cues in square brackets:',
    `     node cli.mjs design --description <description> --text <design audition text> --out <candidate directory> ${adapter}`,
    '  3. When the audition is satisfactory, go on. The passage for step b is also put together from a few lines of output/sample-lines.json, not written separately; --source-pack is the source pack, read only in this step (the last command), and the duplicate check runs before the steps that cost money and stops with an error if too much was copied:',
    ...designedPackSteps({ material: '<candidate directory>/material.json', designSource: '<candidate directory>/design-source.json', adapter, direction: file('direction.json'), guidance: file('guidance.md'), sampleLines: file('sample-lines.json'), cardLine: file('card-line.txt'), sourcePack: true }),
  ];
}

export async function run(args, ctx) {
  const parsed = parseArgs(args, FLAGS);
  if (parsed.problem) return usageProblem(ctx, usage, parsed.problem);
  if (parsed.positional.length > 0) return usageProblem(ctx, usage, `No positional arguments are allowed; extra: ${parsed.positional.join(' ')}`);
  const { options } = parsed;
  if (options.output === undefined) return usageProblem(ctx, usage, 'Give --output <new directory> (the clean room input is written there)');
  if (options.words !== undefined && options['words-file'] !== undefined) return usageProblem(ctx, usage, 'Give only one of --words and --words-file');
  const given = ATTRIBUTE_FLAGS.filter((flag) => options[flag] !== undefined);
  if (options.attributes !== undefined && given.length > 0) return usageProblem(ctx, usage, `--attributes cannot be given together with --${given.join(', --')}: put all the attributes in the file, or give them all as options`);
  if (options.attributes === undefined && given.every((flag) => flag === 'name')) return usageProblem(ctx, usage, 'Give the attributes: at least one of --tags and --words (or --words-file), or --attributes <file.json>');

  const output = path.resolve(ctx.cwd, options.output);
  if (fs.existsSync(output)) throw new VoicePackError('file_exists', `${output} already exists; nothing is written into an existing directory: use a new directory name`, { details: { file: output } });

  const attributes = options.attributes !== undefined
    ? attributesFromFile(ctx, options.attributes)
    : {
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.tags === undefined ? {} : { tags: list(options.tags) }),
      ...(options.words === undefined ? {} : { words: options.words }),
      ...(options['words-file'] === undefined ? {} : { words: readText(ctx, options['words-file']) }),
      ...(options.language === undefined ? {} : { language: options.language }),
      ...(options.designed === true ? { designed: true } : {}),
    };

  const protocolDirectory = path.resolve(ctx.cwd, options.protocol ?? path.join(SKILL_ROOT, 'protocol'));
  const { files: protocolCore, problems } = readDirectory(protocolDirectory);
  if (problems.length > 0) {
    throw new VoicePackError('clean_room_protocol_incomplete', `${partName('protocol')} ${protocolDirectory} has a problem and cannot be used: ${problems[0].message}${problems.length > 1 ? ` (${problems.length} problems in all)` : ''}`, { details: { missing: [], problems } });
  }
  const built = buildCleanRoomInput({ protocolCore, attributes });
  writeDirectory(output, built.files);

  const names = [...built.files.keys()];
  if (ctx.json) {
    ctx.stdout(`${JSON.stringify({ output, files: names, attributes: built.attributes }, null, 2)}\n`);
    return 0;
  }
  ctx.stdout([
    `Clean room input written to ${output} (${names.length} ${names.length === 1 ? 'file' : 'files'}):`,
    ...names.map((name) => `  ${name}`),
    '',
    'Next:',
    '  1. Write the text. This agent must not write it: it has already read the role content of the source pack (for example, it was installed as a skill), and what it has read would leak into the new text, so the new pack would not be new.',
    `     If the environment can start a sub-agent: start one yourself, no need to ask the user. Its working directory is ${output}; give it only this directory and one sentence, "Read BRIEF.md, follow it, and write into output/.", and put nothing of the source pack into what you tell it.`,
    `     If it cannot: tell the user that this step needs a new session that has not seen the source pack, so that the new pack is new; ask the user to open a new session or chat window with the working directory set to ${output} (or to upload this directory), and to send as the first message "Read BRIEF.md, follow it, and write into output/.", then come back and say when it is done.`,
    '     If the source pack is installed as a skill (.agents/skills/, .claude/skills/), the new session and the sub-agent will read it too: tell the user first that a pack made this way does not count as a clean room.',
    `     When the writing is done, look at the items marked "缺" (missing) in ${path.join(output, 'output', 'guidance.md')}: if the user is present, ask them, and hand the answers back unchanged to the writing session to fill in (this agent does not edit them itself); leave the ones that cannot be answered, and tell the user when handing over the pack (references/clean-room.md, step 2).`,
    ...nextSteps(output, attributes.designed === true),
    '',
  ].join('\n'));
  return 0;
}
