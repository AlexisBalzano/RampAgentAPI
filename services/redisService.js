const redis = require('redis');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

class RedisService {
  constructor() {
    this.client = null;
    this.isConnected = false;
  }

  async connect() {
    try {
      this.client = redis.createClient({
        socket: {
          host: 'localhost',
          port: 6379,
          reconnectStrategy: false, // Don't auto-reconnect if Redis is down
        },
        // password: 'your-password', // if needed
      });

      this.client.on('error', (err) => {
        logger.warn(`Redis Client Error: ${err.message} - Running without cache`);
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        logger.info('Redis Client Connected');
        this.isConnected = true;
      });

      this.client.on('end', () => {
        logger.info('Redis Client Disconnected');
        this.isConnected = false;
      });

      await this.client.connect();
      this.isConnected = true;
      logger.info('Successfully connected to Redis');
    } catch (err) {
      logger.warn(`Failed to connect to Redis: ${err.message} - Application will run without caching`);
      this.isConnected = false;
      this.client = null;
    }
  }

  async getAirportConfig(icao) {
    // Validate ICAO code - should be 4 letters, not a file path
    if (!icao || typeof icao !== 'string' || icao.length !== 4 || icao.includes('\\') || icao.includes('/')) {
      logger.error(`Invalid ICAO code passed to getAirportConfig: ${icao}`);
      return null;
    }
    
    const filePath = path.join(__dirname, '..', 'data', 'airports', `${icao}.json`);
    
    if (!this.isConnected) {
      return this.loadFromFile(filePath);
    }

    try {
      const key = `airport:${icao}`;
      const cached = await this.client.get(key);

      if (cached) {
        const data = JSON.parse(cached);
        return data;
      }

      // Not in cache, load from file and cache it
      const fileData = this.loadFromFile(filePath);
      if (fileData) {
        await this.setAirportConfig(icao, fileData);
      }
      return fileData;
    } catch (err) {
      logger.warn(`Redis get error for ${icao}: ${err.message} - falling back to file`);
      return this.loadFromFile(filePath);
    }
  }

  async getConfig() {
    const configPath = path.join(__dirname, '..', 'data', 'config.json');
    
    if (!this.isConnected) {
      return this.loadFromFile(configPath);
    }

    try {
      const key = 'global:config';
      const cached = await this.client.get(key);

      if (cached) {
        const data = JSON.parse(cached);
        return data;
      }

      // Not in cache, load from file and cache it
      const fileData = this.loadFromFile(configPath);
      if (fileData) {
        await this.client.set(key, JSON.stringify(fileData));
        logger.info('Cached global config in Redis');
      }
      return fileData;
    } catch (err) {
      logger.warn(`Redis get error for config: ${err.message} - falling back to file`);
      return this.loadFromFile(configPath);
    }
  }

  async setAirportConfig(icao, data) {
    if (!this.isConnected) return;

    try {
      const key = `airport:${icao}`;
      await this.client.set(key, JSON.stringify(data), {
        EX: 3600, // Expire after 1 hour (optional)
      });
      logger.info(`Cached ${icao} config in Redis`);
    } catch (err) {
      logger.warn(`Redis set error for ${icao}: ${err.message}`);
    }
  }

  async checkAndUpdateVersion(icao) {
    if (!this.isConnected) return false;
    try {
      const filePath = path.join(__dirname, '..', 'data', 'airports', `${icao}.json`);
      const fileData = this.loadFromFile(filePath);
      if (!fileData) return false;

      const key = `airport:${icao}`;
      const cached = await this.client.get(key);

      if (!cached) {
        // Not cached yet, cache it
        await this.setAirportConfig(icao, fileData);
        return true;
      }

      const cachedData = JSON.parse(cached);
      
      // Compare versions
      if (fileData.version !== cachedData.version) {
        logger.info(`Version mismatch for ${icao}: file=${fileData.version}, cache=${cachedData.version}. Updating cache.`);
        await this.setAirportConfig(icao, fileData);
        return true;
      }

      return false; // No update needed
    } catch (err) {
      logger.warn(`Version check error for ${icao}: ${err.message}`);
      return false;
    }
  }

  async checkConfigVersion() {
    if (!this.isConnected) return false;
    try {
      const configPath = path.join(__dirname, '..', 'data', 'config.json');
      const fileData = this.loadFromFile(configPath);
      if (!fileData) return false;
      const key = 'global:config';
      const cached = await this.client.get(key);
      if (!cached) {
        await this.client.set(key, JSON.stringify(fileData));
        return true;
      }
      const cachedData = JSON.parse(cached);
      if (fileData.version !== cachedData.version) {
        logger.info(`Global config version mismatch: file=${fileData.version}, cache=${cachedData.version}. Updating cache.`);
        await this.client.set(key, JSON.stringify(fileData));
        return true;
      }
      return false;
    } catch (err) {
      logger.warn(`Global config version check error: ${err.message}`);
      return false;
    }
  }

  loadFromFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        logger.warn(`File not found: ${filePath}`);
        return null;
      }
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return data;
    } catch (err) {
      logger.error(`Failed to load from file ${filePath}: ${err.message}`);
      return null;
    }
  }

  async disconnect() {
    if (this.client && this.isConnected) {
      await this.client.disconnect();
      logger.info('Redis Client Disconnected');
    }
  }
}

// Singleton instance
const redisService = new RedisService();
module.exports = redisService;