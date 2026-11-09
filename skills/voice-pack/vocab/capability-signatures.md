# 所需能力的调用签名

音色包要在社区里长期流传，会被带进不同的运行环境，各个环境能用的模型不一样，也会变；所以音色包不绑定模型，只向运行环境要所需能力（名字和分层见 `capabilities.json`），用哪个模型来提供由运行环境定，代价是同一个包在不同环境里出来的效果可能不一样。这份文件定下每项能力的**调用签名**：参数、返回值、报错。流程层和适配器照它实现，别各写一套。

每项能力在这里写一次就够了：用到它的模块在文件头用 `@capability <能力名>` 指过来，不再抄一遍签名（在这个 skill 的目录里：`grep -rn "@capability " .`）。

各适配器把所需能力对到哪些模型，写在适配器自己的目录里（`../adapters/<名字>/`）。这里只写能力本身，不写模型；适配器怎么写、出错怎么报，见 `../adapters/README.md`。

## 通用约定

- 一项能力就是一个函数：**一个对象参数**，**`await` 它的返回值**（同步返回也行）。参数和返回值的字段名用 snake_case，和参数名 `ref_audio`、`ref_text` 一致（返回值里的 `modelChange` 是例外，见 `../adapters/README.md`「换了模型」）。
- **音频一律用字节加 MIME 类型**传：`{ bytes: Uint8Array, mimeType: 'audio/wav' }`（`protocol/lib/audio-clip.mjs`）。不收 URL、Base64 字符串、文件路径。要 URL 的模型由适配器自己去上传，URL 不出现在库的接口上。
- 返回里 **`model` 是可选**的：环境愿意报出实际用了哪个模型就报，库会把它记进验证记录和还原度报告；不报就当不知道。`cost` 之类运行环境自己的字段不属于签名，由它自己留着。
  任何一项能力的返回里还可以有 **`modelChange`**（这一次换了模型）：形状、字段名为什么不照 snake_case、谁读它、写错了怎么办，只写在 `../adapters/README.md`「换了模型」。
- 能力自己抛的错原样往上传（库不吞）。库自己抛的错分哪两类、`code` 怎么起，见 `../protocol/README.md` 的「错误」一节。唯一的例外是下一条标出来的「服务暂时出错」。
- **服务暂时出错要标出来**：能力因为服务一时出错（上游 5xx、网关超时、网络错误、超时……）没做成时，抛 `VoicePackError`，在 `details.transient` 里写 `true`（有 HTTP 状态就放 `details.status`）。一次要调很多次能力的功能（还原度、配音、做包、长录音的转写）据此把这一条记下来、接着做别的，调用方事后再决定要不要补做，而不是整件事作废。缺能力、参数错、401、返回的形状不对这类重来也没用的不标；没标的错，库一律原样往上抛，不按 HTTP 状态去猜。适配器怎么标，见 `../adapters/README.md`「出错的约定」。库不替能力重试：会计费的调用（建任务、补全）重试可能重复计费；例外只有 `../lib/call-attempts.mjs` 文件头「谁用它」那张表列的几种：转写，挑默认段和标提示标注（`audio-text-to-text` 在几段候选里挑默认段、给一段参考标提示标注），做包的试合成和配卡片试听那一句（`voice-cloning`，`../lib/make-pack-trial.mjs` 的 `envForPackDub`；配音 `dub` 本身不重试）。这几种做包时每段（每条）最多调 3 次、暂时出错才再来（为什么是这几个数见那个文件头；某个环境上失败的调用收不收费，写在那个环境的适配器里；盲听出错不在这里重试）。
- **只和这一次的文字有关的拒绝要标出来**：能力因为这一次要说的文字（`text`）本身被拒，换一句文字可能就成（字数太短或太长、有环境处理不了的字、服务商对这句话的说法），抛 `VoicePackError`，在 `details.textRejected` 里写 `true`，**不标 `transient`**（同一句原样再发还是一样）。库据此把这一段记成失败、别的段照常做（配音，`lib/dub.mjs`）。**调用之前就查出来的**（适配器自己的检查：空白、太长、有处理不了的字，code 是 `capability_input_invalid`）只记这一句，不计数；**服务商拒的**（code 不是 `capability_input_invalid`）连着 3 句、还没有一句成功的，配音停下来，见那里的文件头（平台说一个请求装不下的不算进这个数，见下面 `voice-cloning`、`text-to-dialogue` 的「一个请求装不下」）；没有这个标的错照旧往上抛、停下来。参考、凭据、参数形状、声音的描述（`voice_prompt`）这类对每一句都一样的错不标：换一句也还是这个错，要停下来。适配器怎么标，见 `../adapters/README.md`「出错的约定」。
- **回答没正常结束或是空的要标出来**：听音频（`audio-text-to-text`）的能力，回答被截断（`stopReason` 是 `length`）、中途出错（`error`、`aborted`），或者回答里没有文字，抛 `VoicePackError`，在 `details.unusable` 里写 `true`，`details.problem` 写是哪一种（`stop_reason` 或 `text_missing`；`stop_reason` 时 `details.stopReason` 写原值）。**不标 `transient`**：每问一次都花钱，再问也可能还是这样，不是「服务暂时出错」。库（`lib/capability-calls.mjs` 的 `isUnusableAnswer`）据此把那一条记成「作废」，不重试、不停下整次：标提示标注的那一段记成 `annotation_answer_unusable`（带 problem、stopReason、模型，`lib/segment-annotation.mjs`），挑默认段的那一次记成作废（`lib/default-pick.mjs`）；盲听的那一条见下面 `audio-text-to-text` 一节。没标的错照常往上抛。适配器怎么标，见 `../adapters/README.md`「出错的约定」第 8 点。
- **服务那头做完了、只是结果没取回来，要标出来**：能力的活儿在服务那头已经做完、已经计费，只是把结果取回来的时候失败了（例如生成好的音频下载不下来，适配器自己该重试的也重试过了），抛 `VoicePackError`，在 `details.unretrieved` 里写 `true`，并在 `details.retrieve` 里写一句给人看的话：结果怎么取回（用什么命令、去哪里取，带上任务号这类线索；不写网址、不写凭据）。**不标 `transient`**：重新调一次能力会再做一次、再计一次费，不是「稍后重来就成」。库（配音，`lib/dub.mjs`）据此把这一段记成失败，单列成「没取回」，不放进重做的命令，照 `details.retrieve` 告诉使用者怎么取回；别的段照常做。没有这个标的错照旧（暂时出错的标 `transient`，别的往上抛）。适配器怎么标，见 `../adapters/README.md`「出错的约定」。
- 环境缺这项能力时不用假装有：不提供这个键就行，用到它的功能会抛 `capability_missing` 并点名。

