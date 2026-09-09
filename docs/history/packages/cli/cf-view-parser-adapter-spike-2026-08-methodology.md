---
status: historical
created: 2026-08-11
archived: 2026-08-11
reason: "Methodology retained after removing the executable cf view parser-adapter spike."
---

# `cf view` parser-adapter spike methodology

This artifact records the exact source shapes, adapter rules, correctness
checks, and sampling procedure behind the
[`cf view` parser-adapter spike](cf-view-parser-adapter-spike-2026-08.md).
The executable harness and its parser dependencies are not retained.

## Source construction

Every source placed `café` before the repeated measured forms so later parser
ranges exercised non-ASCII offset handling. A representative unit was repeated
until another copy would exceed the language's target byte count. A language
comment filled the remaining bytes exactly. The result had no final newline.

| Language | Target bytes | Prefix before repeated units | Padding |
| --- | ---: | --- | --- |
| Python | 100,009 | `# café appears before measured tokens` | `#` followed by `x` |
| Go | 100,206 | the same comment followed by `package spike` | `//` followed by `x` |
| shell | 100,127 | the same comment after the Bash shebang and `set -euo pipefail` | `#` followed by `x` |
| HTML | 100,178 | `<!-- café appears before measured tokens -->` | an HTML comment filled with `x` |

The repeated Python unit was:

```python
@decorator
class RenderedItem[T]:
    async def render_item(self, value: T | None = None) -> str:
        label = f"value={value!r:>8}"
        return label
```

The repeated Go unit was:

```go
type RenderedItem[T any] struct { Value T }
func (item RenderedItem[T]) renderItem(out chan<- T) {
    go func() { out <- item.Value }()
    values := []T{item.Value}
    _ = values
}
```

The repeated shell unit was:

```bash
render_item() {
  local name="$1"
  printf '%s\n' "${name:-item}"
  for ((i = 0; i < 8; i++)); do
    value="$(printf '%02d' "$i")"
    printf '%s:%s\n' "$name" "$value"
  done
  cat <<'PAYLOAD'
literal $text remains literal
PAYLOAD
}
render_item "entry"
```

The repeated HTML unit was:

```html
<article class="item" data-kind="sample">
  <style>.item { color: rebeccapurple; }</style>
  <script>const renderItem = (value) => `item:${value}`;</script>
  <p title="sample &amp; value">content</p>
</article>
```

## Edits and unfinished inputs

The same-length middle edits allowed incremental parsers to reuse the original
tree without changing later offsets:

| Language | Original | Replacement |
| --- | --- | --- |
| Python | `render_item` | `render_unit` |
| Go | `renderItem` | `renderUnit` |
| shell | `render_item` | `render_unit` |
| HTML | `class="item"` | `class="unit"` |

The benchmark appended these exact unfinished suffixes:

```text
Python: \nasync def unfinished(value: str):\n    text = f"""open
Go:     \nfunc unfinished(value chan string) {\n    go func() {
shell:  \nunfinished() {\n  value=$(printf '%s' "open
HTML:   \n<section><style>.open { color:
```

The selected recovery text was `open` for Python and shell, `unfinished` for
Go, and `color` for HTML.

## Multiline and diff fixtures

The multiline fixtures put `old text` inside these forms:

```text
Python: def render():\n    value = """\nold text\n"""\n    return value
Go:     func render() string {\n    value := `\nold text\n`\n    return value\n}
shell:  render() {\n  cat <<'PAYLOAD'\nold text\nPAYLOAD\n}
HTML:   <script>\nconst value = `\nold text\n`;\n</script>
```

The new side replaced only `old text` with `new text`. Each unified diff used
the language's normal filename and one equal-length hunk. The first context
line began with a decoded UTF-8 byte order mark. The changed line appeared
once as removed text and once as added text. The diff ended with a
`No newline at end of file` marker.

The unavailable-file path parsed joined hunk fragments. The complete-file path
read the new source from a synthetic workspace. Both paths used the candidate
adapter for the old and new filenames.

## Adapter rules

Tree-sitter loaded each official WebAssembly grammar and its published
highlight query. Captures containing `comment`, `string`, `number`, `keyword`,
`function`, `type`, `operator`, or `punctuation` mapped to the corresponding
`TokenClass`. Other captures mapped to `identifier`.

Lezer used `classHighlighter`. The same category names mapped to the same
classes. `variableName.function` mapped to `functionName`, and `typeName`
mapped to `typeName`.

For both candidates, uncovered ranges became `plain` spans. Ranges were sorted
by start and then end. Text already claimed by an earlier range was not emitted
twice. The resulting spans were split at line boundaries without changing the
source text.

The structure mappings were:

| Language | Tree-sitter nodes | Lezer nodes | Pager structure |
| --- | --- | --- | --- |
| Python | `class_definition`, `function_definition` | `ClassDefinition`, `FunctionDefinition` | class, function |
| Go | `type_declaration`, `function_declaration`, `method_declaration` | `TypeDecl`, `FunctionDecl`, `MethodDecl` | type alias, function, method |
| shell | `function_definition` | `FunctionDefinition` | function |
| HTML | `element`, `script_element`, `style_element` | `Element` | section |

Tree-sitter incremental parsing edited the prior tree with the exact old and
new source ranges before parsing the edited source. Lezer created fragments
from the prior tree, applied the same change range, and parsed with those
fragments.

## Required checks

The benchmark recorded a candidate only after all of these checks passed:

- highlighting reconstructed the complete, unfinished, and edited source
  exactly;
- every structure node from the complete source retained the same kind, label,
  start, and end in the unfinished parse;
- the multiline fixture retained its expected string or plain-text class;
- the selected unfinished-input text retained the class recorded in the raw
  results;
- unavailable-file and complete-workspace-file diffs reconstructed the unified
  diff exactly;
- each diff hunk retained parser-produced structure; and
- the first remapped structure node began after the context marker and byte
  order mark.

The focused Python scanner ran the exact-reconstruction and both diff-path
checks. It did not provide parser errors, syntax-tree structure, or incremental
parsing.

## Timing procedure

Each timing group ran its operation once before collecting samples. Full and
incremental parsing collected 30 samples. End-to-end highlighting collected 20
samples. Samples used `performance.now()` immediately before and after one
operation.

Tree-sitter full and incremental samples included parsing and deleting the
returned tree. Lezer samples ended when parsing returned because its persistent
trees did not require deletion. Highlight samples included parsing, applying
the candidate's highlight rules, filling uncovered text, and splitting spans
into lines.

The median sorted the samples and averaged the two middle values for an even
sample count. The 95th percentile selected the sorted value at
`ceil(sample count * 0.95) - 1`.

Startup used five fresh Deno processes per candidate. The clock began at the
first executed statement in the measurement module, after Deno had launched,
and before its dynamic candidate imports. It therefore measured imports and
candidate initialization but not Deno process startup. The Tree-sitter process
initialized the runtime, loaded all four WebAssembly grammars and highlight
queries, parsed an empty source with each grammar, and ran each query. The Lezer
process loaded Python, Go, Bash, and nested HTML with CSS and JavaScript, then
parsed and highlighted an empty source with each parser. The scanner process
loaded the focused Python scanner and highlighted an empty source.

Every dependency came from a warm, isolated Deno cache. No deadline, retry, or
sleep participated in a measurement. Package versions, environment versions,
aggregate results, and dependency-size rules are recorded in the main report.
Every raw timing sample and correctness outcome is retained in the adjacent
[`cf-view-parser-adapter-spike-2026-08-results.json`](cf-view-parser-adapter-spike-2026-08-results.json).
