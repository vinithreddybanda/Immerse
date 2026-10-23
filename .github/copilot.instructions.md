# Node.js Local Network Casting Receiver for Android to Windows

## Objective
Build a Node.js receiver that accepts Android casting streams over a local network and writes or forwards the incoming media payload with the lowest practical latency, without altering the media data.

This receiver is a transport node only. It does not decode, transcode, resample, enhance, or process the media payload.

## Core Reality

- Local casting is a latency-sensitive system.
- Zero lag is not physically achievable on real networks.
- The correct target is the lowest practical latency under stable local conditions.
- TCP is chosen for reliability and ordered delivery, but TCP cannot guarantee zero delay.
- The receiver must be optimized for low buffering, bounded memory, and clean disconnect recovery.

The goal is not to invent a perfect transport. The goal is to build a deterministic, reliable, low-latency receiver that behaves predictably on a local Wi‑Fi or wired LAN.

---

## Design Rules

1. Keep the connection persistent.
2. Use binary framing, not text protocols.
3. Preserve original video/audio bytes exactly as received.
4. Avoid extra copies in memory.
5. Keep per-stream state small and predictable.
6. Maintain bounded queue depth.
7. Drop old data only under overload, never silently corrupt payloads.
8. Do not decode or modify media.
9. Treat the receiver as a transport layer, not a media pipeline.
10. Optimize for local network conditions, not public internet conditions.

---

## Local Network Scope

This system is designed for:

- Android device to Windows PC
- same LAN or good local Wi‑Fi
- low-latency casting
- media recording, forwarding, or display capture transfer

This is not a general internet streaming system.

Use this only when:

- the client and server are on the same local subnet or a stable local Wi‑Fi link
- network jitter is low
- you need reliable delivery with limited latency

---

## Transport Model

Use a persistent TCP connection per stream or per client session.

Preferred approach:

- one socket per Android source
- one session ID per connection
- one stream ID per audio or video channel
- binary packets with explicit length and metadata

Do not rely on stream splitting by newline or text markers.

A frame packet should include:

- magic header
- protocol version
- session ID
- stream ID
- channel type (audio/video/control)
- packet type
- sequence number
- timestamp
- payload length
- payload checksum or hash
- payload

Example logical packet layout:

- 4 bytes: magic
- 1 byte: version
- 1 byte: channel
- 2 bytes: reserved
- 8 bytes: session ID
- 8 bytes: stream ID
- 8 bytes: sequence number
- 8 bytes: timestamp
- 4 bytes: payload length
- 4 bytes: checksum
- N bytes: payload

The receiver must parse based on length, not on socket chunk boundaries.

---

## Node.js Requirements

Runtime:

- Node.js LTS
- Windows 11
- native Node.js net module

Core modules:

- net
- stream
- buffer
- crypto
- fs
- events
- os

Do not add heavy dependencies for basic transport work.

The stack should stay lean and predictable.

---

## Server Architecture

Use a layered design:

1. TCP listener
2. socket acceptor
3. session registry
4. per-stream state tracker
5. packet parser
6. integrity validation
7. bounded queue
8. storage or forwarding pipeline

Architecture flow:

Android client
        |
        v
TCP socket
        |
        v
Node.js receiver
        |
        v
Packet parser and validation
        |
        v
Bounded queue / ring buffer
        |
        v
Storage or forwarding layer

The receiver must never do any media manipulation in the middle.

---

## Connection Policy

Socket behavior:

- keep sockets open for the session lifetime
- enable keep-alive
- disable Nagle only when it helps low-latency delivery
- set no delay for time-sensitive packet flow
- use large receive buffers for burst protection
- keep socket lifecycle explicit and tracked

Required socket handling:

- socket.setKeepAlive(true)
- socket.setNoDelay(true)
- read-only binary socket processing
- per-socket timeout monitoring
- graceful close on protocol errors

---

## Session Management

Track for every active connection:

- client identifier
- session ID
- stream IDs
- start time
- last activity time
- connection state
- packet counters
- queue depth
- bytes received
- disconnect reason

Keep a registry of active sessions and remove them immediately on close.

Never allow a dead socket to linger in the session table.

---

## Packet Processing Rules

Every packet must be treated as binary data.

Receiver rules:

- validate packet header
- validate payload length
- validate checksum
- detect duplicate sequence numbers
- detect missing sequence numbers
- detect partial packets
- reject malformed packets cleanly

If a packet is invalid:

- log it
- drop it
- keep the session alive if recoverable
- disconnect only when the protocol is broken or the socket is unusable

The packet parser must be strict. Do not guess.

---

## Buffering Strategy

Buffering is required, but it must be controlled.

Use:

- fixed-size ring buffer per stream
- bounded queue depth
- explicit overflow policy
- fast in-memory accumulation
- immediate writing to storage only when required

No unbounded growth.

Rules:

- queue short bursts only
- keep latency under control
- on overflow, discard oldest queued packets or stop accepting new data for that stream
- never allow memory to grow without limit

The correct principle is:

- reliability without runaway latency
- bounded buffer, not endless buffer

For a real local-casting app, buffering should be very small. A few hundred milliseconds is acceptable; longer buffers create visible lag.

---

## Low-Latency Rules

For real local-network casting, keep latency low:

- do not accumulate large waiting buffers
- do not flush in large batches unless required
- do not decode or re-encode packets
- do not process payloads in large CPU-heavy loops
- do not write every tiny packet to disk immediately if the goal is live forwarding
- do not over-serialize data

The server must optimize for the shortest path from socket to storage or forwarding.

The receiver should prefer:

- fast packet validation
- minimal object creation
- direct streaming to files or downstream consumers
- small, reusable buffers

