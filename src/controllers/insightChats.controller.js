const InsightChat = require('../models/InsightChat.model');
const { activeCafeId } = require('../utils/tenancy');

const CONTEXT_STAT_COUNTS = ['transactionCount', 'locations', 'topItems', 'forecasts', 'menuItemIssues'];
const MAX_CONTEXT_STAT_COUNT = 1_000_000_000;
const MAX_CONTEXT_WINDOW_CHARS = 1000;

const contextStatsError = () => Object.assign(
  new Error('contextStats must hold whole-number counts and a context window description of at most 1000 characters'),
  { statusCode: 400, code: 'INVALID_CONTEXT_STATS', details: { code: 'INVALID_CONTEXT_STATS' } }
);

/** The server-shaped contextStats, undefined when none was sent; anything else is a 400. Unknown keys are dropped. */
const validatedContextStats = (value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw contextStatsError();
  const clean = {};
  for (const key of CONTEXT_STAT_COUNTS) {
    if (value[key] === undefined) continue;
    if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > MAX_CONTEXT_STAT_COUNT) throw contextStatsError();
    clean[key] = value[key];
  }
  if (value.contextWindow !== undefined) {
    if (typeof value.contextWindow !== 'string' || value.contextWindow.length > MAX_CONTEXT_WINDOW_CHARS) {
      throw contextStatsError();
    }
    clean.contextWindow = value.contextWindow;
  }
  return clean;
};

// Count-then-insert let parallel creates at 99 all insert. Insert first, then count: a create that finds the user
// above the cap removes its own chat and is refused. Every chat that survives counted after its own insert, and so
// saw every chat inserted before it, so the total can never end above the cap. Under a race exactly at the cap
// more than one racer may be refused (each counts the others); a single create below the cap is never refused.
// (Ranking by _id is not enough: ObjectId order is creation order, not insert order, so two racers can both rank
// themselves 100th.)
const enforceChatCap = async (req, chat) => {
  const total = await InsightChat.countDocuments({ userId: req.user.id, cafeId: activeCafeId(req) });
  if (total <= MAX_CHATS_PER_USER) return true;
  await InsightChat.deleteOne({ _id: chat._id });
  return false;
};

const chatLimitResponse = (res) => res.status(409).json({
  success: false,
  message: `You have reached the limit of ${MAX_CHATS_PER_USER} saved chats for this location. Delete a chat to start a new one.`,
  details: { code: 'INSIGHT_CHAT_LIMIT_REACHED', limit: MAX_CHATS_PER_USER },
});

const MAX_MESSAGES = 80;
// One chat can legitimately hold 80 messages of 20000 characters. Nothing here
// is rate limited per user, and the portal calls createLocalChat on failure
// paths, so a retry loop could grow this collection without bound on the same
// Mongo instance the transaction data lives on. A cafe owner keeping 100 saved
// conversations per location is generous; a runaway client stops at 100.
const MAX_CHATS_PER_USER = 100;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 30;
const MAX_LIST_WITH_MESSAGES = 10;
const LIST_MESSAGE_PREVIEW_LIMIT = 20;

const buildTitle = (title, messages = []) => {
  if (typeof title === 'string' && title.trim()) {
    return title.trim().slice(0, 80);
  }

  const firstUserMessage = messages.find((message) => message.role === 'user')?.content || '';
  const normalized = firstUserMessage.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 60) : 'New chat';
};

const sanitizeMessages = (messages = []) =>
  messages
    .filter((message) =>
      message &&
      ['user', 'assistant'].includes(message.role) &&
      typeof message.content === 'string' &&
      message.content.trim()
    )
    .slice(-MAX_MESSAGES)
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, 20000),
    }));

const preserveServerRequestKeys = async (req, messages) => {
  if (messages.length === 0) return messages;
  const existing = await InsightChat.findOne(chatScope(req, { _id: req.params.id }))
    .select('+messages.requestKey')
    .lean();
  if (!existing) return messages;

  const keysByMessage = new Map();
  for (const message of existing.messages || []) {
    if (!message.requestKey) continue;
    const signature = JSON.stringify([message.role, message.content]);
    const keys = keysByMessage.get(signature) || [];
    keys.push(message.requestKey);
    keysByMessage.set(signature, keys);
  }

  return messages.map((message) => {
    const signature = JSON.stringify([message.role, message.content]);
    const requestKey = keysByMessage.get(signature)?.shift();
    return requestKey ? { ...message, requestKey } : message;
  });
};

