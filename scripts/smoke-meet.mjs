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
    removeTrack(t) { const i = tracks.indexOf(t); if (i >= 0) tracks.splice(i, 1); },
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
    makeEl,
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

  await runInContext(`
    (async () => {
      const mic = makeTrack("audio");
      const deadCam = makeTrack("video");
      deadCam.stop();
      const audioStream = makeStreamFromTracks([mic, deadCam]);
      stream = audioStream;
      analyser = { fftSize: 2048, getFloatTimeDomainData: () => {} };
      audioCtx = { state: "running", resume: async () => {}, createMediaStreamSource: (s) => { sourceNode = { mediaStream: s, disconnect: () => {} }; return sourceNode; }, createAnalyser: () => analyser };
      sourceNode = { mediaStream: audioStream, disconnect: () => {} };
      camOn = true; micOn = true; rec = null; live = false; busy = false;
      let videoTrack;
      navigator.mediaDevices.getUserMedia = () => new Promise((res) => setTimeout(() => { videoTrack = makeTrack("video"); res(makeStreamFromTracks([videoTrack])); }, 100));
      await ensureMedia();
      if (!deadCam._stopped) throw new Error("ended video track not stopped on retry");
      if (stream.getVideoTracks().length !== 1) throw new Error("ended video track not removed");
      if (stream.getVideoTracks()[0] !== videoTrack) throw new Error("live video track not selected");
    })();
  `, ctx, { filename: "smoke-camera-retry-ended", timeout: 10000 });

  await runInContext(`
    (async () => {
      const tile = document.createElement("div");
      let removed = false;
      tile.remove = () => { removed = true; };
      stage.appendChild(tile);
      tileById.set("x", tile);
      roomId = "r"; memberId = "m";
      stream = makeStream({ audio: 1, video: 1 });
      await leaveMeeting();
      if (tileById.size !== 0) throw new Error("tileById not cleared after leave");
      if (!removed) throw new Error("stage tile not removed after leave");
      if (talkingTimers.size !== 0) throw new Error("talkingTimers not cleared after leave");
    })();
  `, ctx, { filename: "smoke-leave-cleanup", timeout: 10000 });

  await runInContext(`
    (async () => {
      roomId = "old"; memberId = "m"; since = 5;
      let rendered = false;
      const oldRenderMembers = renderMembers;
      renderMembers = () => { rendered = true; };
      const oldApi = api;
      api = () => new Promise((res) => setTimeout(() => res({ room: { members: [] }, events: [{ type: "message", seq: 99, memberId: "x", name: "X", text: "hi" }] }), 80));
      const p = tick();
      await new Promise((r) => setTimeout(r, 20));
      roomId = ""; since = 0; memberId = "";
      await p;
      if (rendered) throw new Error("tick rendered members after leave");
      if (since !== 0) throw new Error("tick advanced since after leave");
      api = oldApi; renderMembers = oldRenderMembers;
    })();
  `, ctx, { filename: "smoke-tick-leave", timeout: 10000 });

  await runInContext(`
    (async () => {
      const mic = makeTrack("audio");
      const audioStream = makeStreamFromTracks([mic]);
      stream = audioStream;
      camOn = true; micOn = true; rec = null; live = false; busy = false;
      let calls = 0;
      navigator.mediaDevices.getUserMedia = () => {
        calls++;
        return new Promise((res) => setTimeout(() => res(makeStreamFromTracks([makeTrack("video")])), 40));
      };
      const p = ensureMedia();
      await new Promise((r) => setTimeout(r, 10));
      stream = null;
      await p;
      if (calls !== 1) throw new Error("expected 1 getUserMedia call after leave, got " + calls);
    })();
  `, ctx, { filename: "smoke-camera-leave", timeout: 10000 });

  await runInContext(`
    (async () => {
      stream = makeStream({ audio: 1 });
      chunks = []; heard = true; speechAt = 0; lastLoud = 0;
      rec = new MediaRecorder(new MediaStream(stream.getAudioTracks()));
      rec.state = "recording";
      rec.stop = function() { this.state = "inactive"; setTimeout(() => { if (this.onstop) this.onstop(); }, 60); };
      busy = false; live = false;
      const p = endUtterance();
      await new Promise((r) => setTimeout(r, 10));
      rec = null;
      await p;
      if (busy) throw new Error("busy stuck after rec nulled during endUtterance");
    })();
  `, ctx, { filename: "smoke-rec-null-race", timeout: 10000 });

  await runInContext(`
    (async () => {
      const oldAudio = Audio;
      const audioInstances = [];
      Audio = function() {
        const inst = { play: async () => {}, onended: null, fireEnded: () => { if (inst.onended) inst.onended(); } };
        audioInstances.push(inst);
        return inst;
      };
      roomId = "old"; memberId = "me"; since = 0;
      const tile = document.createElement("div");
      tile.classList.add("talk");
      tileById.set("x", tile);
      talkingUntil.set("x", Date.now() + 10000);
      const oldApi = api;
      api = () => Promise.resolve({ room: { members: [] }, events: [{ type: "message", seq: 1, memberId: "x", name: "X", text: "", audio: "data:audio/wav;base64," }] });
      await tick();
      api = oldApi;
      if (audioInstances.length !== 1) throw new Error("expected one Audio, got " + audioInstances.length);
      roomId = "new";
      audioInstances[0].fireEnded();
      if (!tile.classList.contains("talk")) throw new Error("old-room audio callback cleared talk class after rejoin");
      Audio = oldAudio;
    })();
  `, ctx, { filename: "smoke-audio-callback-room", timeout: 10000 });

  await runInContext(`
    (async () => {
      camOn = true; micOn = true; stream = null; audioCtx = { state: "running", resume: async () => {}, createMediaStreamSource: (s) => ({ mediaStream: s, disconnect: () => {}, connect: () => {} }), createAnalyser: () => ({ fftSize: 0, getFloatTimeDomainData: () => {} }) }; analyser = { fftSize: 2048, getFloatTimeDomainData: () => {} }; sourceNode = null; rec = null; live = false; busy = false;
      let late;
      navigator.mediaDevices.getUserMedia = () => new Promise((res) => setTimeout(() => { late = makeStream({ audio: 1, video: 1 }); res(late); }, 300));
      const p = ensureMedia();
      await new Promise((r) => setTimeout(r, 50));
      mediaGeneration++;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      await p;
      if (stream === late) throw new Error("stale ensureMedia assigned late stream");
      if (!late) throw new Error("late stream not created");
      if (!late.getAudioTracks().every((t) => t._stopped)) throw new Error("late audio not stopped");
      if (!late.getVideoTracks().every((t) => t._stopped)) throw new Error("late video not stopped");
    })();
  `, ctx, { filename: "smoke-media-generation-leave", timeout: 10000 });

  await runInContext(`
    (async () => {
      roomId = "same"; memberId = "me"; since = 0; sessionGeneration = 0;
      const oldApi = api;
      api = () => new Promise((res) => setTimeout(() => res({ room: { members: [] }, events: [{ type: "message", seq: 1, memberId: "x", name: "X", text: "", audio: "data:audio/wav;base64," }] }), 80));
      const p = tick();
      await new Promise((r) => setTimeout(r, 20));
      sessionGeneration++;
      await p;
      api = oldApi;
      if (since !== 0) throw new Error("stale tick advanced since after same-room rejoin");
    })();
  `, ctx, { filename: "smoke-tick-session-aba", timeout: 10000 });

  await runInContext(`
    (async () => {
      const oldAudio = Audio;
      const audioInstances = [];
      Audio = function() {
        const inst = { play: async () => {}, onended: null, fireEnded: () => { if (inst.onended) inst.onended(); } };
        audioInstances.push(inst);
        return inst;
      };
      roomId = "same"; memberId = "me"; since = 0; sessionGeneration = 1;
      const tile = document.createElement("div");
      tile.classList.add("talk");
      tileById.set("x", tile);
      talkingUntil.set("x", Date.now() + 10000);
      const oldApi = api;
      api = () => Promise.resolve({ room: { members: [] }, events: [{ type: "message", seq: 1, memberId: "x", name: "X", text: "", audio: "data:audio/wav;base64," }] });
      await tick();
      api = oldApi;
      if (audioInstances.length !== 1) throw new Error("expected one Audio, got " + audioInstances.length);
      sessionGeneration++;
      audioInstances[0].fireEnded();
      if (!tile.classList.contains("talk")) throw new Error("old-session audio callback cleared talk class after same-room rejoin");
      Audio = oldAudio;
    })();
  `, ctx, { filename: "smoke-audio-callback-session", timeout: 10000 });

  await runInContext(`
    (async () => {
      camOn = true; micOn = true; stream = null; analyser = null; sourceNode = null; rec = null; live = false; busy = false; mediaGeneration = 0;
      let resumeResolve;
      const resumePromise = new Promise((r) => { resumeResolve = r; });
      preview.srcObject = "unchanged";
      audioCtx = { state: "suspended", resume: () => resumePromise, createMediaStreamSource: (s) => { sourceNode = { mediaStream: s, disconnect: () => {}, connect: () => {} }; return sourceNode; }, createAnalyser: () => ({ fftSize: 2048, getFloatTimeDomainData: () => {} }) };
      let late;
      navigator.mediaDevices.getUserMedia = () => new Promise((res) => setTimeout(() => { late = makeStream({ audio: 1, video: 1 }); res(late); }, 80));
      const p = ensureMedia();
      await new Promise((r) => setTimeout(r, 120));
      mediaGeneration++;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      resumeResolve();
      await p;
      if (sourceNode) throw new Error("stale ensureMedia created sourceNode after resume race");
      if (preview.srcObject !== "unchanged") throw new Error("stale ensureMedia set preview after resume race");
      if (!late) throw new Error("late stream not created");
      if (!late.getAudioTracks().every((t) => t._stopped)) throw new Error("late audio not stopped after resume race");
      if (!late.getVideoTracks().every((t) => t._stopped)) throw new Error("late video not stopped after resume race");
    })();
  `, ctx, { filename: "smoke-media-resume-race", timeout: 10000 });

  await runInContext(`
    (async () => {
      camOn = true; micOn = true; analyser = null; sourceNode = null; rec = null; live = false; busy = false; mediaGeneration = 0;
      const newerStream = makeStream({ audio: 1, video: 1 });
      stream = newerStream;
      let resumeResolve;
      const resumePromise = new Promise((r) => { resumeResolve = r; });
      preview.srcObject = "unchanged";
      audioCtx = { state: "suspended", resume: () => resumePromise, createMediaStreamSource: (s) => { sourceNode = { mediaStream: s, disconnect: () => {}, connect: () => {} }; return sourceNode; }, createAnalyser: () => ({ fftSize: 2048, getFloatTimeDomainData: () => {} }) };
      navigator.mediaDevices.getUserMedia = () => Promise.resolve(makeStream({ audio: 1, video: 1 }));
      const p = ensureMedia();
      await new Promise((r) => setTimeout(r, 20));
      mediaGeneration++;
      resumeResolve();
      await p;
      if (newerStream.getAudioTracks().some((t) => t._stopped)) throw new Error("stale ensureMedia stopped newer audio tracks");
      if (newerStream.getVideoTracks().some((t) => t._stopped)) throw new Error("stale ensureMedia stopped newer video tracks");
      if (stream !== newerStream) throw new Error("newer stream was replaced by stale ensureMedia");
      if (sourceNode) throw new Error("stale ensureMedia created sourceNode after resume race");
      if (preview.srcObject !== "unchanged") throw new Error("stale ensureMedia set preview after resume race");
    })();
  `, ctx, { filename: "smoke-media-resume-race-owned", timeout: 10000 });

  await runInContext(`
    (async () => {
      roomId = ""; memberId = ""; since = 0; sessionGeneration = 0; live = false; mediaGeneration = 0;
      let joinResolve;
      const joinPromise = new Promise((r) => { joinResolve = r; });
      let leaveCalls = [];
      const oldApi = api;
      api = (path, init) => {
        if (path.includes("/join")) {
          setTimeout(() => {
            sessionGeneration++;
            joinResolve({ member: { id: "stale-member" }, room: { seq: 7, members: [{ id: "stale-member", name: "You", kind: "human", role: "host" }], name: "Stale" } });
          }, 40);
          return joinPromise;
        }
        if (path.includes("/leave")) { leaveCalls.push({ path, body: JSON.parse(init.body) }); return Promise.resolve({ ok: true }); }
        return Promise.resolve({});
      };
      roomsEl.value = "room-a";
      const myroleEl = { value: "host" };
      document.getElementById = (id) => id === "myrole" ? myroleEl : makeEl();
      const p = joinMeeting();
      await p;
      api = oldApi;
      if (memberId === "stale-member") throw new Error("stale join response leaked memberId");
      if (since === 7) throw new Error("stale join response leaked since");
      if (document.body.classList.contains("in-call")) throw new Error("stale join response entered call UI");
      if (live) throw new Error("stale join response started live");
      const staleLeave = leaveCalls.find((c) => c.path.includes("room-a/leave") && c.body.memberId === "stale-member");
      if (!staleLeave) throw new Error("stale server member not left: " + JSON.stringify(leaveCalls));
    })();
  `, ctx, { filename: "smoke-join-stale-response", timeout: 10000 });
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

  await api(`/api/rooms/${room.id}/leave`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memberId: agent.member.id }),
  });
  const empty = await api(`/api/rooms/${room.id}`);
  assert(empty.members.length === 0, "zero members after both leave");

  console.log("SMOKE MEET OK", {
    room: room.id,
    seats: agent.room.members.map((m) => m.kind + ":" + m.name),
    tts: Boolean(said.event?.audio),
  });
} finally {
  child.kill("SIGTERM");
}
