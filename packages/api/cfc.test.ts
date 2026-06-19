import { assertEquals } from "@std/assert";
import { CFC_ATOM_TYPE, CFC_RUNTIME_SUBJECT, cfcAtom } from "./cfc.ts";

Deno.test("cfcAtom.resource builds a resource atom (default and explicit subject/scope)", () => {
  assertEquals(cfcAtom.resource("MyClass"), {
    type: CFC_ATOM_TYPE.Resource,
    class: "MyClass",
    subject: CFC_RUNTIME_SUBJECT,
  });

  const scope = cfcAtom.builtin("scope-source");
  assertEquals(cfcAtom.resource("MyClass", "did:web:example", scope), {
    type: CFC_ATOM_TYPE.Resource,
    class: "MyClass",
    subject: "did:web:example",
    scope,
  });
});

Deno.test("cfcAtom.caveat builds a caveat atom (with and without `by`)", () => {
  const source = cfcAtom.builtin("source");

  assertEquals(cfcAtom.caveat("derived-from", source), {
    type: CFC_ATOM_TYPE.Caveat,
    kind: "derived-from",
    source,
  });

  const by = cfcAtom.injectionSafe();
  assertEquals(cfcAtom.caveat("derived-from", source, by), {
    type: CFC_ATOM_TYPE.Caveat,
    kind: "derived-from",
    source,
    by,
  });
});

Deno.test("cfcAtom.builtin builds a builtin atom", () => {
  assertEquals(cfcAtom.builtin("navigateTo"), {
    type: CFC_ATOM_TYPE.Builtin,
    name: "navigateTo",
  });
});

Deno.test("cfcAtom.injectionSafe builds an injection-safe atom", () => {
  assertEquals(cfcAtom.injectionSafe(), {
    type: CFC_ATOM_TYPE.InjectionSafe,
  });
});

Deno.test("cfcAtom.userSurfaceInput builds a user-surface-input atom", () => {
  assertEquals(cfcAtom.userSurfaceInput("did:key:user", "chat", "digest123"), {
    type: CFC_ATOM_TYPE.UserSurfaceInput,
    user: "did:key:user",
    surface: "chat",
    valueDigest: "digest123",
  });
});

Deno.test("cfcAtom.promptSlotBound builds a prompt-slot-bound atom", () => {
  const source = cfcAtom.userSurfaceInput("did:key:user", "chat", "digest123");
  assertEquals(
    cfcAtom.promptSlotBound(
      source,
      "instruction",
      "kernel",
      "did:web:example",
      "chat",
      "digest123",
    ),
    {
      type: CFC_ATOM_TYPE.PromptSlotBound,
      source,
      role: "instruction",
      kernelName: "kernel",
      subject: "did:web:example",
      surface: "chat",
      valueDigest: "digest123",
    },
  );
});
