# 协议核心

每个部分（基础部分、角色部分）都带着的同一份内容：格式说明、公钥和官方地址、读写和校验音色包的程序（核心层）、做新包的步骤和空白模板。只有角色部分的包里只有这一层，所以这里的东西只依赖本目录里的文件。

## 目录

| 路径 | 内容 |
|---|---|
| `lib/` | 核心层程序，`.mjs`，分组见下面「`lib/` 里的程序」。每个文件的文件头写明它做什么、抛哪些 `code` |
| `cli.mjs`、`cli/` | 核心层的命令行，见「命令行」 |
| `FORMAT.md` | 格式说明（中文，只有这一份）：第三方照着它就能读写音色包。目录、路径、哈希、清单、SKILL.md、包 ID、音频、分享文件、解包上限、检查、补全取哪个版本都在里面 |
| `SIGNATURES.md` | 官方签名：签名文件格式（minisign 旧模式）、信任名单、库的入口必须选的验签策略（`signature_policy_missing`）和各调用方怎么传、命令行的 `--allow-unsigned`、互相校验的规则、`keygen`、`sign`、`verify` 命令 |
| `RELEASES.md` | 官方发布：官方地址、目录里的四种文件、版本索引的格式、怎么取一个版本、app 怎么对应到一个版本、不可变 |
| `schema/` | 清单的 JSON Schema |
| `trust.json` | 信任名单：官方公钥（可以有多把）。官方地址（`official_url`）也放这里 |
| `manifest-fields.json` | 协议核心自己的版本号（语义化版本号）。发布时 `seal --part protocol --fields` 读它。基础部分根上的 `manifest-fields.json` 同理，另外登记运行时 |
| `new-pack/` | 做新包：`README.md`（抽象规格：流程、谁能看什么、每个字段怎么写、查重比什么，没有完整的示例角色）、`brief.md`（给净室里的做包 agent 的任务说明）、`template/`（空白模板）。基础部分的 `clean-room` 命令把它们和使用者说的属性装进一个目录，交给一个看不到来源包的新会话 |

### `lib/` 里的程序

| 用途 | 文件 |
|---|---|
| 共用的底子 | `errors.mjs`（统一的错误）、`env.mjs`（从运行环境取东西）、`bytes.mjs`（十六进制、Base64）、`hash.mjs`（SHA-256）、`version.mjs`（协议版本、语义化版本）、`limits.mjs`（解包上限）、`paths.mjs`（路径的写法和检查）、`fileset.mjs`（文件集：`Map<路径, Uint8Array>`） |
| zip | `zip.mjs`（入口，读和写）、`zip-format.mjs`、`zip-structure.mjs`、`zip-read.mjs`、`zip-write.mjs` |
| 清单 | `schema.mjs`（JSON Schema 子集的校验器）、`manifest.mjs`（读、写、检查清单）、`seal.mjs`（给一个部分生成清单） |
| 检查 | `check.mjs`（检查一个部分：`checkPart` 是信任边界上的入口，要选验签的策略；`selfCheckPart` 是库内部自检）、`mutual.mjs`（角色部分和基础部分互相校验）、`audio.mjs`（按内容判断音频格式）、`skill-md.mjs`（SKILL.md 的读和检查，生成角色部分的骨架） |
| 做包和分享文件 | `pack.mjs`（包 ID，做一个角色部分）、`share.mjs`（打成、打开、检查分享文件：`checkShareFile`、`inspectShareFile` 同样要选验签的策略） |
| 预览卡片 | `preview-card.mjs`（`buildPreviewCard`：分享文件里那张自包含的 `index.html`，打包时生成；页面上有什么、怎么保证不联网不跑脚本，只在它的文件头写一份）、`preview-audio.mjs`（卡片里内嵌的试听：WAV 和 MP3 按帧截短、不重新编码，上限和理由在文件头）、`voice-orb.mjs`（卡片的配图，由包 ID 画） |
| 签名 | `signature.mjs`（Ed25519 签名和验签）、`official.mjs`（把信任名单做成检查用的验签钩子：基础部分和协议核心只认官方签名） |
| 官方发布 | `releases.mjs`（官方地址、官方版本的文件名、版本索引的读写、读已发布的文件，布局见 `RELEASES.md`） |
| 补全 | `base-choice.mjs`（纯判断：环境里已有的一份基础部分能不能用，官方版本索引里挑哪一个版本）、`complete.mjs`（补全的流程：先用环境里可用的，没有才读版本索引、挑版本、取官方的基础部分，放进包里以后再检查整个包；规则和理由见 `FORMAT.md`「补全」。读索引、取 zip、核对验签用 `release-fetch.mjs`，不在这里重写） |
| 其他 | `audio-clip.mjs`（音频片段：字节加 MIME 类型） |

