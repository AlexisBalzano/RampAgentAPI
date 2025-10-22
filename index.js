const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
require('dotenv').config();
const logger = require('./utils/logger');

const env = process.env.NODE_ENV || 'default';
const config = require(`./config/${env}.js`);
const reportRoutes = require('./routes/report');
const assignRoutes = require('./routes/assign');
const occupancyRoutes = require('./routes/occupancy');
const airportRoutes = require('./routes/airports');
const logRoutes = require('./routes/log');
const statRoutes = require('./routes/stats');
const redisService = require('./services/redisService');
const airportService = require('./services/airportService');
const authRoutes = require('./routes/auth');
const authController = require('./controllers/authController'); // To use verifyToken middleware
const healthRoutes = require('./routes/health');

const app = express();
app.use(express.json());

// Serve viewer
app.get('/debug', (req, res) => {
  res.sendFile(path.join(__dirname, 'viewer', 'viewer.html'));
});

// Health endpoint for load balancer
app.use('/health', healthRoutes);

// API endpoint to get logs
app.use('/api/logs', logRoutes);

// API endpoint to get Airports
app.use('/api/airports', airportRoutes);

// API endpoint to get stats (call service and return JSON)
app.use('/api/stats', statRoutes);
 
// Github webhook for automatic deployment of config
// TODO: add webhook to GitHub repo when url confirmed
// TODO: add secret to .env
const SECRET = process.env.GH_SECRET;
app.post('/api/github-webhook', (req, res) => {
  const sig = req.headers['x-hub-signature-256'];
  const hmac = 'sha256=' + crypto.createHmac('sha256', SECRET).update(JSON.stringify(req.body)).digest('hex');
  if (sig !== hmac) return res.status(403).send('Invalid signature');

  exec('cd /data && git pull origin main', (err, stdout, stderr) => {
    if (err) return res.status(500).send(stderr);
    res.send('Config updated:\n' + stdout);
  });
});

// Register routes
app.use('/debug', express.static(path.join(__dirname, 'viewer')));
app.use('/api/report', reportRoutes);
app.use('/api/assign', assignRoutes);
app.use('/api/occupancy', occupancyRoutes);
app.use('/auth', authRoutes);

// Connect to Redis
redisService.connect().then(() => {
  app.listen(config.port, () => {
    logger.info(`Server running at http://localhost:${config.port}`, { category: 'System' });
  });
}).catch(err => {
  logger.error(`Failed to start server: ${err.message}`, { category: 'System' });
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
  logger.info('Shutting down...', { category: 'System' });
  await redisService.disconnect();
  process.exit(0);
});