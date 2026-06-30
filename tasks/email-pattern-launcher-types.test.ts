import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { TILE_UI, UI, type VNode } from "commonfabric";
import type {
  LaunchedPatternInfo,
  LaunchedPatternResult,
  PatternOutput,
} from "../packages/patterns/google/extractors/email-pattern-launcher.tsx";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true
  : false;
type Expect<T extends true> = T;

type PendingIsBoolean = Expect<
  Equal<LaunchedPatternInfo["pending"], boolean>
>;
type ErrorIsStringOrNull = Expect<
  Equal<LaunchedPatternInfo["error"], string | null>
>;
type ResultIsKnownLauncherBoundary = Expect<
  Equal<LaunchedPatternInfo["result"], LaunchedPatternResult | null>
>;
type OutputTileIsVNode = Expect<Equal<PatternOutput[typeof TILE_UI], VNode>>;
type ResultUiStaysUnknownUntilNarrowed = Expect<
  Equal<LaunchedPatternResult[typeof UI], unknown>
>;
type ResultTileStaysUnknownUntilNarrowed = Expect<
  Equal<LaunchedPatternResult[typeof TILE_UI], unknown>
>;
type ChildSpecificFieldsStayUnknown = Expect<
  Equal<LaunchedPatternResult["childSpecificField"], unknown>
>;
type UnknownIsNotVNode = Expect<
  Equal<unknown extends VNode ? true : false, false>
>;

function acceptRenderSlot(_slot: VNode) {}

const unknownValue = {} as unknown;
// @ts-expect-error Unknown values must be narrowed before render slots.
acceptRenderSlot(unknownValue);

Deno.test("launcher state types stay render-safe", () => {
  assertEquals(true, true);
});

Deno.test("JSX children reject unknown values", async () => {
  const rootDir = fromFileUrl(new URL("..", import.meta.url));
  const tempDir = await Deno.makeTempDir({
    prefix: "launcher-jsx-type-",
  });
  const fixturePath = join(tempDir, "unknown-jsx-child.tsx");

  try {
    await Deno.writeTextFile(
      fixturePath,
      `
const unknownChild = {} as unknown;
const node = <div>{unknownChild}</div>;
void node;
`,
    );

    const command = new Deno.Command(Deno.execPath(), {
      args: ["check", "--config", "deno.jsonc", fixturePath],
      cwd: rootDir,
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await command.output();
    const output = new TextDecoder().decode(stdout) +
      new TextDecoder().decode(stderr);

    assertEquals(code, 1);
    assertStringIncludes(output, "unknown");
    assertStringIncludes(output, "RenderNode");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
