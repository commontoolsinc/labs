import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts, { type DiagnosticMessageChain } from "typescript";
import {
  CompilationError,
  type DiagnosticMessageTransformer,
} from "../typescript/diagnostics/errors.ts";

// errors.ts keeps a local mirror of `ts.flattenDiagnosticMessageText` so the
// module stays free of typescript value imports (it is boot-eager in the
// runtime worker). These tests pin the mirror to the real thing.

function chainDiagnostic(
  messageText: string | DiagnosticMessageChain,
): ts.Diagnostic {
  return {
    category: ts.DiagnosticCategory.Error,
    code: 1,
    file: undefined,
    start: undefined,
    length: undefined,
    messageText,
  };
}

describe("CompilationError message flattening", () => {
  it("flattens nested message chains byte-identically to typescript", () => {
    const chain: DiagnosticMessageChain = {
      messageText: "Type 'A' is not assignable to type 'B'.",
      category: ts.DiagnosticCategory.Error,
      code: 2322,
      next: [
        {
          messageText: "Types of property 'x' are incompatible.",
          category: ts.DiagnosticCategory.Error,
          code: 2326,
          next: [
            {
              messageText: "Type 'string' is not assignable to type 'number'.",
              category: ts.DiagnosticCategory.Error,
              code: 2322,
            },
            {
              messageText: "A sibling elaboration at the same depth.",
              category: ts.DiagnosticCategory.Message,
              code: 0,
            },
          ],
        },
      ],
    };
    const error = new CompilationError({ diagnostic: chainDiagnostic(chain) });
    expect(error.message).toBe(ts.flattenDiagnosticMessageText(chain, "\n"));
    expect(error.type).toBe("ERROR");
  });

  it("passes plain string messages through and classifies module-not-found", () => {
    const plain = new CompilationError({
      diagnostic: chainDiagnostic("Cannot find module './missing.ts'."),
    });
    expect(plain.type).toBe("MODULE_NOT_FOUND");
    expect(plain.message).toBe("Cannot find module './missing.ts'.");
  });

  it("applies a message transformer over the flattened text", () => {
    const transformer: DiagnosticMessageTransformer = {
      transform: (message) =>
        message.includes("assignable") ? `friendly: ${message}` : null,
    };
    const chain: DiagnosticMessageChain = {
      messageText: "Type 'A' is not assignable to type 'B'.",
      category: ts.DiagnosticCategory.Error,
      code: 2322,
    };
    const error = new CompilationError(
      { diagnostic: chainDiagnostic(chain) },
      transformer,
    );
    expect(error.message).toBe(
      `friendly: ${ts.flattenDiagnosticMessageText(chain, "\n")}`,
    );
  });
});
