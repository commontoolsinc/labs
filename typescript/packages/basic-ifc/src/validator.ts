import { Recipe } from "./recipe.ts";
import { Lattice } from "./lattice.ts";
import {
  Principal,
  Concept,
  Composite,
  JoinExpression,
  Integrity,
  TOP,
  BOTTOM,
} from "./principals.ts";
import { ModuleDefinition, ConstraintOnData, Path } from "./module.ts";
import { Guardrail } from "./guardrail.ts";

export class ValidationError extends Error {}

const allVars = new Map<string, PrincipalVariable>();

class PrincipalVariable extends Concept {
  constructor(
    public readonly path: Path,
    public readonly type: "integrity" | "confidentiality"
  ) {
    const uri =
      "urn:common:validator:var:" + type + ":" + path.flat().join("/");
    if (allVars.has(uri)) return allVars.get(uri)!;

    super(uri);
    allVars.set(uri, this);
  }
}

function getIntegrityVar(path: Path): PrincipalVariable {
  return new PrincipalVariable(path, "integrity");
}

function getConfidentialityVar(path: Path): PrincipalVariable {
  return new PrincipalVariable(path, "confidentiality");
}

const $integrity = Symbol("integrity");
const $confidentiality = Symbol("confidentiality");
type State = {
  [$integrity]?: PrincipalVariable;
  [$confidentiality]?: PrincipalVariable;
  [key: string]: State;
};

type Constraint = [PrincipalVariable, "<=" | ">=", JoinExpression<Principal>];

function getPrincipal(principal: Principal | string): Principal {
  return typeof principal === "string" ? new Concept(principal) : principal;
}

function translateOutsideConstraints(
  outsideConstraints: ConstraintOnData[]
): Constraint[] {
  const constraints: Constraint[] = [];

  for (const constraint of outsideConstraints) {
    // Input constraints
    if ("maximumIntegrity" in constraint)
      constraints.push([
        getIntegrityVar(constraint.path),
        "<=",
        new JoinExpression([getPrincipal(constraint.maximumIntegrity)]),
      ]);

    if ("minimumConfidentiality" in constraint)
      constraints.push([
        getConfidentialityVar(constraint.path),
        ">=",
        new JoinExpression([getPrincipal(constraint.minimumConfidentiality)]),
      ]);

    // Output constraints
    if ("minimumIntegrity" in constraint)
      constraints.push([
        getIntegrityVar(constraint.path),
        ">=",
        new JoinExpression([getPrincipal(constraint.minimumIntegrity)]),
      ]);

    if ("maximumConfidentiality" in constraint)
      constraints.push([
        getConfidentialityVar(constraint.path),
        "<=",
        new JoinExpression([getPrincipal(constraint.maximumConfidentiality)]),
      ]);
  }

  return constraints;
}

function generateConstraintsFromRecipe(
  recipe: Recipe,
  modules: Map<string, ModuleDefinition>
): Constraint[] {
  const constraints: Constraint[] = [];

  for (const node of recipe.nodes) {
    const module =
      typeof node.module === "string" ? modules.get(node.module) : node.module;
    if (!module)
      throw new ValidationError("Module not available: " + node.module);

    // TODO: Actually apply module constraints

    // Output integrity: Cannot be more than its inputs + the module
    constraints.push([
      new PrincipalVariable([node.id], "integrity"),
      "<=",
      new JoinExpression([
        new Composite<Integrity | Concept>(
          Object.fromEntries(
            node.in.map(([port, path]) => [port, getIntegrityVar(path)])
          )
        ),
      ]),
    ]);

    // Output confidentiality: Join of all the inputs
    constraints.push([
      getConfidentialityVar([node.id]),
      ">=",
      new JoinExpression(
        node.in.map(([, path]) => getConfidentialityVar(path))
      ),
    ]);
  }

  return constraints;
}

/**
 * Unify by repeatedly substituting variables with their values.
 *
 * For now, the simple strategy is to find all variables that don't refer to
 * other variables and substitute them. We have to be careful to observe the
 * operator, though.
 *
 * @return The unified constraints
 */
function unify(constraints: Constraint[], lattice: Lattice): Constraint[] {
  // First, let's add missing <= and >= constraints for all variables
  for (const variable of allVars.values()) {
    if (!constraints.find(([v, op]) => v === variable && op === "<=")) {
      constraints.push([variable, "<=", new JoinExpression([TOP])]);
    }
    if (!constraints.find(([v, op]) => v === variable && op === ">=")) {
      constraints.push([variable, ">=", new JoinExpression([BOTTOM])]);
    }
  }

  // Then, keep substituting until we can't anymore
  do {
    // First, simplify expressions
    constraints = constraints.map(([variable, operator, expression]) => [
      variable,
      operator,
      expression.simplify(lattice),
    ]);

    // TODO: Substitions shouldn't create nested JoinExpressions
    // TODO: Think about >= and <= cases
    const substitutions = {
      ">=": new Map<PrincipalVariable, Principal>(),
      "<=": new Map<PrincipalVariable, Principal>(),
    };

    for (const [variable, operator, expression] of constraints) {
      let hasVariable = false;
      expression.walk((p) => {
        hasVariable ||= p instanceof PrincipalVariable;
        return p;
      });

      if (!hasVariable) {
        substitutions[operator].set(variable, expression);
      }
    }

    if (substitutions["<="].size === 0 && substitutions[">="].size === 0) break;
    console.log("subs", substitutions);

    let substituted = false;
    constraints = constraints.map(([variable, operator, expression]) => {
      const newExpression = expression.walk((p) => {
        const substitution = substitutions[operator].get(
          p as PrincipalVariable
        );
        if (substitution) {
          substituted = true;
          return substitution;
        } else {
          return p;
        }
      });

      return [variable, operator, newExpression] as Constraint;
    });

    if (!substituted) break;
  } while (true);

  return constraints;
}

export function validate(
  recipe: Recipe,
  lattice: Lattice,
  nodules: Map<string, ModuleDefinition> = new Map(),
  outsideConstraints: ConstraintOnData[] = []
): Constraint[] {
  const initialConstraints = [
    ...translateOutsideConstraints(outsideConstraints),
    ...generateConstraintsFromRecipe(recipe, nodules),
  ];

  const constraints = unify(initialConstraints, lattice);

  return constraints;
}
