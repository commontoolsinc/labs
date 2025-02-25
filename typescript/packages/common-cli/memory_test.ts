import { CharmManager, createStorage } from "@commontools/charm";
import { RemoteStorageProvider } from "../common-charm/src/storage/remote.ts"
import { StorageValue } from "../common-charm/src/storage/base.ts";

// some config stuff, hardcoded, ofcourse
const replica = "ellyse5";
// i'm running common memory locally, so connect to it directly
const BASE_URL = "http://localhost:8000"
const entityId = { "/": "foobar" }

async function main() {
  const storageProvider = new RemoteStorageProvider({
    address: new URL("/api/storage/memory", BASE_URL),
    space: replica as MemorySpace,
  });

  console.log("created RemoteStorageProvider: " + JSON.stringify(storageProvider, null, 2));
  
  // first lets try to get the value
  await storageProvider.sync(entityId);
  const fetchedValue = storageProvider.get<SomePerson>(entityId);
  if (fetchedValue)
    console.log("retrieved entity: " + JSON.stringify(fetchedValue.value))
  else 
    console.log("retrieved entity but it was undefined");

  // now lets try to store a new value into the entity
  type SomePerson = {
    name: string;
    version: number;
  };
  
  const myValue: SomePerson = {
    name: "something_special",
    version: Math.floor(Math.random() * 1000)
  };

  const myStorageValue: StorageValue<SomePerson> = {
    value: myValue
  }

  console.log("sending value: " + JSON.stringify(myValue, null, 2));

  const result = await storageProvider.send([
    {
      entityId: entityId, 
      value: myStorageValue
    }
  ]);

  console.log("sent entity, result: " + JSON.stringify(result, null, 2))
}

main();
