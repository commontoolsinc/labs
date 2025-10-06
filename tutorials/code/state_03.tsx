/// <cts-enable />
import {
  cell,
  h,
  recipe,
  UI,
  lift,
  derive,
  handler,
  type Cell,
} from "commontools";

const calcAC = (dex: number) : number =>
  20 + Math.floor((dex - 10) / 2);

const updateName = handler<
  { detail: { message: string } },
  { characterName: Cell<string> }
>(
  (event, { characterName }) => {
    characterName.set(event.detail.message);
  }
);

const rollD6 = () => Math.floor(Math.random() * 6) + 1;

const rollDex = handler<
  unknown,
  Cell<number>
>(
  (_, dex) => {
    // Roll 3d6 for new DEX value
    const roll = rollD6() + rollD6() + rollD6();
    dex.set(roll);
  }
);

export default recipe("state test", () => {
  const characterName = cell<string>("");
  characterName.set("Lady Ellyxir");
  const dex = cell<number>(16);
  const ac = lift(calcAC)(dex);

  return {
    [UI]: (
      <div>
        <h2>Character name: {characterName}</h2>
        <common-send-message
          name="Update"
          placeholder="Update Name"
          onmessagesend={updateName({ characterName })}
        />
        <li>
          DEX: {dex}
          {" "}
          <ct-button onClick={rollDex(dex)}>
            Roll
          </ct-button>
        </li>
        <li>DEX Modifier: {Math.floor((dex - 10) / 2)}</li>
        <li>AC: {ac}</li>
      </div>
    ),
  };
});
