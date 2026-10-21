// SPDX-License-Identifier: Apache-2.0
//
// 命令行层接适配器的统一入口：命令行上所有的适配器（官方的、自己的）都从这里进来，合并规则只在这里写一处。
// 适配器是什么、工厂怎么写、返回什么、出错怎么报，约定只写在 adapters/README.md，这里只实现「命令行怎么把它们接进命令」。
// 通用层（protocol/、lib/、tools/、cli/）里只有这个文件碰 adapters/ 目录，别处不直接 import 任何一个适配器。
//
// 命令行上怎么给（--adapter、--adapter-option、官方适配器在 adapter.json 里声明的简写和参数）：写法只在 adapters/README.md「命令行上怎么给」，这里实现它。
// 加一个官方适配器只加目录 adapters/<名字>/（adapter.mjs，可选 adapter.json），不改别的文件。
//
// 合并（applyAdapters）：这是合并规则唯一的正本。适配器按给的先后一个一个接进命令已有的环境：后给的盖过先给的，命令行上明说的盖过命令自己的默认。每个适配器的工厂拿到的 env 是「命令已有的加上前面的适配器」，
// 它返回的 capabilities、runtimes 并进去，同名的盖过已有的；它给了 fetch 就换成它的。billing、limits 和 previewCard 不进环境，留在返回的 adapters 里给命令用
// （费用说明、一次合成的字数上限、分享文件的预览卡片上的产品名和入口）。
//
// 信任：适配器在本进程里直接运行，不隔离，不让用户确认——和包里的脚本一样。用不用、用哪个适配器，是命令行上这个人的决定。
//
// 导出：
//   ADAPTER_USAGE                         命令用法里「接适配器」的那一段（按官方适配器的 adapter.json 生成）
//   officialAdapterNames()                官方适配器的名字，按名字排
//   takeAdapterArguments(args)            从命令的参数里取走适配器的参数 → { rest, requests: [{ spec, options }], problem? }；problem 是用法错误的说明
//   loadAdapter(ctx, env, request)        加载一个适配器 → { adapter, label, spec, file }
//   applyAdapters(ctx, env, requests)     按先后接进环境 → { env, adapters: [{ label, spec, file, billing?, limits?, previewCard? }] }
//   billingSentence(adapters)             费用说明的开头一句（给了 billing 的适配器各一句，「要……，也要……」，不带句末的标点），没有就是 null
//   maxCharsOf(adapters)                  一次合成最多多少个字：最后一个给了 limits.maxChars 的适配器的，没有就是 undefined
//   previewCardOf(adapters)               分享文件的预览卡片要写的产品名和入口：最后一个给了 previewCard 的适配器的，没有就是 undefined
//   environmentName(adapters)             验证记录里「在哪个环境测的」：适配器的名字，几个用 + 连起来，没有就是 null
//   describeRequests(requests)            把适配器的参数写回命令行的样子（补做提示用）
//   quoteArgument(text)                   把一个参数写回命令行的样子：里面有空白或引号就加双引号（给人看的提示用）
//   skeletonKinds()                       `adapter new` 能生成的骨架种类：'module'，加上提供了骨架生成器（adapters/<名字>/skeleton.mjs）的官方适配器，按名字排
//   buildSkeleton(kind, context)          生成一个骨架 → { files: [{ path, content }], fillIn }；context 的形状在 lib/adapter-skeleton.mjs 的文件头。
//                                         module 由 lib/adapter-skeleton.mjs 生成；别的种类由官方适配器的 skeleton.mjs（导出 generateSkeleton）生成，这里核对它返回的形状
//   cleanup 不在这里：适配器占着的资源（例如进程适配器起的程序）由适配器自己在命令结束时收，约定见 adapters/README.md。
//
// 抛出的错误（VoicePackError，细节在抛出处写明）：
//   adapter_invalid     适配器加载不了或写坏了。details: { spec, file?, reason }，reason：
//                         load            模块找不到或加载失败（语法错误……），cause 里是底层错误；给的是目录时，里面没有 adapter.mjs 也是这个
//                         not_function    没有默认导出的函数（也没有导出名叫 createAdapter 的函数）
//                         factory_failed  工厂抛了错（工厂自己抛的 VoicePackError 不包，原样往上抛），cause 里是它抛的错
//                         shape           返回的不是约定的形状。details.problems 是 lib/adapter-check.mjs 的 checkAdapterShape 给的问题
//                         manifest        官方适配器的 adapter.json 写坏了
//                         skeleton        官方适配器的骨架生成器（skeleton.mjs）加载不了、没有导出 generateSkeleton、抛了错，或者返回的形状不对。details.problem 说明哪里不对
//   adapter_not_found   给的是名字，adapters/ 里没有这个官方适配器（或者要生成骨架的种类没有生成器）。details: { name, available }。
//                       名字是退役的官方适配器（下面的 RETIRED）时，说明里写它现在在哪、怎么用路径接进来，details 多一个 retired: true。
//                       适配器的工厂调 use(名字) 时，名字不是现有的官方适配器（写法不对的，例如带路径，也算）是这个错：名字可能是适配器从命令行参数里转来的。
//                       use 的名字根本不是字符串，是写适配器的人用错了接口：抛 TypeError，外面包成 adapter_invalid 的 factory_failed。
// 另外适配器工厂自己抛的错原样往上（它们的 code 写在各自适配器的文件头）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VoicePackError, isVoicePackError } from '../protocol/lib/errors.mjs';
import { ADAPTER_KEYS, checkAdapterShape } from '../lib/adapter-check.mjs';
import { generateModuleSkeleton } from '../lib/adapter-skeleton.mjs';
import { isPlainObject } from './input.mjs';

