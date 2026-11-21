/** Content-addressed cache for object files and linked wasm. */

const DB_NAME = 'systemc-circuit-objects';
const STORE = 'objects';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('no indexedDB'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  try {
    const bytes = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    return bytes ? new Uint8Array(bytes) : null;
  } finally {
    db.close();
  }
}

async function idbSet(key, bytes) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(new Uint8Array(bytes), key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createObjectCache() {
  const memory = new Map();
  return {
    async get(key) {
      if (memory.has(key)) return memory.get(key);
      try {
        const bytes = await idbGet(key);
        if (bytes) memory.set(key, bytes);
        return bytes;
      } catch {
        return null;
      }
    },
    async set(key, bytes) {
      const copy = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      memory.set(key, copy);
      try { await idbSet(key, copy); } catch { /* private mode */ }
    },
  };
}
