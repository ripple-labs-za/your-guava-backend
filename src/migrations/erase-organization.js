/**
 * Operator-only D-016 erasure. Never registered as a startup migration.
 * Stop writers (API, jobs and imports) and take the approved backup first; keep
 * them stopped until success. Storage cannot participate in a Mongo transaction:
 * delete files first, retaining Upload metadata on failure so reruns can retry.
 * Database deletions, payment anonymisation and the register commit atomically.
 *
 * node src/migrations/erase-organization.js --org <id>                 # counts only
 * node src/migrations/erase-organization.js --org <id> --apply --requester-note case-105
 * --requester-note is an opaque case reference, never a name/email/free-text note.
 * Remote/production targets also require --allow-production and an interactive
 * typed "ERASE <id>". No URI, file key or customer data is printed or registered.
 * PaymentSession is the invoice record; there is no separate Invoice model.
 * Retained financial rows have no user/card/payload/checkout data. This script
 * does not expire statutory records or change retention policy.
 */
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { isSafeSeedMongoUri } = require('../utils/seedMongoSafety');
const { sha256Hex } = require('../utils/authPrimitives');
const storage = require('../services/r2.service');

// Explicit policies make newly added tenant models fail closed. Indirect scopes
// are named too: user sessions/resets, email registrations/throttles, counters.
const POLICIES = Object.freeze({
  Organization: { action: 'delete', scope: 'organization' },
  User: { action: 'delete', scope: 'org' },
  Cafe: { action: 'delete', scope: 'org' },
  Transaction: { action: 'delete', scope: 'cafe' },
  Upload: { action: 'delete', scope: 'cafe' },
  Item: { action: 'delete', scope: 'cafe' },
  Event: { action: 'delete', scope: 'cafe' },
  Forecast: { action: 'delete', scope: 'cafe' },
  GeneratedInsight: { action: 'delete', scope: 'orgOrCafe' },
  InsightChat: { action: 'delete', scope: 'orgOrCafe' },
  Staff: { action: 'delete', scope: 'cafe' },
  Shift: { action: 'delete', scope: 'cafe' },
  LeaveRequest: { action: 'delete', scope: 'cafe' },
  LeaveBalance: { action: 'delete', scope: 'cafe' },
  UsageLedger: { action: 'delete', scope: 'orgOrCafe' },
  AuthSession: { action: 'delete', scope: 'user' },
  PasswordResetToken: { action: 'delete', scope: 'user' },
  TeamInvitation: { action: 'delete', scope: 'org' },
  AccessAuditEvent: { action: 'delete', scope: 'org' },
  IntegrationOAuthState: { action: 'delete', scope: 'cafeOrUser' },
  Improvement: { action: 'delete', scope: 'orgOrCafe' },
  Counter: { action: 'delete', scope: 'counter' },
  PendingRegistration: { action: 'delete', scope: 'email' },
  AuthThrottle: { action: 'delete', scope: 'emailHash' },
  PaymentSession: { action: 'anonymize', scope: 'org' },
  Migration: { action: 'keep', reason: 'Global migration history; contains no tenant or personal data.' },
});

function loadModels() {
  for (const file of fs.readdirSync(path.join(__dirname, '../models'))) {
    if (file.endsWith('.model.js')) require(path.join(__dirname, '../models', file));
  }
}

function assertModelCoverage(models = Object.values(mongoose.models)) {
  const missing = models.filter((model) => !Object.hasOwn(POLICIES, model.modelName));
  if (missing.length) throw new Error(`Missing erasure policy: ${missing.map((model) => model.modelName).join(', ')}`);
}

function validateOptions({ orgId, apply, requesterNote }) {
  if (typeof orgId !== 'string' || !/^[a-f0-9]{24}$/i.test(orgId)) throw new Error('--org must be a 24-character ObjectId');
  if (apply && (typeof requesterNote !== 'string' || !/^case-[a-z0-9-]{1,64}$/i.test(requesterNote))) {
    throw new Error('--requester-note must be an opaque case reference (case-...), without personal data');
  }
}

function parseArgs(argv) {
  const options = { orgId: undefined, apply: false, allowProduction: false, requesterNote: undefined };
  const names = { '--org': 'orgId', '--requester-note': 'requesterNote', '--apply': 'apply', '--allow-production': 'allowProduction' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!Object.hasOwn(names, arg)) throw new Error('Unknown erasure option');
    if (seen.has(arg)) throw new Error('Duplicate erasure option');
    seen.add(arg);
    const key = names[arg];
    if (key === 'apply' || key === 'allowProduction') options[key] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[key] = argv[++i];
    }
  }
  validateOptions(options);
  return options;
}

function assertSafeTarget({ mongoUri, nodeEnv, orgId, allowProduction = false, confirmation }) {
  if (!mongoUri) throw new Error('MONGODB_URI is required');
  if (isSafeSeedMongoUri(mongoUri, nodeEnv)) return;
  if (!allowProduction) throw new Error('Refusing remote/production Mongo target without --allow-production');
  if (confirmation !== `ERASE ${orgId}`) throw new Error('Exact typed confirmation required');
}

