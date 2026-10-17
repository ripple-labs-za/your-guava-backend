const mongoose = require('mongoose');

const insightChatMessageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ['user', 'assistant'],
      required: true,
    },
    content: {
      type: String,
      required: true,
      maxlength: 20000,
    },
    // Set only by the paid AI controller. It makes answer persistence
    // idempotent when a client retries after losing the original response.
    requestKey: {
      type: String,
      maxlength: 160,
      select: false,
    },
  },
  { _id: false, timestamps: true }
);

const insightChatSchema = new mongoose.Schema(
  {
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
      required: true,
      index: true,
    },
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
      default: 'New chat',
    },
    messages: {
      type: [insightChatMessageSchema],
      default: [],
      validate: {
        validator: (messages) => messages.length <= 80,
        message: 'A chat can store at most 80 messages',
      },
    },
    contextStats: {
      transactionCount: { type: Number, default: 0, min: 0 },
      locations: { type: Number, default: 0, min: 0 },
      topItems: { type: Number, default: 0, min: 0 },
      forecasts: { type: Number, default: 0, min: 0 },
      menuItemIssues: { type: Number, default: 0, min: 0 },
      contextWindow: { type: String, maxlength: 1000 },
    },
    archived: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true }
);

insightChatSchema.index({ userId: 1, cafeId: 1, archived: 1, updatedAt: -1 });

module.exports = mongoose.model('InsightChat', insightChatSchema);
