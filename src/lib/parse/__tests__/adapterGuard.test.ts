// §parse jest guard — same scanning approach as maps/__tests__/adapterGuard.test.ts:
// no test file may import the LLM adapter or the Anthropic SDK directly, so a
// jest run can never make a live (billed) API call.

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

describe("parse adapter import guard", () => {
  const repoRoot = path.resolve(__dirname, "../../../..");
  const testFiles = [
    ...collectTestFiles(path.join(repoRoot, "src")),
    ...(fs.existsSync(path.join(repoRoot, "e2e")) ? collectTestFiles(path.join(repoRoot, "e2e")) : []),
  ];

  it("found the test suite (guard is actually scanning something)", () => {
    expect(testFiles.length).toBeGreaterThanOrEqual(3);
  });

  it("no test file imports the llm adapter", () => {
    // covers static import, require(), and dynamic import()
    const importPattern = /(?:from\s+|require\(|import\()\s*["'][^"']*llmAdapter["']/;
    for (const file of testFiles) {
      const content = fs.readFileSync(file, "utf8");
      expect({ file, importsLlmAdapter: importPattern.test(content) }).toEqual({
        file,
        importsLlmAdapter: false,
      });
    }
  });

  it("no test file imports the Anthropic SDK directly", () => {
    const importPattern = /(?:from\s+|require\(|import\()\s*["']@anthropic-ai\/sdk["']/;
    for (const file of testFiles) {
      const content = fs.readFileSync(file, "utf8");
      expect({ file, importsAnthropicSdk: importPattern.test(content) }).toEqual({
        file,
        importsAnthropicSdk: false,
      });
    }
  });
});
