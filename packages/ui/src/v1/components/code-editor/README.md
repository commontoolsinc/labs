# CommonCodeEditor

A CodeMirror 6 based code editor web component for CommonTools.

## Features

- Syntax highlighting for multiple languages (JavaScript, TypeScript, JSX, CSS,
  HTML, JSON, Markdown)
- Dark theme (One Dark)
- Auto-completion and basic IDE features
- Real-time change events
- Customizable language mode

## Usage

```typescript
const code = cell<string>("const foo=1");

<common-code-editor
  language="text/javascript"
  source={code}
  onChange="updateCode({code})"
>
</common-code-editor>;
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

- `change`: Fired when the text content changes (debounced by 500ms). The event
  detail contains:
  - `id`: The element's ID
  - `value`: The current source code
  - `language`: The current language mode
