const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
require('dotenv').config();
const logger = require('./utils/logger');

const env = process.env.NODE_ENV || 'default';
const config = require(`./config/${env}.js`);
const reportController = require('./controllers/reportController');
const assignRoutes = require('./routes/assign');
const occupancyRoutes = require('./routes/occupancy');
const airportRoutes = require('./routes/airports');
const logRoutes = require('./routes/log');
const statRoutes = require('./routes/stats');
const redisService = require('./services/redisService');
const airportService = require('./services/airportService');
const healthRoutes = require('./routes/health');

const app = express();

// GitHub webhook for config updates
app.use('/api/config-webhook', express.raw({ type: 'application/json' }));


app.post('/api/config-webhook', async (req, res) => {
  const SECRET = process.env.GH_SECRET;
  if (!SECRET) {
    logger.warn('GH_SECRET not configured, skipping signature verification', { category: 'Config' });
  } else {
    const sig = req.headers['x-hub-signature-256'];
    if (sig) {
      const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(req.body).digest('hex');
      const sigBuf = Buffer.from(sig);
      const expBuf = Buffer.from(expected);
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        logger.error('Invalid webhook signature', { category: 'Config' });
        logger.error(`Computed HMAC: ${expected}`, { category: 'Config' });
        logger.error(`Received Signature: ${sig}`, { category: 'Config' });
        return res.status(403).send('Invalid signature');
      }
    } else {
      logger.warn('No signature provided', { category: 'Config' });
    }
  }
  
  logger.info('Config webhook received', { category: 'Config' });
  
  // Update config from git repo (works with volumes)
  exec('cd /app/data && git pull origin main', (err, stdout, stderr) => {
    if (err) {
      logger.error(`Config update failed: ${stderr}`, { category: 'Config' });
      return res.status(500).json({ error: stderr });
    }
    
    logger.info(`Config updated: ${stdout}`, { category: 'Config' });
    
    res.json({ 
      status: 'success',
      message: 'Config updated successfully',
      output: stdout,
      timestamp: new Date().toISOString()
    });
  });
});

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
 


// Register routes
app.use('/debug', express.static(path.join(__dirname, 'viewer')));
app.use('/api/assign', assignRoutes);
app.use('/api/occupancy', occupancyRoutes);

// Connect to Redis
redisService.connect().then(() => {
  app.listen(config.port, () => {
    logger.info(`Server running at http://localhost:${config.port}`, { category: 'System' });
    startDatafeedProcessing();
  });
}).catch(err => {
  logger.error(`Failed to start server: ${err.message}`, { category: 'System' });
  process.exit(1);
});

function startDatafeedProcessing() {
  // Initial call
  reportController.getDatafeed();
  
  const datafeedInterval = setInterval(() => {
    reportController.getDatafeed();
  }, 15_000); // Every 15 seconds since datafeed regenerate every 15 seconds
  
  // Store interval ID for cleanup
  process.datafeedInterval = datafeedInterval;
}

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

  // Clean up intervals
  if (process.datafeedInterval) {
    clearInterval(process.datafeedInterval);
    logger.info('Datafeed interval cleared', { category: 'System' });
  }

  await redisService.disconnect();
  process.exit(0);
});