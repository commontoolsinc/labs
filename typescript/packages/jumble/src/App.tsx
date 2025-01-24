import { useAllBlobs } from './api';
import './App.css'
import BlobCanvas from './BlobCanvas'

function App() {
  const { blobs } = useAllBlobs();

  return (
    <>
      <BlobCanvas blobs={blobs} />
    </>
  )
}

export default App