## 合成

### `text-to-speech`

用环境的默认音色把文字念出来。

```js
await env.capabilities['text-to-speech']({
  text,                  // string，必填：要说的话；里面方括号的提示原样交给模型，见下面「怎么念」
})
// -> { bytes: Uint8Array, mimeType: string, model?: string }
```

### `voice-cloning`

按参考音频合成新台词，声音像参考里的人。默认只用一段参考。

```js
await env.capabilities['voice-cloning']({
  text,                  // string，必填：要说的话；里面方括号的提示原样交给模型，见下面「怎么念」
  ref_audio,             // {bytes, mimeType}，或它的数组（融合，见下）。必填
  ref_text,              // string，或和 ref_audio 一一对应的字符串数组。参考音频里说的原文，可选
  enhancers,             // 增强件的数组，可选，见下面「增强件」
  expressiveness,        // integer，可选：0 到 100，声音起伏的幅度（数越大越多变，数越小越平稳）。不给，环境用自己的默认
  seed,                  // integer，可选：0 到 2^53−1。同一个种子加同样的输入，尽量出同样的结果。环境声明了 seed-in-request 才收（见下面「怎么念」的 seed-in-request）
})
// -> { bytes: Uint8Array, mimeType: string, model?: string, enhancers_used?: string[] }
```

- `ref_audio` 给数组表示**融合**，只在调用方明确要融合时才用；给一段就只用那一段。怎么融合（等权还是带权重）由环境决定，包不传权重。
- `ref_text` 是参考音频的逐字文本。参考段有提示标注（清单里的 `annotatedText`，逐字文本在说法变化的地方加上方括号提示，例如 `[laughs]呵呵，[happy]太可爱了吧。`）时，配音交的是提示标注，模型就知道这段参考是怎么说的（`lib/dub.mjs`）。用不上的环境可以忽略它；收不下方括号提示的环境，由适配器决定怎么办（例如去掉提示再交）。
- `enhancers`：可选，包里服务这项能力的增强件，用法见下面「增强件」。返回值里可以多一项 `enhancers_used`。
- `expressiveness`：可选。不给的处理、校验和报错、`dub` 什么时候才传，都同 `text-to-dialogue` 的 `expressiveness`。环境的模型没有这个旋钮的，忽略它，在环境自己的说明里写明；不为它另加声明。
- `seed`：可选。只有声明了 `seed-in-request` 的环境，库才给（没声明的环境，调用里没有这个键）；声明了就要收，写法和越界的报法同 `text-to-dialogue` 的 `seed`。
- 库替它重试的只有做包：试合成的留出录音和配卡片试听那一句，暂时出错（`details.transient`）每条最多调 3 次，多调的次数写进「确认费用」（`../lib/make-pack-trial.mjs` 的 `envForPackDub`）；配音 `dub` 不重试。失败的调用收不收费，写在适配器说明里。
- **字数下限**：环境可以声明这项能力一次至少要多少个字（适配器的 `limits.minChars`，见 `../adapters/README.md`）。库据此在合成之前并段（`lib/dub.mjs` 文件头第 5b 步），并不了的那一段记成失败，不调用能力；适配器自己不拦短文字，库不把它送进来。服务商那头说字数不够的，同样标 `details.textRejected`（见上面「通用约定」），库把那一段记成失败，别的段照常做。
- **一个请求装不下**：平台说这一句的话和参考加起来超过了一个请求能说的长度的，写法同 `text-to-dialogue` 的「一个请求装不下」：抛 `VoicePackError`，`details.problem` 写 `too_long_for_one_request`，`details.textRejected` 写 `true`，**不标 `transient`**（原样再发还是装不下）。例如一个人说话和说一场戏用同一个模型的环境，两项能力都可能这样报。
  库不自动切开，不重发：配音（`lib/dub.mjs`）把那一段记成失败，别的段照常做；它只和那一段的长度有关，不算进上面「通用约定」里服务商连着拒 3 句的那个数。命令行说把它改短，或者切成两个请求（见 `../cli/commands/dub.mjs` 的文件头「文字被拒」）。

### `voice-design`

按一段文字描述设计一个原本不存在的声音，用它念一段试听文本。不要参考音频。

```js
await env.capabilities['voice-design']({
  text,                  // string，必填：试听文本，用设计出来的声音念
  voice_prompt,          // string，必填：用文字描述想要的声音（性别、年龄、音高、口音、音色……，写法见 `../SKILL.md` 第 2 节「设计」），不用某个模型的指令语法
})
// -> { bytes: Uint8Array, mimeType: string, model?: string }
```

- `text` 和 `voice_prompt` 都是非空字符串。缺了、不是字符串、只有空白，抛 `VoicePackError('capability_input_invalid', 原话, { details: { capability: 'voice-design', field } })`，`details.field` 是 `text` 或 `voice_prompt`，没有 `problem`。
- 返回的是设计出来的声音念这段试听文本的音频。设计出来的声音不单独留存：要在别处用这个声音，拿这段音频当参考（`voice-cloning` 的 `ref_audio`）。
- **环境对这两个参数可能有限制**：字数上限、处理不了的字。限制由各适配器自己写明（例如写在它的对照表里），没写就是不限制。超出限制，适配器要在一切花钱、花时间的事之前（连服务、建任务）抛错，不截断，也不悄悄改调用方给的字：`VoicePackError('capability_input_invalid', 原话, { details: { capability: 'voice-design', field, problem, … } })`，`field` 是 `text` 或 `voice_prompt`（两个都有问题，先报 `text`），`problem` 有两种：
  - `too_long`：这个参数超过了字数上限。`details.length` 是它有多少个字符，`details.max` 是上限。数法按环境自己写明的（例如数 UTF-16 的单位数，也就是 `String.length`，一个表情符号算两个，和服务商数的一样）。
  - `unsupported_characters`：这个参数里有环境处理不了的字。`details.characters` 是其中不同的字（数组，按第一次出现的先后，最多 10 个）。例如有的服务处理不了码点在 U+FFFF 以上的字（表情符号、生僻汉字），带一个就白等到超时。两件事都碰上，先报这一件：去掉那些字，说不定就不超了。
