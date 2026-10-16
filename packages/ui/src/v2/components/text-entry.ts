/**
 * Whether `event` is aimed at somewhere the user is entering text: a
 * contenteditable element, an input, a textarea, or a select.
 *
 * Editors such as `cf-code-editor` and `cf-input` keep their editable element
 * in a shadow root, and an event that crosses a shadow boundary reports the
 * shadow host as its target, so the composed path is what names the element
 * the event came from. Elements are read structurally, so one from another
 * document or realm still matches.
 */
export function targetsTextEntry(event: Event): boolean {
  for (const node of event.composedPath()) {
    const element = node as { tagName?: unknown; isContentEditable?: unknown };
    if (typeof element.tagName !== "string") continue;
    if (element.isContentEditable === true) return true;
    switch (element.tagName.toLowerCase()) {
      case "input":
      case "textarea":
      case "select":
        return true;
    }
  }
  return false;
}
