// The iframe generator bundles this pinned module into the self-contained guest.
// deno-lint-ignore no-external-import
import Phaser from "npm:phaser@4.2.1";
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
import {
  type CrewColor,
  type CrewTool,
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type IframeInputData,
  type IframeOutputData,
  type IframeStateData,
  type SimulationAction,
} from "./contract.ts";
import {
  canonicalActions,
  describeTile,
  reduceSimulation,
  type SimulationSnapshot,
  type TileState,
} from "./simulation.ts";

type ViewMode = "response" | "terrain";

interface TileProjection {
  container: Phaser.GameObjects.Container;
  ground: Phaser.GameObjects.Rectangle;
  fire: Phaser.GameObjects.Rectangle;
  symbol: Phaser.GameObjects.Text;
  coordinate: Phaser.GameObjects.Text;
}

const TILE_SIZE = 64;
const TERRAIN_COLORS: Record<TileState["terrain"], number> = {
  water: 0x365e68,
  grass: 0x708f4f,
  forest: 0x315b3a,
  settlement: 0xb59b71,
};
const TERRAIN_VIEW_COLORS: Record<TileState["terrain"], number> = {
  water: 0x3f7180,
  grass: 0x83a960,
  forest: 0x3b7047,
  settlement: 0xc9ad7e,
};

const fabric = connectFabric();
const input = fabric.cell<IframeInputData | undefined>("input");
const state = fabric.cell<IframeStateData | undefined>("state");
const output = fabric.cell<IframeOutputData | undefined>("output");
const stateWrite = fabric.cell<IframeStateData>("state");
const outputWrite = fabric.cell<IframeOutputData>("output");

function element<T extends Element>(selector: string): T {
  const match = document.querySelector<T>(selector);
  if (!match) throw new Error(`Firebreak Commons is missing ${selector}.`);
  return match;
}

const app = element<HTMLElement>("#firebreak-app");
const title = element<HTMLElement>("#title");
const briefing = element<HTMLElement>("#briefing");
const syncStatus = element<HTMLElement>("#sync-status");
const turnOutput = element<HTMLOutputElement>("#turn");
const activeFireOutput = element<HTMLOutputElement>("#active-fire");
const evacuatedOutput = element<HTMLOutputElement>("#evacuated");
const lostOutput = element<HTMLOutputElement>("#lost");
const outcomeOutput = element<HTMLOutputElement>("#outcome");
const crewNameInput = element<HTMLInputElement>("#crew-name");
const crewColorSelect = element<HTMLSelectElement>("#crew-color");
const preferredToolSelect = element<HTMLSelectElement>("#preferred-tool");
const saveProfileButton = element<HTMLButtonElement>("#save-profile");
const deployButton = element<HTMLButtonElement>("#deploy");
const advanceButton = element<HTMLButtonElement>("#advance");
const selectedTileText = element<HTMLElement>("#selected-tile");
const mirror = element<HTMLElement>("#board-mirror");
const actionLog = element<HTMLOListElement>("#action-log");
const gameElement = element<HTMLElement>("#game");
const errorText = element<HTMLElement>("#error");
const toolButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-tool]"),
);
const viewButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-view]"),
);
const controls = Array.from(
  document.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLSelectElement
  >("button, input, select"),
);

const abort = new AbortController();
const { signal } = abort;
let hydrated = false;
let disposed = false;
let pendingActions = 0;
let pendingDescription = "";
let crewId = "";
let inputValue: IframeInputData = DEFAULT_INPUT;
let stateValue: IframeStateData = DEFAULT_STATE;
let outputValue: IframeOutputData = DEFAULT_OUTPUT;
let selectedTool: CrewTool = DEFAULT_OUTPUT.crew.preferredTool;
let selectedTileId: string | null = null;
let viewMode: ViewMode = "response";
let scene: Phaser.Scene | undefined;
let snapshot: SimulationSnapshot = reduceSimulation(
  DEFAULT_INPUT,
  DEFAULT_STATE.actions,
);
let actionQueue: Promise<void> = Promise.resolve();
const projections = new Map<string, TileProjection>();
const mirrorButtons = new Map<string, HTMLButtonElement>();

function showError(cause: unknown): void {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  errorText.textContent = error.message;
}

function clearError(): void {
  errorText.textContent = "";
}

