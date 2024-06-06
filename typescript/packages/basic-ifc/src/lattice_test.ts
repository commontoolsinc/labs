import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Const, Concept } from "./principals.ts";
import { makeLattice, Trust, Lattice } from "./lattice.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";

Deno.test("makeLattice with empty trust statements", () => {
  const trustStatements: Trust[] = [];
  const expected: Lattice = {
    up: new Map(),
    concepts: new Map(),
  };
  assertEquals(makeLattice(trustStatements), expected);
});

Deno.test("makeLattice with simple trust relationship", () => {
  const principalA = new Const("A");
  const principalB = new Const("B");
  const trustStatements: Trust[] = [[principalA, [principalB]]];
  const expected: Lattice = {
    up: new Map([[principalA, [principalA, principalB]]]),
    concepts: new Map(),
  };
  assertEquals(makeLattice(trustStatements), expected);
});

Deno.test("makeLattice with multiple trust relationships", () => {
  const principalA = new Const("A");
  const principalB = new Const("B");
  const principalC = new Const("C");
  const trustStatements: Trust[] = [
    [principalA, [principalB]],
    [principalB, [principalC]],
  ];
  const expected: Lattice = {
    up: new Map([
      [principalA, [principalA, principalB, principalC]],
      [principalB, [principalB, principalC]],
    ]),
    concepts: new Map(),
  };
  assertEquals(makeLattice(trustStatements), expected);
});

Deno.test("makeLattice with concepts", () => {
  const conceptX = new Concept("X");
  const principalA = new Const("A");
  const principalB = new Const("B");
  const trustStatements: Trust[] = [[conceptX, [principalA, principalB]]];
  const expected: Lattice = {
    up: new Map([[conceptX, [conceptX, principalA, principalB]]]),
    concepts: new Map([[conceptX.toString(), [principalA, principalB]]]),
  };
  assertEquals(makeLattice(trustStatements), expected);
});
