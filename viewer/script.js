const API_BASE_URL = 'https://pintade.vatsim.fr/rampagent';

/* Set the width of the side navigation to 250px */
function openNav() {
  document.getElementById("mySidenav").style.width = "200px";
}

/* Set the width of the side navigation to 0 */
function closeNav() {
  document.getElementById("mySidenav").style.width = "0";
}

// Dark mode toggle
function toggleDarkMode() {
  document.body.classList.toggle("dark-mode");
  const isDarkMode = document.body.classList.contains("dark-mode");
  localStorage.setItem("darkMode", isDarkMode ? "enabled" : "disabled");
}

// High volume detection and performance mode
let performanceMode = false;
let lastStandCount = 0;
const HIGH_VOLUME_THRESHOLD = 50; // Number of stands that triggers performance mode

function checkVolumeAndTogglePerformanceMode(standCount) {
  const shouldBeInPerformanceMode = standCount >= HIGH_VOLUME_THRESHOLD;
  
  if (shouldBeInPerformanceMode && !performanceMode) {
    enablePerformanceMode();
  } else if (!shouldBeInPerformanceMode && performanceMode && !manualToggle) {
    disablePerformanceMode();
  }
  
  lastStandCount = standCount;
}

function enablePerformanceMode() {
  performanceMode = true;
  document.body.classList.add("performance-mode");
  updatePerformanceToggleButton();
  
  // Show notification to user
  showPerformanceModeNotification(true);
}

function disablePerformanceMode() {
  performanceMode = false;
  document.body.classList.remove("performance-mode");
  updatePerformanceToggleButton();
  
  // Show notification to user
  showPerformanceModeNotification(false);
}

function showPerformanceModeNotification(enabled) {
  const existingNotification = document.querySelector('.performance-notification');
  if (existingNotification) {
    existingNotification.remove();
  }
  
  const notification = document.createElement('div');
  notification.className = 'performance-notification';
  notification.textContent = enabled 
    ? "⚡ Performance Mode: Animations disabled (" + lastStandCount + " stands)" 
    : "✓ Performance Mode: Animations re-enabled";
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.opacity = '0';
    setTimeout(() => notification.remove(), 500);
  }, 3000);
}

let manualToggle = false;
function togglePerformanceModeManual() {
  if (performanceMode) {
    disablePerformanceMode();
  } else {
    enablePerformanceMode();
    manualToggle = true;
  }
  updatePerformanceToggleButton();
}

function updatePerformanceToggleButton() {
  const button = document.getElementById('performanceModeToggle');
  if (button) {
    if (performanceMode) {
      button.classList.add('active');
      button.title = 'Performance Mode: ON (Click to disable)';
    } else {
      button.classList.remove('active');
      button.title = 'Performance Mode: OFF (Click to enable)';
    }
  }
}

// Status page

function generateSpanforText(text) {
  const departureBoard = document.createElement("div");
  departureBoard.className = "departure-board";
  const chars = Array.from(text);
  const blanksNeeded = 16 - chars.length;
  chars.unshift(" ");
  for (let i = 0; i < blanksNeeded; i++) {
    chars.push(" ");
  }
  chars.forEach((char, index) => {
    const charSpan = document.createElement("span");
    if (char === " ") {
      charSpan.className = "letter letter-blank";
    } else {
      charSpan.className = "letter letter-" + char.toUpperCase();
    }
    departureBoard.appendChild(charSpan);
  });
  return departureBoard;
}

function generateSeparator() {
  const separator = document.createElement("div");
  separator.className = "airport-display-separator";
  return separator;
}

function padStandName(name) {
  return name.padStart(3, " ");
}
function padAirportIcao(name) {
  return name.padStart(9, " ");
}

