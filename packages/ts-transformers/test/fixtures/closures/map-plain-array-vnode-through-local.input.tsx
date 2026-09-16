import { pattern, UI } from "commonfabric";

const COLUMN_INDICES = [0, 1, 2];

interface Input {
  weekDates: string[];
  todayDate: string;
}

// FIXTURE: map-plain-array-vnode-through-local
// Verifies: a render-collecting plain-array .map() keeps its callback-local
// lowering when the collected view nodes flow through a local
//   const columns = COLUMN_INDICES.map(fn)  -> plain .map() remains plain
//   const isToday = weekDates?.[colIdx] === todayDate
//                                           -> lift-applied binding capturing
//                                              weekDates, todayDate and colIdx
//   {columns} as the JSX child              -> the local carries view nodes,
//                                              not cells, so the flow is
//                                              ordinary data
// Context: The calendar shape with the mapped columns named before rendering —
// every lowered value is embedded in the returned view nodes, so the map
// result needs no flow restriction
export default pattern<Input>(({ weekDates, todayDate }) => {
  const columns = COLUMN_INDICES.map((colIdx) => {
    const isToday = weekDates?.[colIdx] === todayDate;
    return <div>{isToday ? "Today" : "Other"}</div>;
  });
  return {
    [UI]: <div>{columns}</div>,
  };
});