const chatScope = (req, extra = {}) => ({
  ...extra,
  userId: req.user.id,
  cafeId: activeCafeId(req),
});

const list = async (req, res, next) => {
  try {
    const includeArchived = req.query.archived === 'true';
    const includeMessages = req.query.includeMessages === 'true';
    const parsedPage = Number.parseInt(req.query.page, 10);
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const page = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1;
    const maxLimit = includeMessages ? MAX_LIST_WITH_MESSAGES : MAX_LIST_LIMIT;
    const limit = Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(maxLimit, parsedLimit))
      : Math.min(DEFAULT_LIST_LIMIT, maxLimit);
    const filter = chatScope(req, includeArchived ? {} : { archived: false });

    const query = InsightChat.find(filter)
      .sort({ updatedAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select(`title contextStats archived updatedAt createdAt${includeMessages ? ' messages' : ''}`);
    if (includeMessages) query.slice('messages', -LIST_MESSAGE_PREVIEW_LIMIT);

    const [chats, total] = await Promise.all([
      query.lean(),
      InsightChat.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      chats,
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
        hasMore: page * limit < total,
      },
      meta: {
        includeMessages,
        messagePreviewLimit: includeMessages ? LIST_MESSAGE_PREVIEW_LIMIT : 0,
      },
    });
  } catch (error) {
    next(error);
  }
};

const create = async (req, res, next) => {
  try {
    // `update` already guards this; `create` passed the raw body straight to
    // .filter(), so a body of {"messages":"hi"} became a 500 with a stack trace
    // instead of telling the caller their payload was wrong.
    if (req.body.messages !== undefined && !Array.isArray(req.body.messages)) {
      return res.status(400).json({
        success: false,
        message: 'messages must be an array of { role, content } objects',
      });
    }

    const existingChats = await InsightChat.countDocuments({
      userId: req.user.id,
      cafeId: activeCafeId(req),
    });
    if (existingChats >= MAX_CHATS_PER_USER) return chatLimitResponse(res);

    const messages = sanitizeMessages(req.body.messages);
    const chat = await InsightChat.create({
      userId: req.user.id,
      cafeId: activeCafeId(req),
      orgId: req.user.orgId,
      title: buildTitle(req.body.title, messages),
      messages,
      contextStats: validatedContextStats(req.body.contextStats) || {},
      archived: Boolean(req.body.archived),
    });

    if (!(await enforceChatCap(req, chat))) return chatLimitResponse(res);
    return res.status(201).json({ success: true, chat });
  } catch (error) {
    next(error);
  }
};

const getOne = async (req, res, next) => {
  try {
    const chat = await InsightChat.findOne(chatScope(req, { _id: req.params.id })).lean();

    if (!chat) {
      return res.status(404).json({ success: false, message: 'Chat not found' });
    }

    return res.status(200).json({ success: true, chat });
  } catch (error) {
    next(error);
  }
};

const update = async (req, res, next) => {
  try {
    const updates = {};

    if (typeof req.body.title === 'string') updates.title = buildTitle(req.body.title);
    if (Array.isArray(req.body.messages)) {
      updates.messages = await preserveServerRequestKeys(req, sanitizeMessages(req.body.messages));
    }
    const contextStats = validatedContextStats(req.body.contextStats);
    if (contextStats) updates.contextStats = contextStats;
    if (typeof req.body.archived === 'boolean') updates.archived = req.body.archived;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid updates provided' });
    }

    const chat = await InsightChat.findOneAndUpdate(
      chatScope(req, { _id: req.params.id }),
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!chat) {
      return res.status(404).json({ success: false, message: 'Chat not found' });
    }

    return res.status(200).json({ success: true, chat });
  } catch (error) {
    next(error);
  }
};

const remove = async (req, res, next) => {
  try {
    const chat = await InsightChat.findOneAndDelete(chatScope(req, { _id: req.params.id }));

    if (!chat) {
      return res.status(404).json({ success: false, message: 'Chat not found' });
    }

    return res.status(200).json({ success: true, message: 'Chat deleted' });
  } catch (error) {
    next(error);
  }
};

module.exports = { MAX_CHATS_PER_USER, list, create, getOne, update, remove };
