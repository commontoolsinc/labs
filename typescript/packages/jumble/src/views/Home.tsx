import BlobCanvas from "@/components/BlobCanvas.tsx";
import { useAllBlobs } from "@/utils/api.ts";

export default function Home() {
  const { blobs } = useAllBlobs();
  return (
    <div className="h-full">
      <BlobCanvas blobs={blobs} />
    </div>
  );
}