## 模块约定

库的程序（`protocol/lib/`、基础部分根上的 `lib/` 和 `tools/`、环境适配层 `adapters/` 里的 `.mjs`）都照这几条写。

1. **文件格式**：ESM 的 `.mjs`，文件第一行写 `// SPDX-License-Identifier: Apache-2.0`。
2. **不依赖第三方库**：`import` 只能指向相对路径，不装包。
3. **只用平台自带的 API，浏览器和 Node 都能跑**。
   - 可以用：`crypto.subtle`（哈希、Ed25519）、`TextEncoder`、`TextDecoder`、`CompressionStream`、`DecompressionStream`（只用 `deflate-raw`，浏览器没有 `brotli`）、`URL`、`Blob`、`Intl`、`btoa`、`atob`。
   - 不能用 Node 专有的：`node:` 开头的模块、`Buffer`、`process`、`__dirname`、`require`。
   - 不能用两边不齐的新方法。Node 24.14 没有 `Uint8Array.prototype.toHex`、`toBase64` 和 `Uint8Array.fromHex`、`fromBase64`（2026-10-14 实测），十六进制和 Base64 用 `lib/bytes.mjs`。
4. **Node 专有的东西只出现在命令行层**：名为 `cli.mjs` 的文件和名为 `cli/` 的目录；还有适配器的工厂文件 `adapters/<名字>/adapter.mjs`（它在适配器的主人一侧运行，由命令行层的统一入口 `cli/adapters.mjs` 加载，app 和浏览器从不加载它；规则见 `adapters/README.md`「Node 专有的东西放哪」）。库的程序不碰文件系统（输入输出是 `Uint8Array`、字符串和普通对象，文件由命令行层读写），不直接联网，不直接起进程，不直接调模型：这几样都向注入的运行环境要，见下一节。
5. **不 `import` 基础部分以外的文件，也不复制 AGPL-3.0-only 的代码**：基础部分是 Apache-2.0。可以照着行为重新写，不能复制。
6. **依赖方向是单向的**：核心层（`protocol/lib/`）只依赖核心层；`tools/` 只用核心层；`lib/` 可以用核心层和 `tools/`，也可以读 `vocab/` 里的 JSON 词表（数据，不是程序）；`adapters/<名字>/` 只用核心层和自己的目录。

这几条只看代码：把每个 `.mjs` 切成记号再查，注释和字符串里的字眼不算；`protocol/new-pack/` 里的模板不受约束。

## 运行环境

库不绑定模型。要用模型、联网、起命令行工具，都向调用方注入的运行环境要。环境是一个对象，有三个容器：

```js
const env = {
  capabilities: { 'text-to-speech': async (/* 签名见下 */) => { /* ... */ } },  // 所需能力
  fetch: (input, init) => Promise<Response>,                                      // 所有网络读取
  runtimes: { ffmpeg: async (/* 签名见下 */) => { /* ... */ } },                 // 命令行工具
};
```

| 容器 | 键 | 值 | 取用 | 缺了 |
|---|---|---|---|---|
| `capabilities` | 能力词表（`vocab/capabilities.json`）里的名字 | 这项能力的实现 | `requireCapability(env, 名字)` | 抛 `capability_missing`，`details.capability` 是缺的那一项 |
| `fetch` | 无 | 形同标准 `fetch(input, init)` 的函数；补全、核对外部资源等所有网络读取都走它 | `requireFetch(env)` | 抛 `fetch_missing` |
| `runtimes` | 命令行工具名，例如 `ffmpeg` | 运行这个工具的实现 | `requireRuntime(env, 名字)` | 抛 `runtime_missing`，`details.runtime` 是缺的那一项 |

三个取用函数都在 `lib/env.mjs`。

- **用到才取**：功能在需要某项能力的那一刻才取它，不在启动时一次取齐。所以环境缺一项，只有用到它的功能报错，其他功能照常。
- **环境可以什么都不提供**：`capabilities` 给 `{}` 就是一个合法的环境。环境把某项设成 `undefined`、`null`、`false`，也算没有这项。环境本身不是对象、没有 `capabilities` 容器，抛 `environment_invalid`。
- **调用签名只在一处定义**。能力和运行时的实现是函数，库一律 `await` 它的返回值，所以同步、异步实现都行。所需能力的参数和返回值写在 `vocab/capability-signatures.md`（第一个用到一项新能力的功能，把它的签名加到那里）；用到它的模块在文件头 JSDoc 里加一行 `@capability <能力名>` 指过去，不重抄。运行时的签名写在第一个调用它的模块的文件头（`@runtime <名字>`）。找某项能力用在哪：`grep -rn "@capability text-to-speech" .`。参数名用能力词表第三层的 `ref_audio`、`ref_text`、`instructions`；音频一律用字节加 MIME 类型（`lib/audio-clip.mjs`），不收 URL。`fetch` 的用法（超时、重试、怎么读响应）由用到它的模块写在自己的文件头。
- **适配器**（`adapters/<名字>/`，所有适配器合起来叫环境适配层）负责按这个形状组装环境：把能力词表里的名字对到这个环境里能用的具体模型。模型名只出现在适配器里。适配器的约定（工厂怎么写、返回什么、出错怎么报）只写在 `adapters/README.md`。

