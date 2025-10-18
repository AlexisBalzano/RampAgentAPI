const express = require('express');
const path = require('path');
require('dotenv').config();

const env = process.env.NODE_ENV || 'default';
const config = require(`./config/${env}.js`);
const reportRoutes = require('./routes/report');
const assignRoutes = require('./routes/assign');
const occupancyRoutes = require('./routes/occupancy');
const logger = require('./utils/logger');
const airportRoutes = require('./routes/airports');
const statRoutes = require('./routes/stats');
const redisService = require('./services/redisService');
const airportService = require('./services/airportService');
const authRoutes = require('./routes/auth');
const authController = require('./controllers/authController'); // To use verifyToken middleware

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
app.use('/auth', authRoutes);

// Connect to Redis
redisService.connect().then(() => {
  app.listen(config.port, () => {
    logger.info(`Server running at http://localhost:${config.port}`);
  });
}).catch(err => {
  logger.error(`Failed to start server: ${err.message}`);
  process.exit(1);
});

// Periodically check for airport config updates
setInterval(async () => {
  const airports = airportService.getAirportList();
  for (const icao of airports) {
    await airportService.checkAirportVersion(icao);
  }
  await redisService.checkConfigVersion(path.join(__dirname, '..', 'data', 'config.json'));
}, 10_000); // Check every minute

// Shutdown handling
process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  await redisService.disconnect();
  process.exit(0);
});