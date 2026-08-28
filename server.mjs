#!/usr/bin/env node
/** Room hub: humans in the browser, Pi agents via /meet. */
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createHttps } from "node:https";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.PI_MEET_HOST || "0.0.0.0";
const PORT = Number(process.env.PI_MEET_PORT || 8790);
const TLS_PORT = Number(process.env.PI_MEET_TLS_PORT || 8791);
const STT = process.env.PI_STT_URL || "http://127.0.0.1:10301/v1/audio/transcriptions";
const TTS = process.env.PI_TTS_URL || "http://127.0.0.1:8181/tts";
const HTML = join(ROOT, "index.html");
const FILE_ROOT = join(homedir(), ".pi", "meet", "files");
const VOICES = ["am_michael", "af_bella", "am_echo", "af_nicole", "am_onyx", "af_heart"];

const rooms = new Map();

function id(prefix) {
  return prefix + randomBytes(4).toString("hex");
}
function slug(name) {
  const s = String(name || "room").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "room";
  return rooms.has(s) ? s + "-" + randomBytes(2).toString("hex") : s;
}
function roomPublic(r) {
  return { id: r.id, name: r.name, members: r.members, seq: r.seq };
}

function send(res, status, body, type = "application/json") {
  if (res.headersSent) return;
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
async function readJson(req) {
  const raw = (await readBody(req)).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function ffmpegToWav(buf, ext) {
  const dir = join(tmpdir(), id("pi-meet-"));
  mkdirSync(dir);
  const inn = join(dir, `in${ext}`);
  const out = join(dir, "out.wav");
  writeFileSync(inn, buf);
  const r = spawnSync("ffmpeg", ["-y", "-i", inn, "-ac", "1", "-ar", "16000", out], { encoding: "utf8" });
  const wav = existsSync(out) ? readFileSync(out) : null;
  rmSync(dir, { recursive: true, force: true });
  if (!wav) throw new Error(r.stderr?.slice(-400) || "ffmpeg failed");
  return wav;
}

async function transcribe(wav) {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
  form.append("model", "tiny");
  const r = await fetch(STT, { method: "POST", body: form });
  if (!r.ok) throw new Error(`stt ${r.status}`);
  const j = await r.json();
  return String(j.text || "").trim();
}

async function speak(text, voice) {
  const r = await fetch(TTS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice: voice || "af_heart", speed: 1.0 }),
  });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  return `data:audio/wav;base64,${buf.toString("base64")}`;
}

function push(room, ev) {
  room.seq += 1;
  const event = { seq: room.seq, t: Date.now(), ...ev };
  room.events.push(event);
  if (room.events.length > 200) room.events.splice(0, room.events.length - 200);
  return event;
}

function getRoom(url) {
  const m = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(.*))?$/);
  if (!m) return null;
  const room = rooms.get(decodeURIComponent(m[1]));
  return { room, rest: m[2] || "", id: m[1] };
}

