# 所需能力的调用签名

音色包要在社区里长期流传，会被带进不同的运行环境，各个环境能用的模型不一样，也会变；所以音色包不绑定模型，只向运行环境要所需能力（名字和分层见 `capabilities.json`），用哪个模型来提供由运行环境定，代价是同一个包在不同环境里出来的效果可能不一样。这份文件定下每项能力的**调用签名**：参数、返回值、报错。流程层和适配器照它实现，别各写一套。

每项能力在这里写一次就够了：用到它的模块在文件头用 `@capability <能力名>` 指过来，不再抄一遍签名（在这个 skill 的目录里：`grep -rn "@capability " .`）。

各适配器把所需能力对到哪些模型，写在适配器自己的目录里（`../adapters/<名字>/`）。这里只写能力本身，不写模型；适配器怎么写、出错怎么报，见 `../adapters/README.md`。

## 通用约定

- 一项能力就是一个函数：**一个对象参数**，**`await` 它的返回值**（同步返回也行）。参数和返回值的字段名用 snake_case，和参数名 `ref_audio`、`ref_text`、`instructions` 一致。
- **音频一律用字节加 MIME 类型**传：`{ bytes: Uint8Array, mimeType: 'audio/wav' }`（`protocol/lib/audio-clip.mjs`）。不收 URL、Base64 字符串、文件路径。要 URL 的模型由适配器自己去上传，URL 不出现在库的接口上。
- 返回里 **`model` 是可选**的：环境愿意报出实际用了哪个模型就报，库会把它记进验证记录和还原度报告；不报就当不知道。`cost` 之类运行环境自己的字段不属于签名，由它自己留着。
- 能力自己抛的错原样往上传（库不吞）。库自己抛的错分哪两类、`code` 怎么起，见 `../protocol/README.md` 的「错误」一节。唯一的例外是下一条标出来的「服务暂时出错」。
- **服务暂时出错要标出来**：能力因为服务一时出错（上游 5xx、网关超时、网络错误、超时……）没做成时，抛 `VoicePackError`，在 `details.transient` 里写 `true`（有 HTTP 状态就放 `details.status`）。一次要调很多次能力的功能（目前是还原度）据此把这一条记下来、接着做别的，调用方事后再决定要不要补做，而不是整件事作废。缺能力、参数错、401、返回的形状不对这类重来也没用的不标；没标的错，库一律原样往上抛，不按 HTTP 状态去猜。适配器怎么标，见 `../adapters/README.md`「出错的约定」。库不替能力重试：会计费的调用（建任务、补全）重试可能重复计费；转写和打标签（`audio-text-to-text` 给一段录音打情绪、风格标签）是例外，做包时每段最多问 3 次、暂时出错才再来（规则在 `../lib/call-attempts.mjs`，为什么是这几个数见它的文件头；某个环境上失败的调用收不收费，写在那个环境的适配器里；盲听出错不在这里重试）。
- **只和这一次的文字有关的拒绝要标出来**：能力因为这一次要说的文字（`text`）本身被拒，换一句文字可能就成（字数太短或太长、有环境处理不了的字、服务商对这句话的说法），抛 `VoicePackError`，在 `details.textRejected` 里写 `true`，**不标 `transient`**（同一句原样再发还是一样）。库据此把这一段记成失败、别的段照常做（配音，`lib/dub.mjs`）。**调用之前就查出来的**（适配器自己的检查：空白、太长、有处理不了的字，code 是 `capability_input_invalid`）只记这一句，不计数；**服务商拒的**（code 不是 `capability_input_invalid`）连着 3 句、还没有一句成功的，配音停下来，见那里的文件头；没有这个标的错照旧往上抛、停下来。参考、凭据、参数形状、声音的描述（`voice_prompt`）这类对每一句都一样的错不标：换一句也还是这个错，要停下来。适配器怎么标，见 `../adapters/README.md`「出错的约定」。
- 环境缺这项能力时不用假装有：不提供这个键就行，用到它的功能会抛 `capability_missing` 并点名。

