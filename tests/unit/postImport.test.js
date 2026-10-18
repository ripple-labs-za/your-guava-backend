jest.mock('../../src/services/anthropic.service', () => ({ invalidateInsights: jest.fn() }));
const ai = require('../../src/services/anthropic.service');
const cache = require('../../src/middleware/cache.middleware');
const { invalidateDerivedViews } = require('../../src/services/postImport.service');

afterEach(() => jest.restoreAllMocks());

it('clears the cafe cache even when persisting insight invalidation fails', async () => {
  ai.invalidateInsights.mockRejectedValueOnce(new Error('database unavailable'));
  const clear = jest.spyOn(cache, 'clearApiCache').mockImplementation(() => {});
  await expect(invalidateDerivedViews('cafe-1')).rejects.toThrow('database unavailable');
  expect(clear).toHaveBeenCalledWith({ cafeId: 'cafe-1' });
});