const ADAPTERS_DIR = fileURLToPath(new URL('../adapters/', import.meta.url));
const FACTORY_FILE = 'adapter.mjs';
const MANIFEST_FILE = 'adapter.json';
const SKELETON_FILE = 'skeleton.mjs';
const MODULE_KIND = 'module';
const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const OPTION_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

// 退役的官方适配器：1.x 里在 adapters/ 下，2.0.0 起搬出去了。照老文档写它的名字、简写或专有参数的人，
// 报错时要知道它现在在哪、怎么用路径接进来（--adapter <目录>）。只用来写报错，不加载任何东西；名字、简写、参数只在这里写。
const RETIRED = [
  {
    name: 'cohub',
    flags: ['--cohub', '--space'],
    moved: 'Cohub 适配器从 2.0.0 起不在 voice-pack 里了，归 Voice Studio：在 Voice Studio 的 skill 里，目录 .agents/skills/voice-studio/adapters/cohub/',
    how: '用路径接进来：--adapter <那个目录>；Space 用 --adapter-option space=<Space id>，或者设环境变量 COHUB_SPACE_ID',
  },
];
const retiredNamed = (name) => RETIRED.find((entry) => entry.name === name);

// ---------------------------------------------------------------- 官方适配器

function readManifest(name, dir) {
  const file = path.join(dir, MANIFEST_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {}; // adapter.json 是可选的
  }
  const broken = (message, cause) => new VoicePackError('adapter_invalid', `官方适配器 ${name} 的 ${MANIFEST_FILE} 写坏了：${message}`, { details: { spec: name, file, reason: 'manifest' }, ...(cause === undefined ? {} : { cause }) });
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (cause) {
    throw broken(`不是合法的 JSON（${cause.message}）`, cause);
  }
  if (!isPlainObject(manifest)) throw broken('要是对象');
  if (manifest.summary !== undefined && typeof manifest.summary !== 'string') throw broken('summary 要是字符串');
  if (manifest.shorthand !== undefined && typeof manifest.shorthand !== 'boolean') throw broken('shorthand 要是 true 或 false');
  if (manifest.flags !== undefined) {
    if (!isPlainObject(manifest.flags)) throw broken('flags 要是对象：{ "--参数": "选项的键" }');
    for (const [flag, key] of Object.entries(manifest.flags)) {
      if (!/^--[a-z][a-z0-9-]*$/.test(flag) || typeof key !== 'string' || !OPTION_KEY_RE.test(key)) throw broken(`flags 里的 ${JSON.stringify(flag)}: ${JSON.stringify(key)} 不合约定（参数是 --小写字母开头的名字，选项的键是字母开头的字母、数字、下划线）`);
    }
  }
  return manifest;
}

