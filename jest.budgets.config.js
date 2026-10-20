// Only resource-budget files are loaded; correctness tests in those files remain in the coverage job.
const { budgetFiles } = require('./scripts/ci-budget-files.cjs');

module.exports = {
  ...require('./jest.config'),
  testMatch: budgetFiles(__dirname),
  testNamePattern: '\\[budget\\]',
  collectCoverage: false,
};
