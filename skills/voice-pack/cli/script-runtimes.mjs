// SPDX-License-Identifier: Apache-2.0
//
// 命令行层给包里的脚本的运行时（env.runtimes 里放的东西）：在本机直接运行包里登记的脚本。Node 专有（起进程），所以放在命令行层。
// 库（lib/pack-script.mjs）不起进程，它向注入的运行环境要运行时；这里是 Node 的那一份实现。
//
// 运行环境完全信任脚本——直接运行，不让用户确认，不隔离，不限制权限。所以这里没有「问一句」，也没有沙箱：
// 脚本就是以本进程的身份、在包目录里、用本机装的解释器运行的普通程序。要不要信任一个包，是装它之前的事（安全靠社区的审核）。
//
// 一个运行时是一个函数（签名由 lib/pack-script.mjs 的文件头定）：
//   async ({ entry, input }) => string      entry 是清单里登记的入口（相对包目录，用 /），input 写进脚本的标准输入，返回脚本写到标准输出的文字
// 怎么运行：解释器 <入口的完整路径>，当前目录是包目录，标准输入是 input，不经 shell（参数数组直接交给系统，文件名里的特殊字符不会被当成命令）。
//   解释器：node 就是正在运行的这个 node（一定有）；python 先找 python3、再找 python；别的名字就在 PATH 上找同名的程序（findExecutable 的规则）。
//   找不到解释器，这个名字就不在容器里，用到它的功能会抛 runtime_missing（核心层 requireRuntime 的报法）。
//   失败：起不来、退出码不是 0、超时、输出太大，都抛 Error，说明里有原因；退出码非零时带着标准错误的末尾（最多 400 个字符）。
//   不带输入：输入里可能有音频，不往错误里放。
//
// 超时和输出上限默认 10 分钟、256 MiB（音频钩子的输出是 Base64 的音频）。超时只结束它起的那个进程（拿着自己的 PID），不按名字找别的进程；
// 脚本自己再起的子进程不管。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findExecutable } from './node-runtimes.mjs';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const STDERR_KEEP = 64 * 1024;
const TAIL = 400;

/** 一个运行时名字要找哪些程序名（按先后）。node 不走这里。 */
export function interpreterNames(name) {
  return name === 'python' ? ['python3', 'python'] : [name];
}

function locate(name, pathEnv) {
  if (name === 'node') return process.execPath;
  for (const candidate of interpreterNames(name)) {
    const found = findExecutable(candidate, pathEnv === undefined ? {} : { pathEnv });
    if (found !== null) return found;
  }
  return null;
}

/** 入口在包目录里面吗（脚本的入口来自清单，库已经核对过路径；这里再核对一次，因为这里是真的要运行它的地方）。 */
function insideRoot(root, entry) {
  if (typeof entry !== 'string' || entry === '' || path.isAbsolute(entry) || entry.includes('\\')) return null;
  const full = path.resolve(root, ...entry.split('/'));
  const relative = path.relative(root, full);
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ? null : full;
}

function run(executable, args, { input, cwd, timeoutMs, maxOutputBytes, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let failure = null; // 我们自己决定要结束它（超时、输出太大）：等它真的退出了再报，不留着还在跑的进程
    const finish = (action) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const stop = (error) => {
      if (failure !== null) return;
      failure = error;
      child.kill(); // 只结束自己起的这一个
      setTimeout(() => finish(() => reject(error)), 5000).unref(); // 它迟迟不退出也不能一直等
    };
    const timer = setTimeout(() => stop(new Error(`脚本 ${label} 超过 ${Math.round(timeoutMs / 1000)} 秒没有结束，已被结束`)), timeoutMs);
    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length;
      if (outBytes > maxOutputBytes) return stop(new Error(`脚本 ${label} 的输出超过 ${Math.round(maxOutputBytes / 1024 / 1024)} MiB，已被结束`));
      out.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errBytes += chunk.length;
      err.push(chunk);
      while (errBytes - err[0].length > STDERR_KEEP) errBytes -= err.shift().length; // 只留最近的一段
    });
    child.stdin.on('error', () => {}); // 脚本不读标准输入就退出了：EPIPE 不是错误，结果看退出码
    child.on('error', (cause) => finish(() => reject(new Error(`脚本 ${label} 起不来（${executable}）：${cause.message}`, { cause }))));
    child.on('close', (code, signal) => {
      finish(() => {
        if (failure !== null) return reject(failure);
        if (code === 0) return resolve(Buffer.concat(out).toString('utf8'));
        const stderr = Buffer.concat(err).toString('utf8').trim().slice(-TAIL);
        reject(new Error(`脚本 ${label} 退出码 ${code ?? signal}${stderr === '' ? '' : `：${stderr}`}`));
      });
    });
    child.stdin.end(input);
  });
}

/**
 * 给这个包的脚本建运行时。
 * @param {object} options
 * @param {string} options.packDir 包目录（角色部分的根），脚本在这里面运行
 * @param {string[]} options.names 清单里脚本用到的运行时名字
 * @param {Record<string, unknown>} [options.existing] 环境里已经有的运行时：同名的不建（例如 ffmpeg 的签名是另一种）
 * @param {string} [options.pathEnv] 换掉 PATH（测试用）
 * @param {number} [options.timeoutMs] 单次运行的上限，默认 10 分钟
 * @param {number} [options.maxOutputBytes] 输出的上限，默认 256 MiB
 * @returns {Record<string, (call: { entry: string, input: string }) => Promise<string>>} 找得到解释器的才有
 */
export function createScriptRuntimes({ packDir, names, existing = {}, pathEnv, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES }) {
  const root = fs.realpathSync(packDir);
  const runtimes = {};
  for (const name of new Set(names)) {
    if (Object.hasOwn(existing, name)) continue;
    const executable = locate(name, pathEnv);
    if (executable === null) continue;
    runtimes[name] = async ({ entry, input }) => {
      const full = insideRoot(root, entry);
      if (full === null) throw new Error(`脚本入口 ${JSON.stringify(entry)} 不在包目录里：只运行清单里登记的、包目录里的文件`);
      if (!fs.existsSync(full)) throw new Error(`脚本入口 ${entry} 不存在`);
      return run(executable, [full], { input, cwd: root, timeoutMs, maxOutputBytes, label: entry });
    };
  }
  return runtimes;
}