/** adapters/ 下的官方适配器：有 adapter.mjs 的目录，按名字排。 */
function officialAdapters() {
  let entries;
  try {
    entries = fs.readdirSync(ADAPTERS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !NAME_RE.test(entry.name)) continue;
    const dir = path.join(ADAPTERS_DIR, entry.name);
    const file = path.join(dir, FACTORY_FILE);
    if (!fs.existsSync(file)) continue;
    found.push({ name: entry.name, dir, file, manifest: readManifest(entry.name, dir) });
  }
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function officialAdapterNames() {
  return officialAdapters().map((adapter) => adapter.name);
}

/** 命令的用法里「接适配器」的那一段，按官方适配器的 adapter.json 生成：简写和专有参数都在里面。 */
function usageOf(adapters) {
  const parts = ['[--adapter <名字|模块文件>]...', '[--adapter-option <键=值>]...'];
  for (const { name, manifest } of adapters) {
    const flags = Object.entries(manifest.flags ?? {}).map(([flag, key]) => `[${flag} <${key}>]`).join(' ');
    if (manifest.shorthand === true) parts.push(`[--${name}${flags === '' ? '' : ` ${flags}`}]`);
    else if (flags !== '') parts.push(`[--adapter ${name} ${flags}]`);
  }
  return parts.join(' ');
}
export const ADAPTER_USAGE = usageOf(officialAdapters());

// ---------------------------------------------------------------- 命令行参数

/**
 * 从命令的参数里取走适配器的参数（--adapter、--adapter-option、官方适配器声明的简写和专有参数），其余原样留给命令。
 * @param {string[]} args
 * @returns {{ rest: string[], requests: { spec: string, options: Record<string, string> }[], problem?: string }}
 *   problem：用法错误的说明（命令据此退出 2）。有 problem 时 rest、requests 只是读到的那一部分，不能用。
 */
export function takeAdapterArguments(args) {
  const official = officialAdapters();
  const shorthand = new Map();
  const declared = new Map();
  for (const adapter of official) {
    if (adapter.manifest.shorthand === true) shorthand.set(`--${adapter.name}`, adapter.name);
    for (const [flag, key] of Object.entries(adapter.manifest.flags ?? {})) declared.set(flag, { adapter: adapter.name, key });
  }
  const rest = [];
  const requests = [];
  const sets = []; // { flag, owner（名字，--adapter-option 是 null）, key, value, position（它出现时已有几个适配器） }
  const fail = (problem) => ({ rest, requests, problem });
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--adapter') {
      const value = args[++index];
      if (value === undefined || value === '') return fail('--adapter 后面要给适配器的名字，或者适配器模块的路径');
      requests.push({ spec: value, options: {} });
    } else if (shorthand.has(arg)) {
      requests.push({ spec: shorthand.get(arg), options: {} });
    } else if (arg === '--adapter-option') {
      const value = args[++index];
      if (value === undefined) return fail('--adapter-option 后面要给 键=值');
      const at = value.indexOf('=');
      const key = at < 0 ? '' : value.slice(0, at);
      if (!OPTION_KEY_RE.test(key)) return fail(`--adapter-option 要写成 键=值，键是字母开头的字母、数字、下划线，收到 ${JSON.stringify(value)}`);
      sets.push({ flag: arg, owner: null, key, value: value.slice(at + 1), position: requests.length });
    } else if (declared.has(arg)) {
      const value = args[++index];
      if (value === undefined) return fail(`${arg} 后面要给一个值`);
      const { adapter, key } = declared.get(arg);
      sets.push({ flag: arg, owner: adapter, key, value, position: requests.length });
    } else if (RETIRED.some((entry) => entry.flags.includes(arg))) {
      const entry = RETIRED.find((item) => item.flags.includes(arg));
      return fail(`${arg} 是退役的官方适配器 ${entry.name} 的参数。${entry.moved}。${entry.how}`);
    } else {
      rest.push(arg);
    }
  }
  for (const entry of sets) {
    let target;
    if (entry.owner === null) {
      target = requests[entry.position - 1];
      if (target === undefined) return fail('--adapter-option 要跟在 --adapter <名字|模块文件> 后面（给前一个适配器的参数），前面还没有适配器');
    } else {
      target = requests.slice(0, entry.position).findLast((request) => request.spec === entry.owner) ?? requests.slice(entry.position).find((request) => request.spec === entry.owner);
      if (target === undefined) {
        const how = shorthand.has(`--${entry.owner}`) ? `--${entry.owner}（或 --adapter ${entry.owner}）` : `--adapter ${entry.owner}`;
        return fail(`${entry.flag} 是 ${entry.owner} 适配器的参数，命令行上要有 ${how}`);
      }
    }
    if (Object.hasOwn(target.options, entry.key)) return fail(`适配器 ${target.spec} 的参数 ${entry.key} 给了两次（${entry.flag}）`);
    target.options[entry.key] = entry.value;
  }
  return { rest, requests };
}