function actionLabel(action: SimulationAction): string {
  const actor = action.actorId === crewId
    ? outputValue.crew.name
    : `Crew ${action.actorId.slice(-5)}`;
  if (action.type === "advance-turn") {
    return `${actor} advanced turn ${action.turn}.`;
  }
  const tile = snapshot.tiles.find((candidate) =>
    candidate.id === action.tileId
  );
  const position = tile
    ? `column ${tile.x + 1}, row ${tile.y + 1}`
    : action.tileId;
  const verb = action.type === "water"
    ? "sent water to"
    : action.type === "firebreak"
    ? "cut a firebreak at"
    : "evacuated";
  return `${actor} ${verb} ${position}.`;
}

function tileSymbol(tile: TileState): string {
  if (tile.fire > 0) return `F${tile.fire}`;
  if (tile.firebreak) return "BREAK";
  if (tile.terrain === "settlement") {
    const remaining = tile.residents - tile.evacuatedResidents -
      tile.lostResidents;
    return remaining > 0 ? `P${remaining}` : "CLEAR";
  }
  if (tile.wetUntilTurn >= snapshot.turn) return "WET";
  return tile.terrain === "water" ? "WATER" : "";
}

function projectionColor(tile: TileState): number {
  const base = viewMode === "terrain"
    ? TERRAIN_VIEW_COLORS[tile.terrain]
    : TERRAIN_COLORS[tile.terrain];
  if (viewMode === "response" && tile.wetUntilTurn >= snapshot.turn) {
    return 0x487f8f;
  }
  return base;
}

function selectTile(tileId: string): void {
  if (!hydrated || disposed) return;
  selectedTileId = tileId;
  clearError();
  renderSafely();
}

function createProjection(tile: TileState): TileProjection | undefined {
  if (!scene) return undefined;
  const ground = scene.add.rectangle(0, 0, TILE_SIZE - 5, TILE_SIZE - 5);
  const fire = scene.add.rectangle(
    0,
    0,
    TILE_SIZE - 11,
    TILE_SIZE - 11,
    0xff5b32,
    0,
  );
  const symbol = scene.add.text(0, -2, "", {
    color: "#fff7dd",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    fontSize: "12px",
    fontStyle: "bold",
  }).setOrigin(0.5);
  const coordinate = scene.add.text(
    -TILE_SIZE / 2 + 7,
    TILE_SIZE / 2 - 8,
    "",
    {
      color: "#ffffffaa",
      fontFamily: "ui-monospace, monospace",
      fontSize: "8px",
    },
  ).setOrigin(0, 1);
  const container = scene.add.container(0, 0, [
    ground,
    fire,
    symbol,
    coordinate,
  ])
    .setName(tile.id)
    .setData("fabricEntity", true)
    .setSize(TILE_SIZE - 5, TILE_SIZE - 5)
    .setInteractive();
  container.on("pointerdown", () => selectTile(tile.id));
  const projection = { container, ground, fire, symbol, coordinate };
  projections.set(tile.id, projection);
  return projection;
}

function renderPhaser(): void {
  if (!hydrated || disposed || !scene) return;
  const present = new Set(snapshot.tiles.map((tile) => tile.id));
  for (const [id, projection] of projections) {
    if (present.has(id)) continue;
    projection.container.destroy(true);
    projections.delete(id);
  }

  for (const tile of snapshot.tiles) {
    const projection = projections.get(tile.id) ?? createProjection(tile);
    if (!projection) continue;
    projection.container.setPosition(
      tile.x * TILE_SIZE + TILE_SIZE / 2,
      tile.y * TILE_SIZE + TILE_SIZE / 2,
    );
    projection.ground
      .setFillStyle(projectionColor(tile), tile.burned ? 0.58 : 1)
      .setStrokeStyle(
        selectedTileId === tile.id ? 4 : 1,
        selectedTileId === tile.id ? 0xffdf91 : 0x1a271d,
        1,
      );
    projection.fire
      .setVisible(tile.fire > 0)
      .setAlpha(tile.fire > 0 ? 0.22 + tile.fire * 0.18 : 0);
    projection.symbol
      .setText(tileSymbol(tile))
      .setColor(
        tile.terrain === "settlement" && tile.fire === 0
          ? "#1e2119"
          : "#fff7dd",
      );
    projection.coordinate.setText(`${tile.x + 1},${tile.y + 1}`);
  }

  const width = inputValue.columns * TILE_SIZE;
  const height = inputValue.rows * TILE_SIZE;
  game.scale.resize(width, height);
  gameElement.setAttribute(
    "aria-label",
    `Wildfire map, turn ${snapshot.turn}, ${snapshot.activeFireCount} active fire tiles`,
  );
}

