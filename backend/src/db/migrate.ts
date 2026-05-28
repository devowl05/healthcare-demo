/**
 * Forward-only migration runner.
 *
 * Reads `migrations/*.sql` (this file's directory + `/migrations`), sorts
 * alphanumerically (the leading zero-padded sequence guarantees correct order),
 * and applies any version not already in `schema_migrations`. Each file runs
 * inside a single transaction. Failure aborts that file's txn and exits 1; the
 * remainder of the run is skipped so the operator can investigate.
 *
 * Bootstrapping: `schema_migrations` is created by `001_init.sql` itself. We
 * defensively SELECT against it after the first migration completes; the
 * initial run path queries with try/catch so the table doesn't yet need to exist.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "./client.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(__dirname, "migrations");

interface MigrationFile {
  /** Filename version stem, e.g. "001_init". Used as the PK in schema_migrations. */
  version: string;
  /** Absolute path. */
  path: string;
}

async function discoverMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  return entries
    .filter((f) => f.endsWith(".sql"))
    .sort() // alphanumeric — leading-zero numbering guarantees correct order
    .map((f) => ({
      version: f.replace(/\.sql$/, ""),
      path: join(dir, f),
    }));
}

async function appliedVersions(): Promise<Set<string>> {
  try {
    const rows = await sql<{ version: string }[]>`
      SELECT version FROM schema_migrations
    `;
    return new Set(rows.map((r) => r.version));
  } catch (err) {
    // schema_migrations does not yet exist — that's fine on first run.
    // 42P01 = undefined_table
    if (
      err &&
      typeof err === "object" &&
      (err as { code?: string }).code === "42P01"
    ) {
      return new Set();
    }
    throw err;
  }
}

async function applyOne(mig: MigrationFile): Promise<void> {
  const body = await readFile(mig.path, "utf8");
  await sql.begin(async (tx) => {
    // postgres-js requires `sql.unsafe(...)` for raw multi-statement bodies.
    await tx.unsafe(body);
    await tx`
      INSERT INTO schema_migrations (version)
      VALUES (${mig.version})
      ON CONFLICT (version) DO NOTHING
    `;
  });
}

export interface RunResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply all pending migrations. Idempotent — re-running after success is a
 * no-op. Logs each application to stdout for compose/CI visibility.
 */
export async function runMigrations(dir: string = MIGRATIONS_DIR): Promise<RunResult> {
  const migrations = await discoverMigrations(dir);
  const applied = await appliedVersions();
  const result: RunResult = { applied: [], skipped: [] };

  for (const mig of migrations) {
    if (applied.has(mig.version)) {
      result.skipped.push(mig.version);
      continue;
    }
    console.log(`[migrate] applying ${mig.version}`);
    await applyOne(mig);
    result.applied.push(mig.version);
    console.log(`[migrate]   ✓ ${mig.version}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

function isHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

function printHelp(): void {
  console.log(
    [
      "Usage: bun run src/db/migrate.ts [--help]",
      "",
      "Applies pending SQL files from src/db/migrations/ in lexicographic order.",
      "Each file runs in its own transaction; already-applied versions are skipped.",
      "Records applications in the schema_migrations table.",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (isHelp(argv)) {
    printHelp();
    process.exit(0);
  }
  try {
    const result = await runMigrations();
    if (result.applied.length === 0) {
      console.log(`[migrate] up to date (${result.skipped.length} already applied)`);
    } else {
      console.log(
        `[migrate] done — applied ${result.applied.length}, skipped ${result.skipped.length}`,
      );
    }
    await sql.end({ timeout: 5 });
    process.exit(0);
  } catch (err) {
    console.error("[migrate] FAILED:", err);
    try {
      await sql.end({ timeout: 5 });
    } catch {
      // ignore — we're exiting anyway
    }
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
