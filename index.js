const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();
const logger = require("./utils/logger");
const { exec } = require('child_process');

const env = process.env.NODE_ENV || "default";
const config = require(`./config/${env}.js`);
const reportController = require("./controllers/reportController");
const assignRoutes = require("./routes/assign");
const occupancyRoutes = require("./routes/occupancy");
const airportRoutes = require("./routes/airports");
const logRoutes = require("./routes/log");
const statRoutes = require("./routes/stats");
const redisService = require("./services/redisService");
const airportService = require("./services/airportService");
const airportIndex = require("./services/airportIndex");
const healthRoutes = require("./routes/health");
const authRoutes = require("./routes/auth");
const apiKeyRoutes = require("./routes/APIkey");

const app = express();

// GitHub webhook for config updates
app.use('/api/config-webhook', express.raw({ type: 'application/json' }));


app.post('/api/config-webhook', async (req, res) => {
  const SECRET = process.env.GH_SECRET;
  if (!SECRET) {
    logger.warn('GH_SECRET not configured, skipping signature verification', { category: 'System' });
  } else {
    const sig = req.headers['x-hub-signature-256'];
    if (sig) {
      const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(req.body).digest('hex');
      const sigBuf = Buffer.from(sig);
      const expBuf = Buffer.from(expected);
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        logger.error('Invalid webhook signature', { category: 'System' });
        return res.status(403).send('Invalid signature');
      }
    } else {
      logger.warn('No signature provided', { category: 'System' });
    }
  }

  logger.info('Config webhook received', { category: 'System' });

  // Update config from git repo (works with volumes)
  exec('cd /app/data && git pull origin main', (err, stdout, stderr) => {
    if (err) {
      logger.error(`Config update failed: ${stderr}`, { category: 'System' });
      return res.status(500).json({ error: stderr });
    }

    logger.info(`Config updated: ${stdout}`, { category: 'System' });

    // The pull replaced the config files: drop every cached copy so the next
    // datafeed cycle recompiles from disk.
    airportIndex.invalidateAll();

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
//
// The viewer has no content-hashed filenames, so a browser is free to apply
// heuristic caching and keep running a previous build's script.js long after a
// deploy - the page then talks to a newer API with older code. The shell is
// served with the asset URLs stamped with the build's mtime, so a deploy
// changes the URL and the new files are fetched immediately.
const VIEWER_DIR = path.join(__dirname, "viewer");
const VERSIONED_ASSETS = ["script.js", "styles.css"];
let shellCache = null;

function viewerAssetVersion() {
  let newest = 0;
  for (const name of VERSIONED_ASSETS) {
    try {
      const { mtimeMs } = fs.statSync(path.join(VIEWER_DIR, name));
      if (mtimeMs > newest) newest = mtimeMs;
    } catch (err) {
      /* asset missing: fall back to whatever the others report */
    }
  }
  return Math.round(newest).toString(36);
}

app.get("/", (req, res) => {
  try {
    const version = viewerAssetVersion();
    if (!shellCache || shellCache.version !== version) {
      let html = fs.readFileSync(path.join(VIEWER_DIR, "viewer.html"), "utf8");
      for (const name of VERSIONED_ASSETS) {
        html = html.replace(`"${name}"`, `"${name}?v=${version}"`);
      }
      shellCache = { version, html };
    }
    res.set("Cache-Control", "no-cache");
    res.type("html").send(shellCache.html);
  } catch (err) {
    logger.error(`Failed to serve viewer shell: ${err.message}`, {
      category: "System",
    });
    res.sendFile(path.join(VIEWER_DIR, "viewer.html"));
  }
});

app.use(
  "/",
  express.static(VIEWER_DIR, {
    setHeaders: (res, filePath) => {
      if (/\.(js|css|html)$/i.test(filePath)) {
        res.set("Cache-Control", "no-cache");
      }
    },
  })
);

// Authentication routes
app.use("/api/auth", authRoutes);

// Health endpoint for load balancer
app.use("/health", healthRoutes);

// API endpoint to get logs
app.use("/api/logs", logRoutes);

// API endpoint to get Airports
app.use("/api/airports", airportRoutes);

// API endpoint to get stats (call service and return JSON)
app.use("/api/stats", statRoutes);

// API endpoint for Stands management
app.use("/api/assign", assignRoutes);
app.use("/api/occupancy", occupancyRoutes);

// API endpoint for API key management
app.use("/api/apikey", apiKeyRoutes);

// Connect to Redis
redisService
  .connect()
  .then(() => {
    app.listen(config.port, () => {
      logger.info(`Server running at http://localhost:${config.port}`, {
        category: "System",
      });
      startDatafeedProcessing();
    });
  })
  .catch((err) => {
    logger.error(`Failed to start server: ${err.message}`, {
      category: "System",
    });
    process.exit(1);
  });

function startDatafeedProcessing() {
  // getDatafeed handles its own errors, but an unforeseen rejection escaping it
  // would kill the process rather than one cycle.
  const runCycle = () =>
    Promise.resolve(reportController.getDatafeed()).catch((err) => {
      logger.error(`Datafeed cycle failed: ${err && err.stack ? err.stack : err}`, {
        category: "Report",
      });
    });

  // Initial call
  runCycle();

  const datafeedInterval = setInterval(runCycle, 15_000); // Every 15 seconds since datafeed regenerate every 15 seconds

  // Store interval ID for cleanup
  process.datafeedInterval = datafeedInterval;
}

// Periodically check for airport config updates. A version bump has to drop the
// in-process compiled copies as well, or the datafeed loop keeps serving the
// old config.
setInterval(async () => {
  // Anything thrown in here would otherwise become an unhandled rejection and
  // terminate the process. The check is idempotent, so losing one round is
  // harmless - the next one is ten seconds away.
  try {
    const airports = airportService.refreshAirportList();
    for (const icao of airports) {
      if (await airportService.checkAirportVersion(icao)) {
        airportIndex.invalidate(icao);
      }
    }
    if (await redisService.checkConfigVersion()) {
      airportService.invalidateConfig();
    }
  } catch (err) {
    logger.warn(`Config version check failed: ${err.message}`, {
      category: "System",
    });
  }
}, 10_000); // Check every 10 seconds

// Last-resort handlers. Node terminates on an unhandled rejection, so a stray
// throw in a background task used to end the process with nothing written down
// - the container simply vanished. The periodic work here is idempotent and
// retried, so a rejection is reported and the API keeps serving; a genuine
// uncaught exception still exits, but only after the reason has been recorded.
process.on("unhandledRejection", (reason) => {
  logger.error(
    `Unhandled promise rejection: ${reason && reason.stack ? reason.stack : reason}`,
    { category: "System" }
  );
});

process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception: ${err && err.stack ? err.stack : err}`, {
    category: "System",
  });
  // Process state is no longer trustworthy: get the log on disk, then let the
  // restart policy take over.
  Promise.resolve(logger.flush())
    .catch(() => {})
    .finally(() => process.exit(1));
});

// Shutdown handling
process.on("SIGINT", async () => {
  logger.info("Shutting down...", { category: "System" });

  // Clean up intervals
  if (process.datafeedInterval) {
    clearInterval(process.datafeedInterval);
    logger.info("Datafeed interval cleared", { category: "System" });
  }

  await redisService.disconnect();
  process.exit(0);
});
