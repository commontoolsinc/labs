import { assert, assertEquals, assertThrows } from "@std/assert";
import { _internal as viewInternals, buildView } from "../lib/view/mod.ts";
import { binaryLanguage } from "../lib/view/languages/binary/language.ts";
import {
  binaryLinesFrom,
  MAX_BINARY_VIEW_BYTES,
  renderBinaryLines,
} from "../lib/view/languages/binary/binary.ts";
import { rawBytesDecoder, utf8Decoder } from "../lib/view/languages/decoder.ts";
import {
  canRenderDiffLines,
  renderedLinesFor,
} from "../lib/view/languages/language.ts";
import { markdownLanguage } from "../lib/view/languages/markdown/language.ts";
import { loadViewInput } from "../lib/view/loadinput.ts";
import { Session } from "../lib/view/session.ts";

Deno.test("language decoders: UTF-8 and raw bytes round-trip their input", () => {
  const text = "const greeting = 'héllo';\n";
  assertEquals(utf8Decoder.decode(utf8Decoder.encode(text)).text, text);
  assertThrows(
    () => utf8Decoder.decode(new Uint8Array([0xff, 0xfe])),
    TypeError,
  );

  const bytes = new Uint8Array([0x00, 0x41, 0x80, 0xff]);
  const decodedRaw = rawBytesDecoder.decode(bytes);
  const raw = decodedRaw.text;
  assertEquals(decodedRaw.hasUtf8Bom, false);
  assertEquals([...raw].map((value) => value.charCodeAt(0)), [...bytes]);
  assertEquals(rawBytesDecoder.encode(raw), bytes);
  assertThrows(() => rawBytesDecoder.encode("λ"), TypeError);

  const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]);
  const decodedBom = utf8Decoder.decode(bom);
  assertEquals(decodedBom.text, "A");
  assertEquals(decodedBom.hasUtf8Bom, true);
  assertEquals(decodedBom.encode(decodedBom.text), bom);
});

Deno.test("binary language: renders canonical hex rows with control pictures", () => {
  const bytes = new Uint8Array([
    0x00,
    0x09,
    0x0a,
    0x0d,
    0x1b,
    0x1f,
    0x20,
    0x41,
    0x7e,
    0x7f,
    0x80,
    0x9f,
    0xa0,
    0xff,
    0x31,
    0x32,
  ]);

  assertEquals(
    renderBinaryLines(rawBytesDecoder.decode(bytes).text).map((line) =>
      line.text
    ),
    [
      "00000000  00 09 0a 0d 1b 1f 20 41  7e 7f 80 9f a0 ff 31 32  |␀␉␊␍␛␟ A~␡␦␦␦␦12|",
      "00000010",
    ],
  );
});

Deno.test("binary language: its independent rendered layout is valid", () => {
  const raw = rawBytesDecoder.decode(new Uint8Array([0x00, 0x0a, 0xff])).text;
  const rendered = renderedLinesFor(binaryLanguage, raw, "payload.data");

  assertEquals(rendered?.length, 2);
  assert(rendered?.[0].text.includes("00 0a ff"));
  assertEquals(rendered?.at(-1)?.text, "00000003");
  assertEquals(canRenderDiffLines(binaryLanguage), false);
  assertEquals(canRenderDiffLines(markdownLanguage), true);
});

Deno.test("binary language: buildView keeps bytes read-only and renders by default", () => {
  const bytes = new Uint8Array([0x61, 0x00, 0x62]);
  const view = buildView(bytes, "payload.data");
  const rendered = view.editSource.render?.(view.doc);

  assertEquals(view.editSource.editable, false);
  assertEquals(view.editSource.defaultViewMode, "rendered");
  assertEquals(view.doc.text.charCodeAt(1), 0);
  assertEquals(view.doc.lines, []);
  assert(rendered?.lines[0].text.endsWith("|a␀b|"));
  assertEquals(rendered?.lines.at(-1)?.text, "00000003");
});

Deno.test("binary language: interactive sessions start in the rendered view", () => {
  const view = buildView(new Uint8Array([0x41, 0x00, 0xff]), "payload.data");
  const session = new Session(
    view.doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 20 },
    undefined,
    view.editSource,
  );

  assert(session.doc.lines[0].text.endsWith("|A␀␦|"));
  assertEquals(session.doc.lines.at(-1)?.text, "00000003");
});