const onRequest = async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    return res.end();
  }
  if (req.method === "GET" && url.pathname === "/") {
    return send(res, 200, readFileSync(HTML, "utf8"), "text/html; charset=utf-8");
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, { ok: true, rooms: [...rooms.keys()] });
  }
  if (req.method === "GET" && url.pathname === "/api/rooms") {
    return send(res, 200, { rooms: [...rooms.values()].map(roomPublic) });
  }
  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const body = await readJson(req);
    const r = { id: slug(body.name), name: String(body.name || "room").trim() || "room", members: [], events: [], seq: 0 };
    rooms.set(r.id, r);
    push(r, { type: "create", name: r.name });
    return send(res, 200, roomPublic(r));
  }

  const hit = getRoom(url);
  if (hit) {
    if (!hit.room) return send(res, 404, { error: "no room" });
    const { room, rest } = hit;
    if (req.method === "GET" && rest === "") return send(res, 200, roomPublic(room));
    if (req.method === "GET" && rest === "events") {
      const since = Number(url.searchParams.get("since") || 0);
      return send(res, 200, { room: roomPublic(room), events: room.events.filter((e) => e.seq > since) });
    }
    if (req.method === "POST" && rest === "join") {
      const body = await readJson(req);
      const member = {
        id: body.memberId || id("m"),
        kind: body.kind === "pi" ? "pi" : "human",
        name: String(body.name || "anon").slice(0, 40),
        role: String(body.role || "").slice(0, 80),
        voice: VOICES[room.members.length % VOICES.length],
      };
      room.members = room.members.filter((m) => m.id !== member.id);
      room.members.push(member);
      push(room, { type: "join", memberId: member.id, name: member.name, kind: member.kind, role: member.role });
      return send(res, 200, { member, room: roomPublic(room) });
    }
    if (req.method === "POST" && rest === "leave") {
      const body = await readJson(req);
      const m = room.members.find((x) => x.id === body.memberId);
      room.members = room.members.filter((x) => x.id !== body.memberId);
      if (m) push(room, { type: "leave", memberId: m.id, name: m.name });
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && rest === "role") {
      const body = await readJson(req);
      const m = room.members.find((x) => x.id === body.memberId);
      if (!m) return send(res, 404, { error: "not in room" });
      m.role = String(body.role || "").slice(0, 80);
      push(room, { type: "role", memberId: m.id, name: m.name, role: m.role });
      return send(res, 200, { member: m });
    }
    if (req.method === "POST" && rest === "messages") {
      const body = await readJson(req);
      const m = room.members.find((x) => x.id === body.memberId);
      if (!m) return send(res, 404, { error: "join first" });
      const text = String(body.text || "").trim();
      const files = Array.isArray(body.files) ? body.files.slice(0, 8) : [];
      if (!text && !files.length) return send(res, 400, { error: "empty" });
      let audio = null;
      if (m.kind === "pi" && text) audio = await speak(text, m.voice);
      const ev = push(room, {
        type: "message",
        memberId: m.id,
        name: m.name,
        role: m.role,
        kind: m.kind,
        text,
        files,
        audio,
      });
      return send(res, 200, { event: ev });
    }
    if (req.method === "POST" && rest === "files") {
      const body = await readJson(req);
      const m = room.members.find((x) => x.id === body.memberId);
      if (!m) return send(res, 404, { error: "join first" });
      const name = basename(String(body.name || "file.txt"));
      const dir = join(FILE_ROOT, room.id);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${Date.now()}-${name}`);
      const text = String(body.text || "");
      writeFileSync(path, text);
      const file = { name, path, text: text.slice(0, 8000) };
      push(room, {
        type: "message",
        memberId: m.id,
        name: m.name,
        role: m.role,
        kind: m.kind,
        text: body.caption || `shared ${name}`,
        files: [file],
      });
      return send(res, 200, { file });
    }
    if (req.method === "POST" && rest === "audio") {
      const memberId = url.searchParams.get("memberId");
      const m = room.members.find((x) => x.id === memberId);
      if (!m) return send(res, 404, { error: "join first" });
      const ctype = req.headers["content-type"] || "";
      const audio = await readBody(req);
      const ext = ctype.includes("webm") ? ".webm" : ctype.includes("ogg") ? ".ogg" : ".wav";
      const wav = ext === ".wav" ? audio : ffmpegToWav(audio, ext);
      const text = await transcribe(wav);
      if (!text) return send(res, 400, { error: "empty speech" });
      const ev = push(room, {
        type: "message",
        memberId: m.id,
        name: m.name,
        role: m.role,
        kind: m.kind,
        text,
        files: [],
        audio: null,
      });
      return send(res, 200, { event: ev, text });
    }
  }
  send(res, 404, { error: "not found" });
};

createServer(onRequest).listen(PORT, HOST, () => {
  console.log(`pi-meet http://192.168.68.55:${PORT}`);
});
const cert = join(ROOT, "cert.pem");
const key = join(ROOT, "key.pem");
if (existsSync(cert) && existsSync(key)) {
  createHttps({ cert: readFileSync(cert), key: readFileSync(key) }, onRequest).listen(TLS_PORT, HOST, () => {
    console.log(`pi-meet https://192.168.68.55:${TLS_PORT}`);
  });
}
