/* Set the width of the side navigation to 250px */
function openNav() {
  document.getElementById("mySidenav").style.width = "200px";
}

/* Set the width of the side navigation to 0 */
function closeNav() {
  document.getElementById("mySidenav").style.width = "0";
}

// Fetch occupied stands from server and render into the viewer
function renderOccupiedStands() {
  const ul = document.getElementById('occupiedStands');
  if (!ul) return;
  ul.innerHTML = '<li>Loading...</li>';

  fetch('/api/occupancy/occupied')
    .then((res) => {
      if (!res.ok) throw new Error('Network response was not ok');
      return res.json();
    })
    .then((stands) => {
      ul.innerHTML = '';
      if (!Array.isArray(stands) || stands.length === 0) {
        ul.innerHTML = '<li>No stands are currently occupied.</li>';
        return;
      }
      for (const s of stands) {
        const li = document.createElement('li');
        if (s.callsign) li.textContent = `${s.name} @ ${s.icao} — ${s.callsign}`;
        else li.textContent = `${s.name} @ ${s.icao}`;
        ul.appendChild(li);
      }
    })
    .catch((err) => {
      console.error('Failed to load occupied stands', err);
      ul.innerHTML = '<li>Error loading occupied stands.</li>';
    });
}



// Log management
let autoScroll = true;
let logEntries = [];

// Fetch logs from server and render into the log area
function renderLogs() {
  fetch('/api/logs')
  .then((res) => {
    if (!res.ok) throw new Error('Network response was not ok');
    return res.json();
  })
  .then((logs) => {
    if (Array.isArray(logs)) {
      logEntries = logs;
      updateLogDisplay();
    }
  })
  .catch((err) => {
    console.error('Failed to load logs', err);
    addLogEntry('ERROR', 'Failed to load logs from server');
  });
}

function updateLogDisplay() {
  const logContent = document.getElementById('logContent');
  if (!logContent) return;
  
  logContent.innerHTML = '';
  
  logEntries.forEach(entry => {
    const logDiv = document.createElement('div');
    logDiv.className = `log-entry log-${entry.level.toLowerCase()}`;
    logDiv.innerHTML = `
    <span class="log-timestamp">${new Date(entry.timestamp).toLocaleTimeString()}</span>
    <span class="log-level">[${entry.level}]</span>
    <span class="log-message">${entry.message}</span>
    `;
    logContent.appendChild(logDiv);
  });
  
  if (autoScroll) {
    scrollToBottom();
  }
}

function addLogEntry(level, message) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: level,
    message: message
  };
  
  logEntries.push(entry);
  
  // Keep only last 1000 entries to prevent memory issues
  if (logEntries.length > 1000) {
    logEntries = logEntries.slice(-1000);
  }
  
  updateLogDisplay();
}

function clearLog() {
  logEntries = [];
  updateLogDisplay();
}

function toggleAutoScroll() {
  autoScroll = !autoScroll;
  const button = document.getElementById('toggleAutoScroll');
  button.textContent = `Auto-scroll: ${autoScroll ? 'ON' : 'OFF'}`;
  
  if (autoScroll) {
    scrollToBottom();
  }
}

function scrollToBottom() {
  const logContainer = document.getElementById('logContainer');
  if (logContainer) {
    logContainer.scrollTop = logContainer.scrollHeight;
  }
}

// Initial render and periodic refresh
document.addEventListener('DOMContentLoaded', () => {
  renderOccupiedStands();
  renderLogs();
  setInterval(renderOccupiedStands, 5000);
  setInterval(renderLogs, 2000); // Fetch logs more frequently
});