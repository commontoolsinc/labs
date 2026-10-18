/**
 * Browser harness for the memory compression envelope's stream lifetime.
 *
 * It runs one of several variants of the compression work many times and then
 * idles so an external tool can count the live `ReadableStream` objects in the
 * engine: `heap -s <WebContent pid>` for WebKit, a Chrome DevTools Protocol
 * `Runtime.queryObjects` for Chromium. The "module" variants call the real
 * exports of `message-compression.ts`; the others isolate one expression each
 * so the leaking one can be named. The script works both as a module Worker
 * and as a module imported by the page, selected by `index.html`.
 */

import {
  decodeCompressedMemoryMessage,
  encodeCompressedMemoryMessage,
} from "../../v2/message-compression.ts";

/** One run request from the page. */
export type HarnessRequest = {
  mode: HarnessMode;
  iterations: number;
  payloadBytes: number;
  /** Megabytes of garbage to allocate after the loop, to provoke collections. */
  pressureMegabytes: number;
  /** Echo WebSocket URL for the `ws-*` modes. */
  echoUrl: string;
  /** URL returning `payloadBytes` of body for the `fetch-*` modes. */
  bytesUrl: string;
  /** URL streaming a few delayed chunks, the shape of a streamed LLM reply. */
  slowUrl: string;
};

/** Progress and completion reports from a run. */
export type HarnessReport =
  | { type: "progress"; completed: number }
  | {
    type: "done";
    mode: HarnessMode;
    iterations: number;
    elapsedMs: number;
    /** Whether a full collection ran through `$vm.gc()` after the loop. */
    collected: boolean;
  }
  | { type: "error"; message: string };

/** Variants the harness can run. */
export const HARNESS_MODES = [
  "module-roundtrip",
  "module-roundtrip-concurrent",
  "module-roundtrip-sizes",
  "module-encode",
  "module-decode",
  "module-decode-blob",
  "ws-roundtrip-arraybuffer",
  "ws-roundtrip-blob",
  "fetch-arraybuffer",
  "fetch-body-collect",
  "fetch-body-collect-release",
  "fetch-body-collect-cancel",
  "fetch-body-pipe-collect",
  "fetch-body-for-await",
  "fetch-gzip-body-pipe-collect",
  "fetch-slow-body-collect",
  "fetch-slow-text",
  "response-body-drop",
  "response-empty-body-collect",
  "response-pipe-noread",
  "response-body-collect",
  "response-pipe-collect",
  "response-pipe-collect-release",
  "response-pipe-collect-cancel",
  "response-pipe-arraybuffer",
  "response-arraybuffer-direct",
  "blob-pipe-collect",
  "js-source-collect",
  "js-source-pipe-collect",
  "writer-collect",
  "idle",
] as const;

/** One variant name. */
export type HarnessMode = (typeof HARNESS_MODES)[number];

const TEXT_ENCODER = new TextEncoder();

/** Builds a compressible memory-like text payload of about `bytes` UTF-8. */
export function buildPayload(bytes: number): string {
  const words = ["fvj1:", "session", "effect", "cell", "patch", "value"];
  const parts: string[] = [];
  let length = 0;
  let seed = 7;
  while (length < bytes) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const part = `${words[seed % words.length]}${seed % 977},`;
    parts.push(part);
    length += part.length;
  }
  return parts.join("");
}

/** Runs `request`, reporting progress through `report`. */
export async function runHarness(
  request: HarnessRequest,
  report: (report: HarnessReport) => void,
): Promise<void> {
  const payload = buildPayload(request.payloadBytes);
  const bytes = TEXT_ENCODER.encode(payload);
  const encoded = await encodeCompressedMemoryMessage(payload);
  if (!(encoded instanceof Uint8Array)) {
    throw new Error("Payload did not compress into an envelope");
  }
  const step = await selectStep(request, payload, bytes, encoded);
  const start = performance.now();
  for (let completed = 0; completed < request.iterations; completed++) {
    await step();
    if ((completed + 1) % 100 === 0) {
      report({ type: "progress", completed: completed + 1 });
    }
  }
  const elapsedMs = performance.now() - start;
  allocatePressure(request.pressureMegabytes);
  report({
    type: "done",
    mode: request.mode,
    iterations: request.iterations,
    elapsedMs,
    collected: collectGarbage(),
  });
}

