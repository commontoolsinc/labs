import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { _internal, loadViewInput } from "../lib/view/loadinput.ts";
import { MAX_BINARY_VIEW_BYTES } from "../lib/view/languages/binary/binary.ts";

type LoadFromSource = typeof _internal.loadViewInputFromSource;
type ChunkSource = Parameters<LoadFromSource>[0];
type LoadOptions = Parameters<LoadFromSource>[1];

function loadFromSource(
  source: ChunkSource,
  options: Partial<LoadOptions> = {},
) {
  return _internal.loadViewInputFromSource(source, {
    knownByteLanguage: undefined,
    detectByteLanguage: true,
    interactive: true,
    streamRendered: true,
    ...options,
  });
}

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
  snapshotBytes: number | undefined,
  currentBytes: number | undefined = snapshotBytes,
): ChunkSource {
  return {
    kind: "regular-file",
    chunks: (async function* () {
      for (const value of values) yield value;
    })(),
    snapshotBytes,
    byteCount: () => currentBytes,
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
      () => loadViewInput("unused", undefined, undefined, true),
      Error,
      "stat failed",
    );
    assertEquals(closeCalls, 1);
  } finally {
    (Deno as { open: typeof Deno.open }).open = open;
  }
});

Deno.test("regular file input refreshes its byte count", async () => {
  const open = Deno.open;
  try {
    for (const currentBytes of [MAX_BINARY_VIEW_BYTES - 1, 0]) {
      const bytes = new Uint8Array(MAX_BINARY_VIEW_BYTES + 16);
      bytes[0] = 0;
      let offset = 0;
      let statCalls = 0;
      let closeCalls = 0;
      const file = {
        stat: () =>
          Promise.resolve({
            isFile: true,
            size: statCalls++ === 0 ? bytes.length : currentBytes,
          }),
        read: (target: Uint8Array) => {
          if (offset >= bytes.length) return Promise.resolve(null);
          const length = Math.min(target.length, bytes.length - offset);
          target.set(bytes.subarray(offset, offset + length));
          offset += length;
          return Promise.resolve(length);
        },
        close: () => closeCalls++,
      } as unknown as Deno.FsFile;
      (Deno as { open: typeof Deno.open }).open = () => Promise.resolve(file);

      const input = await loadViewInput("unused", undefined, undefined, true);

      assert(input.kind === "bytes");
      assertEquals(input.extent, {
        byteLength: MAX_BINARY_VIEW_BYTES,
        complete: false,
      });
      assertEquals(statCalls, 2);
      assertEquals(closeCalls, 1);
    }
  } finally {
    (Deno as { open: typeof Deno.open }).open = open;
  }
});

Deno.test("interactive streams discard text retained before binary detection", async () => {
  let disposeCalls = 0;
  const input = await loadFromSource(
    streamSource(
      [new TextEncoder().encode("text"), new Uint8Array([0])],
      () => disposeCalls++,
    ),
  );

  assert(input.kind === "bytes");
  assertEquals(input.language?.id, "binary");
  assertEquals(input.bytes, new Uint8Array([0x74, 0x65, 0x78, 0x74, 0]));
  assertEquals(input.extent, { byteLength: 5, complete: false });
  assertEquals(disposeCalls, 1);
});

Deno.test("interactive streams detect truncated UTF-8 when input ends", async () => {
  const input = await loadFromSource(
    streamSource([new Uint8Array([0xe2])]),
  );

  assert(input.kind === "bytes");
  assertEquals(input.language?.id, "binary");
  assertEquals(input.bytes, new Uint8Array([0xe2]));
  assertEquals(input.extent, { byteLength: 1, complete: true });
});

Deno.test("interactive regular files distinguish stale and complete sizes", async () => {
  const bytes = new Uint8Array(MAX_BINARY_VIEW_BYTES + 16);
  for (const currentBytes of [MAX_BINARY_VIEW_BYTES - 1, bytes.length]) {
    const input = await loadFromSource(
      regularSource([bytes], bytes.length, currentBytes),
    );

    assert(input.kind === "bytes");
    assertEquals(input.language?.id, "binary");
    assertEquals(input.bytes.length, MAX_BINARY_VIEW_BYTES);
    assertEquals(
      input.extent,
      currentBytes < bytes.length
        ? { byteLength: MAX_BINARY_VIEW_BYTES, complete: false }
        : { byteLength: bytes.length, complete: true },
    );
  }
});

Deno.test("noninteractive EOF detection returns a rendered byte stream", async () => {
  const input = await loadFromSource(
    streamSource([new Uint8Array([0xe2])]),
    { interactive: false },
  );

  assert(input.kind === "rendered-stream");
  assertEquals(input.language.id, "binary");
  assertEquals(await collect(input.chunks), new Uint8Array([0xe2]));
});

