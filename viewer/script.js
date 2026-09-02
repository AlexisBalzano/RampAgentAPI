// The viewer is served by the API itself, so same-origin is correct in every
// deployment (and makes a local docker/dev instance work without an edit here).
const API_BASE_URL = location.protocol.startsWith("http")
  ? location.origin
  : "https://rampagent.vatsim.fr";

/* Set the width of the side navigation to 250px */
function openNav() {
  const nav = document.getElementById("mySidenav");
  if (!nav) return; // guard
  nav.style.width = "200px";
}

/* Set the width of the side navigation to 0 */
function closeNav() {
  const nav = document.getElementById("mySidenav");
  if (!nav) return; // guard
  nav.style.width = "0";
}

document.addEventListener("click", function (event) {
  if (event.x <= 200) return;
  const sidenav = document.getElementById("mySidenav");
  if (sidenav && sidenav.style.width !== "0") {
    if (!sidenav.contains(event.target)) {
      closeNav();
    }
  }
});

// Dark mode toggle
function toggleDarkMode() {
  document.body.classList.toggle("dark-mode");
  const isDarkMode = document.body.classList.contains("dark-mode");
  localStorage.setItem("darkMode", isDarkMode ? "enabled" : "disabled");

  // Switch map layer
  if (typeof window.switchMapLayer === "function") {
    window.switchMapLayer();
  }
  updateChartColors(isDarkMode);
}

document.addEventListener("DOMContentLoaded", function () {
  // Check localStorage for dark mode preference
  const darkMode = localStorage.getItem("darkMode");

  // Restore manual performance-mode preference from previous session
  const performanceModeStored = localStorage.getItem("performanceModeManual");
  manualToggle = performanceModeStored === "true";
  if (manualToggle) {
    enablePerformanceMode();
  }

  if (darkMode === "enabled") {
    document.body.classList.add("dark-mode");
  }

  // Switch map layer after map is initialized
  setTimeout(() => {
    if (typeof window.switchMapLayer === "function") {
      window.switchMapLayer();
    }
  }, 100);

  checkAuthAndUpdateUI();
  updateApiKeyCount();
});

// High volume detection and performance mode
let performanceMode = false;
let lastStandCount = 0;
// Number of stands that triggers performance mode. This used to be 50 because
// every refresh re-created and re-animated the whole board; now only rows that
// actually changed flip, so the cost tracks churn rather than total volume and
// the flap effect stays affordable far higher up.
const HIGH_VOLUME_THRESHOLD = 1000;

function checkVolumeAndTogglePerformanceMode(standCount) {
  let shouldBeInPerformanceMode = standCount >= HIGH_VOLUME_THRESHOLD;
  if (window.innerWidth < 700) {
    // Mobiles always in performance mode since lower power
    shouldBeInPerformanceMode = true;
  }

  lastStandCount = standCount;

  if (shouldBeInPerformanceMode && !performanceMode) {
    enablePerformanceMode();
  } else if (!shouldBeInPerformanceMode && performanceMode && !manualToggle) {
    disablePerformanceMode();
  }
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
  const existingNotification = document.querySelector(
    ".performance-notification"
  );
  if (existingNotification) {
    existingNotification.remove();
  }

  const notification = document.createElement("div");
  notification.className = "performance-notification";
  notification.textContent = enabled
    ? "⚡ Performance Mode: Animations disabled (" + lastStandCount + " stands)"
    : "✓ Performance Mode: Animations re-enabled";
  document.body.appendChild(notification);

  setTimeout(() => {
    notification.style.opacity = "0";
    setTimeout(() => notification.remove(), 500);
  }, 3000);
}

let manualToggle = false;

function togglePerformanceModeManual() {
  if (performanceMode) {
    disablePerformanceMode();
    localStorage.setItem("performanceModeManual", "false");
    manualToggle = false;
  } else {
    enablePerformanceMode();
    localStorage.setItem("performanceModeManual", "true");
    manualToggle = true;
  }
  updatePerformanceToggleButton();
}

function updatePerformanceToggleButton() {
  const button = document.getElementById("performanceModeToggle");
  if (button) {
    if (performanceMode) {
      button.classList.add("active");
      button.title = "Performance Mode: ON (Click to disable)";
    } else {
      button.classList.remove("active");
      button.title = "Performance Mode: OFF (Click to enable)";
    }
  }
}

// Status page

function generateSpanforText(text) {
  const departureBoard = document.createElement("div");
  departureBoard.className = "departure-board";
  const chars = Array.from(text);
  const blanksNeeded = 15 - chars.length;
  for (let i = 0; i < blanksNeeded; i++) {
    chars.push(" ");
  }
  const fragment = document.createDocumentFragment();
  chars.forEach((char, index) => {
    const charSpan = document.createElement("span");
    if (char === " ") {
      charSpan.className = "letter letter-blank";
    } else {
      charSpan.className = "letter letter-" + char.toUpperCase();
    }
    fragment.appendChild(charSpan);
  });
  departureBoard.appendChild(fragment);
  // Publishing the letter count lets the board carry a definite width, so it
  // can be skipped while off-screen without its size collapsing (which would
  // take the min-content width of the whole panel with it).
  departureBoard.style.setProperty("--letters", chars.length);
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

// Page visibility ---------------------------------------------------------
// Every page used to poll on its own timer regardless of what was on screen,
// so sitting on the status page also paid for the map, the log tail and the
// stats charts. Pollers now run only for the page actually being looked at,
// and fire immediately when you navigate to it.

let activePage = location.hash.replace("#", "") || "status";
const pageEnterHandlers = new Map(); // page -> [fn]

function isPageActive(page) {
  return activePage === page && !document.hidden;
}

/** Runs fn every ms, but only while `page` is the one on screen. */
function pollOnPage(page, fn, ms) {
  setInterval(() => {
    if (isPageActive(page)) fn();
  }, ms);
}

/** Runs fn each time `page` becomes the active page. */
function onPageEnter(page, fn) {
  const handlers = pageEnterHandlers.get(page);
  if (handlers) handlers.push(fn);
  else pageEnterHandlers.set(page, [fn]);
}

// Runs on navigation regardless of document visibility: arriving at a page
// should show current data even if the tab is not in the foreground yet.
function firePageEnter(page) {
  const handlers = pageEnterHandlers.get(page);
  if (!handlers) return;
  for (const fn of handlers) {
    try {
      fn();
    } catch (err) {
      console.error("page enter handler failed for " + page, err);
    }
  }
}

// Coming back to a backgrounded tab should refresh whatever is on screen.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) firePageEnter(activePage);
});

// One persistent panel per airport. Rows are reconciled against what is
// already on screen and keyed by their rendered text, so an unchanged row is
// never touched: no DOM work, and no flap animation. Only rows that actually
// appeared flip, which is both far cheaper and closer to how a real split-flap
// board behaves.
const statusPanels = new Map(); // ICAO -> { root, sections: { kind -> sectionState } }
const STATUS_SECTIONS = [
  ["occupied", "Occupied Stands"],
  ["assigned", "Assigned Stands"],
  ["blocked", "Blocked Stands"],
];

function standLine(stand) {
  return padStandName(stand.name) + "  " + stand.callsign;
}

// `animate: false` marks the board so its letters never flip - used for the
// first paint, where there is no previous value to flip away from.
function makeBoard(text, animate) {
  const board = generateSpanforText(text);
  if (!animate) board.classList.add("no-flip");
  return board;
}

