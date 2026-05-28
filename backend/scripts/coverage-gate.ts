/**
 * Coverage threshold gate.
 *
 * Reads `coverage/lcov.info` (produced by `bun test --coverage --coverage-reporter=lcov`)
 * and fails the process if any of the watched directories falls under the
 * minimum bar:
 *
 *   - src/agent  → lines ≥ 80 %, branches ≥ 70 %
 *   - src/repo   → lines ≥ 80 %, branches ≥ 70 %
 *   - src/routes → lines ≥ 80 %, branches ≥ 70 %
 *
 * The numbers come from the build plan and reflect the relative criticality
 * of each module — the agent loop and route handlers carry the most surface
 * area for safety-bearing behavior.
 *
 * Why lcov: Bun's test runner only emits `text` and `lcov` reporters today (no
 * native JSON summary), and we don't want to add `c8` or `nyc` just to render
 * a summary file. The lcov format is line-oriented and trivial to parse.
 *
 * Usage:
 *
 *   bun test --coverage --coverage-reporter=lcov
 *   bun run scripts/coverage-gate.ts
 *
 * TODO(devops): wire this as the final step of the `backend-test` CI job
 * after the existing `bun test --coverage` step. The CI config has not been
 * edited from this task — Tier 4b owns that file.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const LCOV_PATH = resolve(__dirname, "..", "coverage", "lcov.info");

interface FileCoverage {
  /** Source file relative to repo root (e.g. "src/agent/agent.ts"). */
  path: string;
  linesFound: number;
  linesHit: number;
  branchesFound: number;
  branchesHit: number;
}

interface Gate {
  prefix: string;
  minLinesPct: number;
  minBranchesPct: number;
}

const GATES: Gate[] = [
  { prefix: "src/agent", minLinesPct: 80, minBranchesPct: 70 },
  { prefix: "src/repo", minLinesPct: 80, minBranchesPct: 70 },
  { prefix: "src/routes", minLinesPct: 80, minBranchesPct: 70 },
];

/**
 * Parse an lcov.info file. Each record begins with `SF:<source-path>` and ends
 * with `end_of_record`. We only need the LF/LH/BRF/BRH totals; the per-line
 * detail (DA, BRDA) is fine to skip.
 */
function parseLcov(raw: string): FileCoverage[] {
  const out: FileCoverage[] = [];
  let current: FileCoverage | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      current = {
        path: line.slice(3).trim(),
        linesFound: 0,
        linesHit: 0,
        branchesFound: 0,
        branchesHit: 0,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("LF:")) current.linesFound = Number(line.slice(3)) || 0;
    else if (line.startsWith("LH:")) current.linesHit = Number(line.slice(3)) || 0;
    else if (line.startsWith("BRF:")) current.branchesFound = Number(line.slice(4)) || 0;
    else if (line.startsWith("BRH:")) current.branchesHit = Number(line.slice(4)) || 0;
    else if (line.trim() === "end_of_record") {
      out.push(current);
      current = null;
    }
  }
  return out;
}

function normalize(p: string): string {
  // lcov may emit absolute paths depending on cwd; trim to the `src/...` root.
  const ix = p.lastIndexOf("/backend/");
  if (ix >= 0) return p.slice(ix + "/backend/".length);
  const srcIx = p.indexOf("src/");
  if (srcIx >= 0) return p.slice(srcIx);
  return p;
}

function aggregateForPrefix(
  files: FileCoverage[],
  prefix: string,
): { linesFound: number; linesHit: number; branchesFound: number; branchesHit: number; matched: number } {
  const agg = {
    linesFound: 0,
    linesHit: 0,
    branchesFound: 0,
    branchesHit: 0,
    matched: 0,
  };
  for (const f of files) {
    if (!normalize(f.path).startsWith(prefix)) continue;
    agg.matched += 1;
    agg.linesFound += f.linesFound;
    agg.linesHit += f.linesHit;
    agg.branchesFound += f.branchesFound;
    agg.branchesHit += f.branchesHit;
  }
  return agg;
}

function pct(hit: number, found: number): number {
  if (found === 0) return 100;
  return (hit / found) * 100;
}

function main(): void {
  if (!existsSync(LCOV_PATH)) {
    console.error(
      `coverage-gate: ${LCOV_PATH} missing.\n` +
        `  Run: bun test --coverage --coverage-reporter=lcov`,
    );
    process.exit(2);
  }

  let raw: string;
  try {
    raw = readFileSync(LCOV_PATH, "utf8");
  } catch (err) {
    console.error(
      `coverage-gate: failed to read ${LCOV_PATH}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(2);
  }

  const files = parseLcov(raw);
  if (files.length === 0) {
    console.error("coverage-gate: lcov.info contained no records");
    process.exit(2);
  }

  const failures: string[] = [];
  const lines: string[] = [];
  for (const gate of GATES) {
    const agg = aggregateForPrefix(files, gate.prefix);
    if (agg.matched === 0) {
      failures.push(
        `[${gate.prefix}] no files in coverage report — check test discovery.`,
      );
      continue;
    }
    const linesPct = pct(agg.linesHit, agg.linesFound);
    const branchesPct = pct(agg.branchesHit, agg.branchesFound);
    lines.push(
      `[${gate.prefix}] files=${agg.matched} ` +
        `lines=${linesPct.toFixed(1)}% ` +
        `branches=${branchesPct.toFixed(1)}% ` +
        `(min lines=${gate.minLinesPct}% branches=${gate.minBranchesPct}%)`,
    );
    if (linesPct < gate.minLinesPct) {
      failures.push(
        `[${gate.prefix}] lines coverage ${linesPct.toFixed(
          1,
        )}% < required ${gate.minLinesPct}%`,
      );
    }
    if (branchesPct < gate.minBranchesPct) {
      failures.push(
        `[${gate.prefix}] branches coverage ${branchesPct.toFixed(
          1,
        )}% < required ${gate.minBranchesPct}%`,
      );
    }
  }

  for (const l of lines) console.log(l);
  if (failures.length > 0) {
    console.error("\ncoverage gate FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\ncoverage gate OK");
}

main();
