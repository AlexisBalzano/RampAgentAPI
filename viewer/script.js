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
  const ul = document.getElementById("occupiedStands");
  if (!ul) return;
  ul.innerHTML = "<li>Loading...</li>";

  fetch("/api/occupancy/occupied")
    .then((res) => {
      if (!res.ok) throw new Error("Network response was not ok");
      return res.json();
    })
    .then((stands) => {
      ul.innerHTML = "";
      if (!Array.isArray(stands) || stands.length === 0) {
        ul.innerHTML = "<li>No stands are currently occupied.</li>";
        return;
      }
      for (const s of stands) {
        const li = document.createElement("li");
        if (s.callsign)
          li.textContent = `${s.name} @ ${s.icao} — ${s.callsign}`;
        else li.textContent = `${s.name} @ ${s.icao}`;
        ul.appendChild(li);
      }
    })
    .catch((err) => {
      console.error("Failed to load occupied stands", err);
      ul.innerHTML = "<li>Error loading occupied stands.</li>";
    });
}

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
  renderOccupiedStands();
  renderLogs();
  setInterval(renderOccupiedStands, 5000);
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
    '<i style="background:#96CEB4; width:18px; height:18px; display:inline-block; margin-right:8px; opacity:0.7; border-radius:50%; border: 1px solid #CCCCCC;"></i> Default<br>' +
    '<i style="background:#45B7D1; width:18px; height:18px; display:inline-block; margin-right:8px; opacity:0.7; border-radius:50%; border: 1px solid #CCCCCC;"></i> Schengen<br>' +
    '<i style="background:#4ECDC4; width:18px; height:18px; display:inline-block; margin-right:8px; opacity:0.7; border-radius:50%; border: 1px solid #CCCCCC;"></i> Non-Schengen<br>' +
    '<i style="background:#FF6B6B; width:18px; height:18px; display:inline-block; margin-right:8px; opacity:0.7; border-radius:50%; border: 1px solid #CCCCCC;"></i> Apron<br><br>' +
    "<small>Click circles for details<br>Click map to copy coordinates</small>";
  // prevent map interactions when interacting with legend
  L.DomEvent.disableClickPropagation(div);
  return div;
};
legend.addTo(map);

function getStandColor(schengen, apron) {
  if (apron) return "#FF6B6B"; // red for apron stands
  if (schengen === true || schengen === "true") return "#45B7D1"; // blue for schengen
  if (schengen === false || schengen === "false") return "#4ECDC4"; // turquoise for non-schengen
  return "#96CEB4"; // light green for default/unspecified
}

// Add airport pins onto map (meter-circle + pixel-marker hybrid)
var zoomThreshold = 5; // <= show meter circle, > show screen-sized marker
var zoomHideThreshold = 13; // > hide marker entirely
var meterRadius = 50000; // meters for the L.Circle when zoomed out

var airports = []; // will be filled after fetch

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
      }
    }

    airports.forEach(function (airport) {
      // create both layers but don't assume both are on the map at once
      airport.circle = L.circle(airport.coords, {
        color: "#505050ff",
        fillColor: "#ffffff",
        fillOpacity: 0.7,
        radius: meterRadius, // meters
        weight: 1,
      }).bindPopup(`<strong>${airport.name}</strong>`);

      airport.marker = L.circleMarker(airport.coords, {
        color: "#505050ff",
        fillColor: "#ffffff",
        fillOpacity: 0.7,
        radius: 26, // pixels on screen when visible
        weight: 1,
      }).bindPopup(`<strong>${airport.name}</strong>`);

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
    const stands = data.filter((s) => {
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
        stand.circle = L.circle(stand.coords, {
          color: "#505050ff",
          fillColor: getStandColor(stand.schengen, stand.apron),
          fillOpacity: 0.8,
          radius: stand.radius, // meters
          weight: 1,
        }).bindPopup(`<strong>${stand.name}</strong>`);
        stand.circle.addTo(map);
      });
    }
  })
  .catch((err) => {
    console.error("Failed to load stands on Map", err);
    addLogEntry("ERROR", "Failed to load stands from server");
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
      if (markerOnMap && marker) map.removeLayer(marker);
      // keep circles hidden when very zoomed out if desired (optional)
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
}
map.on("zoomend", updateMarkerSizes);
