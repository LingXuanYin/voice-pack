// SPDX-License-Identifier: Apache-2.0
//
// 报出去之前的打码：平台、模型或本机程序的原话里，令牌、刷新令牌、ID 令牌、API key、client secret、密码、私钥、cookie、带签名的地址，不管写成哪种形状，都去掉。
// 一条规则一处写：各平台的适配器、命令行层的程序运行时、脚本运行时、进程适配器、库自己收进报告的回答，都从这里引，不各写一份。
// 报的是原话全文，不截：这里只去掉会泄露的东西，别的字一个不动。
//
//   reportable(value, token)   原话（字符串，或者抛出来的错）→ 能报给使用者的字符串。token 是调用方知道的那一个令牌，可省
//   scrubbedCause(error)       错误进另一个错误的 cause 之前：换成一份复制。name、message、stack 和字符串字段都过 reportable；数字和布尔照抄；
//                              对象字段不复制（它们可能带着令牌）。cause 链一环一环照样复制，链多长都复制；走过的对象再遇到就停，不死循环
//
// reportable 依次做下面几件事（按形状认，不靠持有令牌的值；只有 token 参数是调用方给的确切的值）：
//   1. token 原样出现的，换成 [token]
//   2. 形状像 JWT 的串（eyJ 开头，两个点分开的三段 base64url）换成 [token]
//   3. PEM 块（-----BEGIN …----- 开头，到 -----END …----- 为止；没有结尾的取到文字末尾，写到一半被截断的私钥也不留）整块换成 [token]
//   4. Bearer 后面的一串换成 [token]，句末的标点留着
//   5. Authorization、Cookie、Set-Cookie 的值取到行尾或引号为止，换成 [token]（Basic、Bearer 或别的，都是凭据）
//   6. 键名的值换成 [token]。键名（JSON 的键，或 key=value、key: value 的键，大小写不分）以 token、secret、password、private_key、api-key、api_key、apikey、api key 结尾：
//      access_token、refresh_token、id_token、x-api-key、client_secret 都认。键名和冒号之间可以隔一个 provided、supplied、given、received、used、passed、sent、specified、submitted
//      （平台回显使用者给的 key：「Incorrect API key provided: <值>」）。值写在引号里的，取到闭合的引号为止（里面的空白、逗号、分号、& 都是值的一部分；闭合的引号前面的反斜杠转义的引号不算闭合）；
//      没有引号的，取到空白、逗号、分号、& 或 } 之前的一串（没有引号，哪里结束就没法知道）
//   7. 带固定前缀的 key，裸写在正文里、前面没有键名的：sk- 或 AIza 开头，后面至少 16 个字母、数字、下划线或连字符，整串换成 [token]
//   8. 网址的查询串换成 ?[query]：签名、过期时间、令牌都在那里。主机、路径和片段（#…）留下；句末的标点和 Markdown 链接的右括号留在网址后面
//   9. 网址里主机前面的用户信息（scheme://用户:密码@主机）换成 [token]：scheme://[token]@主机
// 幂等：打过码的再打一遍，结果不变（[token] 和 ?[query] 不会再被认成别的东西）。适配器打过的错，库再包一层、再打一次，还是同样的字。
// 长度：耗时跟着原话的长度线性增长。一长串字母数字（base64 的回答、回显的音频）里没有任何一条规则要从每个起点往后扫一遍：
// 键名前面的字符从一串字符的开头起算，不从每个字符起算；JWT 的三段、网址末尾的标点，都只扫一遍。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。

