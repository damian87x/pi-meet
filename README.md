# pi-meet

Local GTM voice+chat room. Browser talks to **Pi** personas (Chair routes → GTM / Sales / CS / Ops). Per company: Solvie, Miyahaihr, Autonoxis.

Not five always-on agents — one Pi process per speaker, per turn. STT is local Whisper (`pi-stt`), TTS is Kokoro (`pi-voice`).

## Run

```bash
pi-stt start
pi-voice server start
./bin/pi-meet cert    # once, for LAN mic (HTTPS)
./bin/pi-meet start
```

- Chat / type: http://127.0.0.1:8790 or http://192.168.68.55:8790
- Mic: https://192.168.68.55:8791 (accept the self-signed cert)

Chat backup: type + Send. `/join` `/leave` `/sales …`

Needs `pi`, `ffmpeg`, Node 22+, and the STT/TTS servers on localhost.
