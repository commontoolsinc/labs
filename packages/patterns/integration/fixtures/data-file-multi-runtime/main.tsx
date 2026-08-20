/// <cts-enable />
// FIXTURE (multi-runtime integration): reads a data file attached to the
// program, so the test has something that can only succeed if the file
// travelled with the source. The pattern compiles and type-checks whether or
// not the file is attached; it fails at the read.
import { dataFile, NAME, pattern } from "commonfabric";

interface Cities {
  cities: string[];
}

export default pattern(() => {
  const parsed = JSON.parse(
    dataFile("/integration/fixtures/data-file-multi-runtime/data/cities.json"),
  ) as Cities;
  return {
    [NAME]: "Data file reader (multi-runtime fixture)",
    cities: parsed.cities,
    count: parsed.cities.length,
  };
});
