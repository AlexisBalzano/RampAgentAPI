const express = require('express');
const path = require('path');

const env = process.env.NODE_ENV || 'default';
const config = require(`./config/${env}.js`);
const reportRoutes = require('./routes/report');
const assignRoutes = require('./routes/assign');
const occupancyRoutes = require('./routes/occupancy');
const logger = require('./utils/logger');
const airportRoutes = require('./routes/airports');
const statRoutes = require('./routes/stats');

const app = express();
app.use(express.json());

// Serve viewer
app.get('/debug', (req, res) => {
  res.sendFile(path.join(__dirname, 'viewer', 'viewer.html'));
});

// API endpoint to get logs
app.get('/api/logs', (req, res) => {
  res.json(logger.getLogs());
});

// API endpoint to get Airports
app.use('/api/airports', airportRoutes);

// API endpoint to get stats (call service and return JSON)
app.use('/api/stats', statRoutes);
 
// Register routes
app.use('/debug', express.static(path.join(__dirname, 'viewer')));
app.use('/api/report', reportRoutes);
app.use('/api/assign', assignRoutes);
app.use('/api/occupancy', occupancyRoutes);

app.listen(config.port, () => {
  logger.info(`Server running at http://localhost:${config.port}`);
});
