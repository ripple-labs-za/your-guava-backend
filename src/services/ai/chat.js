// Ask Guava, non-streaming: message sanitising, the chat request and the answer.
// Moved from anthropic.service.js by BE-11-T02; behaviour unchanged.
const { withUsageDiagnostics } = require('../usage.service');
const { createAnthropicClient, withAnthropicErrors, responseText } = require('../anthropicClient.service');
const {
  contextBlockJson, missingChatKeyResponse, TRUNCATED_ANSWER_MARKER, CHAT_SYSTEM_PROMPT,
} = require('./prompts');
const { providerDiagnostics } = require('./json');
const { requestSettings } = require('../../config/ai');
const Cafe = require('../../models/Cafe.model');
const { buildBusinessContext, cafeAccessError } = require('./context');

const chatInputError = (message) => Object.assign(new Error(message), {
  statusCode: 400,
  code: 'AI_CHAT_INVALID_INPUT',
  details: { code: 'AI_CHAT_INVALID_INPUT' },
});


const assertCafeInScope = async ({ cafeId, orgId, authorizedCafeIds }) => {
  if (Array.isArray(authorizedCafeIds) && !authorizedCafeIds.map(String).includes(String(cafeId))) {
    throw cafeAccessError();
  }
  const exists = await Cafe.exists({ _id: cafeId, ...(orgId ? { orgId } : {}) });
  if (!exists) throw cafeAccessError();
};

const conversationFromBody = ({ messages, question } = {}) => {
  if (messages !== undefined && !Array.isArray(messages)) {
    throw chatInputError('messages must be an array of { role, content } objects');
  }
  if (Array.isArray(messages)) return messages;
  if (question === undefined) return [];
  if (typeof question !== 'string') throw chatInputError('question must be a string');
  return [{ role: 'user', content: question }];
};

/**
 * Everything that can refuse a chat request without calling the provider, run before any credit is reserved or any
 * SSE header is sent, so the caller gets a JSON 400/403 instead of an HTTP 200 carrying an SSE error.
 */
const prepareChatConversation = async ({ body, cafeId, orgId, authorizedCafeIds }) => {
  const conversation = conversationFromBody(body || {});
  const { messages } = sanitizeMessages(conversation);
  if (messages.length === 0 || messages[0].role !== 'user' || messages[messages.length - 1].role !== 'user') {
    throw chatInputError('A chat request needs at least one question, and must end on it');
  }
  await assertCafeInScope({ cafeId, orgId, authorizedCafeIds });
  return conversation;
};

const MAX_CHAT_HISTORY_MESSAGES = 10;
const MAX_CHAT_MESSAGE_CHARS = 4000;

/**
 * Trims a chat thread to the history window we send to the provider.
 *
 * The Messages API requires `messages[0]` to use the `user` role. A chat
 * alternates user/assistant and always ends on the new question, so the Nth
 * question carries 2N-1 messages; from the sixth question on, a blind
 * `slice(-10)` dropped index 0 and opened the window on an assistant turn. The
 * provider answered that with a 400, withAnthropicErrors turned it into a
 * generic 503, and the owner was told the AI was down — permanently, for that
 * thread, because every retry sent the same array. Re-anchor the window to the
 * oldest user turn it contains so a whole exchange is dropped rather than half
 * of one.
 *
 * `truncatedMessages` counts questions we shortened, so the caller can say so
 * instead of silently answering the first 4000 characters of a longer paste.
 */
const sanitizeMessages = (messages = []) => {
  const cleaned = (Array.isArray(messages) ? messages : [])
    .filter((message) =>
      message &&
      ['user', 'assistant'].includes(message.role) &&
      typeof message.content === 'string' &&
      message.content.trim()
    )
    .map((message) => ({ role: message.role, content: message.content.trim() }));

  const window = cleaned.slice(-MAX_CHAT_HISTORY_MESSAGES);
  while (window.length > 0 && window[0].role !== 'user') window.shift();

  const truncatedMessages = window.filter(
    (message) => message.content.length > MAX_CHAT_MESSAGE_CHARS
  ).length;

  return {
    messages: window.map((message) => ({
      role: message.role,
      content: message.content.slice(0, MAX_CHAT_MESSAGE_CHARS),
    })),
    truncatedMessages,
  };
};

