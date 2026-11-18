const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
  // Tone that was active when this message was produced (assistant) or sent (user).
  tone: { type: String, enum: ['professional', 'casual', 'concise'] },
  // True when the user pressed "Stop" and the reply is partial.
  stopped: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

const conversationSchema = new mongoose.Schema(
  {
    title: { type: String, default: 'New chat', trim: true, maxlength: 120 },
    messages: [messageSchema],
  },
  { timestamps: true } // adds createdAt / updatedAt on the conversation itself
);

conversationSchema.index({ updatedAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
