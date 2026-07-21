/**
 * Test Pattern: Note Markdown Viewer
 *
 * Tests for the note-md pattern:
 * - Static properties: isHidden, isMentionable
 * - Wiki-link conversion in processedContent
 * - Checkbox toggle via checkboxToggle stream
 * - Note passthrough
 * - hasBacklinks computed
 * - Edge cases: regular markdown links, special characters, missing checkboxes, empty content
 * - sourceNoteRef and goToEdit action
 *
 * Run: deno task cf test packages/patterns/notes/note-md.test.tsx --verbose
 */
import { action, assert, NAME, pattern, Writable } from "commonfabric";
import NoteMd from "./note-md.tsx";
import Note from "./note.tsx";

export default pattern(() => {
  // Writable content cell for basic testing
  const contentCell = new Writable("Hello world");

  const md = NoteMd({
    note: {
      title: "Test Note",
      content: "Simple content",
      backlinks: [],
    },
    content: contentCell,
  });

  // Second instance with wiki-links in content
  const wikiContent = new Writable(
    "See [[Alice (abc123)]] and [[Bob (def456)]] for details",
  );

  const mdWiki = NoteMd({
    note: {
      title: "Wiki Note",
      content: "Fallback content",
      backlinks: [],
    },
    content: wikiContent,
  });

  // Third instance with no wiki-links (passthrough)
  const plainContent = new Writable("No links here, just plain text.");

  const mdPlain = NoteMd({
    note: {
      title: "Plain Note",
      content: "Fallback",
      backlinks: [],
    },
    content: plainContent,
  });

  // Fourth instance with checkboxes for toggle testing
  const checkboxContent = new Writable(
    "- [ ] Task one\n- [x] Task two\n- [ ] Task three",
  );

  const mdCheckbox = NoteMd({
    note: {
      title: "Checkbox Note",
      content: "Fallback",
      backlinks: [],
    },
    content: checkboxContent,
  });

  // === Edge case - regular markdown links ===
  const regularLinksContent = new Writable(
    "Use [regular markdown](http://example.com) links",
  );

  const mdRegularLinks = NoteMd({
    note: {
      title: "Regular Links Note",
      content: "Fallback",
      backlinks: [],
    },
    content: regularLinksContent,
  });

  // === Edge case - wiki-link with special characters ===
  const specialCharsContent = new Writable("See [[Alice & Bob (special-123)]]");

  const mdSpecialChars = NoteMd({
    note: {
      title: "Special Chars Note",
      content: "Fallback",
      backlinks: [],
    },
    content: specialCharsContent,
  });

  // === Edge case - no checkboxes ===
  const noCheckboxContent = new Writable("Just regular text\nNo checkboxes");

  const mdNoCheckbox = NoteMd({
    note: {
      title: "No Checkbox Note",
      content: "Fallback",
      backlinks: [],
    },
    content: noCheckboxContent,
  });

  // === Edge case - mixed markdown with checkboxes ===
  const mixedContent = new Writable(
    "# Title\n\n- [ ] First task\n\nSome text\n\n- [x] Second task",
  );

  const mdMixed = NoteMd({
    note: {
      title: "Mixed Note",
      content: "Fallback",
      backlinks: [],
    },
    content: mixedContent,
  });

  // === Edge case - empty content ===
  const emptyContent = new Writable("");

  const mdEmpty = NoteMd({
    note: {
      title: "Empty Note",
      content: "Fallback",
      backlinks: [],
    },
    content: emptyContent,
  });

  // === Edge case - whitespace only content ===
  const whitespaceContent = new Writable("   \n\n   ");

  const mdWhitespace = NoteMd({
    note: {
      title: "Whitespace Note",
      content: "Fallback",
      backlinks: [],
    },
    content: whitespaceContent,
  });

  // === Instance with sourceNoteRef for Edit navigation ===
  const sourceNote = Note({
    title: "Source Note",
    content: "Original editable content",
    isHidden: false,
  });

  const sourceContent = new Writable("Content from source");

  const mdWithSource = NoteMd({
    note: {
      title: "Source Note",
      content: "Original editable content",
      backlinks: [],
    },
    sourceNoteRef: sourceNote,
    content: sourceContent,
  });

  // Instance WITHOUT sourceNoteRef (tests wish-based fallback path)
  const mdWithoutSource = NoteMd({
    note: {
      title: "No Source Note",
      content: "Content without source ref",
      backlinks: [],
    },
    content: new Writable("Direct content"),
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

  // === Toggle on content with no checkboxes ===
  const action_toggle_no_checkbox = action(() => {
    mdNoCheckbox.checkboxToggle.send({ detail: { index: 0, checked: true } });
  });

  // === Toggle first checkbox in mixed content ===
  const action_check_mixed_first = action(() => {
    mdMixed.checkboxToggle.send({ detail: { index: 0, checked: true } });
  });

  // === Toggle second checkbox in mixed content ===
  const action_uncheck_mixed_second = action(() => {
    mdMixed.checkboxToggle.send({ detail: { index: 1, checked: false } });
  });

  // === Test goToEdit with sourceNoteRef ===
  const action_go_to_edit_with_source = action(() => {
    mdWithSource.goToEdit.send();
  });

  // === Test goToEdit without sourceNoteRef (wish fallback) ===
  const action_go_to_edit_without_source = action(() => {
    mdWithoutSource.goToEdit.send();
  });

  // ==========================================================================
  // Assertions - Static properties
  // ==========================================================================

  const assert_is_hidden = assert(() => md.isHidden === true);
  const assert_is_not_mentionable = assert(() => md.isMentionable === false);

  // ==========================================================================
  // Assertions - Note passthrough
  // ==========================================================================

  const assert_note_title = assert(
    () => md.note?.title === "Test Note",
  );

  // ==========================================================================
  // Assertions - NAME computed
  // ==========================================================================

  const assert_name = assert(
    () => md[NAME] === "📖 Test Note",
  );

  // ==========================================================================
  // Assertions - Wiki-link conversion
  // ==========================================================================

  // Content with wiki-links should be converted
  const assert_wiki_links_converted = assert(
    () =>
      mdWiki.processedContent ===
        "See [Alice](/of:abc123) and [Bob](/of:def456) for details",
  );

  // Content without wiki-links passes through unchanged
  const assert_plain_passthrough = assert(
    () => mdPlain.processedContent === "No links here, just plain text.",
  );

  // After updating wiki content, new links should be converted
  const assert_multi_wiki_converted = assert(
    () =>
      mdWiki.processedContent ===
        "Link to [Charlie](/of:ghi789) and back to [Alice](/of:abc123)",
  );

  // ==========================================================================
  // Assertions - Checkbox toggle
  // ==========================================================================

  const assert_initial_checkboxes = assert(
    () =>
      mdCheckbox.processedContent ===
        "- [ ] Task one\n- [x] Task two\n- [ ] Task three",
  );

  // After checking first: "- [x] Task one\n- [x] Task two\n- [ ] Task three"
  const assert_first_checked = assert(
    () =>
      mdCheckbox.processedContent ===
        "- [x] Task one\n- [x] Task two\n- [ ] Task three",
  );

  // After unchecking second: "- [x] Task one\n- [ ] Task two\n- [ ] Task three"
  const assert_second_unchecked = assert(
    () =>
      mdCheckbox.processedContent ===
        "- [x] Task one\n- [ ] Task two\n- [ ] Task three",
  );

  // After checking third: "- [x] Task one\n- [ ] Task two\n- [x] Task three"
  const assert_third_checked = assert(
    () =>
      mdCheckbox.processedContent ===
        "- [x] Task one\n- [ ] Task two\n- [x] Task three",
  );

  // ==========================================================================
  // Assertions - hasBacklinks computed
  // ==========================================================================

  const assert_no_backlinks_initially = assert(
    () => md.hasBacklinks === false,
  );

  // ==========================================================================
  // Assertions - Edge cases - wiki-links
  // ==========================================================================

  const assert_regular_links_passthrough = assert(
    () =>
      mdRegularLinks.processedContent ===
        "Use [regular markdown](http://example.com) links",
  );

  const assert_special_chars_converted = assert(
    () =>
      mdSpecialChars.processedContent === "See [Alice & Bob](/of:special-123)",
  );

  // ==========================================================================
  // Assertions - Edge cases - checkboxes
  // ==========================================================================

  const assert_no_checkbox_content = assert(
    () => mdNoCheckbox.processedContent === "Just regular text\nNo checkboxes",
  );

  const assert_no_checkbox_unchanged = assert(
    () => mdNoCheckbox.processedContent === "Just regular text\nNo checkboxes",
  );

  const assert_mixed_initial = assert(
    () =>
      mdMixed.processedContent ===
        "# Title\n\n- [ ] First task\n\nSome text\n\n- [x] Second task",
  );

  const assert_mixed_first_checked = assert(
    () =>
      mdMixed.processedContent ===
        "# Title\n\n- [x] First task\n\nSome text\n\n- [x] Second task",
  );

  const assert_mixed_second_unchecked = assert(
    () =>
      mdMixed.processedContent ===
        "# Title\n\n- [x] First task\n\nSome text\n\n- [ ] Second task",
  );

  // ==========================================================================
  // Assertions - Edge cases - empty/missing content
  // ==========================================================================

  const assert_empty_content = assert(
    () => mdEmpty.processedContent === "",
  );

  const assert_whitespace_preserved = assert(
    () => mdWhitespace.processedContent === "   \n\n   ",
  );

  // ==========================================================================
  // Assertions - sourceNoteRef path
  // ==========================================================================

  const assert_source_name = assert(
    () => mdWithSource[NAME] === "📖 Source Note",
  );

  const assert_source_content = assert(
    () => mdWithSource.processedContent === "Content from source",
  );

  const assert_source_is_hidden = assert(
    () => mdWithSource.isHidden === true,
  );

  // Verify state is stable after goToEdit with sourceNoteRef
  const assert_source_stable_after_edit = assert(
    () => mdWithSource.processedContent === "Content from source",
  );

  // Verify state is stable after goToEdit without sourceNoteRef (wish fallback)
  const assert_no_source_stable_after_edit = assert(
    () => mdWithoutSource.processedContent === "Direct content",
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

      // === hasBacklinks computed ===
      { assertion: assert_no_backlinks_initially },

      // === Edge cases - wiki-links ===
      { assertion: assert_regular_links_passthrough },
      { assertion: assert_special_chars_converted },

      // === Edge cases - checkboxes ===
      { assertion: assert_no_checkbox_content },
      { action: action_toggle_no_checkbox },
      { assertion: assert_no_checkbox_unchanged },

      { assertion: assert_mixed_initial },
      { action: action_check_mixed_first },
      { assertion: assert_mixed_first_checked },
      { action: action_uncheck_mixed_second },
      { assertion: assert_mixed_second_unchecked },

      // === Edge cases - empty/missing content ===
      { assertion: assert_empty_content },
      { assertion: assert_whitespace_preserved },

      // === sourceNoteRef tests ===
      { assertion: assert_source_name },
      { assertion: assert_source_content },
      { assertion: assert_source_is_hidden },
      { action: action_go_to_edit_with_source },
      { assertion: assert_source_stable_after_edit },
      { action: action_go_to_edit_without_source },
      { assertion: assert_no_source_stable_after_edit },
    ],
    md,
    mdWiki,
    mdPlain,
    mdCheckbox,
    mdRegularLinks,
    mdSpecialChars,
    mdNoCheckbox,
    mdMixed,
    mdEmpty,
    mdWhitespace,
    mdWithSource,
    mdWithoutSource,
  };
});
