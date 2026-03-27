import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WishItem } from '@/lib/models/wish';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const WISHES_FILE = path.join(DATA_DIR, 'wishes.json');

interface WishesFile {
  wishes: WishItem[];
}

export class WishStore {
  private wishes: WishItem[] = [];

  constructor() {
    this.load();
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  private load() {
    try {
      if (fs.existsSync(WISHES_FILE)) {
        const data = JSON.parse(fs.readFileSync(WISHES_FILE, 'utf8')) as WishesFile;
        this.wishes = data.wishes ?? [];
      }
    } catch {
      this.wishes = [];
    }
  }

  private persist() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(WISHES_FILE, JSON.stringify({ wishes: this.wishes }, null, 2));
  }

  // ── Read ─────────────────────────────────────────────────────────────────

  getAll(): WishItem[] {
    return [...this.wishes].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  getById(wishId: string): WishItem | null {
    return this.wishes.find((w) => w.wishId === wishId) ?? null;
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  create(input: {
    title: string;
    description?: string;
    submittedBy: string;
    submittedByName: string;
  }): WishItem {
    const wish: WishItem = {
      wishId: randomUUID(),
      title: input.title.trim(),
      description: input.description?.trim() || undefined,
      submittedBy: input.submittedBy,
      submittedByName: input.submittedByName,
      completed: false,
      createdAt: new Date().toISOString(),
    };
    this.wishes.push(wish);
    this.persist();
    return wish;
  }

  update(wishId: string, patch: Partial<Pick<WishItem, 'completed'>>): WishItem | null {
    const idx = this.wishes.findIndex((w) => w.wishId === wishId);
    if (idx === -1) return null;
    const prev = this.wishes[idx];
    this.wishes[idx] = {
      ...prev,
      ...patch,
      completedAt:
        patch.completed === true && !prev.completed
          ? new Date().toISOString()
          : patch.completed === false
            ? undefined
            : prev.completedAt,
    };
    this.persist();
    return this.wishes[idx];
  }

  delete(wishId: string): boolean {
    const idx = this.wishes.findIndex((w) => w.wishId === wishId);
    if (idx === -1) return false;
    this.wishes.splice(idx, 1);
    this.persist();
    return true;
  }
}