/** 把一个参数写回命令行的样子（给人看）：里面有空白或引号就加双引号。 */
export const quoteArgument = (text) => (/[\s"']/.test(text) ? `"${text.replaceAll('"', '\\"')}"` : text);
const quoted = quoteArgument;

/** 把适配器的参数写回命令行的样子（给人看，补做的提示里用）：有简写和声明的参数就用它们，剩下的用 --adapter 和 --adapter-option。 */
export function describeRequests(requests) {
  const official = new Map(officialAdapters().map((adapter) => [adapter.name, adapter]));
  const parts = [];
  for (const { spec, options } of requests) {
    const adapter = official.get(spec);
    const flagOf = new Map(Object.entries(adapter?.manifest.flags ?? {}).map(([flag, key]) => [key, flag]));
    parts.push(adapter?.manifest.shorthand === true ? `--${spec}` : `--adapter ${quoted(spec)}`);
    for (const [key, value] of Object.entries(options)) parts.push(flagOf.has(key) ? `${flagOf.get(key)} ${quoted(value)}` : `--adapter-option ${quoted(`${key}=${value}`)}`);
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------- 加载

const stem = (file) => path.basename(file, path.extname(file));

/** 给的是名字还是路径：名字是小写字母、数字、连字符，不含路径分隔符和点。 */
const isOfficialName = (spec) => NAME_RE.test(spec);

function notFound(name, official, { shown = name, hint = `自己的适配器要给文件或目录的路径，例如 --adapter ./${name}` } = {}) {
  const available = official.map((adapter) => adapter.name);
  const retired = retiredNamed(name);
  return new VoicePackError(
    'adapter_not_found',
    `没有叫 ${shown} 的官方适配器（有：${available.join('、') || '一个都没有'}）。${retired ? `${retired.moved}。${retired.how}` : hint}`,
    { details: { name, available, ...(retired ? { retired: true } : {}) } },
  );
}

/** 把 spec 解析成要加载的文件。 */
function resolveSpec(ctx, spec) {
  if (isOfficialName(spec)) {
    const official = officialAdapters();
    const found = official.find((adapter) => adapter.name === spec);
    if (found === undefined) throw notFound(spec, official);
    return { file: found.file, label: found.name, dir: ctx.cwd };
  }
  const resolved = path.resolve(ctx.cwd, spec);
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(resolved).isDirectory();
  } catch {
    // 不存在：当作文件，加载时报 load
  }
  if (isDirectory) return { file: path.join(resolved, FACTORY_FILE), label: path.basename(resolved), dir: resolved };
  const dir = path.dirname(resolved);
  return { file: resolved, label: path.basename(resolved) === FACTORY_FILE ? path.basename(dir) : stem(resolved), dir };
}

/**
 * 加载一个适配器：找到文件，调工厂，核对返回的形状。
 * @param {{ cwd: string }} ctx 命令的上下文（要 cwd）
 * @param {object} env 命令此刻已有的环境（含前面的适配器），只读着给工厂看
 * @param {{ spec: string, options?: Record<string, unknown> }} request
 * @returns {Promise<{ adapter: object, label: string, spec: string, file: string }>}
 * @throws {VoicePackError} adapter_invalid、adapter_not_found，以及工厂自己抛的 VoicePackError
 */
export async function loadAdapter(ctx, env, request) {
  const { spec } = request;
  const { file, label, dir } = resolveSpec(ctx, spec);
  const invalid = (reason, message, extra = {}) => new VoicePackError('adapter_invalid', `适配器 ${spec}：${message}`, { details: { spec, file, reason, ...(extra.details ?? {}) }, ...(extra.cause === undefined ? {} : { cause: extra.cause }) });
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (cause) {
    throw invalid('load', `加载不了（${file}：${cause?.message ?? cause}）`, { cause });
  }
  const factory = mod.default ?? mod.createAdapter;
  if (typeof factory !== 'function') throw invalid('not_function', `要默认导出一个函数（或者导出名叫 createAdapter 的函数），它返回 { ${ADAPTER_KEYS.join(', ')} }`);
  const use = async (name, options = {}) => {
    // 名字不是字符串：写适配器的人用错了接口，是 TypeError（它在工厂里抛出，外面包成 adapter_invalid 的 factory_failed）。
    // 是字符串但不是现有的官方适配器（写法不对的也算）：名字可能是适配器从命令行参数里转来的，报 adapter_not_found（adapters/README.md 里 use 那一行写的就是这样）。
    if (typeof name !== 'string') throw new TypeError(`use 的第一个参数要是官方适配器的名字（字符串），收到 ${name === null ? 'null' : typeof name}`);
    const official = officialAdapters();
    if (!official.some((adapter) => adapter.name === name)) throw notFound(name, official, { shown: JSON.stringify(name), hint: 'use 只加载官方适配器，名字是小写字母、数字、连字符' });
    return (await loadAdapter({ ...ctx, cwd: ctx.cwd }, env, { spec: name, options, dir })).adapter;
  };
  let adapter;
  try {
    adapter = await factory({ cwd: ctx.cwd, dir: request.dir ?? dir, env, options: request.options ?? {}, use, VoicePackError });
  } catch (cause) {
    if (isVoicePackError(cause)) throw cause; // 工厂自己抛的有 code 的错，比「函数抛了错」更有用：原样往上
    throw invalid('factory_failed', `函数抛了错（${cause?.message ?? cause}）`, { cause });
  }
  const shape = checkAdapterShape(adapter);
  if (!shape.ok) {
    const first = shape.issues.filter((issue) => issue.level === 'error');
    throw invalid('shape', first.map((issue) => issue.message).join('；'), { details: { problems: shape.issues } });
  }
  return { adapter, label, spec, file };
}

/**
 * 按给的先后把适配器接进环境：后给的盖过先给的，也盖过命令已有的同名项。
 * @returns {Promise<{ env: object, adapters: { label: string, spec: string, file: string, billing?: string, limits?: object, previewCard?: object }[] }>}
 */
export async function applyAdapters(ctx, env, requests) {
  let current = env;
  const adapters = [];
  for (const request of requests) {
    const { adapter, label, spec, file } = await loadAdapter(ctx, current, request);
    current = {
      ...current,
      capabilities: { ...current.capabilities, ...adapter.capabilities },
      runtimes: { ...current.runtimes, ...adapter.runtimes },
      ...(adapter.fetch === undefined ? {} : { fetch: adapter.fetch }),
    };
    adapters.push({
      label, spec, file,
      ...(adapter.billing === undefined ? {} : { billing: adapter.billing }),
      ...(adapter.limits === undefined ? {} : { limits: adapter.limits }),
      ...(adapter.previewCard === undefined ? {} : { previewCard: adapter.previewCard }),
    });
  }
  return { env: current, adapters };
}

// ---------------------------------------------------------------- 命令用的几个小函数

/** 费用说明的开头一句：给了 billing 的适配器各一句，用「，也」连起来（「要……，也要……」）；不带句末的标点，命令自己接。没有适配器给 billing 就是 null（不用说）。 */
export function billingSentence(adapters) {
  const sentences = adapters.filter((adapter) => typeof adapter.billing === 'string').map((adapter) => `要${adapter.billing}`);
  return sentences.length === 0 ? null : sentences.join('，也');
}

/** 一次合成最多多少个字：最后一个给了 limits.maxChars 的适配器的（后给的盖过先给的）；都没给是 undefined。 */
export function maxCharsOf(adapters) {
  return adapters.findLast((adapter) => adapter.limits?.maxChars !== undefined)?.limits.maxChars;
}

/** 验证记录里「在哪个环境测的」：适配器的名字，几个用 + 连起来；没有适配器是 null。 */
export function environmentName(adapters) {
  return adapters.length === 0 ? null : adapters.map((adapter) => adapter.label).join('+');
}

/**
 * 分享文件的预览卡片要写的产品名和两个入口：最后一个给了 previewCard 的适配器的（后给的盖过先给的，整份换，不一项一项拼）；都没给是 undefined（卡片上没有产品入口）。
 * 返回的形状同核心层 buildShareFile 的 card 选项（{ productName?, links?: { open?, make? } }），链接里的 {id} 由它换成包 ID。
 */
export function previewCardOf(adapters) {
  return adapters.findLast((adapter) => adapter.previewCard !== undefined)?.previewCard;
}

// ---------------------------------------------------------------- 骨架（adapter new 用）

/** 能生成的骨架种类：module，加上有骨架生成器的官方适配器。 */
export function skeletonKinds() {
  const official = officialAdapters().filter((adapter) => fs.existsSync(path.join(adapter.dir, SKELETON_FILE))).map((adapter) => adapter.name);
  return [MODULE_KIND, ...official];
}

const isSkeleton = (value) => isPlainObject(value)
  && typeof value.fillIn === 'string'
  && Array.isArray(value.files)
  && value.files.length > 0
  && value.files.every((file) => isPlainObject(file) && typeof file.path === 'string' && file.path !== '' && typeof file.content === 'string');

/**
 * 生成一个骨架。
 * @param {string} kind skeletonKinds() 里的一个
 * @param {object} context 形状见 lib/adapter-skeleton.mjs 的文件头
 * @returns {Promise<{ files: { path: string, content: string }[], fillIn: string }>}
 */
export async function buildSkeleton(kind, context) {
  if (kind === MODULE_KIND) return generateModuleSkeleton(context);
  const official = officialAdapters().find((adapter) => adapter.name === kind && fs.existsSync(path.join(adapter.dir, SKELETON_FILE)));
  if (official === undefined) {
    const available = skeletonKinds();
    throw new VoicePackError('adapter_not_found', `没有 ${kind} 这一种骨架（有：${available.join('、')}）`, { details: { name: kind, available } });
  }
  const file = path.join(official.dir, SKELETON_FILE);
  const broken = (problem, cause) => new VoicePackError('adapter_invalid', `官方适配器 ${kind} 的骨架生成器（${SKELETON_FILE}）：${problem}`, { details: { spec: kind, file, reason: 'skeleton', problem }, ...(cause === undefined ? {} : { cause }) });
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (cause) {
    throw broken(`加载不了（${cause?.message ?? cause}）`, cause);
  }
  if (typeof mod.generateSkeleton !== 'function') throw broken('要导出函数 generateSkeleton');
  let skeleton;
  try {
    skeleton = await mod.generateSkeleton(context);
  } catch (cause) {
    throw broken(`抛了错（${cause?.message ?? cause}）`, cause);
  }
  if (!isSkeleton(skeleton)) throw broken('返回的要是 { files: [{ path, content }]（至少一个文件，content 是文字）, fillIn: 字符串 }');
  return skeleton;
}
