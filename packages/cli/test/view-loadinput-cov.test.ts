import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { _internal } from "../lib/view/loadinput.ts";
import { MAX_BINARY_VIEW_BYTES } from "../lib/view/languages/binary/binary.ts";

type ChunkSource = Parameters<typeof _internal.captureInput>[0];

function streamSource(
  values: readonly Uint8Array[],
  onDispose: () => void = () => {},
): ChunkSource {
  return {
    kind: "stream",
    chunks: (async function* () {
      for (const value of values) yield value;
    })(),
    dispose: onDispose,
  };
}

function regularSource(
  values: readonly Uint8Array[],
  reportedBytes: number | undefined,
): ChunkSource {
  return {
    kind: "regular-file",
    chunks: (async function* () {
      for (const value of values) yield value;
    })(),
    snapshotBytes: reportedBytes,
    byteCount: () => reportedBytes,
    dispose: () => {},
  };
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const values: Uint8Array[] = [];
  let length = 0;
  for await (const value of chunks) {
    values.push(value.slice());
    length += value.length;
  }
  const collected = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    collected.set(value, offset);
    offset += value.length;
  }
  return collected;
}

function ascii(length: number): Uint8Array {
  return new Uint8Array(length).fill(0x41);
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

Deno.test("load input closes a file when its initial stat fails", async () => {
  const open = Deno.open;
  let closeCalls = 0;
  const fakeFile = {
    stat: () => Promise.reject(new Error("stat failed")),
    close: () => closeCalls++,
  } as unknown as Deno.FsFile;
  try {
    (Deno as { open: typeof Deno.open }).open = () => Promise.resolve(fakeFile);

    await assertRejects(
      () => _internal.openFileChunkSource("unused"),
      Error,
      "stat failed",
    );
    assertEquals(closeCalls, 1);
  } finally {
    (Deno as { open: typeof Deno.open }).open = open;
  }
});

Deno.test("regular file sources report their current nonzero byte count", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/value.data`;
  try {
    await Deno.writeFile(path, new Uint8Array([1, 2, 3]));
    const file = await Deno.open(path, { read: true });
    const source = _internal.fileChunkSource(file, undefined, true);
    assertEquals(source.kind, "regular-file");
    if (source.kind !== "regular-file") return;

    assertEquals(await source.byteCount(), 3);
    await Deno.truncate(path, 0);
    assertEquals(await source.byteCount(), undefined);
    source.dispose();
    source.dispose();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("interactive streams discard text retained before binary detection", async () => {
  let disposeCalls = 0;
  const input = await _internal.captureInput(
    streamSource(
      [new TextEncoder().encode("text"), new Uint8Array([0])],
      () => disposeCalls++,
    ),
    undefined,
    true,
    true,
    true,
  );

  assert(input.kind === "bytes");
  assertEquals(input.language?.id, "binary");
  assertEquals(input.bytes, new Uint8Array([0x74, 0x65, 0x78, 0x74, 0]));
  assertEquals(input.extent, { byteLength: 5, complete: false });
  assertEquals(disposeCalls, 1);
});

Deno.test("interactive streams detect truncated UTF-8 when input ends", async () => {
  const input = await _internal.captureInput(
    streamSource([new Uint8Array([0xe2])]),
    undefined,
    true,
    true,
    true,
  );

  assert(input.kind === "bytes");
  assertEquals(input.language?.id, "binary");
  assertEquals(input.bytes, new Uint8Array([0xe2]));
  assertEquals(input.extent, { byteLength: 1, complete: true });
});

Deno.test("interactive regular files distinguish stale and complete sizes", async () => {
  const bytes = new Uint8Array(MAX_BINARY_VIEW_BYTES + 16);
  for (const reportedBytes of [MAX_BINARY_VIEW_BYTES - 1, bytes.length]) {
    const input = await _internal.captureInput(
      regularSource([bytes], reportedBytes),
      undefined,
      true,
      true,
      true,
    );

    assert(input.kind === "bytes");
    assertEquals(input.language?.id, "binary");
    assertEquals(input.bytes.length, MAX_BINARY_VIEW_BYTES);
    assertEquals(
      input.extent,
      reportedBytes < bytes.length
        ? { byteLength: MAX_BINARY_VIEW_BYTES, complete: false }
        : { byteLength: bytes.length, complete: true },
    );
  }
});

Deno.test("noninteractive EOF detection returns a rendered byte stream", async () => {
  const input = await _internal.captureInput(
    streamSource([new Uint8Array([0xe2])]),
    undefined,
    true,
    false,
    true,
  );

  assert(input.kind === "rendered-stream");
  assertEquals(input.language.id, "binary");
  assertEquals(await collect(input.chunks), new Uint8Array([0xe2]));
});

Deno.test("large text input is restored from its temporary spool", async () => {
  const values = [ascii(200 * 1024), ascii(100 * 1024), ascii(16 * 1024)];
  const input = await _internal.captureInput(
    streamSource(values),
    undefined,
    true,
    false,
    false,
  );

  assert(input.kind === "bytes");
  assertEquals(input.language, undefined);
  assertEquals(input.bytes.length, 316 * 1024);
  assertEquals(input.bytes[0], 0x41);
  assertEquals(input.bytes.at(-1), 0x41);
});

Deno.test("late binary detection streams the spool and remaining source", async () => {
  const values = [
    ascii(200 * 1024),
    ascii(100 * 1024),
    new Uint8Array([0]),
    new Uint8Array([0x42]),
  ];
  const input = await _internal.captureInput(
    streamSource(values),
    undefined,
    true,
    false,
    true,
  );

  assert(input.kind === "rendered-stream");
  assertEquals(input.language.id, "binary");
  const collected = await collect(input.chunks);
  assertEquals(collected.length, 300 * 1024 + 2);
  assertEquals(collected[300 * 1024], 0);
  assertEquals(collected.at(-1), 0x42);
});

Deno.test("a failed asynchronous spool open removes its temporary file", async () => {
  const makeTempFile = Deno.makeTempFile;
  const open = Deno.open;
  let spoolPath: string | undefined;
  try {
    (Deno as { makeTempFile: typeof Deno.makeTempFile }).makeTempFile = async (
      options,
    ) => {
      spoolPath = await makeTempFile(options);
      return spoolPath;
    };
    (Deno as { open: typeof Deno.open }).open = (path, options) => {
      if (path === spoolPath) {
        return Promise.reject(new Error("spool open failed"));
      }
      return open(path, options);
    };

    await assertRejects(
      () =>
        _internal.captureInput(
          streamSource([ascii(MAX_BINARY_VIEW_BYTES + 1)]),
          undefined,
          true,
          false,
          false,
        ),
      Error,
      "spool open failed",
    );
    assert(spoolPath !== undefined);
    assertThrows(() => Deno.statSync(spoolPath!), Deno.errors.NotFound);
  } finally {
    (Deno as { makeTempFile: typeof Deno.makeTempFile }).makeTempFile =
      makeTempFile;
    (Deno as { open: typeof Deno.open }).open = open;
    if (spoolPath !== undefined) {
      await removeIfPresent(spoolPath);
    }
  }
});

Deno.test("a failed spool rewind closes and removes the spool", async () => {
  const open = Deno.open;
  let closeCalls = 0;
  try {
    (Deno as { open: typeof Deno.open }).open = () =>
      Promise.resolve({
        write: (data: Uint8Array) => Promise.resolve(data.length),
        seek: () => Promise.reject(new Error("seek failed")),
        close: () => closeCalls++,
      } as unknown as Deno.FsFile);

    await assertRejects(
      () =>
        _internal.captureInput(
          streamSource([
            ascii(MAX_BINARY_VIEW_BYTES + 1),
            new Uint8Array([0]),
          ]),
          undefined,
          true,
          false,
          true,
        ),
      Error,
      "seek failed",
    );
    assertEquals(closeCalls, 1);
  } finally {
    (Deno as { open: typeof Deno.open }).open = open;
  }
});

Deno.test("asynchronous spool writes handle short writes and reject zero", async () => {
  const written: number[] = [];
  await _internal.writeAll({
    write(data: Uint8Array): Promise<number> {
      const length = Math.min(2, data.length);
      written.push(...data.subarray(0, length));
      return Promise.resolve(length);
    },
  }, new Uint8Array([1, 2, 3, 4, 5]));
  assertEquals(written, [1, 2, 3, 4, 5]);

  await assertRejects(
    () =>
      _internal.writeAll(
        { write: () => Promise.resolve(0) },
        new Uint8Array([1]),
      ),
    Error,
    "temporary file accepted no bytes",
  );
});
