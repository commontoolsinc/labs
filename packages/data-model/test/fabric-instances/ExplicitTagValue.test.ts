import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { UnknownValue } from "../../src/fabric-instances/UnknownValue.ts";
import { ProblematicValue } from "../../src/fabric-instances/ProblematicValue.ts";
import { ExplicitTagValue } from "../../src/fabric-instances/ExplicitTagValue.ts";

describe("ExplicitTagValue", () => {
  it("UnknownValue is an instance of ExplicitTagValue", () => {
    const us = new UnknownValue("Test@1", "state");
    expect(us instanceof ExplicitTagValue).toBe(true);
  });

  it("ProblematicValue is an instance of ExplicitTagValue", () => {
    const ps = new ProblematicValue("Test@1", "state", "oops");
    expect(ps instanceof ExplicitTagValue).toBe(true);
  });

  it("ExplicitTagValue provides access to typeTag and state", () => {
    const us: ExplicitTagValue = new UnknownValue("Tag@2", 42);
    expect(us.typeTag).toBe("Tag@2");
    expect(us.state).toBe(42);

    const ps: ExplicitTagValue = new ProblematicValue(
      "Bad@1",
      "data",
      "err",
    );
    expect(ps.typeTag).toBe("Bad@1");
    expect(ps.state).toBe("data");
  });
});
