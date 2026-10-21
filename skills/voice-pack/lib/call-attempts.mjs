// SPDX-License-Identifier: Apache-2.0
//
// 一段录音的一次能力调用最多试几次、暂时出错等多久再来（流程层）：这条规则只在这里写一份，做包的转写和打标签、长录音的转写、命令行和用这个库的 app（含 app 听设计试听）都用它
// （它先是给转写写的，后来打标签也用它，所以名字不再只说转写）。规则一处写，调用方 import，不各抄一份（同 capability-calls.mjs 的 isServiceError）。
//
// 规则：
//   - 每段最多试 MAX_ATTEMPTS（3）次。暂时出错（details.transient，lib/capability-calls.mjs 的 isServiceError）和 app 听设计试听时
//     「转写里整句找不到」（在 app 里判断）都从这 3 次里出，不是各 3 次。
//   - 暂时出错就再来：第 2 次之前等 RETRY_DELAYS_MS[0]（5 秒），第 3 次之前等 RETRY_DELAYS_MS[1]（15 秒）；最后一次失败以后不再等。
//     3 次都暂时出错：转写的这一段没转成，做包把它记成 transcription_failed，用不上，页面照实说「稍后再做一次」；打标签的这一段没听成，记成 not_heard，不打标签，照实说。
//   - 别的错（401、被服务商拦下 provider_blocked、参数错、认不了的语言、返回的形状不对）不重试，原样往上抛：重来也没用。
//     回答不是固定格式（tag_answer_invalid）不是错误，是能力返回了一个读不懂的回答：打标签记成作废，同一段录音再问还是一样，不重试。
//   - 多听的上限写进「确认费用」：N 段要调，最多 N 次，另外最多再加 extraAttempts(N)（2N）次，用户同意的是这个总数，实际调用不超过它
//     （plan.extraCalls，lib/make-pack-plan.mjs；app 记进用户同意的计划里）。
//
// 谁用它（用法都是：调用方自己调能力，把「调一次」包成 ask 交给 callWithRetries）：
//   转写（automatic-speech-recognition）   lib/make-pack-transcribe.mjs、lib/long-recording.mjs、app 听试听
//   打标签（audio-text-to-text）           lib/segment-tags.mjs 的 tagSegment（options.attempts），lib/make-pack-tags.mjs 的 tagAll 给它 MAX_ATTEMPTS
//   不用它的：盲听（lib/fidelity.mjs，也调 audio-text-to-text）。盲听暂时出错记成「没听成」，事后由调用方补做（fidelity --redo），不在这条规则里
//
// 为什么是 3 次、5 秒和 15 秒：
//   - 次数和间隔是常见的「暂时出错就稍后再来」：最多再试 2 次，两次之前先等 5 秒、15 秒，不为哪一项能力另起一套。
//   - 在一个真实的云端转写服务上量到过（2026-10-19）：服务会有一阵整个不接新连接，至少 60 秒，每次连不上还要等满连接超时。
//     所以第一次出错以后紧接着重试、或者等得太短，都会撞在同一阵里；这条规则救得了短暂的断开和单次超时（再连一次就成的那种），
//     一分钟以上的中断救不了，试满 3 次以后照实说。
//   - 打标签也用它：做包时让听者（audio-text-to-text）给每段录音打情绪、风格标签，听者暂时出错的那一段原来记成「没听成」，不再问，这一段就没有听者打的标签。
//     规则对它的意义和转写一样，次数和间隔就是上面那一套，不为打标签另起。
//     打标签是一次可能计费的调用：适配器约定不替会计费的调用重试（adapters/README.md「出错的约定」第 4 条），重试由库做，所以次数一定要进「确认费用」。
//   - 失败的调用收不收费由运行环境定，库不知道：「确认费用」一律按最多的调用次数写，用户同意的是上限，多出来的次数不会超过它（每段最多 3 次，计划里的段数是上界）。
//     某个环境上量出来的数（连不上的那一阵、失败的调用有没有计费记录），写在那个环境的适配器里。
//
//   MAX_ATTEMPTS                         每段最多试几次（3）
//   RETRY_DELAYS_MS                      第 2、3 次之前各等多久（毫秒，冻住的数组：[5000, 15000]）
//   extraAttempts(segments)              segments 段最多再多试几次：每段 MAX_ATTEMPTS - 1 次
//   callWithRetries(ask, options)        调 ask（一次能力调用）；暂时出错就按规则等一等再来；返回 { result, attempts }，3 次都暂时出错返回 { error, attempts }，别的错抛出
//   spent(error, attempts)               把一个暂时出错的失败标成「这是 attempts 次调用换来的」：做包别处已经替这一段用完了次数，再把这个失败原样交回来时，callWithRetries 看了就不再重试、也不白等
//
// callWithRetries(ask, options)：
//   ask()               返回一次调用的结果（能力的返回，原样交回），或者抛错
//   options.attempts    这一段还剩几次可用（1 以上的整数），默认 MAX_ATTEMPTS；之前已经用掉几次的（app 对缺整句的段再听），传剩下的；1 就是不重试（只调一次）。不是 1 以上的整数是用法错误（TypeError）
//   options.wait        (毫秒) => Promise：等待。默认真的计时器；app 传一个按「取消」就停的，测试传一个记下要等多久、马上返回的。它抛错就原样往上抛
//   options.delaysMs    每次重试之前等多久的表，默认 RETRY_DELAYS_MS；第 k 次重试用第 k 项，不够长就用最后一项（测试把它改小）
//   options.onRetry     ({ attempt, waitMs, error }) => void：决定重试以后、等之前调一次。attempt 是接下来这一次是这一轮的第几次
// 返回：{ result, attempts } 或 { error, attempts }，attempts 是这一轮一共用了几次（一个失败带着 details.attempts 的，算它自己说的次数，见 spent）。
// 次数用完返回的 error 就是最后一次抛的那个，原样，没有包过。
//
// 抛出的错误：ask 抛的暂时出错以外的错，原样；options.wait 抛的错，原样；options.attempts 不对，TypeError（程序员用错接口）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from '../protocol/lib/errors.mjs';
import { isServiceError } from './capability-calls.mjs';

