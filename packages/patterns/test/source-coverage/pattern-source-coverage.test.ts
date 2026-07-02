function sourceCoveragePath(name: string): string {
  return new URL(name, import.meta.url).pathname;
}

Deno.test("pattern source coverage harness exercises changed pattern modules", async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "test",
      "-A",
      "--no-check",
      "--config",
      sourceCoveragePath("../../deno.jsonc"),
      "--import-map",
      sourceCoveragePath("import-map.json"),
      sourceCoveragePath("fixtures/pattern-source-coverage-child.js"),
    ],
    env: { SOURCE_COVERAGE_CHILD: "1" },
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  if (result.success) return;

  const decoder = new TextDecoder();
  throw new Error(
    [
      "pattern source coverage child test failed",
      decoder.decode(result.stdout),
      decoder.decode(result.stderr),
    ].join("\n"),
  );
});