- 这是调用方和环境之间的事，不是服务出了问题：上面两种不标 `transient`，再问一次还是一样。服务商自己因为这次的输入拒绝了任务（例如超过它的上限），同样是重来也没用，也不标 `transient`，即使服务商回的 HTTP 状态看着像暂时出错（例如有的服务描述超限回 HTTP 502）。真正的服务暂时出错按「通用约定」标 `details.transient: true`。
- 凭据被拒（401）怎么办，见 `../adapters/README.md`「出错的约定」。库不替它重试：建任务会计费，重来可能重复计费。

### `text-to-dialogue`

一段对白：几个说话人轮流说，每个说话人各带一段参考录音。只有一个人说话，用 `voice-cloning`。

```js
await env.capabilities['text-to-dialogue']({
  text,                  // string，和 turns 二选一：整段对白。每个说话人的台词前面写他的编号 {N}，N 从 0 起（见下）
  turns,                 // 数组，和 text 二选一：一场戏的每一轮 [{ speaker, text }]（见下「一场戏」）
  speakers,              // 数组，必填，2 到 16 项：第 N 项是说话人 N 的参考，形如 { ref_audio, ref_text }（见下）
  expressiveness,        // integer，可选：0 到 100，声音起伏的幅度（数越大越多变，数越小越平稳）。不给，环境用自己的默认
  seed,                  // integer，可选：0 到 2^53−1。同一个种子加同样的输入，尽量出同样的结果
})
// -> { bytes: Uint8Array, mimeType: string, model?: string }
```

- `speakers[N]` 的 `ref_audio` 是 `{bytes, mimeType}`（通用约定：不收 URL）；`ref_text` 是那段参考录音的逐字文本，可选，给了就随参考一起交给环境；同 `voice-cloning`，参考段有提示标注时交的是提示标注。
- **说话人标记**：`{N}` 写在一个说话人的台词前，之后的字归他，直到下一个标记。N 写成规范的数字（不带前导零），且小于 `speakers` 的项数。文字里一个标记都没有，或者编号越界，抛 `VoicePackError('capability_input_invalid', 原话, { details: { capability, field: 'text', problem, textRejected: true } })`，`problem` 是 `no_speaker_marker` 或 `speaker_out_of_range`：只和这一句的文字有关，换一句可能就成。标记以外的字（方括号、圆括号里的字，环境自己认的标记）原样交给环境。
- `speakers` 不到 2 项，或超过环境的上限，抛 `capability_input_invalid`，`details.field` 是 `speakers`，`problem` 是 `too_few` 或 `too_many`，没有调用。参考段数有上限的环境，要把上限声明成适配器的 `limits.maxSpeakers`（`../adapters/README.md`「返回的形状」），配音会在超出之前把一场切开；只写在说明里、不声明的话，配音会发来人数更多的一场，这个错不带 `textRejected`，整份配音停下。
- **一场戏（`turns`）**：和 `text` 二选一，一场戏一个请求。每一轮是 `{ speaker, text }`：`speaker` 是 0 到 `speakers` 项数减 1 的整数（对应 `speakers` 的第 N 项），`text` 是这一轮要说的话（非空字符串），这一轮的提示就写在里面它生效的位置（见下面「怎么念」）。
  各轮按次序连着，同一个说话人可以连着几轮。`turns` 和 `text` 都给了，或者 `turns` 不是非空数组、某一轮不是对象、`speaker` 不是整数，抛 `capability_input_invalid`（`field` 点名是哪一项，例如 `turns`、`turns[1].speaker`；
  都给了的 `problem` 是 `text_and_turns`）；`speaker` 越界（`problem` 是 `speaker_out_of_range`）、某一轮的话是空白的，另带 `textRejected: true`：只和这一场的文字有关。
- `expressiveness` 可以不给：不给，环境用自己的默认（配音只在取到值的时候才传，不编一个：调用方给的，或者这个声音的设定固定的，见 `../lib/dub.mjs` 文件头「设定」）。刻度是百分制：0 到 100 的整数，50 是平台的默认，也就是官方采样；不收小数，也不收 0 到 1 的写法；换算成模型自己的参数只在环境里做一次，写在环境自己的说明里。给了，但不是 0 到 100 的整数，抛 `capability_input_invalid`（`field` 是 `expressiveness`；是有限的数、却不是 0 到 100 的整数时（越界、小数、0 到 1 的写法）`problem` 是 `out_of_range`，不是数没有 `problem`）；`seed` 同理（`field` 是 `seed`）。`text` 是空白的，同样抛 `capability_input_invalid`（`field` 是 `text`，`textRejected` 为 true）。这些都是对每一句都一样的或调用方的事，不标 `transient`。
- 没有说明、情绪的名字、语速、音色、语种这些参数：「怎么说」写在文字里（见下面「怎么念」）。要单人说话，用 `voice-cloning`。
- 返回的是整段对白合成出来的一段音频，一个请求一个音频：没有每一轮各自的音频或时间戳。文字和参考录音的长度这里不限制，平台怎么处理就怎么回，报错按下一条原样往上传。
- **一个请求装不下**：平台说这一场的话和参考加起来超过了一个请求能说的长度的，抛 `VoicePackError`，`details.problem` 写 `too_long_for_one_request`，`details.textRejected` 写 `true`，**不标 `transient`**（同样的话和参考原样再发还是装不下，即使平台回的 HTTP 状态看着像暂时出错）。
  库不自动切开，不重发（上游拒收，错原样回给调用方）：配音（`lib/dub.mjs`）把那一场记成失败，说明是哪一场、怎么办（在那一场中间加章节标记，或者用 `scene: false`，见 `scene-in-request`）。平台说了它这次的上限的，适配器放进 `details`（例如 `maxFrames`、`maxMinutes`），库只原样带着，不读它。上限随参考和文字的长度、排队变，不是一个固定的数，所以签名里不写。
