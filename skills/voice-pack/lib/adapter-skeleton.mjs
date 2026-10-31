// SPDX-License-Identifier: Apache-2.0
//
// 适配器骨架的生成（流程层）：纯函数，只用平台自带的 API，浏览器和 Node 都能跑。不碰文件：读 vocab/ 里的两份文件、把生成的文件写进目录，是命令行层的事（cli/commands/adapter.mjs），
// `node cli.mjs adapter new` 只是在外面包一层。适配器的约定（工厂、返回的形状、出错的约定）只写在 adapters/README.md，骨架里只指向它，这里不重述。
//
// 注释从签名表生成：每项能力的说明和调用写法不在这里抄一份，生成时从 vocab/capability-signatures.md 的正文里读（parseSignatureDoc），
// 签名表一改，新生成的骨架就跟着改；参数名（骨架里函数的解构）也是从那里的调用写法读出来的。
//
//   parseSignatureDoc(markdown)                  签名表 → { [能力名]: { heading, description: string[], signature: string[] | null, parameters: string[] } }
//                                                只读标题（###）里有 `能力名` 的小节；一个标题里有几个能力名，几个共用这一节（调用写法里的能力名换成各自的）
//   describeCapabilities(names, { vocabulary, signatures })
//                                                → { capabilities: [{ name, declaration, summary, doc: string[], parameters: string[], documented }], unknown: string[] }
//                                                names 里不在能力词表（vocab/capabilities.json）里的放进 unknown，不生成。declaration：只是声明的能力（DECLARED_CAPABILITIES）。
//                                                documented：签名表里有这一项的小节；没有的（词表里有名字，签名表里还没有写法）doc 只有词表里的一句话和一条说明
//   skeletonContext({ name, names, vocabulary, signatures })
//                                                → { context, unknown }：生成骨架要的上下文（形状见下）和不认识的能力名
//   generateModuleSkeleton(context)              module 种类：一个 ES 模块 adapter.mjs，每项能力一个函数，函数体抛 NOT_IMPLEMENTED；只是声明的能力写 true → { files, fillIn }
//   NOT_IMPLEMENTED                              骨架里还没填写的能力抛的错误码 'adapter_not_implemented'（谁抛谁定义：骨架生成的文件抛它，各种类的骨架都用这个码）。
//                                                adapter check --live 看到它，说「还没有实现」，不当成适配器坏了
//
// 骨架的种类：module 在这里；别的种类由官方适配器自己提供（adapters/<名字>/skeleton.mjs 导出 generateSkeleton），命令行层经 cli/adapters.mjs 的 buildSkeleton 找到它们。
// 适配器不能 import 流程层（lib/），所以要用的东西都放在 context 里传给它们：
//   context = {
//     name,                 适配器的名字（目录名）
//     capabilities,         describeCapabilities 的 capabilities，按命令行上给的先后
//     header,               注释头的文字行（不带注释符号）：这是什么、约定在哪、怎么检查、怎么使用。各种类的骨架共用，只在这里写一处，每种骨架在前面加自己的注释符号
//     notImplemented,       NOT_IMPLEMENTED
//   }
// 返回 { files: [{ path, content }]（path 相对目录，用 /，content 是文字）, fillIn: 一句话：填写什么、在哪个文件里 }。
//
// @capability style-instruction
// @capability style-cues
import { DECLARED_CAPABILITIES } from '../protocol/lib/env.mjs';

export const NOT_IMPLEMENTED = 'adapter_not_implemented';

const NL = String.fromCharCode(10);
const NAMES_IN_HEADING = /`([a-z][a-z0-9-]*)`/g;
const CAPABILITY_CALL = /env\.capabilities\['[a-z0-9-]+'\]/;
const PARAMETER_LINE = /^\s+([a-z][a-z0-9_]*),/;
const FENCE = '```';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 签名表里每个标题含能力名的 ### 小节：{ heading, names, lines }。围栏里的 # 不是标题。 */
function sectionsOf(markdown) {
  const sections = [];
  let current = null;
  let inFence = false;
  for (const raw of String(markdown).split(NL)) {
    const line = raw.trimEnd();
    if (!inFence && /^#{1,6}\s/.test(line)) {
      current = null;
      const match = /^###\s+(.*)$/.exec(line);
      const names = match === null ? [] : [...match[1].matchAll(NAMES_IN_HEADING)].map((item) => item[1]);
      if (names.length > 0) {
        current = { heading: match[1].replaceAll('`', ''), names, lines: [] };
        sections.push(current);
      }
      continue;
    }
    if (line.trimStart().startsWith(FENCE)) inFence = !inFence;
    if (current !== null) current.lines.push(line);
  }
  return sections;
}

/** 小节正文的第一段（到空行、围栏、列表为止），去掉加粗的星号。 */
function descriptionOf(lines) {
  let at = 0;
  while (at < lines.length && lines[at].trim() === '') at += 1;
  const paragraph = [];
  for (; at < lines.length; at += 1) {
    const line = lines[at];
    if (line.trim() === '' || line.trimStart().startsWith(FENCE) || /^\s*[-*]\s/.test(line)) break;
    paragraph.push(line.trim().replaceAll('**', ''));
  }
  return paragraph;
}

/** 小节里第一个 js 围栏里的调用写法，没有就是 null。 */
function signatureOf(lines) {
  const start = lines.findIndex((line) => line.trimStart().startsWith(`${FENCE}js`));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line.trimStart().startsWith(FENCE));
  return lines.slice(start + 1, end < 0 ? lines.length : end);
}

