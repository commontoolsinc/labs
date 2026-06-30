/**
 * Test Pattern: AirtableImporter
 *
 * Verifies the importer waits for usable auth before binding Airtable API
 * actions into the UI.
 *
 * Run: deno task cf test packages/patterns/airtable/airtable-importer.test.tsx --root packages/patterns --verbose
 */
import { computed, pattern, UI } from "commonfabric";
import { hasText } from "../test/vnode-helpers.ts";
import AirtableImporter from "./airtable-importer.tsx";

export default pattern(() => {
  const importer = AirtableImporter({
    selectedBaseId: "",
    selectedTableId: "",
  });

  const assert_initial_data_empty = computed(() =>
    importer.bases.length === 0 &&
    importer.tables.length === 0 &&
    importer.records.length === 0 &&
    importer.recordCount === 0
  );

  const assert_selected_names_empty = computed(() =>
    importer.selectedBaseName === "" &&
    importer.selectedTableName === ""
  );

  const assert_waiting_message_is_rendered = computed(() =>
    hasText(importer[UI], "Waiting for Airtable connection") &&
    hasText(
      importer[UI],
      "Connect Airtable with base and record read access before loading bases, tables, or records.",
    )
  );

  const assert_fetch_controls_are_hidden_until_auth = computed(() =>
    !hasText(importer[UI], "Load Bases") &&
    !hasText(importer[UI], "Load Tables") &&
    !hasText(importer[UI], "Fetch Records")
  );

  return {
    tests: [
      { assertion: assert_initial_data_empty },
      { assertion: assert_selected_names_empty },
      { assertion: assert_waiting_message_is_rendered },
      { assertion: assert_fetch_controls_are_hidden_until_auth },
    ],
    importer,
  };
});
