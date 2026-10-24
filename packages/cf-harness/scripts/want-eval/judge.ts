/**
 * What the shape eval asks of a job, the way the Weaver asks a want said now:
 * the result schema `WantSaidNow.swift` declares, and the instructions lifted
 * out of that Swift.
 */

/** One kind of offer, its payload required, as the Weaver reads it. */
const offerShape = (kind: string, payload: string, says: string) => ({
  type: "object",
  required: ["kind", payload],
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: [kind] },
    [payload]: { type: "string", description: says },
  },
});

/**
 * The result schema the Weaver asks a want's job for, as `WantSaidNow.swift`
 * declares it: a short answer, and offers in the shapes the Weaver reads. An
 * offer item is closed, so a looser copy here would refuse every offer.
 */
export const RESULT_SCHEMA = {
  type: "object",
  required: ["answer", "offers"],
  additionalProperties: false,
  properties: {
    answer: {
      type: "string",
      description: "A short reply for the tile: what you did, or the answer. " +
        "No links, loom ids or commands; those go in offers.",
    },
    offers: {
      type: "array",
      description:
        "What the person can do next in their Weaver. A Weaver command " +
        "(rename, invite, socialize, deploy, or one listed in the context) is a " +
        "command offer with the exact slash line, never prose in the answer.",
      maxItems: 8,
      items: {
        anyOf: [
          offerShape("open_loom", "loomId", "A loom id, loom-…"),
          offerShape("open_url", "url", "An https:// address"),
          offerShape(
            "command",
            "line",
            "The exact slash line the person would type, values filled in",
          ),
        ],
      },
    },
  },
};

/**
 * The Weaver's want instructions, lifted out of the Swift `source` that
 * declares them, or `undefined` when it declares none.
 */
export const instructionsFromSwift = (source: string): string | undefined => {
  const match = /static let instructions = """\n([\s\S]*?)\n {4}"""/.exec(
    source,
  );
  return match?.[1].replace(/ \\\n\s*/g, " ").split("\n").map((line) =>
    line.startsWith("    ") ? line.slice(4) : line
  ).join("\n");
};
