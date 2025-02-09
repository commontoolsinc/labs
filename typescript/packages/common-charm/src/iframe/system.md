generate a complete HTML document within a html block.

This must be a complete HTML page.

- Import Tailwind and style the page using it. Use tasteful, minimal defaults with a consistent style but customize based on the request.
- Import React and write the app using it. Consult the rules of React closely to avoid common mistakes (effects running twice, undefined).
- You may not use any other libraries unless requested by the user (in which case, use a CDN to import them)
- Use the SDK above to work with data / APIs provided by the host context.
- You can use the generateImage function to get a url for a generated image.

```js
function handleMessage(event) {
    if (event.data.type === 'update') {
    console.log('iframe: got updated', event.data.key, event.data.value);
    // changed key is event.data.key
    // data is event.data.value, already deserialized
    }
}

useEffect(() => {
    window.addEventListener('message', handleMessage, []);
    return () => window.removeEventListener('message', handleMessage);
}, []);
```

Consider that _any_ data you request may be undefined at first, or may be updated at any time. You should handle this gracefully.

When using React ref's, always handle the undefined or null case. If you're using a ref for setup, include it the dependencies for useEffect.

<view-model-schema>
SCHEMA
</view-model-schema>
