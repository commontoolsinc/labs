# common-html

`common-html` is the HTML rendering library used by Common, with the goal of **rendering untrusted DOM** within a larger context (e.g. "Common OS").

> [!WARNING]  
> The goals and code here are under heavy development, currently with no claims of isolating untrusted code. Feedback welcome on improving these ideas.

## Goals

The untrusted DOM must have the following properties, with strategies to achieve them:

* **Context Isolation**: Components may only access its own "environment", and cannot access the top-level DOM, nor slotted/untrusted children elements' data.
* **No Egress**: Components must not enable requests to remote services, such that data can be exfiltrated to a different host.
* **Visual Containment**: Components must not render outside of its parents' visual context, such that top-level "trusted" components can not be confused with untrusted components.
  * TBD how to accomplish this, but most likely a property on the parent/OS container preventing rendering outside of its bounds.

## Strategies

There are a few properties this library must uphold in order to achieve the goal of rendering untrusted DOM. All decisions on (un)supported features should map back to one of these justifications.

* **Isolated script execution**: Arbitrary scripts cannot be executed. Event handlers are run in a sandboxed context with no access to browser capabilities. Events received by handlers must not contain other references to other elements. 
* **Mediated external resources**: HTML attributes and CSS properties may request remote resources e.g. `div { background-image: url(..); }`, and may encode data to be exfiltrated via changing properties, and as such, must not be supported.

## Implementation

In order to support our isolation goals, we take the approach of allowlisting various elements, events, and attributes, hardened with [CSP] directives.

### CSP

> [!IMPORTANT]  
> TODO

### Sanitization

In order to support our goals, the rendered DOM sanitizes, or filters/replaces, potentially nonconforming elements, attributes and events.

#### Elements

We only allow "safe" elements with limited functionality. In the future, we may enable more after evaluating isolation, or by offering our own versions of elements (e.g. `<img>` to `<common-img>`, `<a>` to `<common-a>`) that mediate access to remote resources.

The following [element types from MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Element) are allowed:

* Content Sectioning (e.g. `<nav>`, `<header>`)
* Text Content (e.g. `<div>`, `<ul>`)
* Inline Text Semantics (e.g. `<b>`, `<em>`)
  * **EXCEPTION**: Anchor links (`<a>`), as exfiltration
* Demarcating Edits (e.g. `<ins>`, `<del>`)
* Table Content (e.g. `<thead>`, `<table>`)
* Forms (e.g. `<form>`, `<input>`)
  * **WARNING**: Forms are necessary, but will need to think through more isolation scenarios

The following element types are **NOT** allowed currently.

* Image and Multimedia (e.g. `<img>`, `<video>`)
* Embedded Content (e.g. `<iframe>`, `<embed>`)
* SVG and MathML (e.g. `<svg>`, `<math>`)
* Scripting (e.g. `<canvas>`, `<script>`)
* Web Components (e.g. `<slot>`, `<template>`)

#### Attributes

For now, all native HTML element attributes should be sanitized, with the exception of `class`, using OS-provided styling framework (e.g. shoelace). 

#### Styles

We'll need to wrangle styles a bit more and ensure they cannot render outside of their context before allowing inline styles.

#### Events

A list of events we may safely implement. As handlers are executed in an isolated environment, we'll need to consider how to handle things like bubbling, `event.preventDefault()` and [passive event listeners](https://developer.mozilla.org/en-US/docs/Web/API/EventTarget/addEventListener#passive).

| Name | Type | Elements | 
| ---- | ---- | -------- |
| [blur] | [FocusEvent] |
| [focus] | [FocusEvent] |
| [focusin] | [FocusEvent] |
| [focusout] | [FocusEvent] |
| [drag] | [DragEvent] |
| [dragend] | [DragEvent] |
| [dragenter] | [DragEvent] |
| [dragleave] | [DragEvent] |
| [dragover] | [DragEvent] |
| [dragstart] | [DragEvent] |
| [drop] | [DragEvent] |
| [keydown] | [KeyboardEvent] |
| [keyup] | [KeyboardEvent] |
| [input] | [InputEvent] | `<input>` |
| [click] | [MouseEvent] |
| [dblclick] | [MouseEvent] |
| [mousedown] | [MouseEvent] |
| [mouseenter] | [MouseEvent] |
| [mouseleave] | [MouseEvent] |
| [mousemove] | [MouseEvent] |
| [mouseout] | [MouseEvent] |
| [mouseover] | [MouseEvent] |
| [mouseup] | [MouseEvent] |
| [auxclick] | [PointerEvent] |
| [contextmenu] | [PointerEvent] |
| [pointercancel] | [PointerEvent] |
| [pointerdown] | [PointerEvent] |
| [pointerenter] | [PointerEvent] |
| [pointerleave] | [PointerEvent] |
| [pointermove] | [PointerEvent] |
| [pointerout] | [PointerEvent] |
| [pointerover] | [PointerEvent] |
| [pointerup] | [PointerEvent] |
| [scroll] | [Event] |
| [scrollend] | [Event] |
| [touchcancel] | [TouchEvent] |
| [touchend] | [TouchEvent] |
| [touchmove] | [TouchEvent] |
| [touchstart] | [TouchEvent] |
| [wheel] | [WheelEvent] |
| [submit] | [SubmitEvent] | `<form>` |
| [reset] | [Event] | `<form>` |
| [formdata] | [FormDataEvent] | `<form>` |

