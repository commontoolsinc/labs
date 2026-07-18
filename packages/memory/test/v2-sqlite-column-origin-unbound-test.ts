// The column-origin binding's failure paths, exercised in a module instance
// where the FFI is NOT bound. Deno gives each test file its own module state, so
// `cached` starts undefined here — the state the server sees before the first
// labeled query, and the state a bind failure leaves behind. The sibling file
// v2-sqlite-column-origin-test.ts covers the bound, happy path.

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  columnOrigins,
  columnOriginUnavailableReason,
  ensureColumnOriginAvailable,
} from "../v2/sqlite/column-origin.ts";

// Runs first, while nothing has bound the FFI and no reason has been recorded:
// columnOrigins must refuse rather than read through a null library handle, and
// the message names the call the caller skipped.
Deno.test("columnOrigins throws before the FFI is bound", () => {
  assertThrows(
    () => columnOrigins(null, 1),
    Error,
    "column-origin FFI not bound",
  );
  assertThrows(
    () => columnOrigins(null, 1),
    Error,
    "ensureColumnOriginAvailable() must resolve",
  );
});

// Point @db/sqlite's own loader at a file that is not a library — the shape of a
// libsqlite3 built without SQLITE_ENABLE_COLUMN_METADATA, which loads for
// @db/sqlite but exposes no column-origin symbols. ensureColumnOriginAvailable
// must resolve false, record why, and make a later labeled read throw the reason.
Deno.test("a bind failure is recorded and surfaces in the reason and the throw", async () => {
  const notALibrary = Deno.makeTempFileSync({ suffix: ".dylib" });
  Deno.writeTextFileSync(notALibrary, "not a library");
  const previous = Deno.env.get("DENO_SQLITE_PATH");
  Deno.env.set("DENO_SQLITE_PATH", notALibrary);
  try {
    assertEquals(await ensureColumnOriginAvailable(), false);

    const reason = columnOriginUnavailableReason();
    assertStringIncludes(reason ?? "", "$DENO_SQLITE_PATH");
    assertStringIncludes(reason ?? "", notALibrary);

    // A labeled read now fails loudly, carrying the recorded reason rather than
    // the generic "must resolve first" message.
    assertThrows(() => columnOrigins(null, 1), Error, reason!);
  } finally {
    if (previous === undefined) {
      Deno.env.delete("DENO_SQLITE_PATH");
    } else {
      Deno.env.set("DENO_SQLITE_PATH", previous);
    }
    Deno.removeSync(notALibrary);
  }
});
