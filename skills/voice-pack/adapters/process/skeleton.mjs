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
      ...commented('    # ', [`${capability.name}: ${capability.doc[0] ?? ''}`, ...capability.doc.slice(1)]),
      `    raise NotImplementedError("${capability.name} is not implemented")`,
      '',
      '',
    );
  }
  const table = callable.length === 0 ? ['HANDLERS = {}'] : ['HANDLERS = {', ...callable.map((capability) => `    "${capability.name}": ${functionName(capability.name)},`), '}'];
  const lines = [
    ...commented('# ', header),
    `# Fill in: load the model in load_models(), and in each capability replace the line that raises NotImplementedError(…) with a real call; the comment above each capability is generated from vocab/capability-signatures.md and lists its parameters and return value.`,
    '# The process protocol (messages, fields, errors, how the program is shut down) is written only in adapters/process/README.md of the base part; this file only implements it.',
    'import base64',
    'import json',
    'import sys',
    'import traceback',
    '',
    'PROTOCOL = 1',
    '',
    '# Standard output is for the process protocol only: a print in a model library would break the protocol, so keep the real standard output first, then point sys.stdout at standard error.',
    '# Logs go to standard error: when the program fails, the whole of it is passed on to the user.',
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
    '    """Bytes -> audio in the process protocol { bytes: Base64, mimeType }."""',
    '    return {"bytes": base64.b64encode(data).decode("ascii"), "mimeType": mime_type}',
    '',
    '',
    'def clip_bytes(value):',
    '    """Audio in the process protocol { bytes: Base64, mimeType } -> bytes."""',
    '    return base64.b64decode(value["bytes"])',
    '',
    '',
    'def load_models():',
    '    # Load the model here. Slow is fine: ready is only sent after loading finishes, and how long to wait is set by the startTimeout option of the adapter (default 300 seconds).',
    '    pass',
    '',
    '',
    '# One function per capability: params is a dict, and its fields are the ones in the call form in the comment above each capability; audio is { "bytes": Base64, "mimeType": ... }, read with clip_bytes() and written with clip().',
    '# Return a dict whose fields follow what comes after "->" in the comment above each capability. The call form in those comments is written in JavaScript; it is only for seeing which fields exist and what shape is returned.',
    ...handlers,
    ...table,
    `# Capabilities that are only declared: no function needed, just list them in ready${declared.length === 0 ? ' (none this time)' : ''}`,
    `DECLARED = [${declared.map((capability) => `"${capability.name}"`).join(', ')}]`,
    '',
    '',
    'def handle(request):',
    '    request_id = request.get("id")',
    '    capability = request.get("capability")',
    '    details = {"capability": capability}',
    '    handler = HANDLERS.get(capability)',
    '    if handler is None:',
    '        message = "This program does not have the capability " + str(capability)',
    '        send_error(request_id, "capability_unsupported", message, details)',
    '        return',
    '    try:',
    '        result = handler(request.get("params") or {})',
    '        send({"id": request_id, "ok": True, "result": result})',
    '    except NotImplementedError as error:',
    `        send_error(request_id, "${notImplemented}", str(error), details)`,
    '    except Exception as error:  # noqa: BLE001',
    '        # Catching every exception on purpose: a failure in any capability becomes an error response and the program does not crash; the stack trace goes to standard error and is shown to the user when something fails',
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
    `// This file usually needs no change: it hands capability calls to ${PYTHON_FILE} in the same directory (through the official process adapter; the process protocol, options and errors are written only in adapters/process/README.md of the base part).`,
    `// Fill in: open ${PYTHON_FILE}. Arguments given on the command line with --adapter-option key=value (for example timeout=600) are passed unchanged to the process adapter.`,
    '// Interpreter: whatever the environment variable PYTHON points to is used (for example the python of a virtual environment); without it, python (Windows) or python3; you can also change command below directly.',
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
    fillIn: `Needs Python 3 on this machine. Open ${PYTHON_FILE}: load the model in load_models() and replace the line that raises NotImplementedError(…) in each capability with a real call (the parameters and return value are in the comment above each capability); ${ADAPTER_FILE} usually needs no change`,
  };
}
