# CommonCodeEditor

A CodeMirror 6 based code editor web component for CommonTools.

## Features

- Syntax highlighting for multiple languages (JavaScript, TypeScript, JSX, CSS, HTML, JSON, Markdown)
- Dark theme (One Dark)
- Auto-completion and basic IDE features
- Real-time change events
- Customizable language mode

## Usage

```typescript
import "@commontools/ui/v1/components/code-editor/common-code-editor.ts";

// In your HTML or Lit template:
<common-code-editor
  language="text/javascript"
  source="console.log('Hello, world!');"
  @text-change="${(e) => console.log('Text changed', e.detail)}"
></common-code-editor>
```

## Properties

- `source`: The initial source code content
- `language`: The language mode (MimeType). Supported values:
  - `text/css`
  - `text/html`
  - `text/javascript`
  - `text/x.jsx`
  - `text/x.typescript`
  - `application/json`
  - `text/markdown` (default)

## Events

- `text-change`: Fired when the text content changes (debounced by 500ms). The event detail contains:
  - `id`: The element's ID
  - `value`: The current source code
  - `language`: The current language mode

## Example

See `example.html` for a working example with language switching.