- 上游报错按「通用约定」原样往上传（暂时出错标 `transient`；拒绝了这次输入的不标）。
- 名字取业内对这类能力的通用叫法。

## 听

### `audio-text-to-text`

听一段或几段音频，按文字指令回答。盲听、挑默认段、标提示标注都用它。

```js
await env.capabilities['audio-text-to-text']({
  parts,                 // Array<{ text: string } | { audio: {bytes, mimeType} }>，必填：按顺序交替的文字和音频
})
// -> { text: string, model?: string }
```

- `parts` 按顺序拼成一次请求：文字是给模型的说明，音频就是它要听的那几段。两段音频就按它们在 `parts` 里的先后当作 X、Y，**不另外传角色标记**（`{ audio }` 那项只放音频）。
- `text` 是模型的回答原文，库自己解析（盲听要求回答是一个 JSON 对象，见 `lib/fidelity.mjs` 的 `parseBlindAnswer`）。
- 不给温度、最大长度之类的参数：用环境自己的默认值，同一段音频答得稳一点更好。
- 暂时出错（连不上、HTTP 5xx、网关超时、网络错误）按「通用约定」标 `details.transient: true`；服务明确报的错不标。适配器只管标对，不自己重试；重试由库做，**只有挑默认段和标提示标注那两种用法**（`lib/default-pick.mjs`、`lib/segment-annotation.mjs`）：做包时每次最多问 3 次，暂时出错才再来，两次之前各等 5 秒、15 秒，3 次都没成才记成「没听成」（规则只在 `../lib/call-attempts.mjs` 写一份，命令行和 app 共用；「确认费用」里写明最多多听几次）。盲听（两段音频）出错不重试，记成「没听成」，事后补做（`lib/fidelity.mjs`）。补全可能已经计费，失败的补全收不收费没有量过：写费用的调用方按最多的次数写，用户同意的是上限；换一个会为失败的补全收费的服务，要在适配器说明里写明。
- **服务商拦下了回答**（服务商用内容过滤把这次回答截断或换掉，回答的位置上是服务商自己的一句说明，不是模型的回答）：抛 `VoicePackError('provider_blocked', 给人看的一句话, { details: { capability: 'audio-text-to-text', provider, reply, model? } })`，`provider` 是服务商的名字（小写），`reply` 是回答里服务商那句说明的原话全文（打过码：令牌形状的串和签名地址去掉，别的字不动）。这是适配器的事：认的是服务商的原话，哪家服务商说了什么只写在适配器里，换了服务商就在那里加它的说法；不要把这句说明当成回答的 `text` 交给库，库会把它当成「不是 JSON」。不标 `transient`：同一段录音再问还是被拦，不是「服务暂时出错」，不要标成能重来。给人看的那一句话建议写成「模型的服务商拦下了这一段的回答（多半因为台词是现成的文章），这一段不算数」，报告和命令行直接用它。库（`lib/fidelity.mjs`、`lib/default-pick.mjs`、`lib/segment-annotation.mjs`）**只认 `provider_blocked` 这个 code**：盲听那一条、挑默认段那一次、标提示标注那一段记成「作废」（不记成「没听成」，补做也不会重做它），另外数有几条是被拦下的（`blocked`），写明是被拦下而不是「回答不是固定格式」，不进任何比例（读法第 5 点）。别的写法（能力自己起的码）库不认，照常往上抛。
- **回答没正常结束或是空的**（被截断、中途出错、没有文字）：适配器抛它自己的错误码，`details.problem` 写 `stop_reason` 或 `text_missing`，`details.unusable` 为 `true`（写法见「通用约定」，不标 `transient`）。库（`lib/fidelity.mjs` 的 `blindListen`）把那一条盲听转成 `blind_answer_unusable` 记成「作废」，不记成「没听成」，补做不重做它，不计进任何比例；被拦下（`blocked`）只数 `provider_blocked`，这一种不数进去。标提示标注那一段记成作废，原因是 `annotation_answer_unusable`，带 problem、stopReason、模型（`lib/segment-annotation.mjs`）；挑默认段那一次同样作废（`lib/default-pick.mjs`）。几处都不重试，也不停下整次。

### `automatic-speech-recognition`

把一段语音转写成文字。做包时给没有文本的原声补逐字文本：长录音先切段再逐段转写（`lib/long-recording.mjs`），交给做包流程的片段没有文本时它自己转写（`lib/make-pack-transcribe.mjs`）。

```js
await env.capabilities['automatic-speech-recognition']({
  audio,                 // {bytes, mimeType}，必填：要转写的那一段
  language,              // string，可选：这段录音说的是什么语言（BCP 47，例如 es、zh-CN）。调用方知道才带，不知道就不带这个键
})
// -> { text: string, language?: string, model?: string }
```

