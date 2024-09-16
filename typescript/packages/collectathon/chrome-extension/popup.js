const API_URL = 'http://localhost:8000';
let selectedCollections = new Set();

document.addEventListener('DOMContentLoaded', function() {
  const searchInput = document.getElementById('searchInput');
  const recentCollectionsDiv = document.getElementById('recentCollections');
  const searchResultsDiv = document.getElementById('searchResults');
  const promptInput = document.getElementById('prompt');
  const clipButton = document.getElementById('clipButton');

  // Load recent collections
  fetchRecentCollections();

  // Add event listener for search input
  searchInput.addEventListener('input', debounce(handleSearch, 300));

  // Add event listener for clip button
  clipButton.addEventListener('click', handleClip);

  function fetchRecentCollections() {
    fetch(`${API_URL}/recent-collections`)
      .then(response => response.json())
      .then(collections => {
        renderCollectionList(recentCollectionsDiv, collections, 'Recent Collections');
      })
      .catch(error => console.error('Error fetching recent collections:', error));
  }

  function handleSearch() {
    const query = searchInput.value.trim();
    if (query) {
      fetch(`${API_URL}/search-collections?q=${encodeURIComponent(query)}`)
        .then(response => response.json())
        .then(collections => {
          if (collections.length === 0) {
            collections.push('"' + slugify(query) + '"');
          }
          renderCollectionList(recentCollectionsDiv, collections, 'Search Results');
          recentCollectionsDiv.style.display = 'block';
          searchResultsDiv.style.display = 'none';
        })
        .catch(error => console.error('Error searching collections:', error));
    } else {
      fetchRecentCollections();
      recentCollectionsDiv.style.display = 'block';
      searchResultsDiv.style.display = 'none';
    }
  }

  function renderCollectionList(container, collections, title) {
    container.innerHTML = `<h3>${title}</h3>`;
    collections.forEach(collection => {
      const div = document.createElement('div');
      div.className = 'collection-item';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = collection;
      checkbox.checked = selectedCollections.has(collection);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          selectedCollections.add(collection);
        } else {
          selectedCollections.delete(collection);
        }
      });
      const label = document.createElement('label');
      label.textContent = collection;
      div.appendChild(checkbox);
      div.appendChild(label);
      container.appendChild(div);
    });
  }
  function handleClip() {
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      const url = tabs[0].url;
      const collections = Array.from(selectedCollections).map(collection => collection.replace(/[^a-zA-Z0-9-_]/g, ''));
      const prompt = promptInput.value;

      if (collections.length === 0) {
        alert('Please select at least one collection');
        return;
      }

      fetch(`${API_URL}/clip`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url, collections, prompt }),
      })
      .then(response => response.json())
      .then(data => {
        console.log(`Clipped to collections:`, data);
        window.close();
      })
      .catch(error => {
        console.error(`Error clipping to collections:`, error);
      });

      alert(`URL clipped to ${collections.length} collection(s)`);
    });
  }

  function debounce(func, delay) {
    let timeoutId;
    return function (...args) {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => func.apply(this, args), delay);
    };
  }

  function slugify(text) {
    return text.toString().toLowerCase()
      .replace(/\s+/g, '-')           // Replace spaces with -
      .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
      .replace(/\-\-+/g, '-')         // Replace multiple - with single -
      .replace(/^-+/, '')             // Trim - from start of text
      .replace(/-+$/, '');            // Trim - from end of text
  }
});
