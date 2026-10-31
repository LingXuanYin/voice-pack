# 官方签名

基础部分的清单、协议核心、以及发布出去的基础部分 zip，都由官方用 Ed25519 签名；运行环境只认官方版本。这份文件写签名文件的格式、信任名单、命令，以及这样定的依据。第三方照着它，装一个 minisign 就能验官方签名。

一份内容怎么算「官方版本」、两个部分怎么互相校验，在这份文件的「接进检查」和「互相校验」两节；格式本身的规则（清单、文件、哈希）在 `FORMAT.md`，检查的次序在它的「检查」一节。

## 签什么

| 被签的东西 | 签名文件 | 谁来验 |
|---|---|---|
| 基础部分的清单 | 清单旁边，`<清单文件名>.minisig` | 每个部分自带的协议核心；app 用自己带的信任名单 |
| 协议核心的清单 | 协议核心的清单旁边，同上 | 同上 |
| 发布出去的基础部分 zip（每个版本一个，补全时下载） | zip 旁边，`<zip 文件名>.minisig` | 补全时用协议核心里的信任名单验 |

签名只管被签文件的**原始字节**，不做换行转换，不解码再编码。

## 签名文件的格式

就是 minisign 的签名文件，四行，末尾一个换行：

```
untrusted comment: <一行说明，不参与签名>
<base64，74 字节：算法标识 `Ed` 2 字节 + key id 8 字节 + 签名 64 字节>
trusted comment: <一行说明，参与签名>
<base64，64 字节：global signature>
```

- 签名：对被签文件的原始字节直接做 Ed25519。
- global signature：对「上面那 64 字节签名 + trusted comment 的 UTF-8 字节」做 Ed25519。所以 trusted comment 被改了也验得出来；我们用它写 `file:<文件名>`，人一眼看得出这份签名是给谁签的。
- key id：8 字节。我们生成的钥匙取公钥 SHA-256 的前 8 个字节；别人用 minisign 自己生成的钥匙，key id 是随机的，信任名单一样认。显示时和 minisign 一样，8 个字节按小端读成一个整数，写成 16 位大写十六进制。
- 同一份内容、同一把私钥、同一个 trusted comment，签两次，得到的字节完全相同（Ed25519 是确定性的，trusted comment 里默认不带时间戳）。发布时可以拿它和已经发布的文件比字节。
- 读签名文件时，换行 `\n` 和 `\r\n` 都认，末尾多出来的空行也不算。

公钥写成 minisign 的 `.pub` 文件第二行那串 base64，42 字节：`Ed` + key id 8 字节 + 公钥 32 字节。

## 为什么用 minisign 的旧模式，而不是自己定格式

此前的结论是「WebCrypto 没有 BLAKE2b，所以和 minisign 不能互验」。这只对 minisign 的**预哈希模式**（算法标识 `ED`，默认的签名模式）成立：它先对文件算 BLAKE2b-512，再对哈希值签名。minisign 还有**旧模式**（算法标识 `Ed`，`minisign -S -l` 生成）：直接对文件字节做 Ed25519，trusted comment 的 global signature 也只是 Ed25519，两者都用不到 BLAKE2b，WebCrypto 做得了。

依据，分来源写：

- **读源码**（`jedisct1/minisign` 的 `src/minisign.c`，默认分支 `b6de4fe`，2026-10-11；发布版 0.12，2025-01-15，两份的验签逻辑一样）：
  - `sig_load` 认两个算法标识，`Ed` 的 `hashed = 0`，`ED` 的 `hashed = 1`；
  - `verify` 只有在带了 `-H` 且 `hashed == 0` 时才拒绝（输出 `Legacy (non-prehashed) signature found`），默认 `allow_legacy = 1`，所以**默认不带额外参数就接受 `Ed` 签名**；
  - `message_load(…, hashed)` 在 `hashed == 0` 时读整个文件原样当消息，没有哈希；
  - 公钥只认 `Ed`（`pubkey_load_string` 用 `memcmp(pubkey_struct->sig_alg, SIGALG, …) != 0` 拒绝其他），所以我们的公钥写法就是 minisign 的公钥写法。
