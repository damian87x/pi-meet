# Review A2 fixes — concrete race defects at 65da381

Scope: `index.html` only, local commit, no push. Preserved all existing features.

## Defects fixed (verbatim line ranges)

1. **index.html:237-245** — camera retry mutates global `stream` after `await` after leave.
   - Captured `current = stream` before `getWithTimeout`.
   - After await, if `stream !== current`, stop the new `videoOnly` tracks and return instead of mutating the wrong stream.

2. **index.html:339-356** — overlapping `tick()` applies old-room data after leave/rejoin.
   - Captured `thisRoom = roomId` before the events fetch.
   - After await, return early if `roomId !== thisRoom`, so stale events do not update `since`, members, or chat.

3. **index.html:314-315 + 415-434** — `rec = null` race leaves `busy` stuck.
   - `leaveMeeting()` now stops the old recorder and only nulls `rec` when `busy` is false (i.e. `endUtterance` is not in flight).
   - `endUtterance()` captures `thisRec = rec` right after setting `busy = true` and uses `thisRec` for the stop listener, `mimeType`, and cleanup. Added a guard against an inactive recorder to avoid a never-resolving stop promise.

4. **index.html:351-355** — old-room audio `onended` callback modifies new-room talking state.
   - Captured `audioRoom = roomId` when the `Audio` object is created.
   - Callback now checks `roomId !== audioRoom` instead of `!roomId`, so leaving and rejoining any room does not let a stale audio callback clear a tile.

## Tests added

Minimal deterministic VM tests added to `scripts/smoke-meet.mjs`:

- `smoke-tick-leave` — verifies `tick()` does not render members or advance `since` after leave.
- `smoke-camera-leave` — verifies camera retry does not leak/get a second `getUserMedia` call when `stream` is cleared during await.
- `smoke-rec-null-race` — nulls `rec` mid-`endUtterance` and confirms `busy` is reset.
- `smoke-audio-callback-room` — fires an old audio `onended` after rejoining a new room and confirms the tile talk state is untouched.

## Verification

```bash
node scripts/smoke-meet.mjs
```

Output:

```
SMOKE MEET OK { room: 'smoke', seats: [ 'human:You', 'pi:Sol' ], tts: true }
```

Health/status:

```bash
curl -sf http://127.0.0.1:8790/api/health
# {"ok":true,...}
./bin/pi-meet status
# pi-meet: http://192.168.68.55:8790  https://192.168.68.55:8791
```

Git state after commit:

```bash
git status
# On branch feat/meet-video-mvp
# nothing to commit, working tree clean
git log --oneline -1
# a07b847 fix(index): Review A race fixes - tick old room, camera retry after leave, rec null busy, audio callback room
```

## Files changed

- `index.html` — 26 lines changed (9 insertions, 9 deletions net)
- `scripts/smoke-meet.mjs` — 79 lines added for four race tests
- `docs/evidence/pi-meet-video-mvp/mutation-extension-review-a2.md` — this doc