## 错误

库（`lib/` 里的代码）只抛两类错误，按出错的是谁来分：

- **数据的错**：来自用户输入、命令行参数、文件、网络、能力返回的东西不对。抛 `VoicePackError`（`lib/errors.mjs`），带字符串形式的 `code`；调用方按 `code` 区分，不按 `message`。
- **程序员的错**：调用方的代码用错了接口：参数的类型不对（要 `Uint8Array` 给了字符串），取值不合法（上限给了 0），前提没满足（给角色部分用的函数传了基础部分的清单）。抛 `TypeError`，`message` 点名是哪个参数、收到了什么。这是调用方代码的 bug，要改代码，不是报给用户的：命令行把它报成内部错误（`internal_error`）。取值不合法也用 `TypeError`，不用 `RangeError`、`Error`；`lib/` 里没有第三类。

分不清是哪一类时：换一份别人给的数据，同一个调用会不会也出这个错？会，就是数据的错。外来的数据永远不该让库抛 `TypeError`：入口先查，把问题报成 `VoicePackError`，或者放进报告（`checkPart`、`inspectShareFile` 这类入口不抛错，问题都在报告里）。例：做包和 `seal` 读的描述是作者给的文件，字段的类型不对是 `manifest_invalid`，不是 `TypeError`。命令行自己的用法错误（未知命令、缺参数）是 `cli/runner.mjs` 的 `UsageError`，退出码 2，不是库的错误。

`VoicePackError` 的字段：
- `code`：小写字母、数字、下划线，例如 `capability_missing`、`member_too_large`。
- `message`：给人看的说明，点名出了什么问题：缺的是哪项能力，哪个文件，哪个哈希对不上。
- `details`：机器可读的上下文，用 JSON 能表示的值，例如 `{ capability: 'speaker-verification' }`。
- `cause`：底层的原始错误。
- 判断用 `isVoicePackError(错误, 'code')`，不用 `instanceof`：完整包里协议核心有两份副本，同一个进程可能把两份都加载进来，它们各有自己的类。

**code 不集中写成枚举**：谁抛谁定义，在抛出的地方用注释写明含义和 `details` 里放什么。新加之前先 `grep -rn "'<code>'" .` 确认没人用过。

这一层已有的：`capability_missing`、`runtime_missing`、`fetch_missing`、`environment_invalid`（`lib/env.mjs`）；`invalid_hex`、`invalid_base64`（`lib/bytes.mjs`）；`command_load_failed`（`cli/runner.mjs`）；签名和验签的一组（`ed25519_unavailable`、`trust_list_empty`、`signature_invalid` 等，`lib/signature.mjs`，列表在 `SIGNATURES.md`）。

格式和检查的 `code` 在这几处：检查报告里的问题（`file_modified`、`audio_disguised`、`external_unverifiable` 等）和入口没选验签策略抛的 `signature_policy_missing`、只选了 `allowUnsigned` 时的 `signature_unverifiable` 在 `lib/check.mjs` 的文件头；互相校验的（`protocol_incompatible`、`base_too_old`、`capability_unknown`、`capability_vocabulary_invalid`）在 `lib/mutual.mjs`；基础部分和协议核心的官方签名（`signature_missing`，以及验签抛的各种）在 `lib/official.mjs`；清单的（`manifest_invalid`、`protocol_unsupported` 等）在 `lib/manifest.mjs`；路径的（`path_unsafe`、`path_conflict`）在 `lib/paths.mjs`；zip 的（`zip_malformed`、`symlink_not_allowed`、`too_many_members` 等）在 `lib/zip-structure.mjs`、`zip-read.mjs`、`limits.mjs`；分享文件的（`share_not_voicepack`、`share_layout_invalid`）在 `lib/share.mjs`；做包的（`pack_invalid`、`crypto_unavailable`、`random_invalid`）在 `lib/pack.mjs`；官方发布的（`official_url_invalid`、`index_invalid`、`release_conflict`、`published_unreadable` 等）在 `lib/releases.mjs`；补全的（`base_version_unavailable`、`completed_pack_invalid`、`in_pack_base_unusable`、`complete_not_role_part`）在 `lib/complete.mjs`，补全读官方版本时抛的别的 `code`（`official_unpublished`、`release_invalid` 等）原样来自 `lib/release-fetch.mjs`，补全只给它们加上 `details.stage`；命令行读写磁盘的（`file_exists`、`file_unwritable`、`file_unreadable`）在 `cli/disk.mjs`；`seal` 读描述文件的（`fields_invalid`）在 `cli/commands/seal.mjs`。

