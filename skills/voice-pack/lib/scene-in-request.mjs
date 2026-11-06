// SPDX-License-Identifier: Apache-2.0
//
// 一场戏一个请求（lib/dub.mjs 的第 5a 步）：台本里一段连续的、几个说话人轮流说的话，放进一个 text-to-dialogue 请求（环境声明了 scene-in-request，见 vocab/capability-signatures.md）。
// 这个文件只回答两件事，规则只写在这里：哪几段连成一场（sceneRuns），一个说话人整场用他挑到的哪一段参考（mostPicked）。每一轮怎么写、传给环境什么，是 lib/dub.mjs 的事；
// 每一轮在平台上怎么写，是适配器的事（基础部分里没有平台的写法）。给使用者的说法在 references/dub.md 的「一场戏一个请求」；规则改了，两处一起改，别处只指过来。
//
// 一场 = 连续的几段，每相邻的两段都满足：
//   同一章；同一个语速（一个请求只有一个音频，拼接时只能整段变速）；两段之间没有作者写的停顿（前一段的 pauseAfterMs 加后一段的 pauseBeforeMs 为 0：
//   模型写不出长的停顿，作者写的停顿留给拼接的人插）；说话人数不超过 maxSpeakers（环境声明的，没有就不限）；两段的包都没有 dub 脚本（脚本的 text 钩子要看到每一句）。
// 一场至少两个说话人：只有一个人说话的一段（独白，或者切完只剩一个人）不成场，照旧用 voice-cloning（lib/dub.mjs 第 5c 步：同一章放得下就一个请求）。
//
// 一个说话人整场只有一段参考（平台一个请求里一个说话人一个声音）：取他各轮挑到的参考段里次数最多的，并列取先出现的。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。

/** 这个 unit 是不是一场戏（dub 第 5a 步造的，一个请求配几行；别的 unit 没有 scene）。散在 dub、命令行里的判断都用它。 */
export const isScene = (unit) => unit.scene !== undefined;

/** 平台说一场装不下时，适配器给错误标的 details.problem（vocab/capability-signatures.md 的 text-to-dialogue 一节）：dub 据此说明是哪一场、怎么办，不自动切开，不重发。 */
export const TOO_LONG_FOR_ONE_REQUEST = 'too_long_for_one_request';

/**
 * 把一串段（planned 的、按台本的次序）分成几场。
 * @param {{ chapter: number, speed: number|null, pauseBeforeMs: number, pauseAfterMs: number, pack: string }[]} units
 * @param {{ eligible: (unit: object) => boolean, maxSpeakers: number }} options eligible：这一段能不能进场；maxSpeakers：一场最多几个说话人（不限就给 Infinity）
 * @returns {{ first: number, last: number }[]} 每一场的头和尾（units 的下标，含头含尾），按次序；至少两个说话人的才算
 */
export function sceneRuns(units, { eligible, maxSpeakers }) {
  const runs = [];
  let first = null;
  let packs = new Set();
  const close = (last) => {
    if (first !== null && packs.size >= 2) runs.push({ first, last });
    first = null;
    packs = new Set();
  };
  units.forEach((unit, at) => {
    if (!eligible(unit)) {
      close(at - 1);
      return;
    }
    if (first !== null) {
      const before = units[at - 1];
      const speakers = packs.has(unit.pack) ? packs.size : packs.size + 1;
      const seam = before.chapter === unit.chapter && before.speed === unit.speed && before.pauseAfterMs + unit.pauseBeforeMs === 0 && speakers <= maxSpeakers;
      if (!seam) close(at - 1);
    }
    if (first === null) first = at;
    packs.add(unit.pack);
  });
  close(units.length - 1);
  return runs;
}

/**
 * 一串参考段 id（按各轮出现的次序）里次数最多的那一个；并列取先出现的。没有就是 null。
 * @param {string[]} segmentIds
 * @returns {string|null}
 */
export function mostPicked(segmentIds) {
  const counts = new Map(); // Map 按首次出现的次序遍历，所以并列时严格大于才换，留下的是先出现的
  for (const id of segmentIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  let best = null;
  for (const [id, times] of counts) if (best === null || times > best.times) best = { id, times };
  return best === null ? null : best.id;
}
