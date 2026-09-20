// TRIAGE-X website — Express server.
//
// Serves the static frontend (public/) and two small API routes that do
// REAL retrieval-augmented generation against the OpenAI API:
//   POST /api/ai/explain  — explain a case's computed triage priority
//   POST /api/ai/ask      — a follow-up Q&A chat about a case
//
// RAG pipeline (see lib/knowledge.js):
//   1. At startup, every reference-note chunk is embedded once via
//      OpenAI's embeddings API and cached in memory (small, static corpus
//      — no vector DB needed).
//   2. Per request, the case's symptoms/vitals/history (+ the question,
//      for chat) are embedded and compared against the cached chunk
//      embeddings with cosine similarity; the top matches are retrieved.
//   3. Those chunks + the case data are put in the prompt sent to an
//      OpenAI chat model, which is instructed to explain/ground its
//      answer in them and never diagnose.
//
// The browser never sees the OpenAI key — only this server calls OpenAI.

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWLEDGE_BASE, retrieveTopChunks } from './lib/knowledge.js';
import { buildCaseContextText, buildCaseRetrievalText, buildReferenceNotesText, AI_SYSTEM_RULES } from './lib/caseContext.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* =====================================================================
   OpenAI helpers
   ===================================================================== */
async function openaiEmbed(input) {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, input }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`OpenAI embeddings ${resp.status}: ${body.slice(0, 300)}`);
  }
  const json = await resp.json();
  return json.data.map(d => d.embedding);
}

