import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { mergeNativeUsage, latestQuotaSamples } = await jiti.import("./usage-native.ts");

// ---------------------------------------------------------------------------
// base report fixture: two ompweb days (2026-09-18, 2026-09-19), one provider,
// one model, one project.
// ---------------------------------------------------------------------------

function baseReport() {
  return {
    timeRange: "30d",
    granularity: "daily",
    summary: {
      totalCost: 1.0,
      totalTokens: 1000,
      inputTokens: 600,
      outputTokens: 300,
      reasoningTokens: 0,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      cacheSavings: 0.01,
      activeDays: 2,
      tokensPerActiveDay: 500,
      cachePercentage: 100 * (100 / 700),
      costQuality: { providerReported: 100, modelPriced: 0, unpriced: 0 },
    },
    providers: [
      { provider: "prov1", name: "Prov1", cost: 1.0, tokens: 1000, share: 100, color: "#123456" },
    ],
    timeSeries: [
      {
        date: "2026-09-18", label: "Sep 18", timestamp: 1,
        totalCost: 0.4, totalTokens: 400,
        byProvider: { prov1: { cost: 0.4, tokens: 400 } },
      },
      {
        date: "2026-09-19", label: "Sep 19", timestamp: 2,
        totalCost: 0.6, totalTokens: 600,
        byProvider: { prov1: { cost: 0.6, tokens: 600 } },
      },
    ],
    modelBreakdown: [
      {
        model: "m1", provider: "prov1", cost: 1.0, tokens: 1000,
        inputTokens: 600, outputTokens: 300, cacheReadTokens: 100, cacheWriteTokens: 0,
        reasoningTokens: 0, share: 100, recordsCount: 10,
      },
    ],
    dayBreakdown: [
      { date: "2026-09-19", label: "Sep 19, 2026", cost: 0.6, tokens: 600, inputTokens: 360, outputTokens: 180, cacheReadTokens: 60, share: 60 },
      { date: "2026-09-18", label: "Sep 18, 2026", cost: 0.4, tokens: 400, inputTokens: 240, outputTokens: 120, cacheReadTokens: 40, share: 40 },
    ],
    projectBreakdown: [
      { project: "C:\\repo", projectName: "repo", cost: 1.0, tokens: 1000, share: 100, sessionsCount: 3 },
    ],
    scanInfo: { transcriptsScanned: 5, transcriptsOutsideWindow: 0, usageRecordsCount: 10, durationSeconds: 0.1, scannedAt: 0 },
  };
}

function nativeAggregates() {
  return {
    // overlaps 2026-09-19 and adds a CLI-only day 2026-09-20
    days: [
      { date: "2026-09-19", cost: 0.5, tokens: 500, inputTokens: 300, outputTokens: 150, cacheReadTokens: 50 },
      { date: "2026-09-20", cost: 0.25, tokens: 250, inputTokens: 150, outputTokens: 75, cacheReadTokens: 25 },
    ],
    providerDays: [
      { date: "2026-09-19", provider: "prov2", cost: 0.5, tokens: 500 },
      { date: "2026-09-20", provider: "prov2", cost: 0.25, tokens: 250 },
    ],
    models: [
      { model: "m2", provider: "prov2", cost: 0.75, tokens: 750 }, // native-only model
    ],
    projects: [
      { folder: "-Desktop", cost: 0.75, tokens: 750, sessions: 2 },
    ],
  };
}

// ---------------------------------------------------------------------------

test("union math: summary totals, provider shares, and native meta", () => {
  const merged = mergeNativeUsage(baseReport(), nativeAggregates(), { available: true, partial: false, included: true });
  assert.equal(merged.summary.totalCost, 1.75); // 1.0 + 0.75
  assert.equal(merged.summary.totalTokens, 1750);
  assert.equal(merged.summary.inputTokens, 1050);
  assert.equal(merged.summary.outputTokens, 525);
  assert.equal(merged.summary.cacheReadTokens, 175);
  assert.deepEqual(merged.native, { available: true, partial: false, included: true, cost: 0.75, tokens: 750, records: 750 });
  // provider list now carries prov2 with a recomputed share over the union
  const prov2 = merged.providers.find((p) => p.provider === "prov2");
  const prov1 = merged.providers.find((p) => p.provider === "prov1");
  assert.equal(prov2.cost, 0.75);
  assert.ok(Math.abs(prov2.share - 100 * (0.75 / 1.75)) < 1e-9);
  assert.ok(Math.abs(prov1.share + prov2.share - 100) < 1e-9);
});

test("time series unions overlapping and new day buckets with per-provider sums", () => {
  const merged = mergeNativeUsage(baseReport(), nativeAggregates(), { available: true, partial: false, included: true });
  assert.deepEqual(merged.timeSeries.map((p) => p.date), ["2026-09-18", "2026-09-19", "2026-09-20"]);
  const sep19 = merged.timeSeries.find((p) => p.date === "2026-09-19");
  assert.equal(sep19.totalCost, 1.1); // 0.6 ompweb + 0.5 native
  assert.equal(sep19.totalTokens, 1100);
  assert.deepEqual(sep19.byProvider, {
    prov1: { cost: 0.6, tokens: 600 },
    prov2: { cost: 0.5, tokens: 500 },
  });
  const sep20 = merged.timeSeries.find((p) => p.date === "2026-09-20");
  assert.equal(sep20.totalCost, 0.25);
});

