export interface PhotoSet {
  id: string;
  name: string;
  images: Array<{
    id: string;
    dataUrl: string;
    createdAt: string;
  }>;
  createdAt: string;
}

const STORAGE_KEY = "photosets";

export function getPhotoSets(): PhotoSet[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    const sets = data ? JSON.parse(data) : [];
    // Ensure we always return an array
    return Array.isArray(sets) ? sets : [];
  } catch (e) {
    // If there's any error parsing the JSON, return empty array
    console.error("Error loading photosets:", e);
    return [];
  }
}

export function savePhotoSet(photoset: PhotoSet): void {
  const sets = getPhotoSets();
  sets.push(photoset);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sets));
}

export function getPhotoSetByName(name: string): PhotoSet | undefined {
  return getPhotoSets().find((set) => set.name === name);
}

export function updatePhotoSet(photoset: PhotoSet): void {
  const sets = getPhotoSets();
  const index = sets.findIndex((set) => set.id === photoset.id);
  if (index !== -1) {
    sets[index] = photoset;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sets));
  }
}

export function deletePhotoSet(id: string): void {
  const sets = getPhotoSets();
  const filteredSets = sets.filter((set) => set.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filteredSets));
}
