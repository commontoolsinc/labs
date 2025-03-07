type IntegrityOrConfidentiality = "integrity" | "confidentiality";
type PrincipalVariable = `\$${string}-${IntegrityOrConfidentiality}`;
type Principal = Exclude<string, PrincipalVariable>;

type PrincipalExpression =
  | Principal
  | PrincipalVariable
  | ["join" | "meet", PrincipalExpression[]]
  | undefined;

function isLatticeVariable(
  principal: PrincipalExpression
): principal is PrincipalVariable {
  return typeof principal === "string" && principal.startsWith("$");
}

function isLatticeGroundedPrincipal(
  principal: PrincipalExpression
): principal is Principal {
  return typeof principal === "string" && !principal.startsWith("$");
}

function isCombinedPrincipal(
  principal: PrincipalExpression
): principal is ["join" | "meet", PrincipalExpression[]] {
  return Array.isArray(principal) && principal.length === 2;
}

type Label = {
  integrity: PrincipalExpression;
  confidentiality: PrincipalExpression;
};

type Constraint = [PrincipalVariable, PrincipalExpression];

export const $label = Symbol("label");
type State = {
  [$label]?: Label;
  [key: string]: State;
};

type Node = {
  type?: string; // Currently unused
  in: string[];
  out: string[];
};

const [TOP, BOTTOM] = ["TOP", "BOTTOM"] as const as Principal[];

// Each level lists its parents
// If a key is missing, it's assumed to have TOP as its parent
type LatticeRelationships = {
  [label: Principal]: Principal[];
};

type Lattice = {
  parents: LatticeRelationships;
  children: LatticeRelationships;
};

function computeAllParentsForLabel(
  label: string,
  lattice: LatticeRelationships,
  end: PrincipalExpression
): string[] {
  if (label === end) {
    return [];
  }
  const parents = lattice[label];
  if (!parents) {
    return [];
  }
  return parents.reduce(
    (acc, parent) => [
      ...acc,
      ...computeAllParentsForLabel(parent, lattice, end),
    ],
    parents
  );
}

// Create a lattice where each key lists all children
function makeLattice(latticeRelationships: LatticeRelationships): Lattice {
  const invertedLattice: LatticeRelationships = {};

  const allKeys = new Set<string>();

  for (const key in latticeRelationships) {
    allKeys.add(key);
    for (const parent of latticeRelationships[key]) {
      allKeys.add(parent);
      if (!invertedLattice[parent]) {
        invertedLattice[parent] = [];
      }
      invertedLattice[parent].push(key);
    }
  }

  const lattice = {
    parents: {} as LatticeRelationships,
    children: {} as LatticeRelationships,
  };

  // Compute all parents and children for each key
  for (const key of allKeys) {
    lattice.parents[key] = [
      key,
      ...computeAllParentsForLabel(key, latticeRelationships, TOP),
      TOP,
    ];

    lattice.children[key] = [
      key,
      ...computeAllParentsForLabel(key, invertedLattice, BOTTOM),
      BOTTOM,
    ];
  }

  return lattice;
}