- `text` 是识别出来的文字，首尾空白去掉。一句也没识别出来（静音、纯音乐）是空串，**不是错误**。
- `language`（参数）：**调用方知道录音的语言就带上**，库在这几处带：做包页的「录音的语言」（`makePack` 的 `input.language`，片段自己的 `language` 盖过它）、`prepareLongRecording` 的 `language` 选项。不知道就不带，环境自己听。只看主语言：`zh-CN`、`zh_TW`、`ZH` 都是 `zh`；`und`（BCP 47 的「未定」）等于不知道，和不带一样。
- **环境认不了这种语言，就报错，不能把乱的文字交回来**，也不能忽略 `language`、拿别的语言去识别：抛 `VoicePackError('capability_input_invalid', 原话, { details: { capability: 'automatic-speech-recognition', field: 'language', problem: 'unsupported', language } })`，`language` 是调用方带来的那个标签（原样，去掉两头的空白）；环境愿意的话可以再多带 `supported`：它认的语言（数组），给人看，也让调用方改选别的环境。这是调用方和环境之间的事，不是服务出了问题：不标 `transient`，再问一次还是一样；并且要抛在一切花钱、花时间的事（连服务、取令牌、转格式）之前。库不吞这个错（不是服务暂时出错），做包会以它停下：该用哪个环境的转写，由调用方（app 的环境）事先定，见各环境自己的说明。`language` 不是非空字符串（数字、空串）也是 `capability_input_invalid`，`field` 是 `language`，没有 `problem`。
- `language`（返回）可选：环境报得出语言就报（BCP 47，例如 `en`、`zh`），报不出就不带，库当作不知道、从文字本身认。
- 一次转写一段：长录音先切段（`../tools/silence-split.mjs`），不要把几十分钟的录音整段交进来。单次最长多少，写在各适配器自己的说明里。
- 返回里**没有时间戳**：切段不靠转写的时间戳。所以长录音靠 `../tools/silence-split.mjs` 按能量切（没有 `voice-activity-detection` 的环境），切好以后逐段转写，文字就对得上每一段。
- 音频格式环境自己负责：能直接收的就收，收不了的自己转（例如只收 16 kHz、单声道、16 位的 WAV 的服务，别的格式用环境的 `ffmpeg` 运行时转，环境没有 ffmpeg 就抛 `runtime_missing`）。
- **音频是空的，或者解不开**（交来的字节是空的；自己转格式时 ffmpeg 说不是音频，或者转出来一个字节也没有）：抛 `VoicePackError('capability_input_invalid', 原话, { details: { capability: 'automatic-speech-recognition', field: 'audio', problem } })`，`problem` 是 `'empty'`（空的）或 `'undecodable'`（解不开）。解得开、只是没人说话的录音不算：那是返回空串（见上）。这是这一段音频自己的事：不标 `transient`，同一段再转还是一样。库不另认这两个 `problem`，和别的错一样原样往上抛：做包整次停下（`lib/make-pack-transcribe.mjs`），长录音的转写也停下（`lib/long-recording.mjs`）。
- 凭据被拒（401）怎么办，见 `../adapters/README.md`「出错的约定」。
- **服务商拦下了这一段的转写**（内容过滤）：抛 `provider_blocked`，写法同 `audio-text-to-text` 一节的「服务商拦下了回答」（`details.capability` 是 `automatic-speech-recognition`），不标 `transient`。做包把那一段记成用不上（`transcription_blocked`，`lib/make-pack-transcribe.mjs`），不重试，别的段照做，不整次停下；长录音逐段转写（`lib/long-recording.mjs` 的 `transcribeAll`）也一样，丢掉那一段，写进 `transcription_blocked` 的说明。
- **被拦下也可以照暂时出错报**：同一段再问有时就过的服务，适配器可以照暂时出错报，这时要写明是被拦下：`VoicePackError(适配器自己的码, 给人看的一句话, { details: { capability: 'automatic-speech-recognition', transient: true, problem: 'provider_blocked', provider?, reply? } })`。库认的只有 `transient` 和 `problem`：`problem` 是 `'provider_blocked'`，就是被拦下。`provider`、`reply` 写法同 `provider_blocked` 这个码（服务商的名字，小写；服务商那句说明的原话全文，打过码），适配器认得出就带：回答就是服务商那句说明的，两样都有；只知道服务商停下了、不知道它说了什么的（例如平台只回一个 HTTP 502、原话里只有停下的原因），可以不带（平台的原话照旧写在报错里）。库照本节最后一条（暂时出错）再问，问满了次数、**最后一次**的错还是这样，那一段按被拦下记：做包记成 `transcription_blocked`，`details` 是 `{ error, attempts }`（最后一次的错的摘要、试了几次），提示照被拦下的说法（补上逐字文本，或者换一个转写），不叫人「稍后重做」；长录音照样丢掉那一段，`report.segments` 里那一段是 `blocked`，带 `attempts`，写进 `transcription_blocked` 的说明。最后一次只是暂时出错（没有这个 `problem`）的，照旧是 `transcription_failed`。不写 `problem` 的，库只当是暂时出错，问满了记成 `transcription_failed`，提示说稍后重做，使用者会以为重做就好。
- **回答没正常结束**（被截断、中途出错）：半截的文字不交回来。暂时出错和 `provider_blocked` 以外的错，库原样往上抛，做包整次停下（分离人声、切段、前面各段转写的钱已经花了）。所以同一段再问多半就成的，照暂时出错报（标 `transient`），库照下一条再问，问满了那一段记成 `transcription_failed`，别的段照做：例如适配器给转写设了输出上限，回答在上限处被截断，而上限比正常的逐字稿宽得多：碰到了是那一次的回答不正常，不是录音说的话太多。上限要给看不见的输出留够（有的模型思考关不干净，字都对的回答也多用几百个看不见的词元），不然正常的回答也会被截断、白白再问。再问还是一样的（录音真的长过输出的上限），不标。
- 暂时出错（连不上、连接断开、哪一步等不到回应）按「通用约定」标 `details.transient: true`；服务明确报的错不标。适配器只管标对，不自己重试；重试由库做：做包时每段最多转写 3 次，暂时出错才再来，两次之前各等 5 秒、15 秒，3 次都没成这一段才用不上（规则只在 `../lib/call-attempts.mjs` 写一份，命令行和 app 共用；「确认费用」里写明最多多听几次）。失败的转写收不收费，由适配器说明写明（会为失败的转写收费的服务尤其要写），调用方才能照实写费用。

## 评测

### `speaker-verification`

判断两段语音是不是同一个人，给出说话人相似度。

```js
await env.capabilities['speaker-verification']({
  audio_a,               // {bytes, mimeType}，必填
  audio_b,               // {bytes, mimeType}，必填
})
// -> { similarity: number, model?: string }
```