- **真跑**（2026-10-14，minisign 0.12 的官方发布版 Windows 二进制）：
  - minisign 用 `-S -l` 签的文件，我们的 `signature.mjs` 验得过，trusted comment 也验过；
  - 我们的代码签的文件，`minisign -V -p <公钥文件> -m <文件>` 默认参数验得过，退出 0，`Signature and comment signature verified`；公钥不落文件、用 `-P <公钥>` 内联也验得过；
  - 带 `-H`（要求预哈希）时，同一份旧模式签名被拒：`Legacy (non-prehashed) signature found`，退出 1。**要让第三方用 `-H` 验，我们就得用预哈希模式，办不到；所以文档里给第三方的命令不带 `-H`**；
  - 文件改一个字节，minisign 报 `Signature verification failed`，退出 1；
  - trusted comment 是中文、带制表符、长到 1000 字节、换行符是 CRLF，minisign 都验得过。

结论：**用 minisign 的公钥和签名文件格式（旧模式，`Ed`）**。这个格式有现成的第三方实现，不需要我们另起一套。代价只有一个：minisign 的新版本哪天不再默认接受旧模式，第三方就要给命令加参数；我们这边不受影响，因为验签是我们自己的代码。

遇到预哈希（`ED`）的签名，我们的验签不假装能验，明确报 `signature_algorithm_unsupported`，并告诉对方改用 `minisign -S -l`。

### 第三方怎么验官方签名

```
minisign -V -P <官方公钥> -m <被签文件>
```

`<官方公钥>` 就是 `protocol/trust.json` 里 `public_key` 的那串 base64（minisign 的 `-P` 直接收它，不用先落成文件）；要用文件的话，写成 `.pub` 格式：第一行 `untrusted comment: minisign public key <key id>`，第二行就是那串 base64，然后 `-p <公钥文件>`。签名文件默认是 `<被签文件>.minisig`，放在被签文件旁边；不在旁边的话加 `-x <签名文件>`。不要加 `-H`。

## 信任名单

`protocol/trust.json`，每个部分的协议核心都带一份，验签只认这份名单里的公钥。app 自己带一份同样形状的名单。

```json
{
  "version": "1.0",
  "keys": [
    { "public_key": "<minisign 的 .pub 第二行那串 base64>", "comment": "说明，可省" }
  ]
}
```

- `public_key`：minisign 的 `.pub` 第二行那串 base64（上一节）。
- 按签名里的 key id 去名单里找公钥，找不到就是「不是官方签名」，不会拿别的公钥去试。key id 只是找公钥的线索：签名里写了官方的 key id、实际用别的钥匙签的，照样验不过，因为验的是名单里那把公钥。
- 名单可以有多把公钥。换了密钥以后，新公钥加进来，**旧公钥留在名单里**，旧版本的签名就照样能验；名单里两把公钥的 key id 不能相同。
- 名单为空时验签一律失败（`trust_list_empty`），不放行：名单被清空不会变成「不查了」。
- `version` 是名单自己的版本，「主.次」；其他字段（例如官方地址，补全用）验签不看，原样放过。

### 官方公钥

`trust.json` 里现在有第一把官方公钥。

- **来历**：voice-pack 的发布者生成这把钥匙，私钥由发布者保管，不进 git，也不进任何包。进仓库的只有公钥。换了官方地址（1.x 时代在 Cohub 公开文件上，2.0 起在 voice-pack 自己的 GitHub Pages 上），公钥没有换：旧版本的签名照样验得过。
- **指纹**：原始 32 字节公钥的 SHA-256，小写十六进制。交接和核对时用它：`trust.json` 里的 `public_key` 解码后，去掉头 10 个字节（算法标识 2 字节 + key id 8 字节），剩下的 32 字节就是原始公钥。
- **key id 怎么来的**：我们的钥匙，key id 由公钥算出来，取原始公钥 SHA-256 的前 8 个字节，显示时按小端写成 16 位大写十六进制。minisign 自己生成的钥匙，key id 是随机的，不是这样算的，信任名单一样认；`signature.mjs` 的 `publicKeyFromRaw` 把原始公钥写成名单里的那一项，同一个原始公钥永远得到同一项，所以名单里的内容随时能重新算出来核对。
- **确认私钥和名单里的公钥是一对**（生成钥匙之后、第一次签名之前做一遍）：`node protocol/cli.mjs keygen --key <私钥文件> --json`，输出里的 `publicKey` 必须和 `trust.json` 里的 `public_key` 一字不差；更直接的做法是用这把私钥给一份文件签名，再用默认的信任名单验：`sign <文件> --key <私钥文件>`、`verify <文件>`，通过才说明一对。