/** 每段最多试几次。暂时出错和 app 对缺整句的段再听，都从这里出。 */
export const MAX_ATTEMPTS = 3;

/** 第 2 次、第 3 次之前各等多久（毫秒）：5 秒、15 秒（为什么见文件头）。 */
export const RETRY_DELAYS_MS = Object.freeze([5000, 15000]);

/** segments 段最多再多试几次：每段在第一次以外最多再 MAX_ATTEMPTS - 1 次。 */
export const extraAttempts = (segments) => segments * (MAX_ATTEMPTS - 1);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一个失败是几次调用换来的：自己说了（details.attempts，1 以上的整数）就用它，没说就是 1 次。 */
const callsOf = (error) => (Number.isInteger(error?.details?.attempts) && error.details.attempts >= 1 ? error.details.attempts : 1);

/**
 * 把一个暂时出错的失败标成「这是 attempts 次调用换来的」，返回一个新的错（同一个 code、同一句话，details 多一项 attempts，原来的错在 cause 里，不改动它）。
 * 做包别的地方已经替这一段用完了次数，再把这个失败原样交回来（app 回放 4a 听试听时的结果）：callWithRetries 看到它就知道这一段没有次数了。
 */
export function spent(error, attempts) {
  return new VoicePackError(error.code, error.message, { details: { ...(error.details ?? {}), attempts }, cause: error });
}

/** 调一次能力，暂时出错就按规则等一等再来。输入、返回、错误见文件头。 */
export async function callWithRetries(ask, { attempts = MAX_ATTEMPTS, wait = sleep, delaysMs = RETRY_DELAYS_MS, onRetry } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new TypeError(`callWithRetries 的 attempts 必须是 1 以上的整数，收到 ${String(attempts)}`);
  let used = 0;
  for (let failures = 0; ; ) {
    used += 1;
    try {
      return { result: await ask(), attempts: used };
    } catch (error) {
      if (!isServiceError(error)) throw error;
      failures += 1;
      used += callsOf(error) - 1;
      if (used >= attempts) return { error, attempts: used };
      const waitMs = delaysMs.length === 0 ? 0 : delaysMs[Math.min(failures, delaysMs.length) - 1];
      onRetry?.({ attempt: used + 1, waitMs, error });
      await wait(waitMs);
    }
  }
}
