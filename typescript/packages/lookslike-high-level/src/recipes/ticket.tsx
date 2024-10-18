import { recipe, NAME, UI, handler, lift, ifElse } from "@commontools/common-builder";
import { h, Fragment } from "../jsx.js";

const addItem = handler<{}, { concerts: { date: string, location: string }[] }>(
  ({ }, state) => {
    const date = (() => {
      const start = new Date(2024, 0, 1);
      const end = new Date(2024, 11, 31);
      return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
    })().toDateString();
    state.concerts.push({ date, location: "The Gorge" });
  }
);

const removeItem = handler<{}, { concerts: { date: string, location: string }[] }>(
  ({ }, state) => {
    if (state.concerts.length > 0) {
      state.concerts.pop();
    }
  }
);

const updateBand = handler<{ detail: { value: string } }, { band: string }>(
  ({ detail }, state) => {
    state.band = detail?.value ?? "untitled";
  }
);

const sum = lift<{ concerts: { date: string, location: string }[] }, number>(({ concerts }) => concerts ? concerts.length : 0);
const getPending = lift<{ concerts: { date: string, location: string }[] }, boolean>(({ concerts }) => concerts && concerts.length > 0);

export const ticket = recipe<{
  band: string;
  concerts: { date: string, location: string }[];
}>("ticket", ({ band, concerts }) => {

  const count = sum({ concerts });
  const pending = getPending({ concerts });
  const pendingBool = lift(({ pending }) => pending ? true : false)({ pending });

  let rv = {
    [UI]: <div><h1>Touring Dates for {band}</h1>
      <h2>{pendingBool} | {count} tours</h2>
      {ifElse(pendingBool, 
        <ul>{concerts.map(({ location, date }) => <li>{date} at {location}</li>)}</ul>, 
        <div>No concerts scheduled</div>)}
      <p><button onclick={addItem({ concerts })}>Add Concert</button>
        <button onclick={removeItem({ concerts })}>Remove Concert</button></p>
      <common-input value={band} placeholder="Band name"
        oncommon-input={updateBand({ band })}></common-input>
    </div>,
    [NAME]: band,
    band,
    concerts,
  };
  console.log("[UI]", rv[UI]);
  return rv;
});
