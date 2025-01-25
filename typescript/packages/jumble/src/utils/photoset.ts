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
  const data = localStorage.getItem(STORAGE_KEY);
  return data ? JSON.parse(data) : [];
}

export function savePhotoSet(photoset: PhotoSet): void {
  const sets = getPhotoSets();
  sets.push(photoset);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sets));
}

export function getPhotoSetByName(name: string): PhotoSet | undefined {
  return getPhotoSets().find(set => set.name === name);
}

export function updatePhotoSet(photoset: PhotoSet): void {
  const sets = getPhotoSets();
  const index = sets.findIndex(set => set.id === photoset.id);
  if (index !== -1) {
    sets[index] = photoset;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sets));
  }
}