## 合成

### `text-to-speech`

用环境的默认音色把文字念出来。

```js
await env.capabilities['text-to-speech']({
  text,                  // string，必填：要说的话
  instructions,          // string，可选：怎么念（语气、节奏、情绪）。只写想要的效果，不用某个模型的指令语法。环境有 style-instruction 才用
  cues,                  // { emotion, style }，可选：这一句自己的名字（舞台提示认出来的，加调用方 labels 给的情绪和风格）。环境有 style-cues 才用，见下面「怎么念」
  continues,             // true，可选：同 voice-cloning 的 continues（接着下一段说的，不到字数下限补「，」）
})
// -> { bytes: Uint8Array, mimeType: string, model?: string }
```

### `voice-cloning`

按参考音频合成新台词，声音像参考里的人。默认只用一段参考。

```js
await env.capabilities['voice-cloning']({
  text,                  // string，必填：要说的话
  ref_audio,             // {bytes, mimeType}，或它的数组（融合，见下）。必填
  ref_text,              // string，或和 ref_audio 一一对应的字符串数组。参考音频里说的原文，可选
  instructions,          // string，可选：怎么念。环境有 style-instruction 才用
  cues,                  // { emotion, style }，可选：这一句自己的名字（舞台提示认出来的，加调用方 labels 给的情绪和风格）。环境有 style-cues 才用，见下面「怎么念」
  continues,             // true，可选：这一段是接着下一段说的（句子被标记切开、没有停顿）：不到字数下限补「，」，句末的补「。」。没有就是 false
  enhancers,             // 增强件的数组，可选，见下面「增强件」
})
// -> { bytes: Uint8Array, mimeType: string, model?: string, enhancers_used?: string[] }
```

- `ref_audio` 给数组表示**融合**，只在调用方明确要融合时才用；给一段就只用那一段。怎么融合（等权还是带权重）由环境决定，包不传权重。
- `ref_text` 是参考音频的逐字文本。用不上的环境可以忽略它。
- `instructions`：环境有 `style-instruction` 才能按说明念；没有就**忽略**（别把它当成别的意思）。配音指引要不要传 `instructions`，先看环境有没有 `style-instruction`，见下面「怎么念」和 `lib/dub.mjs`。
- `cues`：环境有 `style-cues` 才能用；没有就**忽略**。只装这一句自己的名字（舞台提示认出来的，加调用方 `labels` 给的情绪和风格），配音指引不进去，见下面「怎么念」。
- `enhancers`：可选，包里服务这项能力的增强件，用法见下面「增强件」。返回值里可以多一项 `enhancers_used`。
- **字数下限**：环境可以声明这项能力一次至少要多少个字（适配器的 `limits.minChars`，见 `../adapters/README.md`）。库据此在合成之前并段（`lib/dub.mjs` 文件头第 5b 步），并不了的那一段记成失败，不调用能力；适配器自己不拦短文字，库不把它送进来。服务商那头说字数不够的，同样标 `details.textRejected`（见上面「通用约定」），库把那一段记成失败，别的段照常做。

### `voice-design`

按一段文字描述设计一个原本不存在的声音，用它念一段试听文本。不要参考音频。

```js
await env.capabilities['voice-design']({
  text,                  // string，必填：试听文本，用设计出来的声音念
  voice_prompt,          // string，必填：用文字描述想要的声音（性别、年龄、音高、口音、音色、语气……），不用某个模型的指令语法
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
  text,                  // string，必填：整段对白。每个说话人的台词前面写他的编号 {N}，N 从 0 起（见下）
  speakers,              // 数组，必填，2 到 16 项：第 N 项是说话人 N 的参考，形如 { ref_audio, ref_text }（见下）
  expressiveness,        // number，必填：0 到 1，演得多重（数越大，演得越重）
  seed,                  // integer，可选：0 到 2^53−1。同一个种子加同样的输入，尽量出同样的结果
})
// -> { bytes: Uint8Array, mimeType: string, model?: string }
```

