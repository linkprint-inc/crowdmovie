/*
 * Node 25 defines a global `localStorage` of its own (gated on
 * --localstorage-file), and it wins over the one jsdom installs on the window.
 * Without a file path it is a non-functional stub, so every store that
 * persists a preference would throw here for a reason that has nothing to do
 * with the code under test. Install a real in-memory Storage instead.
 */
class MemoryStorage implements Storage {
  #map = new Map<string, string>();

  get length(): number {
    return this.#map.size;
  }
  clear(): void {
    this.#map.clear();
  }
  getItem(key: string): string | null {
    return this.#map.get(String(key)) ?? null;
  }
  key(index: number): string | null {
    return [...this.#map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.#map.delete(String(key));
  }
  setItem(key: string, value: string): void {
    this.#map.set(String(key), String(value));
  }
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  Object.defineProperty(globalThis, name, {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
}
