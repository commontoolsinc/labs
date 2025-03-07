import { useState } from "react";

interface ImagePreviewsProps {
  previewImage?: string;
  pageScreenshot?: string;
}

export function ImagePreviews({ previewImage, pageScreenshot }: ImagePreviewsProps) {
  const [activeTab, setActiveTab] = useState<'preview' | 'screenshot'>('preview');

  return (
    <div className="image-previews">
      <div className="image-preview-tabs">
        <button
          className={activeTab === 'preview' ? 'active' : ''}
          onClick={() => setActiveTab('preview')}
        >
          Preview Image
        </button>
        <button
          className={activeTab === 'screenshot' ? 'active' : ''}
          onClick={() => setActiveTab('screenshot')}
        >
          Screenshot
        </button>
      </div>

      <div className="image-preview-content">
        {activeTab === 'preview' && previewImage && (
          <img src={previewImage} alt="Site Preview" className="preview-image" />
        )}
        {activeTab === 'screenshot' && pageScreenshot && (
          <img src={pageScreenshot} alt="Page Screenshot" className="page-screenshot" />
        )}
      </div>
    </div>
  );
}
