import { assertEquals, assertStringIncludes } from "@std/assert";
import { StaticCacheFS } from "@commonfabric/static";

import { transformSource } from "./utils.ts";

const commonfabricTypes = await new StaticCacheFS().getText(
  "types/commonfabric.d.ts",
);

Deno.test("latestComplete injects its recursively usable schema", async () => {
  const output = await transformSource(
    `
      import {
        AsyncResult,
        Cell,
        latestComplete,
        pattern,
      } from "commonfabric";

      type Repo = { owner: string; name: string };
      type Ticket = { title: string };

      export default pattern((input: {
        repo: AsyncResult<Repo>;
        ticket: AsyncResult<Ticket>;
        variable: Cell<number>;
      }) => {
        const snapshot = latestComplete({
          repo: input.repo,
          ticket: input.ticket,
          variable: input.variable,
          nested: [input.repo, { ticket: input.ticket }] as const,
        });
        return { snapshot };
      });
    `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(output, "latestComplete({");
  assertStringIncludes(output, "schema:");
  assertStringIncludes(output, "owner: {");
  assertStringIncludes(output, "title: {");
  assertStringIncludes(output, "variable: {");
  assertEquals(output.match(/type: "string"/g)?.length! >= 3, true);
  assertEquals(output.match(/type: "number"/g)?.length! >= 2, true);
  assertEquals(output.includes("DataUnavailable"), false);
  assertEquals(output.includes('reason: { type: "string"'), false);
});

Deno.test("aliased and namespace latestComplete calls inject a schema", async () => {
  const output = await transformSource(
    `
      import * as cf from "commonfabric";
      import {
        AsyncResult,
        latestComplete as keepLatest,
        pattern,
      } from "commonfabric";

      type Repo = { name: string };

      export default pattern((input: { request: AsyncResult<Repo> }) => {
        const one = keepLatest(input.request);
        const two = cf.latestComplete(input.request);
        return { one, two };
      });
    `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertEquals(output.match(/schema:/g)?.length, 2);
  assertEquals(output.match(/name: \{/g)?.length! >= 2, true);
});
