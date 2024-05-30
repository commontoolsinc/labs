import {
  map,
  fromEvent,
  combineLatest,
  filter,
  from,
  debounceTime,
  mergeMap,
  tap,
} from "https://cdn.jsdelivr.net/npm/rxjs@7.8.1/+esm";
import { BehaviourNode } from "./nodes/BehaviourNode.js";
import { Cursor } from "./nodes/Cursor.js";
import { GeneratedNameUI } from "./nodes/GeneratedNameUI.js";
import { GeneratedNameTagUI } from "./nodes/GeneratedNameTagUI.js";
import { GeneratedBackstoryUI } from "./nodes/GeneratedBackstoryUI.js";
import { DangerousUI } from "./nodes/DangerousUI.js";
import { CombinedDataUI } from "./nodes/CombinedDataUI.js";
import { connect, ground } from "./connect.js";
import { extractResponse, doLLM } from "./llm.js";

const startButton = document.getElementById("startWorkflow");

const name$ = BehaviourNode("");
const nameUi$ = GeneratedNameUI();
const nameTagUi$ = GeneratedNameTagUI();
const danger$ = DangerousUI();
const cursor$ = Cursor();
const combined$ = CombinedDataUI();
const backstoryUi$ = GeneratedBackstoryUI();

const backstory$ = nameUi$.out.name.pipe(
  debounceTime(1000),
  filter((v) => v.length > 0),
  mergeMap((character) => {
    return from(
      doLLM(
        JSON.stringify(character),
        "Write a possible backstory for this fantasy character in 280 characters or less.",
      ),
    );
  }),
  map(extractResponse),
);

const app = combineLatest([
  name$.out.value,
  nameUi$.out.ui,
  nameTagUi$.out.ui,
  cursor$.out.ui,
  cursor$.out.cursor,
]).pipe(
  map(([name, nameUi, nameTagUi, cursorUi, cursor]) => ({
    name,
    nameUi,
    nameTagUi,
    cursorUi,
    cursor,
  })),
);

app.subscribe(console.log);

connect(name$.out.value, nameUi$.in.name);
connect(nameUi$.out.name, nameTagUi$.in.name);
connect(nameUi$.out.name, name$.in.value);
connect(nameUi$.out.name, nameTagUi$.in.render);
ground(combined$.out.ui);
ground(danger$.out.ui);
ground(backstoryUi$.out.ui);
connect(app, combined$.in.data);
connect(app, combined$.in.render);

connect(backstory$, backstoryUi$.in.backstory);
connect(backstory$, backstoryUi$.in.render);

ground(
  fromEvent(startButton, "click").pipe(
    tap(() => {
      name$.in.value.next("Ben" + Math.floor(Math.random() * 1000));
      nameUi$.in.generate.next();
      nameTagUi$.in.generate.next();
      danger$.in.generate.next();
      backstoryUi$.in.generate.next();

      cursor$.in.render.next();
      // combined$.in.render.next();
    }),
  ),
);
