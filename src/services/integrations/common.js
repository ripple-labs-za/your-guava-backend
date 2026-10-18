const PROVIDER_LABELS = Object.freeze({ xero: 'Xero', quickbooks: 'QuickBooks', sage: 'Sage' });
const ACCOUNT_ID_FIELD = Object.freeze({ xero: 'tenantId', quickbooks: 'realmId', sage: 'businessId' });
const ACCOUNT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

const isValidAccountId = (value) => typeof value === 'string' && ACCOUNT_ID_RE.test(value);

/** A refusal written for the owner: its status, code and message go to the client as they are. */
const integrationError = (statusCode, code, message, extra = {}) =>
  Object.assign(new Error(message), {
    name: 'IntegrationError',
    statusCode,
    code,
    publicCode: code,
    exposeMessage: true,
    ...extra,
  });

/**
 * The provider account this connection is for, chosen only from ids the provider itself lists for the
 * new token (workforce-integrations-20; D-026).
 */
const pickAccount = ({ providerLabel, accountNoun, ids, requestedId }) => {
  if (requestedId) {
    if (ids.includes(requestedId)) return requestedId;
    throw integrationError(400, 'INTEGRATION_ACCOUNT_MISMATCH',
      `${providerLabel} did not authorise that ${accountNoun} for this connection. `
      + `Connect again and choose it on the ${providerLabel} screen.`);
  }
  if (ids.length === 1) return ids[0];
  if (ids.length === 0) {
    throw integrationError(409, 'INTEGRATION_NO_ACCOUNT',
      `${providerLabel} did not authorise any ${accountNoun}. Connect again and choose the ${accountNoun} this cafe uses.`);
  }
  throw integrationError(409, 'INTEGRATION_ACCOUNT_CHOICE_REQUIRED',
    `Your ${providerLabel} login authorised ${ids.length} ${accountNoun}s. `
    + `Connect again and choose only the ${accountNoun} this cafe uses.`);
};

module.exports = { PROVIDER_LABELS, ACCOUNT_ID_FIELD, isValidAccountId, integrationError, pickAccount };