function createAirportPanel(icao) {
  const root = document.createElement("div");
  root.className = "airport-display subContainer";
  root.id = "airport-" + icao;
  root.appendChild(makeBoard(padAirportIcao(icao), false));

  const sections = {};
  for (const [kind, title] of STATUS_SECTIONS) {
    root.appendChild(generateSeparator());
    root.appendChild(makeBoard(title, false));
    root.appendChild(generateSeparator());

    // display:contents, so the wrapper groups rows for reconciliation without
    // affecting the panel's flex layout.
    const body = document.createElement("div");
    body.className = "status-rows";
    root.appendChild(body);
    sections[kind] = { body, rows: new Map(), primed: false };
  }

  return { root, sections };
}

/**
 * Keyed reconciliation: reuse a row element for every text still present, drop
 * the rest, and move survivors into place. When nothing changed this walks the
 * sibling list and performs zero DOM writes.
 */
function reconcileRows(section, texts) {
  const pool = section.rows;
  const nextRows = new Map();
  const ordered = [];

  for (const text of texts) {
    const bucket = pool.get(text);
    let el;
    if (bucket && bucket.length) {
      el = bucket.pop();
      if (bucket.length === 0) pool.delete(text);
    } else {
      el = makeBoard(text, section.primed);
    }
    ordered.push(el);
    const kept = nextRows.get(text);
    if (kept) kept.push(el);
    else nextRows.set(text, [el]);
  }

  for (const bucket of pool.values()) {
    for (const el of bucket) el.remove();
  }

  const body = section.body;
  let node = body.firstChild;
  for (const el of ordered) {
    if (node === el) {
      node = node.nextSibling;
      continue;
    }
    body.insertBefore(el, node);
  }

  section.rows = nextRows;
  section.primed = true;
}

const byStandName = (a, b) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * One snapshot of every airport with its stands bucketed by state. Shared by
 * the status board and the statistics chart, which never run at the same time
 * because polling follows the visible page.
 */
async function fetchOccupancySnapshot() {
  const headers = { "X-Internal-Request": "1" };
  const json = (path) =>
    fetch(API_BASE_URL + path, { headers })
      .then((res) => res.json())
      .catch(() => []);

  // Four independent reads: issue them together instead of chaining awaits.
  const [airportList, occupiedStands, assignedStands, blockedStands] =
    await Promise.all([
      json("/api/airports"),
      json("/api/occupancy/occupied"),
      json("/api/occupancy/assigned"),
      json("/api/occupancy/blocked"),
    ]);

  const airports = {};
  airportList.forEach((airport) => {
    airports[airport.name] = {
      name: airport.name,
      standCount: airport.standCount || 0,
      occupied: [],
      assigned: [],
      blocked: [],
    };
  });
  const bucket = (list, kind) =>
    list.forEach((stand) => {
      const airport = airports[stand.icao];
      if (airport) airport[kind].push(stand);
    });
  bucket(occupiedStands, "occupied");
  bucket(assignedStands, "assigned");
  bucket(blockedStands, "blocked");

  return {
    airports,
    total: occupiedStands.length + assignedStands.length + blockedStands.length,
  };
}

async function renderAirportsStatus() {
  try {
    const { airports, total } = await fetchOccupancySnapshot();

    // Check volume and toggle performance mode
    checkVolumeAndTogglePerformanceMode(total);

    const statusContainer = document.getElementById("status-container");
    if (!statusContainer) {
      console.error("renderAirportsStatus: status-container not found");
      return;
    }

    // Drop panels for airports that are no longer served.
    for (const [icao, panel] of statusPanels) {
      if (!airports[icao]) {
        panel.root.remove();
        statusPanels.delete(icao);
      }
    }

    for (const [icao, stands] of Object.entries(airports)) {
      let panel = statusPanels.get(icao);
      if (!panel) {
        panel = createAirportPanel(icao);
        statusPanels.set(icao, panel);
        statusContainer.appendChild(panel.root);
      }

      for (const [kind] of STATUS_SECTIONS) {
        // Sorted by stand name so rows keep a stable position between polls -
        // an arrival in the middle then moves one row instead of shifting all.
        const texts =
          stands[kind].length === 0
            ? ["None"]
            : stands[kind].slice().sort(byStandName).map(standLine);
        reconcileRows(panel.sections[kind], texts);
      }
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
    headers: { "X-Internal-Request": "1" },
  });
  if (!res.ok) {
    console.warn(
      "fetchReportsPerHour -> network not ok",
      res.status,
      await res.text()
    );
    throw new Error("Failed to fetch stats");
  }
  const json = await res.json();
  return json;
}

