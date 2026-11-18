require('dotenv').config();
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const Conversation = require('./models/Conversation');
const { streamReply, isValidTone, provider } = require('./llm');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ai_chat';
const MAX_PROMPT_CHARS = 8000;
const HISTORY_LIMIT = 40; // messages sent to the model as context

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const validId = (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  next();
};

// ---------- Conversations (history sidebar) ----------

app.get('/api/conversations', async (_req, res) => {
  const list = await Conversation.find({}, 'title createdAt updatedAt').sort({ updatedAt: -1 }).limit(200).lean();
  res.json(list);
});

app.post('/api/conversations', async (_req, res) => {
  const convo = await Conversation.create({});
  res.status(201).json(convo);
});

app.get('/api/conversations/:id', validId, async (req, res) => {
  const convo = await Conversation.findById(req.params.id).lean();
  if (!convo) return res.status(404).json({ error: 'Not found' });
  res.json(convo);
});

app.patch('/api/conversations/:id', validId, async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120);
  if (!title) return res.status(400).json({ error: 'Title required' });
  const convo = await Conversation.findByIdAndUpdate(req.params.id, { title }, { new: true, timestamps: false }).lean();
  if (!convo) return res.status(404).json({ error: 'Not found' });
  res.json(convo);
});

app.delete('/api/conversations/:id', validId, async (req, res) => {
  await Conversation.findByIdAndDelete(req.params.id);
  res.status(204).end();
});

// ---------- Chat: streams the AI reply over Server-Sent Events ----------

app.post('/api/conversations/:id/messages', validId, async (req, res) => {
  const { content, regenerate } = req.body;
  const tone = isValidTone(req.body.tone) ? req.body.tone : 'professional';

  const convo = await Conversation.findById(req.params.id);
  if (!convo) return res.status(404).json({ error: 'Not found' });

  // Messages the model sees. For regenerate we answer the last user prompt again,
  // but the old reply is only replaced once a new one has actually been produced.
  let context = convo.messages;
  let replaceLast = false;
  if (regenerate) {
    const last = convo.messages[convo.messages.length - 1];
    if (last?.role === 'assistant') {
      replaceLast = true;
      context = convo.messages.slice(0, -1);
    }
    if (!context.length || context[context.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'Nothing to regenerate' });
    }
  } else {
    const text = typeof content === 'string' ? content.trim() : '';
    if (!text) return res.status(400).json({ error: 'Message is empty' });
    if (text.length > MAX_PROMPT_CHARS) return res.status(400).json({ error: `Message too long (max ${MAX_PROMPT_CHARS} chars)` });
    convo.messages.push({ role: 'user', content: text, tone });
    if (convo.messages.length === 1) convo.title = text.replace(/\s+/g, ' ').slice(0, 48);
    await convo.save();
    context = convo.messages;
  }

  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const alive = () => !res.writableEnded && !res.destroyed;
  const send = (obj) => alive() && res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // SSE comment every 15s so proxies don't drop the connection while the model is thinking.
  const heartbeat = setInterval(() => alive() && res.write(': ping\n\n'), 15000);

  // If the client disconnects (Stop button / closed tab), abort the upstream API call.
  const ac = new AbortController();
  res.on('close', () => {
    clearInterval(heartbeat);
    if (!res.writableEnded) ac.abort();
  });

  const history = context.slice(-HISTORY_LIMIT).map((m) => ({ role: m.role, content: m.content }));
  // The window may start mid-exchange; the API expects the first turn to be the user's.
  while (history.length && history[0].role !== 'user') history.shift();
  let full = '';
  let failed = null;

  try {
    for await (const delta of streamReply({ messages: history, tone, signal: ac.signal })) {
      full += delta;
      send({ type: 'delta', text: delta });
    }
  } catch (err) {
    if (!ac.signal.aborted) {
      failed = err.message || 'Upstream error';
      console.error('LLM error:', failed);
    }
  }

  // Persist whatever we got (full reply, or partial if stopped / errored).
  let saved = null;
  if (full) {
    try {
      if (replaceLast) convo.messages.pop();
      convo.messages.push({ role: 'assistant', content: full, tone, stopped: ac.signal.aborted });
      await convo.save();
      saved = convo.messages[convo.messages.length - 1];
    } catch (err) {
      // e.g. the conversation was deleted while the reply was streaming
      console.error('Save failed:', err.message);
      failed = failed || 'Reply could not be saved (was the conversation deleted?)';
    }
  }

  clearInterval(heartbeat);
  if (failed) send({ type: 'error', error: failed });
  send({ type: 'done', message: saved, title: convo.title });
  if (alive()) res.end();
});

// ---------- Boot ----------

app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: 'Internal server error' });
});

mongoose
  .connect(MONGODB_URI)
  .then(() => {
    app.listen(PORT, () => console.log(`Chat assistant on http://localhost:${PORT} (provider: ${provider})`));
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
