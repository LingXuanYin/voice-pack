// SPDX-License-Identifier: Apache-2.0
//
// 核心层的命令行入口：在这个部分的根目录里运行 node protocol/cli.mjs <命令> [参数...]。
// 只有协议核心时也能跑：角色部分的包里只有这一层，补全（取回官方基础部分）就靠它。
// 命令放在 protocol/cli/commands/，一个命令一个文件，约定见 protocol/cli/runner.mjs 的文件头。
import { main } from './cli/runner.mjs';

process.exitCode = await main({
  argv: process.argv.slice(2),
  commandDirs: [new URL('./cli/commands/', import.meta.url)],
  programName: 'node protocol/cli.mjs',
});
