// SPDX-License-Identifier: Apache-2.0
//
// 统一的数据错误：音色包库（核心层、流程层、各适配器）里，数据的问题（用户输入、命令行参数、文件、网络、能力返回的东西不对）
// 都抛这一种，调用方按 code 区分。调用方的代码用错了接口（参数类型不对之类）是程序员的错，抛 TypeError，不在这里：规矩见 protocol/README.md「错误」。
//
// code 是小写字母、数字、下划线组成的字符串，例如 `capability_missing`。
// 每个模块各自加自己的 code，写在抛出的地方并注明含义和 details 里放什么；
// 不集中写成一个枚举，这样并行的改动不会撞在同一个文件上。
// 已有的 code 都能在代码里 grep 到：在基础部分的目录里 `grep -rn "new VoicePackError('" .`。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。

const CODE_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export class VoicePackError extends Error {
  /**
   * @param {string} code 稳定的机器可读标识，小写下划线，例如 `file_missing`
   * @param {string} [message] 给人看的说明，省略时用 code
   * @param {{ details?: Record<string, unknown>, cause?: unknown }} [options]
   *   details：机器可读的上下文（用 JSON 能表示的值），例如 `{ capability: 'speaker-verification' }`；
   *   cause：底层的原始错误
   */
  constructor(code, message, options = {}) {
    if (typeof code !== 'string' || !CODE_RE.test(code)) {
      throw new TypeError(`VoicePackError 的 code 必须是小写字母、数字、下划线组成的字符串（例如 capability_missing），收到 ${JSON.stringify(code)}`);
    }
    const { details, cause } = options ?? {};
    super(message === undefined ? code : String(message), cause === undefined ? undefined : { cause });
    this.name = 'VoicePackError';
    this.code = code;
    this.details = details ?? {};
  }

  /** 命令行、日志、HTTP 响应里用：只带 code、message、details。 */
  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/**
 * 判断一个值是不是 VoicePackError，可选地再核对 code。
 * 不用 instanceof：完整包里协议核心有两份副本（基础部分一份、角色部分一份），同一个进程可能把两份都加载进来，
 * 它们各有自己的类，instanceof 认不出对方。所以按 name 和 code 认。
 * @param {unknown} value
 * @param {string} [code]
 */
export function isVoicePackError(value, code) {
  if (value === null || typeof value !== 'object') return false;
  if (value.name !== 'VoicePackError' || typeof value.code !== 'string') return false;
  return code === undefined || value.code === code;
}
