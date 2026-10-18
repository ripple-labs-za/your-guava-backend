/**
 * Re-export barrel (BE-11-T02). The AI features live in ./ai/*. Code outside
 * services/ai imports this path only: integration tests replace this module with
 * jest.mock(...), and a direct require of ./ai/* would bypass the mock.
 */
const insights = require('./ai/insights');
const { buildSummaryStats } = require('./ai/prompts');
const { buildBusinessContext, invalidateBusinessContext, _resetBusinessContextCache } = require('./ai/context');
const { prepareChatConversation, assertCafeInScope, generateBusinessChatResponse } = require('./ai/chat');
const { streamBusinessChatResponse } = require('./ai/stream');
const { proposeColumnMapping, _resetMappingCache } = require('./ai/columnMapping');

module.exports = {
  _resetInsightsCache: insights._resetInsightsCache,
  buildSummaryStats,
  _resetMappingCache,
  buildBusinessContext,
  invalidateBusinessContext,
  _resetBusinessContextCache,
  invalidateInsights: insights.invalidateInsights,
  getCachedInsights: insights.getCachedInsights,
  generateInsights: insights.generateInsights,
  prepareChatConversation, assertCafeInScope, generateBusinessChatResponse,
  proposeColumnMapping,
  refreshInsights: insights.refreshInsights,
  streamBusinessChatResponse,
};
