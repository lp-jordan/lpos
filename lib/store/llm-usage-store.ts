import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Records exact token usage + computed cost for every Claude call made by LPOS,
 * so the admin "AI Usage & Cost" card can show real spend. Token counts come
 * straight from each API response's `usage` block (not estimated); cost is those
 * tokens × the model's price rate in effect at call time (stored per row so
 * historical totals never shift if pricing changes later).
 */

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'lpos-llm-usage.sqlite');

declare global {
  // eslint-disable-next-line no-var
  var __lpos_llm_usage_db: DatabaseSync | undefined;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`PRAGMA journal_mode = WAL`);
  db.exec(`PRAGMA busy_timeout = 5000`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL,
      feature TEXT NOT NULL,
      model TEXT NOT NULL,
      project_id TEXT,
      asset_id TEXT,
      job_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      input_rate REAL NOT NULL DEFAULT 0,
      output_rate REAL NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_llm_usage_occurred ON llm_usage(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_feature ON llm_usage(feature, occurred_at);
  `);
}

function getDb(): DatabaseSync {
  if (!globalThis.__lpos_llm_usage_db) {
    const db = new DatabaseSync(DB_PATH);
    initSchema(db);
    globalThis.__lpos_llm_usage_db = db;
  }
  return globalThis.__lpos_llm_usage_db;
}

/** Per-1M-token price rates for a model. */
interface ModelRates { input: number; output: number }

/**
 * Price rates ($ per 1M tokens) in effect at `at`. Sonnet 5 carries an
 * introductory rate through 2026-08-31. Unknown models resolve to 0 (surfaced
 * as "unpriced" in the UI) rather than guessing.
 */
function getModelRates(model: string, at: Date): ModelRates {
  const m = model.toLowerCase();
  if (m.includes('sonnet-5') || m.includes('sonnet5')) {
    const intro = at < new Date('2026-09-01T00:00:00Z');
    return intro ? { input: 2, output: 10 } : { input: 3, output: 15 };
  }
  if (m.includes('sonnet')) return { input: 3, output: 15 };   // Sonnet 4.x
  if (m.includes('haiku')) return { input: 1, output: 5 };
  if (m.includes('opus')) return { input: 5, output: 25 };
  if (m.includes('fable') || m.includes('mythos')) return { input: 10, output: 50 };
  return { input: 0, output: 0 };
}

export interface LlmUsageInput {
  feature: string;
  model: string;
  projectId?: string | null;
  assetId?: string | null;
  jobId?: string | null;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

/**
 * Record one Claude call's usage + cost. Best-effort: never throws into the
 * caller (a monitoring write must not break the feature it measures).
 * Cache reads bill at 0.1× input, cache writes at 1.25× input.
 */
export function recordLlmUsage(entry: LlmUsageInput): void {
  try {
    const now = new Date();
    const rates = getModelRates(entry.model, now);
    const inTok = entry.usage.input_tokens ?? 0;
    const outTok = entry.usage.output_tokens ?? 0;
    const cacheRead = entry.usage.cache_read_input_tokens ?? 0;
    const cacheCreate = entry.usage.cache_creation_input_tokens ?? 0;
    const inRate = rates.input / 1_000_000;
    const outRate = rates.output / 1_000_000;
    const cost =
      inTok * inRate +
      cacheRead * inRate * 0.1 +
      cacheCreate * inRate * 1.25 +
      outTok * outRate;

    getDb().prepare(`
      INSERT INTO llm_usage (
        occurred_at, feature, model, project_id, asset_id, job_id,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        input_rate, output_rate, cost_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      now.toISOString(), entry.feature, entry.model,
      entry.projectId ?? null, entry.assetId ?? null, entry.jobId ?? null,
      inTok, outTok, cacheRead, cacheCreate,
      rates.input, rates.output, cost,
    );
  } catch (err) {
    console.warn('[llm-usage] failed to record usage:', err);
  }
}

export interface LlmUsageSummaryRow { key: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }
export interface LlmUsageRecentRow {
  occurredAt: string; feature: string; model: string;
  inputTokens: number; outputTokens: number; costUsd: number;
  projectId: string | null; assetId: string | null;
}
export interface LlmUsageReport {
  since: string;
  until: string;
  totals: { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
  byFeature: LlmUsageSummaryRow[];
  byModel: LlmUsageSummaryRow[];
  recent: LlmUsageRecentRow[];
}

/**
 * Aggregate usage between two ISO timestamps (inclusive of since, exclusive of
 * until). Powers the admin usage card.
 */
export function getLlmUsageReport(sinceIso: string, untilIso: string, recentLimit = 50): LlmUsageReport {
  const db = getDb();
  const totalsRow = db.prepare(`
    SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS inTok,
           COALESCE(SUM(output_tokens),0) AS outTok, COALESCE(SUM(cost_usd),0) AS cost
    FROM llm_usage WHERE occurred_at >= ? AND occurred_at < ?
  `).get(sinceIso, untilIso) as { calls: number; inTok: number; outTok: number; cost: number };

  const grouped = (col: 'feature' | 'model'): LlmUsageSummaryRow[] =>
    (db.prepare(`
      SELECT ${col} AS key, COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS inTok,
             COALESCE(SUM(output_tokens),0) AS outTok, COALESCE(SUM(cost_usd),0) AS cost
      FROM llm_usage WHERE occurred_at >= ? AND occurred_at < ?
      GROUP BY ${col} ORDER BY cost DESC
    `).all(sinceIso, untilIso) as Array<{ key: string; calls: number; inTok: number; outTok: number; cost: number }>)
      .map((r) => ({ key: r.key, calls: r.calls, inputTokens: r.inTok, outputTokens: r.outTok, costUsd: r.cost }));

  const recent = (db.prepare(`
    SELECT occurred_at, feature, model, input_tokens, output_tokens, cost_usd, project_id, asset_id
    FROM llm_usage WHERE occurred_at >= ? AND occurred_at < ?
    ORDER BY occurred_at DESC LIMIT ?
  `).all(sinceIso, untilIso, recentLimit) as Array<{
    occurred_at: string; feature: string; model: string;
    input_tokens: number; output_tokens: number; cost_usd: number;
    project_id: string | null; asset_id: string | null;
  }>).map((r) => ({
    occurredAt: r.occurred_at, feature: r.feature, model: r.model,
    inputTokens: r.input_tokens, outputTokens: r.output_tokens, costUsd: r.cost_usd,
    projectId: r.project_id, assetId: r.asset_id,
  }));

  return {
    since: sinceIso,
    until: untilIso,
    totals: { calls: totalsRow.calls, inputTokens: totalsRow.inTok, outputTokens: totalsRow.outTok, costUsd: totalsRow.cost },
    byFeature: grouped('feature'),
    byModel: grouped('model'),
    recent,
  };
}
