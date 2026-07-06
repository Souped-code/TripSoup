// §3 jest guard: the fixture adapter is the only adapter imported by tests.
// The real adapter must never be constructed in the test environment — this
// scans every test file's import/require statements for the real adapter module.

import * as fs from "fs";
import * as path from "path";

function collectTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") collectTestFiles(full, out);
    else if (/\.(test|spec)\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("adapter import guard (§3)", () => {
  const repoRoot = path.resolve(__dirname, "../../../..");
  const testFiles = [
    ...collectTestFiles(path.join(repoRoot, "src")),
    ...(fs.existsSync(path.join(repoRoot, "e2e"))
      ? collectTestFiles(path.join(repoRoot, "e2e"))
      : []),
  ];

  it("found the test suite (guard is actually scanning something)", () => {
    expect(testFiles.length).toBeGreaterThanOrEqual(3);
  });

  it("no test file imports the real adapter", () => {
    // covers static import, require(), and dynamic import()
    const importPattern = /(?:from\s+|require\(|import\()\s*["'][^"']*realAdapter["']/;
    for (const file of testFiles) {
      const content = fs.readFileSync(file, "utf8");
      expect({ file, importsRealAdapter: importPattern.test(content) }).toEqual({
        file,
        importsRealAdapter: false,
      });
    }
  });

  // routeGeometry.ts (D2.3 M2a) is NOT gated like realAdapter/llmAdapter — it
  // is safe to import and construct with no key (every failure path resolves
  // to null, by design). So banning its import outright doesn't fit this
  // guard's usual mechanism: routeGeometry.test.ts legitimately imports it to
  // exercise the stubbed-deps paths. The equivalent danger here is a test
  // putting a REAL key into the env, which would make createRouteGeometrySource()'s
  // default (env-based) apiKey resolution start hitting live AWS the moment a
  // test forgets to inject a stub fetcher. So this scans for that instead —
  // same mechanism (source scan over testFiles), different target.
  it("no test file sets a real AWS_LOCATION_API_KEY (route geometry must be exercised via injected deps only)", () => {
    // dot AND bracket assignment forms; `(?!=)` keeps `===` comparisons legal
    const assignPattern =
      /process\.env(?:\.AWS_LOCATION_API_KEY|\[\s*["']AWS_LOCATION_API_KEY["']\s*\])\s*=(?!=)/;
    for (const file of testFiles) {
      const content = fs.readFileSync(file, "utf8");
      expect({ file, setsAwsLocationKey: assignPattern.test(content) }).toEqual({
        file,
        setsAwsLocationKey: false,
      });
    }
  });
});
