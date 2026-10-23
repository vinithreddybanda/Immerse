const summaryEl = document.getElementById('summary');
const pendingListEl = document.getElementById('pendingList');
const activeListEl = document.getElementById('activeList');
const stopServerBtn = document.getElementById('stopServerBtn');

function renderSummary(data) {
  const stats = [
    { label: 'Connections', value: data.total || 0 },
    { label: 'Pending', value: (data.pending || []).length },
    { label: 'Accepted', value: (data.active || []).length },
    { label: 'TCP Port', value: data.server?.tcpPort || 9000 },
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
        <span>Bytes: ${session.bytesReceived}</span>
        <span>Strength: ${session.strength}</span>
      </div>
      <div class="controls">
        ${type === 'pending' ? `
          <button class="accept" data-action="accept" data-id="${session.id}">Accept</button>
          <button class="reject" data-action="reject" data-id="${session.id}">Reject</button>
        ` : `
          <button class="stop" data-action="stop" data-id="${session.id}">Stop</button>
        `}

        <div class="range-block">
          <label for="strength-${session.id}">Strength</label>
          <input id="strength-${session.id}" type="range" min="0" max="100" value="${session.strength || 50}" data-id="${session.id}" data-action="strength" />
        </div>
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
    await postDecision(id, action);
    await fetchStatus();
  }
});

document.addEventListener('input', async (event) => {
  const target = event.target.closest('[data-action="strength"]');
  if (!target) return;

  const { id } = target.dataset;
  const strength = Number(target.value);
  await postDecision(id, 'strength', strength);
  await fetchStatus();
});

stopServerBtn.addEventListener('click', async () => {
  await stopServer();
});

fetchStatus();
setInterval(fetchStatus, 1500);
