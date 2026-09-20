import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// ============================================================================
// Launch-profile helpers (BUILD-PLAN-2 Phase 3): pure mapping between the
// projects.json v2 launch fields and the /api/agent/new spawn body. The
// profile prompt is NOT a snippet — every test here pins that it travels
// verbatim, with no $PLACEHOLDER expansion.
// ============================================================================

const jiti = createJiti(import.meta.url);
const {
  LAUNCH_PROMPT_MAX,
  hasLaunchSpawnConfig,
  launchCommandFields,
  normalizeLaunchConfigFields,
  splitLaunchModelRef,
} = await jiti.import("./launch-profile.ts");

test("splitLaunchModelRef parses provider:modelId and rejects the degenerate forms", () => {
  assert.deepEqual(splitLaunchModelRef("anthropic:claude-x"), { provider: "anthropic", modelId: "claude-x" });
  // Model ids may themselves contain colons; the first colon splits.
  assert.deepEqual(splitLaunchModelRef("openrouter:openai/gpt-5:free"), { provider: "openrouter", modelId: "openai/gpt-5:free" });
  assert.equal(splitLaunchModelRef("no-colon"), null);
  assert.equal(splitLaunchModelRef(":no-provider"), null);
  assert.equal(splitLaunchModelRef("no-model:"), null);
  assert.equal(splitLaunchModelRef(""), null);
});

test("normalizeLaunchConfigFields keeps valid v2 fields and drops invalid ones", () => {
  assert.deepEqual(
    normalizeLaunchConfigFields({ prompt: "hi", model: "p:m", thinkingLevel: "high", toolsPreset: "default" }),
    { prompt: "hi", model: "p:m", thinkingLevel: "high", toolsPreset: "default" },
  );
  // Invalid values dropped: oversized prompt, unparseable model, unknown
  // thinking level, unknown preset, wrong types entirely.
  assert.deepEqual(
    normalizeLaunchConfigFields({
      prompt: "x".repeat(LAUNCH_PROMPT_MAX + 1),
      model: "no-colon",
      thinkingLevel: "ultra",
      toolsPreset: "everything",
      prompt2: "ignored",
    }),
    {},
  );
  // Prompt exactly at the cap survives.
  const atCap = { prompt: "y".repeat(LAUNCH_PROMPT_MAX) };
  assert.deepEqual(normalizeLaunchConfigFields(atCap), atCap);
  // Never emits undefined-valued keys, so callers can spread the result.
  const cleaned = normalizeLaunchConfigFields({});
  assert.deepEqual(Object.keys(cleaned), []);
});

test("hasLaunchSpawnConfig flags only configs carrying spawn shortcuts", () => {
  assert.equal(hasLaunchSpawnConfig(undefined), false);
  assert.equal(hasLaunchSpawnConfig({ profile: "work" }), false);
  assert.equal(hasLaunchSpawnConfig({ advisor: true, extraArgs: ["--verbose"] }), false);
  assert.equal(hasLaunchSpawnConfig({ prompt: "go" }), true);
  assert.equal(hasLaunchSpawnConfig({ model: "p:m" }), true);
  assert.equal(hasLaunchSpawnConfig({ thinkingLevel: "off" }), true);
  assert.equal(hasLaunchSpawnConfig({ toolsPreset: "none" }), true);
});

test("launchCommandFields maps prompt/model/thinking/tools onto spawn body fields", () => {
  const full = launchCommandFields({ prompt: "Do the thing", model: "anthropic:claude-x", thinkingLevel: "high", toolsPreset: "default" });
  assert.deepEqual(full, {
    type: "prompt",
    message: "Do the thing",
    provider: "anthropic",
    modelId: "claude-x",
    thinkingLevel: "high",
    toolNames: ["read", "bash", "edit", "write"],
  });

  // Empty/absent prompt = spawn without a first message (ensure_session).
  assert.deepEqual(launchCommandFields(undefined), { type: "ensure_session" });
  assert.deepEqual(launchCommandFields({ profile: "work" }), { type: "ensure_session" });
  assert.equal(launchCommandFields({ prompt: "   " }).type, "ensure_session");
  assert.equal("message" in launchCommandFields({ prompt: "   " }), false);
});

test("launchCommandFields: prompt is NOT a snippet — placeholders travel verbatim", () => {
  const fields = launchCommandFields({ prompt: "Fix $NAME and ${OTHER} for $$100" });
  assert.equal(fields.message, "Fix $NAME and ${OTHER} for $$100");
  assert.equal(fields.type, "prompt");
});

test("launchCommandFields: toolsPreset mapping (none=[], full=omit) and invalid values ignored", () => {
  assert.deepEqual(launchCommandFields({ toolsPreset: "none" }).toolNames, []);
  assert.equal("toolNames" in launchCommandFields({ toolsPreset: "full" }), false, "full leaves omp's default toolset intact");
  assert.deepEqual(launchCommandFields({ toolsPreset: "full" }).type, "ensure_session");

  const stale = launchCommandFields({ prompt: "go", model: "broken", thinkingLevel: "ultra", toolsPreset: "everything" });
  assert.deepEqual(stale, { type: "prompt", message: "go" }, "stale/invalid profile values never reach the spawn body");
});
