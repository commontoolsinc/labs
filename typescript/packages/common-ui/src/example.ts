import { subject } from "@commontools/common-frp/stream";
import { state } from "@commontools/common-frp/signal";
import { dict, datatable, vstack, div, accordion } from "./hyperscript/tags.js";
import { binding, repeat } from "./hyperscript/view.js";
import render from "./hyperscript/render.js";

const datatableNode = datatable({
  "@click": binding("clicks"),
  cols: [
    "title",
    "day",
    "time",
    "location",
    "address",
    "description",
    "level",
    "price",
    "email",
    "reservation",
  ],
  rows: [
    {
      title: "Power Yoga",
      day: "Monday",
      time: "8:00am",
      location: "Studio 1 & 2 (combined)",
      description:
        "Stretch and relax with yoga practice at the studio. All levels welcome. Bring your own mat. Namaste. 🧘‍♂️",
      level: "Beginner to Advanced",
      price: "$10",
      address: "1234 Elm St, Springfield, IL 62701",
      email: "yogazon124@example.com",
      reservation: "https://example.com/reserve/power-yoga",
    },
    {
      title: "Pilates",
      day: "Wednesday",
      time: "8:00am",
      location: "Studio",
      description: "Strengthen and tone",
      level: "Intermediate",
      price: "$15",
      address: "1234 Elm St, Springfield, IL 62701",
      email: "pilates14asdf@example.com",
      reservation: "https://example.com/reserve/pilates",
    },
    {
      title: "Zumba",
      day: "Friday",
      time: "8:00am",
      location: "Studio",
      description: "Dance and have fun",
      level: "Advanced",
      price: "$20",
      address: "1234 Elm St, Springfield, IL 62701",
      email: "zumba@example.com",
      reservation: "https://example.com/reserve/zumba",
    },
  ],
});

const dictNode = dict({
  records: {
    one: "1",
    two: "2",
    three: "3",
  },
});

const listNode = vstack(
  {
    "@click": binding("listClicks"),
  },
  repeat("items", div({ id: binding("id") }, binding("value"))),
);

const acc = accordion();

const tree = vstack({}, [acc, datatableNode, dictNode, listNode]);

const clicks = subject();

clicks.sink({
  send: (clicks) => {
    console.log("clicks", clicks);
  },
});

const element = render(tree, {
  clicks,
  items: state([
    { id: "1", value: state("One") },
    { id: "2", value: state("Two") },
    { id: "3", value: "Three" },
  ]),
});

document.body.appendChild(element);