#### Unsupported

A non-exhaustive list of unsupported element events that we may consider supporting in the future.

<details>
<summary>

Unsupported Events

</summary>

| Name | Type | Elements | 
| ---- | ---- | -------- |
| [animationcancel] | [AnimationEvent] |
| [animationend] | [AnimationEvent] |
| [animationiteration] | [AnimationEvent] |
| [animationstart] | [AnimationEvent] |
| [copy] | [ClipboardEvent] |
| [cut] | [ClipboardEvent] |
| [paste] | [ClipboardEvent] |
| [compositionstart] | [CompositionEvent] |
| [compositionend] | [CompositionEvent] |
| [compositionupdate] | [CompositionEvent] |
| [contentvisibilityautostatechange] | [ContentVisibilityAutoStateChangeEvent] |
| [fullscreenchange] | [Event] |
| [fullscreenerror] | [Event] |
| [beforeinput] | [InputEvent] |
| [gotpointercapture] | [PointerEvent] |
| [lostpointercapture] | [PointerEvent] |
| [securitypolicyviolation] | [SecurityPolicyViolationEvent] |
| [transitioncancel] | [TransitionEvent] |
| [transitionend] | [TransitionEvent] |
| [transitionrun] | [TransitionEvent] |
| [transitionstart] | [TransitionEvent] |
| [contextlost] | [Event] | `<canvas>` |
| [contextrestored] | [Event] | `<canvas>` |
| [webglcontextcreationerror] | [WebGLContextEvent] | `<canvas>` |
| [webglcontextlost] | [WebGLContextEvent] | `<canvas>` |
| [webglcontextrestored] | [WebGLContextEvent] | `<canvas>` |

</details>


[CSP]: https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP

[Event]: https://developer.mozilla.org/en-US/docs/Web/API/Event
[MouseEvent]: https://developer.mozilla.org/en-US/docs/Web/API/MouseEvent
[KeyboardEvent]: https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent
[TouchEvent]: https://developer.mozilla.org/en-US/docs/Web/API/TouchEvent
[FocusEvent]: https://developer.mozilla.org/en-US/docs/Web/API/FocusEvent
[CompositionEvent]: https://developer.mozilla.org/en-US/docs/Web/API/CompositionEvent
[AnimationEvent]: https://developer.mozilla.org/en-US/docs/Web/API/AnimationEvent
[InputEvent]: https://developer.mozilla.org/en-US/docs/Web/API/InputEvent
[PointerEvent]: https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent
[ContentVisibilityAutoStateChangeEvent]: https://developer.mozilla.org/en-US/docs/Web/API/ContentVisibilityAutoStateChangeEvent
[ClipboardEvent]: https://developer.mozilla.org/en-US/docs/Web/API/ClipboardEvent
[SecurityPolicyViolationEvent]: https://developer.mozilla.org/en-US/docs/Web/API/SecurityPolicyViolationEvent
[TransitionEvent]: https://developer.mozilla.org/en-US/docs/Web/API/TransitionEvent
[WheelEvent]: https://developer.mozilla.org/en-US/docs/Web/API/WheelEvent
[SubmitEvent]: https://developer.mozilla.org/en-US/docs/Web/API/SubmitEvent
[FormDataEvent]: https://developer.mozilla.org/en-US/docs/Web/API/FormDataEvent
[DragEvent]: https://developer.mozilla.org/en-US/docs/Web/API/DragEvent
[WebGLContextEvent]: https://developer.mozilla.org/en-US/docs/Web/API/WebGLContextEvent

