export function fetchApiKey() {
  let apiKey = localStorage.getItem("apiKey");

  if (!apiKey) {
    // Prompt the user for the API key if it doesn't exist
    const userApiKey = prompt("Please enter your API key:");

    if (userApiKey) {
      // Save the API key in localStorage
      localStorage.setItem("apiKey", userApiKey);
      apiKey = userApiKey;
    } else {
      // Handle the case when the user cancels or doesn't provide an API key
      alert("API key not provided. Some features may not work.");
    }
  }

  return apiKey;
}
