import {
  assertEquals,
  assertArrayIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  Principal,
  Concept,
  dedupe,
  Composite,
  JoinExpression,
  URLPrincipal,
  Module,
  NetworkCapability,
  User,
} from "./principals.ts";
import { makeLattice, Trust } from "./lattice.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";

Deno.test("Principal join", () => {
  const a = new Principal();
  const b = new Principal();
  const trustStatements: Trust[] = [[a, [b]]];
  const lattice = makeLattice(trustStatements);
  assertEquals(a.join(b, lattice), b);
  assertEquals(b.join(a, lattice), b);
});

Deno.test("Concept resolve", () => {
  const conceptA = new Concept("A");
  const conceptB = new Concept("B");
  const principalC = new Principal();
  const trustStatements: Trust[] = [
    [conceptA, [conceptB]],
    [conceptB, [principalC]],
  ];
  const lattice = makeLattice(trustStatements);
  assertArrayIncludes(conceptA.resolve(lattice), [principalC]);
});

Deno.test("dedupe", () => {
  const a = new Concept("A");
  const b = new Concept("B");
  const c = new Concept("C");
  const c2 = new Concept("C");
  const list = [a, b, a, c, b, c2];
  assertEquals(dedupe(list), [a, b, c]);
});

Deno.test("Composite principal", () => {
  const module = new Module("0xcoffee");
  const user = new User();
  const composite = new Composite(module, { user });
  assertEquals(composite.generic, module);
  assertEquals(composite.parameters, { user });
});

Deno.test("JoinExpression join", () => {
  const a = new Concept("A");
  const b = new Concept("B");
  const c = new Concept("C");
  const trustStatements: Trust[] = [[a, [b, c]]];
  const lattice = makeLattice(trustStatements);
  const joinExpr = new JoinExpression([a, b]);
  const joinExprJoin = joinExpr.join(c, lattice);
  assert(joinExprJoin instanceof JoinExpression);
  assertEquals(joinExprJoin.principals, [a, b, c]);
});

Deno.test("URLPrincipal join", () => {
  const urlA = new URLPrincipal("http://example.com");
  const urlB = new URLPrincipal("http://example.com/page");
  const trustStatements: Trust[] = [];
  const lattice = makeLattice(trustStatements);
  assertEquals(urlA.join(urlB, lattice), urlA);
  assertEquals(urlB.join(urlA, lattice), urlA);
});

Deno.test("NetworkCapability principal", () => {
  const urlPrincipalA = new URLPrincipal("http://example.com");
  const networkCapabilityA = new NetworkCapability(urlPrincipalA);
  const urlPrincipalB = new URLPrincipal("http://example.com/page");
  const networkCapabilityB = new NetworkCapability(urlPrincipalB);
  const join = networkCapabilityA.join(networkCapabilityB, makeLattice([]));
  assertEquals(join.toString(), networkCapabilityA.toString());
});
