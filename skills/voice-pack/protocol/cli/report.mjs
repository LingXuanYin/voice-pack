// SPDX-License-Identifier: Apache-2.0
//
// 检查报告的文字版：check、unpack、pack 都用它把 { ok, problems, parts, signatures, mutual } 写给人看。
// 机器读的版本是 --json：整份报告原样输出，字段见 protocol/lib/check.mjs 的文件头。
//
// 问题多的时候只列前 MAX_LINES 条，说明还有多少：恶意的包可以造出海量的问题，不能刷满终端。--json 给的是全部。
// 通过的报告在部分的清单后面再写两行：签名验过几份（谁签的）、互相校验做没做；没验、没做的要明说，不能让人以为验过了。
import { partName } from '../lib/manifest.mjs';

const MAX_LINES = 100;
const MUTUAL_SKIPPED = {
  no_base: '这个包里没有基础部分，进入环境、补全了基础部分以后再校验',
  no_role: '单独的基础部分或协议核心，没有角色部分可对',
};

const where = (part) => (part === '' ? '根' : part);

/**
 * 命令行里说一个部分的写法：「角色部分 mira-k3x9q2vd 1.0.0」「基础部分 1.0.0」「协议核心 1.0.0」。
 * 种类的名字来自 lib/manifest.mjs 的表；包 ID 只有角色部分有，别的种类给了也不写。check、seal、unpack 都用它。
 */
export function partTitle(kind, id, version) {
  return `${partName(kind)}${kind === 'role' && id ? ` ${id}` : ''} ${version}`;
}

function partLine(part) {
  return `  ${partTitle(part.kind, part.id, part.version)}（${where(part.part)}，清单列了 ${part.files} 个文件，协议 ${part.protocol}）`;
}

function problemLine(problem) {
  return `  [${problem.code}] ${problem.message}${problem.part ? `（在 ${problem.part}）` : ''}`;
}

/** 签名的概况：验过几份、哪几份没有签名文件所以没验（--allow-unsigned）、哪几份有签名文件但这次没验。 */
function signatureLines(report, { onlyUnchecked }) {
  const lines = [];
  const verified = report.signatures.filter((entry) => entry.verified === true);
  if (verified.length > 0 && !onlyUnchecked) {
    const keyIds = [...new Set(verified.map((entry) => entry.keyId).filter((keyId) => typeof keyId === 'string'))];
    lines.push(`  签名：验过 ${verified.length} 份（${verified.map((entry) => where(entry.part)).join('、')}）${keyIds.length > 0 ? `，key id ${keyIds.join('、')}` : ''}`);
  }
  const unsigned = report.signatures.filter((entry) => entry.skipped === 'unsigned');
  if (unsigned.length > 0 && !onlyUnchecked) lines.push(`  签名：${unsigned.length} 个部分没有签名文件，没有验（--allow-unsigned）：${unsigned.map((entry) => where(entry.part)).join('、')}`);
  const unchecked = report.signatures.filter((entry) => entry.present && entry.verified === null && entry.skipped === undefined);
  if (unchecked.length > 0) lines.push(`  签名：${unchecked.length} 份签名文件没有核对（这次检查没有验签）`);
  return lines;
}

function mutualLine(report) {
  const mutual = report.mutual;
  if (mutual === undefined || mutual.reason === 'not_requested') return [];
  if (mutual.checked) return ['  互相校验：通过（协议主版本、基础部分的版本、所需能力）'];
  return MUTUAL_SKIPPED[mutual.reason] === undefined ? [] : [`  互相校验：没做（${MUTUAL_SKIPPED[mutual.reason]}）`];
}

/**
 * @param {{ ok: boolean, problems: object[], parts: object[], signatures: object[], mutual?: object }} report
 * @param {string} subject 检查的是什么（路径），写在第一行
 * @returns {string} 以换行结尾的文字
 */
export function formatReport(report, subject) {
  const lines = [];
  if (report.ok) {
    lines.push(`通过：${subject}`);
    for (const part of report.parts) lines.push(partLine(part));
    lines.push(...signatureLines(report, { onlyUnchecked: false }), ...mutualLine(report));
  } else {
    lines.push(`不通过：${subject}（${report.problems.length} 处问题）`);
    for (const problem of report.problems.slice(0, MAX_LINES)) lines.push(problemLine(problem));
    if (report.problems.length > MAX_LINES) lines.push(`  …还有 ${report.problems.length - MAX_LINES} 处，加 --json 看全部`);
    lines.push(...signatureLines(report, { onlyUnchecked: true }));
  }
  return `${lines.join('\n')}\n`;
}
