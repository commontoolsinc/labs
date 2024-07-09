const HTML_ELEMENT_EVENTS = `
abort
animationcancel
animationend
animationiteration
animationstart
auxclick
blur
cancel
canplay
canplaythrough
change
click
close
contextmenu
copy
cuechange
cut
dblclick
drag
dragend
dragenter
dragexit
dragleave
dragover
dragstart
drop
durationchange
emptied
ended
error
focus
focusin
focusout
fullscreenchange
fullscreenerror
gotpointercapture
input
invalid
keydown
keypress
keyup
load
loadeddata
loadedmetadata
loadend
loadstart
lostpointercapture
mousedown
mouseenter
mouseleave
mousemove
mouseout
mouseover
mouseup
paste
pause
play
playing
pointercancel
pointerdown
pointerenter
pointerleave
pointermove
pointerout
pointerover
pointerup
progress
ratechange
reset
resize
scroll
securitypolicyviolation
seeked
seeking
select
selectionchange
selectstart
stalled
submit
suspend
timeupdate
toggle
touchcancel
touchend
touchmove
touchstart
transitioncancel
transitionend
transitionrun
transitionstart
volumechange
waiting
wheel
`;

function* splitLines(lines: string) {
  for (const line of lines.split("\n")) {
    yield line.trim();
  }
}

/** Get an array of all element events */
export const allHTMLElementEvents = (): Set<keyof HTMLElementEventMap> => {
  return new Set(
    splitLines(HTML_ELEMENT_EVENTS)
  ) as Set<keyof HTMLElementEventMap>;
}

const ELEMENT_EVENTS_SET = allHTMLElementEvents();

export const isElementEventKey = (
  key: unknown
): key is keyof HTMLElementEventMap => {
  if (typeof key !== "string") {
    return false;
  }
  return ELEMENT_EVENTS_SET.has(key as keyof HTMLElementEventMap);
}