Deno.test("binary language: streams rows across input chunk boundaries", async () => {
  const bytes = Uint8Array.from({ length: 35 }, (_, index) => index);
  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield bytes.subarray(0, 5);
    yield bytes.subarray(5, 19);
    yield bytes.subarray(19);
  }

  const streamed = [];
  for await (const line of binaryLinesFrom(chunks())) streamed.push(line.text);
  assertEquals(
    streamed,
    renderBinaryLines(rawBytesDecoder.decode(bytes).text).map((line) =>
      line.text
    ),
  );
});

Deno.test("binary language: bounds rendered previews and reports omitted bytes", () => {
  const raw = "A".repeat(MAX_BINARY_VIEW_BYTES + 16);
  const lines = renderBinaryLines(raw);

  assertEquals(lines.length, MAX_BINARY_VIEW_BYTES / 16 + 2);
  assert(lines.at(-2)?.text.includes("16 bytes omitted"));
  assert(lines.at(-2)?.text.includes("use --plain"));
  assertEquals(lines.at(-1)?.text, "00040010");
});

Deno.test("binary language: its independent layout cannot toggle to source", () => {
  const view = buildView(new Uint8Array(512).fill(0), "payload.data");
  const session = new Session(
    view.doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 5 },
    undefined,
    view.editSource,
  );
  session.top = 10;
  assertEquals(session.view().canRender, false);

  session.handleKey({ name: "v", char: "v" });

  assertEquals(session.view().viewMode, "rendered");
  assertEquals(session.top, 10);
  assertEquals(
    session.view().message,
    "This rendered view has no line-aligned source view.",
  );
});

Deno.test("binary language: transformed headers cannot override binary detection", () => {
  const header = new TextEncoder().encode("// transformed: module.ts\n");
  const bytes = new Uint8Array(header.length + 2);
  bytes.set(header);
  bytes.set([0x00, 0xff], header.length);

  const view = buildView(bytes);

  assertEquals(view.editSource.defaultViewMode, "rendered");
  assertEquals(view.editSource.editable, false);
  assert(
    view.editSource.render?.(view.doc).lines[0].text.startsWith("00000000"),
  );
});

Deno.test("UTF-8 decoding strips a BOM for parsers and restores it on save", () => {
  const dir = Deno.makeTempDirSync();
  try {
    const path = `${dir}/value.json`;
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(
        '{"value": 1}\n',
      ),
    ]);
    Deno.writeFileSync(path, bytes);

    const view = buildView(bytes, path);
    assertEquals(view.doc.text, '{"value": 1}\n');
    assert(
      view.doc.structure.length > 0,
      "JSON structure sees the first token",
    );
    assertEquals(view.editSource.save('{"value": 2}\n'), "Saved 1 file");
    assertEquals(
      Deno.readFileSync(path),
      new Uint8Array([
        0xef,
        0xbb,
        0xbf,
        ...new TextEncoder().encode(
          '{"value": 2}\n',
        ),
      ]),
    );

    const markdown = buildView(
      new Uint8Array([
        0xef,
        0xbb,
        0xbf,
        ...new TextEncoder().encode("# Heading\n"),
      ]),
      `${dir}/notes.md`,
    );
    assertEquals(markdown.doc.text, "# Heading\n");
    assert(markdown.doc.structure.length > 0, "Markdown sees the heading");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test({
  name: "binary input: zero-sized virtual files are read through EOF",
  ignore: Deno.build.os !== "linux",
  async fn() {
    const path = "/proc/self/cmdline";
    const input = await loadViewInput(path, path, undefined, true, false);

    assertEquals(input.kind, "bytes");
    if (input.kind !== "bytes") return;
    assert(input.bytes.length > 0);
    assertEquals(input.language?.metadata.aliases.includes("binary"), true);
    assertEquals(input.extent, {
      byteLength: input.bytes.length,
      complete: true,
    });
  },
});

Deno.test("redirected output completes short writes", () => {
  const written: number[] = [];
  viewInternals.writeAllSync({
    writeSync(data: Uint8Array): number {
      const count = Math.min(2, data.length);
      written.push(...data.subarray(0, count));
      return count;
    },
  }, new Uint8Array([1, 2, 3, 4, 5]));

  assertEquals(written, [1, 2, 3, 4, 5]);
});
