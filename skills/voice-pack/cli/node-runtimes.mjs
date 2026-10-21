// SPDX-License-Identifier: Apache-2.0
//
// 命令行层给库的运行时（env.runtimes）：在本机的 PATH 上找命令行工具，包成库要的签名。
// 库（protocol/lib、tools、lib、adapters）不碰 node:child_process 这类东西，它们向注入的运行环境要运行时；这里是 Node 的那一份实现。
//
// ffmpeg 的签名由第一个调用它的模块定，见 tools/audio-decode.mjs 文件头的 `@runtime ffmpeg`：
//   async (args: string[], input: Uint8Array) => Uint8Array
//   参数里恰好等于 '{input}' 的一项换成输入文件，'{output}' 的换成输出文件。
// 这里的实现：输入写进一个新建的临时目录里的文件，输出也读回自这个目录，用完删掉整个目录（只删自己建的那一个）。
// 用文件而不是管道，因为 m4a 这类格式要往回读，管道读不了。参数数组直接交给 execFile，不经 shell，所以文件名和参数里的特殊字符不会被当成命令。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const STDERR_CAP = 4 * 1024 * 1024;

/**
 * 在 PATH 上找一个可以直接运行的程序，返回完整路径，找不到返回 null。
 * Windows 上只认 .exe 和 .com（不经 shell 运行不了 .cmd、.bat）；别的系统要求文件存在、是普通文件、有执行权限。
 * @param {string} name 程序名，不带扩展名，例如 `ffmpeg`
 * @param {{ pathEnv?: string, pathExt?: string, platform?: string }} [options] 默认取当前进程的 PATH、PATHEXT 和系统；测试里用来换成别的 PATH
 */
export function findExecutable(name, { pathEnv = process.env.PATH ?? '', pathExt = process.env.PATHEXT, platform = process.platform } = {}) {
  const windows = platform === 'win32';
  const exts = windows
    ? (pathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter((e) => e === '.exe' || e === '.com')
    : [''];
  if (windows && exts.length === 0) exts.push('.exe');
  for (const raw of pathEnv.split(path.delimiter)) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (dir === '') continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (!windows) fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {
        // 不存在、不能访问：看下一个
      }
    }
  }
  return null;
}

const tail = (text) => String(text ?? '').trim().slice(-400);

function runFfmpeg(executable, args, input, timeoutMs) {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'vp-ffmpeg-')).then(async (dir) => {
    try {
      const inputFile = path.join(dir, 'input.bin');
      const outputFile = path.join(dir, 'output.bin');
      await fs.promises.writeFile(inputFile, input);
      const argv = ['-y', ...args.map((a) => (a === '{input}' ? inputFile : a === '{output}' ? outputFile : a))];
      await new Promise((resolve, reject) => {
        execFile(executable, argv, { timeout: timeoutMs, maxBuffer: STDERR_CAP, windowsHide: true }, (error, _stdout, stderr) => {
          if (!error) return resolve();
          if (error.killed) return reject(new Error(`ffmpeg 超过 ${Math.round(timeoutMs / 1000)} 秒没有结束，已被结束`, { cause: error }));
          if (error.code === 'ENOENT') return reject(new Error(`ffmpeg 启动不了（${executable}）：${error.message}`, { cause: error }));
          reject(new Error(`ffmpeg 退出码 ${error.code}：${tail(stderr) || error.message}`, { cause: error }));
        });
      });
      let output;
      try {
        output = await fs.promises.readFile(outputFile);
      } catch (cause) {
        throw new Error('ffmpeg 正常结束了，但没有生成输出文件', { cause });
      }
      return new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
}

/**
 * 本机能提供的运行时：PATH 上找得到 ffmpeg，就有 ffmpeg；找不到，容器里就没有这一项（库用到时抛 runtime_missing）。
 * @param {{ pathEnv?: string, timeoutMs?: number }} [options] pathEnv：换掉 PATH（测试里用空串模拟没有 ffmpeg）；timeoutMs：单次调用的上限，默认 5 分钟
 * @returns {{ ffmpeg?: (args: string[], input: Uint8Array) => Promise<Uint8Array> }}
 */
export function createNodeRuntimes({ pathEnv, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const runtimes = {};
  const ffmpeg = findExecutable('ffmpeg', pathEnv === undefined ? {} : { pathEnv });
  if (ffmpeg) runtimes.ffmpeg = (args, input) => runFfmpeg(ffmpeg, args, input, timeoutMs);
  return runtimes;
}
