---
status: historical
created: 2026-07-28
archived: 2026-07-28
reason: "Completion report for the cf view source/rendered mode and its first Markdown renderer."
---

# `cf view` rendered Markdown impact report

## Outcome

`cf view` now has a general source/rendered view mode. A language can provide a
rendered representation without adding language checks to the pager. Markdown
is the first implementation.

Source remains the default. `V` switches the interactive pager between source
and rendered views. `--rendered` selects rendered output at startup and in the
non-interactive `--plain` path.

The Markdown renderer uses the Markdown block parser to distinguish containers
and block types. It formats ATX and setext headings, strong and emphasized text,
deleted text, inline and fenced code, links, images, block quotes, ordered and
unordered lists, task items, thematic rules, tables, escapes, entities, and
embedded HTML text.

## Coordinate contract

A rendered representation retains the exact source text in the document model.
It also returns exactly one display line for each source line. Delimiters that
have no rendered content, such as code fences and a setext heading underline,
become blank display lines.

This contract preserves the pager's source-line coordinate system. It avoids a
second set of mappings for line numbers, structure ranges, diff hunks, file
folds, and edit buffers. Multiline inline constructs retain their physical
source-line boundaries even when Markdown's inline rules normalize whitespace.

## Feature interactions

| Feature | Effect |
| --- | --- |
| Line numbering | Numbers continue to identify source lines. Markup-only lines keep their number even when their rendered display line is blank. Diff file-line numbering remains unchanged. |
| Editing | Pressing `e` in rendered view switches to source before showing the text cursor. Editing, revert, save, and commit amendment continue to operate on source text. The view remains in source after editing. |
| Diff view | Markdown bodies on both the old and new sides are rendered. File headers, hunk headers, diff markers, addition and deletion backgrounds, and non-Markdown files remain unchanged. When a changed rendered line omits source content, becomes empty, or becomes identical to a different line on the other side, it stays in source form so changes such as heading levels and link destinations remain visible. No-newline metadata does not separate the old and new lines for this check. A hunk without a matching workspace file or old blob stays in source form when it begins after the first file line, because omitted earlier lines could have opened a fence, HTML block, list, or other Markdown container that changes how the fragment renders. |
| Diff expansion | Expansion changes the retained source diff and baseline, then rebuilds the active rendered lines. The selection, source line positions, and hunk edges remain aligned. |
| File folding and jump list | File ranges and diff metadata stay in source coordinates. Existing folds survive a view change, and jump targets do not move. |
| Structure navigation | Markdown heading nodes retain their source line ranges. A selected heading remains selected across a view change. Selection endpoints cover the transformed rendered line when its source columns no longer correspond, while unchanged lines in mixed diffs retain their exact columns. |
| Info cards | Cards use the parsed source document. Their source tab therefore shows Markdown source even when the main pager is rendered. |
| Search | Search follows the visible representation. Switching modes recomputes matches, so hidden markup and hidden link destinations stop matching in rendered view. |
| Wrapping and horizontal movement | Wrapping remains enabled across a view change and is recalculated from the new text. The same source line stays at the top. Horizontal position returns to the first column because source and rendered columns differ. |
| Jump to definition | Markdown has no semantic definition service, as before. In a mixed diff, languages without a rendered representation keep their source lines and exact semantic columns. A target on a transformed line lands at that rendered line's start because there is no source-to-rendered column map. |
| Non-interactive output | Output stays source by default. `--rendered` prints formatted Markdown, with rich ANSI styling when color is enabled and formatted plain text when color is disabled. |
| Other languages | JSON, YAML, Python, TypeScript, and unrecognized inputs remain source views. Their language implementations can add rendered lines through the same optional contract. |

## Verification at completion

Focused tests covered source and rendered toggling, initial rendered output,
source cards, automatic source editing, source line numbers, inline and block
Markdown formatting, diff markers and backgrounds, missing-workspace diff
fragments, and expansion of a verified compact Markdown hunk.

The existing Markdown, language selection, session, frame rendering, diff
document, diff semantics, and diff editing suites also passed with the feature
enabled.

The complete CLI suite passed. The repository-wide format, lint, type,
dependency, documentation, and package test tasks also passed.