- `speakers[N]` 的 `ref_audio` 是 `{bytes, mimeType}`（通用约定：不收 URL）；`ref_text` 是那段参考录音的逐字文本，可选，给了就随参考一起交给环境。
- **说话人标记**：`{N}` 写在一个说话人的台词前，之后的字归他，直到下一个标记。N 写成规范的数字（不带前导零），且小于 `speakers` 的项数。文字里一个标记都没有，或者编号越界，抛 `VoicePackError('capability_input_invalid', 原话, { details: { capability, field: 'text', problem, textRejected: true } })`，`problem` 是 `no_speaker_marker` 或 `speaker_out_of_range`：只和这一句的文字有关，换一句可能就成。标记以外的字（方括号、圆括号里的字，环境自己认的标记）原样交给环境。
- `speakers` 不到 2 项，或超过环境的上限（参考的段数上限由适配器写在它的对照表里），抛 `capability_input_invalid`，`details.field` 是 `speakers`，`problem` 是 `too_few` 或 `too_many`，没有调用。
- `expressiveness` 不是有限的数，或者不在 0 到 1 之间，抛 `capability_input_invalid`（`field` 是 `expressiveness`；越界时 `problem` 是 `out_of_range`）；`seed` 同理（`field` 是 `seed`）。`text` 是空白的，同样抛 `capability_input_invalid`（`field` 是 `text`，`textRejected` 为 true）。这些都是对每一句都一样的或调用方的事，不标 `transient`。
- 没有 `instructions`、`cues`、`continues`、语速、音色、语种这些参数：这一项能力不收，传了就忽略。要单人说话，用 `voice-cloning`。
- 返回的是整段对白合成出来的一段音频。文字和参考录音的长度这里不限制，平台怎么处理就怎么回，报错按下一条原样往上传。
- 上游报错按「通用约定」原样往上传（暂时出错标 `transient`；拒绝了这次输入的不标）。
- 名字取业内对这类能力的通用叫法。

## 听

### `audio-text-to-text`

听一段或几段音频，按文字指令回答。盲听、给声音打标签都用它。

```js
await env.capabilities['audio-text-to-text']({
  parts,                 // Array<{ text: string } | { audio: {bytes, mimeType} }>，必填：按顺序交替的文字和音频
})
// -> { text: string, model?: string }
```

