import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface CacheRecord<T> {
  createdAt: number;
  value: T;
}

const cacheRoot = path.resolve(process.cwd(), ".sourcelens-cache");

function cachePath(namespace: string, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return path.join(cacheRoot, namespace, `${digest}.json`);
}

export async function readCache<T>(namespace: string, key: string, ttlMs: number): Promise<T | null> {
  try {
    const raw = await readFile(cachePath(namespace, key), "utf8");
    const record = JSON.parse(raw) as CacheRecord<T>;
    if (!record.createdAt || Date.now() - record.createdAt > ttlMs) return null;
    return record.value;
  } catch {
    return null;
  }
}

export async function writeCache<T>(namespace: string, key: string, value: T): Promise<void> {
  const target = cachePath(namespace, key);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(temp, JSON.stringify({ createdAt: Date.now(), value } satisfies CacheRecord<T>), "utf8");
    await rename(temp, target);
  } catch {
    // Cache failures must never fail an analysis.
  }
}