### 私钥丢了或泄露了

只能发新版本、换公钥：新密钥签下一个版本，下一个版本的协议核心带新公钥，信任名单里旧公钥留着；已经流出去的旧包里是旧公钥，旧版本照样能验。旧版本的 zip 和签名一直留在官方地址上，用旧版本做的包照样能补全：版本索引每发布一次由当时的钥匙重签，换钥匙以后旧包里的名单（只有旧公钥）认不得它，补全这时不信索引，退回去直接取包要求的最低版本本身，它的 zip 和签名用旧名单验得过（这条退路的规则写在 `RELEASES.md`「私钥丢了或泄露了」，不在这里重复）。官方地址上的文件怎么摆，见 `RELEASES.md`。

## 命令

都在协议核心的命令行里（只有协议核心时也能跑）：`node protocol/cli.mjs <命令>`；基础部分根上的 `node cli.mjs <命令>` 一样能用。

| 命令 | 做什么 |
|---|---|
| `keygen --out <私钥文件>` | 生成一把 Ed25519 钥匙。私钥写成 PKCS8 的 PEM（和 `openssl genpkey -algorithm ed25519` 一样，能互相读），权限只给自己（0600）。**文件已存在就拒绝**，不悄悄覆盖。输出公钥和 key id，不输出私钥 |
| `keygen --key <私钥文件>` | 由已有的私钥报出公钥和 key id：得到要写进信任名单的那一项，也用来确认私钥和名单里的公钥是一对（见「官方公钥」） |
| `sign <文件> --key <私钥文件> [--sig <签名文件>] [--trusted-comment <一行>]` | 给文件签名。默认写到 `<文件>.minisig`；trusted comment 默认是 `file:<文件名>` |
| `verify <文件> [--sig <签名文件>] [--trust <信任名单.json>]` | 验签。默认用协议核心自带的 `protocol/trust.json`；`--trust` 给测试和第三方换一份名单用。通过输出 key id 和 trusted comment；不通过退出 1 并报 code |

私钥文件 PEM 和 DER 都认。给了 `--json`，输出和错误都是一行 JSON。

**私钥的值绝不进输出、日志、错误信息**：读私钥文件失败只说路径和系统给的原因；格式不对只说「不是 Ed25519 的 PKCS8 私钥」，不回显内容，也不把底层错误作为 `cause` 带出去。调用方（发布用的脚本）同样不要把私钥放进命令行参数、环境变量的打印里；路径可以写，内容不行。

## 库的接口

`protocol/lib/signature.mjs`，只用平台自带的 WebCrypto，浏览器和 Node 都能跑。所有二进制参数都是 `Uint8Array`（原始字节），不收字符串：字符串会悄悄换一次编码，签的就不是文件的原始字节了。

| 函数 | 说明 |
|---|---|
| `generateSigningKey()` | 生成钥匙：`{ privateKey: Uint8Array（PKCS8 DER）, publicKey: string（minisign 写法）, keyId: string }` |
| `publicKeyOf(privateKey)` | 由私钥推出 `{ publicKey, keyId }` |
| `publicKeyFromRaw(rawPublicKey)` | 把 raw 公钥（32 字节）写成名单里的写法，key id 由公钥算出：`{ publicKey, keyId }` |
| `signMessage(message, privateKey, { trustedComment?, untrustedComment? })` | 返回签名文件的文本 |
| `verifyMessage(message, signatureText, trustList)` | 通过返回 `{ keyId, trustedComment, untrustedComment }`；不通过抛错 |
| `parseTrustList(trustList)` | 读并检查信任名单，返回 `{ version, keys: [{ keyId, publicKey, comment? }] }` |
| `parsePublicKey(text)` | 读 minisign 的公钥（`.pub` 文件整份文本，或第二行那串 base64），返回 `{ keyId, publicKey: Uint8Array（32 字节）}` |
| `SIGNATURE_SUFFIX` | `'.minisig'` |

