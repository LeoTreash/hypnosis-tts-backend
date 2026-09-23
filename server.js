// Minimal TTS backend for the self-hypnosis app prototype.
// Keeps the Google Cloud TTS API key secret on the server; the browser
// never sees it. Deploy this anywhere that runs Node (Render, Railway,
// Fly.io, a VPS) or port it to a single Vercel/Cloudflare serverless function.

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SKELETONS } = require('./skeletons');

const app = express();
app.use(cors()); // In production, restrict this to your app's domain only.
app.use(express.json({ limit: '1mb' }));

const GOOGLE_TTS_KEY = process.env.GOOGLE_TTS_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!GOOGLE_TTS_KEY) {
  console.warn('Warning: GOOGLE_TTS_API_KEY is not set. TTS requests will fail.');
}
if (!ANTHROPIC_API_KEY) {
  console.warn('Warning: ANTHROPIC_API_KEY is not set. Script generation will fail.');
}


// --- Cache setup ---
// Many lines repeat across sessions (inductions, deepeners, emergence blocks
// only vary in a few sentences). Caching by a hash of the exact synthesis
// params means those repeated lines are billed and generated only once,
// ever, instead of on every session a user generates.
const CACHE_DIR = process.env.TTS_CACHE_DIR || path.join(__dirname, 'tts-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });
const memCache = new Map(); // fast in-process lookup; disk is the durable layer

function cacheKeyFor(params) {
  const normalized = JSON.stringify(params); // params object built with stable key order below
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function readFromDisk(key) {
  const file = path.join(CACHE_DIR, `${key}.mp3.b64`);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  return null;
}

function writeToDisk(key, base64Audio) {
  const file = path.join(CACHE_DIR, `${key}.mp3.b64`);
  fs.writeFile(file, base64Audio, 'utf8', (err) => {
    if (err) console.error('Cache write failed:', err);
  });
}


// POST /api/tts
// body: { text: string, voice?: string, languageCode?: string, speakingRate?: number }
// returns: { audioContent: base64 mp3 string }
app.post('/api/tts', async (req, res) => {
  try {
    const {
      text,
      voice = 'en-US-Neural2-F',       // calm, warm default voice
      languageCode = 'en-US',
      speakingRate = 0.88,             // slightly slower, fits hypnosis pacing
      pitch = -1.0,
    } = req.body || {};

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Missing "text" in request body.' });
    }
    if (text.length > 5000) {
      // Google's synthesize endpoint caps input around 5000 bytes per request.
      // For longer sessions, split into paragraphs and call this endpoint
      // once per paragraph (the frontend prototype already renders per-paragraph,
      // so this maps naturally).
      return res.status(400).json({ error: 'Text too long for a single request (max ~5000 chars). Split into paragraphs.' });
    }

    // Stable, ordered key so identical requests always hash the same way.
    const cacheParams = { text, voice, languageCode, speakingRate, pitch };
    const key = cacheKeyFor(cacheParams);

    // 1. Fast in-memory hit (same server process, already served this before)
    if (memCache.has(key)) {
      return res.json({ audioContent: memCache.get(key), cached: 'memory' });
    }

    // 2. Disk hit (persists across server restarts/deploys)
    const diskHit = readFromDisk(key);
    if (diskHit) {
      memCache.set(key, diskHit);
      return res.json({ audioContent: diskHit, cached: 'disk' });
    }

    // 3. No cache hit — call Google TTS, then cache the result both places.
    const response = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode, name: voice },
          audioConfig: {
            audioEncoding: 'MP3',
            speakingRate,
            pitch,
          },
        }),
      }
    );

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Google TTS error:', response.status, errBody);
      return res.status(502).json({ error: 'TTS provider error.' });
    }

    const data = await response.json();
    // data.audioContent is already base64-encoded MP3 audio.
    memCache.set(key, data.audioContent);
    writeToDisk(key, data.audioContent);
    res.json({ audioContent: data.audioContent, cached: false });
  } catch (err) {
    console.error('TTS proxy error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/generate-script
// body: { goal: 'sleep'|'anxiety'|'confidence'|'habit'|'focus', answers: { ... } }
// returns: { paragraphs: string[] }  -- ready to hand to the TTS endpoint, one call per paragraph
app.post('/api/generate-script', async (req, res) => {
  try {
    const { goal, answers = {} } = req.body || {};
    const skeleton = SKELETONS[goal];
    if (!skeleton) {
      return res.status(400).json({ error: `Unknown goal "${goal}". Expected one of: ${Object.keys(SKELETONS).join(', ')}` });
    }

    const answersText = Object.entries(answers)
      .filter(([, v]) => v && String(v).trim())
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n') || '(no specifics provided — write a gentle, general version of this suggestion)';

    const systemPrompt = [
      'You write ONE paragraph of self-hypnosis suggestion language, to be inserted into a fixed, ',
      'pre-written hypnosis script between a deepener and an emergence section. ',
      'You do not write the induction, deepener, or emergence — only the suggestion paragraph. ',
      'Rules: second person ("you"), present tense, calm and unhurried tone, no clinical or medical claims, ',
      'no promises of curing or guaranteeing an outcome, no mention of medication or diagnosis, ',
      'no headers, no stage directions, no quotation marks around the output — return only the paragraph itself.',
    ].join('');

    const userPrompt = `${skeleton.suggestionPrompt}\n\nPerson's answers:\n${answersText}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Anthropic API error:', response.status, errBody);
      return res.status(502).json({ error: 'Script generation provider error.' });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    const suggestion = (textBlock?.text || '').trim();

    if (!suggestion) {
      return res.status(502).json({ error: 'No suggestion text returned.' });
    }

    // Assemble the full script: fixed skeleton + AI-generated middle.
    const paragraphs = [
      skeleton.induction,
      skeleton.deepener,
      suggestion,
      skeleton.emergence,
    ];

    res.json({ paragraphs, aiGenerated: [false, false, true, false] });
  } catch (err) {
    console.error('Script generation error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/cache-stats', (_req, res) => {
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.mp3.b64'));
  res.json({ diskEntries: files.length, memoryEntries: memCache.size });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`TTS proxy listening on port ${PORT}`));