/** 调用写法里 ({ … }) 里每行开头的参数名（text、ref_audio……）。 */
function parametersOf(signature) {
  const names = [];
  let inside = false;
  for (const line of signature ?? []) {
    if (!inside) {
      inside = line.includes('({');
      continue;
    }
    if (line.startsWith('})')) break;
    const match = PARAMETER_LINE.exec(line);
    if (match !== null) names.push(match[1]);
  }
  return names;
}

export function parseSignatureDoc(markdown) {
  const found = {};
  for (const section of sectionsOf(markdown)) {
    const signature = signatureOf(section.lines);
    for (const name of section.names) {
      found[name] = {
        heading: section.heading,
        description: descriptionOf(section.lines),
        signature: signature === null ? null : signature.map((line) => line.replace(CAPABILITY_CALL, `env.capabilities['${name}']`)),
        parameters: parametersOf(signature),
      };
    }
  }
  return found;
}

function docOf(name, entry, summary) {
  if (entry === null) {
    return [summary, '', `签名表（vocab/capability-signatures.md）里还没有「${name}」的调用写法：参数和返回值自己定；音频一律是 { bytes, mimeType }。`];
  }
  const lines = [...entry.description];
  if (entry.signature !== null) lines.push('', '调用的样子：', ...entry.signature.map((line) => (line === '' ? '' : `  ${line}`)));
  lines.push('', `规则（参数的意思、返回里可选的字段、出错）见 vocab/capability-signatures.md 的「${entry.heading}」。`);
  return lines;
}

export function describeCapabilities(names, { vocabulary, signatures }) {
  const known = isPlainObject(vocabulary?.capabilities) ? vocabulary.capabilities : {};
  const capabilities = [];
  const unknown = [];
  for (const name of names) {
    if (!Object.hasOwn(known, name)) {
      unknown.push(name);
      continue;
    }
    const entry = Object.hasOwn(signatures, name) ? signatures[name] : null;
    const summary = typeof known[name].summary === 'string' ? known[name].summary : name;
    capabilities.push({
      name,
      declaration: DECLARED_CAPABILITIES.includes(name),
      summary,
      doc: docOf(name, entry, summary),
      parameters: entry === null ? [] : entry.parameters,
      documented: entry !== null,
    });
  }
  return { capabilities, unknown };
}

/** 注释头：各种类的骨架共用的几行。命令的写法只在 adapters/README.md「做自己的适配器」写全，这里只留最短的提示。 */
function headerOf(name) {
  return [
    `${name}：自己的适配器（骨架，由 node cli.mjs adapter new 生成）。`,
    '约定只写在基础部分的 adapters/README.md（工厂的参数、返回的形状、出错的约定、模型名从哪来），这里不重述。',
    '检查：在基础部分的目录里运行 node cli.mjs adapter check <这个目录>（只看结构，不调用模型）；加 --live：每项能力用很短的输入真调一次，核对返回，可能花钱。',
    '使用：把 --adapter <这个目录> 交给 dub、convert、make-pack、fidelity，例如 node cli.mjs dub <包目录> <台本> --out <输出目录> --adapter <这个目录>。',
  ];
}

export function skeletonContext({ name, names, vocabulary, signatures }) {
  const { capabilities, unknown } = describeCapabilities(names, { vocabulary, signatures });
  return { context: { name, capabilities, header: headerOf(name), notImplemented: NOT_IMPLEMENTED }, unknown };
}

// ---------------------------------------------------------------- 种类 module

/** 文字（行的数组）写成 // 注释：每行前面加缩进和 //，空行只留 //。 */
const commented = (lines, indent) => lines.map((line) => `${indent}//${line === '' ? '' : ` ${line}`}`);

export function generateModuleSkeleton({ capabilities, header, notImplemented }) {
  const body = [];
  for (const capability of capabilities) {
    body.push(...commented([`${capability.name}：${capability.doc[0] ?? ''}`, ...capability.doc.slice(1)], '      '));
    if (capability.declaration) {
      body.push(`      '${capability.name}': true,`);
    } else {
      const parameters = capability.parameters.length === 0 ? 'params' : `{ ${capability.parameters.join(', ')} }`;
      body.push(`      '${capability.name}': async (${parameters}) => {`, `        throw notImplemented('${capability.name}');`, '      },');
    }
    body.push('');
  }
  if (body.at(-1) === '') body.pop();
  const lines = [
    ...commented(header, ''),
    '// 填写：把下面每项能力里 throw notImplemented(…) 的那一行换成真的调用；每项能力上面的注释是从 vocab/capability-signatures.md 生成的，写着参数和返回值。',
    'export default function createAdapter({ options, VoicePackError }) {',
    '  // 在这里准备模型：载入权重、建立连接……命令行上 --adapter-option 键=值 给的参数在 options 里。',
    `  const notImplemented = (capability) => new VoicePackError('${notImplemented}', '能力 ' + capability + ' 还没有实现：把这个文件里它的那一行换成真的调用', { details: { capability } });`,
    '  return {',
    '    capabilities: {',
    ...body,
    '    },',
    '  };',
    '}',
    '',
  ];
  return {
    files: [{ path: 'adapter.mjs', content: lines.join(NL) }],
    fillIn: '打开 adapter.mjs，把每项能力里 throw notImplemented(…) 的那一行换成真的调用（参数和返回值写在每项能力上面的注释里）',
  };
}
