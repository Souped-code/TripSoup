// E7 jest guard — the constraints twin of parse/__tests__/adapterGuard.test.ts:
// no test file may import the live constraints adapter, so a jest run can
// never make a billed compile call. (The Anthropic-SDK-wide scan already
// lives in the parse guard and covers this module's SDK import too.)

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

describe("constraints adapter import guard", () => {
  const repoRoot = path.resolve(__dirname, "../../../..");
  const testFiles = [
    ...collectTestFiles(path.join(repoRoot, "src")),
    ...(fs.existsSync(path.join(repoRoot, "e2e")) ? collectTestFiles(path.join(repoRoot, "e2e")) : []),
  ];

  it("found the test suite (guard is actually scanning something)", () => {
    expect(testFiles.length).toBeGreaterThanOrEqual(3);
  });

  it("no test file imports the llm constraints adapter", () => {
    const importPattern = /(?:from\s+|require\(|import\()\s*["'][^"']*llmConstraintsAdapter["']/;
    for (const file of testFiles) {
      const content = fs.readFileSync(file, "utf8");
      expect({ file, importsLlmConstraintsAdapter: importPattern.test(content) }).toEqual({
        file,
        importsLlmConstraintsAdapter: false,
      });
    }
  });
});
