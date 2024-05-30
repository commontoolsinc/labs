type IntegrityOrConfidentiality = "integrity" | "confidentiality";
type LatticeVariable = `\$${string}-${IntegrityOrConfidentiality}`;
type LatticeGroundedPrincipal = Exclude<string, LatticeVariable>;

function isLatticeVariable(
  principal: LatticePrincipal
): principal is LatticeVariable {
  return typeof principal === "string" && principal.startsWith("$");
}

function isLatticeGroundedPrincipal(
  principal: LatticePrincipal
): principal is LatticeGroundedPrincipal {
  return typeof principal === "string" && !principal.startsWith("$");
}

type LatticePrincipal =
  | LatticeGroundedPrincipal
  | LatticeVariable
  | ["join" | "meet", LatticePrincipal[]];

type Label = { integrity: LatticePrincipal; confidentiality: LatticePrincipal };

type Constraint = [Label, Label];

const $label = Symbol("label");
type State = {
  [$label]: Label;
  [key: string]: State;
};

type Node = {
  type?: string; // Currently unused
  in: string[];
  out: string[];
};

const [TOP, BOTTOM] = ["TOP", "BOTTOM"] as const as LatticeGroundedPrincipal[];

// Each level lists its parents
// If a key is missing, it's assumed to have TOP as its parent
type LatticeRelationships = {
  [label: LatticeGroundedPrincipal]: LatticeGroundedPrincipal[];
};

type Lattice = {
  parents: LatticeRelationships;
  children: LatticeRelationships;
};

function computeAllParentsForLabel(
  label: string,
  lattice: LatticeRelationships,
  end: LatticePrincipal
): string[] {
  if (label === end) {
    return [];
  }
  const parents = lattice[label] || [end];
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
  for (const key in latticeRelationships)
    lattice.parents[key] = [
      key,
      ...computeAllParentsForLabel(key, latticeRelationships, TOP),
    ];

  for (const key in invertedLattice)
    lattice.children[key] = [
      key,
      ...computeAllParentsForLabel(key, invertedLattice, BOTTOM),
    ];

  for (const key of allKeys) {
    if (!lattice.parents[key]) {
      lattice.parents[key] = [key, TOP];
    }
    if (!lattice.children[key]) {
      lattice.children[key] = [key, BOTTOM];
    }
  }

  return lattice;
}

function dedupe(principals: LatticePrincipal[]): LatticePrincipal[] {
  const seen = new Set<LatticePrincipal>();
  return principals.filter((p) => {
    if (seen.has(p)) {
      return false;
    }
    seen.add(p);
    return true;
  });
}

// Computes the join of the principals in the lattice
// Only grounded principals can join, if they are variables, we leave them alone
function join(
  principals: LatticePrincipal[],
  lattice: Lattice
): LatticePrincipal {
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
      ] as LatticePrincipal)
    : commonParents[0] ?? TOP;
}

function meet(
  principals: LatticePrincipal[],
  lattice: Lattice
): LatticePrincipal {
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
      ] as LatticePrincipal)
    : commonChildren[0] ?? BOTTOM;
}

function generateConstraints(state: State, bindings: Node[]): Constraint[] {
  const constraints: Constraint[] = [];

  // Traverse state and create constraints where labels are set
  function traverse(subState: State, path: string[]): void {
    if (subState[$label]) {
      const label = subState[$label];
      const name = path.join(".");

      constraints.push([
        {
          integrity: `\$${name}-integrity`,
          confidentiality: `\$${name}-confidentiality`,
        },
        label,
      ]);
    }
    for (const key in subState) {
      traverse(subState[key], [...path, key]);
    }
  }

  traverse(state, []);

  for (const binding of bindings) {
    const integrity = [
      "meet",
      binding.in.map((input) => `\$${input}-integrity`),
    ] as LatticePrincipal;
    const confidentiality = [
      "join",
      binding.in.map((input) => `\$${input}-confidentiality`),
    ] as LatticePrincipal;

    binding.out.forEach((output) => {
      constraints.push([
        {
          integrity: `\$${output}-integrity`,
          confidentiality: `\$${output}-confidentiality`,
        },
        { integrity, confidentiality },
      ]);
    });
  }

  return constraints;
}

type Substitutions = { [key: LatticeVariable]: LatticeGroundedPrincipal };
function unify(
  constraints: Constraint[],
  substitutions: Substitutions,
  lattice: Lattice
): Substitutions {
  const newSubstitutions = { ...substitutions };

  // Go through all constraints, and where the right side is a grounded principal, unify it with the left side

  return newSubstitutions;
}

/*
function solveConstraints(
  constraints: [Label[], Label[]][],
  lattice: Lattice
): { [key: string]: Label } {
  const substitutions: { [key: string]: Label } = {};

  function unify(label1: Label, label2: Label): Label {
    return {
      integrity: join(label1.integrity, label2.integrity, lattice),
      confidentiality: meet(
        label1.confidentiality,
        label2.confidentiality,
        lattice
      ),
    };
  }

  for (const [inputs, outputs] of constraints) {
    const inferredLabel = inferLabels2(inputs, lattice);

    for (const output of outputs) {
      const key = `${output.integrity}-${output.confidentiality}`;
      if (substitutions[key]) {
        substitutions[key] = unify(substitutions[key], inferredLabel);
      } else {
        substitutions[key] = inferredLabel;
      }
    }
  }

  return substitutions;
}

function applySubstitutions(
  state: State,
  substitutions: { [key: string]: Label }
): State {
  const inferredState: State = JSON.parse(JSON.stringify(state)); // Deep copy the state

  function applyToNested(obj: any): void {
    for (const key in obj) {
      if (obj[key] && typeof obj[key] === "object") {
        if ("label" in obj[key]) {
          const label = obj[key].label;
          const keyLabel = `${label.integrity}-${label.confidentiality}`;
          if (substitutions[keyLabel]) {
            obj[key].label = substitutions[keyLabel];
          }
        }
        applyToNested(obj[key]);
      }
    }
  }

  applyToNested(inferredState);
  return inferredState;
}
*/
function inferLabels(state: State, bindings: Node[], lattice: Lattice): State {
  /* const constraints = generateConstraints(state, bindings);
  const substitutions = solveConstraints(constraints, lattice);
  return applySubstitutions(state, substitutions);*/
  return {} as State;
}

export { type Node, makeLattice, inferLabels, BOTTOM, TOP };

export { join, meet }; // internals for testing