- `similarity` 是有限数（越多越像）。两次调用之间要能比大小：同一次评测里必须用同一个模型（否则还原度的比值没有意义，库会抛 `evaluation_model_mismatch`）。
- 只给相似度，不给「是不是同一个人」的结论：相似度的比值和盲听的结果怎么读，见 `lib/fidelity.mjs` 文件头「怎么读这份报告」。
- **某一段录音里没有能嵌声纹的语音**（短到嵌不出、近乎静音）：抛 `VoicePackError('capability_input_invalid', 原话, { details: { capability: 'speaker-verification', field, problem: 'no_speech' } })`，`field` 是嵌不出的那一路，`'audio_a'` 或 `'audio_b'`；两段都嵌不出时报 `'audio_a'`。这是那一段录音自己的事，不是环境坏了：不标 `transient`，同一段再算还是一样。还原度（`lib/fidelity.mjs`）只认这个写法：那一条的说话人相似度记成「量不到」，写明是哪一段，不进比例，别的条照常量，整份报告照常出（读法第 9 点）。别的写法（能力自己起的码、没写明 `field`）库不认，照常往上抛。同一个 `capability_input_invalid` 加 `details.problem` 的写法，转写能力也在用（`undecodable`、`empty`、`unsupported`，见转写一节）。
- 一次还原度评测要对 N 段真录音两两算（N(N-1)/2 次调用），实现可以自己按音频内容缓存嵌入、省掉重复计算。

## 处理长录音

做包流程（`lib/long-recording.mjs`）处理一段长录音时依次用到的两项能力，都是可选的：缺哪一项，只有那一步跳过，报告里写明。

### `audio-source-separation`

把混在一起的音频分成人声和伴奏等分轨。做包时先把录音里的人声分出来，再切段。

```js
await env.capabilities['audio-source-separation']({
  audio,                 // {bytes, mimeType}，必填：混在一起的录音
})
// -> { vocals: {bytes, mimeType}, accompaniment?: {bytes, mimeType}, model?: string }
```

- `vocals` 必有，是分出来的人声分轨，库只用它。`accompaniment` 和别的分轨环境愿意给就给，库不用。
- 环境没有这项能力：做包流程就跳过这一步，在报告里写明「这次没做分离，输入要是干净的人声」。
- 是花钱、耗时的调用，库不重试；失败原样往上传。

### `voice-activity-detection`

找出音频里哪些时间段有人在说话。做包时用它给长录音切段。

```js
await env.capabilities['voice-activity-detection']({
  audio,                 // {bytes, mimeType}，必填：要检测的录音
})
// -> { speech: Array<{ start_sec: number, end_sec: number }>, model?: string }
```

- `speech` 按时间先后排，互不重叠，每一项 `0 <= start_sec < end_sec`，不超过录音的时长（末尾超出不到 0.05 秒算舍入误差）；一段说话的都没有就是空数组。库会检查，不合格抛 `capability_result_invalid`，`details.problem` 是 `speech_invalid`，`details.index` 是出问题的那一项（整个返回不对就没有），不猜，也不退回按能量切。
- 它只说哪里有人在说话，切成多长一段由库定（`lib/long-recording.mjs` 把它给的区间当作 `../tools/silence-split.mjs` 里「有声音的区间」，后面的合并、长度上限、硬切都一样）。
- 没有这项能力的环境，库用 `../tools/silence-split.mjs` 按能量找静音。

## 只有部分环境能提供的

有些能力不是每个环境都有，别的地方会用到，先在这里定下名字：

- 其余还没有写法的（`text-to-audio`、`audio-watermarking`、`speech-to-speech`、`text-to-image`、`pronunciation-lexicon`）：谁先用到谁来定，定了写到这里。`voice-design` 已经定了，在上面「合成」一节。

## 文字

### `text-generation`

按文字提示生成文字（大语言模型）。润色、翻译、写配音指引用它。配音（`dub`）不用它：挑参考不让模型判情绪（`lib/reference-pick.mjs`）。

```js
await env.capabilities['text-generation']({
  prompt,                // string，必填：给模型的文字提示（非空）
})
// -> { text: string, model?: string }
```

- `text` 是模型的回答原文，由调用方自己解析。
- **一次请求的输入上限**：模型一次能收多少输入，由环境的适配器声明（`limits.maxPromptTokens`，见 `../adapters/README.md`）。声明了，调用方按它分几次发（量法和理由见 `../lib/input-batches.mjs`）；没声明，一次发完。超过上限的请求，平台回 400，是普通的平台错误，照下面的规则往上抛：所以要声明上限，不要靠平台拦。
- 回答不能用（没有文字，或者没有正常结束）：抛 `capability_result_invalid`，`details.capability` 写 `text-generation`，`details.problem` 写是哪一种（`text_missing`、`stop_reason`）；没有正常结束的，`details.stopReason` 写平台报的原因（`length` 是回答被截断，`error`、`aborted` 是中途出错）。回答被截断（`stopReason` 是 `length`）时，调用方可以把那一批对半分开再问（走法见 `../lib/input-batches.mjs`）。别的错（401、输入不对、服务暂时出错）照旧往上抛。

## 怎么念

### 文字里的提示

合成能力（`text-to-speech`、`voice-cloning`，`text-to-dialogue` 的每一轮）的 `text` 里可以有**提示**：方括号里写给模型的「怎么说」（`[sad and surprised]`、`[小声]`、`[laughs]`；语法是 `tools/markup.mjs` 文件头的「提示」），写在说法变化的地方，从那里起生效，一句里可以有好几个。