const buildContextStats = (context) => ({
  transactionCount: context.dataset.transactionCount,
  locations: context.locations.length,
  topItems: context.topItems90d.length,
  forecasts: context.upcomingForecasts.length,
  menuItemIssues: context.menuItemIssues?.length || 0,
  contextWindow: context.dataset.contextWindow,
});

const buildBusinessChatRequest = async ({ cafeId, orgId, authorizedCafeIds, messages }) => {
  const { messages: cleanedMessages, truncatedMessages } = sanitizeMessages(messages);
  // Both ends matter. The provider rejects a request whose first message is an
  // assistant turn, and an answer only means anything if the thread ends on the
  // question being asked. Only the last end was checked before, so a window
  // that opened on an assistant turn left here looking valid and came back as a
  // provider 400 the owner was shown as an AI outage.
  if (
    cleanedMessages.length === 0 ||
    cleanedMessages[0].role !== 'user' ||
    cleanedMessages[cleanedMessages.length - 1].role !== 'user'
  ) {
    const err = new Error('At least one user message is required');
    err.statusCode = 400;
    throw err;
  }

  const context = await buildBusinessContext({ cafeId, orgId, authorizedCafeIds });

  // The context is tens of KB and barely changes between turns; the operator's
  // question is a line of text that changes every turn. Prompt caching is a
  // prefix match rendered tools -> system -> messages, so gluing the context on
  // to the newest user turn (as this did) guaranteed a 0% cache hit rate and
  // re-billed the whole payload at full input price on every answer. Leading
  // with the context behind a cache breakpoint makes the prefix stable, and it
  // also makes messages[0] structurally a user turn no matter what the client
  // sends. It stays in the user channel on purpose: this is attacker-influenced
  // POS text and must never carry system-prompt authority.
  const requestMessages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<untrusted_business_context>\n${contextBlockJson(context)}\n</untrusted_business_context>`,
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
    ...cleanedMessages,
  ];

  return {
    context,
    contextStats: buildContextStats(context),
    truncatedInput: truncatedMessages > 0,
    request: {
      ...requestSettings('chat'),
      system: CHAT_SYSTEM_PROMPT,
      messages: requestMessages,
    },
  };
};

const generateBusinessChatResponse = async ({
  cafeId,
  orgId,
  authorizedCafeIds,
  messages,
  signal,
  requestId,
}) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return missingChatKeyResponse();
  }

  const { request, contextStats, truncatedInput } = await buildBusinessChatRequest({
    cafeId,
    orgId,
    authorizedCafeIds,
    messages,
  });
  const client = createAnthropicClient();

  const startedAt = Date.now();
  const response = await withAnthropicErrors(
    () => client.messages.create(request, { signal }),
    'generateBusinessChatResponse', { requestId }
  );

  const answer = responseText(response);

  if (!answer) {
    const error = new Error('AI chat provider returned an empty response');
    error.statusCode = 502;
    error.code = 'AI_INVALID_RESPONSE';
    throw error;
  }

  // stop_reason was recorded in diagnostics but never acted on, so an answer
  // that hit max_tokens was delivered cut off mid-sentence, charged in full,
  // saved to the chat, and replayed identically for that idempotency key —
  // with nothing telling the operator it was incomplete.
  const truncated = response.stop_reason === 'max_tokens';

  return withUsageDiagnostics(
    {
      answer: truncated ? `${answer}${TRUNCATED_ANSWER_MARKER}` : answer,
      generatedAt: new Date(),
      contextStats,
      ...(truncated ? { truncated: true } : {}),
      ...(truncatedInput ? { truncatedInput: true } : {}),
    },
    providerDiagnostics(response, startedAt, 'ask_guava_chat')
  );
};

module.exports = {
  prepareChatConversation, assertCafeInScope, sanitizeMessages, buildBusinessChatRequest, generateBusinessChatResponse,
};
