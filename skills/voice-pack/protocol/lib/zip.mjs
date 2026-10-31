// SPDX-License-Identifier: Apache-2.0
//
// 读写 zip 的对外入口：writeZip、readZip、crc32。分享文件的版面（类型标识、包目录、README）在 share.mjs。
// 只用平台自带的 API：写不压缩，读认存储和 deflate（用 DecompressionStream）。细节见 zip-write.mjs、zip-read.mjs、zip-structure.mjs。
export { writeZip } from './zip-write.mjs';
export { readZip } from './zip-read.mjs';
export { crc32 } from './zip-format.mjs';
