module.exports = {
  port: 3000,                   // API port
  logLevel: 'info',             // 'debug', 'info', 'warn', 'error'
  staleTimeout: 10_000,         // (ms) before a client report is considered outdated
  updateInterval: 5_000,        // (ms) optional: how often to purge stale clients
  maxAlt: 15000,               // (feet) before assigning stand
  maxDistance: 50.0,           // (nm) before assigning stand

// For c++ node addon
//   native: {
//     enabled: true,                              // disable to mock in JS
//     modulePath: './native/build/Release/assign.node', // path to compiled addon
//   },

  paths: {
    airportDataDir: '../data/airports',
  },

  storage: {
    type: 'memory', // 'redis' | 'file' | 'sqlite'
    redisUrl: 'redis://localhost:6379',
    autosaveInterval: 30_000, // ms
  },

  auth: {
    enabled: false,                     // enable later
    apiKeys: ['TEST123', 'DEV456'],     // simple key auth for dev
  },
  cors: {
    allowedOrigins: ['http://localhost:5173'],
  }
};
