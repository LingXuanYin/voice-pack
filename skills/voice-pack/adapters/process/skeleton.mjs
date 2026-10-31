// SPDX-License-Identifier: Apache-2.0
//
// 进程适配器的骨架：`node cli.mjs adapter new <目录> --capabilities <能力,…> --kind process` 生成的就是它。纯函数，不碰文件、不起进程，浏览器和 Node 都能跑；
// 命令行层经 cli/adapters.mjs 的 buildSkeleton 找到它（官方适配器目录里有 skeleton.mjs，就多一种骨架，种类名是适配器的名字）。
//
//   generateSkeleton(context) → { files: [{ path, content }], fillIn }
//
// context 的形状只写在 lib/adapter-skeleton.mjs 的文件头（适配器不能 import 流程层，要用的东西都在 context 里）。生成两个文件：
//   program.py    用户的程序：Python 写的，读标准输入、写标准输出，照进程协议说话（进程协议只写在 README.md，本目录）。每项能力一个函数，函数体抛「还没有实现」
//   adapter.mjs  适配器：把能力调用交给同目录的 program.py（经官方的进程适配器，use('process', …)）。命令行上 --adapter-option 给的参数原样交给它
// 两个文件都能直接过结构检查：adapter.mjs 声明了能力名，检查时不起程序。
//
// 这个文件里写的 Python 不用反斜杠（骨架在 JavaScript 里拼，反斜杠容易被吃掉）：要换行靠 print，要引号用双引号。
const NL = String.fromCharCode(10);
const PYTHON_FILE = 'program.py';
const ADAPTER_FILE = 'adapter.mjs';

const commented = (prefix, lines) => lines.map((line) => (line === '' ? prefix.trimEnd() : `${prefix}${line}`));
const functionName = (capability) => capability.replaceAll('-', '_');