/**
 * Runs a full collection when the engine exposes one: JavaScriptCore's `$vm`
 * (a WebContent process started with `JSC_useDollarVM=1`) or V8's `gc`
 * (Chromium started with `--js-flags=--expose-gc`).
 */
function collectGarbage(): boolean {
  const scope = globalThis as {
    $vm?: { gc(): void };
    gc?: () => void;
  };
  if (scope.$vm) {
    scope.$vm.gc();
    return true;
  }
  if (scope.gc) {
    scope.gc();
    return true;
  }
  return false;
}

/**
 * Allocates `megabytes` of buffers, holds them so the heap grows past the
 * engine's full-collection threshold, then drops them. Buffer memory counts
 * as extra memory in JavaScriptCore, which is what makes the collector run
 * full collections rather than eden ones.
 */
function allocatePressure(megabytes: number): void {
  const held: ArrayBuffer[] = [];
  for (let allocated = 0; allocated < megabytes; allocated++) {
    held.push(new ArrayBuffer(1_024 * 1_024));
    if (held.length === 64) held.length = 0;
  }
  if (held.length < 0) throw new Error("unreachable");
}

/** Returns the per-iteration body of `request.mode`. */
async function selectStep(
  request: HarnessRequest,
  payload: string,
  bytes: Uint8Array<ArrayBuffer>,
  encoded: Uint8Array<ArrayBuffer>,
): Promise<() => Promise<void>> {
  const gzip = () => new CompressionStream("gzip");
  switch (request.mode) {
    case "module-roundtrip":
      return async () => {
        const frame = await encodeCompressedMemoryMessage(payload);
        await decodeCompressedMemoryMessage(frame);
      };
    case "module-roundtrip-concurrent":
      return async () => {
        await Promise.all(Array.from({ length: 20 }, async () => {
          const frame = await encodeCompressedMemoryMessage(payload);
          await decodeCompressedMemoryMessage(frame);
        }));
      };
    case "module-roundtrip-sizes": {
      const payloads = [
        1_100,
        4_000,
        16_000,
        64_000,
        256_000,
        1_000_000,
        4_000_000,
      ]
        .map(buildPayload);
      let turn = 0;
      return async () => {
        const frame = await encodeCompressedMemoryMessage(
          payloads[turn++ % payloads.length],
        );
        await decodeCompressedMemoryMessage(frame);
      };
    }
    case "module-encode":
      return async () => {
        await encodeCompressedMemoryMessage(payload);
      };
    case "module-decode":
      return async () => {
        await decodeCompressedMemoryMessage(encoded);
      };
    case "module-decode-blob":
      return async () => {
        await decodeCompressedMemoryMessage(new Blob([encoded]));
      };
    case "ws-roundtrip-arraybuffer":
    case "ws-roundtrip-blob": {
      const socket = await openEcho(
        request.echoUrl,
        request.mode === "ws-roundtrip-blob" ? "blob" : "arraybuffer",
      );
      return async () => {
        const frame = await encodeCompressedMemoryMessage(payload);
        const echoed = new Promise<MessageEvent>((resolve) => {
          socket.addEventListener("message", resolve, { once: true });
        });
        socket.send(frame);
        const message = await echoed;
        await decodeCompressedMemoryMessage(message.data);
      };
    }
    case "fetch-arraybuffer":
      return async () => {
        await (await fetch(request.bytesUrl)).arrayBuffer();
      };
    case "fetch-body-collect":
      return async () => {
        await collectReadable((await fetch(request.bytesUrl)).body!);
      };
    case "fetch-body-collect-release":
      return async () => {
        await collectReadable((await fetch(request.bytesUrl)).body!, "release");
      };
    case "fetch-body-collect-cancel":
      return async () => {
        await collectReadable((await fetch(request.bytesUrl)).body!, "cancel");
      };
    case "fetch-body-pipe-collect":
      return async () => {
        await collectReadable(
          (await fetch(request.bytesUrl)).body!.pipeThrough(gzip()),
        );
      };
    case "fetch-body-for-await":
      return async () => {
        for await (const chunk of (await fetch(request.bytesUrl)).body!) {
          void chunk;
        }
      };
    case "fetch-gzip-body-pipe-collect":
      return async () => {
        await collectReadable(
          (await fetch(`${request.bytesUrl}&gzip=1`)).body!.pipeThrough(
            new DecompressionStream("gzip"),
          ),
        );
      };
    case "fetch-slow-body-collect":
      return async () => {
        await collectReadable((await fetch(request.slowUrl)).body!);
      };
    case "fetch-slow-text":
      return async () => {
        await (await fetch(request.slowUrl)).text();
      };
    case "response-body-drop":
      return () => {
        void new Response(bytes).body;
        return Promise.resolve();
      };
    case "response-empty-body-collect":
      return async () => {
        await collectReadable(new Response(new Uint8Array(0)).body!);
      };
    case "response-pipe-noread":
      return () => {
        void new Response(bytes).body!.pipeThrough(gzip());
        return Promise.resolve();
      };
    case "response-body-collect":
      return async () => {
        await collectReadable(new Response(bytes).body!);
      };
    case "response-pipe-collect":
      return async () => {
        await collectReadable(new Response(bytes).body!.pipeThrough(gzip()));
      };
    case "response-pipe-collect-release":
      return async () => {
        await collectReadable(
          new Response(bytes).body!.pipeThrough(gzip()),
          "release",
        );
      };
    case "response-pipe-collect-cancel":
      return async () => {
        await collectReadable(
          new Response(bytes).body!.pipeThrough(gzip()),
          "cancel",
        );
      };
    case "response-pipe-arraybuffer":
      return async () => {
        await new Response(new Response(bytes).body!.pipeThrough(gzip()))
          .arrayBuffer();
      };
    case "response-arraybuffer-direct":
      return async () => {
        await new Response(bytes).arrayBuffer();
      };
    case "blob-pipe-collect":
      return async () => {
        await collectReadable(new Blob([bytes]).stream().pipeThrough(gzip()));
      };
    case "js-source-collect":
      return async () => {
        await collectReadable(singleChunkStream(bytes));
      };
    case "js-source-pipe-collect":
      return async () => {
        await collectReadable(singleChunkStream(bytes).pipeThrough(gzip()));
      };
    case "writer-collect":
      return async () => {
        const stream = gzip();
        const writer = stream.writable.getWriter();
        const written = writer.write(bytes).then(() => writer.close());
        await collectReadable(stream.readable);
        await written;
      };
    case "idle":
      return () => Promise.resolve();
  }
}