async function renderAirportsStatus() {
  try {
    // Fetch all airports
    const airportList = await fetch(API_BASE_URL + "/api/airports", {
      headers: { "X-Internal-Request": "1" },
    })
      .then((res) => res.json())
      .catch(() => []);

    // Fetch stands
    const allOccupiedStands = await fetch(API_BASE_URL + "/api/occupancy/occupied", {
      headers: { "X-Internal-Request": "1" },
    }).then((res) => res.json());
    const getAllAssignedStands = await fetch(API_BASE_URL + "/api/occupancy/assigned", {
      headers: { "X-Internal-Request": "1" },
    }).then((res) => res.json());
    const getAllBlockedStands = await fetch(API_BASE_URL + "/api/occupancy/blocked", {
      headers: { "X-Internal-Request": "1" },
    }).then((res) => res.json());
    


    // Check volume and toggle performance mode
    const totalStands = allOccupiedStands.length + getAllBlockedStands.length + getAllAssignedStands.length;
    checkVolumeAndTogglePerformanceMode(totalStands);

    const statusContainer = document.getElementById("status-container");
    if (!statusContainer) {
      console.error("renderAirportsStatus: status-container not found");
      return;
    }
    statusContainer.innerHTML = "";

  // Build airport map
  const airports = {};
  airportList.forEach((airport) => {
    airports[airport.name] = { name: airport.name, occupied: [], assigned: [], blocked: [] };
  });
  // Assign stands
  allOccupiedStands.forEach((stand) => {
    const airportIcao = stand.icao;
    if (airportIcao && airports[airportIcao]) {
      airports[airportIcao].occupied.push(stand);
    }
  });
  getAllAssignedStands.forEach((stand) => {
    const airportIcao = stand.icao;
    if (airportIcao && airports[airportIcao]) {
      airports[airportIcao].assigned.push(stand);
    }
  });
  getAllBlockedStands.forEach((stand) => {
    const airportIcao = stand.icao;
    if (airportIcao && airports[airportIcao]) {
      airports[airportIcao].blocked.push(stand);
    }
  });

  renderAirportChart(airports);

  // Render all airports
  for (const [airportIcao, stands] of Object.entries(airports)) {
    const subContainer = document.createElement("div");
    subContainer.className = "airport-display subContainer";
    subContainer.id = "airport-" + airportIcao;
    subContainer.appendChild(generateSpanforText(padAirportIcao(airportIcao)));
    subContainer.appendChild(generateSeparator());
    subContainer.appendChild(generateSpanforText("Occupied Stands"));
    subContainer.appendChild(generateSeparator());
    if (stands.occupied.length === 0) {
      subContainer.appendChild(generateSpanforText("None"));
    } else {
      stands.occupied.forEach((stand) => {
        subContainer.appendChild(
          generateSpanforText(padStandName(stand.name) + "  " + stand.callsign)
        );
      });
    }
    subContainer.appendChild(generateSeparator());
    subContainer.appendChild(generateSpanforText("Assigned Stands"));
    subContainer.appendChild(generateSeparator());
    if (stands.assigned.length === 0) {
      subContainer.appendChild(generateSpanforText("None"));
    } else {
      stands.assigned.forEach((stand) => {
        subContainer.appendChild(
          generateSpanforText(padStandName(stand.name) + "  " + stand.callsign)
        );
      });
    }
    subContainer.appendChild(generateSeparator());
    subContainer.appendChild(generateSpanforText("Blocked Stands"));
    subContainer.appendChild(generateSeparator());
    if (stands.blocked.length === 0) {
      subContainer.appendChild(generateSpanforText("None"));
    } else {
      stands.blocked.forEach((stand) => {
        subContainer.appendChild(
          generateSpanforText(padStandName(stand.name) + "  " + stand.callsign)
        );
      });
    }
    statusContainer.appendChild(subContainer);
  }
  } catch (error) {
    console.error("renderAirportsStatus: Error", error);
  }
}

// Statistics chart
let totalRequests = 0;

let reportsChart = null;
let airportChart = null;

async function fetchReportsPerHour() {
  const res = await fetch(API_BASE_URL + "/api/stats/reports-per-hour", {
    headers: { "X-Internal-Request": "1" }
  });
  if (!res.ok) {
    console.warn("fetchReportsPerHour -> network not ok", res.status, await res.text());
    throw new Error("Failed to fetch stats");
  }
  const json = await res.json();
  return json;
}

async function fetchRequestsPerHour() {
  const res = await fetch(API_BASE_URL + "/api/stats/requests-per-hour", {
    headers: { "X-Internal-Request": "1" }
  });
  if (!res.ok) {
    console.warn("fetchRequestsPerHour -> network not ok", res.status, await res.text());
    throw new Error("Failed to fetch stats");
  }
  const json = await res.json();
  return json;
}

function generateTimeWindow(hours = 24) {
  const now = new Date();
  const currentHour = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours()
  );
  const timeLabels = [];

  for (let i = hours - 1; i >= 0; i--) {
    const hour = new Date(currentHour.getTime() - i * 60 * 60 * 1000);
    timeLabels.push({
      hourIso: hour.toISOString(),
      label: String(hour.getHours()).padStart(2, "0") + ":00",
      hour: hour.getHours(),
    });
  }

  return timeLabels;
}

function renderReportsChart(reportsData, requestsData = []) {
  if (!Array.isArray(reportsData)) {
    console.warn("renderReportsChart -> invalid data", reportsData);
    return;
  }

  const isDarkMode = document.body.classList.contains("dark-mode");
  const gridColor = isDarkMode ? "#444" : "#b0b0b0";
  const axisTextColor = isDarkMode ? "#444" : "#b0b0b0";
  const legendTextColor = isDarkMode ? "#444" : "#b0b0b0";

  const timeWindow = generateTimeWindow(24);
  const reportsMap = new Map(
    reportsData.map((d) => [new Date(d.hourIso).getHours(), d.count])
  );
  const requestsMap = new Map(
    requestsData.map((d) => [new Date(d.hourIso).getHours(), d.count])
  );

  const labels = timeWindow.map((t) => t.label);
  const reportsCounts = timeWindow.map((t) => reportsMap.get(t.hour) || 0);
  const requestsCounts = timeWindow.map((t) => requestsMap.get(t.hour) || 0);

  const canvas = document.getElementById("reportsChart");
  if (!canvas) {
    console.warn("renderReportsChart -> canvas#reportsChart not found");
    return;
  }
  if (typeof Chart === "undefined") {
    console.warn("renderReportsChart -> Chart is not loaded");
    return;
  }

  const ctx = canvas.getContext("2d");

  if (!reportsChart) {
    reportsChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Reports / hour",
            data: reportsCounts,
            backgroundColor: "rgba(104, 139, 239,0.7)",
            borderColor: "rgba(54,162,235,1)",
            borderWidth: 1,
            borderRadius: 3,
            maxBarThickness: 40,
          },
          {
            label: "Requests / hour",
            data: requestsCounts,
            backgroundColor: "rgba(255, 99, 132, 0.7)",
            borderColor: "rgba(255, 99, 132, 1)",
            borderWidth: 1,
            borderRadius: 3,
            maxBarThickness: 40,
          },
        ],
      },
      options: {
        scales: {
          x: {
            grid: {
              display: true,
              lineWidth: 1,
              color: gridColor,
            },
            ticks: {
              color: axisTextColor,
            },
            offset: true,
            categoryPercentage: 0.8,
            barPercentage: 0.9,
          },
          y: {
            grid: {
              display: true,
              lineWidth: 1,
              color: gridColor,
            },
            ticks: {
              color: axisTextColor,
              precision: 0,
            },
            beginAtZero: true,
            grid: {
              display: true,
              lineWidth: 1,
              color: gridColor,
            },
          },
        },
        plugins: {
          legend: {
            labels: {
              color: legendTextColor,
            },
          },
          tooltip: { enabled: true },
        },
        responsive: true,
        maintainAspectRatio: false,
        animation: {
          duration: 300,
        },
      },
    });
  } else {
    reportsChart.data.labels = labels;
    reportsChart.data.datasets[0].data = reportsCounts;
    if (reportsChart.data.datasets[1]) {
      reportsChart.data.datasets[1].data = requestsCounts;
    }
    reportsChart.update("none");
  }
}

