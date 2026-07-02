/** Unit tests only — Playwright lives in e2e/ with its own runner. */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: { module: "commonjs", jsx: "react-jsx" } }],
  },
};
