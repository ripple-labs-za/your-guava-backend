// Resource tests run in the plain budgets job. Keep correctness coverage and its floors intact.
module.exports = {
  ...require('./jest.config'),
  testNamePattern: '^(?![\\s\\S]*\\[budget\\])',
  // Each file owns its MongoMemoryReplSet; two workers bound both memory and wall time.
  maxWorkers: 2,
};
