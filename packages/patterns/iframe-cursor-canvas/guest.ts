/**
 * The cursor canvas guest: a board of shapes several people move at once.
 * Shapes are durable, in the `state` cell. Where each person's pointer is,
 * and where a shape is while someone drags it, are not: they travel through
 * the `cursors` presence room and reach a cell only when a drag ends.
 */

import {
  connectFabric,
  type PresenceRoomEvent,
} from "@commonfabric/iframe-sandbox/guest";

import {
  type CanvasShape,
  DEFAULT_INPUT,
  DEFAULT_STATE,
  type IframeInputData,
  type IframeOutputData,
  type IframeStateData,
  type Point,
} from "./contract.ts";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  createShape,
  displayNameOf,
  DRAG_FACET,
  dragPosition,
  type Peer,
  POINTER_FACET,
  readHue,
  readPeer,
  shapeIndex,
  USER_FACET,
  visitorName,
} from "./model.ts";

/** How the presence room stands, as the status line reports it. */
type RoomStatus = "joining" | "live" | "unsupported" | "lost";

/** A shape the local user holds, from pointer down to pointer up. */
interface LocalDrag {
  /** Id of the shape held. */
  readonly id: string;

  /** Pointer holding it, whose later events are the drag's. */
  readonly pointerId: number;

  /** Where on the shape it was grabbed, as an offset from its corner. */
  readonly grab: Point;

  /** Corner the shape was at when grabbed. */
  readonly from: Point;

  /** Corner the shape is dragged to. */
  position: Point;
}

/** Name and hue the local user is shown as. */
interface Profile {
  /** Display name published to the room. */
  readonly name: string;

  /** Hue of the user's cursor and of the shapes they add, in degrees. */
  readonly hue: number;
}

const SVG = "http://www.w3.org/2000/svg";

const fabric = connectFabric();
const input = fabric.cell<IframeInputData>("input");
const state = fabric.cell<IframeStateData>("state");
const output = fabric.cell<IframeOutputData>("output");
const shapesCell = state.key("shapes");
const cursors = fabric.presence("cursors");

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) throw new Error("Cursor Canvas needs a #root element.");

let hydrated = false;
let profile: Profile | undefined;
let selectedId: string | undefined;
let drag: LocalDrag | undefined;
let roomStatus: RoomStatus = "joining";
let leaveRoom: (() => void) | undefined;
let added = 0;

/** Peers by participant id. */
const peers = new Map<string, Peer>();

/**
 * Positions the local user dropped shapes at whose writes have not been read
 * back yet, by shape id. A shape is drawn here until its cell holds it.
 */
const settling = new Map<string, Point>();

const shapeElements = new Map<string, HTMLDivElement>();

/** Returns every shape the board's cell holds, removed ones included. */
function storedShapes(): readonly CanvasShape[] {
  return state.get()?.shapes ?? [];
}

const cursorElements = new Map<string, HTMLDivElement>();

//
// Document
//

const app = document.createElement("main");
app.className = "app";
app.dataset.testid = "cursor-canvas";

const toolbar = document.createElement("header");
toolbar.className = "toolbar";

const title = document.createElement("h1");
title.textContent = DEFAULT_INPUT.title;

const tools = document.createElement("div");
tools.className = "tools";

function toolButton(label: string, testid: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = true;
  button.dataset.testid = testid;
  tools.append(button);
  return button;
}

const addRectangle = toolButton("Rectangle", "add-rectangle");
const addEllipse = toolButton("Ellipse", "add-ellipse");
const removeSelected = toolButton("Delete", "delete-shape");

const spacer = document.createElement("div");
spacer.className = "spacer";

const roster = document.createElement("ul");
roster.className = "roster";
roster.setAttribute("aria-label", "On this board");
roster.dataset.testid = "roster";

const me = document.createElement("label");
me.className = "me";
const meDot = document.createElement("span");
meDot.className = "dot";
const nameInput = document.createElement("input");
nameInput.type = "text";
nameInput.maxLength = 80;
nameInput.disabled = true;
nameInput.setAttribute("aria-label", "Your display name");
nameInput.dataset.testid = "display-name";
me.append("You", meDot, nameInput);

const status = document.createElement("p");
status.className = "status";
status.setAttribute("role", "status");
status.dataset.testid = "presence-status";

toolbar.append(title, tools, spacer, roster, me, status);

const alert = document.createElement("p");
alert.className = "alert";
alert.setAttribute("role", "alert");

const stage = document.createElement("div");
stage.className = "stage";

const board = document.createElement("div");
board.className = "board";
board.style.width = `${BOARD_WIDTH}px`;
board.style.height = `${BOARD_HEIGHT}px`;
board.dataset.testid = "board";

