import React from "react";

export async function getAllBlobs(): Promise<any[]> {
  try {
    const response = await fetch(`/api/storage/blobby?allWithData=true`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error getting blobs:", error);
    throw error;
  }
}

export function useAllBlobs() {
  const [blobs, setBlobs] = React.useState<[string, any][]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<Error | null>(null);

  React.useEffect(() => {
    const fetchBlobs = async () => {
      setLoading(true);
      try {
        const allBlobs = await getAllBlobs();
        console.log(Object.entries(allBlobs));
        setBlobs(Object.entries(allBlobs));
      } catch (err) {
        setError(err as Error);
      } finally {
        setLoading(false);
      }
    };
    fetchBlobs();
  }, []);

  return { blobs, loading, error };
}