---

## Media Handling Rules

The server must:

- accept audio streams
- accept video or screen capture streams
- preserve original stream format
- preserve timestamps if provided
- preserve raw encoded payload

The server must not:

- transcode
- re-encode
- resample audio
- resize video
- interpolate frames
- alter timestamps
- modify packet payloads
- add compression or enhancement

The app is a receiver and relay point only.

If the client sends H.264, AAC, MJPEG, or raw frames, the receiver stores or forwards them as-is.

---

## Audio and Video Separation

Treat audio and video as separate streams.

Do not mix them into one queue unless the protocol specifically requires it.

Reason:

- audio and video have different timing needs
- audio jitter is often more sensitive than video jitter
- screen capture video can tolerate more burst smoothing than audio

Separate stream IDs and queues per media type.

---

## Integrity and Recovery

Every packet should be validated for:

- stream ID
- session ID
- sequence number
- timestamp
- payload length
- checksum

Receiver behavior:

- detect duplicate packets
- detect missing packets
- detect corrupted payload
- detect truncation
- detect malformed metadata

Recovery behavior:

- log and drop bad packet
- keep session active if possible
- reset only if there is protocol corruption or repeated failures
- release resources on disconnect

This is transport integrity management, not media repair.

---

## Error Handling

Handle these conditions explicitly:

### Network failures

- connection reset
- timeout
- broken pipe
- port exhaustion
- unstable Wi‑Fi link
- socket close during transfer

### Data failures

- partial packet reads
- invalid headers
- checksum mismatch
- payload truncation
- sequence jump
- duplicate packet

### System failures

- memory pressure
- disk pressure
- slow storage writes
- CPU starvation
- too many open sockets

On all failures:

- log the cause
- close or reset only the affected session
- keep the server process alive
- recover naturally for remaining sessions

---

## Disconnect Recovery

When a socket disconnects:

1. mark session closed
2. flush pending local queue if needed
3. close any stream handles
4. release buffer references
5. remove session from registry
6. log disconnect reason and final counters
7. keep server running for remaining clients

Recovery is not guesswork. It is strict cleanup and state reset.

---

## Performance Rules

### Memory

- reuse buffers
- avoid object churn
- minimize allocations in the hot path
- avoid copying payloads unnecessarily

### CPU

- keep parsing efficient
- avoid heavy synchronous operations
- no blocking while processing packet data
- use async I/O only where needed

### I/O

- write large contiguous chunks when possible
- avoid tiny fragmented writes
- batch writes where it helps throughput
- do not over-batch if it adds latency

This must be a fast, stable, predictable transport path.

---

## Windows Deployment Guidance

Target environment:

- Windows 11
- Node.js LTS
- stable local network
- dedicated capture or handling PC
- adequate RAM and SSD storage

Recommended deployment settings:

- run on a stable wired LAN when possible
- use fixed local IP or static DHCP lease for the sender
- allow the required TCP port through Windows Defender Firewall
- keep the server process under a Windows service or PM2-style process manager if needed
- favor a clean, low-noise desktop environment for consistent performance

Set the machine to High Performance power mode when doing live local casting.

---

## Monitoring

The server must record:

- total accepted connections
- active sessions
- active streams
- packets received per second
- bytes received per second
- queue depth
- buffer occupancy
- memory usage
- disconnect count
- invalid packet count
- recovery count
- errors by type

Use structured logs for:

- connection start
- connection close
- packet validation failures
- stream errors
- backpressure events
- buffer overflow events
- disconnects
- performance warnings

This is not optional. A receiver under load must be observable.

---

## Backpressure Policy

Backpressure is not a bug. It is required.

When the receiver cannot keep up:

- stop accepting new data for affected stream
- drop oldest queued packets if necessary
- keep the connection alive when possible
- do not explode memory
- log the event

Never let the process silently consume unlimited memory.

---

## Testing Strategy

### Functional tests

- single Android stream to Windows receiver
- two streams at the same time
- audio and video stream separation
- large payload transfers
- clean disconnect and reconnect cycle

### Stress tests

- 50 to 200+ concurrent sessions
- long-running streaming sessions
- burst traffic patterns
- packet bursts above normal network pacing

### Reliability tests

- forced disconnects
- Wi‑Fi drop simulation
- partial packet loss
- packet duplication
- malformed packet injection
- buffer saturation
- memory pressure

### Latency tests

- test under local Wi‑Fi and wired LAN
- measure end-to-end packet arrival timing
- verify queue depth stays bounded
- confirm minimal delay when stream is healthy

---

## Final Implementation Standard

The receiver is considered correct when it:

- accepts persistent TCP sessions from Android devices
- keeps audio and video streams separate and traceable
- preserves incoming media bytes without modification
- uses bounded buffering and safe backpressure management
- accepts bursts without runaway memory growth
- detects invalid packets and drops them cleanly
- handles disconnects without crashing the process
- stays stable under load on Windows
- keeps latency as low as the local network allows

The receiver is not a media editor, not a transcoder, and not a playback engine.

It is a strict, low-latency, reliable local-network media transport receiver.

---

## The Real Answer on “No Lag”

There is no practical system that guarantees zero lag over real wireless or local network traffic.

The correct engineering target is:

- lowest practical latency
- reliable packet ordering
- stable throughput
- zero media alteration
- bounded memory usage
- predictable behavior under load

If the network is healthy and the local environment is stable, low-latency close-to-real-time casting is achievable.

If the network is unstable, the receiver must behave correctly by buffering only as much as needed and never hiding problems behind silent data corruption.

This is the standard for a professional local casting receiver.

