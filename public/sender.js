const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const preview = document.getElementById('preview');

let socket;
let sessionId;
let peer;
let captureStream;
const pendingCandidates = [];

function setStatus(message) {
  statusEl.textContent = message;
}

function sendSignal(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function connectSignaling() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/signal`);
  socket.onopen = () => {
    sendSignal({ type: 'hello', role: 'sender' });
    setStatus('Waiting for the laptop to accept');
  };
  socket.onmessage = (event) => handleSignal(JSON.parse(event.data)).catch((error) => {
    console.error(error);
    setStatus(error.message);
  });
  socket.onclose = () => {
    if (captureStream) setStatus('Connection lost');
  };
}

async function startSharing() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setStatus('This browser does not support screen capture');
    return;
  }
  startBtn.disabled = true;
  try {
    captureStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60, max: 60 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    preview.srcObject = captureStream;
    captureStream.getTracks().forEach((track) => track.addEventListener('ended', stopSharing));
    stopBtn.disabled = false;
    connectSignaling();
    setStatus('Screen selected; waiting for laptop approval');
  } catch (error) {
    startBtn.disabled = false;
    setStatus(error.name === 'NotAllowedError' ? 'Capture permission was cancelled' : error.message);
  }
}

async function createOffer() {
  peer = new RTCPeerConnection({ iceServers: [] });
  captureStream.getTracks().forEach((track) => peer.addTrack(track, captureStream));
  peer.onicecandidate = (event) => {
    if (event.candidate) sendSignal({ type: 'candidate', sessionId, candidate: event.candidate });
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'connected') setStatus('Live: screen and audio are being sent');
    if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) setStatus(`Connection ${peer.connectionState}`);
  };
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  sendSignal({ type: 'offer', sessionId, offer });
}

async function handleSignal(message) {
  if (message.type === 'registered') {
    sessionId = message.sessionId;
    return;
  }
  if (message.type === 'accepted') {
    setStatus('Accepted; connecting to laptop');
    await createOffer();
    return;
  }
  if (message.type === 'answer' && peer) {
    await peer.setRemoteDescription(message.answer);
    for (const candidate of pendingCandidates.splice(0)) await peer.addIceCandidate(candidate);
    return;
  }
  if (message.type === 'candidate' && peer && message.candidate) {
    if (peer.remoteDescription) await peer.addIceCandidate(message.candidate);
    else pendingCandidates.push(message.candidate);
  }
  if (message.type === 'rejected' || message.type === 'session-ended') {
    peer?.close();
    setStatus(message.type === 'rejected' ? 'Laptop rejected this share' : 'Share ended');
  }
}

function stopSharing() {
  captureStream?.getTracks().forEach((track) => track.stop());
  peer?.close();
  socket?.close();
  preview.srcObject = null;
  captureStream = null;
  peer = null;
  sessionId = null;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('Stopped');
}

startBtn.addEventListener('click', startSharing);
stopBtn.addEventListener('click', stopSharing);
