// Ask Guava, streaming: the abort helpers and the streamed answer.
// Moved from anthropic.service.js by BE-11-T02; behaviour unchanged.
const { withUsageDiagnostics } = require('../usage.service');
const { createAnthropicClient, withAnthropicErrors } = require('../anthropicClient.service');
const { missingChatKeyResponse, TRUNCATED_ANSWER_MARKER } = require('./prompts');
const { providerDiagnostics } = require('./json');
const { buildBusinessChatRequest } = require('./chat');

const throwIfAborted = (signal) => {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error
    ? signal.reason
    : new Error('Operation aborted');
  error.name = 'AbortError';
  throw error;
};

const waitWithAbort = (durationMs, signal) =>
  new Promise((resolve, reject) => {
    try {
      throwIfAborted(signal);
    } catch (error) {
      reject(error);
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    const onAbort = () => {
      clearTimeout(timer);
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const PROVIDER_INTERRUPTED_MARKER =
  '\n\n_The AI service stopped this answer part-way through. Because it had started, it was charged. Ask again for a complete answer._';

const streamBusinessChatResponse = async ({
  cafeId,
  orgId,
  authorizedCafeIds,
  messages,
  onDelta,
  signal,
  meter,
}) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    const fallback = missingChatKeyResponse();
    onDelta(fallback.answer);
    return {
      ...fallback,
    };
  }

  const { request, contextStats, truncatedInput } = await buildBusinessChatRequest({
    cafeId,
    orgId,
    authorizedCafeIds,
    messages,
  });
  const client = createAnthropicClient();
  const startedAt = Date.now();
  // The provider call has its own controller. Before anything reaches the customer, their disconnect cancels it and the
  // run is refunded. After the first delta it is drained to the end, so the charged answer is complete for the
  // same-key replay and the saved chat (D-015).
  const upstream = new AbortController();
  const onClientAbort = () => {
    if (meter?.isDelivered?.()) return;
    upstream.abort(signal?.reason);
  };
  if (signal?.aborted) onClientAbort();
  signal?.addEventListener('abort', onClientAbort, { once: true });

  let answer = '';
  let sawMessageStop = false;
  const streamResponse = { usage: {} };
  const recordUsage = () =>
    meter?.recordProviderDiagnostics?.(providerDiagnostics(streamResponse, startedAt, 'ask_guava_chat'));

  try {
    const stream = await withAnthropicErrors(
      () => client.messages.create({ ...request, stream: true }, { signal: upstream.signal }),
      'streamBusinessChatResponse'
    );
    for await (const event of stream) {
      if (event.type === 'message_start') {
        streamResponse.id = event.message?.id;
        streamResponse.model = event.message?.model;
        streamResponse.usage.input_tokens = Number(event.message?.usage?.input_tokens) || 0;
        recordUsage();
      }
      if (event.type === 'message_delta') {
        streamResponse.stop_reason = event.delta?.stop_reason;
        streamResponse.usage.output_tokens = Number(event.usage?.output_tokens) || 0;
        recordUsage();
      }
      if (event.type === 'message_stop') sawMessageStop = true;
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const text = event.delta.text || '';
        answer += text;
        onDelta(text);
      }
    }
    // SDK 0.30.1 ends the iterator quietly when its request is aborted (streaming.js swallows AbortError), so an
    // aborted stream can look finished here.
    if (upstream.signal.aborted && !sawMessageStop) throwIfAborted(upstream.signal);
  } catch (error) {
    if (meter?.isDelivered?.()) {
      meter.recordPartialResult({
        answer: `${answer}${PROVIDER_INTERRUPTED_MARKER}`,
        generatedAt: new Date(),
        contextStats,
        interrupted: true,
        ...(truncatedInput ? { truncatedInput: true } : {}),
      });
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onClientAbort);
  }

  if (!answer.trim()) {
    const error = new Error('AI chat provider returned an empty response');
    error.statusCode = 502;
    error.code = 'AI_INVALID_RESPONSE';
    throw error;
  }

  // Push the marker down the same stream the answer went down, so what the
  // operator watched arrive and what we persist to the chat stay identical.
  const truncated = streamResponse.stop_reason === 'max_tokens';
  if (truncated) {
    answer += TRUNCATED_ANSWER_MARKER;
    onDelta(TRUNCATED_ANSWER_MARKER);
  }

  return withUsageDiagnostics(
    {
      answer,
      generatedAt: new Date(),
      contextStats,
      ...(truncated ? { truncated: true } : {}),
      ...(truncatedInput ? { truncatedInput: true } : {}),
    },
    providerDiagnostics(streamResponse, startedAt, 'ask_guava_chat')
  );
};

module.exports = {
  throwIfAborted, waitWithAbort, streamBusinessChatResponse,
};
