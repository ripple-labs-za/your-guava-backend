// Explicit opt-in mutation probe; ordinary Jest runs do not load this file.
const Organization = require('../../src/models/Organization.model');
const original = Organization.findOneAndUpdate;
Organization.findOneAndUpdate = function (filter, update, options) {
  if (filter.__v !== undefined && update.$addToSet?.fulfilledPaymentReferences) {
    filter = { ...filter };
    delete filter.__v;
  }
  return original.call(this, filter, update, options);
};
afterAll(() => { Organization.findOneAndUpdate = original; });