## 命令行

只有协议核心时也能跑：在这个部分的根目录里运行 `node protocol/cli.mjs <命令> [参数...]`。基础部分根上的 `node cli.mjs <命令>` 在核心层的命令之外再带流程层的命令。完整包里有两份协议核心，用基础部分里那一份。

一个命令就是 `cli/commands/<名字>.mjs`，加命令只加文件。命令的写法、拿到的上下文、退出码和错误的报告方式，都写在 `cli/runner.mjs` 的文件头，这里不重复。

核心层的命令（每个命令的参数、退出码和输出，写在它自己文件的文件头，也可以 `node protocol/cli.mjs help <命令>`）：

| 命令 | 做什么 |
|---|---|
| `seal` | 给一个部分的目录生成清单 `manifest.json`；角色部分没有 `SKILL.md` 时生成骨架。不验签、不做互相校验（被封的部分此时还没签名） |
| `pack` | 把一个部分的目录打成分享文件（`.voicepack.zip`）。先检查，含验签和互相校验 |
| `unpack` | 把分享文件解成包目录。先检查，含验签和互相校验 |
| `check` | 检查一个分享文件或一个部分的目录，含验签和互相校验 |
| `keygen`、`sign`、`verify` | 签名和验签，见 `SIGNATURES.md` |
| `complete` | 补全只有角色部分的包：环境里没有可用的基础部分时，取官方基础部分，验签，放进包里的 `voice-pack/`，再检查整个包。规则见 `FORMAT.md`「补全」 |

`complete` 和上面几个不一样：它联网（读官方地址，走注入的 `env.fetch`），永远验签，没有 `--allow-unsigned`；`--trust <信任名单.json>` 同样只给测试和第三方用，官方的补全不传。它读写目录、找环境里已有的基础部分的那部分在 `cli/completing.mjs`：先在包目录里的临时目录写好，最后一步才改名成 `voice-pack/`，任何一步失败都不留下半个目录。

`seal`、`pack`、`unpack`、`check` 共同的做法：先检查，通过了才写；目录里有符号链接、特殊文件，或者超过解包上限，就拒绝。写盘的规矩各有各的：`pack` 和 `unpack` 不覆盖已有的文件和目录；`seal` 的作用就是换掉目录里的 `manifest.json`（连同清单变了以后作废的签名），所以覆盖它，别的文件不动，已有的 `SKILL.md` 原样留着；`check` 什么都不写。它们共用 `cli/` 里的这几个文件：`disk.mjs`（读写目录和文件）、`checking.mjs`（读进来、检查；`check`、`pack`、`unpack` 在这里接上验签和互相校验）、`report.mjs`（检查报告的文字版）。格式本身的规则在 `FORMAT.md`，不在这里重复。

**`check`、`pack`、`unpack` 默认验签、做互相校验**，选项一样（写在这三个命令各自的 `help` 里）：

- 基础部分和协议核心必须带官方签名；信任名单是**正在运行的这份协议核心**自带的 `protocol/trust.json`，不是被检查的包里带的那份。`--trust <信任名单.json>` 换一份名单（测试和第三方用）。
- `--allow-unsigned` 只放过「没有签名文件」的部分，报告里写明没验；有签名文件的照验。本地开发用。
- 角色部分和它带着的基础部分对一对：协议主版本、基础部分的版本、所需能力。只有角色部分的包做不了，报告里写明。
- 规则和理由见 `SIGNATURES.md` 的「接进检查」「互相校验」两节。

**库里的入口也一样要选**：处理从外面来的东西的 `checkPart`、`checkShareFile`、`inspectShareFile`，调用方必须明确给验签函数（`createSignatureVerifier(信任名单)`），或者明确写 `allowUnsigned: true`；两样都不给就抛 `signature_policy_missing`，在读任何输入之前。互相校验在这些入口上默认打开（`mutual: false` 才关）。库内部检查自己刚封好的部分用 `selfCheckPart`，不要策略。各调用方怎么传，见 `SIGNATURES.md` 的「调用方必须选验签的策略」。
