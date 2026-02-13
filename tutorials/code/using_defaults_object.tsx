/// <cts-enable />
import { type Cell, Default, handler, pattern, UI } from "commontools";

interface Player {
  playerName: string;
  score: number;
  level: number;
}

interface GameState {
  stats: Default<
    Player,
    {
      playerName: "Player 1";
      score: 500;
      level: 10;
    }
  >;
}

const incrementScore = handler<unknown, { stats: Cell<Player> }>(
  (_, { stats }) => {
    const currentScore = stats.key("score").get();
    stats.key("score").set(currentScore + 10);
  },
);

const levelUp = handler<unknown, { stats: Cell<Player> }>(
  (_, { stats }) => {
    const currentLevel = stats.key("level").get();
    stats.key("level").set(currentLevel + 1);
  },
);

export default pattern<GameState>("Game Stats with Default", (state) => {
  return {
    [UI]: (
      <div>
        <h2>Game Stats</h2>
        <p>Player: {state.stats.playerName}</p>
        <p>Level: {state.stats.level}</p>
        <p>Score: {state.stats.score}</p>
        <button type="button" onclick={incrementScore({ stats: state.stats })}>
          Add 10 Points
        </button>
        <button type="button" onclick={levelUp({ stats: state.stats })}>
          Level Up
        </button>
      </div>
    ),
    stats: state.stats,
  };
});