async function fetchRequestsPerHour() {
  const res = await fetch(API_BASE_URL + "/api/stats/requests-per-hour", {
    headers: { "X-Internal-Request": "1" },
  });
  if (!res.ok) {
    console.warn(
      "fetchRequestsPerHour -> network not ok",
      res.status,
      await res.text()
    );
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

function updateChartColors(isDarkMode) {
  const gridColor = isDarkMode ? "#ccc" : "#595959";
  const axisTextColor = isDarkMode ? "#ccc" : "#333";
  const legendTextColor = isDarkMode ? "#ccc" : "#333";

  // Update reports chart if it exists
  if (reportsChart) {
    // Update grid colors
    reportsChart.options.scales.x.grid.color = gridColor;
    reportsChart.options.scales.y.grid.color = gridColor;

    // Update tick colors
    reportsChart.options.scales.x.ticks.color = axisTextColor;
    reportsChart.options.scales.y.ticks.color = axisTextColor;

    // Update legend color
    reportsChart.options.plugins.legend.labels.color = legendTextColor;

    reportsChart.update("active");
  }

  // Update airport chart if it exists
  if (airportChart) {
    airportChart.options.plugins.legend.labels.color = legendTextColor;
    airportChart.options.scales.x.grid.color = gridColor;
    airportChart.options.scales.y.grid.color = gridColor;
    airportChart.options.scales.x.ticks.color = axisTextColor;
    airportChart.options.scales.y.ticks.color = axisTextColor;
    airportChart.options.scales.y.title.color = axisTextColor;
    airportChart.data.datasets[3].backgroundColor = freeStandColor();
    airportChart.update("active");
  }
}

function renderReportsChart(reportsData, requestsData = []) {
  if (!Array.isArray(reportsData)) {
    console.warn("renderReportsChart -> invalid data", reportsData);
    return;
  }

  const isDarkMode = document.body.classList.contains("dark-mode");
  const gridColor = isDarkMode ? "#666" : "#ddd";
  const axisTextColor = isDarkMode ? "#ccc" : "#333";
  const legendTextColor = isDarkMode ? "#ccc" : "#333";

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
            backgroundColor: "#30a9d8",
            borderColor: "#3997bdff",
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

// Stand occupancy per airport: a vertical stacked bar per airport where the
// full column is that airport's stand count, so assigned and blocked are read
// against capacity rather than as bare numbers.
const OCCUPANCY_SERIES = [
  { key: "occupied", label: "Occupied", color: "#36e695" },
  { key: "assigned", label: "Assigned", color: "#30a9d8" },
  { key: "blocked", label: "Blocked", color: "#e6a336" },
  { key: "free", label: "Free", color: null }, // themed, see freeStandColor()
];

// Spare capacity is a backdrop rather than a value to read off, but a single
// translucent grey disappears into the dark panel, so it follows the theme.
function freeStandColor() {
  return document.body.classList.contains("dark-mode")
    ? "rgba(190, 196, 202, 0.32)"
    : "rgba(118, 124, 130, 0.26)";
}

// Capacity ranges from 18 stands to 450, so plotting raw counts lets the
// biggest airport flatten everything else. "share" normalises each column to
// 100% of that airport's stands, which is the comparison worth making; "count"
// keeps absolute numbers. Either way the tooltip carries both.
let occupancyChartMode =
  localStorage.getItem("occupancyChartMode") === "count" ? "count" : "share";

function buildOccupancySeries(airports) {
  const rows = Object.values(airports)
    .filter((a) => a.standCount > 0)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    labels: rows.map((a) => a.name),
    totals: rows.map((a) => a.standCount),
    values: OCCUPANCY_SERIES.map((series) =>
      rows.map((a) => {
        if (series.key !== "free") return a[series.key].length;
        const used = a.occupied.length + a.assigned.length + a.blocked.length;
        // Clamp: blocked stands can in principle be counted alongside a stand
        // that is already spoken for, and a bar must never run past capacity.
        return Math.max(0, a.standCount - used);
      })
    ),
  };
}

function toPlotted(values, totals) {
  if (occupancyChartMode === "count") return values;
  return values.map((row) =>
    row.map((v, i) => (totals[i] ? (v / totals[i]) * 100 : 0))
  );
}

function setOccupancyChartMode(mode) {
  occupancyChartMode = mode === "count" ? "count" : "share";
  localStorage.setItem("occupancyChartMode", occupancyChartMode);

  document.querySelectorAll("[data-occupancy-mode]").forEach((btn) => {
    btn.classList.toggle(
      "active",
      btn.dataset.occupancyMode === occupancyChartMode
    );
  });

  if (!airportChart) return;
  const share = occupancyChartMode === "share";
  airportChart.data.datasets.forEach((dataset, i) => {
    dataset.data = toPlotted(airportChart.$raw, airportChart.$totals)[i];
  });
  airportChart.options.scales.y.max = share ? 100 : undefined;
  airportChart.options.scales.y.title.text = share ? "% of stands" : "Stands";
  airportChart.update();
}

function renderAirportChart(airports) {
  const canvas = document.getElementById("airportChart");
  if (!canvas) {
    console.warn("renderAirportChart -> canvas#airportChart not found");
    return;
  }
  if (typeof Chart === "undefined") {
    console.warn("renderAirportChart -> Chart is not loaded");
    return;
  }

  const { labels, totals, values } = buildOccupancySeries(airports);
  const plotted = toPlotted(values, totals);
  const share = occupancyChartMode === "share";
  const isDarkMode = document.body.classList.contains("dark-mode");
  const gridColor = isDarkMode ? "#666" : "#ddd";
  const axisTextColor = isDarkMode ? "#ccc" : "#333";

  if (airportChart) {
    airportChart.data.labels = labels;
    plotted.forEach((data, i) => {
      airportChart.data.datasets[i].data = data;
    });
    airportChart.$totals = totals;
    airportChart.$raw = values;
    airportChart.update("none");
    return;
  }

  // Absolute counts behind the plotted values, so tooltips can show both
  // whichever mode the chart is in.
  const raw = (item) => (airportChart.$raw[item.datasetIndex] || [])[item.dataIndex] || 0;

  const ctx = canvas.getContext("2d");
  airportChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labels,
      datasets: OCCUPANCY_SERIES.map((series, i) => ({
        label: series.label,
        data: plotted[i],
        backgroundColor: series.color || freeStandColor(),
        borderColor: "#5f5f5f",
        borderWidth: 1,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      scales: {
        x: {
          stacked: true,
          grid: { color: gridColor, display: false },
          ticks: { color: axisTextColor, autoSkip: false },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          max: share ? 100 : undefined,
          grid: { color: gridColor },
          ticks: { color: axisTextColor, precision: 0 },
          title: {
            display: true,
            text: share ? "% of stands" : "Stands",
            color: axisTextColor,
          },
        },
      },
      plugins: {
        legend: {
          position: "top",
          labels: { color: "#b1b1b1ff" },
        },
        tooltip: {
          callbacks: {
            title: (items) => {
              const total = (airportChart.$totals || [])[items[0].dataIndex] || 0;
              return items[0].label + " - " + total + " stands";
            },
            label: (item) => {
              const total = (airportChart.$totals || [])[item.dataIndex] || 0;
              const value = raw(item);
              const pct = total ? Math.round((value / total) * 100) : 0;
              return item.dataset.label + ": " + value + " (" + pct + "%)";
            },
            footer: (items) => {
              const i = items[0].dataIndex;
              const total = (airportChart.$totals || [])[i] || 0;
              const free = (airportChart.$raw[3] || [])[i] || 0;
              const used = total - free;
              const pct = total ? Math.round((used / total) * 100) : 0;
              return "In use: " + used + "/" + total + " (" + pct + "%)";
            },
          },
        },
      },
    },
  });
  airportChart.$totals = totals;
  airportChart.$raw = values;
}

async function refreshStatsChart() {
  try {
    // The occupancy chart used to be driven from the status page, so it stayed
    // empty if you opened statistics directly. It now fetches its own snapshot.
    const [reportsData, requestsData, snapshot] = await Promise.all([
      fetchReportsPerHour(),
      fetchRequestsPerHour(),
      fetchOccupancySnapshot().catch(() => null),
    ]);

    // Pass both datasets to the chart
    renderReportsChart(reportsData, requestsData);
    if (snapshot) renderAirportChart(snapshot.airports);

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
        reportTotal: !!reportTotal,
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
  // reflect the persisted mode on the toggle buttons
  setOccupancyChartMode(occupancyChartMode);
  // refresh every 10 seconds
  pollOnPage("statistics", refreshStatsChart, 10000);
});

// Log management
let autoScroll = true;
let cachedFilters = {
  categories: new Set(),
  icaos: new Set(),
  callsigns: new Set(),
};

// Populate dropdowns
async function populateLogFilters() {
  try {
    const [categoriesRes, icaosRes, callsignsRes] = await Promise.all([
      fetch(API_BASE_URL + "/api/logs/categories", {
        headers: { "X-Internal-Request": "1" },
      }),
      fetch(API_BASE_URL + "/api/logs/icaos", {
        headers: { "X-Internal-Request": "1" },
      }),
      fetch(API_BASE_URL + "/api/logs/callsigns", {
        headers: { "X-Internal-Request": "1" },
      }),
    ]);

    // Check responses
    if (!categoriesRes.ok || !icaosRes.ok || !callsignsRes.ok) {
      console.error("Failed to fetch log filters:", {
        categories: categoriesRes.status,
        icaos: icaosRes.status,
        callsigns: callsignsRes.status,
      });
      return;
    }

    let categories, icaos, callsigns;

    try {
      categories = await categoriesRes.json();
    } catch (e) {
      console.error("Failed to parse categories JSON:", e);
      categories = [];
    }

    try {
      icaos = await icaosRes.json();
    } catch (e) {
      console.error("Failed to parse icaos JSON:", e);
      icaos = [];
    }

    try {
      callsigns = await callsignsRes.json();
    } catch (e) {
      console.error("Failed to parse callsigns JSON:", e);
      callsigns = [];
    }

    // Ensure responses are arrays
    const categoriesArray = Array.isArray(categories) ? categories : [];
    const icaosArray = Array.isArray(icaos) ? icaos : [];
    const callsignsArray = Array.isArray(callsigns) ? callsigns : [];

    // Update categories if changed
    updateDropdownIfChanged(
      "category-select",
      categoriesArray,
      cachedFilters.categories,
      "All Categories"
    );

    // Update ICAOs if changed
    updateDropdownIfChanged(
      "airport-select",
      icaosArray,
      cachedFilters.icaos,
      "All Airports"
    );

    // Update callsigns if changed
    updateDropdownIfChanged(
      "callsign-select",
      callsignsArray,
      cachedFilters.callsigns,
      "All Callsigns"
    );
  } catch (err) {
    console.error("Failed to load log filters", err);
  }
}

// Helper function to update dropdown only if values changed
function updateDropdownIfChanged(selectId, newValues, cachedSet, defaultLabel) {
  const select = document.getElementById(selectId);
  if (!select) {
    console.warn(
      "updateDropdownIfChanged: select element not found -",
      selectId
    );
    return;
  }

  // Ensure newValues is an array
  if (!Array.isArray(newValues)) {
    console.warn(
      "updateDropdownIfChanged: newValues is not an array for",
      selectId,
      newValues
    );
    newValues = [];
  }

  // Check if there are new values
  const newSet = new Set(newValues);
  const hasChanges =
    newSet.size !== cachedSet.size ||
    [...newSet].some(function (v) {
      return !cachedSet.has(v);
    }); // ✅ Use function instead of arrow

  // Always update if cache is empty (first load)
  if (!hasChanges && cachedSet.size > 0) return; // No changes, skip update

  // Store current selection
  const currentValue = select.value;

  // Clear and rebuild dropdown
  select.innerHTML = '<option value="">' + defaultLabel + "</option>";

  newValues.forEach(function (value) {
    // ✅ Use function instead of arrow
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
  newSet.forEach(function (v) {
    cachedSet.add(v);
  }); // ✅ Use function instead of arrow
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
    const logContent = document.getElementById("logContent");
    if (logContent) {
      logContent.innerHTML = "";
    } else {
      console.error("fetchFilteredLogs: logContent element not found");
    }
  }

  isLoading = true;

  const levelSelect = document.getElementById("level-select");
  const categorySelect = document.getElementById("category-select");
  const icaoSelect = document.getElementById("airport-select");
  const callsignSelect = document.getElementById("callsign-select");

  if (!levelSelect || !categorySelect || !icaoSelect || !callsignSelect) {
    console.error("fetchFilteredLogs: Filter elements not found", {
      levelSelect: !!levelSelect,
      categorySelect: !!categorySelect,
      icaoSelect: !!icaoSelect,
      callsignSelect: !!callsignSelect,
    });
    isLoading = false;
    return;
  }

  const level = levelSelect.value || "";
  const category = categorySelect.value || "";
  const icao = icaoSelect.value || "";
  const callsign = callsignSelect.value || "";

  const params = new URLSearchParams();
  if (level) params.append("level", String(level));
  if (category) params.append("category", String(category));
  if (icao) params.append("icao", String(icao));
  if (callsign) params.append("callsign", String(callsign));
  params.append("page", String(currentPage));
  params.append("pageSize", "100");

  try {
    const url = API_BASE_URL + "/api/logs/filter?" + params.toString();

    const response = await fetch(url, {
      headers: { "X-Internal-Request": "1" },
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
      console.warn("No logs in response or logs is not an array:", data);
    }

    if (data.pagination) {
      hasMore = currentPage < data.pagination.totalPages;
      if (!reset) currentPage++;
    } else {
      hasMore = false;
    }
  } catch (err) {
    console.error("Failed to fetch logs:", err);
  } finally {
    isLoading = false;
  }
}

function createLogElement(log) {
  const logEntry = document.createElement("div");
  const levelLower = String(log.level).toLowerCase();
  logEntry.className = "log-entry log-" + levelLower;

  const timestamp = new Date(log.timestamp).toLocaleString();
  const level = String(log.level);
  const message = String(log.message);

  logEntry.innerHTML =
    '<span class="log-timestamp">' +
    timestamp +
    "</span>" +
    '<span class="log-level">[' +
    level +
    "]</span>" +
    '<span class="log-message">' +
    message +
    "</span>";

  logEntry.dataset.timestamp = log.timestamp; // Track uniqueness
  return logEntry;
}

function replaceLogs(logs) {
  const logContent = document.getElementById("logContent");
  if (!logContent) return;

  if (!Array.isArray(logs)) {
    console.warn("replaceLogs: logs is not an array", logs);
    return;
  }

  logContent.innerHTML = "";

  logs.forEach((log) => {
    logContent.appendChild(createLogElement(log));
  });

  if (autoScroll) {
    scrollToBottom();
  }
}

function prependLogs(logs) {
  const logContent = document.getElementById("logContent");
  const logContainer = document.getElementById("logContainer");
  if (!logContent || !logContainer) return;

  if (!Array.isArray(logs)) {
    console.warn("prependLogs: logs is not an array", logs);
    return;
  }

  // Save scroll position before prepending
  const previousScrollHeight = logContainer.scrollHeight;
  const previousScrollTop = logContainer.scrollTop;

  const fragment = document.createDocumentFragment();
  logs.forEach((log) => {
    fragment.appendChild(createLogElement(log));
  });

  logContent.insertBefore(fragment, logContent.firstChild);

  // Restore scroll position to maintain user's view
  const newScrollHeight = logContainer.scrollHeight;
  logContainer.scrollTop =
    previousScrollTop + (newScrollHeight - previousScrollHeight);
}

function appendLogs(logs) {
  const logContent = document.getElementById("logContent");
  if (!logContent) return;

  if (!Array.isArray(logs)) {
    console.warn("appendLogs: logs is not an array", logs);
    return;
  }

  // Get existing timestamps to avoid duplicates
  const existingTimestamps = new Set(
    Array.from(logContent.children).map((el) => el.dataset.timestamp)
  );

  logs.forEach((log) => {
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
      '<span class="log-timestamp">' +
      timestamp +
      "</span>" +
      '<span class="log-level">[' +
      level +
      "]</span>" +
      '<span class="log-message">' +
      message +
      "</span>";

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
  // Paint the board once if it is the landing page. Only polling is gated on
  // document visibility - a first render still has to happen for a tab that
  // opens in the background.
  if (activePage === "status") renderAirportsStatus();
  renderConfigButtons();

  // Initial log setup (the log page is admin-only; arriving there loads these)
  if (activePage === "log") {
    populateLogFilters();
    fetchFilteredLogs();
  }

  // Set up infinite scroll on logContainer
  const logContainer = document.getElementById("logContainer");
  if (logContainer) {
    logContainer.addEventListener("scroll", (e) => {
      const element = e.target;

      // Check if user is at the bottom
      const isAtBottom =
        element.scrollHeight - element.scrollTop <= element.clientHeight + 50;

      if (isAtBottom) {
        // Re-enable auto-scroll when at bottom
        if (!autoScroll) {
          autoScroll = true;
          const button = document.getElementById("toggleAutoScroll");
          if (button) button.textContent = "Auto-scroll: ON";
        }
      } else {
        // Disable auto-scroll when scrolling up
        if (autoScroll) {
          autoScroll = false;
          const button = document.getElementById("toggleAutoScroll");
          if (button) button.textContent = "Auto-scroll: OFF";
        }
      }

      // Load older logs when scrolling near the top
      if (element.scrollTop <= 100 && hasMore && !isLoading) {
        fetchFilteredLogs();
      }
    });
  }

  // Set up filter change listeners
  const levelSelect = document.getElementById("level-select");
  const airportSelect = document.getElementById("airport-select");
  const callsignSelect = document.getElementById("callsign-select");
  const categorySelect = document.getElementById("category-select");

  if (levelSelect)
    levelSelect.addEventListener("change", () => fetchFilteredLogs(true));
  if (airportSelect)
    airportSelect.addEventListener("change", () => fetchFilteredLogs(true));
  if (callsignSelect)
    callsignSelect.addEventListener("change", () => fetchFilteredLogs(true));
  if (categorySelect)
    categorySelect.addEventListener("change", () => fetchFilteredLogs(true));

  pollOnPage("status", renderAirportsStatus, 10000);
  onPageEnter("status", renderAirportsStatus);

  pollOnPage("log", populateLogFilters, 5000);
  onPageEnter("log", () => {
    populateLogFilters();
    fetchFilteredLogs(true);
  });

  // Fetch new logs periodically - only if auto-scroll is enabled
  pollOnPage("log", () => {
    if (!isLoading && autoScroll) {
      // Only fetch latest logs when user wants auto-scroll
      currentPage = 1;
      hasMore = true;
      fetchFilteredLogs(false);
    }
  }, 2000);
});

// Navigation routing - wrapped to execute after DOM is ready
(function () {
  function initNavigation() {
    const sections = Array.from(
      document.querySelectorAll("section[data-page]")
    );
    const navLinks = Array.from(
      document.querySelectorAll('.sidenav a[href^="#"]')
    );

    function showPage(page) {
      sections.forEach(async (s) => {
        if (page === "log" || page === "configs") {
          // Block access to logs and configs if not authenticated
          const currentUser = await fetchCurrentUser();
          if (!isUserAdmin(currentUser)) {
            console.log("Access denied to page:", page);
            s.style.display = "none";
            // redirect to status page
            if (location.hash !== "#status") {
              location.hash = "#status";
            }
          }
        }
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

      if (page === "dashboard") {
        checkAuthAndUpdateUI();
      }

      // optional: scroll to top of content area
      window.scrollTo(0, 0);
    }

    function route() {
      const hash = location.hash.replace("#", "") || "status";
      activePage = hash;
      showPage(hash);
      firePageEnter(hash);
    }

    // initialize
    window.addEventListener("hashchange", route);
    route(); // Call route immediately after setup
  }

  // Wait for DOM to be ready before initializing navigation
  if (document.readyState === "loading") {
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
  fetch(API_BASE_URL + "/api/occupancy/occupied", {
    headers: { "X-Internal-Request": "1" },
  })
    .then((res) => {
      if (!res.ok) throw new Error("Network response was not ok");
      return res.json();
    })
    .then((stands) => {
      if (Array.isArray(stands)) {
        // Group apron stands by ICAO-StandName, keep others as-is
        const grouped = new Map();
        stands.forEach((s) => {
          const id = s.icao + "-" + s.name;
          if (s.apronSize > 0) {
            if (!grouped.has(id)) {
              grouped.set(id, { id, callsigns: [], apronSize: s.apronSize });
            }
            grouped.get(id).callsigns.push(s.callsign);
          } else {
            grouped.set(id, { id, callsign: s.callsign, apronSize: 0 });
          }
        });
        occupiedStands = Array.from(grouped.values());
      }
    })
    .catch((err) => {
      console.error("Failed to load occupied stands", err);
    });
}

function fetchAssignedStands() {
  fetch(API_BASE_URL + "/api/occupancy/assigned", {
    headers: { "X-Internal-Request": "1" },
  })
    .then((res) => {
      if (!res.ok) throw new Error("Network response was not ok");
      return res.json();
    })
    .then((stands) => {
      if (Array.isArray(stands)) {
        // Group apron stands by ICAO-StandName, keep others as-is
        const grouped = new Map();
        stands.forEach((s) => {
          const id = s.icao + "-" + s.name;
          if (s.apronSize > 0) {
            if (!grouped.has(id)) {
              grouped.set(id, { id, callsigns: [], apronSize: s.apronSize });
            }
            grouped.get(id).callsigns.push(s.callsign);
          } else {
            grouped.set(id, { id, callsign: s.callsign, apronSize: 0 });
          }
        });
        assignedStands = Array.from(grouped.values());
      }
    })
    .catch((err) => {
      console.error("Failed to load assigned stands", err);
    });
}

function fetchBlockedStands() {
  fetch(API_BASE_URL + "/api/occupancy/blocked", {
    headers: { "X-Internal-Request": "1" },
  })
    .then((res) => {
      if (!res.ok) throw new Error("Network response was not ok");
      return res.json();
    })
    .then((stands) => {
      if (Array.isArray(stands)) {
        // Blocked stands are usually not aprons, but handle just in case
        const grouped = new Map();
        stands.forEach((s) => {
          const id = s.icao + "-" + s.name;
          if (s.apronSize > 0) {
            if (!grouped.has(id)) {
              grouped.set(id, { id, callsigns: [], apronSize: s.apronSize });
            }
            grouped.get(id).callsigns.push(s.callsign);
          } else {
            grouped.set(id, { id, callsign: s.callsign, apronSize: 0 });
          }
        });
        blockedStands = Array.from(grouped.values());
      }
    })
    .catch((err) => {
      console.error("Failed to load blocked stands", err);
    });
}

function getStandColor(standName, apron) {
  // Now both standName and the arrays are in ICAO-StandName format
  if (apron) {
    return ["#4682B4", "#87CEEB"]; // steel blue border, sky blue fill (apron)
  }

  if (occupiedStands.some((s) => s.id === standName)) {
    return ["#B22222", "#FF6B6B"]; // dark red border, light red fill (occupied)
  }

  if (assignedStands.some((s) => s.id === standName)) {
    return ["#005864ff", "#3a91acff"]; // dark blue border, light blue fill (assigned)
  }

  if (blockedStands.some((s) => s.id === standName)) {
    return ["#9c7c22ff", "#cdc54eff"]; // dark teal border, light teal fill (blocked)
  }

  return ["#78BFA0", "#96CEB4"]; // darker green border, light green fill (default)
}

// Map variables and constants
var zoomThreshold = 6; // <= show meter circle, > show screen-sized marker
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

// Configs page
// generate buttons for available config presets
function renderConfigButtons() {
  const container = document.getElementById("configButtonContainer");
  if (!container) return;
  container.innerHTML = "<p>Loading presets...</p>";
  fetch(API_BASE_URL + "/api/airports", {
    headers: { "X-Internal-Request": "1" },
  })
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
      return '<span class="' + cls + '">' + match + "</span>";
    }
  );
}

function loadConfig(presetName) {
  if (!presetName) return;
  fetch(
    API_BASE_URL + "/api/airports/config/" + encodeURIComponent(presetName),
    {
      method: "GET",
      headers: { "X-Internal-Request": "1" },
    }
  )
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
  if (typeof L === "undefined") {
    console.error(
      "initializeMap: Leaflet (L) is not loaded. Make sure leaflet.js is included before this script."
    );
    return;
  }

  // Check if map element exists
  const mapElement = document.getElementById("map");
  if (!mapElement) {
    console.error(
      "initializeMap: Map element not found, skipping map initialization"
    );
    return;
  }

  try {
    // Initialize Leaflet map
    map = L.map("map", {
      maxZoom: 19,
    }).setView([47.009279, 3.765732], 6);

    // Define multiple tile layers
    const satelliteLayer = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        attribution: "Tiles &copy; Esri",
        maxZoom: 19,
        className: "map-layer",
      }
    );

    const darkLayer = L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: "abcd",
        maxZoom: 20,
        className: "map-layer",
      }
    );

    window.mapLayers = {
      light: satelliteLayer,
      dark: darkLayer,
      current: null,
    };

    window.switchMapLayer = function () {
      const isDarkMode = document.body.classList.contains("dark-mode");
      const newLayer = isDarkMode ? darkLayer : satelliteLayer;

      if (window.mapLayers.current && map.hasLayer(window.mapLayers.current)) {
        map.removeLayer(window.mapLayers.current);
      }

      newLayer.addTo(map);
      window.mapLayers.current = newLayer;
    };

    switchMapLayer();

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
    pollOnPage("standMap", fetchOccupiedStands, 10000);
    pollOnPage("standMap", fetchAssignedStands, 10000);
    pollOnPage("standMap", fetchBlockedStands, 10000);
    onPageEnter("standMap", () => {
      fetchOccupiedStands();
      fetchAssignedStands();
      fetchBlockedStands();
    });

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
        container.innerHTML = "<i class='bx  bx-home'></i>";

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
      onRemove: function (map) {},
    });

    var homeControl = new HomeControl({ position: "topleft" });
    homeControl.addTo(map);

    // Load stands and airports data. Deferred to the first visit: it pulls the
    // full stand list (~150 kB) and builds a marker per stand, which was
    // competing with the first paint of whichever page you actually opened.
    let mapDataLoaded = false;
    const loadMapDataOnce = () => {
      if (mapDataLoaded) return;
      mapDataLoaded = true;
      loadMapData();
    };
    if (activePage === "standMap") loadMapDataOnce();
    else onPageEnter("standMap", loadMapDataOnce);
  } catch (error) {
    console.error("Failed to initialize map:", error);
  }
}

function createStandPopupContent(standId) {
  const div = document.createElement("div");
  div.className = "stand-popup-content";
  div.innerHTML = "<h1>" + standId + "</h1>";

  // Check occupied/assigned/blocked arrays for callsign(s)
  const occupied = occupiedStands.find((s) => s.id === standId);
  const assigned = assignedStands.find((s) => s.id === standId);
  const blocked = blockedStands.find((s) => s.id === standId);
  
  // For aprons, combine occupied and assigned callsigns
  if (occupied && occupied.apronSize && assigned && assigned.apronSize) {
    // Both occupied and assigned callsigns exist
    const occupiedCallsigns = Array.isArray(occupied.callsigns) ? occupied.callsigns : [];
    const assignedCallsigns = Array.isArray(assigned.callsigns) ? assigned.callsigns : [];
    const totalCount = occupiedCallsigns.length + assignedCallsigns.length;

    div.innerHTML += `<p><strong>Aircraft (${totalCount}/${occupied.apronSize}):</strong></p>`;

    if (occupiedCallsigns.length > 0) {
      div.innerHTML += `<p><em>Occupied (${occupiedCallsigns.length}):</em></p><ul>`;
      occupiedCallsigns.forEach(cs => {
        div.innerHTML += `<li>${cs}</li>`;
      });
      div.innerHTML += `</ul>`;
    }
    
    if (assignedCallsigns.length > 0) {
      div.innerHTML += `<p><em>Assigned (${assignedCallsigns.length}):</em></p><ul>`;
      assignedCallsigns.forEach(cs => {
        div.innerHTML += `<li>${cs}</li>`;
      });
      div.innerHTML += `</ul>`;
    }
  } else if (occupied && occupied.apronSize) {
    // Only occupied callsigns
    const occupiedCallsigns = Array.isArray(occupied.callsigns) ? occupied.callsigns : [];
    div.innerHTML += `<p><strong>Aircraft (${occupiedCallsigns.length}/${occupied.apronSize}):</strong></p>`;
    div.innerHTML += `<p><em>Occupied (${occupiedCallsigns.length}):</em></p><ul>`;
    occupiedCallsigns.forEach(cs => {
      div.innerHTML += `<li>${cs}</li>`;
    });
    div.innerHTML += `</ul>`;
  } else if (assigned && assigned.apronSize) {
    // Only assigned callsigns
    const assignedCallsigns = Array.isArray(assigned.callsigns) ? assigned.callsigns : [];
    div.innerHTML += `<p><strong>Aircraft (${assignedCallsigns.length}/${assigned.apronSize}):</strong></p>`;
    div.innerHTML += `<p><em>Assigned (${assignedCallsigns.length}):</em></p><ul>`;
    assignedCallsigns.forEach(cs => {
      div.innerHTML += `<li>${cs}</li>`;
    });
    div.innerHTML += `</ul>`;
  } else if (occupied) {
    // Non-apron occupied stand
    div.innerHTML += `<p>Occupied by <strong>${occupied.callsign}</strong></p>`;
  } else if (assigned) {
    // Non-apron assigned stand
    div.innerHTML += `<p>Assigned to <strong>${assigned.callsign}</strong></p>`;
  } else if (blocked) {
    if (blocked.apronSize && Array.isArray(blocked.callsigns)) {
      div.innerHTML += `<p><strong>Blocked by (${blocked.callsigns.length}):</strong></p><ul>`;
      blocked.callsigns.forEach(cs => {
        div.innerHTML += `<li>${cs}</li>`;
      });
      div.innerHTML += `</ul>`;
    } else {
      div.innerHTML += `<p>Blocked by <strong>${blocked.callsign}</strong></p>`;
    }
  } else {
    div.innerHTML += `<p>Free</p>`;
  }
  return div;
}

function loadMapData() {
  // Draw stands on map
  fetch(API_BASE_URL + "/api/airports/stands", {
    headers: { "X-Internal-Request": "1" },
  })
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
          if (stand.apron && stand.apron.Coordinates) {
            // Parse and validate apron coordinates
            // Currently, coordinates are "lat:lng" strings - convert to [lat, lng] arrays
            if (Array.isArray(stand.apron.Coordinates)) {
              stand.apron.Coordinates = stand.apron.Coordinates.map((coord) => {
                const [lat, lng] = coord.split(":").map(Number);
                return [lat, lng];
              });
            }

            const apronCoordsValid =
              stand &&
              stand.apron &&
              Array.isArray(stand.apron.Coordinates) &&
              stand.apron.Coordinates.length > 0 &&
              stand.apron.Coordinates.every(
                (c) =>
                  Array.isArray(c) &&
                  c.length === 2 &&
                  Number.isFinite(c[0]) &&
                  Number.isFinite(c[1])
              );

            if (!apronCoordsValid) {
              console.warn(
                "Invalid apron coordinates for stand:",
                stand
              );
              return;
            }
            stand.polygon = L.polygon(stand.apron.Coordinates, {
              color: color[0],
              fillColor: color[1],
              fillOpacity: 0.5,
              weight: 2,
              lineJoin: "round",    // <- round joins
              lineCap: "round",     // <- round end caps
              smoothFactor: 1.5
            }).bindPopup(() => {
              return createStandPopupContent(stand.name);
            });
          } else {
            stand.circle = L.circle(stand.coords, {
              color: color[0],
              fillColor: color[1],
              fillOpacity: 0.5,
              radius: stand.radius,
              weight: 3,
            }).bindPopup(() => {
              return createStandPopupContent(stand.name);
            });
          }

          stand.label = L.marker(stand.coords, {
            interactive: false,
            icon: L.divIcon({
              className: "stand-label",
              html: "<span>" + stand.name + "</span>",
            }),
          });

          if (stand.circle) {
            stand.circle.addTo(map);
          } else if (stand.polygon) {
            stand.polygon.addTo(map);
          }
        });
      }
    })
    .catch((err) => {
      console.error("Failed to load stands on Map", err);
    });

  // Update stand colors periodically
  pollOnPage("standMap", () => {
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
      const meterRadius = 25000;

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
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeMap);
} else {
  // DOM already loaded
  initializeMap();
}

