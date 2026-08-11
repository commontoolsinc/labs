import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { cloneIfNecessary } from "@/value-clone.ts";
import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import { hashOf } from "@/value-hash.ts";
import { newDefaultJsonCodec } from "@/codecs.ts";
import { EmptyReconstructionContext } from "@/codec-common/index.ts";
import { codeSpanIn } from "./parse-code-span.ts";

/**
 * Builds a class instance whose `constructor.name` holds the given text.
 * `Function.prototype.name` is configurable, so a value arriving from user
 * data can carry any name at all -- including backticks.
 */
function instanceNamed(name: string): object {
  class Named {}
  Object.defineProperty(Named, "name", { value: name });
  return new Named();
}

// Text that breaks a hand-written pair of backticks: a lone backtick closes
// the span early, a doubled run defeats a two-backtick delimiter, and a
// leading backtick merges into the opening delimiter.
const HOSTILE = ["a`b", "a``b", "`lead", "trail`", "`", "``"];

describe("message quoting", () => {
  describe("`FabricHash.fromString()`", () => {
    it("hands back the source it refused, whatever backticks it held", () => {
      for (const source of HOSTILE) {
        let message = "";
        try {
          FabricHash.fromString(source);
        } catch (e) {
          message = (e as Error).message;
        }
        expect(codeSpanIn(message, "Invalid content hash string: "))
          .toBe(source);
      }
    });
  });

  describe("`hashOf()`", () => {
    it("hands back the class name it refused", () => {
      for (const name of HOSTILE) {
        let message = "";
        try {
          hashOf(instanceNamed(name) as never);
        } catch (e) {
          message = (e as Error).message;
        }
        expect(codeSpanIn(message, "unsupported object type ")).toBe(name);
      }
    });
  });

  describe("`cloneIfNecessary()`", () => {
    it("hands back the class name it refused", () => {
      for (const name of HOSTILE) {
        let message = "";
        try {
          cloneIfNecessary(instanceNamed(name) as never);
        } catch (e) {
          message = (e as Error).message;
        }
        expect(codeSpanIn(message, "Cannot clone: ")).toBe(name);
      }
    });
  });

  describe("`JsonCodec.decode()`", () => {
    it("hands back the excerpt it refused", () => {
      const context = new EmptyReconstructionContext(false);
      for (const data of HOSTILE) {
        let message = "";
        try {
          newDefaultJsonCodec().decode(data, context);
        } catch (e) {
          message = (e as Error).message;
        }
        expect(
          codeSpanIn(message, "Not a JSON-encoded `FabricValue` string: "),
        ).toBe(data);
      }
    });
  });
});
