const BASE = process.env.BASE ?? 'http://localhost:5000';
const WS_BASE = BASE.replace(/^http/, 'ws');
let pass = 0;
let fail = 0;
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
  }
}

let cookie = '';
let token = '';
async function req(path, { method = 'GET', body, headers = {}, auth = true, raw = false } = {}) {
  const h = { ...headers };
  if (auth && token) h.Authorization = `Bearer ${token}`;
  if (cookie) h.Cookie = cookie;
  let payload = body;
  if (body && !(body instanceof FormData)) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const sc = res.headers.getSetCookie?.() ?? [];
  for (const c of sc) if (c.startsWith('rt=')) cookie = c.split(';')[0];
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function wav(seconds, freq = 440) {
  const rate = 8000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), 44 + i * 2);
  return buf;
}

async function waitFor(id, statuses, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let rec;
  while (Date.now() < deadline) {
    ({ data: { recording: rec } = {} } = await req(`/api/recordings/${id}`));
    if (rec && statuses.includes(rec.status)) return rec;
    await sleep(700);
  }
  return rec;
}

function frame(seq, payload, replay = false) {
  const out = Buffer.alloc(5 + payload.length);
  out[0] = replay ? 1 : 0;
  out.writeUInt32BE(seq, 1);
  payload.copy(out, 5);
  return out;
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const msgs = [];
    const waiters = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      msgs.push(m);
      waiters.splice(0).forEach((w) => w());
    };
    ws.waitFor = async (pred, ms = 10000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const hit = msgs.find(pred);
        if (hit) return hit;
        await new Promise((r) => {
          waiters.push(r);
          setTimeout(r, 200);
        });
      }
      return null;
    };
    ws.msgs = msgs;
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error(`ws error ${e.message ?? ''}`));
  });
}

const email = `e2e_${Date.now()}@example.com`;
const password = 'secret123';

console.log('\n# Health');
{
  const r = await req('/api/health', { auth: false });
  check('health ok', r.status === 200 && r.data.db === 'connected', r);
}

