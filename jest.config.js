module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testTimeout: 30000,
  verbose: true,
  // Hermetic by design (BE-12-T01). globalSetup pins the timezone before any test file runs;
  // tests/env.js sets every variable src reads before any module loads; tests/hermetic.js makes
  // dotenv inert and refuses outbound network.
  globalSetup: '<rootDir>/tests/globalSetup.js',
  setupFiles: ['<rootDir>/tests/env.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/hermetic.js'],
  // Coverage (BE-12-T04). Computed only with --coverage, so a single-file TDD run is never gated.
  collectCoverageFrom: ['src/**/*.js'],
  coverageProvider: 'v8',
  coverageReporters: ['text-summary', 'json-summary'],
  coverageThreshold: {
    // Totals only. The 70% per-file floor is checked by scripts/static-checks.mjs from coverage/coverage-summary.json,
    // because a Jest glob threshold takes the files it matches out of this global total.
    global: { lines: 85, branches: 75 },
  },
};
