/**
 * The audit is an expression of the specification, so the specification is
 * what has to be able to break it. Each citation quotes the clause it rests
 * on verbatim; this suite reads every cited document and requires each quote
 * to still be in it. A clause reworded past its quote fails here, which is
 * the notice that the check resting on it needs rewriting too.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, join } from "@std/path";

import { STRUCTURAL_CHECKS } from "../checks/structural.ts";
import { SPEC_CITATIONS } from "../citations.ts";

const REPO_ROOT = join(
  dirname(fromFileUrl(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/**
 * A document's text with every run of whitespace collapsed to one space.
 *
 * A quote is a sentence, and a sentence in a Markdown document is wrapped at
 * whatever column it happened to land on. Comparing against the collapsed
 * text makes a rewrap invisible and a rewording loud, which is the split the
 * suite wants.
 */
const collapsed = (text: string): string => text.replace(/\s+/g, " ");

const documents = new Map<string, string>();
const documentText = async (doc: string): Promise<string> => {
  const held = documents.get(doc);
  if (held !== undefined) {
    return held;
  }
  const text = collapsed(await Deno.readTextFile(join(REPO_ROOT, doc)));
  documents.set(doc, text);
  return text;
};

describe("citation drift", () => {
  describe("SPEC_CITATIONS", () => {
    for (const [key, citation] of Object.entries(SPEC_CITATIONS)) {
      it(`quotes ${key} verbatim from its document`, async () => {
        expect(await documentText(citation.doc)).toContain(
          collapsed(citation.quote),
        );
      });
    }

    it("names a clause id for every citation", () => {
      expect(
        Object.values(SPEC_CITATIONS).filter((citation) =>
          citation.clause.length === 0
        ),
      ).toEqual([]);
    });

    it("carries no line numbers, which a document edit silently invalidates", () => {
      expect(
        Object.values(SPEC_CITATIONS).filter((citation) =>
          /:\d+/.test(citation.doc)
        ),
      ).toEqual([]);
    });
  });

  describe("STRUCTURAL_CHECKS", () => {
    it("cites at least one clause from every check", () => {
      expect(
        STRUCTURAL_CHECKS.filter((check) => check.citations.length === 0)
          .map((check) => check.id),
      ).toEqual([]);
    });

    it("cites only clauses the citation table holds", () => {
      const known = new Set<string>(
        Object.values(SPEC_CITATIONS).map((citation) => citation.clause),
      );
      expect(
        STRUCTURAL_CHECKS.flatMap((check) =>
          check.citations
            .filter((citation) => !known.has(citation.clause))
            .map((citation) => `${check.id} ${citation.clause}`)
        ),
      ).toEqual([]);
    });
  });
});
