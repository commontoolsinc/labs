import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { openV2Space, V2Space } from "../v2-space.ts";
import { executePaginatedQuery } from "../v2-query.ts";
import type { EntityId, JSONValue } from "../v2-types.ts";
import { computeFactHash, computeValueHash, EMPTY } from "../v2-reference.ts";

function writeSetFact(
  space: V2Space,
  branch: string,
  entityId: EntityId,
  value: JSONValue,
): number {
  const version = space.nextVersion(branch);
  const commitRef = `page-commit-${version}`;
  space.insertCommit(commitRef, version, branch, null);

  const valueHash = computeValueHash(value);
  space.insertValue(valueHash.toString(), JSON.stringify(value));

  const fact = {
    type: "set" as const,
    id: entityId,
    value,
    parent: EMPTY(entityId),
  };
  const factHash = computeFactHash(fact);
  space.insertFact({
    hash: factHash.toString(),
    id: entityId,
    valueRef: valueHash.toString(),
    parent: null,
    branch,
    version,
    commitRef,
    factType: "set",
  });
  space.updateHead(branch, entityId, factHash.toString(), version);
  space.updateBranchHeadVersion(branch, version);
  return version;
}

describe("v2-query pagination", () => {
  let space: V2Space;

  beforeEach(() => {
    space = openV2Space(new URL("memory:pagination-test"));

    // Create 10 entities with sequential IDs
    for (let i = 0; i < 10; i++) {
      const id = `urn:entity:page-${String(i).padStart(2, "0")}` as EntityId;
      writeSetFact(space, "", id, { index: i });
    }
  });

  it("returns first page with cursor", () => {
    const result = executePaginatedQuery(space, {
      select: { "*": {} },
      limit: 3,
    });

    expect(Object.keys(result.facts).length).toBe(3);
    expect(result.nextCursor).toBeDefined();
  });

  it("returns next page using cursor", () => {
    const page1 = executePaginatedQuery(space, {
      select: { "*": {} },
      limit: 3,
    });

    const page2 = executePaginatedQuery(space, {
      select: { "*": {} },
      limit: 3,
      cursor: page1.nextCursor,
    });

    expect(Object.keys(page2.facts).length).toBe(3);
    // Page 2 should have different entities than page 1
    const page1Ids = Object.keys(page1.facts);
    const page2Ids = Object.keys(page2.facts);
    for (const id of page2Ids) {
      expect(page1Ids).not.toContain(id);
    }
  });

  it("returns all entities across multiple pages", () => {
    const allIds: string[] = [];
    let cursor: EntityId | undefined;

    for (let page = 0; page < 10; page++) {
      const result = executePaginatedQuery(space, {
        select: { "*": {} },
        limit: 3,
        cursor,
      });

      allIds.push(...Object.keys(result.facts));
      cursor = result.nextCursor;

      if (!cursor) break;
    }

    expect(allIds.length).toBe(10);
    // Verify all entities are unique
    expect(new Set(allIds).size).toBe(10);
  });

  it("returns no cursor on last page", () => {
    const result = executePaginatedQuery(space, {
      select: { "*": {} },
      limit: 20, // More than total entities
    });

    expect(Object.keys(result.facts).length).toBe(10);
    expect(result.nextCursor).toBeUndefined();
  });

  it("respects since parameter with pagination", () => {
    // Write an additional entity at a later version
    const laterVersion = writeSetFact(
      space,
      "",
      "urn:entity:page-late" as EntityId,
      { late: true },
    );

    const result = executePaginatedQuery(space, {
      select: { "*": {} },
      limit: 5,
      since: laterVersion - 1,
    });

    // Should only return the entity written at laterVersion
    expect(Object.keys(result.facts).length).toBe(1);
    expect(result.nextCursor).toBeUndefined();
  });
});