### 报错（`VoicePackError` 的 code）

| code | 什么时候 |
|---|---|
| `ed25519_unavailable` | 运行环境没有 Ed25519：没有 `crypto.subtle`（浏览器里不是安全上下文），或者 `crypto.subtle` 不认 Ed25519（Chrome/Edge 137、Firefox 129、Safari 17 以前，Node 16.17 以前）。**签名和验签都报这个，绝不静默放行** |
| `trust_list_invalid` | 信任名单的形状不对（没有版本号、keys 不是数组、公钥读不出来、key id 重复）；命令行读的信任名单文件不是合法 JSON 也是这个 code |
| `trust_list_empty` | 名单里一把公钥也没有 |
| `signature_malformed` | 签名文件的格式不对：行数、前缀、base64、长度。`details.line` 是出问题的行 |
| `signature_algorithm_unsupported` | 算法标识不是 `Ed`。预哈希（`ED`）单独说明：它要 BLAKE2b-512，WebCrypto 没有 |
| `signature_untrusted_key` | 签名用的钥匙不在信任名单里：不是官方签名。`details.keyId`、`details.trusted` |
| `signature_invalid` | 签名和这份内容对不上：内容被改过，或者签名不是给它签的 |
| `signature_comment_invalid` | trusted comment 和它的签名对不上：签名文件被改过 |
| `private_key_invalid` | 私钥不是 Ed25519 的 PKCS8 |
| `public_key_invalid` | 公钥读不出来：长度、算法标识、base64 |
| `key_id_invalid` | key id 不是 16 位十六进制 |
| `comment_invalid` | 签名里的注释有换行、是空的，或者太长（上限 1000 字节） |
| `file_unreadable`、`file_unwritable`、`file_exists` | 命令行读写文件（私钥、信任名单、被签的文件、签名文件）出问题 |

## 谁用哪份公钥

- **agent 环境里**：用包里自带的协议核心（`protocol/trust.json`）验。整个包连同协议核心一起被改过的话，查不出来：这是这套校验的边界。命令行的做法是：信任名单取**正在运行的这份协议核心**自带的 `protocol/trust.json`（运行 `node protocol/cli.mjs` 的那份），不取被检查的包里带的那份：包里的名单是包的作者写的，不能拿来认这个包。
- **嵌入这个库的 app**：用自己带的一份信任名单验，不依赖包里的那份。
- **接收分享文件的服务端**：用它自己部署的那份基础部分自带的 `protocol/trust.json`，不读上传的分享文件里的名单（见「谁怎么传」）。
- **补全**：下载官方地址上的基础部分 zip 和它的签名，用协议核心里的信任名单验；验不过就报错，不兜底。

## 接进检查

检查一个包的时候（`check`、`pack`、`unpack`，库里是 `checkPart`、`checkShareFile`、`inspectShareFile` 加 `lib/official.mjs`），官方签名这样用：

| 部分 | 要不要验 | 怎么验 |
|---|---|---|
| 基础部分的清单 | 要 | 清单旁边必须有 `manifest.json.minisig`，是信任名单里某把公钥签的，签的就是这份清单的字节 |
| 协议核心的清单（完整包里有两份：角色部分的 `protocol/`，基础部分里的 `voice-pack/protocol/`） | 要 | 同上，每份各验各的 |
| 角色部分的清单 | 不验 | 作者身份交给社区账号；角色部分旁边有没有签名文件、写什么，都不影响检查 |

**为什么验清单就够了**：清单列出部分里每个文件的 SHA-256，检查会逐个核对；清单是官方签的，等于官方担保了清单列出的每个文件的内容。改了文件而没改清单，哈希逮住（`file_modified`）；改了清单而没换签名，验签逮住（`signature_invalid`）；连签名都换成自己钥匙签的，信任名单逮住（`signature_untrusted_key`）。三层各逮一种，所以「协议核心被改」不管怎么改都过不了，除非连运行中的那份协议核心和它的信任名单一起被换掉（这套校验的边界，见上）。

