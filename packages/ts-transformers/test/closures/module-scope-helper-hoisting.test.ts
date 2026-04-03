import { assert, assertMatch, assertNotMatch } from "@std/assert";
import { StaticCacheFS } from "@commontools/static";
import { transformSource } from "../utils.ts";

const staticCache = new StaticCacheFS();
const commontools = await staticCache.getText("types/commontools.d.ts");
const commontoolsSchema = await staticCache.getText(
  "types/commontools-schema.d.ts",
);
const options = {
  types: {
    "commontools.d.ts": commontools,
    "commontools-schema.d.ts": commontoolsSchema,
  },
};

Deno.test("Closure Transformer hoists nested derive callbacks that close over module-scoped helpers", async () => {
  const source = `/// <cts-enable />
    import { derive, pattern, UI } from "commontools";

    const formatDateShort = (dateStr: string) => dateStr.toUpperCase();

    export default pattern<{ values: string[] }>((state) => ({
      [UI]: (
        <div>
          {state.values.map((dateStr) => (
            <span>
              {derive(
                { dateStr },
                ({ dateStr }: { dateStr: string }) => formatDateShort(dateStr),
              )}
            </span>
          ))}
        </div>
      ),
    }));
`;

  const output = await transformSource(source, options);
  const normalized = output.replace(/\s+/g, " ");

  const hoistedMatch = normalized.match(
    /const (\S+) = __ctHardenFn\(\(\{ dateStr \}: \{ dateStr: string; \}\) => formatDateShort\(dateStr\)\);/,
  );

  assert(hoistedMatch, `expected hoisted helper in output:\n${output}`);

  const hoistedName = hoistedMatch[1]!;
  assertMatch(
    normalized,
    new RegExp(
      `derive\\(.*\\{ dateStr \\}, ${hoistedName}\\)`,
    ),
  );
});

Deno.test("Closure Transformer does not hoist nested handler callbacks that also capture factory parameters", async () => {
  const source = `/// <cts-enable />
    import { handler } from "commontools";

    const normalize = (value: string) => value.trim();

    export const makeHandler = (allowed: string[]) =>
      handler((event: { status?: string } | undefined) => {
        const status = normalize(event?.status ?? "");
        if (!allowed.includes(status)) {
          return;
        }
      });
`;

  const output = await transformSource(source, options);
  const normalized = output.replace(/\s+/g, " ");

  assertNotMatch(
    normalized,
    /const \S+ = __ctHardenFn\(\(event: \{ status\?: string \} \| undefined\) =>/,
  );
  assertMatch(
    normalized,
    /const makeHandler = .*handler\(.*\(event: \{ status\?: string; \} \| undefined\) => \{.*allowed\.includes\(status\)/,
  );
});