console.log('\n# Auth');
{
  let r = await req('/api/auth/register', { method: 'POST', body: { name: 'E2E User', email, password: 'short' }, auth: false });
  check('register rejects weak password (400 + field details)', r.status === 400 && r.data.error.details?.[0]?.field === 'password', r);
  r = await req('/api/auth/register', { method: 'POST', body: { name: 'E2E User', email, password }, auth: false });
  check('register 201 + access token + refresh cookie', r.status === 201 && r.data.accessToken && cookie.startsWith('rt='), r);
  r = await req('/api/auth/register', { method: 'POST', body: { name: 'E2E User', email, password }, auth: false });
  check('duplicate email 409', r.status === 409 && r.data.error.code === 'EMAIL_IN_USE', r);
  r = await req('/api/auth/login', { method: 'POST', body: { email, password: 'wrongpass1' }, auth: false });
  check('wrong password 401 generic message', r.status === 401 && r.data.error.code === 'INVALID_CREDENTIALS', r);
  r = await req('/api/auth/login', { method: 'POST', body: { email: email.toUpperCase(), password }, auth: false });
  check('login (case-insensitive email)', r.status === 200 && r.data.accessToken, r);
  token = r.data.accessToken;
  r = await req('/api/auth/me');
  check('GET /me', r.status === 200 && r.data.user.email === email, r);
  r = await req('/api/recordings', { auth: false });
  check('protected API without token 401', r.status === 401 && r.data.error.code === 'AUTH_REQUIRED', r);
  r = await req('/api/recordings', { headers: { Authorization: 'Bearer garbage' }, auth: false });
  check('protected API invalid token 401', r.status === 401 && r.data.error.code === 'INVALID_TOKEN', r);
  r = await req('/api/auth/refresh', { method: 'POST', auth: false });
  check('refresh without CSRF header 403', r.status === 403, r);
  const oldCookie = cookie;
  r = await req('/api/auth/refresh', { method: 'POST', auth: false, headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  check('refresh rotates token', r.status === 200 && r.data.accessToken && cookie !== oldCookie, r);
  token = r.data.accessToken;
}

console.log('\n# Upload pipeline');
let uploadId;
{
  const bad = new FormData();
  bad.append('audio', new Blob([Buffer.from('hello world, not audio'.repeat(100))], { type: 'text/plain' }), 'notes.txt');
  let r = await req('/api/recordings/upload', { method: 'POST', body: bad });
  check('upload rejects non-audio (415)', r.status === 415 && r.data.error.code === 'UNSUPPORTED_FORMAT', r);

  r = await req('/api/recordings/upload', { method: 'POST', body: new FormData() });
  check('upload without file 400', r.status === 400 && r.data.error.code === 'NO_FILE', r);

  const fd = new FormData();
  fd.append('audio', new Blob([wav(40)], { type: 'audio/wav' }), 'Weekly_sync-call.wav');
  r = await req('/api/recordings/upload', { method: 'POST', body: fd });
  check('upload 201 queued', r.status === 201 && ['queued', 'processing'].includes(r.data.recording.status), r);
  uploadId = r.data.recording?.id;
  check('title from filename', r.data.recording?.title === 'Weekly sync call', r.data.recording?.title);

  const rec = await waitFor(uploadId, ['completed', 'failed']);
  check('upload processed to completed', rec?.status === 'completed', rec);
  check('no speech warning', rec?.warnings?.some((w) => w.code === 'NO_SPEECH'), rec?.warnings);
  check('duration detected', rec?.durationSec >= 35, rec?.durationSec);

  r = await req(`/api/recordings/${uploadId}/action-items/400`, { method: 'PATCH', body: { done: true } });
  check('unknown action item → 404', r.status === 404, r);
  r = await req(`/api/recordings/${uploadId}/action-items/0`, { method: 'PATCH', body: { done: 'yes' } });
  check('invalid action item body → 400', r.status === 400, r);

  r = await req(`/api/recordings/${uploadId}`, { method: 'PATCH', body: { title: 'CRM Authentication Planning' } });
  check('rename title', r.status === 200 && r.data.recording.title === 'CRM Authentication Planning' && r.data.recording.titleSource === 'user', r);
  r = await req(`/api/recordings/${uploadId}`, { method: 'PATCH', body: { title: '  ' } });
  check('empty title rejected', r.status === 400, r);

  r = await req(`/api/recordings/${uploadId}/media-url`);
  check('media url issued', r.status === 200 && r.data.url.includes('token='), r);
  const mediaRes = await req(r.data.url, { raw: true, auth: false, headers: { Range: 'bytes=0-99' } });
  check('audio streams with Range (206)', mediaRes.status === 206 && (await mediaRes.arrayBuffer()).byteLength === 100, mediaRes.status);
  const badMedia = await req(`/api/media/${uploadId}?token=nope`, { raw: true, auth: false });
  check('media rejects bad token', badMedia.status === 401, badMedia.status);
}

console.log('\n# Search & filters');
{
  let r = await req('/api/recordings', { auth: true });
  check('list recordings', r.status === 200 && r.data.total >= 1, r);
  for (const q of ['authentication', 'CRM', 'auth', 'Planning']) {
    r = await req(`/api/recordings?q=${encodeURIComponent(q)}`);
    check(`search "${q}" finds the meeting`, r.data.items?.some((i) => i.id === uploadId), r.data);
  }
  r = await req(`/api/recordings?q=zzzxqq`);
  check('search no match returns 0', r.data.total === 0, r.data);
  const today = new Date();
  const from = new Date(today.getTime() - 86400000).toISOString();
  const future = new Date(today.getTime() + 2 * 86400000).toISOString();
  r = await req(`/api/recordings?from=${from}`);
  check('date filter includes today', r.data.items.some((i) => i.id === uploadId), r.data.total);
  r = await req(`/api/recordings?from=${future}`);
  check('date filter excludes future range', r.data.total === 0, r.data.total);
  r = await req('/api/recordings?status=completed');
  check('status filter', r.data.items.every((i) => i.status === 'completed'), r.data);
  r = await req('/api/recordings/stats');
  check('stats', r.status === 200 && r.data.total >= 1, r.data);
}

console.log('\n# Live recording over WebSocket');
let liveId;
{
  let r = await req('/api/recordings', { method: 'POST', body: { mimeType: 'audio/webm;codecs=opus' } });
  check('create live recording', r.status === 201 && r.data.recording.status === 'recording', r);
  liveId = r.data.recording.id;

  const events = await openWs(`${WS_BASE}/ws/events?token=${token}`);
  check('events socket hello', Boolean(await events.waitFor((m) => m.type === 'hello')));

  const ws = await openWs(`${WS_BASE}/ws/live?recordingId=${liveId}&token=${token}`);
  const ready = await ws.waitFor((m) => m.type === 'ready');
  check('live socket ready', ready?.resumeFromSeq === 0, ready);

  let seq = 0;
  for (; seq < 16; seq++) {
    ws.send(frame(seq, Buffer.alloc(2000, seq % 256)));
    await sleep(50);
  }
  check('received acks', Boolean(await ws.waitFor((m) => m.type === 'ack')));

  ws.send(JSON.stringify({ type: 'stop', totalChunks: seq }));
  const stopped = await ws.waitFor((m) => m.type === 'stopped');
  check('stop → server confirms complete audio', stopped?.complete === true && stopped.receivedChunks === seq, stopped);

  r = await req(`/api/recordings/${liveId}/finalize`, { method: 'POST', body: { durationSec: 7.5, totalChunks: seq } });
  check('finalize auto-starts processing', r.status === 200 && ['queued', 'processing'].includes(r.data.recording.status), r);
  r = await req(`/api/recordings/${liveId}/finalize`, { method: 'POST', body: { durationSec: 7.5, totalChunks: seq } });
  check('double finalize rejected 409', r.status === 409, r);

  const stageEvents = await events.waitFor((m) => m.type === 'recording.updated' && m.recording.id === liveId && m.recording.status === 'processing', 8000);
  check('realtime progress events pushed', Boolean(stageEvents));
  events.close();
}

console.log('\n# Network interruption: reconnect + resume');
{
  let r = await req('/api/recordings', { method: 'POST', body: { mimeType: 'audio/webm' } });
  const id = r.data.recording.id;
  let ws = await openWs(`${WS_BASE}/ws/live?recordingId=${id}&token=${token}`);
  await ws.waitFor((m) => m.type === 'ready');
  for (let seq = 0; seq < 10; seq++) ws.send(frame(seq, Buffer.alloc(1500, 1)));
  await sleep(400);
  ws.close();
  await sleep(600);
  ws = await openWs(`${WS_BASE}/ws/live?recordingId=${id}&token=${token}`);
  const ready = await ws.waitFor((m) => m.type === 'ready');
  check('reconnect resumes at next seq', ready?.resumeFromSeq === 10, ready);
  ws.send(frame(0, Buffer.alloc(1500, 1), true));
  for (let seq = 10; seq < 20; seq++) ws.send(frame(seq, Buffer.alloc(1500, 2)));
  ws.send(JSON.stringify({ type: 'stop', totalChunks: 20 }));
  const stopped = await ws.waitFor((m) => m.type === 'stopped');
  check('resumed stream complete', stopped?.complete === true, stopped);

  r = await req('/api/recordings', { method: 'POST', body: { mimeType: 'audio/webm' } });
  const id2 = r.data.recording.id;
  ws = await openWs(`${WS_BASE}/ws/live?recordingId=${id2}&token=${token}`);
  await ws.waitFor((m) => m.type === 'ready');
  ws.send(frame(0, Buffer.alloc(1500, 1)));
  ws.send(frame(3, Buffer.alloc(1500, 1)));
  ws.send(JSON.stringify({ type: 'stop', totalChunks: 4 }));
  const st2 = await ws.waitFor((m) => m.type === 'stopped');
  check('gap detected as incomplete', st2?.complete === false, st2);
  r = await req(`/api/recordings/${id2}/finalize`, { method: 'POST', body: { durationSec: 20, totalChunks: 4 } });
  check('finalize returns AUDIO_INCOMPLETE', r.status === 409 && r.data.error.code === 'AUDIO_INCOMPLETE', r);
  const fd = new FormData();
  fd.append('durationSec', '20');
  fd.append('audio', new Blob([wav(20)], { type: 'audio/webm' }), 'recording.webm');
  r = await req(`/api/recordings/${id2}/audio`, { method: 'PUT', body: fd });
  check('fallback full upload accepted', r.status === 200 && ['queued', 'processing'].includes(r.data.recording.status), r);
  await req(`/api/recordings/${id}`, { method: 'DELETE' });
  await req(`/api/recordings/${id2}`, { method: 'DELETE' });
}

console.log('\n# Empty recordings');
{
  const fd = new FormData();
  fd.append('audio', new Blob([Buffer.alloc(200)], { type: 'audio/wav' }), 'tiny.wav');
  let r = await req('/api/recordings/upload', { method: 'POST', body: fd });
  const tiny = await waitFor(r.data.recording.id, ['completed', 'failed']);
  check('empty audio fails with clear message', tiny?.status === 'failed' && tiny.error.code === 'AUDIO_EMPTY' && tiny.error.retryable === false, tiny?.error);
  r = await req(`/api/recordings/${tiny.id}/retry`, { method: 'POST' });
  check('non-retryable retry rejected', r.status === 409 && r.data.error.code === 'NOT_RETRYABLE', r);
  r = await req(`/api/recordings/${uploadId}/retry`, { method: 'POST' });
  check('retry on completed rejected', r.status === 409, r);
  await req(`/api/recordings/${tiny.id}`, { method: 'DELETE' });
}

console.log('\n# Authorization isolation');
{
  const mine = token;
  const savedCookie = cookie;
  cookie = '';
  const r1 = await req('/api/auth/register', { method: 'POST', body: { name: 'Other', email: `other_${Date.now()}@example.com`, password }, auth: false });
  token = r1.data.accessToken;
  let r = await req(`/api/recordings/${uploadId}`);
  check("other user can't read my recording (404)", r.status === 404, r);
  r = await req(`/api/recordings/${uploadId}`, { method: 'DELETE' });
  check("other user can't delete my recording", r.status === 404, r);
  r = await req(`/api/recordings?q=authentication`);
  check("other user's search doesn't leak", r.data.total === 0, r.data);
  r = await req('/api/recordings/not-an-id');
  check('malformed id → 404', r.status === 404, r);
  token = mine;
  cookie = savedCookie;
}

console.log('\n# Delete & logout');
{
  let r = await req(`/api/recordings/${liveId}`, { method: 'DELETE' });
  check('delete recording 204', r.status === 204, r);
  r = await req(`/api/recordings/${liveId}`);
  check('deleted recording gone', r.status === 404, r);
  r = await req('/api/auth/logout', { method: 'POST', auth: false, headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  check('logout 204', r.status === 204, r);
  r = await req('/api/auth/refresh', { method: 'POST', auth: false, headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  check('refresh after logout fails', r.status === 401, r);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('Failures:\n - ' + failures.join('\n - '));
process.exit(fail ? 1 : 0);
