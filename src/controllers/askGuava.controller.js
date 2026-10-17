// Ask Guava: cached and refreshed insights, the chat answer and its SSE stream, paid-credit metering and chat persistence.
// Moved from forecasts.controller.js by BE-11-T04; behaviour unchanged.
const crypto = require('crypto');
const mongoose = require('mongoose');
const InsightChat = require('../models/InsightChat.model');
const { getCachedInsights, refreshInsights, generateBusinessChatResponse, streamBusinessChatResponse } = require('../services/anthropic.service');
const { meterGuavaCredits } = require('../services/usage.service');
const { activeCafeId } = require('../utils/tenancy');

const CHAT_IN_FLIGHT_WAIT_MS = 60_000;

const getInsights = async (req, res, next) => {
  try {
    const result = await getCachedInsights(activeCafeId(req));
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
};

const paidRequestIdempotencyKey = (req, res) => {
  const key = String(req.get('Idempotency-Key') || '').trim();
  if (!key) {
    res.status(400).json({
      success: false,
      message: 'Idempotency-Key is required for paid AI requests',
    });
    return null;
  }
  if (key.length > 160) {
    res.status(400).json({ success: false, message: 'Idempotency-Key is too long' });
    return null;
  }
  return key;
};

const conversationSemanticHash = (conversation) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(
      conversation.map((message) => ({
        role: String(message?.role || ''),
        content: String(message?.content || ''),
      }))
    ))
    .digest('hex');

const persistChatExchange = async ({
  chatId,
  cafeId,
  orgId,
  userId,
  idempotencyKey,
  conversation,
  result,
}) => {
  const userContent = Array.isArray(conversation)
    ? [...conversation]
      .reverse()
      .find((message) => message?.role === 'user' && typeof message.content === 'string')
      ?.content.trim().slice(0, 20000)
    : '';
  if (
    !mongoose.Types.ObjectId.isValid(chatId) ||
    !userContent ||
    typeof result?.answer !== 'string' ||
    !result.answer.trim()
  ) {
    return false;
  }

  const scope = {
    _id: chatId,
    cafeId,
    orgId,
    userId,
  };
  const assistantContent = result.answer.trim().slice(0, 20000);

  // The client can save the user turn before or after the AI request. Read the
  // current tail and use an updatedAt compare-and-swap so either ordering
  // produces one complete user/assistant exchange without duplicate retries.
  for (let attempt = 0; attempt < 4; attempt++) {
    const existing = await InsightChat.findOne(scope)
      .select('updatedAt messages.role messages.content +messages.requestKey')
      .lean();
    if (!existing) return false;
    if (existing.messages?.some((message) => message.requestKey === idempotencyKey)) {
      return true;
    }

    const tail = existing.messages?.[existing.messages.length - 1];
    const now = new Date();
    const messages = [];
    if (tail?.role !== 'user' || tail.content !== userContent) {
      messages.push({
        role: 'user',
        content: userContent,
        requestKey: idempotencyKey,
        createdAt: now,
        updatedAt: now,
      });
    }
    messages.push({
      role: 'assistant',
      content: assistantContent,
      requestKey: idempotencyKey,
      createdAt: now,
      updatedAt: now,
    });

    const updated = await InsightChat.findOneAndUpdate(
      {
        ...scope,
        updatedAt: existing.updatedAt,
        messages: { $not: { $elemMatch: { requestKey: idempotencyKey } } },
      },
      {
        $push: {
          messages: {
            $each: messages,
            $slice: -80,
          },
        },
        ...(result.contextStats && typeof result.contextStats === 'object'
          ? { $set: { contextStats: result.contextStats } }
          : {}),
      },
      { new: true, runValidators: true }
    );
    if (updated) return true;
  }

  // A highly contended chat can be retried by the client with the same
  // idempotency key; the committed usage result ensures no second AI charge.
  return false;
};