function renderAirportChart(airports) {
  // Convert airports object to array
  const airportArr = Object.values(airports);

  const chartColors = ["#4a90e2", "#e94e77", "#50b848", "#f5a623"];
  const canvas = document.getElementById("airportChart");
  if (!canvas) {
    console.warn("renderAirportChart -> canvas#airportChart not found");
    return;
  }
  if (typeof Chart === "undefined") {
    console.warn("renderAirportChart -> Chart is not loaded");
    return;
  }

  const ctx = canvas.getContext("2d");

  if (!airportChart) {
    airportChart = new Chart(ctx, {
      type: "pie",
      data: {
        labels: airportArr.map((a) => a.name),
        datasets: [
          {
            data: airportArr.map((a) => a.occupied.length),
            backgroundColor: chartColors,
            borderColor: "#222",
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "top",
            labels: {
              color: "#888888",
            },
          },
          tooltip: {
            callbacks: {
              label: (tooltipItem) => {
                const label = tooltipItem.label || "";
                const value = tooltipItem.raw || 0;
                return label + ": " + value;
              },
            },
          },
        },
      },
    });
  } else {
    airportChart.data.labels = airportArr.map((a) => a.name);
    airportChart.data.datasets[0].data = airportArr.map(
      (a) => a.occupied.length
    );
    airportChart.update("none");
  }
}

async function refreshStatsChart() {
  try {
    const reportsData = await fetchReportsPerHour();
    const requestsData = await fetchRequestsPerHour();

    // Pass both datasets to the chart
    renderReportsChart(reportsData, requestsData);

    totalRequests = requestsData.reduce((sum, d) => sum + d.count, 0);
    totalReports = reportsData.reduce((sum, d) => sum + d.count, 0);

    const requestTotal = document.querySelector("#RequestTotal");
    const reportTotal = document.querySelector("#ReportTotal");
    
    if (requestTotal && reportTotal) {
      requestTotal.textContent = totalRequests.toLocaleString();
      reportTotal.textContent = totalReports.toLocaleString();
    } else {
      console.error("refreshStatsChart: Total elements not found", {
        requestTotal: !!requestTotal,
        reportTotal: !!reportTotal
      });
    }
  } catch (err) {
    console.error("refreshStatsChart: Failed", err);
  }
}

// initial load when DOM ready
document.addEventListener("DOMContentLoaded", () => {
  // try initial render (chart canvas must exist)
  setTimeout(() => {
    refreshStatsChart();
  }, 200);
  // refresh every 10 seconds
  setInterval(refreshStatsChart, 10000);
});

// Log management
let autoScroll = true;
let cachedFilters = {
  categories: new Set(),
  icaos: new Set(),
  callsigns: new Set()
};

// Populate dropdowns
async function populateLogFilters() {
  try {
    const [categoriesRes, icaosRes, callsignsRes] = await Promise.all([
      fetch(API_BASE_URL + "/api/logs/categories", { headers: { "X-Internal-Request": "1" } }),
      fetch(API_BASE_URL + "/api/logs/icaos", { headers: { "X-Internal-Request": "1" } }),
      fetch(API_BASE_URL + "/api/logs/callsigns", { headers: { "X-Internal-Request": "1" } })
    ]);

    // Check responses
    if (!categoriesRes.ok || !icaosRes.ok || !callsignsRes.ok) {
      console.error('Failed to fetch log filters:', {
        categories: categoriesRes.status,
        icaos: icaosRes.status,
        callsigns: callsignsRes.status
      });
      return;
    }

    let categories, icaos, callsigns;
    
    try {
      categories = await categoriesRes.json();
    } catch (e) {
      console.error('Failed to parse categories JSON:', e);
      categories = [];
    }
    
    try {
      icaos = await icaosRes.json();
    } catch (e) {
      console.error('Failed to parse icaos JSON:', e);
      icaos = [];
    }
    
    try {
      callsigns = await callsignsRes.json();
    } catch (e) {
      console.error('Failed to parse callsigns JSON:', e);
      callsigns = [];
    }

    // Ensure responses are arrays
    const categoriesArray = Array.isArray(categories) ? categories : [];
    const icaosArray = Array.isArray(icaos) ? icaos : [];
    const callsignsArray = Array.isArray(callsigns) ? callsigns : [];

    // Update categories if changed
    updateDropdownIfChanged('category-select', categoriesArray, cachedFilters.categories, 'All Categories');
    
    // Update ICAOs if changed
    updateDropdownIfChanged('airport-select', icaosArray, cachedFilters.icaos, 'All Airports');
    
    // Update callsigns if changed
    updateDropdownIfChanged('callsign-select', callsignsArray, cachedFilters.callsigns, 'All Callsigns');

  } catch (err) {
    console.error("Failed to load log filters", err);
  }
}

