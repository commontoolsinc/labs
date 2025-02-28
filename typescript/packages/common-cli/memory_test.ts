import { MemorySpace } from "@commontools/memory";
import { RemoteStorageProvider } from "../common-charm/src/storage/remote.ts";
import { StorageProvider } from "../common-charm/src/storage/base.ts";
import { EntityId } from "../common-runner/src/cell-map.ts";

// some config stuff, hardcoded, ofcourse
const replica = "ellyse5";

// i'm running common memory locally, so connect to it directly
const BASE_URL = "http://localhost:8000";

// how many entities will we try to update
const batch_size = 200;

type SomePerson = {
  name: string;
  position: number;
  random: number;
};

function create_person(i: number): SomePerson {
  return {
    name: "foobar",
    position: i,
    random: Math.random(),
  };
}

function create_people(len: number): SomePerson[] {
  return Array.from({ length: len }, (_, i) => create_person(i));
}

function entity_id(i: number): EntityId {
  return { "/": "foo" + i };
}

async function main() {
  const storageProvider: StorageProvider = new RemoteStorageProvider({
    address: new URL("/api/storage/memory", BASE_URL),
    space: replica as MemorySpace,
  });

  console.log(
    "created RemoteStorageProvider: " +
      JSON.stringify(storageProvider, null, 2),
  );

  const people = create_people(batch_size);
  const people_batch = people.map((p: SomePerson, i) => {
    return {
      entityId: entity_id(i),
      value: {
        value: p,
      },
    };
  });
  console.log("create list of people, length=" + people_batch.length);

  // first lets try to get all the values
  console.log("attempting to fetch entities");
  const promises = Array.from(
    { length: batch_size },
    (_, i) => storageProvider.sync(entity_id(i)),
  );
  await Promise.all(promises);
  Array.from({ length: batch_size }, (_, i) => {
    const entityId = entity_id(i);
    const fetchedValue = storageProvider.get<SomePerson>(entityId);
    if (fetchedValue) {
      console.log("retrieved entity: " + JSON.stringify(entityId));
    } else {
      console.log(
        "retrieved entity but it was undefined: entityId=" +
          JSON.stringify(entityId),
      );
    }
  });

  // now lets try to store a batch of values
  console.log("storing all entities");
  const result = await storageProvider.send(people_batch);

  console.log("sent entity, result: " + JSON.stringify(result, null, 2));
}

main();
