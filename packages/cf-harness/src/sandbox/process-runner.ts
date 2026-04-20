export interface ProcessRunRequest {
  command: string;
  args: string[];
  cwd?: string;
  stdinText?: string;
  timeoutMs?: number;
}

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProcessRunner {
  run(request: ProcessRunRequest): Promise<ProcessRunResult>;
}

export class ProcessTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(command: string, timeoutMs: number) {
    super(`process timed out after ${timeoutMs}ms: ${command}`);
    this.name = "ProcessTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const readStreamText = async (
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> => {
  if (!stream) {
    return "";
  }
  const buffer = await new Response(stream).arrayBuffer();
  return textDecoder.decode(buffer);
};

export class DenoProcessRunner implements ProcessRunner {
  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    const controller = new AbortController();
    const timeoutId = request.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), request.timeoutMs)
      : undefined;
    try {
      const child = new Deno.Command(request.command, {
        args: request.args,
        cwd: request.cwd,
        stdin: request.stdinText !== undefined ? "piped" : "null",
        stdout: "piped",
        stderr: "piped",
        signal: controller.signal,
      }).spawn();

      const writeInput = async () => {
        if (request.stdinText === undefined || child.stdin === null) {
          return;
        }
        const writer = child.stdin.getWriter();
        try {
          await writer.write(textEncoder.encode(request.stdinText));
        } finally {
          await writer.close();
        }
      };

      const [status, stdout, stderr] = await Promise.all([
        child.status,
        readStreamText(child.stdout),
        readStreamText(child.stderr),
        writeInput(),
      ]);

      return {
        stdout,
        stderr,
        exitCode: status.code,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ProcessTimeoutError(
          [request.command, ...request.args].join(" "),
          request.timeoutMs ?? 0,
        );
      }
      throw error;
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }
}