- 库原样、按位置交出去，不解读、不改。舞台说明（`（耳语）`、`*笑*`）库在交出去之前已经换成了提示，环境收到的提示只有方括号的。`text` 里还可能有：尖括号标签（台本里写的 `<whisper>…</whisper>`、语言标签、`<|名字|>`；声明了 `phoneme-markers` 时，读音词表换出来的音素标签），库不认、不改，原样交出（写法见 `tools/markup.mjs` 文件头「尖括号标签」；只声明了 `phoneme-in-text` 的环境，用上了拼音音素的那一句整句转成 `<speak>`，标签跟着转义，见 `lib/dub.mjs` 第 4 步）；同一章、同一个声音的几行并成一个请求时，行与行之间是换行（`\n`）。模型会念出来的、服务收不下的，由适配器决定怎么办，写在适配器说明里。
- 环境照它的模型认的写法交给模型：模型认方括号的提示，原样交；模型会把方括号念出来的，由适配器决定怎么办（去掉，或者译成模型认的写法），写在适配器的说明里。
- 没有另外的参数交「怎么说」：说明（`instructions`）、情绪和风格的名字（`cues`）、续接（`continues`）都不是参数了，以前的声明 `style-instruction`、`style-cues`、`pause-in-text`、`cue-in-text` 也没有了（能力词表 2.0）。调用方和设定给的情绪、风格、能量，库合成一条提示写在文字的开头（`lib/dub.mjs` 第 7a 步），环境收到的同样只是文字；说明（`instructions`）库不发给模型，设定的说明是给写台本的人看的，调用方不能再给。配音指引不交给模型：写台本的人照它写提示。
- 语速不在提示里，也不是参数：调用方和设定给的语速，库在合成以后变速（`lib/dub.mjs` 第 7b 步），变不成的（没有 ffmpeg）记在 `unit.speed`，由拼接的人按它做（见 `lib/dub.mjs` 文件头「语速和停顿」）；台本里写的放慢、加快（`[slow]`、`<slow>…</slow>`）是提示或尖括号标签，原样交给模型。
- 停顿：同一章、同一个声音放得下的几行一次请求（`lib/dub.mjs` 第 5c 步，行与行之间换行），中间的短停顿写在 `text` 里，用的是量过的写法（标点和方括号里写的停顿，如 `[pause]`，不是 SSML；写法和长度只在 `lib/pause-in-request.mjs` 的 `PAUSE_WRITINGS`）；长过适配器的 `limits.maxPauseInRequestMs`（一个请求里一处停顿最多多长，见 `adapters/README.md`）的，在那里切成两次请求，停顿记在 `unit.pauseBeforeMs`、`unit.pauseAfterMs`，由拼接的人插静音（`lib/dub.mjs` 第 5c 步）。`[pause]` 是停顿的提示：模型会把方括号念出来的，适配器要把它译成模型认的停顿，不能去掉。配音怎么拼接只在 `references/dub-details.md` 的「拼接的细则」写一次。

### `phoneme-in-text`

不是函数，是**声明**：环境提供它，表示它的合成能力（例如 `voice-cloning`，以及没有参考音频的朗读）认文字里的音素：`<speak>…</speak>` 包着的 `<phoneme alphabet="x-pinyin" ph="zeng1">曾</phoneme>`，按 `ph` 念，标签本身不念。在 `env.capabilities['phoneme-in-text']` 里放 `true`。

- 库用 `hasCapability(env, 'phoneme-in-text')` 问：有，读音词表里的拼音音素（`lexicon.pls` 的 `<phoneme>`，字母表是 `x-pinyin`，写法见 `references/make-pack-details.md`「读音词表」）才写进要说的话里；没有，它照旧报在 `lexicon.unapplied`（`reason` 是 `phoneme`），文字里没有它。
- 字母表名：包里统一写 `x-pinyin`（PLS 第 2 节：非 `ipa` 的字母表必须是 `x-` 开头的自定义名）。适配器把它译成自己服务的写法，并在它的说明里写明认哪个字母表名；不认的字母表不译，由库报在 `unapplied`。
- `ph` 是拼音加数字声调（`zeng1`，声调 1 到 5，5 是轻声）：每个汉字一个音节，用空格分开，个数和汉字数相等；声明了的环境里，词条不全是汉字的、对不上的不写，报 `unapplied`（`reason` 是 `phoneme_format`，`problem` 写明是 `term`、`count` 还是 `form`）。
- 没有声明的环境，和现在一样：音素不用，报在 `unapplied`（`reason` 是 `phoneme`）。
- 环境同时声明了 `phoneme-markers`，库用音素标签，不用这一种（见下）。

### `phoneme-markers`

不是函数，是**声明**：环境提供它，表示它的合成能力（`voice-cloning`、`text-to-speech`，`text-to-dialogue` 每一轮的文字）认文字里的音素标签：`<|phoneme_start|>音素<|phoneme_end|>` 代替原来的词，原来的字不写，按标签里的音念，标签本身不念。在 `env.capabilities['phoneme-markers']` 里放 `true`。

- 库用 `hasCapability(env, 'phoneme-markers')` 问：有，读音词表里的音素（`lexicon.pls` 的 `<phoneme>`）写成音素标签，换掉原来的词，写法见 `references/make-pack-details.md`「读音词表」：
  - 字母表 `x-pinyin`：拼音一个音节一个标签，几个标签挨着写，`银行`（`yin2 hang2`）写成 `<|phoneme_start|>yin2<|phoneme_end|><|phoneme_start|>hang2<|phoneme_end|>`；
  - 字母表 `x-arpabet`：CMU Arpabet，一个词一个标签，音素照写，`Zorbek`（`Z AO1 R B IH0 K`）写成 `<|phoneme_start|>Z AO1 R B IH0 K<|phoneme_end|>`；
  - 字母表 `x-romaji`：日文，OpenJTalk 风格的罗马字带音调数字，一个词条一个标签，`橋が`（`ha0shi1ga0`）写成 `<|phoneme_start|>ha0shi1ga0<|phoneme_end|>`。
- 包里的写法就是标签里的写法，库不转换：拼音小写、ü 写 `v`、声调 1 到 5（5 是轻声）；Arpabet 大写、音素之间空一格、元音带重音数字；罗马字每个字母段后面跟音调数字、不空格。模型要别的写法的，适配器译过去，并在它的说明里写明。
- 换成标签是一次替换，和别名（`<alias>`）在同一次里做（长的词条优先，换出来的字不再查词表），在规划时就做：`dub --dry-run` 的 `spoken`、一场戏每一轮的文字里就是标签，发出去的也就是它。不转义，不包 `<speak>`：句子里别的尖括号标签照样到模型。用上的记在 `lexicon.phonemes`，从 `unapplied` 去掉；那一段没有另外的 `phonemes`。
- 写法不对的（拼音的音节数、写法，Arpabet 的音素、重音数字，罗马字不是字母加数字，词条不是那种字）不写，报 `unapplied`（`reason` 是 `phoneme_format`，`problem` 是 `term`、`count` 或 `form`）；别的字母表（例如 `ipa`）照旧 `reason: phoneme`。
- 和 `phoneme-in-text` 都声明了：用这一种。`plan.capabilities` 里有 `'phoneme-markers': true`；没有声明的环境没有这个键，和以前一字不差。
- 声明的理由写成「模型认文字里的这种标签，按标的音念」。认到什么程度（例如标的读法和上下文里一个常见词冲突时，模型照常见词念），写在模型说明里。
- 标签的字是发出去的文字的一部分：按字数计费的服务连它一起算，`limits.maxChars` 也连它一起数。

