const { businessIdFromTokens, isYocoId } = require('../../src/services/yoco.service');

const idTokenWith = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

describe('Yoco token business selection', () => {
  it('uses the documented authorised business, not the merchant default or another accessible business', () => {
    expect(businessIdFromTokens({ id_token: idTokenWith({
      authorized_business_id: 'selected-business', default_business_id: 'other-business', business_ids: ['other-business'],
    }) })).toBe('selected-business');
  });

  it('keeps the explicitly returned business field and legacy claim forms', () => {
    expect(businessIdFromTokens({ business_id: 'direct' })).toBe('direct');
    expect(businessIdFromTokens({ id_token: idTokenWith({ business_id: 'claim' }) })).toBe('claim');
    expect(businessIdFromTokens({ id_token: idTokenWith({ ext: { business_id: 'extension' } }) })).toBe('extension');
  });

  it('does not guess from a default or a list when no business was authorised', () => {
    expect(businessIdFromTokens({ id_token: idTokenWith({ default_business_id: 'other', business_ids: ['other'] }) })).toBeNull();
  });

  it.each([null, '', 7, {}, [], 'x'.repeat(129), 'x\ny', 'business\n'])('rejects malformed ids: %p', (id) => {
    expect(isYocoId(id)).toBe(false);
    expect(businessIdFromTokens({ business_id: id })).toBeNull();
  });

  it.each(['broken', 'e30.!!!.sig', idTokenWith([]), idTokenWith(null), 'x'.repeat(100_000)])(
    'treats malformed or oversized identity tokens as unavailable', (id_token) => {
      expect(businessIdFromTokens({ id_token })).toBeNull();
    }
  );
});