// Helper function to update dropdown only if values changed
function updateDropdownIfChanged(selectId, newValues, cachedSet, defaultLabel) {
  const select = document.getElementById(selectId);
  if (!select) {
    console.warn('updateDropdownIfChanged: select element not found -', selectId);
    return;
  }

  // Ensure newValues is an array
  if (!Array.isArray(newValues)) {
    console.warn('updateDropdownIfChanged: newValues is not an array for', selectId, newValues);
    newValues = [];
  }

  // Check if there are new values
  const newSet = new Set(newValues);
  const hasChanges = newSet.size !== cachedSet.size || 
                     [...newSet].some(function(v) { return !cachedSet.has(v); }); // ✅ Use function instead of arrow

  // Always update if cache is empty (first load)
  if (!hasChanges && cachedSet.size > 0) return; // No changes, skip update

  // Store current selection
  const currentValue = select.value;

  // Clear and rebuild dropdown
  select.innerHTML = '<option value="">' + defaultLabel + '</option>';

  newValues.forEach(function(value) { // ✅ Use function instead of arrow
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });

  // Restore previous selection if it still exists
  if (currentValue && newSet.has(currentValue)) {
    select.value = currentValue;
  }

  // Update cache
  cachedSet.clear();
  newSet.forEach(function(v) { cachedSet.add(v); }); // ✅ Use function instead of arrow
}

// Fetch logs from server and render into the log area
// Fetch filtered logs
let currentPage = 1;
let isLoading = false;
let hasMore = true;

async function fetchFilteredLogs(reset = false) {
  if (isLoading) {
    return;
  }

  if (reset) {
    currentPage = 1;
    hasMore = true;
    const logContent = document.getElementById('logContent');
    if (logContent) {
      logContent.innerHTML = '';
    } else {
      console.error("fetchFilteredLogs: logContent element not found");
    }
  }

  isLoading = true;

  const levelSelect = document.getElementById('level-select');
  const categorySelect = document.getElementById('category-select');
  const icaoSelect = document.getElementById('airport-select');
  const callsignSelect = document.getElementById('callsign-select');
  
  if (!levelSelect || !categorySelect || !icaoSelect || !callsignSelect) {
    console.error("fetchFilteredLogs: Filter elements not found", {
      levelSelect: !!levelSelect,
      categorySelect: !!categorySelect,
      icaoSelect: !!icaoSelect,
      callsignSelect: !!callsignSelect
    });
    isLoading = false;
    return;
  }
  
  const level = levelSelect.value || '';
  const category = categorySelect.value || '';
  const icao = icaoSelect.value || '';
  const callsign = callsignSelect.value || '';
  
  const params = new URLSearchParams();
  if (level) params.append('level', String(level));
  if (category) params.append('category', String(category));
  if (icao) params.append('icao', String(icao));
  if (callsign) params.append('callsign', String(callsign));
  params.append('page', String(currentPage));
  params.append('pageSize', '100');

  try {
    const url = API_BASE_URL + "/api/logs/filter?" + params.toString();
    
    const response = await fetch(url, {
      headers: { "X-Internal-Request": "1" }
    });
    
    if (!response.ok) {
      throw new Error("HTTP " + response.status + ": " + response.statusText);
    }
    
    const data = await response.json();

    if (data.logs && Array.isArray(data.logs)) {
      // Reverse logs so newest is at bottom
      const reversedLogs = [...data.logs].reverse();
      
      if (reset || currentPage === 1) {
        // Replace all logs on reset or first page
        replaceLogs(reversedLogs);
      } else {
        // Prepend older logs when scrolling up
        prependLogs(reversedLogs);
      }
    } else {
      console.warn('No logs in response or logs is not an array:', data);
    }

    if (data.pagination) {
      hasMore = currentPage < data.pagination.totalPages;
      if (!reset) currentPage++;
    } else {
      hasMore = false;
    }
  } catch (err) {
    console.error('Failed to fetch logs:', err);
  } finally {
    isLoading = false;
  }
}

function createLogElement(log) {
  const logEntry = document.createElement('div');
  const levelLower = String(log.level).toLowerCase();
  logEntry.className = "log-entry log-" + levelLower;
  
  const timestamp = new Date(log.timestamp).toLocaleString();
  const level = String(log.level);
  const message = String(log.message);
  
  logEntry.innerHTML = 
    '<span class="log-timestamp">' + timestamp + '</span>' +
    '<span class="log-level">[' + level + ']</span>' +
    '<span class="log-message">' + message + '</span>';
  
  logEntry.dataset.timestamp = log.timestamp; // Track uniqueness
  return logEntry;
}

function replaceLogs(logs) {
  const logContent = document.getElementById('logContent');
  if (!logContent) return;

  if (!Array.isArray(logs)) {
    console.warn('replaceLogs: logs is not an array', logs);
    return;
  }

  logContent.innerHTML = '';
  
  logs.forEach(log => {
    logContent.appendChild(createLogElement(log));
  });

  if (autoScroll) {
    scrollToBottom();
  }
}

