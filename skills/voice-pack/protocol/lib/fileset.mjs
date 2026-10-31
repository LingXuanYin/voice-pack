// SPDX-License-Identifier: Apache-2.0
//
// 文件集：一个部分（或整个包）的文件，Map<路径, Uint8Array>，路径用 /，相对这个部分的目录。
// seal.mjs、check.mjs、pack.mjs、share.mjs 都用它，所以检查和小工具只写在这一处。
//
// 模块约定见 protocol/README.md：只用平台自带的 API，浏览器和 Node 都能跑。

/** 不是合格的文件集就抛 TypeError。 */
export function assertFileSet(files) {
  if (!(files instanceof Map)) throw new TypeError('文件集必须是 Map<路径, Uint8Array>');
  for (const [path, data] of files) {
    if (typeof path !== 'string') throw new TypeError('文件集的键必须是字符串路径');
    if (!(data instanceof Uint8Array)) throw new TypeError(`文件 ${JSON.stringify(path)} 的内容必须是 Uint8Array`);
  }
}

/** 把文件集放进一个子目录：{ a: … } → { dir/a: … }。 */
export function withPrefix(directory, files) {
  return new Map([...files].map(([path, data]) => [`${directory}/${path}`, data]));
}

/** 取出一个子目录里的文件，去掉前缀：{ dir/a: … , b: … } → { a: … }。 */
export function subtree(files, directory) {
  const prefix = `${directory}/`;
  return new Map([...files].filter(([path]) => path.startsWith(prefix)).map(([path, data]) => [path.slice(prefix.length), data]));
}
