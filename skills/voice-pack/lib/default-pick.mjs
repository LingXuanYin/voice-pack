// SPDX-License-Identifier: Apache-2.0
//
// 让能听音频的模型挑默认段（流程层）：做包时把几段候选一次交给它，请它挑最自然、像在跟人说话、带着表演的那一段（不是平平地念稿的）。
// 它和标提示标注是一类用法：听这段录音是怎么说的；不是判「像不像」（像不像由说话人相似度和盲听量，见 lib/fidelity.mjs）。
//   @capability audio-text-to-text  听几段录音，按文字指令回答（签名在 vocab/capability-signatures.md）
// 候选是哪几段、按什么次序交、挑不成时怎么挑，规则在 lib/pack-material.mjs 的规则 5 和 lib/make-pack-pick.mjs；这里只管问一次、读回答。
//
// 一次调用问全部候选（调用方最多交 MAX_PICK_CANDIDATES 段，按优先级取前面的），每段前面写编号「录音 1：」「录音 2：」……，不告诉模型每段的原文。
// 回答是一个 JSON 对象（可以包在一个代码块里）：{ "choice": 2, "opening": "…", "why": "…" }。choice 是挑的那段的编号（从 1 起），
//   opening 是那段录音开头的 OPENING_WORDS 个词，why 是一句理由（原样写进报告）。
// 收音校验同标提示标注（lib/segment-annotation.mjs）：opening 和挑的那段的已知文本的开头对不上（lib/fidelity.mjs 的 openingErrorRate 超过上限），就是模型没有真的听到，
//   它挑的不采用。只要开头、不要整段原话，理由也同那里：现成的文章做的包，模型的服务商会拦下「把整段原话写出来」的回答。
//
// 暂时出错（details.transient）：按 lib/call-attempts.mjs 的规则再问（options.attempts，做包给 MAX_ATTEMPTS：最多问 3 次），问满了还是暂时出错就是没听成。
// 不重试的同标提示标注：回答被服务商拦下（provider_blocked）、回答没正常结束或是空的（能力标 details.unusable）、回答不是固定格式、收音校验没过：能力是答了的，
//   重来也是一样的答案，而且每问一次都花钱。别的错原样抛出，由调用方决定（做包退回按规则挑，中止和凭据被拒照旧往上抛，见 lib/make-pack-pick.mjs）。
//
// 返回（pickByListening）：
//   { status: 'picked', index, why, attempts, model? }         index 是挑的那段在 candidates 里的下标
//   { status: 'voided', reason, attempts, errorRate?, problem?, stopReason?, model? }
//                                                              不采用。reason 是 'listening_check_failed'（收音校验没过，带 errorRate）、'pick_answer_invalid'（回答不是固定格式，
//                                                              或者 choice 不是候选的编号）、'pick_answer_unusable'（回答没正常结束或是空的，带 problem、stopReason）、'provider_blocked'（被服务商拦下）
//   { status: 'not_heard', error: { code, message, details }, attempts }   服务暂时出错，问满了 attempts 次也没成
//
// 抛出的错误：
//   capability_result_invalid  能力的返回不是 { text: 字符串, model?: 字符串 }。details: { capability, problem }
//   另外 capability_missing 来自核心层；能力抛的别的错（401……）、options.wait 抛的错原样往上抛；candidates 不是两段以上的 { audio, text }，或者多于 MAX_PICK_CANDIDATES 段，TypeError（程序员用错接口）。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError, isVoicePackError } from '../protocol/lib/errors.mjs';
import { reportable } from '../protocol/lib/scrub.mjs';
import { requireCapability } from '../protocol/lib/env.mjs';
import { openingErrorRate, OPENING_WORDS, DEFAULT_MAX_ERROR_RATE } from './fidelity.mjs';
import { summarizeError, badResult, isUnusableAnswer, unusableDetails, answerBody, isPlainObject } from './capability-calls.mjs';
import { callWithRetries } from './call-attempts.mjs';

/**
 * 一次最多交几段候选。这份实现定的，不是实测的：几段录音一起放进一个请求，请求的大小跟着段数涨（一段 20 秒、24 kHz 的 16 位 WAV 约 1 MB，编成 Base64 再大三分之一），
 * 8 段约 10 MB；候选再多，挑的也只是排在前面的这几段（调用方按优先级排好）。改它改这里。
 */
export const MAX_PICK_CANDIDATES = 8;

/** 给模型的提示：不写每段的原文；只要挑的那段开头的 OPENING_WORDS 个词（要整段原话会被模型的服务商拦下，见文件头）。 */
export const PICK_PROMPT = [
  '你会听到同一个人的几段录音，每段前面写着编号，从 1 起。请只根据你听到的内容回答。',
  '',
  '从这几段里挑一段，当这个声音平常说话的样子：最自然、像在跟人说话、带着表演的那一段，不是平平地念稿的那种。',
  `先写出你挑的那段录音开头的 ${OPENING_WORDS} 个词，只写听到的字，不要改写、不要补充；中文、日文每个字算一个词，别的语言按空格分词。`,
  '再用一句话说为什么挑它。',
  '',
  '只输出一个 JSON 对象，不要输出别的文字。格式如下（choice 是你挑的那段的编号）：',
  '{"choice": 1, "opening": "…", "why": "…"}',
].join('\n');

