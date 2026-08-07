/**
 * Real-piece / real-registry test for Record extraction field discovery.
 *
 * Extraction discovers a module's fields through the module registry, which is
 * the single source of truth for a module's field shapes. It does not read a
 * schema off a live piece. This test builds a real Note piece (not a mock) and
 * asserts that the registry-driven discovery the extractor uses surfaces real
 * module types' fields — including notes, whose content field must not silently
 * drop from extraction.
 *
 * Run: deno task cf test packages/patterns/record/extraction/schema-discovery.test.tsx --root packages/patterns --verbose
 */
import { computed, pattern, TESTS } from "commonfabric";
import { getSchemaForType } from "./schema-utils.ts";
import { getFieldToTypeMapping } from "../registry.ts";
import Note from "../../notes/note.tsx";

export default pattern(() => {
  // A real piece (not a hand-built mock): confirms we are in a live runtime.
  const notesPiece = Note({ linkPattern: "" });

  const notesSchema = getSchemaForType("notes");
  const addressSchema = getSchemaForType("address");
  const unknownSchema = getSchemaForType("does-not-exist");
  const fieldMap = getFieldToTypeMapping();

  const assert_real_piece_built = computed(() =>
    notesPiece !== undefined && notesPiece !== null
  );

  // The notes module's content field is discoverable via the registry.
  const assert_notes_content_discoverable = computed(() =>
    notesSchema?.properties?.content !== undefined
  );

  // A representative data module also exposes its fields.
  const assert_address_has_fields = computed(() =>
    addressSchema?.properties !== undefined &&
    Object.keys(addressSchema.properties).length > 0
  );

  // The registry-driven field map is populated and carries the record-title
  // pseudo-mapping the extractor relies on.
  const assert_map_built = computed(() =>
    Object.keys(fieldMap).length > 0 && fieldMap.name === "record-title"
  );

  // The notes alias routes back to the notes module. (The `content` field is
  // shared with text-import, another content source, so it is not asserted to
  // any single owner.)
  const assert_notes_routed = computed(() => fieldMap.notes === "notes");

  // The content field reaches some real source module.
  const assert_content_routed = computed(() => fieldMap.content !== undefined);

  // An unknown module type yields no schema (no accidental catch-all).
  const assert_unknown_type_undefined = computed(() =>
    unknownSchema === undefined
  );

  return {
    [TESTS]: [
      { assertion: assert_real_piece_built },
      { assertion: assert_notes_content_discoverable },
      { assertion: assert_address_has_fields },
      { assertion: assert_map_built },
      { assertion: assert_notes_routed },
      { assertion: assert_content_routed },
      { assertion: assert_unknown_type_undefined },
    ],
    notesPiece,
  };
});