function filterFor(scope, { orgId, cafeIds, userIds, emails }) {
  const cafes = { cafeId: { $in: cafeIds } };
  const users = { userId: { $in: userIds } };
  switch (scope) {
    case 'organization': return { _id: orgId };
    case 'org': return { orgId };
    case 'cafe': return cafes;
    case 'orgOrCafe': return { $or: [{ orgId }, cafes] };
    case 'user': return users;
    case 'cafeOrUser': return { $or: [cafes, users] };
    case 'counter': return { _id: `improvementTicket:${orgId}` };
    case 'email': return { email: { $in: emails } };
    case 'emailHash': return { _id: { $in: emails.flatMap((email) =>
      ['login', 'email_password_reset', 'email_signup'].map((bucket) => `${bucket}:${sha256Hex(email)}`)) } };
    default: throw new Error('Unknown erasure scope');
  }
}

// Replacement is deliberately an allowlist: even an unmodelled old provider
// payload or a future personal field must disappear, rather than survive $unset.
const FINANCIAL_FIELDS = [
  '_id', 'orgId', 'provider', 'kind', 'status', 'reference', 'amount', 'currency',
  'plan', 'billingCycle', 'credits', 'paidAt', 'reversedAt', 'failedAt', 'createdAt', 'updatedAt',
];
function anonymousPayment(payment, erasedAt) {
  const retained = { anonymizedAt: erasedAt };
  for (const field of FINANCIAL_FIELDS) {
    if (Object.hasOwn(payment, field)) retained[field] = payment[field];
  }
  return retained;
}

async function eraseOrganization({ orgId: input, apply = false, requesterNote } = {}) {
  validateOptions({ orgId: input, apply, requesterNote });
  loadModels();
  assertModelCoverage();
  const orgId = new mongoose.Types.ObjectId(input);
  const register = mongoose.connection.collection('erasureRegisters');
  const previous = await register.findOne({ _id: orgId });
  if (previous) return { apply, alreadyErased: true, counts: previous.counts };
  if (!await mongoose.model('Organization').exists({ _id: orgId })) throw new Error('Organisation not found');
  const cafes = await mongoose.model('Cafe').find({ orgId }).select('_id').lean();
  const users = await mongoose.model('User').find({ orgId }).select('_id email').lean();
  const context = {
    orgId, cafeIds: cafes.map((row) => row._id), userIds: users.map((row) => row._id),
    emails: users.map((row) => row.email).filter(Boolean).map((email) => email.toLowerCase().trim()),
  };
  const counts = {};
  const filters = {};
  for (const [name, policy] of Object.entries(POLICIES)) {
    if (policy.action === 'keep') continue;
    filters[name] = filterFor(policy.scope, context);
    counts[name] = { action: policy.action, documents: await mongoose.model(name).countDocuments(filters[name]), files: 0 };
  }
  const fileKeys = await mongoose.model('Upload').distinct('r2Key', filters.Upload);
  const keys = [...new Set(fileKeys.filter((key) => typeof key === 'string' && key))];
  counts.Upload.files = keys.length;
  if (!apply) return { apply, counts };

  // No metadata is lost if storage refuses: deleting an absent file is safe on retry.
  for (const key of keys) await storage.deleteFile(key);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const [name, policy] of Object.entries(POLICIES)) {
        if (policy.action === 'delete') {
          const result = await mongoose.model(name).deleteMany(filters[name], { session });
          counts[name].documents = result.deletedCount;
        } else if (policy.action === 'anonymize') {
          const collection = mongoose.model(name).collection;
          const cursor = collection.find(filters[name], { session });
          let documents = 0;
          for await (const payment of cursor) {
            await collection.replaceOne({ _id: payment._id, orgId }, anonymousPayment(payment, new Date()), { session });
            documents += 1;
          }
          counts[name].documents = documents;
        }
      }
      await register.insertOne({ _id: orgId, requesterNote, counts, erasedAt: new Date() }, { session });
    });
  } finally {
    await session.endSession();
  }
  return { apply, counts };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  const target = { ...options, mongoUri: env.MONGODB_URI, nodeEnv: env.NODE_ENV };
  if (!isSafeSeedMongoUri(target.mongoUri, target.nodeEnv) && options.allowProduction) {
    if (!process.stdin.isTTY) throw new Error('Interactive typed confirmation required');
    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      target.confirmation = await new Promise((resolve) => terminal.question(`Type ERASE ${options.orgId}: `, resolve));
    } finally { terminal.close(); }
  }
  assertSafeTarget(target);
  try {
    await mongoose.connect(target.mongoUri);
    const report = await eraseOrganization(options);
    console.log(JSON.stringify(report, null, 2));
    if (!options.apply) console.log('Dry run. No changes made. Stop all writers before --apply.');
  } finally { await mongoose.disconnect(); }
}

module.exports = { POLICIES, assertModelCoverage, parseArgs, assertSafeTarget, eraseOrganization, main };
if (require.main === module) {
  require('dotenv').config();
  main().catch((error) => {
    // Connection/storage errors can embed credentials or file keys. Print only
    // our fixed validation sentences; all other failures get a fixed refusal.
    const safe = /^(--org|--requester-note|Unknown erasure|Duplicate erasure|Missing value|MONGODB_URI|Refusing |Exact typed|Interactive typed|Organisation not found|Missing erasure policy)/;
    console.error(safe.test(error.message) ? error.message : 'Erasure failed; no completed receipt. Investigate and rerun with writers stopped.');
    process.exitCode = 1;
  });
}
