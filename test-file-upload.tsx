/// <cts-enable />
import { Default, NAME, recipe, UI } from "commontools";

interface RecipeState {
  files: Default<any[], []>;
  images: Default<any[], []>;
}

interface RecipeOutput {
  files: any[];
  images: any[];
}

export default recipe<RecipeState, RecipeOutput>((state) => {
  return {
    [NAME]: "Test File Upload",
    [UI]: (
      <div style="padding: 2rem; max-width: 1200px; margin: 0 auto;">
        <h1>🧪 File Upload Component Tests</h1>

        <div style="margin: 2rem 0; padding: 1.5rem; border: 2px solid #e5e7eb; border-radius: 8px; background: white;">
          <h2>📄 ct-file-input (PDF Support)</h2>
          <p>Upload PDFs - they should NOT be compressed or resized</p>
          <ct-file-input
            accept="application/pdf"
            files={state.files}
            buttonText="📄 Upload PDF"
            multiple
          ></ct-file-input>

          <div style="margin-top: 1rem; padding: 1rem; background: #f9fafb; border-radius: 4px; border: 1px solid #e5e7eb;">
            <strong>Uploaded Files ({state.files.length}):</strong>
            {state.files.length === 0 ? (
              <p style="color: #6b7280;">No files uploaded yet</p>
            ) : (
              <ul style="list-style: none; padding: 0;">
                {state.files.map((file: any) => (
                  <li style="padding: 0.5rem; margin: 0.5rem 0; background: white; border: 1px solid #e5e7eb; border-radius: 4px; font-family: monospace; font-size: 0.875rem;">
                    <div><strong>{file.name}</strong></div>
                    <div>Type: {file.type}</div>
                    <div>Size: {(file.size / 1024).toFixed(1)} KB</div>
                    <div>Width: {file.width || 'N/A'} | Height: {file.height || 'N/A'}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div style="margin: 2rem 0; padding: 1.5rem; border: 2px solid #e5e7eb; border-radius: 8px; background: white;">
          <h2>🖼️ ct-image-input (Backward Compatibility)</h2>
          <p>Upload images - they SHOULD be compressed if over 1MB</p>
          <ct-image-input
            images={state.images}
            maxSizeBytes={1000000}
            buttonText="📷 Add Photos"
            multiple
          ></ct-image-input>

          <div style="margin-top: 1rem; padding: 1rem; background: #f9fafb; border-radius: 4px; border: 1px solid #e5e7eb;">
            <strong>Uploaded Images ({state.images.length}):</strong>
            {state.images.length === 0 ? (
              <p style="color: #6b7280;">No images uploaded yet</p>
            ) : (
              <ul style="list-style: none; padding: 0;">
                {state.images.map((img: any) => (
                  <li style="padding: 0.5rem; margin: 0.5rem 0; background: white; border: 1px solid #e5e7eb; border-radius: 4px; font-family: monospace; font-size: 0.875rem;">
                    <div><strong>{img.name}</strong></div>
                    <div>Type: {img.type}</div>
                    <div>Size: {(img.size / 1024).toFixed(1)} KB</div>
                    <div>Dimensions: {img.width}x{img.height}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div style="margin: 2rem 0; padding: 1.5rem; border: 2px solid #e5e7eb; border-radius: 8px; background: white;">
          <h2>✅ Test Checklist</h2>
          <ul>
            <li>✓ PDFs upload without errors</li>
            <li>✓ PDFs show no width/height (N/A)</li>
            <li>✓ PDFs are NOT resized</li>
            <li>✓ Images show correct dimensions</li>
            <li>✓ Large images get compressed</li>
            <li>✓ ct-image-input still works (backward compat)</li>
          </ul>
        </div>
      </div>
    ),
    files: state.files,
    images: state.images,
  };
});
