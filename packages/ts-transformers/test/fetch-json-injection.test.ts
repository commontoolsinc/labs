import { assertStringIncludes } from "@std/assert";
import { transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

const REPO = `
interface Repo {
  name: string;
  stars: number;
}
`;

// fetchJson<T> lowers T into an injected `schema` property. The object-literal
// argument form is covered by the schema-injection fixture; these cases reach
// the other two emission branches: a non-object-literal argument (spread) and
// no argument at all.

Deno.test("fetchJson injects a schema by spreading a non-literal argument", async () => {
  const source = `
    import { fetchJson } from "commonfabric";
    ${REPO}
    const opts = { url: "https://example.com/repo.json" };
    export default function T() {
      return fetchJson<Repo>(opts);
    }
  `;

  const output = await transformSource(source, { types: COMMONFABRIC_TYPES });

  // The derived schema is emitted, and the original argument is spread in.
  assertStringIncludes(output, "schema");
  assertStringIncludes(output, "...opts");
});

Deno.test("fetchJson injects a schema when called with no argument", async () => {
  const source = `
    import { fetchJson } from "commonfabric";
    ${REPO}
    export default function T() {
      return fetchJson<Repo>();
    }
  `;

  const output = await transformSource(source, { types: COMMONFABRIC_TYPES });

  // With no argument, the injected schema becomes the sole property of a fresh
  // params object.
  assertStringIncludes(output, "schema");
});
