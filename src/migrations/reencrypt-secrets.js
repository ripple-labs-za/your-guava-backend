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

async function main() {
  require('dotenv').config();
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGODB_URI);
  const paths = Cafe.secretPaths();
  const cafes = await Cafe.find({}).select(paths.map((path) => `+${path}`).join(' ')).lean();
  const { upgrades, failures } = planSecretUpgrades(cafes, paths);
  const byReason = upgrades.reduce((counts, { reason }) => ({ ...counts, [reason]: (counts[reason] || 0) + 1 }), {});

  logger.printLine(`cafes scanned: ${cafes.length}`);
  logger.printLine(`upgrades: ${upgrades.length} ${JSON.stringify(byReason)}`);
  logger.printLine(`unreadable: ${failures.length}`);
  for (const failure of failures.slice(0, 20)) logger.printLine(`  ${failure.cafeId} ${failure.path} ${failure.code}`);

  if (apply && upgrades.length > 0) logger.printLine(`modified: ${await applySecretUpgrades(upgrades)}`);
  else if (!apply) logger.printLine('Dry run. Re-run with --apply to write these changes.');

  await mongoose.disconnect();
}

module.exports = { planSecretUpgrades, applySecretUpgrades };

if (require.main === module) {
  main().then(() => process.exit(0)).catch((error) => {
    logger.error('secret_rotation_failed', { code: error.code || 'SECRET_MIGRATION_FAILED' });
    process.exit(1);
  });
}
