// SPDX-License-Identifier: Apache-2.0
//
// 预览卡片的配图：由包 ID 生成一张小图。
// 角色部分没有头像，所以配图由 ID 生成：同一个 ID 永远画出同一张图，不同的 ID 看起来不一样。
//
// 图片就是一段 SVG 文字：一个圆角方块，加五根高低不一的圆头竖条。卡片要能单独打开、不联网，所以不能引外部文件、不能用脚本画，
// 也不能用 Math.sin 这类各引擎最后一位不保证相同的函数——这里的数全用整数运算（FNV-1a 取种子、mulberry32 取数），
// 同一份输入在浏览器、Node、Bun、Windows、Linux 上画出的字节都一样（和 share.mjs 里「同样的输入同样的字节」是同一个要求）。
//
// 画法是从一个已有程序的界面截图里量出来的，不是照那个程序的代码写的：卡片属于基础部分（Apache-2.0），那个程序是 AGPL-3.0-only，不能复制它的代码。
// 2026-10-15 在 headless Edge 里打开它，在一个有名称输入的页面把名称换成 120 个不同的字符串，给它没有头像时显示的 56 像素的图截屏（8 倍像素），
// 用 canvas 量：底色是七种里的一种，竖条的颜色是底色乘 0.3（那个程序里是黑色七成、垫在底色上，这里直接写成算好的颜色），
// 五根竖条等宽（5.2）、中心在 5.6、16.8、28、39.2、50.4，高是 9 到 29 里的整数、竖直居中、两头圆，圆角半径是边长的 0.258。
// 一个 ID 落在哪种底色和哪五个高度上，这里自己定：那个程序里的图用的是声音自己的 id，卡片用包 ID，两处的图本来就不会是同一张，
// 要一样的是画法。量到的记录不在这个目录里。
//
// 同一个包在哪都是同一张图：别处的配图（例如服务端画的 PNG 和页面头部的小图）取的是 voiceOrbDesign(id) 交出来的同一份数，
// 卡片把它写成 SVG（voiceOrbSvg），服务端把它画成像素。voiceOrbDesign 只是把这个文件里已有的数（底色、竖条色、五根竖条的位置和高度）
// 换一种方式交出来：画法没有变，也没有照别人的代码写，上面那一段的来历对它同样成立。
//
// 抛出的错误（VoicePackError；details 里放什么在抛出处写明）：
//   orb_size_invalid  size 不是正整数
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from './errors.mjs';

/** 底色和它的竖条色（量到的像素值）。次序定了：第 1 个数选底色时按这个次序取。 */
export const ORB_PALETTE = Object.freeze([
  Object.freeze({ fill: '#FF5C9A', ink: '#4C1B2E' }),
  Object.freeze({ fill: '#FF5A1F', ink: '#4C1B09' }),
  Object.freeze({ fill: '#F2B705', ink: '#483701' }),
  Object.freeze({ fill: '#2FB67C', ink: '#0E3625' }),
  Object.freeze({ fill: '#12A3A8', ink: '#053132' }),
  Object.freeze({ fill: '#2F7CF6', ink: '#0E2549' }),
  Object.freeze({ fill: '#8A6D3B', ink: '#292011' }),
]);

const CANVAS = 56;                 // 画布边长：和量到的那张一样
const CORNER = 14.45;              // 圆角半径（0.258 倍边长）
const BAR_WIDTH = 5.2;
const BAR_GAP = 6;
const BAR_FIRST_CENTER = 5.6;      // 第一根的中心：3（留白）+ 5.2 / 2
const BAR_COUNT = 5;
const BAR_MIN_HEIGHT = 9;
const BAR_LEVELS = 21;             // 高 9 到 29，二十一种
const DEFAULT_TITLE = null;

/** FNV-1a，32 位，对文本的 UTF-8 字节。全整数运算，任何引擎上结果一样。 */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32：一个 32 位整数种子，每次给一个 0 到 2^32-1 的整数。全整数运算。 */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** 把一个 ID 变成一套画法：底色和五根竖条的高度（0 到 20 的档，画的时候加 9）。 */
function designOf(id) {
  const next = mulberry32(fnv1a(id));
  const color = ORB_PALETTE[next() % ORB_PALETTE.length];
  const heights = Array.from({ length: BAR_COUNT }, () => next() % BAR_LEVELS);
  return { color, heights };
}

const escapeXml = (text) => String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);

/**
 * 一个 ID 的画法：底色、竖条色，和五根竖条的几何，单位是 56 的画布（canvas）。voiceOrbSvg 画的就是它；别的出图方式（服务端把它画成 PNG）取它，
 * 画出来的就和卡片上的是同一张。底是 canvas 乘 canvas 的圆角方块（圆角半径 corner），竖条的 x、y 是左上角，rx 是圆头的半径；
 * 数和 voiceOrbSvg 写进 SVG 的一样（位置已经取到两位小数）。
 * @param {string} id 包 ID（或任何字符串）
 * @returns {{ canvas: number, corner: number, fill: string, ink: string, bars: { x: number, y: number, width: number, height: number, rx: number }[] }}
 * @throws {TypeError} id 不是字符串
 */
export function voiceOrbDesign(id) {
  if (typeof id !== 'string') throw new TypeError('voiceOrbDesign 的 id 必须是字符串');
  const { color, heights } = designOf(id);
  const bars = heights.map((level, index) => {
    const height = BAR_MIN_HEIGHT + level;
    const center = BAR_FIRST_CENTER + index * (BAR_WIDTH + BAR_GAP);
    const x = round(center - BAR_WIDTH / 2);
    const y = round((CANVAS - height) / 2);
    return { x, y, width: BAR_WIDTH, height, rx: BAR_WIDTH / 2 };
  });
  return { canvas: CANVAS, corner: CORNER, fill: color.fill, ink: color.ink, bars };
}

/**
 * 由 ID 画一张图（SVG 文字）。
 * @param {string} id 包 ID（或任何字符串）
 * @param {{ size?: number, title?: string }} [options] size 是边长（像素），默认 56；title 给了就是有意义的图（读屏读它），不给就是装饰图
 * @returns {string} 一段自包含的 SVG：不引用外部东西，没有脚本
 * @throws {VoicePackError} orb_size_invalid：size 不是正整数
 */
export function voiceOrbSvg(id, options = {}) {
  if (typeof id !== 'string') throw new TypeError('voiceOrbSvg 的 id 必须是字符串');
  const size = options.size ?? CANVAS;
  if (!Number.isInteger(size) || size <= 0) {
    throw new VoicePackError('orb_size_invalid', `配图的边长要是正整数，收到 ${JSON.stringify(options.size)}`, { details: { size: options.size } });
  }
  const { canvas, corner, fill, ink, bars } = voiceOrbDesign(id);
  const title = options.title ?? DEFAULT_TITLE;
  const header = title === null
    ? `role="presentation" aria-hidden="true"`
    : `role="img" aria-label="${escapeXml(title)}"`;
  const rects = [{ x: 0, y: 0, width: canvas, height: canvas, rx: corner, fill }, ...bars.map((bar) => ({ ...bar, fill: ink }))];
  const body = rects.map((rect) => `<rect x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.width)}" height="${num(rect.height)}" rx="${num(rect.rx)}" fill="${rect.fill}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${CANVAS} ${CANVAS}" ${header}>${title === null ? '' : `<title>${escapeXml(title)}</title>`}${body}</svg>`;
}

/** 去掉小数末尾的零（5.20 → 5.2，28.00 → 28）：写出来的字节各处一致，好认。 */
const num = (value) => String(round(value));
const round = (value) => Math.round(value * 100) / 100;
