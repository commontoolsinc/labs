import { type Cell, cell, handler, lift, pattern, UI } from "commonfabric";

const calcAC = (dex: number): number => 20 + Math.floor((dex - 10) / 2);

const updateName = handler<
  { detail: { message: string } },
  { characterName: Cell<string> }
>(
  (event, { characterName }) => {
    console.log("Updating character name to:", event.detail.message);
    characterName.set(event.detail.message);
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
        <li>DEX: {dex}</li>
        <li>DEX Modifier: {Math.floor((dex - 10) / 2)}</li>
        <li>AC: {ac}</li>
      </div>
    ),
  };
});
