/// <cts-enable />
/**
 * Test Pattern: Note Markdown Viewer
 *
 * Tests for the note-md pattern:
 * - Static properties: isHidden, isMentionable
 * - Wiki-link conversion in processedContent
 * - Checkbox toggle via checkboxToggle stream
 * - Note passthrough
 *
 * Run: deno task ct test packages/patterns/notes/note-md.test.tsx --verbose
 */
import { action, computed, NAME, pattern, Writable } from "commontools";
import NoteMd from "./note-md.tsx";

export default pattern(() => {
  // Writable content cell for checkbox toggle testing
  const contentCell = Writable.of("Hello world");

  const md = NoteMd({
    note: {
      title: "Test Note",
      content: "Simple content",
      backlinks: [],
      noteId: "test-note-1",
    },
    content: contentCell,
  });

  // Second instance with wiki-links in content
  const wikiContent = Writable.of(
    "See [[Alice (abc123)]] and [[Bob (def456)]] for details",
  );

  const mdWiki = NoteMd({
    note: {
      title: "Wiki Note",
      content: "Fallback content",
      backlinks: [],
      noteId: "test-note-2",
    },
    content: wikiContent,
  });

  // Third instance with no wiki-links (passthrough)
  const plainContent = Writable.of("No links here, just plain text.");

  const mdPlain = NoteMd({
    note: {
      title: "Plain Note",
      content: "Fallback",
      backlinks: [],
      noteId: "test-note-3",
    },
    content: plainContent,
  });

  // Fourth instance with checkboxes for toggle testing
  const checkboxContent = Writable.of(
    "- [ ] Task one\n- [x] Task two\n- [ ] Task three",
  );

  const mdCheckbox = NoteMd({
    note: {
      title: "Checkbox Note",
      content: "Fallback",
      backlinks: [],
      noteId: "test-note-4",
    },
    content: checkboxContent,
  });

  // ==========================================================================
  // Actions
  // ==========================================================================

  // Toggle first checkbox (index 0) to checked
  const action_check_first = action(() => {
    mdCheckbox.checkboxToggle.send({ detail: { index: 0, checked: true } });
  });

  // Toggle second checkbox (index 1) to unchecked
  const action_uncheck_second = action(() => {
    mdCheckbox.checkboxToggle.send({ detail: { index: 1, checked: false } });
  });

  // Toggle third checkbox (index 2) to checked
  const action_check_third = action(() => {
    mdCheckbox.checkboxToggle.send({ detail: { index: 2, checked: true } });
  });

  // Update wiki content to have multiple links
  const action_set_multi_wiki = action(() => {
    wikiContent.set(
      "Link to [[Charlie (ghi789)]] and back to [[Alice (abc123)]]",
    );
  });

  // ==========================================================================
  // Assertions - Static properties
  // ==========================================================================

  const assert_is_hidden = computed(() => md.isHidden === true);
  const assert_is_not_mentionable = computed(() => md.isMentionable === false);

  // ==========================================================================
  // Assertions - Note passthrough
  // ==========================================================================

  const assert_note_title = computed(
    () => md.note?.title === "Test Note",
  );
  const assert_note_id = computed(
    () => md.note?.noteId === "test-note-1",
  );

  // ==========================================================================
  // Assertions - NAME computed
  // ==========================================================================

  const assert_name = computed(
    () => md[NAME] === "📖 Test Note",
  );

  // ==========================================================================
  // Assertions - Wiki-link conversion
  // ==========================================================================

  // Content with wiki-links should be converted
  const assert_wiki_links_converted = computed(
    () =>
      mdWiki.processedContent ===
        "See [Alice](/of:abc123) and [Bob](/of:def456) for details",
  );

  // Content without wiki-links passes through unchanged
  const assert_plain_passthrough = computed(
    () => mdPlain.processedContent === "No links here, just plain text.",
  );

  // After updating wiki content, new links should be converted
  const assert_multi_wiki_converted = computed(
    () =>
      mdWiki.processedContent ===
        "Link to [Charlie](/of:ghi789) and back to [Alice](/of:abc123)",
  );

  // ==========================================================================
  // Assertions - Checkbox toggle
  // ==========================================================================

  const assert_initial_checkboxes = computed(
    () =>
      mdCheckbox.processedContent ===
        "- [ ] Task one\n- [x] Task two\n- [ ] Task three",
  );

  // After checking first: "- [x] Task one\n- [x] Task two\n- [ ] Task three"
  const assert_first_checked = computed(
    () =>
      mdCheckbox.processedContent ===
        "- [x] Task one\n- [x] Task two\n- [ ] Task three",
  );

  // After unchecking second: "- [x] Task one\n- [ ] Task two\n- [ ] Task three"
  const assert_second_unchecked = computed(
    () =>
      mdCheckbox.processedContent ===
        "- [x] Task one\n- [ ] Task two\n- [ ] Task three",
  );

  // After checking third: "- [x] Task one\n- [ ] Task two\n- [x] Task three"
  const assert_third_checked = computed(
    () =>
      mdCheckbox.processedContent ===
        "- [x] Task one\n- [ ] Task two\n- [x] Task three",
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    tests: [
      // === Static properties ===
      { assertion: assert_is_hidden },
      { assertion: assert_is_not_mentionable },

      // === Note passthrough ===
      { assertion: assert_note_title },
      { assertion: assert_note_id },

      // === NAME ===
      { assertion: assert_name },

      // === Wiki-link conversion ===
      { assertion: assert_wiki_links_converted },
      { assertion: assert_plain_passthrough },

      // === Update wiki content and verify ===
      { action: action_set_multi_wiki },
      { assertion: assert_multi_wiki_converted },

      // === Checkbox toggle ===
      { assertion: assert_initial_checkboxes },

      { action: action_check_first },
      { assertion: assert_first_checked },

      { action: action_uncheck_second },
      { assertion: assert_second_unchecked },

      { action: action_check_third },
      { assertion: assert_third_checked },
    ],
    md,
    mdWiki,
    mdPlain,
    mdCheckbox,
  };
});