[keydown]: https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event
[keyup]: https://developer.mozilla.org/en-US/docs/Web/API/Element/keyup_event
[keypress]: https://developer.mozilla.org/en-US/docs/Web/API/Element/keypress_event
[click]: https://developer.mozilla.org/en-US/docs/Web/API/Element/click_event
[dblclick]: https://developer.mozilla.org/en-US/docs/Web/API/Element/dblclick_event
[mouseup]: https://developer.mozilla.org/en-US/docs/Web/API/Element/mouseup_event
[mousedown]: https://developer.mozilla.org/en-US/docs/Web/API/Element/mousedown_event
[touchstart]: https://developer.mozilla.org/en-US/docs/Web/API/Element/touchstart_event
[touchend]: https://developer.mozilla.org/en-US/docs/Web/API/Element/touchend_event
[touchmove]: https://developer.mozilla.org/en-US/docs/Web/API/Element/touchmove_event
[touchcancel]: https://developer.mozilla.org/en-US/docs/Web/API/Element/touchcancel_event
[focus]: https://developer.mozilla.org/en-US/docs/Web/API/Element/focus_event
[blur]: https://developer.mozilla.org/en-US/docs/Web/API/Element/blur_event
[focusin]: https://developer.mozilla.org/en-US/docs/Web/API/Element/focusin_event
[focusout]: https://developer.mozilla.org/en-US/docs/Web/API/Element/focusout_event
[compositionstart]: https://developer.mozilla.org/en-US/docs/Web/API/Element/compositionstart_event
[compositionend]: https://developer.mozilla.org/en-US/docs/Web/API/Element/compositionend_event
[compositionupdate]: https://developer.mozilla.org/en-US/docs/Web/API/Element/compositionupdate_event
[animationcancel]: https://developer.mozilla.org/en-US/docs/Web/API/Element/animationcancel_event
[animationend]: https://developer.mozilla.org/en-US/docs/Web/API/Element/animationend_event
[animationiteration]: https://developer.mozilla.org/en-US/docs/Web/API/Element/animationiteration_event
[animationstart]: https://developer.mozilla.org/en-US/docs/Web/API/Element/animationstart_event
[contentvisibilityautostatechange]: https://developer.mozilla.org/en-US/docs/Web/API/Element/contentvisibilityautostatechange_event
[copy]: https://developer.mozilla.org/en-US/docs/Web/API/Element/copy_event
[cut]: https://developer.mozilla.org/en-US/docs/Web/API/Element/cut_event
[paste]: https://developer.mozilla.org/en-US/docs/Web/API/Element/paste_event
[beforeinput]: https://developer.mozilla.org/en-US/docs/Web/API/Element/beforeinput_event
[auxclick]: https://developer.mozilla.org/en-US/docs/Web/API/Element/auxclick_event
[contextmenu]: https://developer.mozilla.org/en-US/docs/Web/API/Element/contextmenu_event
[fullscreenchange]: https://developer.mozilla.org/en-US/docs/Web/API/Element/fullscreenchange_event
[fullscreenerror]: https://developer.mozilla.org/en-US/docs/Web/API/Element/fullscreenerror_event
[input]: https://developer.mozilla.org/en-US/docs/Web/API/Element/input_event
[mouseenter]: https://developer.mozilla.org/en-US/docs/Web/API/Element/mouseenter_event
[mouseleave]: https://developer.mozilla.org/en-US/docs/Web/API/Element/mouseleave_event
[mousemove]: https://developer.mozilla.org/en-US/docs/Web/API/Element/mousemove_event
[mouseout]: https://developer.mozilla.org/en-US/docs/Web/API/Element/mouseout_event
[mouseover]: https://developer.mozilla.org/en-US/docs/Web/API/Element/mouseover_event
[gotpointercapture]: https://developer.mozilla.org/en-US/docs/Web/API/Element/gotpointercapture_event
[lostpointercapture]: https://developer.mozilla.org/en-US/docs/Web/API/Element/lostpointercapture_event
[pointercancel]: https://developer.mozilla.org/en-US/docs/Web/API/Element/pointercancel_event
[pointerdown]: https://developer.mozilla.org/en-US/docs/Web/API/Element/pointerdown_event
[pointerenter]: https://developer.mozilla.org/en-US/docs/Web/API/Element/pointerenter_event
[pointerleave]: https://developer.mozilla.org/en-US/docs/Web/API/Element/pointerleave_event
[pointermove]: https://developer.mozilla.org/en-US/docs/Web/API/Element/pointermove_event
[pointerout]: https://developer.mozilla.org/en-US/docs/Web/API/Element/pointerout_event
[pointerover]: https://developer.mozilla.org/en-US/docs/Web/API/Element/pointerover_event
[pointerup]: https://developer.mozilla.org/en-US/docs/Web/API/Element/pointerup_event
[scroll]: https://developer.mozilla.org/en-US/docs/Web/API/Element/scroll_event
[scrollend]: https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollend_event
[securitypolicyviolation]: https://developer.mozilla.org/en-US/docs/Web/API/Element/securitypolicyviolation_event
[transitioncancel]: https://developer.mozilla.org/en-US/docs/Web/API/Element/transitioncancel_event
[transitionend]: https://developer.mozilla.org/en-US/docs/Web/API/Element/transitionend_event
[transitionrun]: https://developer.mozilla.org/en-US/docs/Web/API/Element/transitionrun_event
[transitionstart]: https://developer.mozilla.org/en-US/docs/Web/API/Element/transitionstart_event
[wheel]: https://developer.mozilla.org/en-US/docs/Web/API/Element/wheel_event
[submit]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLFormElement/submit_event
[reset]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLFormElement/reset_event
[formdata]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLFormElement/formdata_event
[contextlost]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/contextlost_event
[contextrestored]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/contextrestored_event
[webglcontextcreationerror]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/webglcontextcreationerror_event
[webglcontextlost]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/webglcontextlost_event
[webglcontextrestored]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/webglcontextrestored_event
[drag]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/drag_event
[dragend]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/dragend_event
[dragenter]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/dragenter_event
[dragleave]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/dragleave_event
[dragover]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/dragover_event
[dragstart]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/dragstart_event
[drop]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/drop_event