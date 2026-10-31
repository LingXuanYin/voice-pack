// SPDX-License-Identifier: Apache-2.0
//
// 进程适配器的会话（Node 专有，所以放在 cli/）：起用户的程序，等它说 ready，一行一个 JSON 地发请求、按 id 配对收回应，
// 超时、程序退出、回应写得不对都给明确的错误，命令结束时把程序收掉。进程协议的正本是 ../README.md，编码和解码在 ../wire.mjs。
//
//   const session = createSession({ argv, cwd, env?, timeoutMs, startTimeoutMs, expect? });
//   await session.start()                    起程序，等它说 ready → { capabilities, info }。不调也行：第一次 call 会先起
//   await session.call(capability, params)   发一个请求，返回结果（音频已经换回字节）。一次只有一个请求在途，别的排队
//   await session.close()                    关标准输入，等程序自己退出，不退就结束它
//   killTree(pid)                            结束这个进程（Windows 上连它起的子进程）。只对自己起的进程用：pid 是 spawn 时记下的
//   closeAllSessions()                       关掉所有会话
//   expect                                   适配器声明了要用的能力名：程序的 ready 里没有，就报 process_capability_unsupported
//
// 一个会话只起一次程序。起不来、退出了、超时被结束以后，会话就死了，后面的调用马上报 process_not_running，不再重起
// （重起会让一个卡死的输入拖着后面的每个输入各等一次启动；要接着做，重新运行命令，它会起一个新的程序）。
//
// 生命周期：
//   - 子进程不挡着命令退出（unref），有请求在途或在等 ready 的时候，超时的定时器让命令活着。命令跑完、事件循环空了（beforeExit），
//     关标准输入让程序自己退出，不退就结束它；最后 exit 事件里同步地把还活着的结束掉（process.exit() 和未接住的异常时 beforeExit 不会来）。
//     宿主被信号杀死、断电这类连 exit 事件都没有的退出：程序的标准输入跟着关了，进程协议要求它读到结尾就退出（../README.md）。
//     Windows 上 Node（libuv）把它起的子进程放进一个作业对象，宿主不管怎么退出，系统都会结束这些子进程和它们的子进程
//     （2026-10-15 在 Windows 上实测：宿主被 TerminateProcess，程序和它自己起的子进程 250 毫秒内也没了，程序没来得及做收尾）。所以 Windows 上 exit 事件里这一步是兜底；别的系统没有这个兜底，这一步是主要的办法。
//   - 超时、违反进程协议这类「宿主还活着，程序不行了」的结束：Windows 上用 taskkill /T（venv 里的 python.exe 是个启动器，会再起真正的解释器，只结束启动器会留下解释器）；
//     别的系统只结束程序本身（不另开进程组：那样终端上的 Ctrl-C 到不了程序）。程序自己起的子进程（多进程的推理、数据加载）归程序管，README 里写了。
//   - 程序的标准错误不转给命令（会弄脏 --json 的输出），只留最后一段，放进错误的 details.stderr。
//
// 抛出的错误（VoicePackError；details 里放什么在抛出处写明，什么时候出现见 ../README.md「出错」）：
//   process_spawn_failed          起不来。details: { command, reason }
//   process_start_timeout         超过 startTimeoutMs 还没说 ready，已结束。details: { seconds, stderr, output }
//   process_exited                程序退出了，而 ready 或回应还没有来。details: { stage: 'start' | 'request', exitCode, signal, capability?, stderr, output }
//   process_timeout               一个请求超过 timeoutMs 没有回应，已结束程序。details: { capability, seconds, stderr, output }
//   process_not_running           程序已经不在了（此前起不来、退出了、超时被结束，或者会话关了）。details: { capability, reason }，reason 是当初死的那个错的 code，会话被关了是 closed
//   process_protocol_error        程序违反了进程协议：ready 写得不对、回应的 id 不是在途的。details: { reason, ... }，已结束程序
//   process_capability_unsupported  声明要用的能力，程序的 ready 里没有。details: { missing, announced }，已结束程序
//   process_response_invalid      回应是进程协议的消息，但内容不对（缺 ok、result 不是对象、Base64 不对）。details: { capability, problem }。只这一个请求报错，程序不动
//   程序自己报的 error 原样变成 VoicePackError（见 ../wire.mjs 的 programError）。
// 超时和退出不标 details.transient：适配器分不清一个卡住的程序和一个必现的 bug，宁可马上停下来让人看；程序知道自己的某个失败是暂时的，在自己的 error 里写 transient。
// output 是程序写在标准输出里的、不是进程协议消息的最后几行（日志，没把标准输出让给进程协议的 print），帮人找原因。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { VoicePackError } from '../../../protocol/lib/errors.mjs';
import { decodeClips, encodeRequest, parseProgramLine, programError } from '../wire.mjs';

