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
    const importPattern = /(?:from\s+|require\()\s*["'][^"']*realAdapter["']/;
    for (const file of testFiles) {
      const content = fs.readFileSync(file, "utf8");
      expect({ file, importsRealAdapter: importPattern.test(content) }).toEqual({
        file,
        importsRealAdapter: false,
      });
    }
  });
});