没有签名文件的基础部分或协议核心，默认拒绝（`signature_missing`）。`allowUnsigned`（命令行里是 `--allow-unsigned`）只放过「没有签名文件」的部分，报告里写明没验（`skipped: 'unsigned'`），是本地开发和测试用的：改基础部分的代码、还没发布签名的时候能跑通。有签名文件的照验，签得不对照样拒绝；名单为空照样不放行。**这不是关掉验签**，但它是个逃生口：用它放行的包没有被验过，不是官方版本，所以用户说明（基础部分的 `SKILL.md`、角色部分 `SKILL.md` 和 README 的模板）里一个字都不提它：改这些说明的人要守住这一条。

`check`、`pack`、`unpack` 的选项：

| 选项 | 作用 |
|---|---|
| `--trust <信任名单.json>` | 换一份信任名单，给测试和第三方用；官方的检查不传它。读不了、形状不对，退出 1，不退回默认名单 |
| `--allow-unsigned` | 见上 |

`seal` 不验签也不做互相校验：被封的部分此时还没有签名，签名在 `seal` 之后（封完、`sign`、再 `pack`）。重新 `seal` 会删掉旧签名（清单变了，旧签名就作废了）。

### 调用方必须选验签的策略

库里处理从外面来的东西的入口，不替调用方定「验不验签」：调用方必须明确选，不选就报错。这是为了让嵌入库的 app（导入）、补全、接收分享文件的服务端这几处，没有哪一处因为忘了传，悄悄把非官方的基础部分或协议核心放进来。

| 入口 | 处理什么 | 要不要选策略 |
|---|---|---|
| `checkShareFile`、`inspectShareFile`（`lib/share.mjs`） | 从外面来的分享文件 | 要 |
| `checkPart`（`lib/check.mjs`） | 从外面来的包目录的文件集（补全以后的整包、服务端解开的包……） | 要 |
| `openShareFile`（`lib/share.mjs`） | 只读 zip 的容器，不查清单、哈希、签名 | 不要：它不下结论。但它交出来的文件是没验过的，所以只有 `share.mjs` 自己引用它；要从分享文件里取文件，走 `inspectShareFile`，`opened.files` 是文件集，`report.ok` 为 `true` 才能用 |
| `selfCheckPart`（`lib/check.mjs`） | 库内部自检：做包时对正在做的角色部分（`packRolePart`）、`seal` 对正在封的部分 | 不要：不验签、不做互相校验，也不收这些选项。检查的是自己刚做出来的东西；处理外来输入不许用 |

选项（`verifySignature` 和 `allowUnsigned` 的组合）：

| `verifySignature` | `allowUnsigned` | 怎么办 |
|---|---|---|
| 给了 | 不写或 `false` | 严格：基础部分和协议核心每个都要有官方签名，验签函数说了算 |
| 给了 | `true` | 验签，但放过没有签名文件的部分（命令行的 `--allow-unsigned`） |
| 没给 | `true` | 没有验签的办法：没有签名文件的部分放过，有签名文件的没法验，报 `signature_unverifiable`，不当成通过 |
| 没给 | 不写或 `false` | 抛 `signature_policy_missing`，在读任何输入之前（连文件集的形状、分享文件的字节都没看） |

`mutual` 在这些入口上默认打开，调用方可以明确写 `mutual: false`。`allowUnsigned` 只在入口的选项里，`createSignatureVerifier` 本身永远是严格的。

### 谁怎么传

名单从哪来：命令行用正在运行的这份协议核心自带的 `protocol/trust.json`；嵌入这个库的 app 用自己带的；接收分享文件的服务端用它自己部署的那份基础部分自带的。三处都**不取被检查的东西里别处带的名单**（那是包的作者写的，不能拿来认这个包）。app 和服务端在信任判断上不写 `allowUnsigned`：产品里没有「不验签」这个选择；只有一种情形可以有意这样写：打开一个只用来读、不当成可信内容用的文件（下面的「只读来比一比」）。命令行的 `--allow-unsigned` 是给本地开发用的。