const STDERR_KEEP = 2000; // 错误里带的标准错误的末尾（字符数）
const NOISE_KEEP = 5; // 错误里带的「不是进程协议消息」的标准输出行数
const NOISE_LINE = 200;
const GRACE_MS = 3000; // 关了标准输入以后，等程序自己退出多久

const sessions = new Set();
let hooked = false;

/** 结束这个进程。Windows：taskkill /T（连它起的子进程）；别处：SIGKILL 它自己（它起的子进程它自己管）。 */
export function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 已经退出了
  }
}

const alive = (child) => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
const tail = (text, keep) => (text.length > keep ? text.slice(text.length - keep) : text);
const seconds = (ms) => Math.round((ms / 1000) * 100) / 100;

function installHooks() {
  if (hooked) return;
  hooked = true;
  process.on('beforeExit', () => {
    for (const session of [...sessions]) void session.close();
  });
  process.on('exit', () => {
    for (const session of sessions) session.killNow();
  });
}

export function createSession({ argv, cwd, env, timeoutMs, startTimeoutMs, expect = [] }) {
  const [command, ...args] = argv;
  let child = null;
  let state = 'idle'; // idle → starting → ready → dead
  let reason = null; // 死掉的原因（第一个错）
  let buffer = '';
  let scanned = 0;
  let stderr = '';
  const noise = [];
  const pending = new Map(); // id → { capability, resolve, reject, timer }；一次只有一个，用 id 核对回应是不是这个请求的
  let startSettle = null;
  let startTimer = null;
  let starting = null;
  let queue = Promise.resolve();
  let closing = false; // close() 在请程序退出：它的退出不是出了错
  let nextId = 1;

  const context = () => ({ stderr: tail(stderr, STDERR_KEEP).trim(), output: noise.slice(-NOISE_KEEP) });
  const stderrNote = () => (context().stderr === '' ? '' : `。它写在标准错误里的最后一段：${tail(context().stderr, 400)}`);

  /** 程序不行了：先拒掉在等的 ready 和在途的请求，再结束它。why 是为什么（也是以后的调用看到的原因），itemError 给在途的请求各自的错（默认同 why）。 */
  function die(why, itemError = () => why, { kill = true } = {}) {
    if (state === 'dead') return;
    state = 'dead';
    reason = why;
    clearTimeout(startTimer);
    if (startSettle !== null) {
      const { reject } = startSettle;
      startSettle = null;
      reject(why);
    }
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(itemError(item));
    }
    pending.clear();
    if (kill && child !== null && alive(child)) killTree(child.pid);
  }

  const exitedError = (stage, capability, exit) => {
    const how = exit.signal ? `被信号 ${exit.signal} 结束` : `退出码 ${exit.code}`;
    const where = stage === 'start' ? '在说 ready 之前' : capability === undefined ? '' : `在回应 ${capability} 之前`;
    return new VoicePackError('process_exited', `程序${where}就退出了（${how}）${stderrNote()}`, {
      details: { stage, exitCode: exit.code ?? null, signal: exit.signal ?? null, ...(capability === undefined ? {} : { capability }), ...context() },
    });
  };
  const closedError = () => new VoicePackError('process_not_running', '会话已经关了（命令结束时收尾）', { details: { reason: 'closed' } });
  const protocolError = (why, message, more = {}) => new VoicePackError('process_protocol_error', `程序违反了进程协议：${message}`, { details: { reason: why, ...more, ...context() } });

  function onLine(line) {
    const parsed = parseProgramLine(line);
    if (parsed.kind === 'noise') {
      const text = line.trim();
      if (text !== '') {
        noise.push(tail(text, NOISE_LINE));
        if (noise.length > NOISE_KEEP * 4) noise.splice(0, noise.length - NOISE_KEEP);
      }
      return;
    }
    if (parsed.kind === 'ready') {
      if (startSettle === null) return; // 第二次 ready 忽略
      const missing = expect.filter((name) => !parsed.capabilities.includes(name));
      if (missing.length > 0) {
        die(new VoicePackError('process_capability_unsupported', `适配器声明了要用 ${missing.join('、')}，程序在 ready 里没有说它有（它说有：${parsed.capabilities.join('、') || '一项也没有'}）：改适配器的声明，或者让程序实现它`, { details: { missing, announced: parsed.capabilities } }));
        return;
      }
      clearTimeout(startTimer);
      const { resolve } = startSettle;
      startSettle = null;
      state = 'ready';
      resolve({ capabilities: parsed.capabilities, info: parsed.info });
      return;
    }
    if (parsed.kind === 'invalid' && parsed.id === undefined) {
      die(protocolError('ready_invalid', parsed.problem));
      return;
    }
    const item = pending.get(parsed.id);
    if (item === undefined) {
      die(protocolError('unknown_id', `回应的 id ${JSON.stringify(parsed.id)} 不是在途的请求（重复回应，或者回应了没发过的 id）`, { id: parsed.id }));
      return;
    }
    pending.delete(parsed.id);
    clearTimeout(item.timer);
    if (parsed.kind === 'invalid') {
      item.reject(new VoicePackError('process_response_invalid', `程序对 ${item.capability} 的回应写得不对：${parsed.problem}`, { details: { capability: item.capability, problem: parsed.problem } }));
    } else if (!parsed.ok) {
      item.reject(programError(parsed.error, item.capability));
    } else {
      try {
        item.resolve(decodeClips(parsed.result));
      } catch (cause) {
        item.reject(new VoicePackError('process_response_invalid', `程序对 ${item.capability} 的回应里，音频的 Base64 写得不对`, { details: { capability: item.capability, problem: 'invalid_base64' }, cause }));
      }
    }
  }

  function onData(chunk) {
    buffer += chunk;
    for (;;) {
      const at = buffer.indexOf('\n', scanned);
      if (at < 0) break;
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      scanned = 0;
      onLine(line);
      if (state === 'dead') return;
    }
    scanned = buffer.length; // 下次从这里往后找换行，一行很长（Base64 的音频）时不会越找越慢
  }

  function begin() {
    state = 'starting';
    return new Promise((resolve, reject) => {
      startSettle = { resolve, reject };
      try {
        child = spawn(command, args, { cwd, env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (cause) {
        die(new VoicePackError('process_spawn_failed', `起不来程序 ${command}：${cause?.message ?? cause}`, { details: { command, reason: cause?.code ?? 'unknown' }, cause }), undefined, { kill: false });
        return;
      }
      const wasStarting = () => startSettle !== null;
      let exited = false;
      const settleExit = (code, signal) => {
        if (exited) return;
        exited = true;
        if (closing) {
          die(closedError(), undefined, { kill: false }); // 是 close() 请它退出的，不是出了错
          return;
        }
        die(exitedError(wasStarting() ? 'start' : 'request', undefined, { code, signal }), (item) => exitedError('request', item.capability, { code, signal }), { kill: false });
      };
      child.on('error', (cause) => {
        if (exited) return;
        exited = true;
        // ENOENT 有两种：程序找不到，或者给它的当前目录不存在（spawn 报的是同一个码）
        const why = cause?.code === 'ENOENT'
          ? (fs.existsSync(cwd) ? '找不到它（检查 PATH，或者把完整路径写进命令）' : `程序的当前目录 ${cwd} 不存在（cwd 选项）`)
          : (cause?.message ?? cause);
        die(new VoicePackError('process_spawn_failed', `起不来程序 ${command}：${why}`, { details: { command, reason: cause?.code ?? 'unknown' }, cause }), undefined, { kill: false });
      });
      child.on('exit', (code, signal) => setTimeout(() => settleExit(code, signal), 200).unref()); // 标准输出里可能还有没读完的回应；close 先到就不用等
      child.on('close', (code, signal) => settleExit(code, signal));
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        stream.on('error', () => {}); // 程序退出时管道断了：不是错误，结果看它的退出
        stream.unref?.();
      }
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', onData);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr = tail(stderr + chunk, STDERR_KEEP * 2);
      });
      child.unref();
      startTimer = setTimeout(() => {
        die(new VoicePackError('process_start_timeout', `程序 ${seconds(startTimeoutMs)} 秒内没有说 ready，已结束它${stderrNote()}`, { details: { seconds: seconds(startTimeoutMs), ...context() } }));
      }, startTimeoutMs);
    });
  }

  function start() {
    if (state === 'idle') starting = begin();
    if (starting !== null) return starting;
    return Promise.reject(reason);
  }

  function request(capability, line, id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        die(new VoicePackError('process_timeout', `程序 ${seconds(timeoutMs)} 秒内没有回应 ${capability}，已结束它${stderrNote()}`, { details: { capability, seconds: seconds(timeoutMs), ...context() } }));
      }, timeoutMs);
      pending.set(id, { capability, resolve, reject, timer });
      child.stdin.write(`${line}\n`);
    });
  }

  async function call(capability, params) {
    const id = nextId;
    const line = encodeRequest({ id, capability, params }); // 编不出来就在排队、起程序之前报（async 函数：报成被拒绝的 promise，id 也不用掉）
    nextId += 1;
    const run = async () => {
      if (state === 'idle' || state === 'starting') await start(); // 第一次调用才起；起不来的错就报给这一次调用
      if (state !== 'ready') {
        const why = reason?.details?.reason === 'closed' ? 'closed' : (reason?.code ?? state); // 当初出的那个错的 code；会话被关了是 closed
        throw new VoicePackError('process_not_running', `程序已经不在了，${capability} 没有发出去：${reason?.message ?? '它没有起来'}`, { details: { capability, reason: why } });
      }
      return request(capability, line, id);
    };
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  }

  async function close() {
    sessions.delete(session);
    closing = true;
    if (child === null || !alive(child)) {
      if (state !== 'dead') {
        state = 'dead';
        reason ??= closedError();
      }
      return;
    }
    const target = child;
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        killTree(target.pid);
        setTimeout(done, 100);
      }, GRACE_MS);
      target.once('close', done);
      target.once('exit', () => setTimeout(done, 300));
      try {
        target.stdin.end();
      } catch {
        // 已经关了
      }
    });
    die(closedError(), undefined, { kill: false });
  }

  const session = {
    start,
    call,
    close,
    killNow() {
      if (child !== null && alive(child)) killTree(child.pid);
    },
    get pid() {
      return child?.pid;
    },
  };
  sessions.add(session);
  installHooks();
  return session;
}

/** 关掉所有会话（等程序退出，不退就结束）。 */
export async function closeAllSessions() {
  await Promise.all([...sessions].map((session) => session.close()));
}
