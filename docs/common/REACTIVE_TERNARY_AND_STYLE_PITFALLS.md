# Reactive Ternary and Style Pitfalls

**TL;DR:** Reactive values (derived/cell) are proxies that are always truthy in ternaries. Layout style properties (`justifyContent`, `flexDirection`) don't work with reactive values. Use `ifElse` with static styles instead.

## Quick Reference

```tsx
// BAD - ternary with reactive value (proxy always truthy)
const result = reactiveBoolean ? "yes" : "no";  // ALWAYS "yes"

// BAD - reactive value in layout style
<div style={{ justifyContent: reactiveDerived }}>  // Won't work

// GOOD - use ifElse with static styles
ifElse(reactiveBoolean,
  <div style={{ justifyContent: "flex-end" }}>content</div>,
  <div style={{ justifyContent: "flex-start" }}>content</div>
)
```

---

## Background

This document captures pitfalls discovered while developing a chat pattern where messages needed conditional alignment:
- **My messages**: Blue bubbles, RIGHT-aligned
- **Other's messages**: Grey bubbles, LEFT-aligned with avatar
- **System messages**: Centered, italic

## What Didn't Work

### Attempt 1: Ternary Operators with Reactive Values

```tsx
// BROKEN - proxy is always truthy
const isMyMessage = derive(meta, m => m?.isMyMessage ?? false);

<div style={{
  flexDirection: isMyMessage ? "row-reverse" : "row"  // Always evaluates to "row-reverse"
}}>
```

**Why it fails:** Derived values are reactive proxies. In JavaScript, any object (including proxies) is truthy. So `isMyMessage ? x : y` ALWAYS returns `x`, regardless of the underlying boolean value.

### Attempt 2: Pre-computed Style Values in Derive

```tsx
// Pre-compute in derive
const messagesMeta = derive({ messages, myName }, ({ messages, myName }) => {
  return messages.map(msg => ({
    isMyMessage: msg.author === myName,
    justifyContent: msg.author === myName ? "flex-end" : "flex-start",  // Computed correctly!
  }));
});

// Extract as reactive value
const justifyContent = derive(meta, m => m?.justifyContent ?? "flex-start");

// Use in style
<div style={{ justifyContent }}>  // STILL BROKEN
```

**Why it fails:** Even though `justifyContent` correctly resolves to `"flex-end"` or `"flex-start"` as a string, when used as a style property value, layout properties like `justifyContent` don't work with reactive values. The CSS property receives the proxy object, not the string.

### Attempt 3: flex-direction: row-reverse

```tsx
<div style={{ flexDirection: "row-reverse" }}>
  {isMyMessage ? null : avatar}
  <div>bubble</div>
</div>
```

**Why it fails:** `flex-direction: row-reverse` reverses the ORDER of children. When `isMyMessage` is true, the avatar renders as `null`, leaving only ONE child. With one child, there's nothing to reverse - the single element stays where it is (left side).

## What Works

### Solution: ifElse with Completely Separate Containers

```tsx
return ifElse(
  isSystem,
  // SYSTEM MESSAGE - centered, STATIC styles
  <div style={{
    width: "100%",
    display: "flex",
    justifyContent: "center",  // STATIC string literal
  }}>
    <div>{msg.content}</div>
  </div>,

  ifElse(
    isMyMessage,
    // MY MESSAGE - right aligned, STATIC styles
    <div style={{
      width: "100%",
      display: "flex",
      justifyContent: "flex-end",  // STATIC string literal
    }}>
      <div style={{ backgroundColor: "#007AFF", color: "white" }}>
        {msg.content}
      </div>
    </div>,

    // OTHER'S MESSAGE - left aligned, STATIC styles
    <div style={{
      width: "100%",
      display: "flex",
      justifyContent: "flex-start",  // STATIC string literal
    }}>
      {avatar}
      <div style={{ backgroundColor: "#E5E5EA" }}>
        {msg.content}
      </div>
    </div>
  )
);
```

**Why it works:** `ifElse` is a CommonTools primitive that correctly evaluates reactive boolean conditions and renders the appropriate branch. Each branch has STATIC style values (literal strings, not reactive proxies).

## Key Rules

### 1. Never Use Reactive Values in Ternary Operators

```tsx
// BAD - proxy is always truthy
const color = isActive ? "blue" : "gray";

// GOOD - use ifElse
{ifElse(isActive, <BlueComponent />, <GrayComponent />)}
```

### 2. Never Use Reactive Values for Layout Style Properties

```tsx
// BAD - layout property with reactive value
<div style={{ justifyContent: reactiveJustify }}>

// GOOD - static string in separate ifElse branches
ifElse(condition,
  <div style={{ justifyContent: "flex-end" }}>,
  <div style={{ justifyContent: "flex-start" }}>
)
```

### 3. Some Style Properties DO Work with Reactive Values

These appear to work (based on testing):
- `backgroundColor`
- `color`
- `marginBottom`

These do NOT work:
- `justifyContent`
- `flexDirection`
- Likely other layout properties

### 4. Pre-computing Metadata is Still Valuable

Even though we can't use pre-computed styles directly, pre-computing boolean flags for use with `ifElse` is still the right approach:

```tsx
const messagesMeta = derive({ messages, myName, users }, ({ messages, myName, users }) => {
  const colorMap = new Map(users.map(u => [u.name, u.color]));

  return messages.map((msg, i) => {
    const prev = messages[i - 1];
    const isMyMessage = msg.author === myName;
    const isSystem = msg.type === "system";
    const isFirstInBlock = !prev || prev.author !== msg.author;

    return {
      isMyMessage,
      isSystem,
      isFirstInBlock,
      shouldShowAvatar: !isMyMessage && isFirstInBlock,
      color: colorMap.get(msg.author) || "#6b7280",
      initials: getInitials(msg.author),
    };
  });
});
```

Then extract and use with `ifElse`:

```tsx
const isMyMessage = derive(meta, m => m?.isMyMessage ?? false);
const shouldShowAvatar = derive(meta, m => m?.shouldShowAvatar ?? false);

return ifElse(isMyMessage, <MyBubble />, <OtherBubble />);
```

### 5. Width: 100% is Required for justify-content

For `justify-content` to work, the flex container must have width to distribute:

```tsx
<div style={{
  width: "100%",        // Container takes full width
  display: "flex",
  justifyContent: "flex-end",  // Now has space to push items right
}}>
```

## Performance Considerations

The `ifElse` approach with separate containers is actually efficient:
- Only the matching branch is rendered
- No extra computation for the non-matching branch
- Pre-computed metadata is O(n) - computed once, used many times
- No re-computation on scroll or viewport changes

## Summary

| Approach | Works? | Why |
|----------|--------|-----|
| Ternary with reactive | No | Proxy always truthy |
| Reactive in layout styles | No | CSS receives proxy, not string |
| flex-direction: row-reverse | No | Single child has nothing to reverse |
| ifElse with static styles | Yes | Correct branch with literal values |

The fundamental insight: **Use `ifElse` to select between complete, statically-styled elements rather than trying to inject reactive values into shared element styles.**
