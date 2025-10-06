const express = require('express');
const path = require('path');

const env = process.env.NODE_ENV || 'default';
const config = require(`./config/${env}.js`);
const reportRoutes = require('./routes/report');
const assignRoutes = require('./routes/assign');
const logger = require('./utils/logger');

const app = express();
app.use(express.json());

// Serve viewer
app.get('/debug', (req, res) => {
  res.sendFile(path.join(__dirname, 'viewer', 'viewer.html'));
});

// Register routes
app.use('/debug', express.static(path.join(__dirname, 'viewer')));
app.use('/report', reportRoutes);
app.use('/assign', assignRoutes);

app.listen(config.port, () => {
  logger.info(`Server running at http://localhost:${config.port}`);
});