const BEARER = /\bBearer\s+[^\s"',;]+/gi;
const CREDENTIAL_HEADER = /(["']?\b(?:authorization|cookie)["']?\s*[:=]\s*["']?)[^"'\r\n]*/gi;
// PEM 块：-----BEGIN 标签----- 到 -----END 标签-----，没有结尾的取到文字末尾（$ 没有 m 标志，只在整段文字末尾成立）
const PEM = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g;
// 值有两种写法：引号里的（取到同一种闭合的引号，至少一个字），或者没有引号的（取到空白、引号、逗号、分号、& 或 } 之前）。打码留下开头的引号，闭合的引号不动。
// 开头的 (?<![A-Za-z0-9_-]) 让匹配只从一串键名字符的开头起：没有它，一长串字母数字里每个起点都向后吃到串尾、再一个字一个字地退回来找键名，耗时随长度平方增长。
// 结果和没有它时一样：匹配总是从一串字符的开头起（同一串里更靠后的起点，开头那个起点也一定匹配得上，而且在它前面）
const KEYED = /(?<![A-Za-z0-9_-])(["']?[A-Za-z0-9_-]*(?:token|secret|password|private[_-]?key|api[ _-]?key)(?:\s+(?:provided|supplied|given|received|used|passed|sent|specified|submitted))?["']?\s*[:=]\s*)(?:(["'])(?:\\.|(?!\2)[^\\\r\n])+|[^\s"',;&}]+)/gi;
// 固定前缀的 key：sk-、AIza 开头，后面至少 16 个 key 字符
const PREFIXED = /\b(?:sk-|AIza)[A-Za-z0-9_-]{16,}/g;
// 网址：查询串里的 ?[query] 整个吃进来，下一遍打码就不会多出一个 ]
const ADDRESS = /https?:\/\/(?:\[query\]|[^\s"'<>)\]])+/gi;
// 网址里的用户信息：scheme:// 后面、第一个 @ 之前（不跨过 / ? #）。scheme 前面的 (?<![A-Za-z0-9+.-]) 理由同 KEYED
const USER_INFO = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#"'<>@]+@/g;

/** 文字末尾连着的那一串 chars 里的字符（没有就是空串）。从末尾往前数，只扫这一串：用 /[.]*$/ 从每个起点各扫一遍，一长串标点里耗时随长度平方增长。 */
const trailing = (text, chars) => {
  let start = text.length;
  while (start > 0 && chars.includes(text[start - 1])) start -= 1;
  return text.slice(start);
};
const dots = (text) => trailing(text, '.');

/**
 * 形状像 JWT 的串换成 [token]：\beyJ、第一段（base64url 字符，至少一个）、点、第二段（同上）、点、第三段（可以空）。
 * 和正则 \beyJ[\w-]+\.[\w-]+\.[\w-]*（全局）的结果一样；不用它，是因为 eyJ 后面那一段没有以点结尾的话，同一串里每个 eyJ 都要再扫一遍到串尾（eyJ-eyJ-eyJ-… 平方增长）。
 * 这里一个起点失败了，同一段字符里更靠后的 eyJ 一定也失败（它们的第一段在同一处结束），所以直接跳到这一段的末尾。
 */
function maskJwt(text) {
  if (!text.includes('eyJ')) return text;
  const start = /\beyJ/g;
  const run = /[\w-]*/y;
  const runEnd = (from) => {
    run.lastIndex = from;
    run.exec(text);
    return run.lastIndex;
  };
  let out = '';
  let copied = 0;
  for (let found = start.exec(text); found !== null; found = start.exec(text)) {
    const from = found.index + 3;
    const first = runEnd(from);
    if (first > from && text[first] === '.') {
      const second = runEnd(first + 1);
      if (second > first + 1 && text[second] === '.') {
        const last = runEnd(second + 1);
        out += `${text.slice(copied, found.index)}[token]`;
        copied = last;
        start.lastIndex = last;
        continue;
      }
    }
    start.lastIndex = first;
  }
  return out + text.slice(copied);
}

/**
 * 原话打码（规则见文件头）。
 * @param {unknown} value 原话（字符串，或者抛出来的错）
 * @param {string} [token] 调用方知道的令牌
 * @returns {string}
 */
export function reportable(value, token) {
  let text = String(value);
  if (typeof token === 'string' && token !== '') text = text.split(token).join('[token]');
  text = maskJwt(text);
  text = text.replace(PEM, '[token]');
  text = text.replace(BEARER, (match) => `Bearer [token]${dots(match)}`);
  text = text.replace(CREDENTIAL_HEADER, '$1[token]');
  text = text.replace(KEYED, (_match, head, quote) => `${head}${quote ?? ''}[token]`);
  text = text.replace(PREFIXED, '[token]');
  text = text.replace(ADDRESS, (address) => {
    const tail = trailing(address, '.,;:!?');
    const core = address.slice(0, address.length - tail.length);
    const hash = core.indexOf('#');
    const head = hash === -1 ? core : core.slice(0, hash);
    return `${head.replace(/\?.*$/s, '?[query]')}${hash === -1 ? '' : core.slice(hash)}${tail}`;
  });
  return text.replace(USER_INFO, '$1[token]@');
}

/**
 * 包 SDK 的错误进 VoicePackError 的 cause：原来的错误不留在 cause 里。它的 message、stack 和字符串字段（网址……）里可能有令牌和签名的地址，
 * 打印 error 或 error.cause 就都看得到。这里换成一份复制（规则见文件头）。
 * @param {unknown} error 要包进去的错误
 * @returns {unknown}
 */
export function scrubbedCause(error) {
  // 先沿链走一遍，记下每一环；走过的对象记在 seen 里，再遇到就停
  const seen = new Set();
  const links = [];
  let next = error;
  while (next !== null && typeof next === 'object' && !seen.has(next)) {
    seen.add(next);
    links.push(next);
    next = next.cause;
  }
  // 链的末端：字符串过 reportable，别的原值照抄；环回到走过的对象，或者没有 cause，就是 undefined
  let copied = next === null || next === undefined ? next : typeof next === 'object' ? undefined : typeof next === 'string' ? reportable(next) : next;
  // 从末端往前复制：每一环的 cause 是它后面那一环的复制
  for (let i = links.length - 1; i >= 0; i--) copied = copyOfError(links[i], copied);
  return copied;
}

/** 链上的一环的复制（scrubbedCause 用）：文字过 reportable，数字和布尔照抄，对象字段不复制；cause 是后面那一环的复制，没有 cause 的环就不带。 */
function copyOfError(error, cause) {
  const copy = new Error(reportable(typeof error.message === 'string' ? error.message : String(error)), error.cause === undefined ? undefined : { cause });
  copy.name = reportable(typeof error.name === 'string' ? error.name : 'Error');
  if (typeof error.stack === 'string') copy.stack = reportable(error.stack);
  for (const key of Object.keys(error)) {
    if (key === 'message' || key === 'stack' || key === 'cause' || key === 'name') continue;
    const value = error[key];
    if (typeof value === 'string') copy[key] = reportable(value);
    else if (typeof value === 'number' || typeof value === 'boolean') copy[key] = value;
  }
  return copy;
}
