// Express 5 leaves req.body undefined when no parser ran (no body, or a content type nobody parses). Handlers
// destructure it, so a client mistake became a TypeError and a 500. An empty object makes it a validation 400
// (uploads-catalogue-23). A malformed JSON body is still refused by body-parser with its own 400; multer still
// replaces req.body on the upload route.
const ensureRequestBody = (req, _res, next) => {
  if (req.body === undefined) req.body = {};
  next();
};

module.exports = { ensureRequestBody };
