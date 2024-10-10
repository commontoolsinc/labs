export const splitlines = (text: string): string[] => {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

const randomCompare = () => Math.random() - 0.5;

export const randomSample = <T>(arr: T[], max: number = Infinity): Array<T> =>
  arr.toSorted(randomCompare).slice(0, max);

const DUMMY_TITLES = `
Lorem ipsum dolor sit
Amet consectetur adipiscing elit
Sed do
Eiusmod tempor
Incididunt ut labore et dolore magna aliqua
Ut enim ad minim veniam
Quis nostrud exercitation
Ullamco laboris nisi ut
Aliquip ex ea commodo
Consequat
Duis aute irure
Dolor in reprehenderit
In voluptate
Velit esse cillum
Dolore eu fugiat
Nulla Pariatur
Excepteur sint occaecat cupidatat non proident
Sunt in culpa qui officia deserunt mollit anim id est laborum
Sed ut perspiciatis
Unde omnis iste natus
Sit voluptatem accusantium
Doloremque laudantium
Totam rem aperiam
Eaque ipsa quae ab illo
`;

export const titles = (max = Infinity) =>
  randomSample(splitlines(DUMMY_TITLES), max);

let _cid = 0;
export const id = () => `dummy${_cid++}`;
