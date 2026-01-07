/// <cts-enable />
import { Cell, computed, Default, NAME, pattern, UI } from "commontools";

interface City {
  name: string;
  timezone: string;
  emoji: string;
}

interface Input {
  cities: Default<
    City[],
    [
      { name: "Berkeley, CA"; timezone: "America/Los_Angeles"; emoji: "🌉" },
      { name: "Brisbane, AUS"; timezone: "Australia/Brisbane"; emoji: "🦘" },
      { name: "Boulder, CO"; timezone: "America/Denver"; emoji: "🏔️" },
    ]
  >;
  tick: Default<number, 0>;
}

export default pattern<Input, Input>(({ cities, tick }) => {
  // Start timer once on first render
  const tickCell = tick as unknown as Cell<number>;
  const startTimer = computed(() => {
    const t = tickCell.get();
    if (t === 0) {
      tickCell.set(Date.now());
      setInterval(() => {
        tickCell.set(Date.now());
      }, 1000);
    }
    return t;
  });

  const times = computed(() => {
    // Reference tick to trigger reactivity
    const _ = startTimer;
    const now = new Date();

    return (cities as City[]).map((city) => {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: city.timezone,
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
        weekday: "short",
      });

      const dateFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: city.timezone,
        month: "short",
        day: "numeric",
      });

      return {
        city: city.name,
        emoji: city.emoji,
        time: formatter.format(now),
        date: dateFormatter.format(now),
      };
    });
  });

  return {
    [NAME]: "World Clock",
    [UI]: (
      <ct-screen>
        <ct-vstack slot="header" gap="1">
          <ct-heading level={4}>World Clock</ct-heading>
        </ct-vstack>

        <ct-vscroll flex showScrollbar fadeEdges>
          <ct-vstack gap="2" style="padding: 1rem;">
            {times.map((t) => (
              <ct-card>
                <ct-hstack justify="between" align="center">
                  <ct-hstack gap="2" align="center">
                    <span style="font-size: 1.5rem;">{t.emoji}</span>
                    <ct-vstack gap="0">
                      <span style="font-weight: 600;">{t.city}</span>
                      <span style="font-size: 0.85rem; color: var(--ct-color-gray-500);">
                        {t.date}
                      </span>
                    </ct-vstack>
                  </ct-hstack>
                  <span style="font-size: 1.25rem; font-family: monospace; font-weight: 500;">
                    {t.time}
                  </span>
                </ct-hstack>
              </ct-card>
            ))}
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    ),
    cities,
    tick,
  };
});
