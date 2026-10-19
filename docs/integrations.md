# Accounting integrations

Verified against: `0896312` on 19 October 2026.

Xero, QuickBooks and Sage OAuth connections exist for development. Sales posting is not implemented for any provider.
Keep `ACCOUNTING_INTEGRATIONS_ENABLED=false` for MVP: production startup refuses true.

## OAuth and account selection

Register a developer app with a callback at `http://localhost:5175/integrations/<provider>/callback` and set the matching
client ID, client secret and redirect URI in `.env.example`. Use sandbox provider accounts only for development.
Xero uses `/integrations/xero/callback`, QuickBooks `/integrations/quickbooks/callback`, and Sage `/integrations/sage/callback`.
For QuickBooks set `QUICKBOOKS_ENV=sandbox`.

`src/services/integrationOAuthState.service.js` creates opaque random state, stores only its SHA-256 digest, and atomically
consumes it once within ten minutes. It binds state to the current user, cafe and provider. State is not a signed JWT;
server-side digest lookup provides integrity, expiry and replay protection. All mutations and authorization URLs are owner-only
(`src/routes/integrations.routes.js`). Auth, callback and sync are feature-gated; disconnect remains available with the flag off.

Provider modules in `src/services/integrations/` verify the account before storing a grant:
Xero checks the server-side connections list, Sage checks the businesses list, and QuickBooks verifies access to the requested realm.
Xero/Sage auto-select a sole account; an ambiguous list needs a requested `tenantId` / `businessId` from that list.
The frontend never fetches provider account lists with an exposed access token. Intuit's redirect provides `realmId`,
which the frontend includes in the callback body. Requested IDs are validated before state is consumed.

```json
{
  "code": "authorization-code",
  "state": "opaque-state-echoed-by-provider",
  "tenantId": "Xero-only-requested-tenant",
  "realmId": "QuickBooks-only-requested-realm",
  "businessId": "Sage-only-requested-business"
}
```

Include only the account field for the selected provider. Codes are non-empty strings up to 4096 characters.
`src/utils/http.js` bounds provider calls using total and connection deadlines. Disconnect attempts remote revocation then clears
local tokens even if revocation fails, reporting `revoked`, `skipped`, `failed` or `not_needed`.
Reconnect replaces the grant and attempts revocation of the old refresh token unless it is unchanged; a missing old encryption key
does not discard the newly stored grant. Callback, disconnect and refresh serialize by cafe/provider.

## Endpoints

Every route requires authentication. Unknown providers answer 400 before feature gating; non-owners get 403 on owner-only routes.
Valid providers: `xero`, `quickbooks`, `sage`.

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/integrations` | 200 connection status for all providers, no tokens; also available with flag off |
| GET | `/api/integrations/:provider/auth` | 200 authorize URL; 503 disabled or unconfigured |
| POST | `/api/integrations/:provider/callback` | 200 stored grant; 400 invalid state/input, 409 ambiguous account, 502/504 upstream failure, 503 disabled/unconfigured |
| POST | `/api/integrations/:provider/sync` | 501 when posting is attempted; 200 if already up to date; 400 disconnected; 502/504 refresh failure, 409 concurrent disconnect; 503 disabled |
| POST | `/api/integrations/:provider/disconnect` | 200 local disconnection and revocation outcome, including when flag is off |

## Sync and tokens

`src/controllers/integrations.controller.js` builds summaries for closed cafe-local days since the successful high-water mark;
the first window covers the previous seven closed days. Concurrent syncs share one cafe/provider flight. Only successful posting
advances `lastSyncedThrough`; failure preserves the retry window. If there is no new closed day, sync returns 200 without posting.

The access token is refreshed automatically by sync when it is within 60 seconds of expiry and there is a new closed-day period.
`src/services/integrations/tokens.js` single-flights refresh and persists rotated tokens with a compare-and-set guard; a competing replacement is reread.
Invalid-grant refresh failure answers 502 INTEGRATION_REAUTH_REQUIRED and clears the matching stale grant; other upstream failures answer
502/504, and a concurrent disconnect can answer 409.
Refresh does not make posting functional: each provider's `pushSalesSummary` still returns 501, so an attempted sync records a failed
status and returns 501. No other endpoint initiates token refresh. No sales have been sent by these stubs.

`Cafe.accountingIntegrations.<provider>` stores encrypted tokens, hidden from normal queries (`src/models/Cafe.model.js`).
Status responses expose connection status, timestamps and safe error messages, never tokens. Encryption and key rotation are handled
by `src/services/secrets.service.js`; follow the launch checklist and `.env.example` rotation instructions before changing keys.
