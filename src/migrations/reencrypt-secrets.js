const logger = require('../utils/logger');
const mongoose = require('mongoose');
const Cafe = require('../models/Cafe.model');
const { decryptSecretWithStatus, encryptSecret, decryptSecret } = require('../services/secrets.service');

/**
 * Re-seals every stored provider token under the current TOKEN_ENCRYPTION_KEY: plaintext rows written
 * before encryption existed, v1 envelopes without a key id, and envelopes sealed with the previous key.
 *
 * Key rotation, in order: set TOKEN_ENCRYPTION_KEY_PREVIOUS to the old key and TOKEN_ENCRYPTION_KEY to the
 * new one, deploy, run this with --apply, confirm a second dry run reports 0, then remove the previous key.
 * Do not run --apply until rollback below BE-09-T03 is ruled out: that older code cannot read v2
 * envelopes, and rolling back requires reconnecting the integrations (ISSUES #78 / GATE-03).
 * Development only: a JWT-fallback source of 64 hex or 43-44 base64 characters is always scrypted,
 * whereas TOKEN_ENCRYPTION_KEY_PREVIOUS treats it as a raw key. It cannot be copied into previous;
 * reconnect those development integrations when switching to an explicit encryption key.
 * Interim pre-release v2 envelopes without authenticated key ids must also be recreated; v1 remains readable.
 *
 *   node src/migrations/reencrypt-secrets.js           # dry run: counts only, changes nothing
 *   node src/migrations/reencrypt-secrets.js --apply   # write the upgrades
 *
 * It never prints a token, plaintext or sealed.
 */
const valueAt = (doc, path) => path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), doc);

const planSecretUpgrades = (cafes, paths) => {
  const upgrades = [];
  const failures = [];
  for (const cafe of cafes) {
    for (const path of paths) {
      const stored = valueAt(cafe, path);
      if (stored == null || stored === '') continue;
      try {
        const { needsReencrypt, reason } = decryptSecretWithStatus(stored);
        if (needsReencrypt) upgrades.push({ cafeId: String(cafe._id), path, reason, stored });
      } catch (error) {
        failures.push({ cafeId: String(cafe._id), path, code: error.code || 'SECRET_UNREADABLE' });
      }
    }
  }
  return { upgrades, failures };
};

const applySecretUpgrades = async (upgrades) => {
  let modified = 0;
  for (const { cafeId, path, stored } of upgrades) {
    const result = await Cafe.updateOne(
      { _id: cafeId, [path]: stored },
      { $set: { [path]: encryptSecret(decryptSecret(stored)) } }
    );
    modified += result.modifiedCount;
  }
  return modified;
};

/** The CLI's work on the open connection: report counts (never a token), and write the upgrades with apply. */
const rotate = async ({ apply = false, print = (line) => logger.printLine(line) } = {}) => {
  const paths = Cafe.secretPaths();
  const cafes = await Cafe.find({}).select(paths.map((path) => `+${path}`).join(' ')).lean();
  const { upgrades, failures } = planSecretUpgrades(cafes, paths);
  const byReason = upgrades.reduce((counts, { reason }) => ({ ...counts, [reason]: (counts[reason] || 0) + 1 }), {});

  print(`cafes scanned: ${cafes.length}`);
  print(`upgrades: ${upgrades.length} ${JSON.stringify(byReason)}`);
  print(`unreadable: ${failures.length}`);
  for (const failure of failures.slice(0, 20)) print(`  ${failure.cafeId} ${failure.path} ${failure.code}`);

  let modified = 0;
  if (apply && upgrades.length > 0) {
    modified = await applySecretUpgrades(upgrades);
    print(`modified: ${modified}`);
  } else if (!apply) print('Dry run. Re-run with --apply to write these changes.');
  return { scanned: cafes.length, upgrades: upgrades.length, unreadable: failures.length, modified };
};

async function main() {
  require('dotenv').config();
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGODB_URI);
  await rotate({ apply });
  await mongoose.disconnect();
}

module.exports = { planSecretUpgrades, applySecretUpgrades, rotate };

if (require.main === module) {
  main().then(() => process.exit(0)).catch((error) => {
    logger.error('secret_rotation_failed', { code: error.code || 'SECRET_MIGRATION_FAILED' });
    process.exit(1);
  });
}
