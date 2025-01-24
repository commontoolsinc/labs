/* eslint-disable @typescript-eslint/no-explicit-any */
const API_URL = "http://localhost:8000";

export async function getAllBlobs(): Promise<any[]> {
  try {
    const response = await fetch(`${API_URL}/api/storage/blobby?allWithData=true`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error getting blobs:', error);
    throw error;
  }
}
