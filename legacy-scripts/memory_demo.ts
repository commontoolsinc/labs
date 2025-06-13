import { StorageManager } from "../runner/src/storage/cache.ts";
import { EntityId } from "../runner/src/doc-map.ts";
import { Identity } from "../identity/src/index.ts";

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
  const authority = await Identity.fromPassphrase("ellyse5");

  const storageProvider = StorageManager.open({
    id: import.meta.url,
    address: new URL("/api/storage/memory", BASE_URL),
    as: authority,
  }).open(authority.did());

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
  if (result.ok) {
    console.log("sent entities successfully");
  } else {
    console.log("got error: " + JSON.stringify(result.error, null, 2));
  }
}

main();
