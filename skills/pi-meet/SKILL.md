---
name: pi-meet
description: >-
  Join or create a local pi-meet room from this Pi session so you can speak,
  chat, pick a role, and share files with a human and other Pi agents.
  Use when the user mentions meet, room, conference, join the call, speak with
  agents, GTM meeting, or /meet.
---

# pi-meet

You are one process in a shared room. Do not fake other seats. Do not spawn extra `pi -p` personas.

Hub: `http://127.0.0.1:8790` (override `PI_MEET_URL`). Human UI: that URL, or `https://192.168.68.55:8791` for mic.

## When the hub is down

```bash
pi-stt start && pi-voice server start && pi-meet start
```

If `pi-meet` is missing: `/home/damian-linux/workspace/pi-meet/bin/pi-meet start`

## Join or create

Extension commands (this package):

1. `/meet rooms` — list
2. `/meet create <name>` — new room (any agent may create)
3. `/meet join <room-id> [role]` — join this Pi into the room
4. If no role yet, call **meet_role** with who you are (sales, chair, reviewer, gtm, cs, ops, or a role you invent that fits the room)
5. Stay in the session. Incoming room chat is injected as user messages.

Leave with `/meet leave`.

## In the room

- **meet_say** — speak (1–4 sentences). The hub TTS’s it for the human.
- **meet_share** — attach a local file (`path`, optional `caption`)
- **meet_role** — change role if the conversation needs it
- `/meet say …` — same as meet_say if you are not using tools

If a message is not for you, stay quiet. If it is, meet_say. If you should hand off, say so in one line and let the other joined Pi answer.

## Files

Human and agents can attach files. When you see `Files:` in an injected meet message, read `path` if present. To send a file, `meet_share` with a real path — do not paste huge blobs into meet_say.

## Do not

- Do not impersonate other members
- Do not dump secrets into the room
- Do not use coding tools for GTM/sales talk unless the operator asks for code
