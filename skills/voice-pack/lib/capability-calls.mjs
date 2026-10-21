// SPDX-License-Identifier: Apache-2.0
//
// 调所需能力时流程层共用的几个小函数：做包、长录音、配音、还原度、打标签都要分辨能力抛的错是不是「服务暂时出错」、把错记进报告、
// 报能力的返回不合约定、把一批调用分给几个并发的工人。以前每个模块各抄了一份，改一处要改好几处；规矩现在只在这里写一遍。
//
//   isServiceError(error)                          能力抛的错是不是「服务暂时出错」（上游 5xx、网关超时、网络错误、超时……）：是 VoicePackError，
//                                                  details.transient 为 true。谁来标是能力实现的事（适配器照自己的重试规则标），约定写在
//                                                  adapters/README.md「出错的约定」，每项能力的签名在 vocab/capability-signatures.md「通用约定」。
//                                                  没标的错（缺能力、参数错、401、返回的形状不对、普通的 Error……）都不是：照常往上抛，库不猜
//   summarizeError(error)                          收进报告的错误摘要 { code, message, details }：details 没有就是 {}，不带 cause 和栈
//   badResult(capability, problem, message?, extra?)  所需能力的返回不合约定：造一个 capability_result_invalid，调用方自己 throw。
//                                                  problem 是问题的代码（text_missing……）或一句话，message 是说明（省略就用 problem），
//                                                  extra 并进 details（例如 { index }）。details: { capability, problem, ...extra }
//   pool(list, limit, work)                        一批事分给最多 limit 个并发的工人做：work(项, 序号)；结果的次序由调用方按序号自己放。
//                                                  一件事抛了错就不再开始新的，等在做的做完，把第一个错往上抛
//
// 抛出的错误：badResult 造的 capability_result_invalid，details: { capability, problem, ...extra }（用到它的模块在自己的文件头写具体是哪几种问题）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError, isVoicePackError } from '../protocol/lib/errors.mjs';

export const isServiceError = (error) => isVoicePackError(error) && error.details?.transient === true;

export const summarizeError = (error) => ({ code: error.code, message: error.message, details: error.details ?? {} });

export const badResult = (capability, problem, message = problem, extra = {}) =>
  new VoicePackError('capability_result_invalid', `所需能力 ${capability} 的返回不符合约定：${message}`, { details: { capability, problem, ...extra } });

export async function pool(list, limit, work) {
  let next = 0;
  let fatal = null;
  const worker = async () => {
    while (fatal === null) {
      const index = next++;
      if (index >= list.length) return;
      try {
        await work(list[index], index);
      } catch (error) {
        if (fatal === null) fatal = error;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  if (fatal !== null) throw fatal;
}