function dedupe(principals: PrincipalExpression[]): PrincipalExpression[] {
  const seen = new Set<PrincipalExpression>();
  return principals.filter((p) => {
    if (p === undefined || seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

// Computes the join of the principals in the lattice
// Only grounded principals can join, if they are variables, we leave them alone
function join(
  principals: PrincipalExpression[],
  lattice: Lattice
): PrincipalExpression {
  const groundedPrincipals = principals.filter(isLatticeGroundedPrincipal);
  const otherPrincipals = dedupe(
    principals.filter((p) => !isLatticeGroundedPrincipal(p))
  );

  const commonParents = groundedPrincipals.reduce(
    (acc, principal) =>
      (lattice.parents[principal] ?? []).filter((parent) =>
        acc.includes(parent)
      ),
    lattice.parents[groundedPrincipals[0]] ?? []
  );

  return otherPrincipals.length
    ? ([
      "join",
      [
        ...otherPrincipals,
        ...(commonParents.length ? [commonParents[0]] : []),
      ],
    ] as PrincipalExpression)
    : commonParents[0] ?? TOP;
}

function meet(
  principals: PrincipalExpression[],
  lattice: Lattice
): PrincipalExpression {
  const groundedPrincipals = principals.filter(isLatticeGroundedPrincipal);
  const otherPrincipals = dedupe(
    principals.filter((p) => !isLatticeGroundedPrincipal(p))
  );

  const commonChildren = groundedPrincipals.reduce(
    (acc, principal) =>
      (lattice.children[principal] ?? []).filter((child) =>
        acc.includes(child)
      ),
    lattice.children[groundedPrincipals[0]] ?? []
  );

  return otherPrincipals.length
    ? ([
      "meet",
      [
        ...otherPrincipals,
        ...(commonChildren.length ? [commonChildren[0]] : []),
      ],
    ] as PrincipalExpression)
    : commonChildren[0] ?? BOTTOM;
}

// Creates an expression from a list of labels combined by join/meet, inlining
// any nested join/meet expressions
function combine(
  op: "join" | "meet",
  expressions: PrincipalExpression[]
): PrincipalExpression {
  const expressionsToJoin = dedupe(
    expressions.flatMap((expression) => {
      if (Array.isArray(expression) && expression[0] === op) {
        return expression[1];
      }
      return expression;
    })
  );

  if (expressionsToJoin.length === 0) return undefined;

  if (expressionsToJoin.length === 1) return expressionsToJoin[0];

  return [op, expressionsToJoin];
}

function generatePrincipalVariable(
  name: string,
  type: IntegrityOrConfidentiality
): PrincipalVariable {
  return `$${name}-${type}` as PrincipalVariable;
}

// Generate initial constraints from the state and bindings
//
// Output integrity is at most the meet of the input integrities Output
// confidentiality is at least the join of the input confidences
//
// "at most" means `x ∧ y = x`, so we can combine all "at most" constraints with
// a meet. Analogous for "at least" and join.
//
// When a label is in the initial state, and it's forcing a specific label.
// Eventually we could support `base-integrity ∧ $other-integrity` to mean to
// compute all other required integrity? Analogous for confidentiality.
function generateConstraints(state: State, bindings: Node[]): Constraint[] {
  const constraints: Constraint[] = [];

  // Traverse state and create constraints where labels are set
  function traverse(subState: State, path: string[]): void {
    if (subState[$label]) {
      const label = subState[$label];
      const name = path.join(".");

      if (label.integrity)
        constraints.push([
          generatePrincipalVariable(name, "integrity"),
          label.integrity,
        ]);

      if (label.confidentiality)
        constraints.push([
          generatePrincipalVariable(name, "confidentiality"),
          label.confidentiality,
        ]);
    }
    for (const key in subState) {
      traverse(subState[key], [...path, key]);
    }
  }

  traverse(state, []);

  for (const binding of bindings) {
    // Compute output constraints based on inputs
    const combinedInputintegrity = combine(
      "meet",
      binding.in.map((input) => generatePrincipalVariable(input, "integrity"))
    );
    const combinedInputconfidentiality = combine(
      "join",
      binding.in.map((input) =>
        generatePrincipalVariable(input, "confidentiality")
      )
    );

    binding.out.forEach((output) => {
      if (combinedInputintegrity !== undefined) {
        const name = generatePrincipalVariable(output, "integrity");
        constraints.push([
          name,
          combine("meet", [name, combinedInputintegrity]),
        ]);
      }

      if (combinedInputconfidentiality !== undefined) {
        const name = generatePrincipalVariable(output, "confidentiality");
        constraints.push([
          name,
          combine("join", [name, combinedInputconfidentiality]),
        ]);
      }
    });

    // Compute input constraints based on outputs
    const combinedOutputintegrity = combine(
      "join",
      binding.out.map((output) =>
        generatePrincipalVariable(output, "integrity")
      )
    );
    const combinedOutputconfidentiality = combine(
      "meet",
      binding.out.map((output) =>
        generatePrincipalVariable(output, "confidentiality")
      )
    );

    binding.in.forEach((input) => {
      if (combinedOutputintegrity !== undefined) {
        const name = generatePrincipalVariable(input, "integrity");
        constraints.push([
          name,
          combine("join", [name, combinedOutputintegrity]),
        ]);
      }

      if (combinedOutputconfidentiality !== undefined) {
        const name = generatePrincipalVariable(input, "confidentiality");
        constraints.push([
          name,
          combine("meet", [name, combinedOutputconfidentiality]),
        ]);
      }
    });
  }

  return constraints;
}

type Substitutions = { [key: PrincipalVariable]: PrincipalExpression };
// Substitution rules, in order of priority:
//  - If the variable isn't mentioned on the right side, always substitute it
//  - If a subset of an expression is just grounded principals, compute their
//    join/meet.
//  - If there is only one constraint for a variable, we can substitute it if
//    the variable is only mentioned in the first layer.
//  - If there are multiple constraints for a variable, and all contain the
//    variable, see whether there are more top level joins or meets, and
//    substitute the winner together. That is `a = a ∧ b` and `a = a ∧ c` can be
//    simplified to `a = a ∧ b ∧ c`.
//
// Function will return the first class of these substitutions it finds. It'll
// return an empty object if no substitutions are found.
function findSubstitutions(
  allConstraints: Constraint[],
  substitutions: Substitutions
): Substitutions {
  const newSubstitutions: Substitutions = {};
  const constraints = allConstraints.filter(([v]) => !substitutions[v]);

  // Return the deepest level the variable is found in, or 0 if not found.
  function maxLevelVariableIsContained(
    variable: PrincipalVariable,
    expression: PrincipalExpression
  ): number {
    if (isCombinedPrincipal(expression))
      return (
        1 +
        Math.max(
          ...expression[1].map((e) => maxLevelVariableIsContained(variable, e))
        )
      );
    else return expression === variable ? 1 : 0;
  }

  // If the variable isn't mentioned on the right side, always substitute it
  constraints.forEach(([variable, expression]) => {
    const level = maxLevelVariableIsContained(variable, expression);
    if (level === 0)
      newSubstitutions[variable] = simplifyExpression(expression);
  });
  if (Object.keys(newSubstitutions).length > 0) return newSubstitutions;

  // Split unique from non-unique constraints
  const uniqueConstraints: Constraint[] = [];
  const multipleConstraints: Map<PrincipalVariable, PrincipalExpression[]> =
    new Map();
  constraints.forEach(([variable, expression]) => {
    if (constraints.filter(([v]) => v === variable).length === 1) {
      uniqueConstraints.push([variable, expression]);
    } else {
      if (!multipleConstraints.has(variable)) {
        multipleConstraints.set(variable, [expression]);
      } else {
        multipleConstraints.get(variable)!.push(expression);
      }
    }
  });

  function substituteWithoutSelfReference([variable, expression]: Constraint):
    | PrincipalExpression
    | undefined {
    const level = maxLevelVariableIsContained(variable, expression);
    // level 2 means it's $var = [ "meet"| "join", [$var, ...] ]
    if (level == 2) {
      const [op, expressions] = expression as [
        "join" | "meet",
        PrincipalExpression[]
      ];
      return simplifyExpression([
        op,
        expressions.filter((e) => e !== variable),
      ]);
    }
    return undefined;
  }

  // If there is only one constraint for a variable, we can substitute it if
  // the variable is only mentioned in the first layer.
  uniqueConstraints.forEach(([v, e]) => {
    const substitution = substituteWithoutSelfReference([v, e]);
    if (substitution) newSubstitutions[v] = substitution;
  });
  if (Object.keys(newSubstitutions).length > 0) return newSubstitutions;

  // If there are multiple constraints for a variable, and one has the variable
  // at the top level, substitute all others into it via the same join/meet,
  // a = a v (b ^ c), a = a v (d ^ e) => a = a v (d ^ e) v (b ^ c ^ d ^ e)
  multipleConstraints.forEach((expressions, variable) => {
    const container = expressions.find(
      (e) => maxLevelVariableIsContained(variable, e) === 2
    );

    if (container && isCombinedPrincipal(container)) {
      const newExpression: PrincipalExpression = [
        container[0],
        [...container[1], ...expressions.filter((e) => e !== container)],
      ];
      newSubstitutions[variable] = simplifyExpression(
        substituteWithoutSelfReference([variable, newExpression]) ??
        newExpression
      );
    }
  });
  if (Object.keys(newSubstitutions).length > 0) return newSubstitutions;

  return {};
}

function applySubstitutions(
  constraints: PrincipalExpression,
  substitutions: Substitutions
): PrincipalExpression {
  if (isLatticeVariable(constraints)) {
    return substitutions[constraints] ?? constraints;
  } else if (isLatticeGroundedPrincipal(constraints)) {
    return constraints;
  } else if (isCombinedPrincipal(constraints)) {
    const [op, expressions] = constraints;
    return [op, expressions.map((e) => applySubstitutions(e, substitutions))];
  }
}

// Finds nested join and meet and flattens them into one
function simplifyExpression(
  expression: PrincipalExpression
): PrincipalExpression {
  if (isCombinedPrincipal(expression)) {
    const [op, expressions] = expression;
    const simplified: PrincipalExpression[] = [];
    expressions.forEach((e) => {
      if (isCombinedPrincipal(e)) {
        if (e[0] === op) {
          const flatten = (e: PrincipalExpression): PrincipalExpression[] => {
            if (isCombinedPrincipal(e) && e[0] === op) {
              return e[1].flatMap(flatten);
            } else {
              return [e];
            }
          };

          simplified.push(...flatten(e));
        } else {
          // The opposite of `op`, so let's see whether we can swap it.
          // Let's handle `B ^ (B v C)` <=> `B v (B ^ C)` for now.
          // B AND (B OR C) AND D <=> B OR (B AND C) OR (B AND D)
          const single = e[1].find((e) => !isCombinedPrincipal(e));
          const combined = e[1].find(
            (e) => isCombinedPrincipal(e) && e[0] === op
          ) as ["join" | "meet", PrincipalExpression[]] | undefined;
          if (
            e[1].length === 2 &&
            single &&
            combined &&
            single !== combined &&
            combined[1].includes(single)
          ) {
            // We can commute the operation and so flatten it by one level
            simplified.push(single);
            simplified.push([e[0], combined[1]]);
            console.log("commuted", single, combined);
          } else {
            simplified.push(simplifyExpression(e));
          }
        }
      } else {
        simplified.push(e);
      }
    });

    const deduped = dedupe(simplified);
    if (deduped.length === 1) console.log("single expression", deduped[0]);
    return deduped.length === 1
      ? simplifyExpression(deduped[0])
      : [op, deduped];
  } else {
    return expression;
  }
}

function unify(constraints: Constraint[], lattice: Lattice): Constraint[] {
  function traverse(expression: PrincipalExpression): PrincipalExpression {
    if (isLatticeVariable(expression)) {
      return expression;
    } else if (isLatticeGroundedPrincipal(expression)) {
      return expression;
    } else if (isCombinedPrincipal(expression)) {
      const [op, expressions] = expression;
      const newExpression = expressions.map((e) =>
        isCombinedPrincipal(e) ? traverse(e) : e
      );
      return (op === "join" ? join : meet)(newExpression, lattice);
    }
  }

  let substitutions: { [key: PrincipalVariable]: PrincipalExpression } = {};
  let newSubstitutions: { [key: PrincipalVariable]: PrincipalExpression } = {};
  do {
    constraints = constraints
      .filter(([v]) => !substitutions[v])
      .map(([v, e]) => [v, traverse(e)]);
    newSubstitutions = findSubstitutions(constraints, substitutions);
    constraints = constraints.map(([v, e]) => [
      v,
      simplifyExpression(applySubstitutions(e, newSubstitutions)),
    ]);
    substitutions = { ...substitutions, ...newSubstitutions };
  } while (Object.keys(newSubstitutions).length > 0);

  return [...(Object.entries(substitutions) as Constraint[]), ...constraints];
}

function inferLabels(
  initialState: State,
  bindings: Node[],
  lattice: Lattice
): State {
  const constraints = unify(
    generateConstraints(initialState, bindings),
    lattice
  );

  // Verify that there are no contradictions
  // TODO

  // Apply the constraints to the state and show all inferred labels
  // For now, this means turning variable names into paths and writing out the state
  const state: State = {};
  for (const [variable, expression] of constraints) {
    const [name, type] = variable.slice(1).split("-");
    let current = state;
    for (const part of name.split(".")) {
      if (!current[part]) current[part] = {};
      current = current[part];
    }
    if (!current[$label])
      current[$label] = { integrity: undefined, confidentiality: undefined };
    current[$label][type as IntegrityOrConfidentiality] = expression;
  }

  return state;
}

export { type Node, type State, makeLattice, inferLabels, BOTTOM, TOP };

export { join, meet, generateConstraints }; // internals for testing