// Dashboard
async function fetchCurrentUser() {
  try {
    const res = await fetch(API_BASE_URL + "/api/auth/session", {
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn("fetchCurrentUser error", err);
    return null;
  }
}

function isUserConnected(user) {
  return !!user && (!!user.core || !!user.local || !!user.token);
}

function isUserAdmin(user) {
  if (!user) return false;
  if (
    user.local &&
    Array.isArray(user.local.roles) &&
    user.local.roles.includes("admin")
  )
    return true;
  return false;
}

async function checkAuthAndUpdateUI() {
  const user = await fetchCurrentUser();
  renderLoginLayout(user);
  displayDashboard(user);
}

async function fetchLocalUsers() {
  const res = await fetch(API_BASE_URL + "/api/auth/internal/localusers", {
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error("Failed to fetch users");
  return res.json();
}

async function toggleAdminRole(cid, add) {
  const url =
    API_BASE_URL +
    `/api/auth/internal/localuser/${encodeURIComponent(cid)}/roles`;
  const method = add ? "POST" : "DELETE";
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "admin" }),
  });
  if (!res.ok) throw new Error("Failed to update role");
  return res.json();
}

//FIXME: need testing and better UI
async function renderAdminList(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  try {
    const users = await fetchLocalUsers();
    container.innerHTML = users
      .map((u) => {
        const isAdmin = Array.isArray(u.roles) && u.roles.includes("admin");
        return `<div data-cid="${u.cid}">
        <strong>${u.cid}</strong> ${u.full_name ? "- " + u.full_name : ""}
        <button class="role-btn" data-cid="${u.cid}" data-action="${
          isAdmin ? "revoke" : "grant"
        }">
          ${isAdmin ? "Revoke admin" : "Grant admin"}
        </button>
      </div>`;
      })
      .join("");
    container.querySelectorAll(".role-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const cid = btn.dataset.cid;
        const add = btn.dataset.action === "grant";
        await toggleAdminRole(cid, add);
        await renderAdminList(containerId);
      });
    });
  } catch (err) {
    container.textContent = "Error loading users";
    console.error(err);
  }
}

