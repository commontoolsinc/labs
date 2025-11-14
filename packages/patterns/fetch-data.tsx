/// <cts-enable />
import { computed, Default, fetchData, NAME, recipe, UI } from "commontools";

export default recipe<
  { url: Default<string, "https://api.github.com/repos/vercel/next.js"> }
>(
  "URL Fetcher Demo",
  (state) => {
    // Fetch data from any URL
    const fetchResult = fetchData<any>({
      url: state.url,
    });
    const data = fetchResult.result;

    const printedData = computed(() =>
      data ? JSON.stringify(data, null, 2) : "No data"
    );

    return {
      [NAME]: "URL Fetcher",
      [UI]: (
        <div>
          <div>
            <ct-input
              $value={state.url}
              placeholder="Enter any URL"
              customStyle="width: 100%; padding: 8px; font-size: 14px;"
            />
          </div>

          <div>
            <h3>Response:</h3>
            <pre style="background-color: #f5f5f5; padding: 16px; border-radius: 4px; overflow: auto; white-space: pre-wrap;">
              {printedData}
            </pre>
          </div>
        </div>
      ),
      result: data,
    };
  },
);