const hint = document.createElement("p");
hint.className = "hint";
hint.textContent =
  "Add a shape, then drag it. Open this board in a second window to see each other's pointers.";
board.append(hint);
stage.append(board);

app.append(toolbar, alert, stage);
root.append(app);

//
// Rendering
//

function fill(hue: number): string {
  return `hsl(${hue} 90% 90%)`;
}

function ink(hue: number): string {
  return `hsl(${hue} 70% 42%)`;
}

/**
 * Returns the color a peer's cursor and name label are drawn in. At this
 * lightness white text on it keeps a contrast of at least 4.5:1 for every
 * hue, yellow being the least.
 */
function cursorInk(hue: number): string {
  return `hsl(${hue} 70% 27%)`;
}

function showError(cause: unknown): void {
  alert.textContent = cause instanceof Error ? cause.message : String(cause);
}

/** Returns the peer dragging the shape `id`, when one is. */
function holderOf(id: string): Peer | undefined {
  for (const peer of peers.values()) {
    if (peer.drag?.id === id) return peer;
  }
  return undefined;
}

/**
 * Returns where the shape is drawn: where the local user holds or dropped
 * it, else where a peer holds it, else where its cell says it is.
 */
function shownPosition(shape: CanvasShape): Point {
  if (drag?.id === shape.id) return drag.position;
  return settling.get(shape.id) ?? holderOf(shape.id)?.drag?.position ??
    shape.position;
}

function shapeElement(id: string): HTMLDivElement {
  let element = shapeElements.get(id);
  if (!element) {
    element = document.createElement("div");
    element.className = "shape";
    element.dataset.testid = "shape";
    element.dataset.shapeId = id;
    element.addEventListener("pointerdown", (event) => grab(id, event));
    element.addEventListener("pointermove", (event) => moveDrag(event));
    element.addEventListener("pointerup", (event) => endDrag(event, true));
    element.addEventListener(
      "pointercancel",
      (event) => endDrag(event, false),
    );
    shapeElements.set(id, element);
    board.append(element);
  }
  return element;
}

function renderShapes(): void {
  const shapes = storedShapes().filter((shape) => !shape.removed);
  const present = new Set(shapes.map((shape) => shape.id));
  for (const [id, element] of shapeElements) {
    if (present.has(id)) continue;
    element.remove();
    shapeElements.delete(id);
  }
  if (selectedId !== undefined && !present.has(selectedId)) {
    selectedId = undefined;
  }
  // A shape removed while it is held took the element holding the pointer
  // with it, so no pointer-up will end the drag.
  if (drag !== undefined && !present.has(drag.id)) {
    drag = undefined;
    releaseDragFacet();
  }
  for (const shape of shapes) {
    const element = shapeElement(shape.id);
    const position = shownPosition(shape);
    const holder = drag?.id === shape.id ? undefined : holderOf(shape.id);
    element.dataset.kind = shape.kind;
    element.style.width = `${shape.width}px`;
    element.style.height = `${shape.height}px`;
    element.style.transform = `translate(${position.x}px, ${position.y}px)`;
    element.style.background = fill(shape.hue);
    element.style.borderColor = ink(shape.hue);
    element.toggleAttribute("data-selected", selectedId === shape.id);
    element.toggleAttribute("data-dragging", drag?.id === shape.id);
    if (holder) {
      element.dataset.heldBy = holder.name;
      element.style.setProperty("--holder", ink(holder.hue));
    } else {
      delete element.dataset.heldBy;
      element.style.removeProperty("--holder");
    }
  }
  hint.hidden = !hydrated || shapes.length > 0;
  removeSelected.disabled = !hydrated || selectedId === undefined;
}

function cursorElement(participantId: string): HTMLDivElement {
  let element = cursorElements.get(participantId);
  if (!element) {
    element = document.createElement("div");
    element.className = "cursor";
    element.dataset.testid = "peer-cursor";
    const arrow = document.createElementNS(SVG, "svg");
    arrow.setAttribute("width", "18");
    arrow.setAttribute("height", "24");
    arrow.setAttribute("viewBox", "0 0 18 24");
    arrow.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG, "path");
    path.setAttribute(
      "d",
      "M2 2v17l4.8-4.4 3.2 6.9 2.8-1.3-3.1-6.7H16z",
    );
    path.setAttribute("stroke", "#ffffff");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linejoin", "round");
    arrow.append(path);
    element.append(arrow, document.createElement("span"));
    cursorElements.set(participantId, element);
    board.append(element);
  }
  return element;
}

function rosterEntry(name: string, hue: number): HTMLLIElement {
  const entry = document.createElement("li");
  entry.dataset.testid = "participant";
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = ink(hue);
  const label = document.createElement("span");
  label.textContent = name;
  entry.append(dot, label);
  return entry;
}

