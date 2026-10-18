jest.mock('../../src/utils/http', () => ({ outboundGet: jest.fn(), outboundPost: jest.fn() }));
const { outboundGet } = require('../../src/utils/http');
const { fetchAllOrders } = require('../../src/services/yoco.service');
const logger = require('../../src/utils/logger');

it('caps YOCO_SYNC_MAX_PAGES=99999 at two thousand pages and reports page_limit', async () => {
  const saved = process.env.YOCO_SYNC_MAX_PAGES;
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  process.env.YOCO_SYNC_MAX_PAGES = '99999';
  let page = 0;
  outboundGet.mockImplementation(async () => {
    page++;
    // The finite sentinel keeps a missing-ceiling mutant bounded too.
    return { data: { data: [{ id: `order-${page}` }], next_cursor: page <= 2000 ? `cursor-${page}` : null } };
  });
  try {
    const result = await fetchAllOrders('test-token', new Date('2026-01-01'), new Date('2026-01-02'));
    expect(result).toMatchObject({ pages: 2000, truncated: 'page_limit' });
    expect(result.orders).toHaveLength(2000);
    expect(result.orders[1999]).toEqual({ id: 'order-2000' });
    expect(outboundGet).toHaveBeenCalledTimes(2000);
    expect(outboundGet.mock.calls[1999][2].params.cursor).toBe('cursor-1999');
    expect(warn).toHaveBeenCalledWith('yoco_sync_truncated', { reason: 'page_limit', pages: 2000 });
  } finally {
    if (saved === undefined) delete process.env.YOCO_SYNC_MAX_PAGES;
    else process.env.YOCO_SYNC_MAX_PAGES = saved;
    warn.mockRestore();
  }
});