async function openaiChatStream(messages) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: CHAT_MODEL, messages, stream: true, temperature: 0.3 }),
  });
  if (!resp.ok || !resp.body) {
    const body = await resp.text().catch(() => '');
    const err = new Error(`OpenAI chat ${resp.status}: ${body.slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
  return resp.body; // a WHATWG ReadableStream of OpenAI's own SSE bytes
}

/** Reads an OpenAI streaming chat completion body and calls onDelta(text)
 * for each token chunk as it arrives. */
async function pumpOpenAiStream(openAiBody, onDelta) {
  const reader = openAiBody.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep the last, possibly-incomplete line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch (e) { /* ignore malformed partial line */ }
    }
  }
}

/* =====================================================================
   Knowledge base embeddings — computed once at startup
   ===================================================================== */
let embeddedChunks = null; // [{ id, title, text, embedding }] once ready
let embeddingError = null;

async function initKnowledgeEmbeddings() {
  if (!OPENAI_API_KEY) {
    embeddingError = 'OPENAI_API_KEY is not set. Add it to .env and restart the server.';
    console.warn('[triagex] ' + embeddingError + ' AI Case Assistant routes will return 503.');
    return;
  }
  try {
    const vectors = await openaiEmbed(KNOWLEDGE_BASE.map(c => `${c.title}. ${c.text}`));
    embeddedChunks = KNOWLEDGE_BASE.map((c, i) => ({ ...c, embedding: vectors[i] }));
    console.log(`[triagex] Embedded ${embeddedChunks.length} knowledge-base chunks (${EMBED_MODEL}).`);
  } catch (e) {
    embeddingError = e.message || String(e);
    console.error('[triagex] Failed to embed knowledge base at startup:', embeddingError);
  }
}

/* =====================================================================
   SSE-ish streaming helper — plain "data: {json}\n\n" frames the client
   reads with fetch() + getReader() (not the EventSource API, since this
   is a POST request with a body).
   ===================================================================== */
function startStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  return {
    send(obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); },
    end() { res.end(); },
  };
}

function validateCase(body) {
  const c = body && body.case;
  if (!c || typeof c !== 'object') return null;
  return {
    age: c.age,
    gender: c.gender,
    symptoms: Array.isArray(c.symptoms) ? c.symptoms : [],
    vitals: c.vitals && typeof c.vitals === 'object' ? c.vitals : {},
    history: Array.isArray(c.history) ? c.history : [],
    triage: c.triage && typeof c.triage === 'object' ? c.triage : {},
  };
}

/* =====================================================================
   Routes
   ===================================================================== */
app.post('/api/ai/explain', async (req, res) => {
  const c = validateCase(req.body);
  if (!c) return res.status(400).json({ error: 'invalid_request', message: 'Missing "case" in request body.' });
  if (!embeddedChunks) {
    return res.status(503).json({ error: 'ai_unavailable', message: embeddingError || 'AI Case Assistant is not ready yet — try again in a moment.' });
  }

  const stream = startStream(res);
  try {
    const retrievalText = buildCaseRetrievalText(c, 'explain this case and why it was triaged this way');
    const [queryEmbedding] = await openaiEmbed([retrievalText]);
    const chunks = retrieveTopChunks(embeddedChunks, queryEmbedding, 5);
    stream.send({ type: 'sources', chunks: chunks.map(ch => ({ id: ch.id, title: ch.title, text: ch.text })) });

    const userPrompt = `${buildCaseContextText(c)}\n\nReference notes (cite the bracketed id like [chest-pain] when you use one):\n${buildReferenceNotesText(chunks)}\n\nTask: In 3-5 short bullet points, explain why the case data plausibly supports the computed priority (or note any tension), citing reference note ids where relevant. End with one line reminding the reader this is decision support, not a diagnosis.`;
    const messages = [
      { role: 'system', content: AI_SYSTEM_RULES },
      { role: 'user', content: userPrompt },
    ];

    const body = await openaiChatStream(messages);
    await pumpOpenAiStream(body, (delta) => stream.send({ type: 'delta', text: delta }));
    stream.send({ type: 'done' });
  } catch (e) {
    console.error('[triagex] /api/ai/explain error:', e.message);
    stream.send({ type: 'error', message: friendlyOpenAiError(e) });
  } finally {
    stream.end();
  }
});

app.post('/api/ai/ask', async (req, res) => {
  const c = validateCase(req.body);
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-6) : [];
  if (!c || !question) return res.status(400).json({ error: 'invalid_request', message: 'Missing "case" or "question" in request body.' });
  if (!embeddedChunks) {
    return res.status(503).json({ error: 'ai_unavailable', message: embeddingError || 'AI Case Assistant is not ready yet — try again in a moment.' });
  }

  const stream = startStream(res);
  try {
    const retrievalText = buildCaseRetrievalText(c, question);
    const [queryEmbedding] = await openaiEmbed([retrievalText]);
    const chunks = retrieveTopChunks(embeddedChunks, queryEmbedding, 5);
    stream.send({ type: 'sources', chunks: chunks.map(ch => ({ id: ch.id, title: ch.title, text: ch.text })) });

    const systemPrompt = `${AI_SYSTEM_RULES}\n\n${buildCaseContextText(c)}\n\nReference notes (cite the bracketed id like [chest-pain] when you use one):\n${buildReferenceNotesText(chunks)}`;
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.filter(t => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string').map(t => ({ role: t.role, content: t.content })),
      { role: 'user', content: question },
    ];

    const body = await openaiChatStream(messages);
    await pumpOpenAiStream(body, (delta) => stream.send({ type: 'delta', text: delta }));
    stream.send({ type: 'done' });
  } catch (e) {
    console.error('[triagex] /api/ai/ask error:', e.message);
    stream.send({ type: 'error', message: friendlyOpenAiError(e) });
  } finally {
    stream.end();
  }
});

function friendlyOpenAiError(e) {
  const msg = e.message || String(e);
  if (e.status === 401) return 'OpenAI rejected the API key (401). Check OPENAI_API_KEY in .env.';
  if (e.status === 429) return 'Rate limited by OpenAI (429) — wait a moment and try again.';
  if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
    return 'Could not reach OpenAI from this server (network issue). Check internet access and try again.';
  }
  return 'Could not get an answer right now — please try again.';
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, aiReady: !!embeddedChunks, aiError: embeddingError });
});

app.listen(PORT, async () => {
  console.log(`[triagex] TRIAGE-X website running at http://localhost:${PORT}`);
  await initKnowledgeEmbeddings();
});
