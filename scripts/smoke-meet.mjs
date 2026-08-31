#!/usr/bin/env node
/** Hub protocol: create → human join → pi join → pi speak → leave. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PI_MEET_SMOKE_PORT || 8792);
const BASE = `http://127.0.0.1:${PORT}`;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function makeEl(tag) {
  const classes = new Set();
  const props = {
    tag,
    style: {},
    dataset: {},
    classList: {
      toggle(cls, force) {
        if (force === undefined) {
          if (classes.has(cls)) classes.delete(cls);
          else classes.add(cls);
          return classes.has(cls);
        }
        if (force) classes.add(cls);
        else classes.delete(cls);
        return classes.has(cls);
      },
      contains(cls) { return classes.has(cls); },
      add(cls) { classes.add(cls); },
      remove(cls) { classes.delete(cls); },
    },
  };
  return new Proxy(props, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === "querySelector") return () => null;
      if (p === "querySelectorAll") return () => [];
      if (p === "play") return async () => {};
      if (p === "pause") return () => {};
      if (p === "appendChild") return () => {};
      if (p === "removeChild") return () => {};
      if (p === "addEventListener") return () => {};
      if (p === "removeEventListener") return () => {};
      if (typeof p === "symbol") return undefined;
      return () => {};
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}

function makeTrack(kind) {
  return { kind, readyState: "live", enabled: true, muted: false, _stopped: false, stop() { this._stopped = true; this.readyState = "ended"; } };
}
function makeStreamFromTracks(tracks) {
  return {
    _tracks: tracks,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    addTrack(t) { tracks.push(t); },
  };
}
function makeStream({ audio = 0, video = 0 } = {}) {
  const tracks = [];
  for (let i = 0; i < audio; i++) tracks.push(makeTrack("audio"));
  for (let i = 0; i < video; i++) tracks.push(makeTrack("video"));
  return makeStreamFromTracks(tracks);
}

function MediaRecorder(stream, opts) {
  this.stream = stream;
  this.state = "inactive";
  this.mimeType = opts?.mimeType || "";
  this.start = () => { this.state = "recording"; };
  this.stop = () => { const was = this.state; this.state = "inactive"; if (was !== "inactive" && this.onstop) this.onstop(); };
  this.addEventListener = (ev, fn) => { if (ev === "stop") this.onstop = fn; };
  this.ondataavailable = null;
}
MediaRecorder.isTypeSupported = () => true;

function AudioContext() {
  this.state = "running";
  this.resume = async () => {};
  this.createMediaStreamSource = (s) => ({ mediaStream: s, disconnect: () => {} });
  this.createAnalyser = () => ({ fftSize: 0, getFloatTimeDomainData: () => {} });
}

function MediaStream(tracks) { return makeStreamFromTracks(tracks); }

async function runBrowserMockTest(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert(m, "inline script found");
  const script = m[1];
  const timeouts = [];
  const rafs = [];
  const ctx = {
    console,
    setTimeout: (fn, ms, ...args) => { const id = setTimeout(fn, ms, ...args); timeouts.push(id); return id; },
    clearTimeout: (id) => clearTimeout(id),
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => { const id = ctx.setTimeout(fn, 0); rafs.push(id); return id; },
    cancelAnimationFrame: (id) => { ctx.clearTimeout(id); },
    Blob: globalThis.Blob,
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    fetch: async () => ({ json: async () => ({}) }),
    Audio: function () { return { play: async () => {}, set onended(v) {} }; },
    MediaRecorder,
    AudioContext,
    MediaStream,
    makeStream,
    makeTrack,
    makeStreamFromTracks,
    navigator: { mediaDevices: { getUserMedia: async () => makeStream({ audio: 1, video: 1 }) } },
    document: {
      getElementById: () => makeEl(),
      createElement: (tag) => makeEl(tag),
      body: { classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false } },
    },
    location: { search: "" },
  };
  ctx.window = ctx;
  runInContext(script, createContext(ctx), { filename: "index.html", timeout: 10000 });
  await new Promise((r) => setTimeout(r, 100));
  timeouts.forEach(clearTimeout);
  rafs.forEach(clearTimeout);

  await runInContext(`
    (async () => {
      camOn = true; micOn = true; stream = null; analyser = null; sourceNode = null; rec = null; live = false; busy = false;
      let late;
      navigator.mediaDevices.getUserMedia = () => new Promise((res) => setTimeout(() => { late = makeStream({ audio: 1, video: 1 }); res(late); }, 2700));
      try {
        await ensureMedia();
        throw new Error("should have timed out");
      } catch (e) {
        if (!e.message.includes("media timeout")) throw e;
      }
      await new Promise((r) => setTimeout(r, 600));
      if (!late) throw new Error("late stream not created");
      if (!late.getAudioTracks().every((t) => t._stopped)) throw new Error("late audio not stopped");
      if (!late.getVideoTracks().every((t) => t._stopped)) throw new Error("late video not stopped");
    })();
  `, ctx, { filename: "smoke-media-timeout", timeout: 10000 });

  await runInContext(`
    (async () => {
      const mic = makeTrack("audio");
      const audioStream = makeStreamFromTracks([mic]);
      stream = audioStream;
      analyser = { fftSize: 2048, getFloatTimeDomainData: () => {} };
      audioCtx = { state: "running", resume: async () => {}, createMediaStreamSource: (s) => { sourceNode = { mediaStream: s, disconnect: () => {} }; return sourceNode; }, createAnalyser: () => analyser };
      sourceNode = { mediaStream: audioStream, disconnect: () => {} };
      camOn = true; micOn = true; rec = null; live = false; busy = false;
      let videoTrack;
      navigator.mediaDevices.getUserMedia = () => new Promise((res) => setTimeout(() => { videoTrack = makeTrack("video"); res(makeStreamFromTracks([videoTrack])); }, 100));
      await ensureMedia();
      if (mic._stopped) throw new Error("mic stopped");
      if (stream !== audioStream) throw new Error("stream replaced");
      if (stream.getAudioTracks()[0] !== mic) throw new Error("mic track changed");
      if (stream.getVideoTracks().length !== 1) throw new Error("video not added");
      if (!sourceNode || sourceNode.mediaStream !== audioStream) throw new Error("analyser source lost");
    })();
  `, ctx, { filename: "smoke-camera-retry", timeout: 10000 });
}

async function api(path, init) {
  const r = await fetch(BASE + path, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} ${r.status} ${j.error || ""}`);
  return j;
}

const child = spawn(process.execPath, [join(DIR, "server.mjs")], {
  env: { ...process.env, PI_MEET_PORT: String(PORT), PI_MEET_TLS_PORT: String(PORT + 1), PI_MEET_HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => { out += d; });
child.stderr.on("data", (d) => { out += d; });

try {
  for (let i = 0; i < 40; i++) {
    try {
      const h = await api("/api/health");
      assert(h.ok, "health");
      break;
    } catch {
      if (i === 39) throw new Error("hub did not start: " + out.slice(-400));
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  const html = await fetch(BASE + "/").then((r) => r.text());
  assert(html.includes("Join now"), "lobby Join now");
  assert(html.includes("id=\"stage\""), "call stage");
  assert(html.includes("id=\"leave\""), "leave");
  assert(html.includes("getUserMedia"), "camera path");
  assert(html.includes("Camera unavailable; using microphone only"), "camera-fallback path");

  await runBrowserMockTest(html);

  const room = await api("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "smoke" }),
  });
  const human = await api(`/api/rooms/${room.id}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "human", name: "You", role: "host" }),
  });
  const agent = await api(`/api/rooms/${room.id}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "pi", name: "Sol", role: "sales" }),
  });
  assert(agent.room.members.length === 2, "two seats");
  assert(agent.room.members.some((m) => m.kind === "pi" && m.name === "Sol"), "pi tile data");

  const said = await api(`/api/rooms/${room.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memberId: agent.member.id, text: "PONG" }),
  });
  assert(said.event?.text === "PONG", "agent speech text");
  assert(said.event?.kind === "pi", "agent kind");
  // TTS may be null if pi-voice is down; still a valid conference event.
  const ev = await api(`/api/rooms/${room.id}/events?since=0`);
  assert(ev.events.some((e) => e.type === "join" && e.name === "Sol"), "join event");
  assert(ev.events.some((e) => e.type === "message" && e.text === "PONG"), "message event");

  await api(`/api/rooms/${room.id}/leave`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memberId: human.member.id }),
  });
  const after = await api(`/api/rooms/${room.id}`);
  assert(!after.members.some((m) => m.id === human.member.id), "human left");
  assert(after.members.some((m) => m.id === agent.member.id), "agent still in");

  console.log("SMOKE MEET OK", {
    room: room.id,
    seats: agent.room.members.map((m) => m.kind + ":" + m.name),
    tts: Boolean(said.event?.audio),
  });
} finally {
  child.kill("SIGTERM");
}