function prependLogs(logs) {
  const logContent = document.getElementById('logContent');
  const logContainer = document.getElementById('logContainer');
  if (!logContent || !logContainer) return;

  if (!Array.isArray(logs)) {
    console.warn('prependLogs: logs is not an array', logs);
    return;
  }

  // Save scroll position before prepending
  const previousScrollHeight = logContainer.scrollHeight;
  const previousScrollTop = logContainer.scrollTop;

  const fragment = document.createDocumentFragment();
  logs.forEach(log => {
    fragment.appendChild(createLogElement(log));
  });

  logContent.insertBefore(fragment, logContent.firstChild);

  // Restore scroll position to maintain user's view
  const newScrollHeight = logContainer.scrollHeight;
  logContainer.scrollTop = previousScrollTop + (newScrollHeight - previousScrollHeight);
}

function appendLogs(logs) {
  const logContent = document.getElementById('logContent');
  if (!logContent) return;

  if (!Array.isArray(logs)) {
    console.warn('appendLogs: logs is not an array', logs);
    return;
  }

  // Get existing timestamps to avoid duplicates
  const existingTimestamps = new Set(
    Array.from(logContent.children).map(el => el.dataset.timestamp)
  );

  logs.forEach(log => {
    // Only add if not already present
    if (!existingTimestamps.has(log.timestamp)) {
      logContent.appendChild(createLogElement(log));
    }
  });

  // Only scroll to bottom if auto-scroll is enabled
  if (autoScroll) {
    requestAnimationFrame(() => {
      scrollToBottom();
    });
  }
}

// Infinite scroll on logContainer - load older logs when scrolling up
// This will be set up after DOM is ready

function updateLogDisplay(logs) {
  const logContent = document.getElementById("logContent");
  if (!logContent) return;

  logContent.innerHTML = "";

  logs.forEach((entry) => {
    const level = entry.level || "INFO";
    const logDiv = document.createElement("div");
    const levelLower = String(level).toLowerCase();
    logDiv.className = "log-entry log-" + levelLower;
    
    const timestamp = new Date(entry.timestamp).toLocaleTimeString();
    const message = String(entry.message);
    
    logDiv.innerHTML = 
      '<span class="log-timestamp">' + timestamp + '</span>' +
      '<span class="log-level">[' + level + ']</span>' +
      '<span class="log-message">' + message + '</span>';
    
    logContent.appendChild(logDiv);
  });

  if (autoScroll) {
    scrollToBottom();
  }
}

function toggleAutoScroll() {
  autoScroll = !autoScroll;
  const button = document.getElementById("toggleAutoScroll");
  const text = autoScroll ? "Auto-Scroll: ON" : "Auto-Scroll: OFF";
  button.textContent = text;

  if (autoScroll) {
    scrollToBottom();
  }
}

function scrollToBottom() {
  const logContainer = document.getElementById("logContainer");
  if (logContainer) {
    logContainer.scrollTop = logContainer.scrollHeight;
  }
}

// Initial render and periodic refresh
document.addEventListener("DOMContentLoaded", () => {
  renderAirportsStatus();
  renderConfigButtons();
  
  // Initial log setup
  populateLogFilters();
  fetchFilteredLogs();
  
  // Set up infinite scroll on logContainer
  const logContainer = document.getElementById('logContainer');
  if (logContainer) {
    logContainer.addEventListener('scroll', (e) => {
      const element = e.target;
      
      // Check if user is at the bottom
      const isAtBottom = element.scrollHeight - element.scrollTop <= element.clientHeight + 50;
      
      if (isAtBottom) {
        // Re-enable auto-scroll when at bottom
        if (!autoScroll) {
          autoScroll = true;
          const button = document.getElementById("toggleAutoScroll");
          if (button) button.textContent = 'Auto-scroll: ON';
        }
      } else {
        // Disable auto-scroll when scrolling up
        if (autoScroll) {
          autoScroll = false;
          const button = document.getElementById("toggleAutoScroll");
          if (button) button.textContent = 'Auto-scroll: OFF';
        }
      }
      
      // Load older logs when scrolling near the top
      if (element.scrollTop <= 100 && hasMore && !isLoading) {
        fetchFilteredLogs();
      }
    });
  }
  
  // Set up filter change listeners
  const levelSelect = document.getElementById('level-select');
  const airportSelect = document.getElementById('airport-select');
  const callsignSelect = document.getElementById('callsign-select');
  const categorySelect = document.getElementById('category-select');
  
  if (levelSelect) levelSelect.addEventListener('change', () => fetchFilteredLogs(true));
  if (airportSelect) airportSelect.addEventListener('change', () => fetchFilteredLogs(true));
  if (callsignSelect) callsignSelect.addEventListener('change', () => fetchFilteredLogs(true));
  if (categorySelect) categorySelect.addEventListener('change', () => fetchFilteredLogs(true));
  
  setInterval(renderAirportsStatus, 10000);
  setInterval(populateLogFilters, 5000);
  
  // Fetch new logs periodically - only if auto-scroll is enabled
  setInterval(() => {
    if (!isLoading && autoScroll) {
      // Only fetch latest logs when user wants auto-scroll
      currentPage = 1;
      hasMore = true;
      fetchFilteredLogs(false);
    }
  }, 2000);
});

