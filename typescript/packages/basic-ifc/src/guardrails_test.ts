import {
  Principal,
  Expression,
  Confidentiality,
  Concept,
  Integrity,
  JoinExpression,
  BOTTOM,
} from "./principals.ts";

import { Lattice, makeLattice, Trust } from "./lattice.ts";
import { Guardrail } from "./guardrail.ts";
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("Guardrail.PUBLIC should be BOTTOM", () => {
  assertEquals(Guardrail.PUBLIC, BOTTOM);
});

Deno.test("Guardrail initialization", () => {
  const canFlowTo: (Confidentiality | Concept)[] = [];
  const declassifiers: [(Integrity | Concept)[], Guardrail | Concept][] = [];
  const guardrail = new Guardrail(canFlowTo, declassifiers);

  assertEquals(guardrail.canFlowTo, canFlowTo);
  assertEquals(guardrail.declassifiers, declassifiers);
});

Deno.test("Guardrail equals method", () => {
  const canFlowTo: (Confidentiality | Concept)[] = [];
  const declassifiers: [(Integrity | Concept)[], Guardrail | Concept][] = [];
  const guardrail1 = new Guardrail(canFlowTo, declassifiers);
  const guardrail2 = new Guardrail(canFlowTo, declassifiers);
  const differentGuardrail = new Guardrail(
    [new Confidentiality()],
    declassifiers
  );

  // Guardrails with the same canFlowTo and declassifiers should be equal
  assert(guardrail1.equals(guardrail2));
  assert(guardrail2.equals(guardrail1));

  // Guardrails with different canFlowTo or declassifiers should not be equal
  assert(!guardrail1.equals(differentGuardrail));
  assert(!differentGuardrail.equals(guardrail1));
});

Deno.test("Guardrail join with non-Guardrail principal", () => {
  const trustStatements: Trust[] = [];
  const lattice = makeLattice(trustStatements);
  const canFlowTo: (Confidentiality | Concept)[] = [];
  const declassifiers: [(Integrity | Concept)[], Guardrail | Concept][] = [];
  const guardrail = new Guardrail(canFlowTo, declassifiers);

  const otherPrincipal = new Expression();
  const result = guardrail.join(otherPrincipal, lattice);

  assert(result instanceof JoinExpression);
  assertEquals(result.principals.length, 2);

  let [a, b] = result.principals;
  if (b instanceof Guardrail) [a, b] = [b, a];
  console.log(a, b, guardrail);
  assert(a.equals(guardrail));
  assert(b === otherPrincipal);
});

Deno.test("Guardrail join with another Guardrail", () => {
  const trustStatements: Trust[] = [];
  const lattice = makeLattice(trustStatements);
  const canFlowTo: (Confidentiality | Concept)[] = [];
  const declassifiers: [(Integrity | Concept)[], Guardrail | Concept][] = [];
  const guardrail1 = new Guardrail(canFlowTo, declassifiers);
  const guardrail2 = new Guardrail(canFlowTo, declassifiers);

  const result = guardrail1.join(guardrail2, lattice);

  assert(result instanceof JoinExpression);
  assertEquals(result.principals.length, 2);
  assert(result.principals.includes(guardrail1));
  assert(result.principals.includes(guardrail2));
});

Deno.test("Guardrail expand", () => {
  class MockConcept extends Concept {
    resolve(_lattice: Lattice): Principal[] {
      return [new Confidentiality(), new Integrity()];
    }
  }

  const trustStatements: Trust[] = [];
  const lattice = makeLattice(trustStatements);
  const concept = new MockConcept("mock");
  const canFlowTo: (Confidentiality | Concept)[] = [concept];
  const declassifiers: [(Integrity | Concept)[], Guardrail | Concept][] = [
    [[concept], concept],
  ];
  const guardrail = new Guardrail(canFlowTo, declassifiers);

  const expanded = guardrail.expand(lattice);

  assertEquals(expanded.canFlowTo.length, 2);
  assert(expanded.canFlowTo.some((p) => p instanceof Confidentiality));
  assert(expanded.canFlowTo.some((p) => p instanceof Integrity));

  assertEquals(expanded.declassifiers.length, 2);
  for (const [conditions, gr] of expanded.declassifiers) {
    assertEquals(conditions.length, 2);
    assert(conditions.some((p) => p instanceof Confidentiality));
    assert(conditions.some((p) => p instanceof Integrity));
    assert(gr instanceof MockConcept);
  }
});
