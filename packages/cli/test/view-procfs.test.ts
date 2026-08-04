import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { realFileGateway } from "../lib/view/filegateway.ts";
import { loadViewInput } from "../lib/view/loadinput.ts";

const PROCFS_PATH = "/proc/self/cmdline";

Deno.test({
  name: "binary input: zero-sized virtual files are read through EOF",
  ignore: Deno.build.os !== "linux",
  async fn() {
    assertEquals(Deno.statSync(PROCFS_PATH).size, 0);
    const input = await loadViewInput(
      PROCFS_PATH,
      PROCFS_PATH,
      undefined,
      true,
      false,
    );

    assertEquals(input.kind, "bytes");
    if (input.kind !== "bytes") return;
    assert(input.bytes.length > 0);
    assertEquals(input.language?.id, "binary");
    assertEquals(input.extent, {
      byteLength: input.bytes.length,
      complete: true,
    });
  },
});

Deno.test({
  name: "realFileGateway.open: reads a zero-sized procfs file",
  ignore: Deno.build.os !== "linux",
  fn() {
    assertEquals(Deno.statSync(PROCFS_PATH).size, 0);
    const opened = realFileGateway().open(PROCFS_PATH);
    assert(opened !== null);
    assert(opened.text.length > 0);
    assertEquals(opened.source.editable, false);
    const rendered = opened.source.render?.(
      opened.source.parse(opened.text),
    );
    assert(rendered !== undefined);
    assert(rendered.lines[0].text.startsWith("00000000  "));
    assertEquals(
      rendered.lines.at(-1)?.text.includes("preview stopped"),
      false,
    );
  },
});

Deno.test({
  name: "cf view reads a zero-sized procfs file",
  ignore: Deno.build.os !== "linux",
  async fn() {
    assertEquals(Deno.statSync(PROCFS_PATH).size, 0);
    const result = await new Deno.Command(Deno.execPath(), {
      cwd: join(import.meta.dirname!, ".."),
      args: [
        "run",
        "--allow-all",
        "./mod.ts",
        "view",
        "--plain",
        "--color",
        "never",
        PROCFS_PATH,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();

    const decoder = new TextDecoder();
    assertEquals(result.code, 0, decoder.decode(result.stderr));
    const stdout = decoder.decode(result.stdout).split("\n").filter(Boolean);
    assert(stdout[0].startsWith("00000000  "), stdout.join("\n"));
    assertEquals(stdout.at(-1) === "00000000", false);
  },
});
