import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFTabList } from "./cf-tab-list.ts";

describe("CFTabList", () => {
  it("should have default properties", () => {
    const element = new CFTabList();

    expect(element.orientation).toBe("horizontal");
    expect(element.variant).toBe("underline");
  });

  it("should reflect orientation for host and child orientation styling", () => {
    const properties = CFTabList.properties as Record<
      string,
      { reflect?: boolean }
    >;

    expect(properties.orientation.reflect).toBe(true);
  });

  it("should normalize invalid enum-like properties to defaults", () => {
    const element = new CFTabList();
    element.orientation = "diagonal" as never;
    element.variant = "pills" as never;

    (element as any).willUpdate(
      new Map([
        ["orientation", "horizontal"],
        ["variant", "underline"],
      ]),
    );

    expect(element.orientation).toBe("horizontal");
    expect(element.variant).toBe("underline");
  });
});
