const DB_NAME = "syncura-local-assets";
const STORE_NAME = "wallpapers";
const WALLPAPER_KEY = "personal";
const SELECTION_KEY = "syncura.wallpaper";

export interface WallpaperOption {
  id: string;
  label: string;
  kind: "solid" | "gradient";
  background: string;
}

export const WALLPAPERS: WallpaperOption[] = [
  { id: "dusk", label: "Dusk", kind: "solid", background: "var(--bg)" },
  { id: "blush", label: "Blush", kind: "solid", background: "#f6d8d2" },
  { id: "sage", label: "Sage", kind: "solid", background: "#d7e6d8" },
  { id: "sky", label: "Sky", kind: "solid", background: "#d8e8f6" },
  { id: "aurora", label: "Aurora", kind: "gradient", background: "linear-gradient(135deg, #d8e8f6, #f6d8d2)" },
  { id: "meadow", label: "Meadow", kind: "gradient", background: "linear-gradient(135deg, #d7e6d8, #f6e7c5)" },
];

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open local wallpaper storage"));
  });
}

export async function loadWallpaper(): Promise<Blob | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(WALLPAPER_KEY);
      request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
      request.onerror = () => reject(request.error ?? new Error("Could not load the saved wallpaper"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Wallpaper read was interrupted"));
    });
  } finally {
    database.close();
  }
}

export async function saveWallpaper(file: File): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(file, WALLPAPER_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save the wallpaper"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Wallpaper save was interrupted"));
    });
  } finally {
    database.close();
  }
}

export async function clearWallpaper(): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(WALLPAPER_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not remove the wallpaper"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Wallpaper removal was interrupted"));
    });
  } finally {
    database.close();
  }
}

export function selectedWallpaper(): string {
  try {
    const saved = localStorage.getItem(SELECTION_KEY);
    if (saved && WALLPAPERS.some((option) => option.id === saved)) return saved;
  } catch {
    return WALLPAPERS[0].id;
  }
  return WALLPAPERS[0].id;
}

export function chooseWallpaper(id: string): void {
  const option = WALLPAPERS.find((candidate) => candidate.id === id);
  if (!option) throw new Error("Unknown wallpaper");
  try {
    localStorage.setItem(SELECTION_KEY, option.id);
  } catch {
    throw new Error("Could not save wallpaper");
  }
  applyWallpaper();
}

export function applyWallpaper(): void {
  if (typeof document === "undefined") return;
  const id = selectedWallpaper();
  const option = WALLPAPERS.find((candidate) => candidate.id === id) ?? WALLPAPERS[0];
  document.documentElement.style.setProperty("--wallpaper", option.background);
  document.body.style.background = option.background;
}
