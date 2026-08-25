import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

const read = (relativePath: string): string =>
  Deno.readTextFileSync(new URL(relativePath, import.meta.url));

function expectRetiredStateTombstones(source: string): void {
  expect(source.match(/recentPieces/g)?.length).toBe(2);
  expect(source).toContain(
    "const recentPieces = new Writable<MentionablePiece[]>([]);",
  );
  expect(source).toContain("    recentPieces,");
  expect(source).not.toMatch(
    /recentPieces\.(?:get|set|push|addUnique|map|filter)/,
  );

  expect(source.match(/trackRecent/g)?.length).toBe(1);
  expect(source).toContain("    trackRecent: retiredAction({}),");
  expect(source).toContain(">(() => {});");
}

describe("default-app retired state continuity", () => {
  for (
    const file of ["./default-app.tsx", "./default-app-ben.tsx"] as const
  ) {
    it(`${file} preserves inert state tombstones`, () => {
      expectRetiredStateTombstones(read(file));
    });
  }
});