const persistChatExchangeWithoutBlockingDelivery = async (options) => {
  try {
    await persistChatExchange(options);
  } catch (error) {
    // The committed usage record contains the complete result for replay, so a
    // transient chat-history write must not turn a delivered answer into a 500.
    console.error('[ask-guava] chat exchange persistence failed:', error.code || error.name);
  }
};

const refreshGeneratedInsights = async (req, res, next) => {
  const requestAbort = abortWhenResponseCloses(res);
  try {
    const idempotencyKey = paidRequestIdempotencyKey(req, res);
    if (!idempotencyKey) return;
    const { result, guavaCredits, replayed, coalesced } = await refreshInsights({
      cafeId: activeCafeId(req),
      orgId: req.user.orgId,
      userId: req.user.id,
      idempotencyKey,
      signal: requestAbort.signal,
    });
    return res.status(200).json({
      success: true,
      ...result,
      requiresRefresh: false,
      cacheStatus: result.cacheStatus === 'unconfigured' ? 'unconfigured' : 'fresh',
      guavaCredits,
      aiCredits: guavaCredits,
      meta: { replayed, coalesced },
    });
  } catch (error) {
    if (requestAbort.signal.aborted || res.destroyed) return;
    next(error);
  } finally {
    requestAbort.dispose();
  }
};

const chatInsights = async (req, res, next) => {
  const requestAbort = abortWhenResponseCloses(res);
  try {
    const cafeId = activeCafeId(req);
    const orgId = req.user.orgId;
    const authorizedCafeIds = req.user.role === 'manager' ? req.user.cafeIds : undefined;
    const { chatId, messages, question } = req.body;

    const conversation = Array.isArray(messages)
      ? messages
      : question
        ? [{ role: 'user', content: question }]
        : [];

    if (!process.env.ANTHROPIC_API_KEY) {
      const result = await generateBusinessChatResponse({
        cafeId,
        orgId,
        authorizedCafeIds,
        messages: conversation,
        signal: requestAbort.signal,
      });
      return res.status(200).json({ success: true, ...result, aiCredits: null, guavaCredits: null });
    }

    const idempotencyKey = paidRequestIdempotencyKey(req, res);
    if (!idempotencyKey) return;

    const { result, guavaCredits, replayed } = await meterGuavaCredits({
      orgId,
      cafeId,
      userId: req.user.id,
      featureKey: 'ask_guava_chat',
      awaitInFlightMs: CHAT_IN_FLIGHT_WAIT_MS,
      relatedEntity: mongoose.Types.ObjectId.isValid(chatId)
        ? { kind: 'insight_chat', id: String(chatId) }
        : undefined,
      metadata: {
        messageCount: conversation.length,
        semanticHash: conversationSemanticHash(conversation),
      },
      idempotencyKey,
      signal: requestAbort.signal,
      run: () => generateBusinessChatResponse({
        cafeId,
        orgId,
        authorizedCafeIds,
        messages: conversation,
        signal: requestAbort.signal,
      }),
    });
    await persistChatExchangeWithoutBlockingDelivery({
      chatId,
      cafeId,
      orgId,
      userId: req.user.id,
      idempotencyKey,
      conversation,
      result,
    });
    return res.status(200).json({
      success: true,
      ...result,
      aiCredits: guavaCredits,
      guavaCredits,
      meta: { replayed: Boolean(replayed) },
    });
  } catch (error) {
    if (requestAbort.signal.aborted || res.destroyed) return;
    next(error);
  } finally {
    requestAbort.dispose();
  }
};

const writeStreamEvent = (res, event, data) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

const openSse = (res) => {
  if (res.headersSent) return;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
};

const abortWhenResponseCloses = (res) => {
  const controller = new AbortController();
  const onClose = () => {
    if (res.writableEnded || controller.signal.aborted) return;
    const error = new Error('Client disconnected');
    error.name = 'AbortError';
    controller.abort(error);
  };
  res.once('close', onClose);
  return {
    signal: controller.signal,
    dispose: () => res.off('close', onClose),
  };
};

