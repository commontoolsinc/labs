/// <cts-enable />
import { lift, h } from "commontools";

interface Person {
  name: string;
  age: number;
}

interface PersonWithYear {
  name: string;
  birthYear: number;
}

const currentYear = 2024;

export const result = (
  <div>
    {lift((person: Person): PersonWithYear => ({
      name: person.name,
      birthYear: currentYear - person.age,
    }))}
  </div>
);
