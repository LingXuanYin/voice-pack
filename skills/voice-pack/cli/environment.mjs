// SPDX-License-Identifier: Apache-2.0
//
// 基础部分的命令行给命令的运行环境：核心层的 Node 环境（本机的 fetch，没有所需能力），再加上本机 PATH 上找得到的命令行工具（node-runtimes.mjs）。
// 以后要给命令接别的东西，在这里往返回的对象里加，cli.mjs 不用改。模型从适配器接进来，走命令行上的 --adapter（cli/adapters.mjs），不在这里。
import { createNodeEnvironment } from '../protocol/cli/runner.mjs';
import { createNodeRuntimes } from './node-runtimes.mjs';

export function createEnvironment() {
  const env = createNodeEnvironment();
  return { ...env, runtimes: { ...env.runtimes, ...createNodeRuntimes() } };
}
