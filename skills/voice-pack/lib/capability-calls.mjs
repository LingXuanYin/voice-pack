// SPDX-License-Identifier: Apache-2.0
//
// 调所需能力时流程层共用的几个小函数：做包、长录音、配音、还原度、标提示标注、挑默认段都要分辨能力抛的错是不是「服务暂时出错」、把错记进报告、
// 报能力的返回不合约定、读能听音频的模型按固定格式给的回答、把一批调用分给几个并发的工人。以前每个模块各抄了一份，改一处要改好几处；规矩现在只在这里写一遍。
//
//   isServiceError(error)                          能力抛的错是不是「服务暂时出错」（上游 5xx、网关超时、网络错误、超时……）：是 VoicePackError，
//                                                  details.transient 为 true。谁来标是能力实现的事（适配器照自己的重试规则标），约定写在
//                                                  adapters/README.md「Error conventions」，每项能力的签名在 vocab/capability-signatures.md「General conventions」。
//                                                  没标的错（缺能力、参数错、401、返回的形状不对、普通的 Error……）都不是：照常往上抛，库不猜
//   isTextRejected(error)                          能力抛的错是不是「只和这一次的文字有关」的拒绝：是 VoicePackError，details.textRejected 为 true
//                                                  （谁来标是能力实现的事，约定同上，写在 vocab/capability-signatures.md「General conventions」）。配音据此把这一段记成失败、别的段照常做；没标的照常往上抛
//   keepsThrowing(error)                           能力抛的错是不是不能退回、不能当成「这一项没做成」记下的那种：调用方中止（AbortError，人不要了），
//                                                  和凭据被拒（HTTP 401，或者适配器说它之后不再发请求的 details.halted：要让使用者处理，不替它再试一次，
//                                                  约定见 adapters/README.md「Error conventions」第 3 条）。挑默认段（lib/make-pack-pick.mjs）碰到它照旧往上抛；
//                                                  配试听句（lib/make-pack-card-line.mjs）在包做好以后，401、halted 不抛，按它分出要使用者先处理的那一种（理由在那里）
//   isUnusableAnswer(error)                        能力抛的错是不是「回答没正常结束（截断、出错中断）或是空的」：是 VoicePackError，details.unusable 为 true
//                                                  （谁来标是能力实现的事，约定同上）。标提示标注、挑默认段、盲听据此把那一条记成「作废」，不重试、不停下整次（标提示标注回答是空的除外，算暂时出错，lib/segment-annotation.mjs）；没标的照常往上抛
//   isUnretrieved(error)                           能力抛的错是不是「服务那头已经做完（计过费）、只是结果没取回来」：是 VoicePackError，details.unretrieved 为 true
//                                                  （谁来标是能力实现的事，约定同上；怎么取回在 details.retrieve，给人看的一句话）。重新调一次会再做一次、再计一次费，
//                                                  所以不是暂时出错：配音据此把这一段记成失败、单列成「没取回」，不放进重做的命令；没标的照常往上抛
//   isProviderBlocked(error)                       能力抛的错是不是「被服务商拦下」（内容过滤）：是 VoicePackError，code 是 provider_blocked；或者照暂时出错报（details.transient 为 true）、
//                                                  details.problem 是 provider_blocked（转写的约定：同一段再问有时就过的服务这样报，写法在 vocab/capability-signatures.md 的转写一节）。
//                                                  做包的转写（lib/make-pack-transcribe.mjs）、长录音的转写（lib/long-recording.mjs）据此把这一段记成被拦下：
//                                                  前一种不再问，后一种照暂时出错问满了次数、最后一次的错是这样的才算
//   unusableDetails(error)                         isUnusableAnswer 那种错记进报告的几项：{ problem?, stopReason?, model? }（能力在 details 里给了的才写；model 要是字符串）。
//                                                  标提示标注（lib/segment-annotation.mjs）和挑默认段（lib/default-pick.mjs）的作废原因都带着它
//   answerBody(reply)                              能听音频的模型按固定格式（一个 JSON 对象）给的回答，去掉两头空白；整段回答是一个 ``` 代码块的，取代码块里面的（再去掉两头空白）。
//                                                  拿到的字符串交给 JSON.parse：读不懂由调用方报自己的 *_answer_invalid
//   isPlainObject(value)                           是不是普通对象（不是 null、不是数组）：读回答、读返回值时用
//   summarizeError(error)                          收进报告的错误摘要 { code, message, details }：details 没有就是 {}，不带 cause 和栈
//   badResult(capability, problem, message?, extra?)  所需能力的返回不合约定：造一个 capability_result_invalid，调用方自己 throw。
//                                                  problem 是问题的代码（text_missing……）或一句话，message 是说明（省略就用 problem），
//                                                  extra 并进 details（例如 { index }）。details: { capability, problem, ...extra }
//   pool(list, limit, work)                        一批事分给最多 limit 个并发的工人做：work(项, 序号)；结果的次序由调用方按序号自己放。
//                                                  一件事抛了错就不再开始新的，等在做的做完，把第一个错往上抛
//   reportedModel(capability, result)              能力的返回里报的模型：{}、{ model }，或者换过模型时 { model, modelChange: { from, reason } }。
//                                                  约定（model 是实际用的模型；换过模型另给 modelChange，没换就不给）只写在 adapters/README.md「When the model changes」。
//                                                  model 不是字符串就当没报（和以前一样）；modelChange 给了（不是 undefined、null）却写得不对，
//                                                  抛 capability_result_invalid（problem 是 model_change_invalid）：换了模型是要告诉使用者的事，写错了不悄悄丢掉
//
// 抛出的错误：badResult 造的 capability_result_invalid，details: { capability, problem, ...extra }（用到它的模块在自己的文件头写具体是哪几种问题）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError, isVoicePackError } from '../protocol/lib/errors.mjs';