/** A stream yielding `bytes` as one chunk from a JavaScript source. */
function singleChunkStream(
  bytes: Uint8Array<ArrayBuffer>,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Opens an echo WebSocket delivering binary frames as `binaryType`. */
function openEcho(url: string, binaryType: BinaryType): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = binaryType;
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("echo failed")), {
      once: true,
    });
  });
}

/**
 * Collects `readable` the way `message-compression.ts` does, optionally
 * releasing the reader or cancelling the stream once it reports completion.
 */
async function collectReadable(
  readable: ReadableStream<Uint8Array>,
  after: "release" | "cancel" | "none" = "none",
): Promise<Uint8Array> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks.push(value);
  }
  if (after === "release") reader.releaseLock();
  if (after === "cancel") {
    reader.releaseLock();
    await readable.cancel();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** The worker global, when this module runs as a dedicated worker. */
const workerScope = (globalThis as {
  DedicatedWorkerGlobalScope?: abstract new () => unknown;
}).DedicatedWorkerGlobalScope;
if (workerScope && globalThis instanceof workerScope) {
  const worker = globalThis as unknown as {
    onmessage: ((event: MessageEvent<HarnessRequest>) => void) | null;
    postMessage(message: HarnessReport): void;
  };
  worker.onmessage = (event) => {
    runHarness(event.data, (report) => worker.postMessage(report)).catch(
      (error) => {
        worker.postMessage({ type: "error", message: String(error) });
      },
    );
  };
}