function syncMirror(): void {
  mirror.style.gridTemplateColumns =
    `repeat(${inputValue.columns}, minmax(0, 1fr))`;
  const present = new Set(snapshot.tiles.map((tile) => tile.id));
  for (const [id, button] of mirrorButtons) {
    if (present.has(id)) continue;
    button.remove();
    mirrorButtons.delete(id);
  }
  for (const tile of snapshot.tiles) {
    let button = mirrorButtons.get(tile.id);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "mirror-tile";
      button.dataset.tileId = tile.id;
      button.setAttribute("role", "gridcell");
      button.addEventListener("click", () => selectTile(tile.id), { signal });
      mirrorButtons.set(tile.id, button);
    }
    button.disabled = !hydrated || pendingActions > 0;
    button.dataset.terrain = tile.terrain;
    button.dataset.fire = String(tile.fire > 0);
    button.dataset.fireLevel = String(tile.fire);
    button.dataset.residents = String(
      tile.residents - tile.evacuatedResidents - tile.lostResidents,
    );
    button.setAttribute(
      "aria-pressed",
      String(selectedTileId === tile.id),
    );
    button.setAttribute("aria-label", describeTile(tile));
    button.textContent = `${tile.x + 1},${tile.y + 1} ${tileSymbol(tile)}`
      .trim();
    mirror.append(button);
  }
}

function render(): void {
  if (disposed) return;
  snapshot = reduceSimulation(inputValue, stateValue.actions);
  if (
    selectedTileId &&
    !snapshot.tiles.some((tile) => tile.id === selectedTileId)
  ) selectedTileId = null;

  title.textContent = inputValue.title;
  briefing.textContent = inputValue.briefing;
  app.dataset.ready = String(hydrated);
  app.dataset.turn = String(snapshot.turn);
  app.dataset.status = snapshot.status;
  syncStatus.textContent = !hydrated
    ? "Synchronizing commons"
    : pendingActions > 0
    ? pendingDescription
    : `Ready · ${outputValue.crew.name}`;
  turnOutput.textContent = `${snapshot.turn} / ${inputValue.maximumTurns}`;
  activeFireOutput.textContent = String(snapshot.activeFireCount);
  evacuatedOutput.textContent = String(snapshot.evacuatedResidentCount);
  lostOutput.textContent = String(snapshot.lostResidentCount);
  outcomeOutput.textContent = snapshot.status === "active"
    ? "Responding"
    : snapshot.status === "contained"
    ? "Contained"
    : "Overrun";

  const baseDisabled = !hydrated || pendingActions > 0;
  controls.forEach((control) => control.disabled = baseDisabled);
  crewNameInput.value = outputValue.crew.name;
  crewColorSelect.value = outputValue.crew.color;
  preferredToolSelect.value = outputValue.crew.preferredTool;
  for (const button of toolButtons) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.tool === selectedTool),
    );
  }
  for (const button of viewButtons) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.view === viewMode),
    );
  }

  const selectedTile = snapshot.tiles.find((tile) =>
    tile.id === selectedTileId
  );
  selectedTileText.textContent = selectedTile
    ? describeTile(selectedTile)
    : "Select a map tile.";
  const hasActed = stateValue.actions.some((action) =>
    action.turn === snapshot.turn && action.actorId === crewId &&
    action.type !== "advance-turn"
  );
  deployButton.disabled = baseDisabled || !selectedTile || hasActed ||
    snapshot.status !== "active";
  deployButton.textContent = hasActed
    ? "Crew deployed this turn"
    : `Deploy ${selectedTool}`;
  advanceButton.disabled = baseDisabled || snapshot.status !== "active";

  const latestActions = canonicalActions(stateValue.actions).slice(-8)
    .reverse();
  actionLog.replaceChildren();
  if (latestActions.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No deployments yet.";
    actionLog.append(item);
  } else {
    for (const action of latestActions) {
      const item = document.createElement("li");
      item.textContent = actionLabel(action);
      item.dataset.actionId = action.id;
      actionLog.append(item);
    }
  }

  syncMirror();
  renderPhaser();
}

function renderSafely(): void {
  try {
    render();
  } catch (cause) {
    showError(cause);
  }
}