- **嵌入这个库的 app（导入、导出）**：用 app 构建时带进去的信任名单。
  ```js
  const verifySignature = createSignatureVerifier(appTrustList);       // appTrustList 随 app 的版本走，换密钥时旧公钥留着
  const report = await checkShareFile(bytes, { verifySignature, env });   // mutual 不写，默认做
  ```
  只有角色部分的包，报告的 `mutual` 是 `{ checked: false, reason: 'no_base' }`：app 导入时拿 app 自带的基础部分对一对，不补全、不联网。app 不必带整份基础部分，只带互相校验要用的三样：基础部分的版本（根上的 `manifest-fields.json`）、协议版本（库的 `PROTOCOL_VERSION`）、能力词表（`vocab/capabilities.json`）。对的时候用库自己的规则，不在 app 里另写一遍：
  ```js
  const problems = mutualProblems(roleManifest, { protocol, version }, capabilityVocabularyBytes, { maxJsonBytes });
  // 问题的形状和检查报告里的一样：protocol_incompatible、base_too_old、capability_unknown、capability_vocabulary_invalid；有就拒绝，一个字节都不上传
  ```
  导出完整包时，基础部分是 app 固定用的那一版，用 `fetchOfficialVersion`（`protocol/lib/release-fetch.mjs`）从官方地址取回：读版本索引，zip 和它的签名、里面的内容都验过；放进包里、出包以后，再用 app 的信任名单把整个文件检查一遍，过不了就不交出去。要拿分享文件里的文件（导入），用 `inspectShareFile`，报告通过了才用 `opened.files`；别引用 `openShareFile`（见上表）。
- **补全**：下载的基础部分 zip 先用 `verifyMessage(zip 字节, 签名文本, 信任名单)` 验 zip 本身（这几步在 `lib/release-fetch.mjs` 的 `fetchOfficialEntry`：核对大小和 SHA-256、验 zip 的签名、用 `inspectShareFile` 检查里面的内容，补全和导出完整包共用）；放进角色部分的 `voice-pack/` 以后，**再整个包做一次互相校验**（`lib/complete.mjs`）：
  ```js
  const report = await checkPart(filesWithBase, { verifySignature: createSignatureVerifier(trustList) });
  if (!report.ok || !report.mutual.checked) { /* 补全没成：报错，不兜底 */ }
  ```
  `trustList` 是正在运行的这份协议核心自带的 `protocol/trust.json`（agent 环境里就是包自带的那份协议核心，这是这套校验的边界，见上一节）。补全后 `mutual.checked` 必须是 `true`，不是就说明基础部分没有落到该在的位置，当作补全失败。从基础部分 zip 里取文件时，同样别引用 `openShareFile`（见上表）。
- **接收分享文件的服务端**：用**服务端自己部署的这份基础部分自带的** `protocol/trust.json`，不读上传的分享文件里的名单。
  ```js
  const trustList = JSON.parse(await readFile(path.join(basePartDir, 'protocol', 'trust.json'), 'utf-8'));
  const report = await checkShareFile(bytes, { verifySignature: createSignatureVerifier(trustList), env: { fetch: serverFetch } });
  ```
  `mutual` 默认做；只有角色部分的包做不了（`no_base`），接不接收由服务端自己定。外部资源用的 `env.fetch` 由服务端注入，要带上不指向内网这类网络策略（见 `FORMAT.md` 的「外部资源」）。
- **只读来比一比**：打开来源包时写了 `allowUnsigned: true`，没给验签函数（和命令行做包时交来源包一样）。这是有意的，不是漏了验签：来源包只读来和新包比一遍（查重），内容不进新包、不展示、不拿来用，也不联网、不签名、不看检查报告的结论，所以这里不是信任判断。凡是要用分享文件里的东西（导入、补全、接收发布），仍然走上面各条的验签。
- **命令行（`check`、`pack`、`unpack`）**：`cli/checking.mjs` 永远给验签函数、打开互相校验；`--allow-unsigned` 加上 `allowUnsigned: true`，也就是上表第二行。

库的接口（`protocol/lib/official.mjs`，只用平台自带的 API，浏览器和 Node 都能跑）：

```js
import { createSignatureVerifier } from './protocol/lib/official.mjs';
const verifySignature = createSignatureVerifier(trustList);
const report = await checkPart(files, { verifySignature });   // mutual 默认就开
```

`createSignatureVerifier` 建的时候就检查信任名单（形状不对抛 `trust_list_invalid`），并且读下一份快照，之后调用方再改手里的名单对象也不影响它。报告里每个部分的签名是 `{ part, file, present, verified, skipped?, keyId? }`，字段含义在 `lib/check.mjs` 的文件头。