Deno.test("large text input is restored from its temporary spool", async () => {
  const makeTempFile = Deno.makeTempFile;
  const open = Deno.open;
  const values = [ascii(200 * 1024), ascii(100 * 1024), ascii(16 * 1024)];
  let spoolPath: string | undefined;
  try {
    (Deno as { makeTempFile: typeof Deno.makeTempFile }).makeTempFile = async (
      options,
    ) => {
      spoolPath = await makeTempFile(options);
      return spoolPath;
    };
    (Deno as { open: typeof Deno.open }).open = async (path, options) => {
      const file = await open(path, options);
      if (path !== spoolPath) return file;
      return {
        write: (data: Uint8Array) =>
          file.write(data.subarray(0, Math.min(2, data.length))),
        read: (data: Uint8Array) => file.read(data),
        seek: (offset: number, whence: Deno.SeekMode) =>
          file.seek(offset, whence),
        close: () => file.close(),
      } as unknown as Deno.FsFile;
    };

    const input = await loadFromSource(
      streamSource(values),
      { interactive: false, streamRendered: false },
    );

    assert(input.kind === "bytes");
    assertEquals(input.language, undefined);
    assertEquals(input.bytes.length, 316 * 1024);
    assertEquals(input.bytes[0], 0x41);
    assertEquals(input.bytes.at(-1), 0x41);
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

Deno.test("late binary detection streams the spool and remaining source", async () => {
  const makeTempFile = Deno.makeTempFile;
  const values = [
    ascii(200 * 1024),
    ascii(100 * 1024),
    new Uint8Array([0]),
    new Uint8Array([0x42]),
  ];
  let spoolPath: string | undefined;
  try {
    (Deno as { makeTempFile: typeof Deno.makeTempFile }).makeTempFile = async (
      options,
    ) => {
      spoolPath = await makeTempFile(options);
      return spoolPath;
    };
    const input = await loadFromSource(
      streamSource(values),
      { interactive: false },
    );

    assert(input.kind === "rendered-stream");
    assertEquals(input.language.id, "binary");
    assert(spoolPath !== undefined);
    assertEquals(Deno.statSync(spoolPath).isFile, true);
    const collected = await collect(input.chunks);
    assertEquals(collected.length, 300 * 1024 + 2);
    assertEquals(collected[300 * 1024], 0);
    assertEquals(collected.at(-1), 0x42);
    assertThrows(() => Deno.statSync(spoolPath!), Deno.errors.NotFound);
  } finally {
    (Deno as { makeTempFile: typeof Deno.makeTempFile }).makeTempFile =
      makeTempFile;
    if (spoolPath !== undefined) {
      await removeIfPresent(spoolPath);
    }
  }
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
        loadFromSource(
          streamSource([ascii(MAX_BINARY_VIEW_BYTES + 1)]),
          { interactive: false, streamRendered: false },
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
  const makeTempFile = Deno.makeTempFile;
  const open = Deno.open;
  let closeCalls = 0;
  let spoolPath: string | undefined;
  try {
    (Deno as { makeTempFile: typeof Deno.makeTempFile }).makeTempFile = async (
      options,
    ) => {
      spoolPath = await makeTempFile(options);
      return spoolPath;
    };
    (Deno as { open: typeof Deno.open }).open = (path, options) => {
      if (path !== spoolPath) return open(path, options);
      return Promise.resolve({
        write: (data: Uint8Array) => Promise.resolve(data.length),
        seek: () => Promise.reject(new Error("seek failed")),
        close: () => closeCalls++,
      } as unknown as Deno.FsFile);
    };

    await assertRejects(
      () =>
        loadFromSource(
          streamSource([
            ascii(MAX_BINARY_VIEW_BYTES + 1),
            new Uint8Array([0]),
          ]),
          { interactive: false },
        ),
      Error,
      "seek failed",
    );
    assertEquals(closeCalls, 1);
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

Deno.test("asynchronous spool writes reject a writer that makes no progress", async () => {
  const makeTempFile = Deno.makeTempFile;
  const open = Deno.open;
  let closeCalls = 0;
  let spoolPath: string | undefined;
  try {
    (Deno as { makeTempFile: typeof Deno.makeTempFile }).makeTempFile = async (
      options,
    ) => {
      spoolPath = await makeTempFile(options);
      return spoolPath;
    };
    (Deno as { open: typeof Deno.open }).open = (path, options) => {
      if (path !== spoolPath) return open(path, options);
      return Promise.resolve({
        write: () => Promise.resolve(0),
        close: () => closeCalls++,
      } as unknown as Deno.FsFile);
    };

    await assertRejects(
      () =>
        loadFromSource(
          streamSource([ascii(MAX_BINARY_VIEW_BYTES + 1)]),
          { interactive: false, streamRendered: false },
        ),
      Error,
      "temporary file accepted no bytes",
    );
    assertEquals(closeCalls, 1);
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