### `seed-in-request`

不是函数，是**声明**：环境提供它，表示它的 `voice-cloning` 收 `seed`（同一个种子加同样的输入，尽量出同样的结果；`text-to-dialogue` 本来就收）。在 `env.capabilities['seed-in-request']` 里放 `true`。

- 库用 `hasCapability(env, 'seed-in-request')` 问：有，配音给每个 `voice-cloning`、`text-to-dialogue` 请求同一个固定的 `seed`（`lib/dub.mjs` 的 `DUB_SEED`），长文切开的几块就用的是同一个；每一段用的写在 `dub.json` 的 `units[i].seed`，`plan.capabilities` 里有 `'seed-in-request': true`。没有声明的环境，请求里没有 `seed`，`dub.json` 里也没有，和以前一字不差。
- 固定的意思是不随台本变：同一段同样的输入再配，出来的尽量一样。例外是调用方明说这一段要换一条再配：`dub --only` 点到、上一次配成过的段（库的 `options.only` 加 `previousSeed`，哪些算见 `cli/commands/dub.mjs` 文件头「--only 换 seed」），和做包时用同样的请求重配卡片试听那一句（`make-pack --card-line`），seed 换成上一次的加 1（`lib/dub.mjs` 第 7 步「seed」）。所以收到的 seed 可以是 0 到 2^53−1 的任何整数，不一定是 `DUB_SEED`。为什么要它和切分的规则见 `references/dub.md` 的「长文怎么切」。
- 声明的理由写成「模型收这个参数，同一个种子同样的输入尽量出同样的结果」。模型收不收、同一个种子能不能让切开的几块前后更接近，写在适配器和模型说明里。

### `scene-in-request`

不是函数，是**声明**：环境提供它，表示它的 `text-to-dialogue` 收 `turns`（见上），配音可以把台本里几个说话人轮流说的一段连续的话（一场戏）放进一个请求、一个音频。在 `env.capabilities['scene-in-request']` 里放 `true`。

- 库用 `hasCapability(env, 'scene-in-request')` 问，**还要有 `text-to-dialogue`**（缺一就按没声明处理）。两样都有、给了几个包、调用方没说 `options.scene: false`，配音才分场（`lib/dub.mjs` 第 5a 步）。没声明的环境，`planDub`、`dub.json` 和以前一字不差，`plan.capabilities` 里也没有这个键。
- 分场的规则（切点、每个说话人用哪一段参考）、场景在 `dub.json` 里的样子、为什么每一行没有各自的音频、太长怎么办、怎么退回一行一个请求：见 `references/dub.md` 的「一场戏一个请求」。平台说一场装不下时适配器怎么标，见 `text-to-dialogue` 的「一个请求装不下」。
- 声明的理由写成「模型认这种写法，一个请求配完一场」，不要写成「我们想少发请求」。声明就是换了这一场用的模型和做法（每个说话人整场只用一段参考，取他各行挑到最多的那一段，见 `lib/scene-in-request.mjs`；每一轮怎么说靠这一轮文字里的提示。没声明时，每行照它自己那一行挑参考。挑参考从来不看情绪，见 `lib/reference-pick.mjs`），所以要不要声明由适配器和宿主定，不由库定。

## 变声和唱歌

### `voice-conversion`、`singing-voice-conversion`

把一段音频换成另一个声音，内容、节奏（唱歌是旋律和歌词）不变。前者用于说话，后者用于歌声（输入应当是人声分轨，没有伴奏）。

```js
await env.capabilities['voice-conversion']({        // singing-voice-conversion 的签名相同
  audio,                 // {bytes, mimeType}，必填：要换声音的那段
  ref_audio,             // {bytes, mimeType}，必填：目标声音的参考（包里挑出来的一段）
  ref_text,              // string，可选：参考音频的逐字文本；参考段有提示标注时交的是提示标注（带方括号提示，同 voice-cloning 的 ref_text），收不下方括号的由适配器决定怎么办（例如去掉提示）；用不上的环境可以忽略
  enhancers,             // 增强件的数组，可选，见下
})
// -> { bytes: Uint8Array, mimeType: string, model?: string, enhancers_used?: string[] }
```

- 用到它们的是 `lib/convert.mjs`（`convertAudio`）。缺哪一项，只有对应的变声报 `capability_missing`，别的功能照常。

## 增强件

增强件是包里只对某个模型有效的文件（微调权重、LoRA、RVC 或 SVC 模型、说话人嵌入），包不依赖它。配音（`voice-cloning`）和变声会把包里**服务这项能力**（清单里增强件的 `capability`）的增强件递给能力：

```js
enhancers: [{ id, model, modelVersion, capability, referenceVersion, load }]   // load() -> Promise<Uint8Array>，用到才读（文件和清单对不对得上，进入环境时检查过，这里不再算）
```

- 能力是环境提供的，只有它知道自己跑的是哪个模型：认识增强件的 `model`（和 `modelVersion`）就 `await load()` 用上，并在返回值里写 `enhancers_used: [用上的增强件的 id]`；不认识就忽略 `enhancers`，照常生成，不报错。
- 报了没有递给它的 id、或 `enhancers_used` 不是数组，库抛 `capability_result_invalid`（`details.problem` 是 `enhancers_used_invalid`），不猜。
- 一个都没用上、而包里有增强件时，库在返回值里写 `enhancers.statement: 'enhancers_not_used'`，附上没用上的增强件是哪个模型的，和包的验证记录，让人知道当前环境下效果会差多少（`lib/enhancers.mjs`）。
