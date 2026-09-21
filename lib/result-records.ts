// Pure result-record normalizer (P12 / R3-15): turns the shapes that ALREADY
// flow today — SubagentInfo roster entries (lib/subagent-types) and task
// toolResult detail rows (lib/session-reader keepTaskToolResultDetails) — into
// one flat ResultRecord for the compare-results table. Known fields only:
// anything the source shapes do not carry stays null. Nothing is invented.

import { asNumber, asString, isRecord } from "./type-guards";

export type ResultStatus = "complete" | "partial" | "failed" | "canceled" | "unknown";
export type ResultOrigin = "direct" | "delegated" | "scheduled" | "unknown";

export interface ResultRecord {
  id: string;
  agent: string;
  status: ResultStatus;
  /** task/assignment/description/error ladder, trimmed, hard-capped. */
  summary: string;
  filesChanged: number | null;
  testsPassed: number | null;
  testsFailed: number | null;
  tokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  model?: string;
  origin: ResultOrigin;
}

export const RESULT_SUMMARY_MAX = 300;

const ORIGINS: readonly ResultOrigin[] = ["direct", "delegated", "scheduled"];

function asOrigin(value: unknown): ResultOrigin {
  return ORIGINS.includes(value as ResultOrigin) ? (value as ResultOrigin) : "unknown";
}

/** First non-empty string among the candidates. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const str = asString(value);
    if (str !== undefined && str.trim() !== "") return str;
  }
  return undefined;
}

function pickNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  return record ? asNumber(record[key]) : undefined;
}

function summarize(...values: unknown[]): string {
  return (firstString(...values) ?? "").trim().slice(0, RESULT_SUMMARY_MAX);
}

/**
 * Status ladder (fixed precedence, first match wins):
 *   aborted (status or result.aborted)          → canceled
 *   failed status or an error string            → failed
 *   detached / async spawn                      → partial
 *   completed with no error                     → complete
 *   anything else (started / missing / junk)    → unknown
 */
export function normalizeResultRecord(raw: unknown): ResultRecord | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  if (!id) return null;
  const agent = asString(raw.agent) ?? "subagent";
  const result = isRecord(raw.result) ? raw.result : undefined;
  const progress = isRecord(raw.progress) ? raw.progress : undefined;
  const status = asString(raw.status);
  const detached = raw.detached === true || raw.async === true || isRecord(raw.async);
  const errorText = firstString(result?.error, raw.error);

  let mapped: ResultStatus;
  if (status === "aborted" || result?.aborted === true) mapped = "canceled";
  else if (status === "failed" || errorText !== undefined) mapped = "failed";
  else if (detached) mapped = "partial";
  else if (status === "completed") mapped = "complete";
  else mapped = "unknown";

  const cost = pickNumber(raw, "cost") ?? pickNumber(result, "cost") ?? pickNumber(progress, "cost");
  const tokens = pickNumber(raw, "tokens") ?? pickNumber(progress, "tokens");
  const durationMs = pickNumber(raw, "durationMs") ?? pickNumber(progress, "durationMs");
  const model = firstString(raw.resolvedModel, progress?.resolvedModel);

  const record: ResultRecord = {
    id,
    agent,
    status: mapped,
    summary: summarize(
      raw.task,
      raw.assignment,
      raw.description,
      errorText,
      raw.lastIntent,
      progress?.task,
      progress?.lastIntent,
    ),
    filesChanged: pickNumber(raw, "filesChanged") ?? null,
    testsPassed: pickNumber(raw, "testsPassed") ?? null,
    testsFailed: pickNumber(raw, "testsFailed") ?? null,
    tokens: tokens ?? null,
    costUsd: cost ?? null,
    durationMs: durationMs ?? null,
    origin: asOrigin(raw.origin),
  };
  if (model !== undefined) record.model = model;
  return record;
}

/** Map a list, dropping records that fail normalization (junk never renders). */
export function toResultRecords(values: readonly unknown[]): ResultRecord[] {
  const records: ResultRecord[] = [];
  for (const value of values) {
    const record = normalizeResultRecord(value);
    if (record) records.push(record);
  }
  return records;
}

export interface ResultStatusCounts {
  complete: number;
  partial: number;
  failed: number;
  canceled: number;
  unknown: number;
}

/** Status histogram for the compare header — pure fold, stable key order. */
export function compareResultRecords(records: readonly ResultRecord[]): ResultStatusCounts {
  const counts: ResultStatusCounts = { complete: 0, partial: 0, failed: 0, canceled: 0, unknown: 0 };
  for (const record of records) counts[record.status] += 1;
  return counts;
}
