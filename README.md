# AI Chat Assistant

Streaming chat UI + Express/MongoDB backend. Works with Google Gemini, Anthropic (Claude) or OpenAI.

## Run it

Requires Node.js 18+ and a MongoDB instance.

```bash
npm install
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
# edit .env: set LLM_PROVIDER (gemini | anthropic | openai) and the matching API key
# MongoDB: local `mongod`, Docker (docker run -p 27017:27017 mongo), or an Atlas URI in MONGODB_URI
npm start                 # http://localhost:3000   (npm run dev = auto-restart on changes)
```

No API key yet? Set `LLM_PROVIDER=mock` to try the whole UI with canned replies.
API keys are read only on the server from `.env`, which is git-ignored and never sent to the browser.

## What's where

| Requirement | Implementation |
|---|---|
| Scrollable chat with distinct bubbles | `public/app.js` `messageEl()`, `style.css` |
| Character-by-character streaming | Server streams SSE chunks (`server.js`); client typewriter queue drains them one frame at a time (`send()` in `app.js`) |
| History sidebar | `GET /api/conversations`, rename / delete / title search |
| Gemini / Claude / OpenAI integration | `llm.js` (`LLM_PROVIDER=gemini\|anthropic\|openai`), official SDKs, streamed |
| MongoDB persistence | `models/Conversation.js` – each message stores `role`, `content` (prompt or reply), `tone`, `createdAt`; conversation has `title` + timestamps |
| **Tone Toggle** | Header pills → `tone` sent with every request → `buildSystemPrompt(tone)` in `llm.js` is passed as the **system** parameter of the API call, so the very next reply changes style. The tone used is stored on each message and shown as a badge. |

## Extra features (not in the brief)

1. **Markdown + syntax-highlighted code blocks with one-click Copy** – replies render headings, lists, tables and code (sanitised with DOMPurify, highlighted with highlight.js).
2. **Stop & Regenerate** – the Send button becomes *Stop* while streaming; this aborts the upstream API call and saves the partial reply (marked "stopped"). *Regenerate* re-answers the last prompt, and you can change the tone first to see the same answer in a different voice. The old reply is only replaced once a new one arrives; if a reply fails, a *Retry* link appears under your prompt.

Smaller extras: auto-titled conversations, rename/delete, sidebar search, dark mode, mobile layout, per-reply copy.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/conversations` | list (newest first) |
| POST | `/api/conversations` | create |
| GET | `/api/conversations/:id` | full conversation |
| PATCH | `/api/conversations/:id` | `{title}` |
| DELETE | `/api/conversations/:id` | |
| POST | `/api/conversations/:id/messages` | `{content, tone, regenerate?}` → SSE: `delta`, `error`, `done` |

## Notes

- Single-user demo: no authentication. Add auth + per-user filtering before exposing publicly.
- Last 40 messages are sent as context. Prompt limit 8000 chars.
- Frontend loads marked / DOMPurify / highlight.js from jsDelivr; if blocked, it falls back to plain text.
