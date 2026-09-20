// Wave-3 P1 parity gate (R3-29): en / zh-CN / ja must expose the exact same
// flat key set. Run via `npm run check:i18n`; exits 1 on any drift.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../lib/i18n/locales/", import.meta.url));
const locales = ["en", "zh-CN", "ja"];
const dicts = locales.map((locale) => ({
  locale,
  keys: new Set(Object.keys(JSON.parse(readFileSync(`${root}${locale}.json`, "utf8")))),
}));

const failures = [];
const [base, ...rest] = dicts;
for (const other of rest) {
  for (const key of base.keys) {
    if (!other.keys.has(key)) failures.push(`${other.locale} missing "${key}"`);
  }
  for (const key of other.keys) {
    if (!base.keys.has(key)) failures.push(`${other.locale} has extra key "${key}" (absent in ${base.locale})`);
  }
}

if (failures.length > 0) {
  console.error(`i18n parity FAILED — ${failures.length} problem(s):`);
  for (const failure of failures.slice(0, 40)) console.error(`  - ${failure}`);
  if (failures.length > 40) console.error(`  … and ${failures.length - 40} more`);
  process.exit(1);
}
console.log(`i18n parity OK — ${base.keys.size} keys × ${locales.length} locales, exact parity`);