function renderPeers(): void {
  for (const [participantId, element] of cursorElements) {
    if (peers.get(participantId)?.pointer) continue;
    element.remove();
    cursorElements.delete(participantId);
  }
  const entries: HTMLLIElement[] = [];
  for (const peer of peers.values()) {
    entries.push(rosterEntry(peer.name, peer.hue));
    if (!peer.pointer) continue;
    const element = cursorElement(peer.participantId);
    element.dataset.name = peer.name;
    element.style.transform =
      `translate(${peer.pointer.x}px, ${peer.pointer.y}px)`;
    element.querySelector("path")!.setAttribute("fill", cursorInk(peer.hue));
    const label = element.querySelector("span")!;
    label.textContent = peer.name;
    label.style.background = cursorInk(peer.hue);
  }
  roster.replaceChildren(...entries);
}

function renderStatus(): void {
  status.dataset.status = roomStatus;
  status.textContent = {
    joining: "Connecting…",
    live: peers.size === 0
      ? "Live · only you"
      : `Live · ${peers.size + 1} here`,
    unsupported: "Live cursors unavailable",
    lost: "Live cursors paused",
  }[roomStatus];
}

function render(): void {
  title.textContent = input.get()?.title ?? DEFAULT_INPUT.title;
  addRectangle.disabled = !hydrated || !profile;
  addEllipse.disabled = !hydrated || !profile;
  nameInput.disabled = !hydrated || !profile;
  if (profile) meDot.style.background = ink(profile.hue);
  renderShapes();
  renderPeers();
  renderStatus();
}

//
// Presence
//

/**
 * Publishes to the room, where a rejection needs no handling of its own: a
 * room that cannot take a publication reports its failure to the listener.
 */
function publish(publication: Promise<void>): void {
  publication.catch(() => {});
}

function publishProfile(): void {
  if (!profile || !leaveRoom) return;
  publish(cursors.setName(profile.name));
  publish(cursors.setFacet(USER_FACET, { hue: profile.hue }));
}

function onRoomEvent(event: PresenceRoomEvent): void {
  switch (event.kind) {
    case "snapshot":
      roomStatus = "live";
      peers.clear();
      for (const participant of event.participants) {
        peers.set(participant.participantId, readPeer(participant));
      }
      break;
    case "upsert":
      peers.set(event.participant.participantId, readPeer(event.participant));
      break;
    case "remove":
      peers.delete(event.participantId);
      break;
    case "failure":
      leaveRoom = undefined;
      peers.clear();
      roomStatus = event.error.code === "presence-unsupported"
        ? "unsupported"
        : "lost";
      break;
  }
  render();
}

/** Joins the presence room unless it is joined, and says who we are. */
function joinRoom(): void {
  if (leaveRoom) return;
  roomStatus = "joining";
  leaveRoom = cursors.join(onRoomEvent);
  publishProfile();
  render();
}

function boardPoint(event: PointerEvent): Point {
  const bounds = board.getBoundingClientRect();
  return {
    x: Math.round(
      Math.min(Math.max(event.clientX - bounds.left, 0), BOARD_WIDTH),
    ),
    y: Math.round(
      Math.min(Math.max(event.clientY - bounds.top, 0), BOARD_HEIGHT),
    ),
  };
}

board.addEventListener("pointermove", (event) => {
  if (!leaveRoom) return;
  publish(cursors.setFacet(POINTER_FACET, { ...boardPoint(event) }));
});

board.addEventListener("pointerleave", () => {
  if (leaveRoom) publish(cursors.clearFacet(POINTER_FACET));
});

// A room the host lost is joined again when the user comes back to the
// board. One the host cannot offer stays as it is.
board.addEventListener("pointerenter", () => {
  if (roomStatus === "lost") joinRoom();
});

//
// Shapes
//

/** Returns the stable handle of the shape `id`, which outlives its index. */
async function resolveShape(id: string) {
  const index = shapeIndex(storedShapes(), id);
  if (index < 0) throw new Error("That shape is no longer on the board.");
  return await shapesCell.key(index).resolve();
}

function grab(id: string, event: PointerEvent): void {
  if (!hydrated || event.button !== 0 || drag) return;
  const shape = storedShapes().find((entry) => entry.id === id);
  if (!shape) return;
  event.preventDefault();
  event.stopPropagation();
  selectedId = id;
  const from = shownPosition(shape);
  const pointer = boardPoint(event);
  drag = {
    id,
    pointerId: event.pointerId,
    grab: { x: pointer.x - from.x, y: pointer.y - from.y },
    from,
    position: from,
  };
  shapeElement(id).setPointerCapture(event.pointerId);
  render();
}

