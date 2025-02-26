import { h } from "@commontools/html"
import { recipe, handler, UI, NAME } from "@commontools/builder"
import { z } from "zod"

const Recipe = z
  .object({
    count: z.number().default(0),
  })
  .describe("fake calendar")

const Events = z
  .object({
    events: z.array(
      z.object({
        title: z.string(),
        description: z.string(),
        start: z.number(),
        end: z.number(),
      })
    ),
  })
  .describe("events")

const updateNum = handler<{ detail: { value: string } }, { value: number }>(
  ({ detail }, state) => {
    state.value = parseInt(detail?.value ?? "0")
  }
)

const runSync = handler<{}, { count: number; events: any[] }>(
  (event, state) => {
    state.events = Array.from({ length: state.count }, (_, i) => ({
      title: `Event ${i}`,
      description: `Description ${i}`,
      start: Date.now() + i * 1000 * 60 * 60 * 24,
      end: Date.now() + i * 1000 * 60 * 60 * 24 + 1000 * 60 * 60 * 2,
    }))
  }
)

export default recipe(Recipe, Events, ({ count, events }) => ({
  [NAME]: "fake calendar",
  [UI]: (
    <div>
      <h1>Fake Calendar</h1>
      <p>
        Number of events:
        <common-input
          value={count}
          placeholder="number of events"
          oncommon-input={updateNum({ value: count })}
        />
        <button onclick={runSync({ count, events })}>Generate</button>
      </p>
      <div>
        {events.map(event => (
          <div>
            <h3>{event.summary}</h3>
            <p>
              <em>
                {event.start} - {event.end}
              </em>{" "}
              {event.description}
            </p>
          </div>
        ))}
      </div>
    </div>
  ),
  sync: runSync({ count, events }),
  events,
}))
