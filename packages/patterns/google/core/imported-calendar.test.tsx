import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  childNodes,
  findElement,
  findElementByExactText,
  propsOf,
  propValue,
  readValue,
  textContent,
} from "../../test/vnode-helpers.ts";
import ImportedCalendar from "./imported-calendar.tsx";

const pressButton = (ui: unknown, label: string) => {
  const onClick = propsOf(findElementByExactText(ui, "button", label))?.onClick;
  if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
    (onClick as { send: (event: Record<string, never>) => void }).send({});
  }
};

// One date header per day column, each reading like "Mon, Aug 18". The week is
// seeded from the `#now` wish, so a full set of seven proves the seed landed;
// before it does, every header is empty.
const dayHeaderCount = (ui: unknown): number =>
  (textContent(ui).match(
    /(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [A-Z][a-z]{2} \d{1,2}/g,
  ) ?? []).length;

// "Today" reaches the tree twice: on the button that jumps back to this week,
// and on the marker under the one column whose date matches what #now reported.
const todayMentions = (ui: unknown): number =>
  (textContent(ui).match(/Today/g) ?? []).length;

const newEventModalOpen = (ui: unknown): unknown =>
  propValue(findElement(ui, "cf-modal"), "$open");

const firstEventDate = (events: readonly { date: string }[]): string =>
  events.length > 0 ? events[0].date : "";

const firstEventColor = (events: readonly { color: string }[]): string =>
  events.length > 0 ? events[0].color : "";

// The colour swatches are a plain-array `.map()` whose callback attaches an
// inline handler per element. Collect them in tree order so a test can press
// one by position and check that it set that swatch's own colour: a shared or
// last-one-wins handler would set some other swatch's colour instead, which
// nothing else in this suite would notice.
const isSwatch = (node: unknown): boolean => {
  const value = readValue(node);
  if (
    typeof value !== "object" || value === null ||
    readValue((value as Record<string, unknown>)["name"]) !== "div"
  ) {
    return false;
  }
  const props = propsOf(value);
  if (!props || props["onClick"] === undefined) return false;
  const style = readValue(props["style"]);
  if (typeof style !== "object" || style === null) return false;
  const shape = style as Record<string, unknown>;
  // The `STYLES.colorSwatch` signature, which no other clickable div carries.
  return readValue(shape["width"]) === "24px" &&
    readValue(shape["height"]) === "24px" &&
    typeof readValue(shape["backgroundColor"]) === "string";
};

const collectSwatches = (node: unknown): unknown[] => {
  const value = readValue(node);
  const self = isSwatch(value) ? [value] : [];
  return childNodes(value).reduce<unknown[]>(
    (found, child) => found.concat(collectSwatches(child)),
    self,
  );
};

const swatchColor = (swatch: unknown): string => {
  const style = readValue(propsOf(swatch)?.["style"]) as
    | Record<string, unknown>
    | undefined;
  const color = style ? readValue(style["backgroundColor"]) : undefined;
  return typeof color === "string" ? color : "";
};

const pressSwatch = (swatch: unknown) => {
  const onClick = propsOf(swatch)?.["onClick"];
  if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
    (onClick as { send: (event: Record<string, never>) => void }).send({});
  }
};

export default pattern(() => {
  const subject = ImportedCalendar({});

  const action_open_new_event = action(() => pressButton(subject[UI], "+ Add"));
  const action_create_event = action(() => pressButton(subject[UI], "Create"));

  const assert_built = assert(() => subject != null);
  const assert_no_events = assert(() => subject.eventCount === 0);
  const assert_week_rendered = assert(() => dayHeaderCount(subject[UI]) === 7);
  const assert_today_marked = assert(() => todayMentions(subject[UI]) === 2);
  const assert_modal_closed = assert(() =>
    newEventModalOpen(subject[UI]) === false
  );
  const assert_modal_open = assert(() =>
    newEventModalOpen(subject[UI]) === true
  );
  const assert_one_event = assert(() =>
    subject.localEvents.length === 1 && subject.eventCount === 1
  );
  // Press the third swatch: the event created afterwards must carry THAT
  // swatch's colour. Pins per-element handler binding in the plain-array map,
  // where a shared or last-one-wins handler would apply a different swatch's
  // colour and nothing else here would notice.
  const action_pick_third_color = action(() => {
    const swatches = collectSwatches(subject[UI]);
    if (swatches.length > 2) pressSwatch(swatches[2]);
  });
  const assert_third_color_applied = assert(() => {
    const swatches = collectSwatches(subject[UI]);
    return swatches.length > 2 &&
      firstEventColor(subject.localEvents) === swatchColor(swatches[2]);
  });

  // The create form's date defaults to the day the `#now` wish reported, so a
  // dated event is the second half of the seeding story.
  const assert_event_is_dated = assert(() =>
    /^\d{4}-\d{2}-\d{2}$/.test(firstEventDate(subject.localEvents))
  );

  return {
    [TESTS]: [
      { assertion: assert_built },
      { assertion: assert_no_events },
      { assertion: assert_week_rendered },
      { assertion: assert_today_marked },
      { assertion: assert_modal_closed },

      { action: action_open_new_event },
      { assertion: assert_modal_open },

      { action: action_pick_third_color },
      { action: action_create_event },
      { assertion: assert_one_event },
      { assertion: assert_third_color_applied },
      { assertion: assert_event_is_dated },
      { assertion: assert_modal_closed },
    ],
    subject,
  };
});
