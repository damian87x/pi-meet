#!/usr/bin/env node
/** Hub protocol: create → human join → pi join → pi speak → leave. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PI_MEET_SMOKE_PORT || 8792);
const BASE = `http://127.0.0.1:${PORT}`;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
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