// Select correct dashboard based on isAdmin or not
function displayDashboard(user) {
  const isAdmin = isUserAdmin(user);
  if (isAdmin) {
    renderAdminList("adminUserList");
    document.getElementById("dashboardAdmin").style.display = "block";
    updateControllerNumber();
    updateApiKeyList();
  } else {
    document.getElementById("dashboardAdmin").style.display = "none";
  }
}

function renderLoginLayout(user) {
  const isConnected = isUserConnected(user);
  const isAdmin = isUserAdmin(user);

  // Handle sidenav items visibility
  const adminOnlyItems = document.querySelectorAll(
    ".sidenav a[data-admin-only]"
  );
  adminOnlyItems.forEach((item) => {
    item.style.display = isConnected && isAdmin ? "block" : "none";
  });

  // Rest of existing login layout logic
  if (!isConnected) {
    Array.from(document.getElementsByClassName("loginLayout")).forEach(
      (el) => (el.style.display = "flex")
    );
    Array.from(document.getElementsByClassName("connectedLayout")).forEach(
      (el) => (el.style.display = "none")
    );
  } else {
    Array.from(document.getElementsByClassName("loginLayout")).forEach(
      (el) => (el.style.display = "none")
    );
    // Check maxwidth to adjust layout
    if (window.innerWidth <= 600) {
      Array.from(document.getElementsByClassName("connectedLayout")).forEach(
        (el) => (el.style.display = "flex")
      );
    } else {
      Array.from(document.getElementsByClassName("connectedLayout")).forEach(
        (el) => (el.style.display = "inline")
      );
    }
    document.getElementById("username").textContent = user
      ? user.core.firstName
      : "Guest";
    apiKeyDisplay(user);
  }
}

