import { JoinExpression, Composite, Integrity } from "./principals.ts";
import { Guardrail } from "./guardrail.ts";

/**
 * Guardrails are in CNF form, but we have to allow for multiple at the same
 * time as a join, so we get a join of meets of joins as confidentiality.
 *
 * TODO: We also have to keep stashing declassification events per level, for
 * when they are needed to expand guardrails lazily. For now we'll expand
 * guardrails eagerly, which might add more things at the meet level.
 */

export interface Label {
  integrity: JoinExpression<Composite<Integrity>>;
  confidentiality: JoinExpression<Guardrail>;
}
