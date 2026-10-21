// SPDX-License-Identifier: Apache-2.0
//
// 基础部分的命令行入口：在基础部分的根目录里运行 node cli.mjs <命令> [参数...]。
// 带两层命令：协议核心的命令（protocol/cli/commands/）和流程层的命令（cli/commands/），名字不能重复。
// 只有协议核心、没有基础部分时，用 node protocol/cli.mjs（命令少一些，只有核心层的）。
// 完整包里有两份协议核心，用基础部分里这一份：从这里进，加载的就是基础部分自己的 protocol/。
import { main } from './protocol/cli/runner.mjs';
import { createEnvironment } from './cli/environment.mjs';

process.exitCode = await main({
  argv: process.argv.slice(2),
  commandDirs: [new URL('./protocol/cli/commands/', import.meta.url), new URL('./cli/commands/', import.meta.url)],
  programName: 'node cli.mjs',
  createEnvironment,
});
