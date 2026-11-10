// IndexedDB wrapper. Database "liftlog" v1: `sets` (keyPath id) and `meta` (key/value).

const DB_NAME = 'liftlog';
const DB_VERSION = 1;

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const sets = db.createObjectStore('sets', { keyPath: 'id' });
        sets.createIndex('exerciseId', 'exerciseId');
        sets.createIndex('date', 'date');
        db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

// Runs fn(store) in one transaction; resolves with the result of the request fn returns (if any)
// once the transaction commits.
async function run(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    let result;
    const req = fn(tx.objectStore(storeName));
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const addSet = set => run('sets', 'readwrite', s => s.add(set));
export const putSet = set => run('sets', 'readwrite', s => s.put(set));
export const setsByExercise = id => run('sets', 'readonly', s => s.index('exerciseId').getAll(id));
export const setsByDate = date => run('sets', 'readonly', s => s.index('date').getAll(date));
export const allSets = () => run('sets', 'readonly', s => s.getAll());

// Deletes and puts in a single transaction.
export const writeSets = ({ put = [], del = [] }) => run('sets', 'readwrite', s => {
  del.forEach(id => s.delete(id));
  put.forEach(set => s.put(set));
});

export const replaceAll = sets => run('sets', 'readwrite', s => {
  s.clear();
  sets.forEach(set => s.put(set));
});

export const getMeta = key => run('meta', 'readonly', s => s.get(key));
export const setMeta = (key, value) => run('meta', 'readwrite', s => s.put(value, key));

// Local calendar date as YYYY-MM-DD. Never use toISOString() for this: it is UTC.
export function localDate(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