function moveDrag(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const held = drag.id;
  const shape = storedShapes().find((entry) => entry.id === held);
  if (!shape) return;
  drag.position = dragPosition(boardPoint(event), drag.grab, shape);
  if (leaveRoom) {
    publish(cursors.setFacet(DRAG_FACET, {
      id: drag.id,
      position: { ...drag.position },
    }));
  }
  renderShapes();
}

/**
 * Ends the local drag. A drop that moved the shape writes its position, and
 * the room keeps showing peers the dropped position until the cell holds it,
 * so the shape does not return to where it was in between.
 */
function endDrag(event: PointerEvent, drop: boolean): void {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const held = drag;
  drag = undefined;
  const moved = held.position.x !== held.from.x ||
    held.position.y !== held.from.y;
  if (!drop || !moved) {
    releaseDragFacet();
    render();
    return;
  }
  settling.set(held.id, held.position);
  render();
  void (async () => {
    try {
      const shape = await resolveShape(held.id);
      await shape.key("position").set(held.position);
      await state.pull();
    } catch (cause) {
      showError(cause);
    } finally {
      if (settling.get(held.id) === held.position) settling.delete(held.id);
      releaseDragFacet();
      render();
    }
  })();
}

/** Clears the `drag` facet once no shape is held and none is settling. */
function releaseDragFacet(): void {
  if (drag || settling.size > 0 || !leaveRoom) return;
  publish(cursors.clearFacet(DRAG_FACET));
}

function addShape(kind: CanvasShape["kind"]): void {
  if (!hydrated || !profile) return;
  const shape = createShape(kind, crypto.randomUUID(), profile.hue, added++);
  shapesCell.push(shape).then(() => state.pull()).then(() => {
    selectedId = shape.id;
    render();
  }).catch(showError);
}

function removeShape(): void {
  const id = selectedId;
  if (!hydrated || id === undefined) return;
  selectedId = undefined;
  render();
  void (async () => {
    try {
      const shape = await resolveShape(id);
      await shape.key("removed").set(true);
      await state.pull();
    } catch (cause) {
      showError(cause);
    }
  })();
}

addRectangle.addEventListener("click", () => addShape("rectangle"));
addEllipse.addEventListener("click", () => addShape("ellipse"));
removeSelected.addEventListener("click", removeShape);

board.addEventListener("pointerdown", (event) => {
  if (event.target !== board || selectedId === undefined) return;
  selectedId = undefined;
  render();
});

document.addEventListener("keydown", (event) => {
  if (event.target === nameInput) return;
  if (event.key === "Delete" || event.key === "Backspace") removeShape();
});

//
// Profile
//

/**
 * The name and hue this page goes by until the user picks a name. Nothing
 * stores them: viewing the board writes nothing of the user's.
 */
const visitorProfile: Profile = (() => {
  const [nameSeed, hueSeed] = crypto.getRandomValues(new Uint32Array(2));
  return { name: visitorName(nameSeed), hue: hueSeed % 360 };
})();

/** Takes the profile the user stored, or the visitor one where there is none. */
function adoptProfile(value: Readonly<IframeOutputData> | undefined): void {
  const name = value?.displayName || visitorProfile.name;
  const hue = readHue(value?.hue) ?? visitorProfile.hue;
  const changed = profile?.name !== name || profile?.hue !== hue;
  profile = { name, hue };
  // A name being typed is a draft, and stays until it is committed.
  if (document.activeElement !== nameInput) nameInput.value = profile.name;
  if (changed) publishProfile();
}

nameInput.addEventListener("change", () => {
  if (!hydrated || !profile) return;
  const name = displayNameOf(nameInput.value, profile.name);
  nameInput.value = name;
  if (name === profile.name) return;
  // Picking a name stores it with the hue this page has gone by, so every
  // later session of the user's reads both back.
  output.set({ displayName: name, hue: profile.hue }).catch(showError);
});

nameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") nameInput.blur();
});

//
// Startup and teardown
//

const stops = [
  input.sink(render),
  state.sink(render),
  output.sink((value) => {
    if (hydrated) adoptProfile(value);
    render();
  }),
];

joinRoom();

void (async () => {
  try {
    await Promise.all([input.pull(), state.pull(), output.pull()]);
    await state.initialize(DEFAULT_STATE);
    await state.pull();
    hydrated = true;
    adoptProfile(output.get());
    render();
  } catch (cause) {
    showError(cause);
  }
})();

globalThis.addEventListener("pagehide", () => {
  stops.forEach((stop) => stop());
  leaveRoom?.();
  fabric.disconnect();
}, { once: true });
