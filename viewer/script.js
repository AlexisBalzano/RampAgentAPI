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

// Initial render and periodic refresh
document.addEventListener('DOMContentLoaded', () => {
  renderOccupiedStands();
  setInterval(renderOccupiedStands, 5000);
});

