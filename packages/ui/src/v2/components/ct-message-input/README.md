# CT Message Input Component

A message input component that combines a text input with a send button, commonly used in chat interfaces, comment sections, and messaging applications.

## Installation

```bash
npm install @your-org/ui
```

## Usage

### Basic Usage

```html
<ct-message-input
  placeholder="Type a message..."
  @ct-send="${(e) => console.log(e.detail.message)}"
></ct-message-input>
```

### JavaScript Usage

```javascript
import '@your-org/ui/ct-message-input';

const messageInput = document.querySelector('ct-message-input');

// Listen for send events
messageInput.addEventListener('ct-send', (event) => {
  const message = event.detail.message;
  console.log('Message sent:', message);
});

// Programmatically set value
messageInput.value = 'Hello!';

// Disable the input
messageInput.disabled = true;
```

## Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `placeholder` | `string` | `""` | Placeholder text for the input field |
| `buttonText` | `string` | `"Send"` | Text displayed on the send button |
| `disabled` | `boolean` | `false` | Whether the input and button are disabled |
| `value` | `string` | `""` | Current value of the input field |

## Events

| Event | Detail | Description |
|-------|--------|-------------|
| `ct-send` | `{ message: string }` | Fired when the send button is clicked or Enter is pressed |

## Styling

The component can be styled using CSS custom properties:

```css
ct-message-input {
  /* Height of the input and button */
  --ct-message-input-height: 3rem;
  
  /* Gap between input and button */
  --ct-message-input-gap: 0.5rem;
}
```

### CSS Parts

The component exposes the following parts for styling:

- `input` - The ct-input element
- `button` - The ct-button element

```css
ct-message-input::part(input) {
  border-radius: 20px;
}

ct-message-input::part(button) {
  border-radius: 20px;
}
```

## Examples

### Chat Interface

```html
<div class="chat-container">
  <div class="messages">
    <!-- Messages appear here -->
  </div>
  <ct-message-input
    placeholder="Type your message..."
    @ct-send="${handleSendMessage}"
  ></ct-message-input>
</div>
```

### Comment Form

```html
<ct-message-input
  placeholder="Add a comment..."
  button-text="Post"
  @ct-send="${handlePostComment}"
></ct-message-input>
```

### Search Bar

```html
<ct-message-input
  placeholder="Search..."
  button-text="Search"
  @ct-send="${handleSearch}"
></ct-message-input>
```

## Keyboard Shortcuts

- **Enter**: Send the message (same as clicking the send button)
- **Shift+Enter**: Currently not supported (single-line input only)

## Accessibility

The component is keyboard accessible and works with screen readers. The input field and button are properly linked for assistive technologies.

## Browser Support

This component uses modern web standards and requires browsers that support:
- Custom Elements v1
- Shadow DOM v1
- ES6+ JavaScript features

## Migration from v1

If you're migrating from the v1 `common-send-message` component:

```html
<!-- Old v1 -->
<common-send-message
  name="Send"
  placeholder="Type here..."
  @messagesend="${handleSend}"
></common-send-message>

<!-- New v2 -->
<ct-message-input
  button-text="Send"
  placeholder="Type here..."
  @ct-send="${handleSend}"
></ct-message-input>
```

Key differences:
- Event name changed from `messagesend` to `ct-send`
- Property `name` is now `button-text`
- Uses v2 components (`ct-input` and `ct-button`) internally
- Better TypeScript support
- More consistent with v2 component patterns