export const isServiceError = (error) => isVoicePackError(error) && error.details?.transient === true;

/** 调用方中止（AbortError），或者凭据被拒（401、details.halted）：不能退回、不能当成「没做成」记下（见文件头）。 */
export const keepsThrowing = (error) => error?.name === 'AbortError' || (isVoicePackError(error) && (error.details?.status === 401 || error.details?.halted === true));

/** 只和这一次的文字有关的拒绝（details.textRejected 为 true，约定见 vocab/capability-signatures.md「General conventions」）。 */
export const isTextRejected = (error) => isVoicePackError(error) && error.details?.textRejected === true;

/** 回答没正常结束（截断、出错中断）或是空的（details.unusable 为 true，约定见 vocab/capability-signatures.md「General conventions」）。不是服务出错：不重试，每问一次都花钱，再问也可能还是这样。 */
export const isUnusableAnswer = (error) => isVoicePackError(error) && error.details?.unusable === true;

/** 服务那头做完了（计过费）、结果没取回来（details.unretrieved 为 true，约定见 vocab/capability-signatures.md「General conventions」）。不是暂时出错：重新调一次会再计一次费。 */
export const isUnretrieved = (error) => isVoicePackError(error) && error.details?.unretrieved === true;

/** 被服务商拦下（内容过滤）：provider_blocked 这个码，或者照暂时出错报、details.problem 是 provider_blocked 的（转写的约定，见文件头和 vocab/capability-signatures.md 的转写一节）。 */
export const isProviderBlocked = (error) => isVoicePackError(error) && (error.code === 'provider_blocked' || (error.details?.transient === true && error.details?.problem === 'provider_blocked'));

/** 回答没正常结束或是空的（isUnusableAnswer）时记进报告的几项：problem、stopReason、模型，能力给了的才写（见文件头）。 */
export const unusableDetails = (error) => {
  const { problem, stopReason, model } = error.details ?? {};
  return { ...(problem === undefined ? {} : { problem }), ...(stopReason === undefined ? {} : { stopReason }), ...(typeof model === 'string' ? { model } : {}) };
};

// 整段回答就是一个 ``` 代码块
const FENCED = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;

/** 按固定格式给的回答：去掉两头空白，整段是一个代码块就取里面的（见文件头）。 */
export function answerBody(reply) {
  const body = String(reply).trim();
  const fenced = FENCED.exec(body);
  return fenced ? fenced[1].trim() : body;
}

export const summarizeError = (error) => ({ code: error.code, message: error.message, details: error.details ?? {} });

export const badResult = (capability, problem, message = problem, extra = {}) =>
  new VoicePackError('capability_result_invalid', `The result of the required capability ${capability} does not match the contract: ${message}`, { details: { capability, problem, ...extra } });

export const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFilled = (value) => typeof value === 'string' && value.trim() !== '';

/** 能力的返回里报的模型，和换过模型时的 modelChange（见文件头）。result 是已经核对过的返回值（对象）。 */
export function reportedModel(capability, result) {
  const model = typeof result.model === 'string' ? { model: result.model } : {};
  const change = result.modelChange;
  if (change === undefined || change === null) return model;
  if (!isPlainObject(change) || !isFilled(change.from) || !isFilled(change.reason) || !isFilled(result.model)) {
    throw badResult(capability, 'model_change_invalid', 'when the model was changed, modelChange must be { from, reason } (the model that was meant to be used, and a reason for people to read, both non-empty strings), and model must be the model it was changed to (a non-empty string)');
  }
  return { ...model, modelChange: { from: change.from, reason: change.reason } };
}

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
