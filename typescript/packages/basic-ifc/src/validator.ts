/**
 * This module contains the validator, which is responsible for checking the
 * integrity and confidentiality constraints of a recipe.
 *
 * The validator works by generating constraints from the recipe and then
 * unifying them to find a solution. The constraints are generated from the
 * recipe by:
 *
 *  - Adding constraints from the outside (e.g. input constraints)
 *  - Adding constraints from the modules used in the recipe
 *  - Adding constraints from the graph in the recipe, according to information
 *    flow control principles
 *
 *
 * Expanding on the last point: For each node, we generate constraints on all
 * the inputs and its output. Constraints on the outputs are constraints flowing
 * downstream, e.g. anchored by upstream modules or recipe inputs. Input
 * constraints are flowing upstream, and come from downstream modules or
 * constraints on the recipe outputs:
 *
 *  - Output integrity: The integrity is `ModuleOutput<ModulePrincipal,
 *    inputs>`, where inputs corresponds to the integrity of the inputs, so set
 *    to the variable representing them.
 *
 *  - Output confidentiality: The confidentiality is the join of all the input
 *    confidentiality variables.
 *
 *  - Input integrity: The integrity of each input must be higher or equal (>=)
 *    than the corresponding `inputs` parameter of the module output. TBD
 *    substitution rules. I think we have to generate constraints for each input
 *    here, somehow cleaving off the trust the module provides at each step.
 *
 *    There are two cases: Something on the way endorses the required integrity,
 *    then we don't want to propagate that requirement further. To problem is
 *    that we don't know that until we've propagated to that step. So possibly
 *    we need to keep creating new variables on each step to captures the
 *    possible transformation to "integrity >= BOTTOM".
 *
 *    The other case is that the integrity is passed through, so here we keep
 *    the upstream requirement, but we also require the trust in the module.
 *
 *    Ok, so we're going to keep creating new variables per input and capture a
 *    substitution rule that resolves the above two cases once enough
 *    information is available.
 *
 *  - Input confidentiality: The confidentiality of the input must be at most
 *    (<=) any constraint on the output confidentiality.
 *
 *    It may pay to first simplify the join of guardrails then! Essentially,
 *    only flow allowed by all guardrails is allowed. So we can pick any
 *    guardrail and then for each term of its meet check if it's allowed by all
 *    the other ones (as in: at least one of the other's terms allows it), and
 *    only keep those. Or more precisely, join each of these terms and keep the
 *    result if it isn't TOP, and if one of the guardrails only merges to TOP,
 *    then no flow is allowed. Note that for declassifier terms (themselves join
 *    expressions), we'll always get results, but some of them have no chance of
 *    ever being allowed, for example because they require integrity that is
 *    mutually exclusive – we don't yet have means to identify these, but we
 *    might need that to cut down on the number of terms we have to keep. But
 *    also, a declassifier to a flow principal that is now already required can
 *    be dropped.
 *
 *    Now we have one guardrail <= another guardrail, which is true if no term
 *    on the left allows flow that isn't allowed by at least one term on the
 *    right. Or in other words, we can we use x <= y iff x = x meet y, which
 *    here means any term on the right can be absorbed by terms on the left.
 *
 *
 *  Next we need to model declassification, which we model as removing
 *  confidentiality constraints when the data has the corresponding integrity.
 *  Effectively, the JoinExpression of integrity says that our data is trusted
 *  by any of the individual principals in the join. So we can remove any
 *  individual ones that appear in a join expressoin of declassifiers.
 *
 *  Note:
 *  - Flow principals shouldn't be "trusted" by module outputs (unless we really
 *    mean declassification to public). But it seems tempting to say this
 *    "module Foo is trusted by trustedAPIaccess".
 *
 *
 *  Next we consider restrictions on the flow provided by module manifests. Note
 *  that these don't require trust, they are voluntary restrictions on the flow,
 *  usually so that their output can be trusted by others, or to get the ability
 *  to use a sensitive capability (which restricts what data it would ever see):
 *
 *  - Constraints on the output data, based on the input data:
 *    - Required output, captured in the schema as non-optional field: The
 *      confidentiality of the field name (not the data) is the confidentiality
 *      of all required inputs, but not influenced by the confidentiality of the
 *      values. This should be fairly common.
 *    - Only reading a subset of the input data: The provided schema still
 *      constraints what input is allowed, even if only a subset is actually
 *      read.
 *    - Exact copy of some input data
 *      - Often combined with marking input data as opaque. The module can pass
 *        the reference along, but not read the data, hence not taint the
 *        outputs with the other input data.
 *        - It's possible to express "original input plus this field" as output.
 *          That is passing through an object with the original input and adding
 *          or changing a field.
 *      - For lists:
 *        - All entries come from an input list, same length, no duplicates
 *        - Subset of the input list
 *        - Single entry from the input list
 *        - Same length as input list, but otherwise transformed
 *  - Maximum confidentiality of some input data (this is usually derived from a
 *    capability the module requests, e.g. network access to a specific domain).
 *  - Minimum integrity of some input data
 *  - Selective declassification of some input data: If the module can
 *    declassify data, it'll only declassify the marked data and not the rest
 *    (e.g. a specific sensitive input like an API key that it declassifies
 *    while not allowing data sensitive data to come in through other input
 *    parameters)
 *  - Maximum integrity of some output data: The module only endorses part of
 *    the output data. Can be stated as a function of input integrity. E.g. a
 *    fetch module can say that T integrity is only guaranteed if the input url
 *    has `URLTrustedFor<T>`, where T is e.g. "no prompt injection".
 *  - Minimum confidentiality of some output data: The module raises output
 *    confidentiality, typically expressed as a guardrail principal. E.g. a
 *    module that fetches data with an auth key would raise the confidentiality
 *    of the output to the level of the auth key (and also declassify the auth
 *    key, see above).
 *
 * Implementation-wise the first class ("copy over" and partial reads) mean that
 * the rules above are applied more selectively. We have to translate the paths
 * to subset of the state space and manage labels accordingly. Note:
 *  - Field names can have different values than the values. With lists we also
 *    maintain a label for the length and the order. E.g. a module that just
 *    ranks input entries only taints the order and nothing else. A trusted
 *    module that sorts the list then declassifies the order and replaces it
 *    with just the sort criteria's confidentiality. TODO: Can we get set
 *    semantics, i.e. the order is irrelevant?
 *  - Integrity is expressed over a group of values and the same values
 *    independently don't have the same integrity. Consider lat & long and a
 *    module that reads two pairs and swaps them. We'll have to write that as
 *    four subsets of the original integrity, and don't recombine them
 *    automatically afterwards.
 *
 * The label constraints should all directly translate to constraints as above.
 * The trickiest one is output integrity, because now we have to consider the
 * meet of `ModuleOutput<Foo, ..>` and the extra constraint. TODO: Maybe instead
 * such cases are actually an expressin that replaces the ModuleOutput default?
 * We still need to model the trust in the module here though, it's essentially
 * a meet between that and this claim.
 */

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