function enqueueMutation(
  description: string,
  operation: () => Promise<void>,
): void {
  if (!hydrated || disposed) return;
  pendingActions += 1;
  pendingDescription = description;
  clearError();
  renderSafely();
  actionQueue = actionQueue.then(operation).catch(showError).finally(() => {
    pendingActions -= 1;
    if (pendingActions === 0) pendingDescription = "";
    renderSafely();
  });
}

async function appendAction(action: SimulationAction): Promise<void> {
  await stateWrite.key("actions").push(action);
  await state.pull();
  stateValue = state.get() ?? DEFAULT_STATE;
}

function deployCrew(): void {
  const tileId = selectedTileId;
  if (!tileId) return;
  const action: SimulationAction = {
    id: crypto.randomUUID(),
    actorId: crewId,
    turn: snapshot.turn,
    type: selectedTool,
    tileId,
  };
  enqueueMutation(
    `Committing ${selectedTool} deployment`,
    () => appendAction(action),
  );
}

function advanceTurn(): void {
  const action: SimulationAction = {
    id: crypto.randomUUID(),
    actorId: crewId,
    turn: snapshot.turn,
    type: "advance-turn",
  };
  enqueueMutation("Advancing the shared wildfire", () => appendAction(action));
}

function saveProfile(): void {
  const name = crewNameInput.value.trim();
  if (!name) {
    showError(new TypeError("Give your crew a name."));
    return;
  }
  const crew = {
    name,
    color: crewColorSelect.value as CrewColor,
    preferredTool: preferredToolSelect.value as CrewTool,
  };
  enqueueMutation("Saving crew profile", async () => {
    await outputWrite.key("crew").set(crew);
    await output.pull();
    outputValue = output.get() ?? DEFAULT_OUTPUT;
  });
}

class FirebreakScene extends Phaser.Scene {
  constructor() {
    super("firebreak-commons");
  }

  create(): void {
    scene = this;
    renderSafely();
  }
}

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: gameElement,
  width: DEFAULT_INPUT.columns * TILE_SIZE,
  height: DEFAULT_INPUT.rows * TILE_SIZE,
  backgroundColor: "#101812",
  scene: FirebreakScene,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  render: {
    antialias: true,
    pixelArt: false,
  },
});

toolButtons.forEach((button) => {
  button.addEventListener("click", () => {
    selectedTool = button.dataset.tool as CrewTool;
    renderSafely();
  }, { signal });
});
viewButtons.forEach((button) => {
  button.addEventListener("click", () => {
    viewMode = button.dataset.view as ViewMode;
    renderSafely();
  }, { signal });
});
saveProfileButton.addEventListener("click", saveProfile, { signal });
deployButton.addEventListener("click", deployCrew, { signal });
advanceButton.addEventListener("click", advanceTurn, { signal });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") game.loop.sleep();
  else game.loop.wake();
}, { signal });

const stops = [
  input.sink((value) => {
    inputValue = value ?? DEFAULT_INPUT;
    renderSafely();
  }),
  state.sink((value) => {
    stateValue = value ?? DEFAULT_STATE;
    renderSafely();
  }),
  output.sink((value) => {
    outputValue = value ?? DEFAULT_OUTPUT;
    renderSafely();
  }),
];

function dispose(): void {
  if (disposed) return;
  disposed = true;
  abort.abort();
  stops.forEach((stop) => stop());
  projections.clear();
  game.destroy(true);
  fabric.disconnect();
}

globalThis.addEventListener("pagehide", dispose, { once: true, signal });

try {
  await Promise.all([input.pull(), state.pull(), output.pull()]);
  await Promise.all([
    stateWrite.initialize(DEFAULT_STATE),
    outputWrite.initialize(DEFAULT_OUTPUT),
  ]);
  const resolvedCrew = await outputWrite.resolve();
  const resolvedCrewId = resolvedCrew.identity?.instanceId;
  if (!resolvedCrewId) {
    throw new Error("Firebreak Commons needs a stable PerUser crew identity.");
  }
  crewId = resolvedCrewId;
  inputValue = input.get() ?? DEFAULT_INPUT;
  stateValue = state.get() ?? DEFAULT_STATE;
  outputValue = output.get() ?? DEFAULT_OUTPUT;
  selectedTool = outputValue.crew.preferredTool;
  hydrated = true;
  renderSafely();
} catch (cause) {
  showError(cause);
  dispose();
}
