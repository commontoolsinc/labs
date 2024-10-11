const API_URL = "http://localhost:8001";
let clipContent = null;

chrome.runtime.connect({ name: "popup" });

function displayClippedContent() {
  const contentDiv = document.getElementById("clippedContent");
  if (clipContent) {
    let contentHtml = `<h3>Clipped Content:</h3>`;
    if (clipContent.type === "text") {
      contentHtml += `<p>${clipContent.text}</p>`;
    } else if (clipContent.type === "link") {
      contentHtml += `<p>Link: <a href="${clipContent.url}" target="_blank">${clipContent.url}</a></p>`;
    } else if (clipContent.type === "image") {
      contentHtml += `<img src="${clipContent.url}" style="max-width: 100%; height: auto;">`;
    } else {
      contentHtml += `<p>${clipContent.type}: ${clipContent.url}</p>`;
    }
    contentDiv.innerHTML = contentHtml;
  } else {
    contentDiv.innerHTML = "";
  }
}

function clearClipContent() {
  chrome.storage.local.remove("clipContent", () => {
    clipContent = null;
    displayClippedContent();
  });
}

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .replace(/\s+/g, "-") // Replace spaces with -
    .replace(/[^\w\-]+/g, "") // Remove all non-word chars
    .replace(/\-\-+/g, "-") // Replace multiple - with single -
    .replace(/^-+/, "") // Trim - from start of text
    .replace(/-+$/, ""); // Trim - from end of text
}

function getPageSource() {
  return document.documentElement.outerHTML;
}

async function clipContentToCollection(collections, prompt = "") {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const url = clipContent ? clipContent.pageUrl : tabs[0].url;
      const content = clipContent || { type: "webpage", url: url };
      await new Promise((resolveSource) => {
        let activeTab = tabs[0];
        chrome.scripting.executeScript(
          {
            target: { tabId: activeTab.id },
            function: getPageSource,
          },
          (injectionResults) => {
            for (const frameResult of injectionResults) {
              console.log("Frame HTML:", frameResult.result);
              content.html = frameResult.result;
              resolveSource();
            }
          },
        );
      });

      fetch(`${API_URL}/clip`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: url,
          collections: collections,
          prompt: prompt,
          content: content,
        }),
      })
        .then((response) => response.json())
        .then((data) => {
          clearClipContent();
          resolve(data);
        })
        .catch((error) => {
          console.error("Error:", error);
          reject(error);
        });
    });
  });
}

function openCommonOS() {
  const COMMON_OS_URL = "http://localhost:5173";
  const newTab = window.open(COMMON_OS_URL, "_blank");
  newTab.focus();
  window.close();
}

document.addEventListener("DOMContentLoaded", () => {
  const searchInput = document.getElementById("searchInput");
  const recentCollections = document.getElementById("recentCollections");
  const searchResults = document.getElementById("searchResults");

  document
    .getElementById("openCommonOSButton")
    .addEventListener("click", openCommonOS);

  document
    .getElementById("openInCommonOSButton")
    .addEventListener("click", function () {
      clipContentToCollection(["inbox"])
        .then(() => {
          openCommonOS();
        })
        .catch((error) => {
          alert("An error occurred while clipping the content to inbox.");
        });
    });

  chrome.tabs.query(
    { active: true, currentWindow: true },
    async function (tabs) {
      const currentUrl = tabs[0].url;
      // Load recent collections
      fetch(
        `${API_URL}/suggested-collections?url=${encodeURIComponent(currentUrl)}`,
      )
        .then((response) => response.json())
        .then((collections) => {
          recentCollections.innerHTML =
            "<h3>Suggested Collections</h3>" +
            collections
              .map(
                (collection) => `
              <div class="collection-item">
                <input type="checkbox" id="${collection}" name="${collection}">
                <label for="${collection}">${collection}</label>
              </div>
            `,
              )
              .join("");
        });
    },
  );

  // Search collections
  searchInput.addEventListener("input", () => {
    const query = searchInput.value;
    if (query) {
      fetch(`${API_URL}/search-collections?q=${encodeURIComponent(query)}`)
        .then((response) => response.json())
        .then((collections) => {
          let resultsHtml = "<h3>Search Results</h3>";
          collections.forEach((collection) => {
            resultsHtml += `
              <div class="collection-item">
                <input type="checkbox" id="${collection}" name="${collection}">
                <label for="${collection}">${collection}</label>
              </div>
            `;
          });

          // Check if the exact query is not in the results
          if (!collections.includes(query)) {
            const slugifiedQuery = slugify(query);
            resultsHtml += `
              <div class="collection-item">
                <input type="checkbox" id="${slugifiedQuery}" name="${slugifiedQuery}">
                <label for="${slugifiedQuery}">${slugifiedQuery}</label>
              </div>
            `;
          }

          searchResults.innerHTML = resultsHtml;
        });
    } else {
      searchResults.innerHTML = "<h3>Search Results</h3>";
    }
  });

  chrome.storage.local.get(["clipContent"], (result) => {
    clipContent = result.clipContent;
    displayClippedContent();
  });
});

function getSelectedCollections() {
  const checkboxes = document.querySelectorAll(
    'input[type="checkbox"]:checked',
  );
  return Array.from(checkboxes).map((checkbox) => checkbox.name);
}

document.getElementById("clipButton").addEventListener("click", () => {
  const selectedCollections = getSelectedCollections();
  const prompt = document.getElementById("prompt").value;

  if (selectedCollections.length === 0) {
    alert("Please select at least one collection.");
    return;
  }

  clipContentToCollection(selectedCollections, prompt)
    .then((data) => {
      alert("Content clipped successfully!");

      // Create a pre element to display the response
      const responseElement = document.createElement("pre");
      responseElement.style.height = "200px";
      responseElement.style.overflowY = "scroll";
      responseElement.textContent = JSON.stringify(data, null, 2);

      // Append the response element to the body
      document.body.appendChild(responseElement);
    })
    .catch((error) => {
      console.error("Error:", error);
      alert("An error occurred while clipping the content.");
    });
});
