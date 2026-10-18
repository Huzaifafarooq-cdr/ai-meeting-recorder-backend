# AI Meeting Recorder - Backend

Backend for the AI Meeting Recorder & Smart Notes Portal. Users record meetings in the browser, see a live transcript with speaker detection, and once the recording stops they get a cleaned transcript, summary, key decisions, action items, keywords and a suggested title.

This repo has the REST API, the WebSocket gateway for live transcription and the background worker that runs the AI pipeline. The React frontend is in a separate repo.

**Stack:** Node.js, Express, MongoDB (Mongoose), `ws` for WebSockets, Deepgram for speech-to-text, Google Gemini as the LLM (through its OpenAI-compatible API).

---

## Running locally

Requires Node.js 20.10 or newer.

```bash
npm install
cp .env.example .env   # then fill in the keys (see below)
npm run dev            # API + worker on http://localhost:5000
```

| Script | What it does |
|---|---|
| `npm run dev` | Starts the API with the worker running in the same process, restarts on file changes |
| `npm start` | Same, without watch mode |
| `npm run worker` | Runs a standalone worker (needs a shared MongoDB, set `RUN_WORKER=false` on the API) |
| `npm run test:e2e` | End-to-end tests against a running server (see [Testing](#testing)) |
| `npm run lint` | ESLint |

### Environment variables

Everything is configured in `.env`. The server validates it on startup and exits with a clear message if something required is missing.

| Variable | Notes |
|---|---|
| `JWT_ACCESS_SECRET`, `JWT_MEDIA_SECRET` | Required, at least 32 characters each |
| `DEEPGRAM_API_KEY` | Required. Used for live and pre-recorded transcription with speaker diarization |
| `LLM_API_KEY` | Required. Google AI Studio (Gemini) API key |
| `LLM_BASE_URL`, `LLM_MODEL` | Default to Gemini (`gemini-flash-lite-latest`). Point them at any OpenAI-compatible API (OpenAI, Groq, Azure) to switch providers |
| `MONGODB_URI` | MongoDB connection string (Atlas in production) |
| `USE_IN_MEMORY_DB` | `true` starts an embedded MongoDB for local dev, so nothing needs installing. Use `false` in production |
| `CLIENT_ORIGIN` | Frontend URL(s), comma separated. Used for CORS and the WebSocket origin check |
| `COOKIE_SAMESITE` | `lax` if frontend and API share a site, `none` (HTTPS only) if they are on different domains |
| `KEEP_ALIVE_URL` | Optional. The server pings its own `/api/health` every 10 minutes so free hosting doesn't put it to sleep. On Render it uses `RENDER_EXTERNAL_URL` automatically |
| `RUN_WORKER`, `WORKER_CONCURRENCY`, `LLM_CONCURRENCY`, `JOB_MAX_ATTEMPTS`, `AI_TIMEOUT_MS` | Worker and AI tuning, defaults are fine |

---

## Architecture

```
 Browser (React)                        Backend (this repo)                       External
┌──────────────────────┐   REST /api   ┌───────────────────────────────┐
│ auth, dashboard,     │ ────────────► │ Express API                   │
│ history, search      │               │  auth · recordings · media    │
│                      │  WS /ws/live  │                               │   wss   ┌───────────┐
│ recorder             │ ◄───────────► │ live gateway ── STT stream ───┼───────► │ Deepgram  │
│ (MediaRecorder)      │ audio chunks  │  (saves audio + segments)     │         └───────────┘
│                      │ ← transcripts │                               │
│                      │ WS /ws/events │ event bus ─► progress push    │  https  ┌───────────┐
│ live progress        │ ◄──────────── │                               │ ──────► │ Gemini    │
└──────────────────────┘               │ job queue (MongoDB)           │         └───────────┘
                                       │  └► worker: 7-stage pipeline  │
                                       └──────────────┬────────────────┘
                                                      │
                                           ┌──────────▼──────────┐
                                           │ MongoDB             │
                                           │ data + audio GridFS │
                                           └─────────────────────┘
```

### Folder structure

```
src/
├── modules/      auth, recordings, media (routes → service → models), input validated with zod
├── ai/stt/       Deepgram client (streaming + pre-recorded)
├── ai/llm/       LLM client (Gemini via OpenAI-compatible API) and prompts
├── jobs/         job queue, processing pipeline, sweeper for interrupted recordings, worker entry
├── realtime/     WebSocket server, live recording handler, event bus
├── models/       Mongoose schemas
├── storage/      audio storage (MongoDB GridFS, local disk only as a working copy)
├── middleware/   auth, validation, uploads, rate limits, error handler
├── config/       env validation, DB connection
└── lib/          shared helpers
scripts/e2e.mjs   end-to-end test script
```

### Why these choices

- **Express + Mongoose:** simple and well known. Transcripts and AI output fit a document model well.
- **Plain WebSockets (`ws`) instead of Socket.IO:** the live recorder sends small binary audio frames several times a second and has its own resume logic based on chunk sequence numbers. Plain WebSockets carry those frames without an extra protocol layer, and the browser's built-in `WebSocket` is enough on the client.
- **Deepgram:** streaming transcription and speaker diarization in one API, with good accuracy and low latency.
- **Gemini for the LLM:** called through Google's OpenAI-compatible endpoint, which most LLM providers support. Switching to OpenAI, Groq or another provider only needs different `LLM_*` env values, no code changes.
- **Job queue in MongoDB:** avoids adding Redis for now. The queue sits behind one function (`enqueueProcessing`), so it can be swapped for BullMQ or SQS later.

---

## AI flow

### During recording

1. The browser's `MediaRecorder` produces a WebM/Opus chunk every 250 ms. Each chunk is sent over `/ws/live` as `[flags][seq:u32][audio bytes]`.
2. The server appends every chunk to the recording's audio file and forwards it to a Deepgram streaming session (interim results + diarization on).
3. Deepgram results are split into turns by speaker. Interim results go to the client as partials, final results replace them and are saved as `live` transcript segments.
4. If the connection drops, the client reconnects and the server tells it which sequence number to resume from.

### When the user stops

1. The client sends `stop` with the total chunk count. The server replies whether its copy of the audio is complete (no missing chunks).
2. If it's complete, the client calls `POST /finalize`. If chunks were lost, the client uploads its own full copy with `PUT /audio`. Both start processing automatically, the user never triggers transcription manually.
3. A worker picks up the job and runs these stages. Each stage's status is saved and pushed to the browser over `/ws/events`, so the user always sees the current stage.

| Stage | What happens |
|---|---|
| Audio upload | Checks the audio exists in storage (MongoDB GridFS) and isn't empty |
| Speech-to-text | Full-file transcription with Deepgram (more accurate than the live pass), flags low confidence |
| Speaker separation | Labels speakers (Speaker A, B, ...) and merges consecutive fragments into turns |
| Transcript generation | LLM cleanup in batches: removes filler words, fixes punctuation and capitalization. If a batch fails, a rule-based cleanup is used instead and a warning is added |
| AI summary | Overview, topics, decisions, outcome |
| Action items | Tasks with owner and due date where mentioned, plus key decisions |
| Insights | Keywords and a suggested title (doesn't replace a title the user set) |

The last three stages only need the finished transcript, so they run in parallel. Long meetings are condensed in chunks first, and the condensed notes are shared by those three stages.

### Failures and audio quality

- Timeouts, 5xx errors, rate limits and network errors are retried automatically with backoff, starting from the stage that failed. Earlier stages are not redone.
- When the provider rate limits, the client waits as long as the provider asks. If a daily quota is used up, the error says so instead of retrying pointlessly.
- After the last attempt the recording is marked `failed` with a readable message, whatever finished (e.g. the transcript) stays available, and the user can retry from the failed stage.
- No speech detected: the recording completes with a `NO_SPEECH` warning and the analysis stages are skipped. Average confidence below 0.6 adds a `LOW_CONFIDENCE` warning. Empty files fail with `AUDIO_EMPTY`.
- If the browser closes or crashes mid-recording, a sweeper processes whatever audio reached the server and adds an `INTERRUPTED` warning.

---

## Database design

| Collection | Main fields | Indexes |
|---|---|---|
| `users` | name, email (unique, lowercase), passwordHash (bcrypt, not selected by default) | `email` unique |
| `refreshtokens` | user, tokenHash (SHA-256), family, expiresAt, revokedAt | `tokenHash` unique, `family`, TTL on `expiresAt` |
| `recordings` | user, title, source (live/upload), status, current stage, `stages[]`, error, warnings, audio info, duration, speakers `[{label, name}]`, summary, actionItems, keyDecisions, keywords, transcriptText, stats | `{user, createdAt}`, `{user, status}`, `{status, lastActivityAt}`, weighted text index on title, keywords, summary, transcript |
| `transcriptsegments` | recording, kind (`live` / `final`), idx, speaker, start, end, text, cleanText, confidence | `{recording, kind, idx}` unique |
| `jobs` | recording, status, fromStage, attempts, runAt, lockedBy, lockedUntil, lastError | `{status, runAt}`, `{status, lockedUntil}`, TTL on finished jobs (7 days) |

- **Transcript segments are a separate collection**, so long meetings never get near MongoDB's 16 MB document limit and segments can be paged.
- `transcriptText` is a copy of the clean transcript used only for full-text search. It's excluded from list queries.
- **Speaker renaming** stores `label → name` on the recording. Segments keep the original label, so renaming is one small update rather than rewriting every segment.
- **Search** uses a weighted `$text` search across title, keywords, summary and transcript, and falls back to a substring match so partial words like "auth" still work. History can be filtered by date range and status, with pagination.
- **Audio files** are stored in GridFS (`audio.files` / `audio.chunks`), keyed by `audio/<userId>/<recordingId>.<ext>`. This keeps everything in one Atlas database, so recordings survive restarts and redeploys even on hosts without a persistent disk. Local disk is only used while recording and processing: live chunks are appended to a local file, the file is copied into GridFS when processing is queued, and the local copy is deleted after processing. A worker that doesn't have the file locally (after a restart, or on another machine) downloads it from GridFS first. Playback streams straight from GridFS with HTTP Range support, so seeking works.

---

## Scalability

How this would scale to thousands of concurrent users:

- **Stateless API:** auth is JWT based, so any instance can serve any request. Run several instances behind a load balancer.
- **Workers scale separately:** set `RUN_WORKER=false` on the API and run as many `npm run worker` processes as needed. Workers claim jobs atomically (`findOneAndUpdate` with a lease that gets extended while the job runs), so two workers never take the same job, and a crashed worker's job is picked up again once its lease expires. On shutdown, workers hand unfinished jobs back right away. Audio is copied to GridFS before a job is queued, so workers don't need to share a disk with the API.
- **Realtime across instances:** a live recording stays on one instance for its duration (sticky WebSocket). Progress events from standalone workers are written to a small capped MongoDB collection that every API instance tails and forwards to its own sockets. No Redis needed at this size, and the event bus could move to Redis pub/sub later without touching the rest.
- **Live transcription:** the server only relays audio bytes to Deepgram, so one instance can handle many recordings at once. The real limit is the provider's concurrency limit.
- **Audio storage:** GridFS is simple and works on any host, but at large scale audio shouldn't share the database. The next step is S3/GCS with direct browser uploads via pre-signed URLs, so large files don't go through the API at all. Only the `storage/` module would change, and playback already uses short-lived signed URLs in the same way.
- **Database:** MongoDB Atlas with replicas. `transcriptsegments` could be sharded by recording. For heavier search, Atlas Search or Elasticsearch.
- **AI throughput:** `WORKER_CONCURRENCY` recordings per worker, and AI calls inside a recording run in parallel up to `LLM_CONCURRENCY` to stay under provider rate limits. AI work never runs inside a request.

---

## Security

- **Passwords:** bcrypt with cost 12. Login takes the same time and returns the same error for unknown emails and wrong passwords, so it doesn't reveal which emails are registered.
- **Tokens:** short-lived JWT access token (15 min) that the frontend keeps in memory only. The refresh token is an opaque random value in an `httpOnly` `SameSite` cookie scoped to `/api/auth`, stored hashed in the DB and rotated on every use. Reusing an old refresh token revokes the whole session (token theft detection). Logout revokes it on the server.
- **CSRF:** the cookie endpoints (`/refresh`, `/logout`) require an `X-Requested-With` header, which a browser can't send cross-site without CORS allowing it. Everything else uses Bearer tokens.
- **Authorization:** every recording query is filtered by the logged-in user, so another user's recording returns 404, not 403. Invalid IDs also return 404.
- **WebSockets:** the token is checked during the HTTP upgrade, so unauthenticated sockets are never opened. The `Origin` header is checked, frames are limited to 4 MB, and a heartbeat closes dead connections.
- **Uploaded audio:**
  - streamed to disk and then into GridFS, never held in memory
  - size limit plus allowed MIME types and extensions
  - stored under server-generated paths, user input never becomes part of a file path
  - served only with a short-lived token scoped to that one recording (an `<audio>` tag can't send auth headers)
  - deleting a recording removes its audio, segments and jobs
- **General:** helmet headers, strict CORS, zod validation on all input, JSON body size limit, rate limits on auth (30 per 15 min), uploads (60 per hour) and the API, and a central error handler that never leaks stack traces. Secrets live only in environment variables.

---

## API

| Method & path | Description |
|---|---|
| `POST /api/auth/register`, `/login`, `/refresh`, `/logout`, `GET /api/auth/me` | Authentication |
| `GET /api/recordings?q&from&to&status&page&limit` | History, search and filters |
| `GET /api/recordings/stats` | Dashboard stats |
| `POST /api/recordings` | Start a live recording |
| `POST /api/recordings/upload` | Upload an audio file (multipart field `audio`) |
| `POST /api/recordings/:id/finalize` | Finish a live recording and start processing |
| `PUT /api/recordings/:id/audio` | Upload the full audio (fallback after lost chunks) |
| `GET /api/recordings/:id`, `/transcript?kind=final\|live` | Recording details and transcript |
| `PATCH /api/recordings/:id`, `/speakers` | Rename the meeting or speakers |
| `PATCH /api/recordings/:id/action-items/:index` | Mark an action item done / not done |
| `POST /api/recordings/:id/retry` | Retry from the failed stage |
| `GET /api/recordings/:id/media-url` then `GET /api/media/:id?token=` | Audio playback |
| `DELETE /api/recordings/:id` | Delete a recording with its audio and transcript |
| `GET /api/health` | Health check (DB status) |
| `WS /ws/live?recordingId&token` | Live audio in, transcript out |
| `WS /ws/events?token` | Processing progress events |

---

## Testing

`scripts/e2e.mjs` runs 59 end-to-end checks against a running server with the real Deepgram and Gemini keys:

```bash
npm run dev                                   # in one terminal
npm run test:e2e                              # in another (BASE=http://localhost:5000 by default)
```

It covers registration and login, token refresh and CSRF, upload validation, processing, playback with Range requests, search and filters, the live WebSocket (acks, reconnect and resume, lost chunks), empty audio, retries, and that users can't see or delete each other's recordings. It creates its own test users, so run it against a test database rather than production.

---

## Where to look (evaluation criteria)

| Criterion | Main places in the code |
|---|---|
| Architecture / backend design | `src/modules/*` (routes → service → model), `src/app.js`, `src/server.js` |
| Authentication & security | `src/modules/auth/`, `src/middleware/auth.js`, `src/middleware/rateLimiters.js`, `src/modules/media/` |
| AI integration | `src/ai/stt/deepgram.js`, `src/ai/llm/client.js`, `src/ai/llm/prompts.js`, `src/jobs/pipeline.js` |
| Real-time communication | `src/realtime/wsServer.js`, `src/realtime/liveHandler.js`, `src/realtime/eventBus.js` |
| Error handling | `src/lib/AppError.js`, `src/middleware/errorHandler.js`, `src/lib/http.js` (provider errors, retry delays), `src/jobs/queue.js` (retries) |
| Database design | `src/models/` |
| Performance & scalability | `src/jobs/` (queue, leases, worker), `src/lib/concurrency.js`, `src/storage/index.js` |

---

## Assumptions and limitations

- Live transcription expects WebM/Opus audio, which Chrome, Edge and Firefox produce. Safari records MP4/AAC, so live captions may not work there, but the transcript after processing does.
- Audio is stored in MongoDB GridFS. The free Atlas tier has 512 MB, enough for roughly 15 hours of recorded meetings. For real production use, audio would move to S3 (see Scalability).
- A live recording only exists on the server's local disk until it is stopped. If the server restarts in the middle of a recording, the client's own copy is uploaded instead when the user stops.
- The backend is hosted on Render's free tier, which sleeps after 15 minutes without traffic. The server pings itself every 10 minutes to stay awake, which fits within Render's 750 free hours per month for one service.
- The embedded MongoDB is for local development only and can't be shared with a standalone worker.
- Live and final speaker labels can differ, since the final transcript is a separate, more accurate pass. The final one is what's kept.
- Action items are stored by position, so reprocessing a recording creates a new list and resets their done state.
- Gemini's free tier has low rate limits. The app handles rate limiting, but many meetings at once will be slower on a free key.
