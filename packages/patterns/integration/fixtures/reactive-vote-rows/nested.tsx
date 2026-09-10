/** Demands remote linked votes and profiles inside reactive option-row filters. */

import { NAME, pattern, UI } from "commonfabric";
import { cast, type Input } from "./model.ts";

export default pattern<Input>(({ options, votes, profiles }) => {
  const rows = options.map((option) => ({
    id: option.id,
    colors: votes.filter((vote) => vote.optionId === option.id)
      .map((vote) => vote.color),
    names: votes.filter((vote) => vote.optionId === option.id)
      .map((vote) => vote.voter.name),
  }));
  return {
    [NAME]: "Nested vote filters",
    [UI]: (
      <div>
        {rows.map((row) => (
          <div data-row={row.id} title={row.names.join(",")}>
            {row.id}: {row.colors.join(",")}
          </div>
        ))}
      </div>
    ),
    rows,
    cast: cast({ votes, profiles }),
  };
});
