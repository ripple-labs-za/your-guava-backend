const mockAnthropicMessageCreate = jest.fn();
const mockR2Files = new Map();

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: mockAnthropicMessageCreate },
})));
jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async (buffer, key) => { mockR2Files.set(key, buffer); },
  downloadFile: async (key) => mockR2Files.get(key),
  getSignedDownloadUrl: async (key) => `https://test.r2.local/${key}`,
  deleteFile: async (key) => { mockR2Files.delete(key); },
  _resetClient: () => {},
}));
jest.mock('../../src/middleware/rateLimit.middleware', () => {
  const actual = jest.requireActual('../../src/middleware/rateLimit.middleware');
  return { ...actual, admitAiRequest: jest.fn(actual.admitAiRequest) };
});

const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Organization = require('../../src/models/Organization.model');
const UsageLedger = require('../../src/models/UsageLedger.model');
const { admitAiRequest } = require('../../src/middleware/rateLimit.middleware');
const { _resetMappingCache } = require('../../src/services/anthropic.service');

const request = supertest(app);

const UNFAMILIAR_CSV = Buffer.from([
  'Moment,Things bought,Paid',
  '2026-09-01 08:15,1 x Flat White,45.00',
  '2026-09-01 09:20,2 x Muffin,60.00',
  '',
].join('\n'));

const aiMapping = {
  id: 'msg_map',
  model: 'test-model',
  usage: { input_tokens: 300, output_tokens: 60 },
  stop_reason: 'end_turn',
  content: [{
    type: 'text',
    text: JSON.stringify({ mapping: { date: 'Moment', items: 'Things bought', total: 'Paid' }, itemsMode: 'packed' }),
  }],
};

const uploadUnfamiliar = (token) => request
  .post('/api/transactions/upload')
  .set('Authorization', `Bearer ${token}`)
  .attach('file', UNFAMILIAR_CSV, 'unfamiliar.csv');

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockAnthropicMessageCreate.mockReset();
  admitAiRequest.mockClear();
  mockR2Files.clear();
  _resetMappingCache();
  delete process.env.ANTHROPIC_API_KEY;
  await clearDB();
});

describe('AI column mapping on upload', () => {
  it('passes the AI limiter, reserves credits and commits 10 around the provider call', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    mockAnthropicMessageCreate.mockImplementation(async () => {
      const reserved = await UsageLedger.findOne({ featureKey: 'import_column_mapping' }).lean();
      expect(reserved).toEqual(expect.objectContaining({ status: 'reserved', credits: 10 }));
      expect((await Organization.findById(owner.user.orgId)).aiCredits.used).toBe(10);
      return aiMapping;
    });

    const response = await uploadUnfamiliar(owner.token);

    expect(response.status).toBe(200);
    expect(response.body.mappingAssistedByAi).toBe(true);
    expect(response.body.mappingCreditsUsed).toBe(10);
    expect(response.body.mappingAiUnavailableReason).toBeNull();
    expect(admitAiRequest).toHaveBeenCalledTimes(1);
    expect(admitAiRequest.mock.invocationCallOrder[0])
      .toBeLessThan(mockAnthropicMessageCreate.mock.invocationCallOrder[0]);
    const rows = await UsageLedger.find({ featureKey: 'import_column_mapping' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ status: 'committed', credits: 10 }));
  });

  it('does not call the provider when the balance cannot cover the mapping, and says why', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    await Organization.updateOne(
      { _id: owner.user.orgId },
      { $set: { 'aiCredits.used': 1_000_000, 'aiCredits.resetAt': new Date(Date.now() + 7 * 86_400_000) } }
    );

    const response = await uploadUnfamiliar(owner.token);

    expect(response.status).toBe(200);
    expect(response.body.mappingAssistedByAi).toBe(false);
    expect(response.body.mappingAiUnavailableReason).toBe('insufficient_credits');
    expect(response.body.needsConfirmation).toBe(true);
    expect(mockAnthropicMessageCreate).not.toHaveBeenCalled();
    expect(await UsageLedger.countDocuments({ status: 'committed' })).toBe(0);
  });

  it('skips the AI mapping when the per-user AI limiter refuses it', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    admitAiRequest.mockRejectedValueOnce(
      Object.assign(new Error('Too many AI requests'), { statusCode: 429, code: 'AI_RATE_LIMITED' })
    );

    const response = await uploadUnfamiliar(owner.token);

    expect(response.status).toBe(200);
    expect(response.body.mappingAiUnavailableReason).toBe('rate_limited');
    expect(mockAnthropicMessageCreate).not.toHaveBeenCalled();
    expect(await UsageLedger.countDocuments({})).toBe(0);
  });

  it('refunds the reservation when the provider call fails (WS-06-T02 case c)', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    mockAnthropicMessageCreate.mockRejectedValue(
      Object.assign(new Error('overloaded'), { status: 529, error: { type: 'error', error: { type: 'overloaded_error' } } })
    );

    const response = await uploadUnfamiliar(owner.token);

    expect(response.status).toBe(200);
    expect(response.body.mappingAssistedByAi).toBe(false);
    expect(response.body.mappingAiUnavailableReason).toBe('provider_unavailable');
    const rows = await UsageLedger.find({ featureKey: 'import_column_mapping' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('refunded');
    const org = await Organization.findById(owner.user.orgId).lean();
    expect(org.aiCredits.used).toBe(0);
  });
});
