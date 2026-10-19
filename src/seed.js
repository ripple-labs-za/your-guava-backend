const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const User = require('./models/User.model');
const Cafe = require('./models/Cafe.model');
const Organization = require('./models/Organization.model');
const { ingestFile } = require('./services/ingestion.service');
const { isSafeSeedMongoUri } = require('./utils/seedMongoSafety');

/** The seed options from the environment and the CLI argument, with the local demo defaults. */
const seedOptionsFromEnv = (argv = process.argv) => ({
  mongoUri: process.env.MONGODB_URI,
  importFile: process.env.SEED_IMPORT_FILE || argv[2],
  userName: process.env.SEED_USER_NAME,
  userEmail: process.env.SEED_USER_EMAIL,
  userPassword: process.env.SEED_USER_PASSWORD,
  orgName: process.env.SEED_ORG_NAME,
  cafeName: process.env.SEED_CAFE_NAME,
  cafeCity: process.env.SEED_CAFE_CITY,
  cafeAddress: process.env.SEED_CAFE_ADDRESS,
  nodeEnv: process.env.NODE_ENV,
});

const resolveImportFile = (importFile) => {
  if (!importFile) throw new Error('SEED_IMPORT_FILE or an import file argument is required.');
  const resolved = path.resolve(importFile);
  if (!fs.existsSync(resolved)) throw new Error(`Import file does not exist: ${resolved}`);
  return resolved;
};

/**
 * Seeds a local database with a demo owner, organisation and cafe, and imports
 * a POS file through ingestion. Destructive: wipes users, cafes and
 * organisations, so only a single parsed loopback MongoDB target is accepted
 * and production is always refused, before anything connects. Throws on a
 * refusal; connects and disconnects only when manageConnection is true.
 */
async function seed({
  mongoUri,
  importFile,
  userName = 'Demo Owner',
  userEmail = 'demo@yourguava.local',
  userPassword = 'password123',
  orgName = 'Demo Coffee Group',
  cafeName = 'Demo Cafe',
  cafeCity = 'Cape Town',
  cafeAddress = 'Demo address',
  nodeEnv = process.env.NODE_ENV,
  manageConnection = true,
} = {}) {
  if (!mongoUri) throw new Error('MONGODB_URI is required.');
  if (!isSafeSeedMongoUri(mongoUri, nodeEnv)) {
    throw new Error('Refusing to run: MONGODB_URI must target one loopback host outside production.');
  }
  if (String(userPassword).length < 8) throw new Error('SEED_USER_PASSWORD must be at least 8 characters.');
  const resolvedFile = resolveImportFile(importFile);
  const email = String(userEmail).toLowerCase();

  if (manageConnection) {
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');
  }
  try {
    await User.deleteMany({});
    await Cafe.deleteMany({});
    await Organization.deleteMany({});
    console.log('Cleared existing users, cafes, and organizations');

    const user = new User({ name: userName, email, password: userPassword, role: 'owner' });
    await user.save();
    const org = await Organization.create({ name: orgName, ownerId: user._id });
    const cafe = await Cafe.create({
      name: cafeName,
      orgId: org._id,
      location: { address: cafeAddress, city: cafeCity },
      dataUploaded: false,
      timezone: 'Africa/Johannesburg',
    });
    user.orgId = org._id;
    user.cafeIds = [cafe._id];
    user.activeCafeId = cafe._id;
    await user.save();
    console.log(`User created: ${email}`);
    console.log(`Cafe created: ${cafe.name} (${cafe._id})`);

    console.log(`\nIngesting POS data from ${resolvedFile}...`);
    const stats = await ingestFile(resolvedFile, cafe._id, { timezone: cafe.timezone });
    console.log(`Ingestion complete: ${stats.imported} imported, ${stats.skipped} skipped, ${stats.errors} errors`);
    await Cafe.findByIdAndUpdate(cafe._id, { dataUploaded: true, lastSyncAt: new Date() });

    return { email, orgId: org._id, cafeId: cafe._id, stats };
  } finally {
    if (manageConnection) await mongoose.disconnect();
  }
}

if (require.main === module) {
  require('dotenv').config();
  seed(seedOptionsFromEnv())
    .then(({ email }) => {
      console.log('\nSeed complete. Login with:');
      console.log(`  Email:    ${email}`);
      console.log('  Password: value from SEED_USER_PASSWORD, or the local demo default');
      process.exit(0);
    })
    .catch((error) => {
      console.error(`[seed] ${error.message}`);
      process.exit(1);
    });
}

module.exports = { seed, seedOptionsFromEnv };
