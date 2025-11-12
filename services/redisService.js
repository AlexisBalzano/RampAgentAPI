const redis = require("redis");
const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const crypto = require("crypto");
const ADMIN_CIDS = require("../config/admins");

class RedisService {
  // Default expiration times in seconds
  static KEY_EXPIRATION = 24 * 60 * 60 * 30; // 30 days
  static KEY_METADATA_EXPIRATION = 30 * 24 * 60 * 60 * 2; // 60 days

  constructor() {
    this.client = null;
    this.isConnected = false;
  }

  async connect() {
    try {
      this.client = redis.createClient({
        socket: {
          host: process.env.REDIS_HOST || "localhost",
          port: parseInt(process.env.REDIS_PORT) || 6379,
          reconnectStrategy: false, // Don't auto-reconnect if Redis is down
        },
        password: process.env.REDIS_PASSWORD || undefined,
      });

      this.client.on("error", (err) => {
        logger.warn(
          `Redis Client Error: ${err.message} - Running without cache`,
          { category: "System" }
        );
        this.isConnected = false;
      });

      this.client.on("connect", () => {
        logger.info("Redis Client Connected", { category: "System" });
        this.isConnected = true;
      });

      this.client.on("end", () => {
        logger.info("Redis Client Disconnected", { category: "System" });
        this.isConnected = false;
      });

      await this.client.connect();
      this.isConnected = true;
      logger.info("Successfully connected to Redis", { category: "System" });
    } catch (err) {
      logger.warn(`Failed to connect to Redis: ${err.message}`, {
        category: "System",
      });
      this.isConnected = false;
      this.client = null;
    }
  }

