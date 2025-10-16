module.exports = {
  port: 3000,                   // API port
  logLevel: 'info',             // 'debug', 'info', 'warn', 'error'
  staleTimeout: 10_000,         // (ms) before a client report is considered outdated

// For c++ node addon
//   native: {
//     enabled: true,                              // disable to mock in JS
//     modulePath: './native/build/Release/assign.node', // path to compiled addon
//   },

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