function programFile({ capabilities, header, notImplemented }) {
  const callable = capabilities.filter((capability) => !capability.declaration);
  const declared = capabilities.filter((capability) => capability.declaration);
  const handlers = [];
  for (const capability of callable) {
    handlers.push(
      `def ${functionName(capability.name)}(params):`,
      ...commented('    # ', [`${capability.name}：${capability.doc[0] ?? ''}`, ...capability.doc.slice(1)]),
      `    raise NotImplementedError("能力 ${capability.name} 还没有实现")`,
      '',
      '',
    );
  }
  const table = callable.length === 0 ? ['HANDLERS = {}'] : ['HANDLERS = {', ...callable.map((capability) => `    "${capability.name}": ${functionName(capability.name)},`), '}'];
  const lines = [
    ...commented('# ', header),
    `# 填写：在 load_models() 里载入模型，把每项能力里 raise NotImplementedError(…) 的那一行换成真的调用；每项能力上面的注释是从 vocab/capability-signatures.md 生成的，写着参数和返回值。`,
    '# 进程协议（消息、字段、出错、程序怎么被收掉）只写在基础部分的 adapters/process/README.md，这里只实现它。',
    'import base64',
    'import json',
    'import sys',
    'import traceback',
    '',
    'PROTOCOL = 1',
    '',
    '# 标准输出只给进程协议用：模型库里的 print 会弄坏进程协议，所以先留下真的标准输出，再把 sys.stdout 换成标准错误。',
    '# 日志写在标准错误里：程序出了错，最后一段会带给使用者看。',
    'protocol_out = sys.stdout',
    'sys.stdout = sys.stderr',
    '',
    '',
    'def send(message):',
    '    print(json.dumps(message, ensure_ascii=True), file=protocol_out, flush=True)',
    '',
    '',
    'def send_error(request_id, code, message, details):',
    '    error = {"code": code, "message": message, "details": details}',
    '    send({"id": request_id, "ok": False, "error": error})',
    '',
    '',
    'def clip(data, mime_type):',
    '    """字节 -> 进程协议里的音频 { bytes: Base64, mimeType }。"""',
    '    return {"bytes": base64.b64encode(data).decode("ascii"), "mimeType": mime_type}',
    '',
    '',
    'def clip_bytes(value):',
    '    """进程协议里的音频 { bytes: Base64, mimeType } -> 字节。"""',
    '    return base64.b64decode(value["bytes"])',
    '',
    '',
    'def load_models():',
    '    # 在这里载入模型。慢也没关系：载入完才说 ready，等多久由适配器的 startTimeout 选项管（默认 300 秒）。',
    '    pass',
    '',
    '',
    '# 每项能力一个函数：参数 params 是字典，字段就是每项能力上面注释里调用写法的那几个；音频是 { "bytes": Base64, "mimeType": ... }，用 clip_bytes() 读、clip() 写。',
    '# 返回一个字典，字段照每项能力上面注释里「->」后面的写。那些注释里的「调用的样子」是 JavaScript 的写法，只用来看有哪些字段、返回什么形状。',
    ...handlers,
    ...table,
    `# 只是声明的能力：不用写函数，ready 里说有就行${declared.length === 0 ? '（这次没有）' : ''}`,
    `DECLARED = [${declared.map((capability) => `"${capability.name}"`).join(', ')}]`,
    '',
    '',
    'def handle(request):',
    '    request_id = request.get("id")',
    '    capability = request.get("capability")',
    '    details = {"capability": capability}',
    '    handler = HANDLERS.get(capability)',
    '    if handler is None:',
    '        message = "这个程序没有能力 " + str(capability)',
    '        send_error(request_id, "capability_unsupported", message, details)',
    '        return',
    '    try:',
    '        result = handler(request.get("params") or {})',
    '        send({"id": request_id, "ok": True, "result": result})',
    '    except NotImplementedError as error:',
    `        send_error(request_id, "${notImplemented}", str(error), details)`,
    '    except Exception as error:  # noqa: BLE001',
    '        # 有意捕获所有异常：任何一项能力出错，都变成一个 error 回应，程序不崩；栈追踪写在标准错误里，出错时会带给使用者看',
    '        traceback.print_exc()',
    '        details["type"] = type(error).__name__',
    '        message = str(error) or details["type"]',
    '        send_error(request_id, "program_exception", message, details)',
    '',
    '',
    'def main():',
    '    load_models()',
    '    capabilities = list(HANDLERS) + DECLARED',
    '    send({"event": "ready", "protocol": PROTOCOL, "capabilities": capabilities})',
    '    for line in sys.stdin:',
    '        line = line.strip()',
    '        if not line:',
    '            continue',
    '        try:',
    '            request = json.loads(line)',
    '        except ValueError:',
    '            traceback.print_exc()',
    '            continue',
    '        handle(request)',
    '',
    '',
    'if __name__ == "__main__":',
    '    main()',
    '',
  ];
  return lines.join(NL);
}

function adapterFile({ capabilities, header }) {
  const lines = [
    ...commented('// ', header),
    `// 这个文件一般不用改：它把能力调用交给同目录的 ${PYTHON_FILE}（官方的进程适配器；进程协议、选项、出错只写在基础部分的 adapters/process/README.md）。`,
    `// 填写：打开 ${PYTHON_FILE}。命令行上 --adapter-option 键=值 给的参数（例如 timeout=600）原样交给进程适配器。`,
    '// 解释器：环境变量 PYTHON 指到哪个就用哪个（例如虚拟环境里的 python），没有就用 python（Windows）或 python3；也可以直接改下面的 command。',
    'export default ({ use, options }) =>',
    "  use('process', {",
    `    command: [process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), '${PYTHON_FILE}'],`,
    `    capabilities: [${capabilities.map((capability) => `'${capability.name}'`).join(', ')}],`,
    '    ...options,',
    '  });',
    '',
  ];
  return lines.join(NL);
}

export function generateSkeleton(context) {
  return {
    files: [
      { path: ADAPTER_FILE, content: adapterFile(context) },
      { path: PYTHON_FILE, content: programFile(context) },
    ],
    fillIn: `需要本机有 Python 3。打开 ${PYTHON_FILE}：在 load_models() 里载入模型，把每项能力里 raise NotImplementedError(…) 的那一行换成真的调用（参数和返回值写在每项能力上面的注释里）；${ADAPTER_FILE} 一般不用改`,
  };
}
