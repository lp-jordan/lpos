import { getCoreDb } from './core-db';

/**
 * Per-date exceptions to the default working week.
 *
 * A row exists only where a date departs from the pattern, so the common case
 * (every weekend, forever) costs nothing. `working` runs both ways: 0 marks a
 * normally-working day as off, 1 opens a normally-off day up.
 */
export interface CalendarDayOverride {
  /** Inclusive ISO day, YYYY-MM-DD. */
  date: string;
  working: boolean;
  createdBy: string;
  createdAt: string;
}

interface Row {
  date: string;
  working: number;
  created_by: string;
  created_at: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function rowToOverride(row: Row): CalendarDayOverride {
  return {
    date: row.date,
    working: row.working === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export class CalendarDayStore {
  /** Every override. The table holds one row per exception, so this stays tiny
   *  — a few dozen rows a year — and the calendar wants them all at once. */
  getAll(): CalendarDayOverride[] {
    const rows = getCoreDb()
      .prepare('SELECT * FROM calendar_day_overrides ORDER BY date')
      .all() as Row[];
    return rows.map(rowToOverride);
  }

  /** Upsert. Callers delete rather than writing an override that matches the
   *  default pattern, so the table never accumulates no-op rows. */
  set(date: string, working: boolean, userId: string): CalendarDayOverride | null {
    if (!ISO_DAY.test(date)) return null;
    const createdAt = new Date().toISOString();
    getCoreDb().prepare(
      `INSERT INTO calendar_day_overrides (date, working, created_by, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET working = excluded.working,
                                       created_by = excluded.created_by,
                                       created_at = excluded.created_at`,
    ).run(date, working ? 1 : 0, userId, createdAt);
    return { date, working, createdBy: userId, createdAt };
  }

  /** Drop the exception, returning the date to the default pattern. */
  clear(date: string): boolean {
    if (!ISO_DAY.test(date)) return false;
    const res = getCoreDb().prepare('DELETE FROM calendar_day_overrides WHERE date = ?').run(date);
    return (res as { changes: number }).changes > 0;
  }
}

let singleton: CalendarDayStore | null = null;
export function getCalendarDayStore(): CalendarDayStore {
  singleton ??= new CalendarDayStore();
  return singleton;
}
