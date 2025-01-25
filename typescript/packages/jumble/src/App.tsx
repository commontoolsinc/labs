import { useAllBlobs } from "./api.ts";
import "./App.css";
import BlobCanvas from "./BlobCanvas.tsx";

function App() {
  const { blobs } = useAllBlobs();

  return (
    <>
      <BlobCanvas blobs={blobs} />
    </>
  );
}

export default App;