function apiKeyDisplay(user) {
  let apiKey = user ? user.local.api_key : "";
  if (apiKey && apiKey.length > 0) {
    document.getElementById("selfAPIKey").style.display = "inline";
    document.getElementById("selfAPIKey").textContent = apiKey;
  } else {
    document.getElementById("selfAPIKey").style.display = "none";
  }
}

function generateApiKey() {
  console.log("Generating new API key...");
  fetchLocalUsers().then((user) => {
    if (!user) {
      console.error("Cannot generate API key: user not found");
      return;
    }
    fetch(API_BASE_URL + `/api/auth/key/${user.core.cid}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: user.core.cid }),
    });
  });

  // Refresh the dashboard to show new key
  fetchLocalUsers().then((user) => {
    apiKeyDisplay(user);
  });
}

function updateApiKeyList() {
  const tbody = document.querySelector("#apiKeyListTable tbody");
  if (!tbody) return;
  fetch(API_BASE_URL + "/api/apikey/", {
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
  })
    .then((res) => {
      if (!res.ok) throw new Error("Network response was not ok");
      // Display no API keys message if empty
      showNoApiKeysMessageIfEmpty();
      return res.json();
    })
    .then((data) => {
      // Clear existing rows
      tbody.innerHTML = "";

      // FIXME: Debug log
      console.log("Fetched API keys:", data);

      // Populate table with API keys
      // Make sure it is an array
      if (!Array.isArray(data.keys)) {
        console.error("API keys data is not an array:", data.keys);
        return;
      }
      data.keys.forEach((key) => {
        const row = document.createElement("tr");
        row.id = key.cid;
        row.innerHTML = `
          <td>${key.cid}</td>
          <td class="apiValue">${key.apiKey}</td>
          <td class="createdValue">${key.createdAt}</td>
          <td>${key.lastUsed}</td>
          <td class="actionCell">
            <button class="renewButton" onclick="renewApiKey('${key.cid}')">Renew</button>
            <button class="revokeButton" onclick="revokeApiKey('${key.cid}')">Revoke</button>
          </td>
        `;
        tbody.appendChild(row);
      });
      updateApiKeyCount();
    })
    .catch((err) => {
      console.error("Failed to fetch API key list", err);
    });
  showNoApiKeysMessageIfEmpty();
}

function updateApiKeyCount() {
  const countElem = document.getElementById("apiKeyCount");
  const apiKeyCounter = document.querySelectorAll(
    "#apiKeyListTable tbody tr"
  ).length;
  if (countElem) {
    countElem.textContent = apiKeyCounter;
  }
}

// API actions
function renewApiKey(cid) {
  console.log("Renewing API key of CID:", cid);
  fetch(API_BASE_URL + `/api/apikey/${cid}/renew`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    body: JSON.stringify({ cid }),
  });
}

function revokeApiKey(cid) {
  console.log("Revoking API key of CID:", cid);

  fetch(API_BASE_URL + `/api/apikey/${cid}/revoke`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    body: JSON.stringify({ cid }),
  });

  // Remove entire row from table
  const row = document.getElementById(cid);
  if (row) {
    row.remove();
    updateApiKeyCount();
  }

  // If table is empty after removal, show "no keys" message
  showNoApiKeysMessageIfEmpty();
}

function showNoApiKeysMessageIfEmpty() {
  const tbody = document.querySelector("#apiKeyListTable tbody");
  if (tbody && tbody.children.length === 0) {
    const noKeysRow = document.createElement("tr");
    const noKeysCell = document.createElement("td");
    noKeysCell.colSpan = 5;
    noKeysCell.textContent = "No API keys found";
    noKeysRow.appendChild(noKeysCell);
    tbody.appendChild(noKeysRow);
  }
}

// ATC controller number
function updateControllerNumber() {
  const span = document.getElementById("connectedAtcCount");
  if (!span) return;
  fetch(API_BASE_URL + "/api/occupancy/controllers", {
    headers: { "X-Internal-Request": "1" },
  })
    .then((res) => {
      if (!res.ok) throw new Error("Network response was not ok");
      return res.json();
    })
    .then((data) => {
      if (typeof data.count === "number") {
        span.textContent = data.count;
      }
    })
    .catch((err) => {
      console.error("Failed to fetch connected ATC count", err);
    });
}

pollOnPage("dashboard", updateControllerNumber, 15000); // update every 15 seconds
onPageEnter("dashboard", updateControllerNumber);

// Swipe buttons
(function enableRowSwipeActions() {
  const tbody = document.querySelector("#apiKeyListTable tbody");
  if (!tbody) return;

  let startX = 0,
    startY = 0,
    activeRow = null;
  let dragging = false;
  const HORIZONTAL_THRESHOLD = 50; // px needed to count as swipe
  const MAX_TRANSLATE = 120; // px maximum visual translation

  function getRow(el) {
    while (el && el !== tbody && el.tagName !== "TR") el = el.parentElement;
    return el && el.tagName === "TR" ? el : null;
  }

  function ensureIndicators(row) {
    if (!row) return;
    if (!row.querySelector(".swipe-indicator.left")) {
      const left = document.createElement("div");
      left.className = "swipe-indicator left";
      left.innerHTML = "<span>Renew</span>";
      row.appendChild(left);
    }
    if (!row.querySelector(".swipe-indicator.right")) {
      const right = document.createElement("div");
      right.className = "swipe-indicator right";
      right.innerHTML = "<span>Revoke</span>";
      row.appendChild(right);
    }
  }

  function startDrag(x, y, target) {
    startX = x;
    startY = y;
    activeRow = getRow(target);
    if (!activeRow) return;
    ensureIndicators(activeRow);
    dragging = true;
    activeRow.classList.add("swipe-dragging");
    // guard everything that touches style with a check
    if (activeRow) {
      activeRow.style.transition = "none";
      activeRow.style.willChange = "transform";
      activeRow.style.zIndex = "1500";
      activeRow.style.boxShadow = "0 12px 30px rgba(0,0,0,0.18)";
      activeRow.style.transform = "translateX(0) scale(1.01)";
      activeRow.style.userSelect = "none";
    }

    // initialize indicators
    const left = activeRow.querySelector(".swipe-indicator.left");
    const right = activeRow.querySelector(".swipe-indicator.right");
    if (left) {
      left.style.width = "0px";
      left.style.opacity = "0";
    }
    if (right) {
      right.style.width = "0px";
      right.style.opacity = "0";
    }
  }

  function moveDrag(x, y) {
    if (!dragging || !activeRow) return;
    const dx = x - startX;
    const dy = y - startY;
    if (Math.abs(dy) > Math.abs(dx)) return;
    const limited = Math.max(-MAX_TRANSLATE, Math.min(MAX_TRANSLATE, dx));
    const scale = 1 + Math.min(Math.abs(limited) / 800, 0.03);
    activeRow.style.transform = `translateX(${limited}px) scale(${scale})`;

    const left = activeRow.querySelector(".swipe-indicator.left");
    const right = activeRow.querySelector(".swipe-indicator.right");
    if (limited > 0) {
      // reveal left indicator proportionally
      if (left) {
        left.style.width = `${Math.min(limited, MAX_TRANSLATE)}px`;
        left.style.opacity = String(Math.min(1, Math.abs(limited) / 20));
      }
      if (right) {
        right.style.width = "0px";
        right.style.opacity = "0";
      }
    } else if (limited < 0) {
      // reveal right indicator proportionally
      const w = Math.min(-limited, MAX_TRANSLATE);
      if (right) {
        right.style.width = `${w}px`;
        right.style.opacity = String(Math.min(1, Math.abs(limited) / 20));
      }
      if (left) {
        left.style.width = "0px";
        left.style.opacity = "0";
      }
    } else {
      if (left) {
        left.style.width = "0px";
        left.style.opacity = "0";
      }
      if (right) {
        right.style.width = "0px";
        right.style.opacity = "0";
      }
    }
  }

  function endDrag(x, y) {
    if (!activeRow) {
      dragging = false;
      return;
    }
    const dx = x - startX;
    const dy = y - startY;
    dragging = false;

    // use a localRef to avoid race if activeRow is cleared/removed later
    const rowRef = activeRow;

    if (rowRef)
      rowRef.style.transition = "transform 220ms ease, box-shadow 180ms ease";

    const left = rowRef ? rowRef.querySelector(".swipe-indicator.left") : null;
    const right = rowRef
      ? rowRef.querySelector(".swipe-indicator.right")
      : null;

    if (Math.abs(dx) >= HORIZONTAL_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
      const apiCell = rowRef ? rowRef.querySelector(".apiValue") : null;
      const apiKey = apiCell ? apiCell.textContent.trim() : null;
      if (apiKey && rowRef) {
        const direction = dx > 0 ? "right" : "left";
        const finishTranslate = dx > 0 ? MAX_TRANSLATE : -MAX_TRANSLATE;
        rowRef.style.transform = `translateX(${finishTranslate}px) scale(1.02)`;
        if (direction === "right" && left) {
          left.style.width = `${MAX_TRANSLATE}px`;
          left.style.opacity = "1";
        }
        if (direction === "left" && right) {
          right.style.width = `${MAX_TRANSLATE}px`;
          right.style.opacity = "1";
       
        }

        setTimeout(() => {
          if (direction === "right") {
            try {
              renewApiKey(apiKey);
            } catch (err) {
              console.error(err);
            }
          } else {
            try {
              revokeApiKey(apiKey);
            } catch (err) {
              console.error(err);
            }
          }
          if (rowRef) {
            rowRef.style.transform = "translateX(0) scale(1)";
            if (left) {
              left.style.width = "0px";
              left.style.opacity = "0";
            }
            if (right) {
              right.style.width = "0px";
              right.style.opacity = "0";
            }
          }
        }, 180);
      } else if (rowRef) {
        rowRef.style.transform = "translateX(0) scale(1)";
      }
    } else {
      if (rowRef) {
        rowRef.style.transform = "translateX(0) scale(1)";
        if (left) {
          left.style.width = "0px";
          left.style.opacity = "0";
        }
        if (right) {
          right.style.width = "0px";
          right.style.opacity = "0";
        }
      }
    }

    const cleanup = () => {
      if (!rowRef) return;
      rowRef.classList.remove("swipe-dragging");
      // clear inline styles safely
      rowRef.style.transition = "";
      rowRef.style.transform = "";
      rowRef.style.willChange = "";
      rowRef.style.boxShadow = "";
      rowRef.style.zIndex = "";
      rowRef.style.userSelect = "";
      const l = rowRef.querySelector(".swipe-indicator.left");
      const r = rowRef.querySelector(".swipe-indicator.right");
      if (l) l.remove();
      if (r) r.remove();
      rowRef.removeEventListener("transitionend", cleanup);
      // only null the shared activeRow after cleanup finishes
      if (activeRow === rowRef) activeRow = null;
    };
    if (rowRef) rowRef.addEventListener("transitionend", cleanup);
  }

  // Touch handlers
  tbody.addEventListener(
    "touchstart",
    (e) => {
      const t = e.changedTouches[0];
      startDrag(t.clientX, t.clientY, e.target);
    },
    { passive: true }
  );

  tbody.addEventListener(
    "touchmove",
    (e) => {
      if (!dragging) return;
      const t = e.changedTouches[0];
      moveDrag(t.clientX, t.clientY);
    },
    { passive: true }
  );

  tbody.addEventListener(
    "touchend",
    (e) => {
      const t = e.changedTouches[0];
      endDrag(t.clientX, t.clientY);
    },
    { passive: true }
  );

  tbody.addEventListener(
    "touchcancel",
    () => {
      if (activeRow) {
        activeRow.style.transition = "transform 150ms ease";
        activeRow.style.transform = "translateX(0) scale(1)";
        activeRow.addEventListener(
          "transitionend",
          () => {
            if (activeRow) {
              activeRow.classList.remove("swipe-dragging");
              activeRow.style.transition = "";
              activeRow.style.transform = "";
              activeRow = null;
            }
          },
          { once: true }
        );
      }
      dragging = false;
    },
    { passive: true }
  );
})();