// Event listeners for filter changes are now set up inside DOMContentLoaded

// Navigation routing - wrapped to execute after DOM is ready
(function () {
  function initNavigation() {
    const sections = Array.from(document.querySelectorAll("section[data-page]"));
    const navLinks = Array.from(
      document.querySelectorAll('.sidenav a[href^="#"]')
    );

    function showPage(page) {
      sections.forEach((s) => {
        s.style.display = s.dataset.page === page ? "" : "none";
      });
      navLinks.forEach((a) => {
        a.classList.toggle("active", a.getAttribute("href") === "#" + page);
      });
      // ensure map renders correctly when its section becomes visible
      if (page === "standMap" && typeof map !== "undefined" && map) {
        // small delay to allow layout to settle
        setTimeout(() => {
          try {
            map.invalidateSize();
          } catch (e) {
            /* ignore if not ready */
          }
        }, 100);
      }

      // ensure statistics chart is initialised/updated when the section becomes visible
      if (page === "statistics") {
        // small delay so layout settles and canvas has non-zero size
        setTimeout(() => {
          if (typeof refreshStatsChart === "function") refreshStatsChart();
        }, 150);
      }

      // optional: scroll to top of content area
      window.scrollTo(0, 0);
    }

    function route() {
      const hash = location.hash.replace("#", "") || "status";
      showPage(hash);
    }

    // initialize
    window.addEventListener("hashchange", route);
    route(); // Call route immediately after setup
  }

  // Wait for DOM to be ready before initializing navigation
  if (document.readyState === 'loading') {
    document.addEventListener("DOMContentLoaded", initNavigation);
  } else {
    initNavigation();
  }
})();

// Map initialization - will be set up after DOM is ready
var stands = []; // make stands accessible to updateMarkerSizes
var map; // Declare map variable but don't initialize yet
var airports = []; // will be filled after fetch
var initialBounds = null; // Store the initial bounds

let occupiedStands = [];
let assignedStands = [];
let blockedStands = [];

function fetchOccupiedStands() {
  fetch(API_BASE_URL + "/api/occupancy/occupied", { headers: { "X-Internal-Request": "1" } })
    .then((res) => {
      if (!res.ok) throw new Error("Network response was not ok");
      return res.json();
    })
    .then((stands) => {
      if (Array.isArray(stands)) {
        // Store as ICAO-StandName format instead of just name
        occupiedStands = stands.map((s) => s.icao + "-" + s.name);
      }
    })
    .catch((err) => {
      console.error("Failed to load occupied stands", err);
    });
}

function fetchAssignedStands() {
  fetch(API_BASE_URL + "/api/occupancy/assigned", { headers: { "X-Internal-Request": "1" } })
    .then((res) => {
      if (!res.ok) throw new Error("Network response was not ok");
      return res.json();
    })
    .then((stands) => {
      if (Array.isArray(stands)) {
        // Store as ICAO-StandName format instead of just name
        assignedStands = stands.map((s) => s.icao + "-" + s.name);
      }
    })
    .catch((err) => {
      console.error("Failed to load assigned stands", err);
    });
}

function fetchBlockedStands() {
  fetch(API_BASE_URL + "/api/occupancy/blocked", { headers: { "X-Internal-Request": "1" } })
    .then((res) => {
      if (!res.ok) throw new Error("Network response was not ok");
      return res.json();
    })
    .then((stands) => {
      if (Array.isArray(stands)) {
        // Store as ICAO-StandName format instead of just name
        blockedStands = stands.map((s) => s.icao + "-" + s.name);
      }
    })
    .catch((err) => {
      console.error("Failed to load blocked stands", err);
    });
}

function getStandColor(standName, apron) {
  // Now both standName and the arrays are in ICAO-StandName format
  if (occupiedStands.includes(standName)) {
    return ["#B22222", "#FF6B6B"]; // dark red border, light red fill (occupied)
  }

  if (assignedStands.includes(standName)) {
    return ["#005864ff", "#3a91acff"]; // dark blue border, light blue fill (assigned)
  }

  if (blockedStands.includes(standName)) {
    return ["#9c7c22ff", "#cdc54eff"]; // dark teal border, light teal fill (blocked)
  }

  if (apron) {
    return ["#4682B4", "#87CEEB"]; // steel blue border, sky blue fill (apron)
  }

  return ["#78BFA0", "#96CEB4"]; // darker green border, light green fill (default)
}

// Map variables and constants
var zoomThreshold = 5; // <= show meter circle, > show screen-sized marker
var zoomHideThreshold = 13; // > hide marker entirely
var meterRadius = 50000; // meters for the L.Circle when zoomed out
var labelZoomThreshold = 17; // show stand labels at this zoom level and above

