<p align="center">
  <img src="https://raw.githubusercontent.com/Huzaifafarooq-cdr/ai-meeting-recorder-frontend/main/public/logo.png" width="72" alt="Buzytech logo" />
</p>

<h1 align="center">Buzytech AI Recorder</h1>

<p align="center">
  Record meetings in the browser, follow a live transcript with speaker detection, and get a clean transcript, summary, key decisions, action items, keywords and a suggested title as soon as the meeting ends.
</p>

---

## Contents

1. [Repositories](#repositories)
2. [Features](#features)
3. [Tech stack](#tech-stack)
4. [Getting started](#getting-started)
5. [Architecture](#architecture)
6. [AI flow](#ai-flow)
7. [Database design](#database-design)
8. [Scalability](#scalability)
9. [Security](#security)
10. [Error handling](#error-handling)
11. [Performance](#performance)
12. [Testing](#testing)
13. [Evaluation guide](#evaluation-guide)
14. [Assumptions and limitations](#assumptions-and-limitations)
15. [API reference](#api-reference)

---

## Repositories

| Repository | Contents |
|---|---|
| [ai-meeting-recorder-frontend](https://github.com/Huzaifafarooq-cdr/ai-meeting-recorder-frontend) | React single-page app (Vite, React Router, TanStack Query, Tailwind CSS) |
| [ai-meeting-recorder-backend](https://github.com/Huzaifafarooq-cdr/ai-meeting-recorder-backend) | Node.js API, WebSocket gateway and AI processing worker (Express, Mongoose, ws) |

Clone both side by side:

```
ai-meeting-recorder/
├── backend/
└── frontend/
```

---

## Features

**Authentication**: registration, login, logout, JWT access tokens, bcrypt password hashing, rotating refresh tokens, protected REST and WebSocket APIs.

**Dashboard**: new recording, upload audio, recent meetings, live processing status, usage stats and global search (`Ctrl K` / `⌘K`).

**Languages**: English and Hindi are both supported, including Hinglish (switching between the two in the same sentence). Hindi is transcribed in Devanagari, and the summary, action items, decisions and title are generated from the transcript in either language. Set with `STT_LANGUAGE=multi` (see [Getting started](#getting-started)).

**Live recording**
- Start, pause, resume and stop with a pause-aware timer
- Record from the **microphone** or from a **meeting tab** (Google Meet, Zoom or Teams in the browser): the tab's audio and your microphone are mixed, so everyone in the call is captured, even with headphones (Chrome and Edge on desktop)
- Live waveform, input level meter and microphone picker
- Real-time transcript: partial words appear immediately and are replaced by finalized text, with auto-scroll and a "jump to latest" button
- Multi-speaker detection with the active speaker shown live
- Session panel: connection, network, active speaker, AI status, audio synced to the server
- Warnings for silence, low volume and lost connection while recording

**Automatic processing** starts when recording stops (no manual trigger). Seven visible stages: audio upload → speech-to-text → speaker separation → transcript generation → AI summary → action items → insights → completed.

**Results**
- Clean transcript (filler words removed, punctuation and capitalization fixed) with a toggle to the original
- Summary (overview, topics, decisions, outcome), key decisions, action items with owner and due date (can be ticked off), keywords and an AI-suggested title
- Speaker renaming (Speaker A → John) applied everywhere
- Audio playback with click-to-seek timestamps and the current line highlighted
- Find in transcript, and copy notes as Markdown

**History**: list, search across title / transcript / summary / keywords, filter by date and status, replay, delete, pagination.

**Meeting page tabs**: *Summary & actions* and *Transcript*, plus a *Processing* tab when processing fails partway, so finished results stay visible next to the failed stage.

**Input validation in the browser**: forms are checked before anything is sent, using the same rules as the server (`src/lib/validation.js`), so invalid input never reaches the API:
- Login and register: required fields, email format, name length, password rules (8+ characters, a letter and a number). The first invalid field gets focus and its message clears as you type.
- Title and speaker editors: empty titles are rejected; saving without changes doesn't call the API; only changed speaker names are sent.
- Search: at least 2 characters, and a "From" date after the "To" date is flagged instead of searched.
- Repeated clicks on an action item while it's saving are ignored.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React 19, Vite, React Router, TanStack Query, Tailwind CSS 4 | Fast dev loop, server-state caching and retries out of the box, consistent design system |
| Backend | Node.js 20+, Express, Mongoose, zod | Simple, well-known HTTP layer; schema validation on every input |
| Realtime | `ws` WebSockets | Binary audio frames and a small custom protocol don't need Socket.IO's extra layer |
| Database | MongoDB (Atlas or local) | Flexible documents for meeting results, text indexes for search, GridFS for audio |
| Speech-to-text | Deepgram (`nova-3`) | Streaming and pre-recorded transcription with diarization in one API |
| LLM | Any OpenAI-compatible API (Gemini by default) | Provider can change through configuration only |

---

## Getting started

### Requirements

- Node.js 20.10 or newer
- A [Deepgram](https://console.deepgram.com) API key (new accounts get free credit)
- An LLM API key for any OpenAI-compatible endpoint. The default is Google Gemini ([free key](https://aistudio.google.com/apikey))
- MongoDB: a MongoDB Atlas connection string, a local MongoDB, or none at all (an embedded MongoDB can start automatically for local development)

### 1. Backend (http://localhost:5000)

```bash
cd backend
npm install
cp .env.example .env      # then fill in the values below
npm run dev
```

Minimum `.env` values:

| Variable | Description |
|---|---|
| `JWT_ACCESS_SECRET`, `JWT_MEDIA_SECRET` | Random strings, at least 32 characters: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `DEEPGRAM_API_KEY` | Deepgram key |
| `STT_LANGUAGE` | `multi` for English + Hindi (and Hinglish), `en` for English only, `hi` for Hindi only |
| `LLM_API_KEY` | Key for the LLM provider |
| `LLM_BASE_URL`, `LLM_MODEL` | Defaults to Gemini (`gemini-flash-lite-latest`). For OpenAI: `https://api.openai.com/v1` and e.g. `gpt-4o-mini` |
| `MONGODB_URI` + `USE_IN_MEMORY_DB` | Set `USE_IN_MEMORY_DB=true` to start an embedded MongoDB, or `false` and a `MONGODB_URI` (Atlas or local) |
| `CLIENT_ORIGIN` | Frontend URL(s), comma separated |

The server validates its configuration on startup and exits with a clear message if something is missing.

### 2. Frontend (http://localhost:5173)

```bash
cd frontend
npm install
npm run dev
```

Leave `VITE_API_URL` empty to use the Vite dev proxy (`/api` and `/ws` go to `http://localhost:5000`). Requests are then same-origin, so CORS never gets in the way locally. In production, set it to the API origin before `npm run build`.

In development (`NODE_ENV` other than `production`), the backend accepts requests and WebSocket connections from any `localhost` / `127.0.0.1` port. In production, only the origins listed in `CLIENT_ORIGIN` are allowed.

Open http://localhost:5173, create an account, then record a meeting or upload an audio file.

### Useful scripts

| Where | Command | What it does |
|---|---|---|
| backend | `npm run dev` | API + in-process worker with auto-reload |
| backend | `npm run worker` | Standalone worker process (needs a shared MongoDB) |
| backend | `npm run test:e2e` | End-to-end API checks against a running server |
| backend / frontend | `npm run lint` | ESLint |
| frontend | `npm run build` | Production build in `dist/` |

---

## Architecture

```
 Browser (React)                         Backend (Node.js)                         External
┌──────────────────────┐   REST /api    ┌───────────────────────────────┐
│ Auth, dashboard,     │ ─────────────► │ Express API                   │
│ history, search      │                │  auth · recordings · media    │
│                      │   WS /ws/live  │                               │   wss   ┌───────────┐
│ Recorder:            │ ◄────────────► │ Live gateway ── STT session ──┼───────► │ Deepgram  │
│ MediaRecorder 250 ms │  audio chunks  │  (stores audio + segments)    │         └───────────┘
│ WebAudio analyser    │  ← transcripts │                               │
│                      │  WS /ws/events │ Event bus ─► progress push    │  https  ┌───────────┐
│ Live progress        │ ◄───────────── │                               │ ──────► │ LLM       │
└──────────────────────┘                │ Job queue (MongoDB, leased)   │         │ (Gemini / │
                                        │  └► Worker: 7-stage pipeline  │         │  OpenAI)  │
                                        └──────────────┬────────────────┘         └───────────┘
                                                       │ Mongoose
                                            ┌──────────▼──────────┐
                                            │ MongoDB             │
                                            │ data + GridFS audio │
                                            └─────────────────────┘
```

**Backend layout (`backend/src`)**

| Folder | Responsibility |
|---|---|
| `modules/` | Feature modules: `auth`, `recordings`, `media` (routes → service → models), validated with zod |
| `ai/stt`, `ai/llm` | Provider clients behind one small interface each (Deepgram; OpenAI-compatible chat) |
| `jobs/` | MongoDB-backed job queue, the processing pipeline, and a sweeper that recovers interrupted recordings |
| `realtime/` | WebSocket server (`/ws/live`, `/ws/events`), live session handler, cross-process event bus |
| `storage/` | Local staging during recording/processing, then GridFS for long-term audio storage |
| `middleware/` | Auth, validation, uploads, rate limits, central error handling |

**Frontend layout (`frontend/src`)**

| File / folder | Responsibility |
|---|---|
| `hooks/useRecorder` | Microphone, MediaRecorder, pause-aware timer, silence and low-volume detection, interruption handling |
| `hooks/useLiveTranscript` | Sequence-numbered chunk streaming, reconnect and resend, partial vs. final segments |
| `hooks/useRealtimeEvents` | Applies server push events to the React Query cache so every page updates live |
| `components/AudioVisuals` | Canvas waveform and level meter driven by `requestAnimationFrame` (no React re-render per frame) |
| `pages/` | Dashboard, Record, Recordings (history/search), Recording detail, Auth |

---

## AI flow

### While recording

1. `MediaRecorder` emits a WebM/Opus chunk every 250 ms. Each chunk is framed as `[flags][seq:u32][bytes]` and sent over `/ws/live`.
2. The gateway appends each chunk to storage in order and forwards it to a Deepgram streaming session (`interim_results`, `diarize`).
3. Results are split into speaker runs. Interim hypotheses are pushed as partials (grey italics in the UI). Final segments replace them and are saved in batches as `kind: 'live'` segments.
4. Streaming diarization needs time to learn the voices, so early on it tends to put everyone under one speaker. Every few seconds early on (6 s, 12 s, 20 s, 30 s…) and less often later (up to about 7 min), the gateway re-transcribes the audio recorded so far as a whole file in the background. If that finds more than one speaker, recent live lines are relabelled to match (the text stays as it was, labels are kept consistent with what is already on screen, and lines older than ~15 s are left alone so the screen does not keep changing) and the browser gets a `live_reset` with the corrected lines. Later live lines are mapped to the same labels. If it finds only one speaker, nothing changes.

### When the user stops

1. The client flushes remaining chunks and sends `stop{totalChunks}`. The server replies whether its copy is complete (no sequence gaps).
2. **Complete** → `POST /finalize` queues processing. **Incomplete** (chunks lost during a network drop) → the browser uploads its own full copy with `PUT /audio`, with a progress bar, which also queues processing.
3. A worker claims the job and runs the stages. Each stage's status is saved and pushed to the UI:

| Stage | What happens |
|---|---|
| Audio upload | Checks that the audio exists and isn't empty; moves it to GridFS |
| Speech-to-text | Pre-recorded transcription of the full file (more accurate than the live pass); flags low confidence |
| Speaker separation | Speakers come from Deepgram's per-word diarization (Speaker A, B…). If that finds only one speaker, three fallbacks run in order: a single-language Deepgram pass (nova-3's multilingual mode sometimes merges speakers), the live pass's speaker labels aligned by timestamp, and finally an LLM check that splits only clear dialogue (a question and its answer, greetings, short replies) when the replies are too short for any voice model. Fragments are then merged into speaker turns |
| Transcript generation | LLM cleanup in batches of 40 segments, run in parallel up to `LLM_CONCURRENCY`. A failed batch falls back to rule-based cleanup with a `PARTIAL_CLEANUP` warning |
| AI summary | Overview, topics, decisions, outcome. Long meetings are map-reduced (chunk notes, then a final summary) |
| Action items | Tasks with owner and due date, plus key decisions |
| Insights | Keywords and suggested title (never overwrites a title the user set) |

The last three stages only read the finished transcript, so they run in parallel and each is marked done as soon as it finishes.

4. **Failures**: retryable errors (timeouts, 5xx, 429, network) retry automatically with exponential backoff, starting **from the failed stage** so finished work is never repeated. After the last attempt, the recording is marked `failed` with a clear message, everything finished so far stays visible, and **Retry** resumes from the failed stage.
5. **Audio quality**: no speech → completed with a `NO_SPEECH` warning (analysis stages skipped). Average confidence below 0.6 → `LOW_CONFIDENCE` warning. While recording, the browser warns about silence and low volume.

---

## Database design

| Collection | Key fields | Indexes |
|---|---|---|
| `users` | name, email (unique, lowercase), passwordHash (bcrypt, never selected by default) | `email` unique |
| `refreshtokens` | user, tokenHash (SHA-256), family, expiresAt, revokedAt | `tokenHash` unique, `family`, TTL on `expiresAt` |
| `recordings` | user, title, source (live/upload), status, stage, `stages[]`, error, retryInfo, warnings, audio, durationSec, speakers, summary, actionItems, keyDecisions, keywords, `transcriptText`, stats | `{user, createdAt}`, `{user, status}`, `{status, lastActivityAt}`, weighted text index on title (10), keywords (6), summary (3), transcript (1) |
| `transcriptsegments` | recording, kind (`live`/`final`), idx, speaker, start, end, text, cleanText, confidence | `{recording, kind, idx}` unique |
| `jobs` | recording, status, fromStage, attempts, runAt, lockedBy, lockedUntil, lastError | `{status, runAt}`, `{status, lockedUntil}`, TTL on finished jobs (7 days) |
| GridFS (`audio.files` / `audio.chunks`) | Audio files keyed by a server-generated name | GridFS defaults |
| `realtime_events` | Capped collection used to relay progress events between processes | capped |

Design decisions:

- **Segments live in their own collection**, so long meetings never approach the 16 MB document limit and can be paged.
- `transcriptText` is a denormalized copy of the clean transcript used only for full-text search; it is excluded from list queries.
- **Speaker renaming** stores `label → name` on the recording. Segments keep the stable label, so a rename is one small update instead of rewriting every segment.
- **Search** uses a ranked `$text` query across title, keywords, summary and transcript, returns a snippet and the matched field, and falls back to a substring match so partial words ("auth") still find results.

---

## Scalability

How the design supports thousands of concurrent users:

- **Stateless API.** JWT auth means any instance can serve any request; run several instances behind a load balancer.
- **Separate workers.** Set `RUN_WORKER=false` on API nodes and run `npm run worker` replicas. Jobs are claimed atomically (`findOneAndUpdate` + lease with heartbeat), so two workers never take the same job, and a crashed worker's job is picked up when its lease expires. Scale workers on queue depth, independently of HTTP traffic. At higher volume, the queue can move to BullMQ/Redis or SQS behind the same `enqueueProcessing` interface.
- **Realtime fan-out.** `/ws/live` is a sticky connection to one instance for the length of a recording. Progress events from any process go through a capped MongoDB collection that every API instance tails, so no Redis is required; Redis pub/sub is a drop-in replacement at very high volume.
- **Live STT** streams straight to Deepgram; the server only relays bytes, so one node can carry many simultaneous recordings. The real ceiling is the provider's concurrency limit.
- **Storage.** Audio is kept in GridFS today. For large scale, move it to S3/GCS with pre-signed uploads so the API never carries large files.
- **Database.** MongoDB Atlas with replicas; shard `transcriptsegments` by `recording`. Atlas Search or Elasticsearch for heavier search needs.
- **API performance.** Compound indexes cover every list and search query, projections leave out large fields, and routes are rate limited.
- **Worker throughput.** `WORKER_CONCURRENCY` recordings per worker; inside a recording, independent AI calls run in parallel, capped by `LLM_CONCURRENCY` to stay under provider rate limits.

---

## Security

- **Passwords**: bcrypt (cost 12). Login takes the same time for unknown emails and wrong passwords and returns the same message, so it doesn't reveal which emails exist. Password rules are enforced on the server.
- **Tokens**: short-lived JWT access token (15 min) kept **in memory only** on the client, never in localStorage. Opaque refresh token in an `httpOnly`, `SameSite` cookie scoped to `/api/auth`, stored hashed and **rotated on every use**. Reusing a rotated token revokes the whole session family. Logout revokes the token on the server.
- **CSRF**: cookie-authenticated endpoints (`/refresh`, `/logout`) require an `X-Requested-With` header, which can't be sent cross-site without passing CORS.
- **Authorization**: every recording query is scoped to the signed-in user, so other users' data returns "not found". Malformed IDs return 404.
- **CORS and origins**: one origin check is shared by the REST API and WebSockets. Production allows only the `CLIENT_ORIGIN` list; development additionally allows `localhost` / `127.0.0.1` on any port.
- **WebSockets**: the token is verified during the HTTP upgrade (unauthenticated sockets are never opened), `Origin` is checked against the allow-list above, frames are size-capped, and a ping/pong heartbeat removes dead connections.
- **Input validation**: the browser validates forms before sending (fewer pointless requests, instant feedback); the server validates every input again with zod and is always the authority.
- **Uploaded audio**: streamed to disk (never fully buffered in memory), size-limited, MIME type and extension allow-listed, stored under server-generated keys, and served only through a **short-lived, recording-scoped signed media token** with `Cache-Control: private`. Deleting a recording deletes its audio, segments and jobs.
- **Hardening**: helmet headers, strict CORS, zod validation on every input, JSON body limits, rate limiting on auth, uploads and the API, central error handling that never leaks stack traces, and startup validation of all secrets.

---

## Error handling

| Scenario | Behaviour |
|---|---|
| Invalid form input (empty fields, bad email, weak password, empty title, reversed date range) | Message next to the field, focus moves to it, and no request is sent |
| Microphone permission denied / not found / busy | Specific message with how to fix it |
| Unsupported browser or insecure context | Recording disabled with an explanation and an upload alternative |
| Microphone unplugged or recorder error mid-meeting | Recording stops cleanly; captured audio is kept and submitted |
| Network drop while recording | Recording continues locally; the socket reconnects and resends missing chunks; if chunks are still missing, the full file is uploaded on stop |
| Upload fails after recording | Overlay with **Retry** and **Download audio**, so nothing is lost |
| Tab closed or crash mid-recording | A sweeper processes whatever audio reached the server, with an `INTERRUPTED` warning |
| Large files | Size limits on client and server, upload progress, cancel option |
| Expired access token | Refreshed silently (single-flight); if refresh fails, "session expired" message and redirect to login |
| AI provider unavailable / timeout / rate limit | Automatic retries with backoff from the failed stage, then a clear error and manual Retry |
| Partial transcript cleanup failure | Rule-based fallback plus a warning banner |
| Summary generation failure | Transcript stays available; Retry resumes at the summary stage |
| Silent or poor-quality audio | Live warnings while recording; `NO_SPEECH` / `LOW_CONFIDENCE` warnings after processing |

---

## Performance

- Waveform and level meter draw on canvas inside `requestAnimationFrame`, with no React state updates per frame.
- Final live segments are batched into one state update per animation frame; transcript blocks are memoized and only the block being played re-renders during playback.
- Long transcripts use CSS `content-visibility: auto`, so off-screen blocks skip layout and paint.
- Recorded audio is kept as 250 ms `Blob`s and read lazily when streamed.
- All AI work runs in background jobs; uploads stream to disk; audio playback supports HTTP Range requests for instant seeking.

---

## Testing

- **End-to-end API checks** (`backend/scripts/e2e.mjs`, run with `npm run test:e2e` while the API is running) cover registration and login, token refresh and logout, protected routes, uploads, the live WebSocket protocol (streaming, acknowledgements, reconnect and resume, gap detection and fallback upload), search and filters, speaker and title renaming, signed audio streaming, silent and empty audio, and user isolation. They call the configured AI providers, so they use a small amount of API credit.
- **Linting**: `npm run lint` in both projects.
- **Browser testing** of the full flow in Chrome (register, upload, live recording with pause/resume, results, speaker renaming, search, logout), including the phone-width layout.
- **Validation checks** in Chrome with the API mocked, confirming that invalid login, register and search input shows the right message and sends no request.

---

## Evaluation guide

### Suggested walkthrough (about 10 minutes)

1. **Auth**: submit the empty form and then a weak password to see field-level validation (no request is sent; check the browser's Network tab), then register with valid details. Reload the page: the session survives. Log out and back in.
2. **Live recording**: open *New recording*, allow the microphone, and speak (two people if possible). Watch the timer, waveform, level meter, live transcript (partials becoming final text), active speaker and session status. Pause (timer stops), resume, then stop.
3. **Automatic processing**: you're taken to the meeting page, where the seven stages tick off live. No button needs to be pressed.
4. **Results**: review the summary, key decisions, action items (tick one off and reload), keywords and suggested title. Open *Transcript*, switch Clean/Original, rename speakers, search inside the transcript, and click a timestamp to play from that point.
5. **Upload**: upload an existing audio file from the dashboard and follow its progress.
6. **History and search**: on *Recordings*, search for a word from a transcript, filter by date, and delete a meeting. Try `Ctrl K` from any page.
7. **Failure handling**: block the microphone permission and try to record; turn the network off mid-recording and back on; record a few seconds of silence.

### How each criterion is addressed

| Criterion | Where to look |
|---|---|
| Software architecture | Modular backend (`modules/`, `ai/`, `jobs/`, `realtime/`, `storage/`); hooks-based frontend; see [Architecture](#architecture) |
| Backend design | Routes → service → model layering, zod validation, central `AppError` handling, MongoDB job queue with leases and retries (`jobs/queue.js`, `jobs/pipeline.js`) |
| Frontend user experience | Record page, live processing stepper, skeleton screens, toasts, responsive and keyboard-accessible layout |
| Authentication and security | `modules/auth/*`, `middleware/auth.js`, signed media tokens, see [Security](#security) |
| AI integration | `ai/stt/deepgram.js` (streaming + pre-recorded with diarization), `ai/llm/client.js` (OpenAI-compatible, rate-limit aware), prompts in `ai/llm/prompts.js` |
| Real-time communication | `/ws/live` binary protocol (`realtime/liveHandler.js`, `hooks/useLiveTranscript.js`) and `/ws/events` progress push (`hooks/useRealtimeEvents.js`) |
| Error handling | See [Error handling](#error-handling); stage-level retry, fallback upload, sweeper for interrupted recordings, browser-side form validation |
| Code quality | Small focused modules, consistent naming, ESLint in both projects, shared validation rules (`src/lib/validation.js`) mirrored by zod schemas on the server |
| Database design | See [Database design](#database-design); segments collection, text index, TTL indexes |
| Performance | Canvas visualizations, batched live updates, memoized transcript blocks, background jobs, Range streaming |
| Scalability thinking | See [Scalability](#scalability); stateless API, independent workers, cross-process event relay |
| Documentation | This README |

---

## Assumptions and limitations

- Live transcription streams WebM/Opus, which Chrome, Edge and Firefox produce. Safari records MP4/AAC, so live captions may not work there, but the transcript after recording still does.
- Languages: with `STT_LANGUAGE=multi`, Deepgram's nova-3 handles English and Hindi (and also Spanish, French, German, Italian, Portuguese, Dutch, Russian and Japanese), including switching mid-sentence. Other languages, such as Urdu or Tamil, aren't supported.
- Meeting-tab recording needs Chrome or Edge on desktop with "Also share tab audio" turned on. Firefox and Safari can't share tab audio, and phones can't share tabs, so there the app records the microphone only.
- Speaker labels come from Deepgram's diarization. Live and final labels can differ; the final transcript is authoritative. Very short replies (a word or two) can't be told apart by voice; for those the final transcript falls back to a text-based check that only splits clear dialogue.
- The embedded MongoDB (`USE_IN_MEMORY_DB=true`) is for local development only and doesn't support a separate worker process; use a real `MONGODB_URI` in production.
- Action items are matched by position, so reprocessing a recording generates a fresh list and clears ticks.
- AI output quality depends on the chosen LLM. Free Gemini tiers have daily request limits; when a quota is exhausted, the app reports it instead of retrying forever.
- MediaRecorder WebM files have no duration header; the player works around this so seeking works.

---

## API reference

| Method and path | Description |
|---|---|
| `POST /api/auth/register` · `/login` · `/refresh` · `/logout` · `GET /api/auth/me` | Authentication |
| `GET /api/recordings?q&from&to&status&page&limit` | History and search |
| `GET /api/recordings/stats` | Dashboard stats |
| `POST /api/recordings` | Start a live recording session |
| `POST /api/recordings/upload` | Upload an audio file (multipart field `audio`) |
| `POST /api/recordings/:id/finalize` | Finish a live recording and start processing |
| `PUT /api/recordings/:id/audio` | Upload or replace audio (fallback after network loss) |
| `GET /api/recordings/:id` · `/transcript?kind=final\|live` | Details and transcript |
| `PATCH /api/recordings/:id` · `/speakers` | Rename the meeting or its speakers |
| `PATCH /api/recordings/:id/action-items/:index` | Tick or untick an action item (`{ done }`) |
| `POST /api/recordings/:id/retry` | Retry from the failed stage |
| `GET /api/recordings/:id/media-url` → `GET /api/media/:id?token=` | Signed audio playback |
| `DELETE /api/recordings/:id` | Delete a recording, its audio and transcript |
| `WS /ws/live?recordingId&token` · `WS /ws/events?token` | Live audio and transcript · progress events |

---

<p align="center">Built by Huzaifa Farooq</p>