test("model/day/project breakdowns badge native-only rows and recompute shares", () => {
  const merged = mergeNativeUsage(baseReport(), nativeAggregates(), { available: true, partial: false, included: true });

  const m2 = merged.modelBreakdown.find((m) => m.model === "m2");
  const m1 = merged.modelBreakdown.find((m) => m.model === "m1");
  assert.equal(m2.source, "native");
  assert.ok(!("source" in m1) || m1.source === undefined, "ompweb rows stay unbadged");
  assert.ok(Math.abs(m2.share - 100 * (0.75 / 1.75)) < 1e-9);
  assert.ok(Math.abs(m1.share - 100 * (1.0 / 1.75)) < 1e-9);

  const sep19 = merged.dayBreakdown.find((d) => d.date === "2026-09-19");
  const sep20 = merged.dayBreakdown.find((d) => d.date === "2026-09-20");
  assert.equal(sep19.source, undefined, "overlapping day stays an ompweb row (merged in place)");
  assert.equal(sep19.cost, 1.1);
  assert.equal(sep20.source, "native");
  assert.ok(Math.abs(sep20.share - 100 * (0.25 / 1.75)) < 1e-9);
  // day breakdown stays sorted newest first
  assert.deepEqual(merged.dayBreakdown.map((d) => d.date), ["2026-09-20", "2026-09-19", "2026-09-18"]);

  const cli = merged.projectBreakdown.find((p) => p.project === "-Desktop");
  assert.equal(cli.source, "native");
  assert.equal(cli.projectName, "-Desktop");
  assert.equal(cli.sessionsCount, 2);
  const repo = merged.projectBreakdown.find((p) => p.project === "C:\\repo");
  assert.ok(Math.abs(repo.share - 100 * (1.0 / 1.75)) < 1e-9);
});

test("model union adds native usage into an existing model row instead of duplicating", () => {
  const aggregates = nativeAggregates();
  aggregates.models = [{ model: "m1", provider: "prov1", cost: 0.3, tokens: 300 }];
  const merged = mergeNativeUsage(baseReport(), aggregates, { available: true, partial: false, included: true });
  assert.equal(merged.modelBreakdown.length, 1);
  assert.equal(merged.modelBreakdown[0].cost, 1.3);
  assert.equal(merged.modelBreakdown[0].tokens, 1300);
});

test("excluded or empty native input leaves the report intact and marks included: false", () => {
  const empty = { days: [], providerDays: [], models: [], projects: [] };
  const excluded = mergeNativeUsage(baseReport(), nativeAggregates(), { available: true, partial: false, included: false });
  assert.equal(excluded.summary.totalCost, 1.0);
  assert.deepEqual(excluded.native, { available: true, partial: false, included: false, cost: 0, tokens: 0, records: 0 });

  const absent = mergeNativeUsage(baseReport(), empty, { available: false, partial: false, included: true });
  assert.equal(absent.summary.totalCost, 1.0);
  assert.equal(absent.native.included, false);
  assert.equal(absent.native.available, false);
  assert.deepEqual(absent.timeSeries.map((p) => p.date), ["2026-09-18", "2026-09-19"]);
});

test("partial flag passes through even when the merge succeeds", () => {
  const merged = mergeNativeUsage(baseReport(), nativeAggregates(), { available: true, partial: true, included: true });
  assert.equal(merged.native.partial, true);
  assert.equal(merged.native.included, true);
});

test("latestQuotaSamples keeps the newest sample per scope, fullest first, capped", () => {
  const samples = latestQuotaSamples([
    { ts: "2026-09-19T00:00:00Z", scope: "a:5h", usedPct: 20, label: "A 5h" },
    { ts: "2026-09-19T01:00:00Z", scope: "a:5h", usedPct: 40, label: "A 5h" },
    { ts: "2026-09-19T00:30:00Z", scope: "b:7d", usedPct: 90, label: "B 7d" },
    { ts: "2026-09-19T02:00:00Z", scope: "c:week", usedPct: 10 },
  ]);
  assert.deepEqual(samples.map((s) => s.scope), ["b:7d", "a:5h", "c:week"]); // 90 > 40 > 10
  const a = samples.find((s) => s.scope === "a:5h");
  assert.equal(a.usedPct, 40); // newest of the two, not the max
  assert.equal(a.label, "A 5h");
  // cap is respected
  const capped = latestQuotaSamples(
    Array.from({ length: 10 }, (_, i) => ({ ts: `2026-09-19T0${i}:00:00Z`, scope: `s${i}`, usedPct: i })),
    3,
  );
  assert.equal(capped.length, 3);
  assert.deepEqual(capped.map((s) => s.usedPct), [9, 8, 7]);
});
