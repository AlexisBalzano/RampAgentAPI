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

// Status page

// filter occupied stands by airport icao
// add subcontainer child to status-container for each airport
// add departure-board child to each airport subcontainer for each occupied stand

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

function padStandName(name) {
  return name.padStart(3, " ");
}

async function renderAirportsStatus() {
  // Fetch all airports
  const airportList = await fetch("/api/airports", {
    headers: { "X-Internal-Request": "1" },
  })
    .then((res) => res.json())
    .catch(() => []);

  // Fetch stands
  const allOccupiedStands = await fetch("/api/occupancy/occupied", {
    headers: { "X-Internal-Request": "1" },
  }).then((res) => res.json());
  const getAllBlockedStands = await fetch("/api/occupancy/blocked", {
    headers: { "X-Internal-Request": "1" },
  }).then((res) => res.json());

  const statusContainer = document.getElementById("status-container");
  statusContainer.innerHTML = "";

  // Build airport map
  const airports = {};
  airportList.forEach((airport) => {
    airports[airport.name] = { name: airport.name, occupied: [], blocked: [] };
  });
  // Assign stands
  allOccupiedStands.forEach((stand) => {
    const airportIcao = stand.icao;
    if (airportIcao && airports[airportIcao]) {
      airports[airportIcao].occupied.push(stand);
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
    subContainer.id = `airport-${airportIcao}`;
    subContainer.appendChild(generateSpanforText(" " + airportIcao));
    subContainer.appendChild(generateSpanforText("Occupied Stands"));
    if (stands.occupied.length === 0) {
      subContainer.appendChild(generateSpanforText("None"));
    } else {
      stands.occupied.forEach((stand) => {
        subContainer.appendChild(
          generateSpanforText(padStandName(stand.name) + "  " + stand.callsign)
        );
      });
    }
    subContainer.appendChild(generateSpanforText("Blocked Stands"));
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
}

// Statistics chart
let totalRequests = 0;

let reportsChart = null;
let airportChart = null;

async function fetchReportsPerHour() {
  const res = await fetch("/api/stats/reports-per-hour"); // match server route
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
  const res = await fetch("/api/stats/requests-per-hour", {
    headers: { "X-Internal-Request": "1" },
  }); // match server route
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
      label: `${String(hour.getHours()).padStart(2, "0")}:00`,
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
                return `${label}: ${value}`;
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

    document.querySelector("#RequestTotal").textContent =
      totalRequests.toLocaleString();
    document.querySelector("#ReportTotal").textContent =
      totalReports.toLocaleString();
  } catch (err) {
    console.error("Failed to refresh stats chart", err);
  }
}

// initial load when DOM ready
document.addEventListener("DOMContentLoaded", () => {
  // try initial render (chart canvas must exist)
  setTimeout(() => {
    refreshStatsChart();
  }, 200);
  // refresh every 10 seconds
  setInterval(refreshStatsChart, 10_000);
});

// Log management
let autoScroll = true;
let logEntries = [];

// Fetch logs from server and render into the log area
function renderLogs() {
  fetch("/api/logs")
    .then((res) => {
      if (!res.ok) throw new Error("Network response was not ok");
      return res.json();
    })
    .then((logs) => {
      if (Array.isArray(logs)) {
        logEntries = logs;
        updateLogDisplay();
      }
    })
    .catch((err) => {
      console.error("Failed to load logs", err);
      addLogEntry("ERROR", "Failed to load logs from server");
    });
}

function updateLogDisplay() {
  const logContent = document.getElementById("logContent");
  if (!logContent) return;

  logContent.innerHTML = "";

  logEntries.forEach((entry) => {
    const level = entry.level || "INFO";
    const logDiv = document.createElement("div");
    logDiv.className = `log-entry log-${String(level).toLowerCase()}`;
    logDiv.innerHTML = `
    <span class="log-timestamp">${new Date(
      entry.timestamp
    ).toLocaleTimeString()}</span>
    <span class="log-level">[${level}]</span>
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
    message: message,
  };

  logEntries.push(entry);

  // Keep only last 1000 entries to prevent memory issues
  if (logEntries.length > 1000) {
    logEntries = logEntries.slice(-1000);
  }

  updateLogDisplay();
}

function toggleAutoScroll() {
  autoScroll = !autoScroll;
  const button = document.getElementById("toggleAutoScroll");
  button.textContent = `Auto-scroll: ${autoScroll ? "ON" : "OFF"}`;

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
  renderLogs();
  setInterval(renderAirportsStatus, 10_000);
  setInterval(renderLogs, 2000); // Fetch logs more frequently
});

(function () {
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
    if (page === "standMap" && typeof map !== "undefined") {
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
  document.addEventListener("DOMContentLoaded", route);
})();

// Map
var stands = []; // make stands accessible to updateMarkerSizes
var map = L.map("map", {
  maxZoom: 19, // Increase maximum zoom level
}).setView([49.009279, 2.565732], 14);

// Add satellite tile layer
L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    attribution:
      "Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community",
    maxZoom: 19, // Set tile layer max zoom
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
    '<i style="background:#FF6B6B; width:18px; height:18px; display:inline-block; margin-right:8px; opacity:0.7; border-radius:50%; border: 1px solid #CCCCCC;"></i> Occupied<br><br>';
  // prevent map interactions when interacting with legend
  L.DomEvent.disableClickPropagation(div);
  return div;
};
legend.addTo(map);

let occupiedStands = [];
let blockedStands = [];

function fetchOccupiedStands() {
  fetch("/api/occupancy/occupied", { headers: { "X-Internal-Request": "1" } })
    .then((res) => {
      if (!res.ok) throw new Error("Network response was not ok");
      return res.json();
    })
    .then((stands) => {
      if (Array.isArray(stands)) {
        // Store as ICAO-StandName format instead of just name
        occupiedStands = stands.map((s) => `${s.icao}-${s.name}`);
      }
    })
    .catch((err) => {
      console.error("Failed to load occupied stands", err);
    });
}

function fetchBlockedStands() {
  fetch("/api/occupancy/blocked", { headers: { "X-Internal-Request": "1" } })
    .then((res) => {
      if (!res.ok) throw new Error("Network response was not ok");
      return res.json();
    })
    .then((stands) => {
      if (Array.isArray(stands)) {
        // Store as ICAO-StandName format instead of just name
        blockedStands = stands.map((s) => `${s.icao}-${s.name}`);
      }
    })
    .catch((err) => {
      console.error("Failed to load blocked stands", err);
    });
}

// Initial fetch and periodic refresh
fetchOccupiedStands();
fetchBlockedStands();
setInterval(fetchOccupiedStands, 10_000);
setInterval(fetchBlockedStands, 10_000);

function getStandColor(standName, apron) {
  // Now both standName and the arrays are in ICAO-StandName format
  if (occupiedStands.includes(standName)) {
    return ["#B22222", "#FF6B6B"]; // dark red border, light red fill (occupied)
  }

  if (blockedStands.includes(standName)) {
    return ["#9c7c22ff", "#cdc54eff"]; // dark teal border, light teal fill (blocked)
  }

  if (apron) {
    return ["#4682B4", "#87CEEB"]; // steel blue border, sky blue fill (apron)
  }

  return ["#78BFA0", "#96CEB4"]; // darker green border, light green fill (default)
}

// Add airport pins onto map (meter-circle + pixel-marker hybrid)
var zoomThreshold = 5; // <= show meter circle, > show screen-sized marker
var zoomHideThreshold = 13; // > hide marker entirely
var meterRadius = 50000; // meters for the L.Circle when zoomed out
var labelZoomThreshold = 17; // show stand labels at this zoom level and above

// Draw stands on map
fetch("/api/airports/stands")
  .then((res) => {
    if (!res.ok) throw new Error("Network response was not ok");
    return res.json();
  })
  .then((data) => {
    if (!Array.isArray(data))
      throw new Error("Stands response is not an array");
    // keep only entries with valid numeric [lat, lon] coords
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
          radius: stand.radius, // meters
          weight: 3,
        }).bindPopup(`<strong>${stand.name}</strong>`);

        stand.label = L.marker(stand.coords, {
          interactive: false,
          icon: L.divIcon({
            className: "stand-label", // style in CSS
            html: `<span>${stand.name}</span>`,
          }),
        });

        stand.circle.addTo(map);
      });
    }
  })
  .catch((err) => {
    console.error("Failed to load stands on Map", err);
    addLogEntry("ERROR", "Failed to load stands from server");
  });

// update stand marker colors every minute in case occupancy changed
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
}, 10_000);

// Draw airports on map (meter-circle + pixel-marker hybrid)
var airports = []; // will be filled after fetch
var initialBounds = null; // Store the initial bounds

fetch("/api/airports")
  .then((res) => {
    if (!res.ok) throw new Error("Network response was not ok");
    return res.json();
  })
  .then((data) => {
    if (!Array.isArray(data))
      throw new Error("Airports response is not an array");
    // keep only entries with valid numeric [lat, lon] coords
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
    } else {
      // create a feature group only from valid markers
      const markers = airports.map((a) => L.marker(a.coords));
      const group = new L.featureGroup(markers);
      const bounds = group.getBounds();
      if (bounds.isValid && bounds.isValid()) {
        map.fitBounds(bounds.pad(0.5));
        initialBounds = bounds.pad(0.5); // Store the initial bounds
      }
    }

    airports.forEach(function (airport) {
      // create both layers but don't assume both are on the map at once
      airport.circle = L.circle(airport.coords, {
        color: "#505050ff",
        fillColor: "#ffffff",
        fillOpacity: 0.7,
        radius: meterRadius, // meters
        weight: 3,
      }).bindPopup(`<strong>${airport.name}</strong>`);

      airport.marker = L.circleMarker(airport.coords, {
        color: "#505050ff",
        fillColor: "#ffffff",
        fillOpacity: 0.7,
        radius: 26, // pixels on screen when visible
        weight: 3,
      }).bindPopup(`<strong>${airport.name}</strong>`);

      // zoom-to-airport on click: ensure map zoom reaches the pixel-marker zoom level
      const targetZoom = zoomHideThreshold + 1;
      const zoomAndOpen = function (layer) {
        // animate to the airport and open the popup afterwards
        map.setView(airport.coords, targetZoom, { animate: true });
        // small delay so popup opens after the view change
        setTimeout(() => {
          try {
            layer.openPopup();
          } catch (e) {
            /* ignore */
          }
        }, 300);
      };

      airport.circle.on("click", function () {
        zoomAndOpen(airport.circle);
      });
      airport.marker.on("click", function () {
        zoomAndOpen(airport.marker);
      });

      // initially decide which to add based on current zoom
      if (map.getZoom() <= zoomThreshold) {
        airport.circle.addTo(map);
      } else {
        airport.marker.addTo(map);
      }
    });

    // ensure toggling logic runs now that airports exist
    updateMarkerSizes();
  })
  .catch((err) => {
    console.error("Failed to load airports on Map", err);
    addLogEntry("ERROR", "Failed to load airports from server");
  });

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
map.on("zoomend", updateMarkerSizes);

// Custom home button control
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
      if (initialBounds && initialBounds.isValid()) {
        map.fitBounds(initialBounds, { animate: true, duration: 1 });
      } else {
        // Fallback to default view if no bounds stored
        map.setView([49.009279, 2.565732], 7, { animate: true });
      }
    };

    // Prevent map interactions when clicking the button
    L.DomEvent.disableClickPropagation(container);

    return container;
  },

  onRemove: function (map) {
    // Nothing to do here
  },
});

// Add the home control to the map
var homeControl = new HomeControl({ position: "topleft" });
homeControl.addTo(map);

// Store the initial view bounds
map.whenReady(function () {
  initialBounds = map.getBounds();
});

// Configs page
// generate buttons for available config presets
function renderConfigButtons() {
  const container = document.getElementById("configButtonContainer");
  if (!container) return;
  container.innerHTML = "<p>Loading presets...</p>";
  fetch("/api/airports", { headers: { "X-Internal-Request": "1" } })
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
        button.setAttribute("aria-label", `Load config ${preset.name}`);
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
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

function loadConfig(presetName) {
  if (!presetName) return;
  fetch(`/api/airports/config/${encodeURIComponent(presetName)}`, {
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
