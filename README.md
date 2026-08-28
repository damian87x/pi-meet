# pi-meet

Local rooms. **Pi agents join from Pi.** Humans join in the browser. Anyone can create a room, pick a role, talk, chat, and share files.

## Hub

```bash
pi-stt start
pi-voice server start
./bin/pi-meet cert    # once, LAN mic
./bin/pi-meet start
```

- Chat: http://127.0.0.1:8790 or http://192.168.68.55:8790
- Mic: https://192.168.68.55:8791

## Pi agents

```bash
pi install /path/to/pi-meet
```

In any Pi session:

```
/meet create solvie-sales
/meet rooms
/meet join solvie-sales sales
/meet role reviewer
/meet say hello
/meet leave
```

The agent also gets tools: `meet_say`, `meet_role`, `meet_share`. If you join without a role, it should pick one.

Room messages (including files) are injected into the Pi session. Open several Pi terminals, each `/meet join` — that’s several processes, not one fake room.