const streamChatInsights = async (req, res, next) => {
  const requestAbort = abortWhenResponseCloses(res);
  try {
    const cafeId = activeCafeId(req);
    const orgId = req.user.orgId;
    const authorizedCafeIds = req.user.role === 'manager' ? req.user.cafeIds : undefined;
    const { chatId, messages, question } = req.body;

    const conversation = Array.isArray(messages)
      ? messages
      : question
        ? [{ role: 'user', content: question }]
        : [];

    if (!process.env.ANTHROPIC_API_KEY) {
      openSse(res);

      const result = await streamBusinessChatResponse({
        cafeId,
        orgId,
        authorizedCafeIds,
        messages: conversation,
        onDelta: (text) => writeStreamEvent(res, 'delta', { text }),
        signal: requestAbort.signal,
      });

      writeStreamEvent(res, 'done', {
        generatedAt: result.generatedAt,
        contextStats: result.contextStats,
        aiCredits: null,
        guavaCredits: null,
      });
      res.end();
      return;
    }

    const idempotencyKey = paidRequestIdempotencyKey(req, res);
    if (!idempotencyKey) return;

    const { result, guavaCredits, replayed } = await meterGuavaCredits({
      orgId,
      cafeId,
      userId: req.user.id,
      featureKey: 'ask_guava_chat',
      awaitInFlightMs: CHAT_IN_FLIGHT_WAIT_MS,
      relatedEntity: mongoose.Types.ObjectId.isValid(chatId)
        ? { kind: 'insight_chat', id: String(chatId) }
        : undefined,
      metadata: {
        messageCount: conversation.length,
        semanticHash: conversationSemanticHash(conversation),
        stream: true,
      },
      idempotencyKey,
      signal: requestAbort.signal,
      run: (meter) => {
        openSse(res);

        return streamBusinessChatResponse({
          cafeId,
          orgId,
          authorizedCafeIds,
          messages: conversation,
          onDelta: (text) => {
            if (!text || res.destroyed || res.writableEnded) return;
            writeStreamEvent(res, 'delta', { text });
            meter.markDelivered();
          },
          signal: requestAbort.signal,
          meter,
        });
      },
    });

    if (res.destroyed) {
      await persistChatExchangeWithoutBlockingDelivery({
        chatId, cafeId, orgId, userId: req.user.id, idempotencyKey, conversation, result,
      });
      return;
    }
    openSse(res);
    if (replayed && result?.answer) {
      writeStreamEvent(res, 'delta', { text: result.answer });
    }
    await persistChatExchangeWithoutBlockingDelivery({
      chatId,
      cafeId,
      orgId,
      userId: req.user.id,
      idempotencyKey,
      conversation,
      result,
    });
    writeStreamEvent(res, 'done', {
      generatedAt: result.generatedAt,
      contextStats: result.contextStats,
      aiCredits: guavaCredits,
      guavaCredits,
      replayed: Boolean(replayed),
    });
    res.end();
  } catch (error) {
    const charged = error.guavaCharge?.status === 'committed';
    if (charged && error.guavaResult) {
      await persistChatExchangeWithoutBlockingDelivery({
        chatId: req.body.chatId,
        cafeId: activeCafeId(req),
        orgId: req.user.orgId,
        userId: req.user.id,
        idempotencyKey: String(req.get('Idempotency-Key') || '').trim(),
        conversation: req.body.messages || [{ role: 'user', content: req.body.question }],
        result: error.guavaResult,
      });
    }
    if (requestAbort.signal.aborted || res.destroyed) return;
    if (res.headersSent) {
      writeStreamEvent(res, 'error', {
        code: charged ? 'AI_STREAM_INTERRUPTED' : (error.code || 'AI_CHAT_FAILED'),
        charged,
        credits: charged ? error.guavaCharge.credits : 0,
        message: charged
          ? 'The AI service stopped this answer part-way. It had started, so it was charged.'
          : 'The AI analyst could not complete this request. Nothing was charged. Please retry.',
      });
      return res.end();
    }
    return next(error);
  } finally {
    requestAbort.dispose();
  }
};

module.exports = {
  getInsights, refreshGeneratedInsights, chatInsights, streamChatInsights,
};
