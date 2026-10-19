// A preview needs the file reader, never the database/model graph. Make that startup cost deterministic.
const Module = require('node:module');
const load = Module._load;
Module._load = function withoutModels(request, ...args) {
  if (request === 'mongoose') throw new Error('Preview loaded the persistence layer');
  return load.call(this, request, ...args);
};
