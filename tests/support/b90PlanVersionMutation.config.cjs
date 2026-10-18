module.exports = {
  ...require('../../jest.config.js'),
  rootDir: require('node:path').resolve(__dirname, '../..'),
  setupFilesAfterEnv: [
    '<rootDir>/tests/hermetic.js',
    '<rootDir>/tests/support/b90PlanVersionMutation.cjs',
  ],
};
