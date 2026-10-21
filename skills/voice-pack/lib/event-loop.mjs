// SPDX-License-Identifier: Apache-2.0
//
// 让事件循环转一圈：一段连续的同步活（切段、编段、筛片段）做得久了，页面的绘制和事件、定时器都要等它，浏览器里就是卡住。
// 这几件是做包、长录音这些流程共用的，只在这里写一份（长录音切段最先用它，做包筛片段也要，所以放在这里，不留在 long-recording.mjs 里）。
//
//   YIELD_AFTER_MS      连续做了这么多毫秒（同步的活）就让一圈，再接着做：50，一个让出的节拍里页面还感觉不出来
//   nowMs()             现在是第几毫秒（单调的钟，只用来量「连续做了多久」）
//   turnEventLoop()     返回 Promise<void>，等到事件循环转过一圈（一个宏任务）才兑现
//
// 用法：调用方自己记一个 busySince = nowMs()，每做完一小件看一眼 nowMs() - busySince >= YIELD_AFTER_MS，到了就 await turnEventLoop()，再重记。
// 让一次的代价是一个宏任务（微秒级），所以按「连续做了多久」让，不按「做了几件」让：件数少的活一次都不让，和不让的写法一样快。
// 不能指望 await 别的异步调用来让：浏览器里 crypto.subtle.digest 对小输入在调用里就算完，await 它走微任务，事件循环不转。
//
// 抛出的错误：没有。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。

/** 切段、编段、筛片段里，连续做了这么多毫秒（同步的活）就让事件循环转一圈，再接着做。 */
export const YIELD_AFTER_MS = 50;

/** 现在是第几毫秒（单调的钟，只用来量「连续做了多久」）；浏览器和 Node 都有 performance.now，没有就用 Date.now。 */
export const nowMs = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

/**
 * 让事件循环转一圈：等一个宏任务（微任务不行，页面的绘制和事件要等宏任务）。用 MessageChannel，不用 setTimeout：浏览器里页面在后台标签里时，
 * setTimeout 被拖到一秒甚至一分钟才响一次，每让一次就要白等那么久，做包会在编段上停好几秒；MessageChannel 不受这个限制，也不被测试里的假时钟接管。
 * 没有 MessageChannel 的运行环境退回 setTimeout(0)。
 */
export const turnEventLoop = () =>
  new Promise((resolve) => {
    if (typeof MessageChannel !== 'function') {
      setTimeout(resolve, 0);
      return;
    }
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close(); // 关一头，两头都关：不留着开着的端口（Node 里它会让进程退不出去）
      resolve();
    };
    port2.postMessage(null);
  });
