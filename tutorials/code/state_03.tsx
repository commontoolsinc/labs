/// <cts-enable />
import { type Cell, cell, handler, lift, pattern, UI } from "commonfabric";

const calcAC = (dex: number): number => 20 + Math.floor((dex - 10) / 2);

const updateName = handler<
  { detail: { message: string } },
  { characterName: Cell<string> }
>(
  (event, { characterName }) => {
    characterName.set(event.detail.message);
  },
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
  },
);

export default pattern(() => {
  const characterName = cell<string>("");
  characterName.set("Lady Ellyxir");
  const dex = cell<number>(16);
  const ac = lift(calcAC)(dex);

  return {
    [UI]: (
      <div>
        <h2>Character name: {characterName}</h2>
        <cf-message-input
          name="Update"
          placeholder="Update Name"
          oncf-send={updateName({ characterName })}
        />
        <li>
          DEX: {dex}{" "}
          <cf-button onClick={rollDex(dex)}>
            Roll
          </cf-button>
        </li>
        <li>DEX Modifier: {Math.floor((dex - 10) / 2)}</li>
        <li>AC: {ac}</li>
      </div>
    ),
  };
});