// updateMarkerSizes function
function updateMarkerSizes() {
  if (!Array.isArray(airports) || airports.length === 0) return;
  const z = map.getZoom();

  airports.forEach((airport) => {
    if (!airport) return;
    const circle = airport.circle;
    const marker = airport.marker;

    const circleOnMap = circle && map.hasLayer ? map.hasLayer(circle) : false;
    const markerOnMap = marker && map.hasLayer ? map.hasLayer(marker) : false;

    if (z > zoomHideThreshold) {
      // hide everything at very high zoom
      if (markerOnMap && marker) map.removeLayer(marker);
      if (circleOnMap && circle) map.removeLayer(circle);
    } else if (z <= zoomThreshold) {
      // show meter-based circle, hide pixel marker
      if (circle && !circleOnMap) circle.addTo(map);
      if (markerOnMap && marker) map.removeLayer(marker);
    } else {
      // show pixel marker, hide meter circle
      if (marker && !markerOnMap) marker.addTo(map);
      if (circleOnMap && circle) map.removeLayer(circle);
    }
  });

  // toggle stand labels (if you keep stands array accessible)
  if (Array.isArray(stands) && stands.length) {
    stands.forEach((stand) => {
      const label = stand.label;
      const labelOnMap = label && map.hasLayer ? map.hasLayer(label) : false;
      if (z >= labelZoomThreshold) {
        if (label && !labelOnMap) label.addTo(map);
      } else {
        if (labelOnMap && label) map.removeLayer(label);
      }
    });
  }
}
// map.on("zoomend", updateMarkerSizes); // Moved to initializeMap()

// Home button control and map.whenReady moved to initializeMap()

// Configs page
// generate buttons for available config presets
function renderConfigButtons() {
  const container = document.getElementById("configButtonContainer");
  if (!container) return;
  container.innerHTML = "<p>Loading presets...</p>";
  fetch(API_BASE_URL + "/api/airports", { headers: { "X-Internal-Request": "1" } })
    .then((res) => {
      if (!res.ok) throw new Error("Network response was not ok");
      return res.json();
    })
    .then((presets) => {
      container.innerHTML = "";
      if (!Array.isArray(presets) || presets.length === 0) {
        container.innerHTML = "<p>No presets available.</p>";
        return;
      }
      presets.forEach((preset) => {
        const button = document.createElement("button");
        button.className = "configButton";
        button.textContent = preset.name;
        button.setAttribute("aria-label", "Load config " + preset.name);
        button.onclick = () => loadConfig(preset.name);
        container.appendChild(button);
      });
    })
    .catch((error) => {
      console.error("Error fetching config presets:", error);
      container.innerHTML = "<p>Error loading presets.</p>";
    });
}

function syntaxHighlight(json) {
  if (typeof json != "string") {
    json = JSON.stringify(json, null, 2);
  }
  json = json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return json.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    function (match) {
      let cls = "json-number";
      if (/^"/.test(match)) {
        if (/:$/.test(match)) {
          cls = "json-key";
        } else {
          cls = "json-string";
        }
      } else if (/true|false/.test(match)) {
        cls = "json-boolean";
      } else if (/null/.test(match)) {
        cls = "json-null";
      }
      return '<span class="' + cls + '">' + match + '</span>';
    }
  );
}

function loadConfig(presetName) {
  if (!presetName) return;
  fetch(API_BASE_URL + "/api/airports/config/" + encodeURIComponent(presetName), {
    method: "GET",
    headers: { "X-Internal-Request": "1" },
  })
    .then((res) => {
      if (!res.ok) throw new Error("Network response was not ok");
      return res.json();
    })
    .then((data) => {
      // load config json text into pre code of id configCode
      const code = document.getElementById("configCode");
      if (code) {
        code.innerHTML = syntaxHighlight(data);
      }
    })
    .catch((error) => {
      console.error("Error loading config preset:", error);
    });
}

// Initialize map after DOM is ready
function initializeMap() {
  // Check if Leaflet is loaded
  if (typeof L === 'undefined') {
    console.error("initializeMap: Leaflet (L) is not loaded. Make sure leaflet.js is included before this script.");
    return;
  }

  // Check if map element exists
  const mapElement = document.getElementById("map");
  if (!mapElement) {
    console.error("initializeMap: Map element not found, skipping map initialization");
    return;
  }

  try {
    // Initialize Leaflet map
    map = L.map("map", {
      maxZoom: 19,
    }).setView([47.009279, 3.765732], 6);

  // Add satellite tile layer
  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      attribution:
        "Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community",
      maxZoom: 19,
    }
  ).addTo(map);

  // Add legend
  var legend = L.control({ position: "topright" });
  legend.onAdd = function (map) {
    var div = L.DomUtil.create("div", "legend");
    div.innerHTML =
      "<h4>Stands Legend</h4>" +
      '<i style="background:#FFFFFF; width:18px; height:18px; display:inline-block; margin-right:8px; opacity:0.7; border-radius:50%; border: 1px solid #CCCCCC;"></i> Airport<br>' +
      '<i style="background:#96CEB4; width:18px; height:18px; display:inline-block; margin-right:8px; opacity:0.7; border-radius:50%; border: 1px solid #CCCCCC;"></i> Free<br>' +
      '<i style="background:#cdc54eff; width:18px; height:18px; display:inline-block; margin-right:8px; opacity:0.7; border-radius:50%; border: 1px solid #CCCCCC;"></i> Blocked<br>' +
      '<i style="background:#3a91acff; width:18px; height:18px; display:inline-block; margin-right:8px; opacity:0.7; border-radius:50%; border: 1px solid #CCCCCC;"></i> Assigned<br>' +
      '<i style="background:#FF6B6B; width:18px; height:18px; display:inline-block; margin-right:8px; opacity:0.7; border-radius:50%; border: 1px solid #CCCCCC;"></i> Occupied<br><br>';
    L.DomEvent.disableClickPropagation(div);
    return div;
  };
  legend.addTo(map);

  // Initial fetch and periodic refresh for stand status
  fetchOccupiedStands();
  fetchAssignedStands();
  fetchBlockedStands();
  setInterval(fetchOccupiedStands, 10000);
  setInterval(fetchAssignedStands, 10000);
  setInterval(fetchBlockedStands, 10000);

  // Add map event handlers
  map.on("zoomend", updateMarkerSizes);

  // Store initial bounds when ready
  map.whenReady(function () {
    initialBounds = map.getBounds();
  });

  // Add home control
  var HomeControl = L.Control.extend({
    onAdd: function (map) {
      var container = L.DomUtil.create(
        "div",
        "leaflet-bar leaflet-control leaflet-control-custom"
      );

      container.style.backgroundColor = "white";
      container.style.backgroundImage =
        "url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Im0zIDkgOS03IDkgN3YxMWgtNnYtNGgtNnY0aC02eiIvPjwvc3ZnPg==')";
      container.style.backgroundSize = "16px 16px";
      container.style.backgroundPosition = "center";
      container.style.backgroundRepeat = "no-repeat";
      container.style.width = "30px";
      container.style.height = "30px";
      container.style.cursor = "pointer";
      container.title = "Return to initial view";

      container.onclick = function () {
          map.setView([47.009279, 3.765732], 6, { animate: true });
      };

      L.DomEvent.disableClickPropagation(container);
      return container;
    },
    onRemove: function (map) {}
  });

  var homeControl = new HomeControl({ position: "topleft" });
  homeControl.addTo(map);

    // Load stands and airports data
    loadMapData();
  } catch (error) {
    console.error("Failed to initialize map:", error);
  }
}