- `parts` 按顺序拼成一次请求：文字是给模型的说明，音频就是它要听的那几段。两段音频就按它们在 `parts` 里的先后当作 X、Y，**不另外传角色标记**（`{ audio }` 那项只放音频）。
- `text` 是模型的回答原文，库自己解析（盲听要求回答是一个 JSON 对象，见 `lib/fidelity.mjs` 的 `parseBlindAnswer`）。
- 不给温度、最大长度之类的参数：用环境自己的默认值，同一段音频答得稳一点更好。
- 暂时出错（连不上、HTTP 5xx、网关超时、网络错误）按「通用约定」标 `details.transient: true`；服务明确报的错不标。适配器只管标对，不自己重试；重试由库做，**只有打标签那种用法**（一次一段音频，`lib/segment-tags.mjs`）：做包时每段最多问 3 次，暂时出错才再来，两次之前各等 5 秒、15 秒，3 次都没成这一段才记成「没听成」，不打标签（规则只在 `../lib/call-attempts.mjs` 写一份，命令行和 app 共用；「确认费用」里写明最多多听几次）。盲听（两段音频）出错不重试，记成「没听成」，事后补做（`lib/fidelity.mjs`）。补全可能已经计费，失败的补全收不收费没有量过：写费用的调用方按最多的次数写，用户同意的是上限；换一个会为失败的补全收费的服务，要在适配器说明里写明。
- **服务商拦下了回答**（服务商用内容过滤把这次回答截断或换掉，回答的位置上是服务商自己的一句说明，不是模型的回答）：抛 `VoicePackError('provider_blocked', 给人看的一句话, { details: { capability: 'audio-text-to-text', provider, reply, model? } })`，`provider` 是服务商的名字（小写），`reply` 是回答里服务商那句说明的前 300 个字符。这是适配器的事：认的是服务商的原话，哪家服务商说了什么只写在适配器里，换了服务商就在那里加它的说法；不要把这句说明当成回答的 `text` 交给库，库会把它当成「不是 JSON」。不标 `transient`：同一段录音再问还是被拦，不是「服务暂时出错」，不要标成能重来。给人看的那一句话建议写成「模型的服务商拦下了这一段的回答（多半因为台词是现成的文章），这一段不算数」，报告和命令行直接用它。库（`lib/fidelity.mjs`、`lib/segment-tags.mjs`）**只认 `provider_blocked` 这个 code**：盲听那一条、打标签那一段记成「作废」（不记成「没听成」，补做也不会重做它），另外数有几条是被拦下的（`blocked`），写明是被拦下而不是「回答不是固定格式」，不进任何比例（读法第 5 点）。别的写法（能力自己起的码）库不认，照常往上抛。

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
- `language`（参数）：**调用方知道录音的语言就带上**，库在这几处带：做包页的「录音的语言」（`makePack` 的 `input.labels.language`，片段自己的 `labels.language` 盖过它）、`prepareLongRecording` 的 `language` 选项。不知道就不带，环境自己听。只看主语言：`zh-CN`、`zh_TW`、`ZH` 都是 `zh`；`und`（BCP 47 的「未定」）等于不知道，和不带一样。
- **环境认不了这种语言，就报错，不能把乱的文字交回来**，也不能忽略 `language`、拿别的语言去识别：抛 `VoicePackError('capability_input_invalid', 原话, { details: { capability: 'automatic-speech-recognition', field: 'language', problem: 'unsupported', language } })`，`language` 是调用方带来的那个标签（原样，去掉两头的空白）；环境愿意的话可以再多带 `supported`：它认的语言（数组），给人看，也让调用方改选别的环境。这是调用方和环境之间的事，不是服务出了问题：不标 `transient`，再问一次还是一样；并且要抛在一切花钱、花时间的事（连服务、取令牌、转格式）之前。库不吞这个错（不是服务暂时出错），做包会以它停下：该用哪个环境的转写，由调用方（app 的环境）事先定，见各环境自己的说明。`language` 不是非空字符串（数字、空串）也是 `capability_input_invalid`，`field` 是 `language`，没有 `problem`。
- `language`（返回）可选：环境报得出语言就报（BCP 47，例如 `en`、`zh`），报不出就不带，库当作不知道、从文字本身认。
- 一次转写一段：长录音先切段（`../tools/silence-split.mjs`），不要把几十分钟的录音整段交进来。单次最长多少，写在各适配器自己的说明里。
- 返回里**没有时间戳**：切段不靠转写的时间戳。所以长录音靠 `../tools/silence-split.mjs` 按能量切（没有 `voice-activity-detection` 的环境），切好以后逐段转写，文字就对得上每一段。
- 音频格式环境自己负责：能直接收的就收，收不了的自己转（例如只收 16 kHz、单声道、16 位的 WAV 的服务，别的格式用环境的 `ffmpeg` 运行时转，环境没有 ffmpeg 就抛 `runtime_missing`）。
- 凭据被拒（401）怎么办，见 `../adapters/README.md`「出错的约定」。
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

按文字提示生成文字（大语言模型）。按台词挑参考时让它判断每句的情绪、风格（`lib/reference-pick.mjs`）；润色、翻译、写配音指引也用它。

```js
await env.capabilities['text-generation']({
  prompt,                // string，必填：给模型的文字提示（非空）
})
// -> { text: string, model?: string }
```

