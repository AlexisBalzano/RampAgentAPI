const express = require('express');

const env = process.env.NODE_ENV || 'default';
const config = require(`./config/${env}.js`);

const config = require('./config/${env}.js');
const reportRoutes = require('./routes/report');
const assignRoutes = require('./routes/assign');
const logger = require('./utils/logger');

const app = express();
app.use(express.json());

// Register routes
app.use('/report', reportRoutes);
app.use('/assign', assignRoutes);

app.listen(config.port, () => {
  logger.info(`Server running at http://localhost:${config.port}`);
});
