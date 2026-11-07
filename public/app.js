const summaryEl = document.getElementById('summary');
const pendingListEl = document.getElementById('pendingList');
const activeListEl = document.getElementById('activeList');
const stopServerBtn = document.getElementById('stopServerBtn');
const remoteVideo = document.getElementById('remoteVideo');
const connectionStatus = document.getElementById('connectionStatus');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const senderLink = document.getElementById('senderLink');

const sessions = new Map();
let socket;
let activePeer = null;
let playbackContext;
let playbackNode;

function setStatus(message) {
  connectionStatus.textContent = message;
}

function sendSignal(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

async function primePlaybackAudio() {
  if (!playbackContext) playbackContext = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  await playbackContext.resume();
}

async function attachPlaybackAudio(channel) {
  await primePlaybackAudio();
  if (!playbackNode) {
    const worklet = `class ImmersePlayback extends AudioWorkletProcessor {
      constructor() { super(); this.queue = []; this.current = null; this.offset = 0; this.port.onmessage = (event) => this.queue.push(new Float32Array(event.data)); }
      process(inputs, outputs) {
        const output = outputs[0][0];
        for (let index = 0; index < output.length; index += 1) {
          if (!this.current || this.offset >= this.current.length) { this.current = this.queue.shift(); this.offset = 0; }
          output[index] = this.current ? this.current[this.offset++] : 0;
        }
        return true;
      }
    }
    registerProcessor('immerse-playback', ImmersePlayback);`;
    const url = URL.createObjectURL(new Blob([worklet], { type: 'application/javascript' }));
    await playbackContext.audioWorklet.addModule(url);
    playbackNode = new AudioWorkletNode(playbackContext, 'immerse-playback', { outputChannelCount: [1] });
    playbackNode.connect(playbackContext.destination);
  }
  channel.binaryType = 'arraybuffer';
  channel.onopen = () => setStatus('Live: screen and device audio connected');
  channel.onmessage = async (event) => {
    const raw = event.data instanceof ArrayBuffer ? event.data : await event.data.arrayBuffer();
    const input = new DataView(raw);
    const samples = new Float32Array(raw.byteLength / 2);
    for (let index = 0; index < samples.length; index += 1) samples[index] = input.getInt16(index * 2, true) / 32768;
    playbackNode.port.postMessage(samples.buffer, [samples.buffer]);
  };
}

async function createReceiverPeer(sessionId) {
  const peer = new RTCPeerConnection({ iceServers: [] });
  peer.ondatachannel = (event) => {
    if (event.channel.label === 'playback-audio') attachPlaybackAudio(event.channel).catch((error) => setStatus(`Audio error: ${error.message}`));
  };
  peer.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    remoteVideo.play().catch(() => setStatus('Tap the video to start audio'));
    setStatus('Live: screen and audio connected');
  };
  peer.onicecandidate = (event) => {
    if (event.candidate) sendSignal({ type: 'candidate', sessionId, candidate: event.candidate });
  };
  peer.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) setStatus(`Connection ${peer.connectionState}`);
  };
  return peer;
}

async function handleSignal(message) {
  if (message.type === 'session-request') {
    sessions.set(message.id, message);
    await fetchStatus();
    return;
  }
  if (message.type === 'offer' && activePeer) {
    await activePeer.setRemoteDescription(message.offer);
    const answer = await activePeer.createAnswer();
    await activePeer.setLocalDescription(answer);
    sendSignal({ type: 'answer', sessionId: message.sessionId, answer });
    return;
  }
  if (message.type === 'session-accepted') {
    activePeer?.close();
    activePeer = await createReceiverPeer(message.sessionId);
    return;
  }
  if (message.type === 'candidate' && activePeer && message.candidate) {
    await activePeer.addIceCandidate(message.candidate);
  }
  if (message.type === 'session-ended') {
    activePeer?.close();
    activePeer = null;
    remoteVideo.srcObject = null;
    setStatus('Sender disconnected');
    await fetchStatus();
  }
}

function connectSignaling() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/signal`);
  socket.onopen = () => {
    sendSignal({ type: 'hello', role: 'receiver' });
    setStatus('Ready for a mobile sender');
  };
  socket.onmessage = (event) => handleSignal(JSON.parse(event.data)).catch((error) => {
    console.error(error);
    setStatus('Signaling error');
  });
  socket.onclose = () => {
    setStatus('Signaling disconnected; retrying');
    setTimeout(connectSignaling, 1500);
  };
}

function renderSummary(data) {
  const stats = [
    { label: 'Connections', value: data.total || 0 },
    { label: 'Pending', value: (data.pending || []).length },
    { label: 'Accepted', value: (data.active || []).length },
    { label: 'WebRTC sessions', value: data.total || 0 },
  ];

  summaryEl.innerHTML = stats.map((stat) => `
    <div class="stat">
      <div class="label">${stat.label}</div>
      <div class="value">${stat.value}</div>
    </div>
  `).join('');
}

function renderSessionList(list, type) {
  if (!list || list.length === 0) {
    return `<div class="empty">No ${type} sessions</div>`;
  }

  return list.map((session) => `
    <div class="item">
      <div class="item-header">
        <div class="item-title">${session.remoteAddress}</div>
        <div class="badge">${session.status}</div>
      </div>
      <div class="meta">
        <span>ID: ${session.id}</span>
      </div>
      <div class="controls">
        ${type === 'pending' ? `
          <button class="accept" data-action="accept" data-id="${session.id}">Play</button>
          <button class="reject" data-action="reject" data-id="${session.id}">Reject</button>
        ` : `
          <button class="stop" data-action="stop" data-id="${session.id}">Stop</button>
        `}

      </div>
    </div>
  `).join('');
}

async function fetchStatus() {
  try {
    const response = await fetch('/status');
    const data = await response.json();
    renderSummary(data);
    pendingListEl.innerHTML = renderSessionList(data.pending, 'pending');
    activeListEl.innerHTML = renderSessionList(data.active, 'active');
  } catch (error) {
    console.error('Failed to fetch status:', error);
  }
}

async function postDecision(id, action, strength) {
  const payload = { id, action };
  if (typeof strength !== 'undefined') {
    payload.strength = strength;
  }

  try {
    const response = await fetch('/api/decision', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    if (!result.ok) {
      console.error('Decision failed:', result.message);
    }
  } catch (error) {
    console.error('Request failed:', error);
  }
}

async function stopServer() {
  try {
    const response = await fetch('/api/server/stop', { method: 'POST' });
    const data = await response.json();
    console.log(data);
  } catch (error) {
    console.error('Stop server request failed:', error);
  }
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;

  const { action, id } = target.dataset;
  if (action === 'accept' || action === 'reject' || action === 'stop') {
    if (action === 'accept') await primePlaybackAudio();
    await postDecision(id, action);
    await fetchStatus();
  }
});

stopServerBtn.addEventListener('click', async () => {
  await stopServer();
});

fullscreenBtn.addEventListener('click', () => remoteVideo.requestFullscreen?.());

senderLink.href = `${location.origin}/sender`;
connectSignaling();

fetchStatus();
setInterval(fetchStatus, 1500);
