const fs = require('fs');
const path = require('path');

// BE-11-T06: the second credit API, the legacy import and refresh paths and the
// unused helpers are gone, so the next fix cannot land in a copy nobody runs.
const SRC = path.resolve(__dirname, '../../src');
const exists = (relative) => fs.existsSync(path.join(SRC, relative));

describe('retired code stays retired (BE-11-T06)', () => {
  it('has one credit API: the ledgered meter', () => {
    const usage = require('../../src/services/usage.service');
    expect(exists('services/aiUsage.service.js')).toBe(false);
    ['reserveGuavaCredits', 'refundGuavaCredits', 'ensureFreshCreditWindow', 'consumeGuavaCredits']
      .forEach((name) => expect(usage[name]).toBeUndefined());
    expect(typeof usage.meterGuavaCredits).toBe('function');
  });

  it('has one import path and no legacy ingestion aliases', () => {
    const ingestion = require('../../src/services/ingestion.service');
    expect(ingestion.parseYocoCSV).toBeUndefined();
    expect(ingestion.extractHeaders).toBeUndefined();
    expect(fs.readFileSync(path.join(SRC, 'services/ingestion.service.js'), 'utf8')).not.toMatch(/Transaction\.create\(/);
  });

  it('exports no helper nothing calls', () => {
    expect(require('../../src/utils/tradingHours').getOpenWindowForDate).toBeUndefined();
    expect(require('../../src/middleware/rbac.middleware').authenticated).toBeUndefined();
    expect(require('../../src/controllers/account.controller').mockCheckout).toBeUndefined();
    expect(require('../../src/services/forecast/stock').computeSuggestedStock).toBeUndefined();
    // One reader of model text (BE-05-T03's responseText/extractJson), not two.
    const modelText = require('../../src/services/ai/json');
    ['joinTextBlocks', 'firstBlockText', 'stripJsonFences'].forEach((name) => expect(modelText[name]).toBeUndefined());
  });

  it('keeps no refresh tokens on the user document', () => {
    const User = require('../../src/models/User.model');
    expect(User.schema.path('refreshTokens')).toBeUndefined();
    const keys = User.schema.indexes().flatMap(([key]) => Object.keys(key));
    expect(keys.filter((field) => field.startsWith('refreshTokens'))).toEqual([]);
  });

  it('declares no Forecast index that no query uses, and keeps no one-off scripts', () => {
    const Forecast = require('../../src/models/Forecast.model');
    const keys = Forecast.schema.indexes().map(([key]) => JSON.stringify(key));
    expect(keys).not.toContain('{"dateKey":1}');
    expect(keys).not.toContain('{"origin":1}');
    // Kept on purpose: BE-06-T01's loadStoredSignalsByDateKey filters { cafeId, dateKey: { $in } } (row 20a).
    expect(keys).toContain('{"cafeId":1,"dateKey":1}');
    expect(exists('migrations/add-orgs.js')).toBe(false);
    expect(exists('seed-bulk.js')).toBe(false);
  });
});
