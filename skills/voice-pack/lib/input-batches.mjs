// SPDX-License-Identifier: Apache-2.0
//
// 一份很长的输入分成几次请求（流程层，纯计算）：模型一次请求能收的输入有上限，平台或模型写明了，由环境的适配器声明（adapters/README.md 的 limits.maxPromptTokens）。
// 声明了上限的环境，调用文字模型的地方按它分批发，不截输入；没声明的，一次发完。库里判情绪（lib/reference-pick.mjs）和 app 的文字功能（翻译、找术语、分析角色、润色、按台本推荐音色）
// 用的是同一份分批，量法、单独超限的、回答被截断的走法只在这里写一遍。
//
//   utf8Length(text)                                              一段文字的 UTF-8 字节数
//   splitBatches(items, { limit, fixed, bytesOf, glue })          把 items 按上限装成几批：{ batches, tooLong }
//   askBatches(batches, { ask, isCut, whenCutAlone })             一批一批地问，回答被截断的对半分开再问：{ results, calls }
//
// 怎么量：一次请求的整个提示（说明加输入）的 UTF-8 字节数不超过 limit。
//   为什么按字节：limit 的单位由平台或模型定，通常是 token，库不知道换算比例，也不另定一个。每个 token 至少占一个字节，所以一个提示的 token 数不会超过它的字节数；
//   字节数不超过 limit，token 数就不会超过。limit 的单位要是字符也一样，字节数不小于字符数。代价是偏保守：实际一批装的比 limit 留有余量。
//   具体模型的分词怎么切，是适配器对照表里那一项的事（出处写在它的 note 里），这里不写。
//   一批的字节数 = fixed（没有一项输入时整个提示的字节数）+ 各项的 bytesOf(item) 之和 + glue × (项数 − 1)。
//   glue 是两项之间多占的字节（JSON 数组的逗号是 1，直接接起来的文字是 0）；每项自己带着分隔的（例如一项占一行，行尾的换行算在这一项里），glue 就是 0。
//
// splitBatches：limit 是 null 或 undefined（环境没声明）：全部一批。声明了：按次序装，装不下下一项就另起一批；
//   单独一项就超过 limit 的（tooLong: [{ item, position, bytes }]，position 是它在 items 里的次序，bytes 是只装它一项时整个提示的字节数）不进任何一批，也不截，
//   怎么办由调用方定：判情绪的不判、落到默认参考；app 的文字功能报错。
//
// askBatches：每一批调一次 ask(batch)，结果按问的次序放进 results（{ batch, result }）；calls 是问了几次，含被截断的。
//   回答被截断（isCut(error) 为真，用平台给的信号，不另估每项要多少输出）：这一批对半分开，两半各问一次（先问前一半），一直分下去；
//   分到只剩一项、单独问还是被截断：交给 whenCutAlone(batch, error) 定，它返回的是这一批的结果，要停下就抛。
//   别的错原样往上抛。ask 里「这一批回答不能用」之类要继续问下一批的情况，自己接住、当结果返回。

const encoder = new TextEncoder();
/** 一段文字的 UTF-8 字节数。 */
export const utf8Length = (text) => encoder.encode(text).length;

/**
 * @template T
 * @param {T[]} items
 * @param {{ limit: number | null | undefined, fixed: number, bytesOf: (item: T) => number, glue: number }} options
 * @returns {{ batches: T[][], tooLong: { item: T, position: number, bytes: number }[] }}
 */
export function splitBatches(items, { limit, fixed, bytesOf, glue }) {
  if (items.length === 0) return { batches: [], tooLong: [] };
  if (limit === null || limit === undefined) return { batches: [items], tooLong: [] };
  const batches = [];
  const tooLong = [];
  let current = [];
  let size = fixed;
  for (const [position, item] of items.entries()) {
    const own = bytesOf(item);
    if (fixed + own > limit) {
      tooLong.push({ item, position, bytes: fixed + own });
      continue;
    }
    if (current.length > 0 && size + glue + own > limit) {
      batches.push(current);
      current = [];
      size = fixed;
    }
    size += (current.length > 0 ? glue : 0) + own;
    current.push(item);
  }
  if (current.length > 0) batches.push(current);
  return { batches, tooLong };
}

/**
 * @template T, R
 * @param {T[][]} batches
 * @param {{ ask: (batch: T[]) => Promise<R>, isCut: (error: unknown) => boolean, whenCutAlone: (batch: T[], error: unknown) => R }} options
 * @returns {Promise<{ results: { batch: T[], result: R }[], calls: number }>}
 */
export async function askBatches(batches, { ask, isCut, whenCutAlone }) {
  const results = [];
  const queue = [...batches];
  let calls = 0;
  while (queue.length > 0) {
    const batch = queue.shift();
    calls += 1;
    try {
      results.push({ batch, result: await ask(batch) });
    } catch (error) {
      if (!isCut(error)) throw error;
      if (batch.length === 1) {
        results.push({ batch, result: whenCutAlone(batch, error) });
        continue;
      }
      const half = Math.ceil(batch.length / 2);
      queue.unshift(batch.slice(0, half), batch.slice(half));
    }
  }
  return { results, calls };
}
