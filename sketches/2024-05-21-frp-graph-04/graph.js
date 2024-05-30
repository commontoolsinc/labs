import {
  combineLatest,
  debounceTime,
  delay,
  distinctUntilChanged,
  filter,
  from,
  fromEvent,
  map,
  mergeMap,
  share,
  switchMap,
  tap,
} from "https://cdn.jsdelivr.net/npm/rxjs@7.8.1/+esm";
import { connect, ground } from "./connect.js";
import { doLLM, extractResponse, generateImage } from "./llm.js";
import { BehaviourNode } from "./nodes/BehaviourNode.js";
import { CombinedDataUI } from "./nodes/CombinedDataUI.js";
import { Cursor } from "./nodes/Cursor.js";
import { DangerousUI } from "./nodes/DangerousUI.js";
import { GeneratedBackstoryUI } from "./nodes/GeneratedBackstoryUI.js";
import { GeneratedNameTagUI } from "./nodes/GeneratedNameTagUI.js";
import { GeneratedNameUI } from "./nodes/GeneratedNameUI.js";
import { PortraitUI } from "./nodes/PortraitUI.js";
import { GeneratedStatsUI } from "./nodes/GeneratedStatsUI.js";

const startButton = document.getElementById("startWorkflow");

const name$ = BehaviourNode("");
const nameUi$ = GeneratedNameUI();
const nameTagUi$ = GeneratedNameTagUI();
const danger$ = DangerousUI();
const cursor$ = Cursor();
const combined$ = CombinedDataUI();
const backstoryUi$ = GeneratedBackstoryUI();
const portraitUi$ = PortraitUI();
const statsUi$ = GeneratedStatsUI();

const character$ = combineLatest([
  nameUi$.out.name,
  statsUi$.out.str,
  statsUi$.out.dex,
  statsUi$.out.con,
  statsUi$.out.int,
  statsUi$.out.wis,
  statsUi$.out.cha,
]).pipe(
  map(([name, str, dex, con, int, wis, cha]) => ({
    name,
    stats: {
      str,
      dex,
      con,
      int,
      wis,
      cha,
    },
  })),
);

const backstory$ = character$.pipe(
  filter(
    (v) =>
      v.name.length > 0 &&
      (v.stats.str > 0 ||
        v.stats.dex > 0 ||
        v.stats.con > 0 ||
        v.stats.int > 0 ||
        v.stats.wis > 0 ||
        v.stats.cha > 0),
  ),
  debounceTime(1000),
  distinctUntilChanged(),
  switchMap((character) => {
    console.log("character", character);
    return from(
      doLLM(
        JSON.stringify(character),
        "Write a possible backstory for this fantasy character in 280 characters or less.",
      ),
    );
  }),
  map(extractResponse),
  share(),
);

const image$ = backstory$.pipe(
  debounceTime(1000),
  distinctUntilChanged(),
  switchMap((backstory) => {
    console.log("backstory", backstory);
    return from(
      generateImage(
        "Create a fantasy portrait of character based on this bio: " +
          backstory,
      ),
    );
  }),
  share(),
);

connect(name$.out.value, nameUi$.in.name);

connect(character$, combined$.in.data);
connect(character$, combined$.in.render);

connect(nameUi$.out.name, nameTagUi$.in.name);
connect(nameUi$.out.name, nameTagUi$.in.render);
connect(backstory$, backstoryUi$.in.backstory);
connect(backstory$, backstoryUi$.in.render);
connect(image$, portraitUi$.in.img);
connect(image$, portraitUi$.in.render);

ground(nameUi$.out.ui);
ground(nameTagUi$.out.ui);
ground(combined$.out.ui);
// ground(danger$.out.ui);
ground(backstoryUi$.out.ui);
ground(portraitUi$.out.ui);
ground(statsUi$.out.ui);

character$.subscribe(console.log);

ground(
  fromEvent(startButton, "click").pipe(
    tap(() => {
      // name$.in.value.next("Ben" + Math.floor(Math.random() * 1000));
      nameUi$.in.generate.next();
      nameTagUi$.in.generate.next();
      // danger$.in.generate.next();
      backstoryUi$.in.generate.next();
      statsUi$.in.generate.next();

      cursor$.in.render.next();
      combined$.in.render.next();
    }),
  ),
);
