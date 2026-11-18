/**
 * LLM adapter. Exposes one async generator, streamReply(), that yields text
 * chunks regardless of which provider is configured.
 *
 * The "Tone Toggle" lives here: the selected tone is turned into a system
 * instruction and sent with EVERY request, so switching tone mid-conversation
 * changes the style of the very next reply.
 */

const TONES = {
  professional:
    'Tone: PROFESSIONAL. Write in a polished, formal, business-appropriate register. ' +
    'Use precise vocabulary, complete sentences and a structured layout (short headings or bullet points where useful). ' +
    'No slang, no emojis, no filler.',
  casual:
    'Tone: CASUAL. Write like a friendly, relaxed person chatting with a friend. ' +
    'Use contractions, simple everyday words and a warm, upbeat voice. An occasional emoji is fine. ' +
    "Keep it conversational, not stiff.",
  concise:
    'Tone: CONCISE. Be as brief as possible while staying correct. ' +
    'Lead with the answer in one to three short sentences. No preamble, no repetition, no closing pleasantries. ' +
    'Use a short list only if it is clearly shorter than prose.',
};

const BASE_SYSTEM =
  'You are a helpful, accurate AI assistant in a chat application. ' +
  'Format answers in Markdown (use fenced code blocks with a language tag for code). ' +
  'The style instruction below applies to this reply and overrides any style used earlier in the conversation.';

function isValidTone(t) {
  return Object.prototype.hasOwnProperty.call(TONES, t);
}

function buildSystemPrompt(tone) {
  return `${BASE_SYSTEM}\n\n${TONES[isValidTone(tone) ? tone : 'professional']}`;
}

const provider = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();

let anthropicClient;
let openaiClient;
let geminiClient;

async function* streamGemini({ messages, system, signal }) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
  if (!geminiClient) {
    const { GoogleGenAI } = require('@google/genai');
    // SDK default is 5 attempts with backoff (~100s of "Thinking…" when Gemini is overloaded);
    // fail fast instead and let the user press Retry.
    geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { retryOptions: { attempts: 2 } } });
  }
  try {
    const stream = await geminiClient.models.generateContentStream({
      model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
      // Gemini calls the assistant role "model".
      contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      config: { systemInstruction: system, abortSignal: signal },
    });
    for await (const chunk of stream) {
      if (signal?.aborted) return;
      const text = chunk.text;
      if (text) yield text;
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error(friendlyGeminiError(err));
  }
}

// Gemini SDK errors carry the HTTP status plus a (sometimes doubly) JSON-encoded body.
// Turn that into one readable sentence for the chat UI.
function friendlyGeminiError(err) {
  let msg = err?.message || 'Gemini request failed';
  for (let i = 0; i < 3; i++) {
    try {
      const j = JSON.parse(msg);
      const inner = j?.error?.message ?? j?.message;
      if (typeof inner !== 'string') break;
      msg = inner;
    } catch { break; }
  }
  const status = err?.status;
  if (status === 503) return 'Gemini is overloaded right now (503). Please press Retry in a moment.';
  if (status === 429) return 'Gemini rate limit / quota reached (429). Please wait a bit and retry.';
  if (status === 401 || status === 403) return `Gemini rejected the API key (${status}): ${msg.trim()}`;
  return status ? `Gemini error (${status}): ${msg.trim()}` : msg.trim();
}

async function* streamAnthropic({ messages, system, signal }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  if (!anthropicClient) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  const stream = anthropicClient.messages.stream(
    {
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
      max_tokens: 2048,
      system,
      messages,
    },
    { signal }
  );
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
      yield ev.delta.text;
    }
  }
}

async function* streamOpenAI({ messages, system, signal }) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
  if (!openaiClient) {
    const OpenAI = require('openai');
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  const stream = await openaiClient.chat.completions.create(
    {
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'system', content: system }, ...messages],
    },
    { signal }
  );
  for await (const chunk of stream) {
    const text = chunk.choices?.[0]?.delta?.content;
    if (text) yield text;
  }
}

// Offline demo provider: lets the UI be tried without an API key.
async function* streamMock({ messages, system, signal }) {
  const last = messages[messages.length - 1]?.content || '';
  let tone = 'professional';
  if (system.includes('CASUAL')) tone = 'casual';
  if (system.includes('CONCISE')) tone = 'concise';

  const replies = {
    professional:
      `Thank you for your message. Here is a structured response to: "${last.slice(0, 80)}"\n\n` +
      '## Summary\n- This is a **mock** response (no API key configured).\n- Tone applied: *professional*.\n\n' +
      '```js\nconsole.log("Set LLM_PROVIDER and an API key to use a real model.");\n```\n',
    casual:
      `Hey! Got your message about "${last.slice(0, 80)}" 😄\n\nThis is just a **mock** reply since there's no API key yet - ` +
      "but hey, the streaming and tone switch are working, so that's the fun part!",
    concise: 'Mock reply (no API key). Tone: concise.',
  };

  for (const ch of replies[tone]) {
    if (signal?.aborted) return;
    await new Promise((r) => setTimeout(r, 8));
    yield ch;
  }
}

async function* streamReply({ messages, tone, signal }) {
  const system = buildSystemPrompt(tone);
  const args = { messages, system, signal };
  if (provider === 'gemini') yield* streamGemini(args);
  else if (provider === 'openai') yield* streamOpenAI(args);
  else if (provider === 'mock') yield* streamMock(args);
  else yield* streamAnthropic(args);
}

module.exports = { streamReply, buildSystemPrompt, isValidTone, TONES, provider };