const invalidAnswer = (reason, reply) => new VoicePackError('pick_answer_invalid', `The answer for picking the default segment does not follow the fixed format (${reason}); it is not guessed at, and this pick is not used`, { details: { reason, reply: reportable(reply) } });

/**
 * 把模型的回答解析出来。整段回答必须是一个 JSON 对象（可以包在一个代码块里）：choice 是 1 到 count 的整数，opening、why 是字符串。
 * @throws {VoicePackError} pick_answer_invalid。details.reason 说哪里不对，details.reply 是原话全文（打过码，规则见 protocol/lib/scrub.mjs）
 */
export function parsePickAnswer(reply, count) {
  let data;
  try {
    data = JSON.parse(answerBody(reply));
  } catch {
    throw invalidAnswer('not JSON', reply);
  }
  if (!isPlainObject(data)) throw invalidAnswer('not a JSON object', reply);
  if (!Number.isInteger(data.choice) || data.choice < 1 || data.choice > count) throw invalidAnswer(`choice must be an integer from 1 to ${count}`, reply);
  for (const key of ['opening', 'why']) if (typeof data[key] !== 'string') throw invalidAnswer(`${key} must be a string`, reply);
  return { choice: data.choice, opening: data.opening, why: data.why };
}

function readCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length < 2) throw new TypeError('candidates must be an array of at least two segments');
  if (candidates.length > MAX_PICK_CANDIDATES) throw new TypeError(`candidates may have at most ${MAX_PICK_CANDIDATES} segments`);
  for (const [index, candidate] of candidates.entries()) {
    if (!isPlainObject(candidate) || !isPlainObject(candidate.audio) || typeof candidate.text !== 'string') throw new TypeError(`candidates[${index}] must be { audio, text }`);
  }
}

/**
 * 请能听音频的模型从几段候选里挑默认段。
 * @param {object} env 注入的运行环境，要有 audio-text-to-text
 * @param {{ audio: {bytes: Uint8Array, mimeType: string}, text: string }[]} candidates 两段以上、最多 MAX_PICK_CANDIDATES 段，按交给模型的次序；text 是这段录音里说的话（收音校验用），不会交给模型
 * @param {{ maxErrorRate?: number, attempts?: number, wait?: (ms: number) => Promise<void> }} [options] attempts、wait 同 lib/call-attempts.mjs 的 callWithRetries
 * @returns {Promise<object>} 见文件头
 */
export async function pickByListening(env, candidates, { maxErrorRate = DEFAULT_MAX_ERROR_RATE, attempts = 1, wait } = {}) {
  readCandidates(candidates);
  const listen = requireCapability(env, 'audio-text-to-text');
  const parts = [{ text: PICK_PROMPT }, ...candidates.flatMap((candidate, index) => [{ text: `录音 ${index + 1}：` }, { audio: candidate.audio }])];
  let calls = 0; // 问了几次（报告里写；暂时出错再问的也算）
  let outcome;
  try {
    // 暂时出错就按 lib/call-attempts.mjs 的规则再问；问满了还是暂时出错返回 { error }。别的错不重试，下面接
    outcome = await callWithRetries(() => {
      calls += 1;
      return listen({ parts });
    }, { attempts, wait });
  } catch (error) {
    // 被服务商拦下、回答没正常结束或是空的：作废，不再问（见文件头）
    if (isVoicePackError(error, 'provider_blocked')) return { status: 'voided', reason: 'provider_blocked', attempts: calls, ...(typeof error.details?.model === 'string' ? { model: error.details.model } : {}) };
    if (isUnusableAnswer(error)) return { status: 'voided', reason: 'pick_answer_unusable', attempts: calls, ...unusableDetails(error) };
    throw error;
  }
  if ('error' in outcome) return { status: 'not_heard', error: summarizeError(outcome.error), attempts: calls };
  const reply = outcome.result;
  if (!isPlainObject(reply) || typeof reply.text !== 'string') throw badResult('audio-text-to-text', 'text_missing', 'must return { text: string, model?: string }');
  const asked = { attempts: calls, ...(typeof reply.model === 'string' ? { model: reply.model } : {}) };
  let answer;
  try {
    answer = parsePickAnswer(reply.text, candidates.length);
  } catch (error) {
    if (isVoicePackError(error, 'pick_answer_invalid')) return { status: 'voided', reason: 'pick_answer_invalid', ...asked };
    throw error;
  }
  const index = answer.choice - 1;
  const errorRate = openingErrorRate(candidates[index].text, answer.opening);
  if (errorRate > maxErrorRate) return { status: 'voided', reason: 'listening_check_failed', errorRate, ...asked };
  return { status: 'picked', index, why: answer.why, ...asked };
}