- `text` 是模型的回答原文，库自己解析：按台词挑参考要求回答是一个 JSON 数组，读不出来就不采纳、不猜（`judge.status` 是 `unusable`）。
- 环境没有这项能力时，按台词挑参考不判断，用默认参考；这不是错误。
- 回答不能用（没有文字，或者没有正常结束）：抛 `capability_result_invalid`，`details.capability` 写 `text-generation`，`details.problem` 写是哪一种（`text_missing`、`stop_reason`）。库把那几句落到默认参考（`judge.status` 是 `unusable`，它们的 `picks[i].judgeFailed` 为 true），配音接着做。别的错（401、输入不对、服务暂时出错）照旧往上抛。

## 怎么念

### `style-instruction`

不是函数，是**声明**：环境提供它，表示合成能力（`text-to-speech`、`voice-cloning`）会按 `instructions` 里的自然语言说明调整语气、节奏、情绪。在 `env.capabilities['style-instruction']` 里放 `true`（或任何不是 `undefined`、`null`、`false` 的值）。

- 库用 `hasCapability(env, 'style-instruction')` 问：有，配音就把配音指引（和这一句的舞台提示）通过 `instructions` 传给合成能力；没有，**整个不传 `instructions`** 这个键，照常合成，并在返回值里说明没传和原因（`unit.instructions.reason` 是 `style_instruction_missing`）。
- 为什么用声明而不是看合成能力「收不收」`instructions`：合成能力的签名里 `instructions` 一直是可选的，没有 `style-instruction` 的环境会忽略它；这样「传了没效果」和「没传」分得开。
- 不声明的理由写成「模型或服务做不到」，不要写成「我们的请求里没有 `instructions` 字段」：后者是适配器自己的构造，读的人会当成环境的结论（分工见 `../adapters/README.md`「只是声明的能力」）。

### `style-cues`

不是函数，是**声明**：环境提供它，表示合成能力（`text-to-speech`、`voice-cloning`）收参数 `cues`：这一句自己的几个名字（舞台提示认出来的，加调用方在 `labels` 里给的情绪和风格）。在 `env.capabilities['style-cues']` 里放 `true`（或任何不是 `undefined`、`null`、`false` 的值）。

- `cues` 的形状是 `{ emotion, style }`：`emotion`、`style` 是 `vocab/cues.json` 里 `emotion`、`style` 的规范名字，没有就是 `null`。环境收到别的键（例如旧版本的 `actions`）忽略：不出标签，也不报错。
- 库用 `hasCapability(env, 'style-cues')` 问：有，配音就把这一句的 `cues` 通过参数传给合成能力；没有，**整个不传 `cues`** 这个键，照常合成，并在 `unit.cues.reason` 里说明（`style_cues_missing`）。
- 这一句的 `emotion`、`style`：调用方在 `labels` 里给这一项的（规范化以后认得出的才用）先用，和挑参考一样；没给的，取读这一句的舞台提示时的状态（最后一个有情绪或风格的提示起，和 `lib/line-hints.mjs` 的读法一样）。语速和停顿不进 `cues`，见下面一条。
- **配音指引永远不进 `cues`。** 指引写的是这个声音的习惯（爱笑、说话慢），不是这一句的指示。它只通过 `style-instruction` 的 `instructions` 传，而且只在环境声明了它的时候才传。
- 一句被切成几段（`maxChars`）时，`emotion`、`style` 每段都带，除了 `vocab/cues.json` 的 `oneShot` 标着的一下子的声音（笑、叹气）：它只在第一段带。
- **语速和停顿不在 `cues` 里。** 它们是 `unit.speed`、`unit.pauseBeforeMs`、`unit.pauseAfterMs`（和 `unit.join`），由拼接的人按它们做一次（见 `lib/dub.mjs` 文件头「语速和停顿」）。语速只有一条路：合成能力不收语速，环境也不把它译成标签或变速；不论环境声明不声明 `style-cues`，都一样。
- `style-instruction` 和 `style-cues` 是两回事：前者是一段**自由的文字**（配音指引加这一句的说明，原样交给环境，由环境去理解）；后者是**这一句认出来的几个名字**（库已经读过、规范化过，环境只需要对表）。一个环境可以两个都声明，也可以只声明一个。不声明的理由写成「模型或服务做不到」，不要写成「我们的请求里没有 `cues` 字段」（同 `style-instruction`，分工见 `../adapters/README.md`「只是声明的能力」）。

