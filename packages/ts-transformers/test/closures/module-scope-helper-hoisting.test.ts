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

Deno.test("Closure Transformer hoists nested computed callbacks that close over module-scoped helpers", async () => {
  const source = `    import { computed, pattern, UI } from "commonfabric";

    const formatDateShort = (dateStr: string) => dateStr.toUpperCase();

    export default pattern<{ values: string[] }>((state) => ({
      [UI]: (
        <div>
          {state.values.map((dateStr) => (
            <span>
              {computed(() => formatDateShort(dateStr))}
            </span>
          ))}
        </div>
      ),
    }));
`;

  const output = await transformSource(source, options);
  const normalized = output.replace(/\s+/g, " ");

  // After CT-1644 Phase 2 the computed lowers to a lift whose WHOLE call is
  // hoisted to a module-scope `const __cfLift_N = __cfHelpers.lift(...)`, with
  // the callback inline (no separate `__cfModuleCallback` hardened wrapper —
  // CT-1644 subsumes lift from the CT-1585 callback hoister). The hoisted
  // const is module-scope, which is the property this test guards: a computed
  // closing over the module-scoped helper `formatDateShort` becomes a named,
  // module-scope, self-contained unit.
  const hoistedMatch = normalized.match(
    /const (__cfLift_\d+) = __cfHelpers\.lift[\s\S]*?, \(\{ dateStr \}\) => formatDateShort\(dateStr\)\);/,
  );

  assert(hoistedMatch, `expected hoisted lift in output:\n${output}`);

  const hoistedName = hoistedMatch[1]!;
  // The original site applies the captures to the hoisted name.
  assertMatch(
    normalized,
    new RegExp(`${hoistedName}\\(\\{ dateStr: dateStr \\}\\)`),
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

Deno.test("CT-1585: Closure Transformer hoists synthesized mapWithPattern callback that closes only over module-level symbols", async () => {
  // Source shape: a .map() callback whose body invokes a module-level
  // pattern factory (`EntryRow`) and reads a module-level constant
  // (`UI`). After the closure transformer rewrites .map() to
  // .mapWithPattern(__cfHelpers.pattern(...)), the synthesized pattern
  // callback closes only over module-scoped references — there are no
  // per-call-site captures. The `hoistModuleScopedBuilderCallbacks` tail
  // step should therefore hoist the synthesized callback to module scope
  // and replace it at the call site with a reference to the hoisted name.
  //
  // Currently failing: the hoister does not fire on the synthesized
  // pattern callback. The inline `__cfHelpers.pattern((_input) => { ... })`
  // remains at the call site instead of being replaced by a hoisted
  // reference. See CT-1585.
  const source = `    import { pattern, UI } from "commonfabric";

    interface Entry { piece: string }
    interface RowOutput { rendered: string; [UI]: string }

    const EntryRow = pattern<Entry, RowOutput>((input) => ({
      rendered: input.piece,
      [UI]: input.piece,
    }));

    export default pattern<{ filtered: Entry[] }>(({ filtered }) => ({
      [UI]: (
        <div>
          {filtered.map((entry) => {
            const row = EntryRow({ piece: entry.piece });
            return row[UI];
          })}
        </div>
      ),
    }));
`;

  const output = await transformSource(source, options);
  const normalized = output.replace(/\s+/g, " ");

  // The synthesized pattern callback should be hoisted to module scope.
  // Hoisting runs *after* PatternCallbackLowering (see CT-1585), so the
  // hoisted callback has the fully-lowered shape:
  //   `__cf_pattern_input => { const entry = __cf_pattern_input.key("element"); ... }`
  // (rather than the destructured form `({ element, params }) => ...`
  // which exists transiently between stages 7 and 11). The exact name
  // is generated; capture it for the call-site assertion.
  const hoistedMatch = normalized.match(
    /const (__cfModuleCallback_?\d+) = (?:__cfHardenFn\()?\(?__cf_pattern_input\b/,
  );
  assert(
    hoistedMatch,
    `expected synthesized pattern callback to be hoisted to module scope. Output was:\n${output}`,
  );

  const hoistedName = hoistedMatch[1]!;
  // The mapWithPattern call site should reference the hoisted name
  // rather than carry the callback inline.
  assertMatch(
    normalized,
    new RegExp(
      `mapWithPattern\\(\\s*__cfHelpers\\.pattern\\(\\s*${hoistedName}\\b`,
    ),
  );
});