function loadMapData() {
  // Draw stands on map
  fetch(API_BASE_URL + "/api/airports/stands", { headers: { "X-Internal-Request": "1" } })
    .then((res) => {
      if (!res.ok) throw new Error("Network response was not ok");
      return res.json();
    })
    .then((data) => {
      if (!Array.isArray(data))
        throw new Error("Stands response is not an array");
      
      stands = data.filter((s) => {
        return (
          Array.isArray(s.coords) &&
          s.coords.length === 2 &&
          Number.isFinite(s.coords[0]) &&
          Number.isFinite(s.coords[1])
        );
      });

      if (stands.length === 0) {
        console.warn(
          "No valid stand coordinates found in /api/airports/stands response",
          data
        );
      } else {
        stands.forEach((stand) => {
          const color = getStandColor(stand.name, stand.apron);
          stand.circle = L.circle(stand.coords, {
            color: color[0],
            fillColor: color[1],
            fillOpacity: 0.8,
            radius: stand.radius,
            weight: 3,
          }).bindPopup("<strong>" + stand.name + "</strong>");

          stand.label = L.marker(stand.coords, {
            interactive: false,
            icon: L.divIcon({
              className: "stand-label",
              html: "<span>" + stand.name + "</span>",
            }),
          });

          stand.circle.addTo(map);
        });
      }
    })
    .catch((err) => {
      console.error("Failed to load stands on Map", err);
    });

  // Update stand colors periodically
  setInterval(() => {
    if (!Array.isArray(stands) || stands.length === 0) return;
    stands.forEach((stand) => {
      if (!stand || !stand.circle) return;
      const color = getStandColor(stand.name, stand.apron);
      stand.circle.setStyle({
        color: color[0],
        fillColor: color[1],
      });
    });
  }, 10000);

  // Draw airports on map
  fetch(API_BASE_URL + "/api/airports")
    .then((res) => {
      if (!res.ok) throw new Error("Network response was not ok");
      return res.json();
    })
    .then((data) => {
      if (!Array.isArray(data))
        throw new Error("Airports response is not an array");
      
      airports = data.filter((a) => {
        return (
          Array.isArray(a.coords) &&
          a.coords.length === 2 &&
          Number.isFinite(a.coords[0]) &&
          Number.isFinite(a.coords[1])
        );
      });

      if (airports.length === 0) {
        console.warn(
          "No valid airport coordinates found in /api/airports response",
          data
        );
      }

      const zoomThreshold = 5;
      const zoomHideThreshold = 13;
      const meterRadius = 50000;

      airports.forEach(function (airport) {
        airport.circle = L.circle(airport.coords, {
          color: "#505050ff",
          fillColor: "#ffffff",
          fillOpacity: 0.7,
          radius: meterRadius,
          weight: 3,
        }).bindPopup("<strong>" + airport.name + "</strong>");

        airport.marker = L.circleMarker(airport.coords, {
          color: "#505050ff",
          fillColor: "#ffffff",
          fillOpacity: 0.7,
          radius: 26,
          weight: 3,
        }).bindPopup("<strong>" + airport.name + "</strong>");

        const targetZoom = zoomHideThreshold + 1;
        const zoomAndOpen = function (layer) {
          map.setView(airport.coords, targetZoom, { animate: true });
          setTimeout(() => {
            try {
              layer.openPopup();
            } catch (e) {}
          }, 300);
        };

        airport.circle.on("click", function () {
          zoomAndOpen(airport.circle);
        });
        airport.marker.on("click", function () {
          zoomAndOpen(airport.marker);
        });

        if (map.getZoom() <= zoomThreshold) {
          airport.circle.addTo(map);
        } else {
          airport.marker.addTo(map);
        }
      });

      updateMarkerSizes();
    })
    .catch((err) => {
      console.error("Failed to load airports on Map", err);
    });
}

// Call map initialization when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeMap);
} else {
  // DOM already loaded
  initializeMap();
}
