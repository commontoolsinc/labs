import type { Module, toEncodableForm, toJSON } from "./types.ts";

/**
 * Builds the `toJSON` member, which is what `JSON.stringify` consults -- that
 * name and no other.
 *
 * Both a module and its factory carry it. A factory because pattern source
 * holds one, so `JSON.stringify(someFactory)` has to keep answering. A module
 * because `JSON.stringify` reaches one THROUGH A GRAPH: the internal graph
 * (`serializePatternGraph`) is the in-memory instantiation representation and
 * so holds live modules, whose `implementation` is a function. Absent this,
 * stringifying such a graph drops every function-valued member silently and
 * yields nodes with no executable body and no `$implRef` naming one.
 *
 * It delegates rather than duplicating: `toEncodableForm` is the serializer,
 * and this is the name the JSON protocol looks it up by.
 */
export function jsonMemberFor(module: Module & toEncodableForm): toJSON {
  return { toJSON: () => module.toEncodableForm() };
}

/**
 * Installs that member on a module, in place, and types the result as carrying
 * it.
 *
 * Assigned rather than written into the module's own literal because
 * `jsonMemberFor` reads the module eagerly, and inside that literal it is not
 * yet bound. A factory built by `Object.assign`ing the module picks the member
 * up along with the rest.
 *
 * This lives in a leaf module so that `builder/pattern.ts` -- which builds a
 * module of its own and which `builder/module.ts` imports -- can reach it
 * without closing an import cycle.
 */
export function withJsonMember<M extends Module & toEncodableForm>(
  module: M,
): M & toJSON {
  return Object.assign(module, jsonMemberFor(module));
}
