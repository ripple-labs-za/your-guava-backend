require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const User = require('./models/User.model');
const Cafe = require('./models/Cafe.model');
const Organization = require('./models/Organization.model');
const { ingestFile } = require('./services/ingestion.service');
const { isSafeSeedMongoUri } = require('./utils/seedMongoSafety');

const MONGO_URI = process.env.MONGODB_URI;
const IMPORT_FILE = process.env.SEED_IMPORT_FILE || process.argv[2];
const SEED_USER_NAME = process.env.SEED_USER_NAME || 'Demo Owner';
const SEED_USER_EMAIL = (process.env.SEED_USER_EMAIL || 'demo@yourguava.local').toLowerCase();
const SEED_USER_PASSWORD = process.env.SEED_USER_PASSWORD || 'password123';
const SEED_ORG_NAME = process.env.SEED_ORG_NAME || 'Demo Coffee Group';
const SEED_CAFE_NAME = process.env.SEED_CAFE_NAME || 'Demo Cafe';
const SEED_CAFE_CITY = process.env.SEED_CAFE_CITY || 'Cape Town';
const SEED_CAFE_ADDRESS = process.env.SEED_CAFE_ADDRESS || 'Demo address';

const resolveImportFile = () => {
  if (!IMPORT_FILE) {
    console.error('[seed] SEED_IMPORT_FILE or an import file argument is required.');
    process.exit(1);
  }

  const resolved = path.resolve(IMPORT_FILE);
  if (!fs.existsSync(resolved)) {
    console.error(`[seed] Import file does not exist: ${resolved}`);
    process.exit(1);
  }

  return resolved;
};

async function seed() {
  if (!MONGO_URI) {
    console.error('[seed] MONGODB_URI is required.');
    process.exit(1);
  }

  // Destructive: wipes users/cafes/orgs. Only a single, parsed loopback
  // MongoDB target is permitted, and production is always refused.
  if (!isSafeSeedMongoUri(MONGO_URI, process.env.NODE_ENV)) {
    console.error('[seed] Refusing to run: MONGODB_URI must target one loopback host outside production.');
    process.exit(1);
  }

  if (SEED_USER_PASSWORD.length < 8) {
    console.error('[seed] SEED_USER_PASSWORD must be at least 8 characters.');
    process.exit(1);
  }

  const importFile = resolveImportFile();

  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  // Clean existing data
  await User.deleteMany({});
  await Cafe.deleteMany({});
  await Organization.deleteMany({});
  console.log('Cleared existing users, cafes, and organizations');

  // Create user + org + cafe
  const user = new User({
    name: SEED_USER_NAME,
    email: SEED_USER_EMAIL,
    password: SEED_USER_PASSWORD,
    role: 'owner',
  });
  await user.save();

  const org = await Organization.create({
    name: SEED_ORG_NAME,
    ownerId: user._id,
  });

  const cafe = await Cafe.create({
    name: SEED_CAFE_NAME,
    orgId: org._id,
    location: {
      address: SEED_CAFE_ADDRESS,
      city: SEED_CAFE_CITY,
    },
    dataUploaded: false,
    timezone: 'Africa/Johannesburg',
  });

  user.orgId = org._id;
  user.cafeIds = [cafe._id];
  user.activeCafeId = cafe._id;
  await user.save();

  console.log(`User created: ${SEED_USER_EMAIL}`);
  console.log(`Cafe created: ${cafe.name} (${cafe._id})`);

  console.log(`\nIngesting POS data from ${importFile}...`);
  const stats = await ingestFile(importFile, cafe._id, { timezone: cafe.timezone });
  console.log(`Ingestion complete: ${stats.imported} imported, ${stats.skipped} skipped, ${stats.errors} errors`);

  // Mark cafe as having data
  await Cafe.findByIdAndUpdate(cafe._id, {
    dataUploaded: true,
    lastSyncAt: new Date(),
  });

  console.log('\nSeed complete. Login with:');
  console.log(`  Email:    ${SEED_USER_EMAIL}`);
  console.log('  Password: value from SEED_USER_PASSWORD, or the local demo default');

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