  async getAirportConfig(icao) {
    // Validate ICAO code - should be 4 letters, not a file path
    if (
      !icao ||
      typeof icao !== "string" ||
      icao.length !== 4 ||
      icao.includes("\\") ||
      icao.includes("/")
    ) {
      logger.error(`Invalid ICAO code passed to getAirportConfig: ${icao}`, {
        category: "System",
      });
      return null;
    }

    const filePath = path.join(
      __dirname,
      "..",
      "data",
      "airports",
      `${icao}.json`
    );

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
      logger.warn(
        `Redis get error for ${icao}: ${err.message} - falling back to file`,
        { category: "System" }
      );
      return this.loadFromFile(filePath);
    }
  }

  async getConfig() {
    const configPath = path.join(__dirname, "..", "data", "config.json");

    if (!this.isConnected) {
      return this.loadFromFile(configPath);
    }

    try {
      const key = "global:config";
      const cached = await this.client.get(key);

      if (cached) {
        const data = JSON.parse(cached);
        return data;
      }

      // Not in cache, load from file and cache it
      const fileData = this.loadFromFile(configPath);
      if (fileData) {
        await this.client.set(key, JSON.stringify(fileData));
      }
      return fileData;
    } catch (err) {
      logger.warn(
        `Redis get error for config: ${err.message} - falling back to file`,
        { category: "System" }
      );
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
    } catch (err) {
      logger.warn(`Redis set error for ${icao}: ${err.message}`, {
        category: "System",
      });
    }
  }

  async checkAndUpdateVersion(icao) {
    if (!this.isConnected) return false;
    try {
      const filePath = path.join(
        __dirname,
        "..",
        "data",
        "airports",
        `${icao}.json`
      );
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
        logger.info(
          `Version mismatch for ${icao}: file=${fileData.version}, cache=${cachedData.version}. Updating cache.`,
          { category: "System" }
        );
        await this.setAirportConfig(icao, fileData);
        return true;
      }

      return false; // No update needed
    } catch (err) {
      logger.warn(`Version check error for ${icao}: ${err.message}`, {
        category: "System",
      });
      return false;
    }
  }

  async checkConfigVersion() {
    if (!this.isConnected) return false;
    try {
      const configPath = path.join(__dirname, "..", "data", "config.json");
      const fileData = this.loadFromFile(configPath);
      if (!fileData) return false;
      const key = "global:config";
      const cached = await this.client.get(key);
      if (!cached) {
        await this.client.set(key, JSON.stringify(fileData));
        return true;
      }
      const cachedData = JSON.parse(cached);
      if (fileData.version !== cachedData.version) {
        logger.info(
          `Global config version mismatch: file=${fileData.version}, cache=${cachedData.version}. Updating cache.`,
          { category: "System" }
        );
        await this.client.set(key, JSON.stringify(fileData));
        return true;
      }
      return false;
    } catch (err) {
      logger.warn(`Global config version check error: ${err.message}`, {
        category: "System",
      });
      return false;
    }
  }

  loadFromFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        logger.warn(`File not found: ${filePath}`, { category: "System" });
        return null;
      }
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return data;
    } catch (err) {
      logger.error(`Failed to load from file ${filePath}: ${err.message}`, {
        category: "System",
      });
      return null;
    }
  }

  async disconnect() {
    if (this.client && this.isConnected) {
      await this.client.disconnect();
      logger.info("Redis Client Disconnected", { category: "System" });
    }
  }

  async getAllLocalUsers() {
    if (!this.isConnected) return null;
    try {
      const keys = await this.client.keys("user:*:settings");
      const users = [];
      for (const key of keys) {
        const cid = key.split(":")[1];
        users.push({ cid });
      }
      return users;
    } catch (err) {
      logger.warn(`Failed to get all local users: ${err.message}`, {
        category: "System",
      });
      return null;
    }
  }

  async getLocalUser(cid) {
    if (!this.isConnected) return {};

    try {
      const key = `user:${cid}:settings`;
      const settings = await this.client.get(key);
      return settings ? JSON.parse(settings) : {};
    } catch (err) {
      logger.warn(`Failed to get local user for ${cid}: ${err.message}`, {
        category: "System",
      });
      return {};
    }
  }

  VALID_ROLES = ["admin"];

  async validateRole(role) {
    return VALID_ROLES.includes(role);
  }

  async ensureAdminRoles() {
    if (!this.isConnected) return;

    try {
      // Ensure all admin CIDs have admin role
      for (const cid of ADMIN_CIDS) {
        const user = await this.getLocalUser(cid);
        if (!user.roles || !user.roles.includes("admin")) {
          await this.updateLocalUser(cid, {
            roles: [...(user.roles || []), "admin"],
            updated_at: new Date().toISOString(),
          });
          logger.info(`Admin role granted to CID: ${cid}`, {
            category: "System",
          });
        }
      }
    } catch (err) {
      logger.error(`Failed to ensure admin roles: ${err.message}`, {
        category: "System",
      });
    }
  }

  async updateLocalUser(cid, settings) {
    if (!this.isConnected) return false;

    // Local user settings : {
    //   roles: [ 'admin', 'user' ],
    //   cid: cid,
    //   api_key: '',
    //   full_name: '',
    //   first_name: '',
    //   last_name: '',
    //   email: '',
    //   core_session_token: '',
    // }

    try {
      const key = `user:${cid}:settings`;
      const existing = await this.getLocalUser(cid);

      // Check if this is first login for an admin (only if roles are missing or empty)
      if (
        ADMIN_CIDS.includes(cid) &&
        (!existing.roles || existing.roles.length === 0)
      ) {
        settings.roles = ["admin"];
        logger.info(`First login: admin role granted to CID: ${cid}`, {
          category: "System",
        });
      }

      // Validate roles if they're being updated
      if (settings.roles) {
        if (!Array.isArray(settings.roles)) {
          logger.warn(`Invalid roles format for ${cid}`, {
            category: "System",
          });
          return false;
        }

        // Filter out invalid roles
        settings.roles = settings.roles.filter((role) =>
          this.VALID_ROLES.includes(role)
        );
      }

      const updated = { ...existing, ...settings };
      await this.client.set(key, JSON.stringify(updated));
      return updated;
    } catch (err) {
      logger.warn(`Failed to update local user for ${cid}: ${err.message}`, {
        category: "System",
      });
      return false;
    }
  }

  async hasRole(cid, role) {
    const user = await this.getLocalUser(cid);
    return user.roles && Array.isArray(user.roles) && user.roles.includes(role);
  }

  async getRoles(cid) {
    const user = await this.getLocalUser(cid);
    return user.roles || [];
  }

  async addRole(cid, role) {
    if (!VALID_ROLES.includes(role)) {
      logger.warn(`Invalid role: ${role}`, { category: "System" });
      return false;
    }

    const user = await this.getLocalUser(cid);
    user.roles = Array.from(new Set([...(user.roles || []), role]));
    return await this.updateLocalUser(cid, user);
  }

  async removeRole(cid, role) {
    const user = await this.getLocalUser(cid);
    if (!user.roles) return true;
    user.roles = user.roles.filter((r) => r !== role);
    return await this.updateLocalUser(cid, user);
  }

  async getAllKeys() {
    if (!this.isConnected) return [];

    try {
      // Get all keys except metadata keys
      const keys = await this.client.keys("*");
      const nonMetaKeys = keys.filter((key) => !key.startsWith("meta:"));

      // Get metadata for each key
      const keysWithMetadata = await Promise.all(
        nonMetaKeys.map(async (key) => {
          const metadata = await this.getKeyMetadata(key);
          return {
            key,
            metadata,
          };
        })
      );

      return keysWithMetadata;
    } catch (err) {
      logger.warn(`Failed to get all keys: ${err.message}`, {
        category: "System",
      });
      return [];
    }
  }

  async createKey(key, expireIn = RedisService.KEY_EXPIRATION) {
    if (!this.isConnected) return false;
    try {
      const raw = crypto.randomBytes(bytes); // cryptographically secure
      // base64url: replace +/ with -_ and remove trailing = padding
      const value = raw
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      // Store the key value with expiration
      await this.client.set(key, value, { EX: expireIn });

      // Store metadata about the key
      const metadata = {
        created_at: Date.now(),
        last_used: Date.now(),
        expires_at: Date.now() + expireIn * 1000,
        value_type: typeof value,
      };

      await this.client.set(`meta:${key}`, JSON.stringify(metadata), {
        EX: RedisService.KEY_METADATA_EXPIRATION,
      });

      return true;
    } catch (err) {
      logger.warn(`Failed to create key ${key}: ${err.message}`, {
        category: "System",
      });
      return false;
    }
  }

  async renewKey(key, value, expireIn = RedisService.KEY_EXPIRATION) {
    if (!this.isConnected) return false;
    try {
      const exists = await this.client.exists(key);
      if (exists) {
        // Update the key value and reset expiration
        await this.client.set(key, value, { EX: expireIn });

        // Update metadata
        const metaKey = `meta:${key}`;
        const existingMeta = await this.client.get(metaKey);
        const metadata = existingMeta ? JSON.parse(existingMeta) : {};

        metadata.last_used = Date.now();
        metadata.expires_at = Date.now() + expireIn * 1000;

        await this.client.set(metaKey, JSON.stringify(metadata), {
          EX: RedisService.KEY_METADATA_EXPIRATION,
        });

        return true;
      }
      return false;
    } catch (err) {
      logger.warn(`Failed to renew key ${key}: ${err.message}`, {
        category: "System",
      });
      return false;
    }
  }

  async getKeyMetadata(key) {
    if (!this.isConnected) return null;
    try {
      const metaKey = `meta:${key}`;
      const metadata = await this.client.get(metaKey);
      return metadata ? JSON.parse(metadata) : null;
    } catch (err) {
      logger.warn(`Failed to get metadata for key ${key}: ${err.message}`, {
        category: "System",
      });
      return null;
    }
  }

  async deleteKey(key) {
    if (!this.isConnected) return false;
    try {
      const exists = await this.client.exists(key);
      if (exists) {
        // Delete both the key and its metadata
        await Promise.all([
          this.client.del(key),
          this.client.del(`meta:${key}`),
        ]);
        return true;
      }
      return false;
    } catch (err) {
      logger.warn(`Failed to delete key ${key}: ${err.message}`, {
        category: "System",
      });
      return false;
    }
  }

  async getKeyById(id) {
    if (!this.isConnected) return null;
    try {
      // Get key value
      const value = await this.client.get(id);
      if (!value) return null;

      // Get metadata separately
      const metadata = await this.getKeyMetadata(id);

      // Try to parse value if it's JSON, otherwise return as is
      let parsedValue;
      try {
        parsedValue = JSON.parse(value);
      } catch {
        parsedValue = value;
      }

      return {
        value: parsedValue,
        expires_at: metadata?.expires_at || null,
        metadata,
      };
    } catch (err) {
      logger.warn(`Failed to get key ${id}: ${err.message}`, {
        category: "System",
      });
      return null;
    }
  }
}

// Singleton instance
const redisService = new RedisService();
module.exports = redisService;
