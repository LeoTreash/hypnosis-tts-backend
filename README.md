# TTS Backend — Setup Guide

A small proxy server with two jobs:
1. **`/api/generate-script`** — asks Claude to write only the personalized
   suggestion paragraph, and assembles it into your fixed, reviewed skeleton
   (induction → deepener → suggestion → emergence). The structure never
   changes; only that one paragraph is AI-generated per user.
2. **`/api/tts`** — turns each paragraph into audio via Google Cloud TTS,
   with caching so repeated lines (your fixed skeleton text) are free after
   the first synthesis.

## 1. Get your API keys
**Anthropic (for script generation):**
1. Go to console.anthropic.com and create an API key.
2. Set it as `ANTHROPIC_API_KEY` in your environment.

**Google Cloud (for narration audio):**
1. Go to console.cloud.google.com, create/select a project.
2. Enable the **Cloud Text-to-Speech API**.
3. Create an API key under **APIs & Services → Credentials**.
4. Set it as `GOOGLE_TTS_API_KEY` in your environment.

## 2. Run it locally
```bash
cd tts-backend
npm install
export ANTHROPIC_API_KEY="your-anthropic-key"
export GOOGLE_TTS_API_KEY="your-google-key"
npm start
```
Server runs on http://localhost:3001.

Test script generation:
```bash
curl -X POST http://localhost:3001/api/generate-script \
  -H "Content-Type: application/json" \
  -d '{"goal": "sleep", "answers": {"worry": "a presentation tomorrow"}}'
```
Returns `{ "paragraphs": [induction, deepener, suggestion, emergence], "aiGenerated": [false,false,true,false] }`.

Test TTS on one of those paragraphs:
```bash
curl -X POST http://localhost:3001/api/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Take a slow breath in, and let it out slowly."}'
```

## 3. Full flow from your frontend
```javascript
async function generateSession(goal, answers) {
  const scriptRes = await fetch('https://your-backend.com/api/generate-script', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal, answers }),
  });
  const { paragraphs } = await scriptRes.json();

  // Fetch audio per paragraph (parallel is fine; cache makes repeats instant)
  const audioClips = await Promise.all(
    paragraphs.map(async (text) => {
      const r = await fetch('https://your-backend.com/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const { audioContent } = await r.json();
      return audioContent;
    })
  );

  return { paragraphs, audioClips }; // play audioClips[i] in sequence
}
```

## Notes on the design
- **Why only one paragraph is AI-generated:** this is the safety/quality
  guardrail from the original design — induction, deepener, and emergence
  are hypnotherapist-reviewed and never touched by the model. Only the
  suggestion block, which needs to reference the user's specific situation,
  is generated per request.
- **Cost:** script generation is a short completion (a few hundred tokens),
  so it's inexpensive per session even outside any free tier. Combined with
  TTS caching, most of a session's audio (the fixed parts) costs nothing
  after the first user generates each goal type.
- **Extending to more skeletons:** add an entry to `skeletons.js` following
  the same shape (`induction`, `deepener`, `emergence`, `suggestionPrompt`)
  and it's automatically available at `/api/generate-script`.

## 4. Deploy it

### Option A: Render, using the included Blueprint (recommended, easiest)
1. Push this `tts-backend` folder to a GitHub repo (create one if you don't
   have one yet — github.com/new, then `git init && git add . && git commit
   -m "init" && git remote add origin <your-repo-url> && git push`).
2. Go to render.com, sign up/log in, click **New → Blueprint**.
3. Connect the GitHub repo. Render detects `render.yaml` automatically and
   pre-fills the service config (free plan, Node runtime, correct build and
   start commands).
4. When prompted, enter your two environment variables:
   - `ANTHROPIC_API_KEY`
   - `GOOGLE_TTS_API_KEY`
5. Click **Apply** / **Deploy**. First deploy takes a couple of minutes.
6. Once live, Render gives you a URL like
   `https://hypnosis-tts-backend.onrender.com`. Visit `<that-url>/health` —
   you should see `{"ok": true}`.

Note: Render's free tier spins the service down after inactivity, so the
first request after idle time can take ~30-50s to wake up. Fine for
testing; worth upgrading before a real launch.

### Option B: Railway
Same idea — connect the repo, Railway auto-detects Node, set the two env
vars in its dashboard, deploy. No blueprint file needed; Railway infers
the start command from `package.json`.

### Option C: Vercel serverless / Cloudflare Worker
Both work, but need the route logic ported into their function format
(one file per route rather than a long-running Express server), and the
disk cache swapped for a key-value store (see the caching section below).
Only worth it once you outgrow Render/Railway's simplicity.

Whichever you choose, never commit your API keys to source control —
always set them as environment variables on the hosting platform (already
excluded via `.gitignore`).

## 5. Test it for real with the included local test client
`local-test-client.html` in this folder is a plain HTML file — **not** a
Claude artifact, so it isn't sandboxed and can call your real deployed
backend directly. To use it:
1. Open `local-test-client.html` by double-clicking it (or dragging it
   into a browser tab).
2. Paste in your Render/Railway URL.
3. Pick a goal, add a specific (e.g. `worry: a big presentation tomorrow`),
   and click Generate. You'll get the real Claude-written suggestion
   paragraph and real Google-quality audio clips per paragraph, playable
   right there.

This is the fastest way to actually hear production voice quality before
wiring any of this into the React Native app.
## Caching (already built in)
Every request is hashed (text + voice + rate + pitch) and checked against
a cache before calling Google — first in memory, then on disk in
`tts-cache/`. A repeated line (like a shared induction sentence across many
users' sessions) is synthesized once, ever, and served from cache after
that — free and instant on repeat.

- Disk cache persists across restarts/deploys, as long as you're not on an
  ephemeral filesystem (see note below for serverless).
- Check `GET /cache-stats` to see how many entries are cached.
- **Serverless caveat:** Vercel/Cloudflare Workers typically have ephemeral
  or no writable disk. On those platforms, swap `readFromDisk`/`writeToDisk`
  for a small key-value store (Vercel KV, Cloudflare KV, or even a Redis
  free tier) using the same `cacheKeyFor()` hash as the key.

## Notes on cost
Google's free tier is 1 million characters/month for WaveNet/Neural2
voices, resetting every month (not a one-time trial). A 10-minute session
is roughly 9,000 characters, so this covers 100+ full sessions/month at
zero cost. Monitor usage in the Google Cloud Console if you expect to
scale past that.