### `pause-in-text`

不是函数，是**声明**：环境提供它，表示合成能力（`voice-cloning`）认文字里的停顿：一次请求里的停顿写成 `<speak>…</speak>` 包着的 `<break time="Nms"/>`（文字里的 `& < >` 转义），或者只靠标点。在 `env.capabilities['pause-in-text']` 里放 `true`。

- 库用 `hasCapability(env, 'pause-in-text')` 问：有，配音就把段落里不超过 2.5 秒的停顿并进一次请求（`lib/pause-in-request.mjs`，`lib/dub.mjs` 的第 5c 步）；没有，每个停顿照旧切成两次请求，文字里没有 `<speak>`。
- 名字（`cues` 译成的行内标签，例如 `[laughing]`）放在 `<speak>` 的根里面、要念的文字前面，不放在它外面。
- 字数下限（`padToMinLength`）按说出来的字数数，补的字在 `</speak>` 前面；续接的段（`continues`）补「，」（`padCharOf`）。两处都在适配器的 `limits.mjs`。
- 配音怎么拼接（停顿、续接、并起来的段）只在 `references/dub.md` 的「拼接」写一次。

### `phoneme-in-text`

不是函数，是**声明**：环境提供它，表示它的合成能力（例如 `voice-cloning`，以及没有参考音频的朗读）认文字里的音素：`<speak>…</speak>` 包着的 `<phoneme alphabet="x-pinyin" ph="zeng1">曾</phoneme>`，按 `ph` 念，标签本身不念。在 `env.capabilities['phoneme-in-text']` 里放 `true`。

- 库用 `hasCapability(env, 'phoneme-in-text')` 问：有，读音词表里的拼音音素（`lexicon.pls` 的 `<phoneme>`，字母表是 `x-pinyin`，写法见 `references/make-pack.md`「读音词表」）才写进要说的话里；没有，它照旧报在 `lexicon.unapplied`（`reason` 是 `phoneme`），文字里没有它。
- 字母表名：包里统一写 `x-pinyin`（PLS 第 2 节：非 `ipa` 的字母表必须是 `x-` 开头的自定义名）。适配器把它译成自己服务的写法，并在它的说明里写明认哪个字母表名；不认的字母表不译，由库报在 `unapplied`。
- `ph` 是拼音加数字声调（`zeng1`，声调 1 到 5，5 是轻声）：每个汉字一个音节，用空格分开，个数和汉字数相等；声明了的环境里，词条不全是汉字的、对不上的不写，报 `unapplied`（`reason` 是 `phoneme_format`，`problem` 写明是 `term`、`count` 还是 `form`）。
- 和 `pause-in-text` 共用一层 `<speak>`：一句里既有停顿又有音素，只包一层（`lib/pause-in-request.mjs` 的 `renderRun`）。
- 没有声明的环境，和现在一样：音素不用，报在 `unapplied`（`reason` 是 `phoneme`）。

## 变声和唱歌

### `voice-conversion`、`singing-voice-conversion`

把一段音频换成另一个声音，内容、节奏（唱歌是旋律和歌词）不变。前者用于说话，后者用于歌声（输入应当是人声分轨，没有伴奏）。

```js
await env.capabilities['voice-conversion']({        // singing-voice-conversion 的签名相同
  audio,                 // {bytes, mimeType}，必填：要换声音的那段
  ref_audio,             // {bytes, mimeType}，必填：目标声音的参考（包里挑出来的一段）
  ref_text,              // string，可选：参考音频的逐字文本，用不上的环境可以忽略
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
