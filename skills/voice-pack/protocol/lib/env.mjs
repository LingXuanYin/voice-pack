// SPDX-License-Identifier: Apache-2.0
//
// 注入的运行环境：库不绑定任何模型、不直接联网、不直接起进程，要什么都向调用方给的运行环境要。
// 运行环境是一个对象，有三个容器（形状和取用方式的说明见 protocol/README.md「运行环境」一节）：
//
//   env.capabilities   所需能力。键是能力词表（vocab/capabilities.json）里的名字，值是这项能力的实现（函数，库一律 await 它的返回值）。
//                      每项能力的调用签名写在 vocab/capability-signatures.md，用到它的模块在文件头 JSDoc 里加一行
//                      `@capability <能力名>` 指过去；这里只管取用。找某项能力用在哪：grep -rn "@capability text-to-speech" .
//   env.fetch          所有网络读取都走它（补全、核对外部资源）。形状同标准 fetch(input, init)。省略表示没有网络。
//   env.runtimes       命令行工具，例如 ffmpeg。键是工具名，值是运行它的实现；签名同样写在引入它的模块文件头，
//                      用 `@runtime <名字>`。省略表示没有。
//
// 缺了就抛 VoicePackError：
//   capability_missing    缺所需能力。details.capability 是缺的那一项的名字。
//   runtime_missing       缺命令行工具。details.runtime 是缺的那一项的名字。
//   fetch_missing         环境没有提供网络读取。
//   environment_invalid   环境本身不合格（不是对象，或没有 capabilities 容器）。details.field 是出问题的字段。
//
// 只有用到这项能力的功能才取它，所以缺一项只让用到它的功能报错，别的功能照常。
// 一项能力有没有、没有也能做的功能（例如环境有 style-instruction 才传语气说明、有 text-generation 才让模型来判断）问 hasCapability，
// 不抛错；缺了就不能做的功能用 requireCapability。两者对「有」的判断完全一致。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from './errors.mjs';

/**
 * 只是声明的能力：不是函数，值写 true。环境提供它，表示别的能力会按它说的做（签名和理由见 vocab/capability-signatures.md「怎么念」）。
 * 用 hasCapability 问有没有，不用 requireCapability 去取（没有函数可取）。适配器的检查（lib/adapter-check.mjs）、骨架生成（lib/adapter-skeleton.mjs）
 * 和适配器本身（约定见 adapters/README.md「只是声明的能力」）都按这一份名单认，名单只在这里写。
 */
export const DECLARED_CAPABILITIES = Object.freeze(['style-instruction']);

const hasOwn = (obj, name) => Object.prototype.hasOwnProperty.call(obj, name);
const isContainer = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// 环境把某项设成 undefined、null、false，都表示它没有这项。
const isProvided = (value) => value !== undefined && value !== null && value !== false;

function assertEnvironment(env) {
  if (!isContainer(env) || !isContainer(env.capabilities)) {
    throw new VoicePackError(
      'environment_invalid',
      '运行环境必须是一个对象，并且带有 capabilities 对象（可以是空的）',
      { details: { field: 'capabilities' } },
    );
  }
}

function assertName(name, what) {
  if (typeof name !== 'string' || name === '') throw new TypeError(`${what}的名字必须是非空字符串，收到 ${JSON.stringify(name)}`);
}

/**
 * 从环境里取一项所需能力。
 * @param {object} env 注入的运行环境
 * @param {string} name 能力词表里的名字，例如 `text-to-speech`
 * @returns 环境提供的实现，原样给出（调用签名由引入这项能力的模块定）
 * @throws {VoicePackError} capability_missing（点名缺的能力）、environment_invalid
 */
export function requireCapability(env, name) {
  assertName(name, '所需能力');
  assertEnvironment(env);
  if (hasOwn(env.capabilities, name) && isProvided(env.capabilities[name])) return env.capabilities[name];
  throw new VoicePackError(
    'capability_missing',
    `运行环境没有提供所需能力 ${name}：用到它的功能不能运行，其他功能照常`,
    { details: { capability: name } },
  );
}

/**
 * 环境有没有这项能力：不抛错，只回答有或没有。「有」的认法和 requireCapability 一样（undefined、null、false 都算没有）。
 * 给「有就多做一步、没有也不是错」的开关用，例如环境有 style-instruction 才把配音指引通过 instructions 传给模型；
 * 用到了就必须有的能力，用 requireCapability，缺了才会点名报错。
 * @param {object} env 注入的运行环境
 * @param {string} name 能力词表里的名字
 * @returns {boolean}
 * @throws {VoicePackError} environment_invalid（环境本身不合格）
 */
export function hasCapability(env, name) {
  assertName(name, '所需能力');
  assertEnvironment(env);
  return hasOwn(env.capabilities, name) && isProvided(env.capabilities[name]);
}

/**
 * 从环境里取一个命令行工具的运行实现（例如 ffmpeg）。
 * @throws {VoicePackError} runtime_missing、environment_invalid
 */
export function requireRuntime(env, name) {
  assertName(name, '运行时');
  assertEnvironment(env);
  const runtimes = env.runtimes;
  if (isContainer(runtimes) && hasOwn(runtimes, name) && isProvided(runtimes[name])) return runtimes[name];
  throw new VoicePackError(
    'runtime_missing',
    `运行环境没有提供运行时 ${name}：用到它的功能不能运行，其他功能照常`,
    { details: { runtime: name } },
  );
}

/**
 * 取环境的网络读取（形状同标准 fetch）。
 * @throws {VoicePackError} fetch_missing、environment_invalid
 */
export function requireFetch(env) {
  assertEnvironment(env);
  if (typeof env.fetch === 'function') return env.fetch;
  throw new VoicePackError('fetch_missing', '运行环境没有提供网络读取（env.fetch）：需要联网的功能不能运行');
}
