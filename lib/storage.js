// Atomic JSON file storage. Write to .tmp then rename (POSIX atomic).
import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || './data';
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const locks = new Map();
async function withLock(file, fn) {
  while (locks.get(file)) await locks.get(file);
  let release;
  const p = new Promise(r => { release = r; });
  locks.set(file, p);
  try { return await fn(); } finally { locks.delete(file); release(); }
}

function full(file) { return path.join(DATA_DIR, file); }

export async function readJSON(file, fallback) {
  try {
    const raw = await fs.readFile(full(file), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

export async function writeJSON(file, data) {
  return withLock(file, async () => {
    const tmp = full(file + '.tmp');
    const final = full(file);
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, final);
  });
}

export async function updateJSON(file, fallback, updater) {
  return withLock(file, async () => {
    let current;
    try { current = JSON.parse(await fs.readFile(full(file), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; current = fallback; }
    const next = await updater(current);
    const tmp = full(file + '.tmp');
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await fs.rename(tmp, full(file));
    return next;
  });
}

export function dataDir() { return DATA_DIR; }
