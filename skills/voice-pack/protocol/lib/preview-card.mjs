// SPDX-License-Identifier: Apache-2.0
//
// 预览卡片：分享文件里那张不靠其他文件就能直接打开、能试听的页面。
//
//   buildPreviewCard(manifest, options)   角色部分的清单（加上它的文件）→ 一页自包含的 HTML（文字）
//
// 卡片是什么：
//   一页静态的 HTML，放在分享文件的根上（index.html，和 README.md 并列），打包时生成，不列进清单，不参与检查，读的人也从不执行它（FORMAT.md「分享文件」）。
//   双击就能在浏览器里打开：名字和配图，一段内嵌的试听，验证记录里的还原度（有的话），调用方给的两个入口。不依赖包里的任何别的文件，不联网。
//   只给角色部分做（基础部分里没有声音）。同样的输入同样的字节：没有时间、随机数（和 share.mjs 里「同样的输入同样的字节」是同一个要求）。
//
// 页面上有什么：
//   名字      标题；包 ID 和版本写在它下面。配图由包 ID 画（voice-orb.mjs：同一个 ID 同一张图，不放头像）。
//   试听      默认参考段的音频，内嵌成 data: 地址放进 <audio controls>，旁边是这一段的逐字文本。放不下就截短，不重新编码，规则和上限见 preview-audio.mjs；
//            截短了写明放了前几秒。默认段的字节不在包里、放不下又切不了的，换下一段；一段都没有，写明「没有内嵌的试听」和原因，不留空白。
//            示例台词（sampleLines）只是文字，格式里没有它的音频，所以试听总是一段真录音。
//   还原度    验证记录（manifest.verification）里的，每条一行：环境、模型、日期、比值。读法只在 lib/fidelity.mjs 的文件头写一份（「怎么读这份报告」第 7 条）：
//            比值本身就是分数，照数显示（两位小数，和 app 的显示一样），不设门槛，不封顶，不替人下「像不像」的结论，没写比值的显示「—」；
//            旁边写明比值怎么来的、1 表示什么、这是作者附上的记录、没有重新量过。没有验证记录就写明没有，不留空白。
//   入口      两个链接，只来自调用方（options.links）：「在 <产品名> 里打开」和「做一个你自己的」；没给哪个就没有哪个，都没给就没有入口。
//   页脚      一句话：卡片在打包时生成，不在清单里、不参与检查，导入时检查的是包本身。
//
// 链接和产品名只来自调用方：通用层（这个文件）不写死任何产品的名字和地址，产品的值（名字、app 的地址、导入和「做一个你自己的」的入口）来自产品契约
// （适配器的 product-contract.json 里的 previewCard），app 导出和命令行打包把它们传进来。链接里的 {id} 换成包 ID（按 URL 组件的规则编码），换完要是 http 或 https 的地址。
//
// 页面怎么保证自包含、不能联网：
//   没有 <script>，没有任何会执行的东西（事件属性、javascript: 地址）；不引用外部的图片、字体、样式、脚本；配图是内联的 <svg>，样式是内联的 <style>。
//   <head> 里有内容安全策略：default-src 'none'（默认什么都不让加载），只放开 data: 的音频（media-src）和页面自己的内联样式（style-src）。
//   所以就算作者的文字里夹了标记（名字、台词、环境名……），它们全部转义以后才进页面，也进不了脚本；双击打开的 file:// 页面读不了别的文件、连不了网。
//   字符集写在 <head> 最前面：file:// 打开时没有 HTTP 头，浏览器按它认编码。
//   两种语言：每个标签、每句说明都是中文在前、英文在后（和 README 一样）。深色模式跟着系统。
//
// 抛出的错误（VoicePackError；details 里放什么在抛出处写明）：
//   card_link_invalid   options.links 里的链接不是 http 或 https 的地址（{id} 换完以后算）。details: { field: 'open' | 'make', link, reason }，
//                       reason：not_text（不是字符串）、not_a_url（不是完整的地址：相对地址、空串、缺主机……）、scheme_not_http（javascript:、data:、file: 等别的协议）
// 参数不对（清单不是角色部分、files 不是 Map、产品名不是字符串……）抛 TypeError。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。
import { VoicePackError } from './errors.mjs';
import { toBase64 } from './bytes.mjs';
import { voiceOrbSvg } from './voice-orb.mjs';
import { choosePreviewAudio } from './preview-audio.mjs';

/** 卡片的内容安全策略：什么都不让加载，除了 data: 的音频和页面自己的内联样式。 */
export const PREVIEW_CARD_CSP = "default-src 'none'; media-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const ORB_SIZE = 72;
const NO_RATIO = '—';
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

/** 中文在前、英文在后。两段文字都是调用方已经转义好的。 */
const both = (zh, en) => `<span lang="zh-CN">${zh}</span> <span lang="en">${en}</span>`;

