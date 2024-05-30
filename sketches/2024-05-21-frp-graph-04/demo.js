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
]);

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

connect(nameUi$.out.name, nameTagUi$.in.name);
connect(nameUi$.out.name, nameTagUi$.in.render);
connect(backstory$, backstoryUi$.in.backstory);
connect(backstory$, backstoryUi$.in.render);
connect(image$, portraitUi$.in.img);
connect(image$, portraitUi$.in.render);

connect(character$, combined$.in.data);
connect(character$, combined$.in.render);

ground(nameUi$.out.ui);
ground(nameTagUi$.out.ui);
ground(combined$.out.ui);
ground(backstoryUi$.out.ui);
ground(portraitUi$.out.ui);
ground(statsUi$.out.ui);