除了「报错」一节的 code，验签失败还可能是 `signature_missing`（基础部分或协议核心没有签名文件，`details.path` 是应该有的文件）；所有验签失败的 `details.path` 都是签名文件在整个包里的完整路径。入口不选策略抛的是 `signature_policy_missing`（`details.entry` 是哪个入口）；只选了 `allowUnsigned: true` 而部分带着签名文件，报告里是 `signature_unverifiable`。

## 互相校验

一个角色部分和它带着的基础部分对一对（`checkPart`、`checkShareFile`、`inspectShareFile` 默认就做，写 `mutual: false` 才不做；规则在 `lib/mutual.mjs`；命令行的 `check`、`pack`、`unpack` 一直做）。校验的四条（完整性、版本、能力、内容），这样落：

| 要求 | 怎么查 | code |
|---|---|---|
| 完整性：每个文件都和清单里记的哈希一致 | 检查对每个部分各自做的（`FORMAT.md`「检查」第 3 步），不在互相校验里 | `file_modified` 等 |
| 版本：两部分的协议版本兼容 | 角色部分的 `requires.protocolMajor` 等于基础部分的协议主版本；次版本不管（同一个主版本内兼容） | `protocol_incompatible` |
| 版本：基础部分不低于角色部分要求的最低版本 | 基础部分的版本不低于 `requires.baseMin`，按语义化版本的次序比：预发布版低于对应的正式版，构建信息不参与 | `base_too_old` |
| 能力：角色部分里每个功能要的所需能力，基础部分都认得 | 每项能力都是基础部分能力词表（`vocab/capabilities.json` 的 `capabilities` 的键）里的名字；每项缺的能力报一次，要它的功能都列上 | `capability_unknown`；词表读不懂 `capability_vocabulary_invalid` |
| 内容：至少有一段参考音频和对应的文本 | 不在互相校验里：这是清单自己的规则，清单检查里判定、报告（schema 的 `minItems`、`minLength` 加语义规则 `text_blank`，`FORMAT.md`「语义规则」第 10 条）。同一条规则只在一处判定、一处报错 | `manifest_invalid` |

只有角色部分、没有基础部分的包，互相校验做不了：报告的 `mutual` 是 `{ checked: false, reason: 'no_base' }`，命令行的文字报告会写「没做」和原因。这种包进入环境、补全了基础部分之后，对补全来的基础部分再做一次互相校验。

两个检查的结果各报各的，不互相遮：签名不对不会让互相校验不做，互相校验没过也不会让验签不做。

### 报错（验签和互相校验接进检查之后新增的 code）

| code | 什么时候 |
|---|---|
| `signature_missing` | 基础部分或协议核心没有签名文件 |
| `signature_unverifiable` | 只选了 `allowUnsigned: true`、没给验签函数，而这个部分带着签名文件：没法验，不当成通过。`details.path` 是签名文件 |
| `signature_policy_missing` | 信任边界上的入口（`checkPart`、`checkShareFile`、`inspectShareFile`）没选验签的策略：`verifySignature` 和 `allowUnsigned: true` 两样都没给。**抛出来，不放进报告**，在读任何输入之前。`details.entry` 是入口的名字 |
| `protocol_incompatible` | 角色部分要求的协议主版本和基础部分的不一样。`details`：要求的、实际的、基础部分的协议版本 |
| `base_too_old` | 基础部分比角色部分要求的最低版本低。`details`：要求的、实际的版本 |
| `capability_unknown` | 角色部分的某个功能要一项基础部分词表里没有的所需能力。`details.capability`、`details.features` |
| `capability_vocabulary_invalid` | 基础部分的能力词表缺了（清单里也没列）、不是 JSON、形状不对、太大。`details.reason` |
| `signature_hook_invalid` | 验签的钩子返回的不是 `{ ok }`（程序错误） |

## 测试怎么做

测试签名相关的代码：钥匙现场生成，或者用明确标成「仅测试」的固定数据（里面只有公钥，没有私钥），**绝不用官方私钥**。用真的 minisign 0.12 签出来的签名当独立来源的已知答案。接进检查的坏包用例（签名不对、协议核心被改、协议主版本不支持、基础部分版本太旧、缺所需能力）用现场生成的测试密钥签名。