const badLink = (field, link, reason) => new VoicePackError('card_link_invalid', `预览卡片的链接 ${field} 必须是 http 或 https 的地址（原因：${reason}）`, { details: { field, link, reason } });

/** 把链接模板里的 {id} 换成包 ID，核对换完是 http(s) 的地址。给 null 或 undefined 表示没有这个链接。 */
function resolveLink(template, field, id) {
  if (template === undefined || template === null) return null;
  if (typeof template !== 'string') throw badLink(field, template, 'not_text');
  const link = template.split('{id}').join(encodeURIComponent(id));
  let parsed;
  try { parsed = new URL(link); } catch { throw badLink(field, template, 'not_a_url'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw badLink(field, template, 'scheme_not_http');
  return link;
}

/** 比值：非负的有限数才显示，两位小数；别的（没写、负数、NaN、文字）是「—」，不替它猜一个数。 */
function ratioText(record) {
  const ratio = record?.fidelity?.ratio;
  return typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0 ? ratio.toFixed(2) : NO_RATIO;
}

/** 秒数：一位小数，整数不带小数点（8、2.4）。 */
const secondsText = (seconds) => String(Number(seconds.toFixed(1)));

function auditionSection(manifest, audition) {
  const heading = `<h2>${both('试听', 'Audition')}</h2>`;
  if (audition === null) {
    return `<section class="audition">${heading}<p class="note">${both('这张卡片没有内嵌的试听：参考录音不在这个文件里，或者太大放不进卡片。', 'No audition is embedded on this card: the reference recordings are not inside this file, or are too big to fit on it.')}</p></section>`;
  }
  const segment = (manifest.reference?.segments ?? []).find((candidate) => candidate.id === audition.segmentId);
  const language = typeof segment?.tags?.language === 'string' ? ` lang="${escapeHtml(segment.tags.language)}"` : '';
  const excerpt = audition.trimmed && audition.seconds !== null
    ? `<p class="note">${both(`只放了这段录音的前 ${secondsText(audition.seconds)} 秒。`, `Only the first ${secondsText(audition.seconds)} seconds of this recording are embedded.`)}</p>`
    : '';
  const line = segment?.text === undefined ? '' : `<p class="line"${language}>${escapeHtml(segment.text)}</p>`;
  return `<section class="audition">${heading}<audio controls preload="metadata" src="data:${audition.mimeType};base64,${toBase64(audition.bytes)}"></audio>${line}${excerpt}</section>`;
}

function fidelitySection(manifest) {
  const heading = `<h2>${both('还原度', 'Fidelity')}</h2>`;
  const records = Array.isArray(manifest.verification) ? manifest.verification : [];
  if (records.length === 0) {
    return `<section class="fidelity">${heading}<p class="note">${both('没有验证记录：作者没有量过，或者没有附上。', 'No verification record: the author did not measure it, or did not include it.')}</p></section>`;
  }
  const rows = records.map((record) => `<li class="record"><span class="ratio">${escapeHtml(ratioText(record))}</span><span class="what">${escapeHtml(record?.environment ?? '')} · ${escapeHtml(record?.model ?? '')} · ${escapeHtml(record?.date ?? '')}</span></li>`).join('');
  const zh = '比值：用这个包生成的声音和这个人的真录音之间的说话人相似度，除以这个人自己的真录音两两之间的相似度。1 表示和这个人自己的真录音之间一样像。照数显示，不设门槛。这是作者随包附上的验证记录，没有重新量过。';
  const en = "Ratio: the speaker similarity between the voice this pack generates and the person's real recordings, divided by the similarity among the person's own real recordings. 1 means as alike as the person's own recordings are to each other. Shown as recorded, with no threshold. These are the verification records the author put in the pack; they have not been measured again.";
  return `<section class="fidelity">${heading}<ul class="records">${rows}</ul><p class="note">${both(zh, en)}</p></section>`;
}

function actionsSection(productName, open, make) {
  const anchors = [];
  if (open !== null) {
    const zh = productName === null ? '打开' : `在 ${escapeHtml(productName)} 里打开`;
    const en = productName === null ? 'Open' : `Open in ${escapeHtml(productName)}`;
    anchors.push(`<a class="primary" href="${escapeHtml(open)}" target="_blank" rel="noopener noreferrer">${both(zh, en)}</a>`);
  }
  if (make !== null) anchors.push(`<a class="secondary" href="${escapeHtml(make)}" target="_blank" rel="noopener noreferrer">${both('做一个你自己的', 'Make your own')}</a>`);
  return anchors.length === 0 ? '' : `<nav class="actions">${anchors.join('')}</nav>`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f4f3ef;--card:#fff;--ink:#1b1b1f;--muted:#6a6a74;--line:#e5e3dd;--accent:#1b1b1f;--accent-ink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--card:#1b1b1f;--ink:#f2f1ee;--muted:#9b9ba6;--line:#2f2f36;--accent:#f2f1ee;--accent-ink:#111113}}
*{box-sizing:border-box}
body{margin:0;padding:32px 16px;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif}
main{max-width:560px;margin:0 auto;padding:28px;background:var(--card);border:1px solid var(--line);border-radius:20px}
header{display:flex;gap:16px;align-items:center}
header svg{flex:none;display:block}
h1{margin:0;font-size:26px;line-height:1.2;overflow-wrap:anywhere}
.meta{margin:4px 0 0;color:var(--muted);font-size:13px;overflow-wrap:anywhere}
h2{margin:28px 0 10px;color:var(--muted);font-size:13px;font-weight:600;letter-spacing:.06em}
h2 [lang=en]{margin-left:.35em;font-weight:400}
audio{display:block;width:100%}
.line{margin:12px 0 0;padding-left:12px;border-left:3px solid var(--line);overflow-wrap:anywhere}
.note{margin:8px 0 0;color:var(--muted);font-size:13px}
.note [lang=en],footer [lang=en]{display:block;margin-top:4px}
.records{margin:0;padding:0;list-style:none}
.record{display:flex;gap:14px;align-items:baseline;padding:10px 0;border-top:1px solid var(--line)}
.record:first-child{border-top:0;padding-top:0}
.ratio{min-width:3.4em;font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}
.what{color:var(--muted);font-size:14px;overflow-wrap:anywhere}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:28px}
.actions a{flex:1 1 200px;display:block;padding:12px 16px;border:1px solid var(--line);border-radius:12px;color:var(--ink);text-align:center;text-decoration:none;font-weight:600}
.actions a [lang=en]{display:block;font-size:12px;font-weight:400;opacity:.75}
.actions a.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.actions a:focus-visible{outline:3px solid #2f7cf6;outline-offset:2px}
footer{margin-top:28px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
@media (max-width:480px){body{padding:16px 10px}main{padding:20px}}
`.trim();

/**
 * 生成预览卡片。
 * @param {{ part: 'role', id: string, version: string, name: string, reference: object, verification?: object[] }} manifest 角色部分的清单（清单已经检查过：这里不再校验字段的写法）
 * @param {object} [options]
 * @param {Map<string, Uint8Array>} [options.files] 角色部分的文件（路径相对角色部分的目录），试听的音频从这里取；不给就没有试听
 * @param {string} [options.productName] 产品的名字，写进「在 X 里打开」；不给，入口就是通用的「打开」
 * @param {{ open?: string, make?: string }} [options.links] 两个入口的链接（可以带 {id}）：open 是「在 X 里打开」，make 是「做一个你自己的」；没给哪个，页面上就没有哪个
 * @param {{ maxSeconds?: number, maxBytes?: number }} [options.audio] 试听的上限，默认见 preview-audio.mjs
 * @returns {string} HTML 文字（UTF-8）
 * @throws {VoicePackError} card_link_invalid
 * @throws {TypeError} 清单不是角色部分、files 不是 Map、productName 不是字符串、links 不是对象
 */
export function buildPreviewCard(manifest, options = {}) {
  if (manifest === null || typeof manifest !== 'object' || manifest.part !== 'role') throw new TypeError('预览卡片只给角色部分生成：清单的 part 必须是 role');
  const files = options.files ?? new Map();
  if (!(files instanceof Map)) throw new TypeError('files 必须是 Map<路径, Uint8Array>');
  if (options.productName !== undefined && typeof options.productName !== 'string') throw new TypeError('productName 必须是字符串');
  const links = options.links ?? {};
  if (links === null || typeof links !== 'object' || Array.isArray(links)) throw new TypeError('links 必须是 { open?, make? } 对象');
  const productName = (options.productName ?? '').trim() === '' ? null : options.productName.trim();

  const id = String(manifest.id ?? '');
  const name = String(manifest.name ?? manifest.id ?? '');
  const open = resolveLink(links.open, 'open', id);
  const make = resolveLink(links.make, 'make', id);
  const audition = choosePreviewAudio(manifest, files, options.audio);

  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CARD_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(name)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    `<header>${voiceOrbSvg(id, { size: ORB_SIZE })}<div><h1>${escapeHtml(name)}</h1><p class="meta"><code>${escapeHtml(id)}</code> · v${escapeHtml(manifest.version ?? '')}</p></div></header>`,
    auditionSection(manifest, audition),
    fidelitySection(manifest),
    actionsSection(productName, open, make),
    `<footer>${both('这张卡片在打包时生成，不在清单里，不参与检查：导入时检查的是包本身。', 'This card is made when the pack is made. It is not listed in the manifest and is not part of any check; what an import checks is the pack itself.')}</footer>`,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
