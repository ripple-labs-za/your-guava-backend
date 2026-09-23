/**
 * Re-export barrel (BE-11-T03). Handlers live in ./uploads/*; the parsing lease
 * in uploads/lease.js, the post-import job queue in uploads/jobs.js, the sweeper
 * in uploads/sweeper.js. server.js and the routes import this path (the startup
 * test mocks it), so keep every export here.
 */
const { localDownload } = require('./uploads/download');
const { confirm } = require('./uploads/confirm');
const { list } = require('./uploads/list');
const { detail, rows, overlaps } = require('./uploads/detail');
const { remap } = require('./uploads/remap');
const { remove } = require('./uploads/remove');
const { cleanupAbandonedPendingUploads } = require('./uploads/sweeper');
const { recoverPendingUploadMaintenance } = require('./uploads/jobs');

module.exports = {
  localDownload,
  confirm,
  list,
  detail,
  rows,
  overlaps,
  remap,
  remove,
  cleanupAbandonedPendingUploads,
  recoverPendingUploadMaintenance,
};
