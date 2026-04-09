import { assert, assertMatch, assertNotMatch } from "@std/assert";
import { StaticCacheFS } from "@commonfabric/static";
import { transformSource } from "../utils.ts";

const staticCache = new StaticCacheFS();
const commonfabric = await staticCache.getText("types/commonfabric.d.ts");
const commonfabricSchema = await staticCache.getText(
  "types/commonfabric-schema.d.ts",
);
const options = {
  types: {
    "commonfabric.d.ts": commonfabric,
    "commonfabric-schema.d.ts": commonfabricSchema,
  },
};

Deno.test("Closure Transformer hoists nested derive callbacks that close over module-scoped helpers", async () => {
  const source = `    import { derive, pattern, UI } from "commonfabric";

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
    /const (\S+) = __cfHardenFn\(\(\{ dateStr \}: \{ dateStr: string; \}\) => formatDateShort\(dateStr\)\);/,
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
  const source = `    import { handler } from "commonfabric";

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
    /const \S+ = __cfHardenFn\(\(event: \{ status\?: string \} \| undefined\) =>/,
  );
  assertMatch(
    normalized,
    /const makeHandler = .*handler\(.*\(event: \{ status\?: string; \} \| undefined\) => \{.*allowed\.includes\(status\)/,
  );
});
