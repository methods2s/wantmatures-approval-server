const sqlite3 = require('sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'devices.db');

class DeviceDatabase {
  constructor() {
    this.db = new sqlite3.Database(dbPath);
    this.initTables();
    console.log('✅ Database initialized at:', dbPath);
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes, lastID: this.lastID });
      });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  initTables() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT UNIQUE NOT NULL,
        user_agent TEXT,
        ip_address TEXT,
        browser_info TEXT,
        status TEXT DEFAULT 'pending',
        approved_at DATETIME,
        revoked_at DATETIME,
        last_ping DATETIME,
        ping_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (device_id) REFERENCES devices(device_id)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ Tables created/verified');
  }

  async registerDevice(deviceId, userAgent, ip, browserInfo) {
    try {
      const result = await this.run(
        `INSERT OR IGNORE INTO devices (device_id, user_agent, ip_address, browser_info, status)
         VALUES (?, ?, ?, ?, 'pending')`,
        [deviceId, userAgent || '', ip || '', browserInfo || '']
      );
      
      await this.logUsage(deviceId, 'register', 'Device registered');
      return await this.getDevice(deviceId);
    } catch (error) {
      console.error('Register error:', error);
      throw error;
    }
  }

  async getDevice(deviceId) {
    return await this.get(`SELECT * FROM devices WHERE device_id = ?`, [deviceId]);
  }

  async getDevices(status = null) {
    let query = 'SELECT * FROM devices';
    const params = [];
    
    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY created_at DESC';
    return await this.all(query, params);
  }

  async getPendingDevices() {
    return await this.getDevices('pending');
  }

  async getApprovedDevices() {
    return await this.getDevices('approved');
  }

  async getRevokedDevices() {
    return await this.getDevices('revoked');
  }

  async approveDevice(deviceId) {
    const result = await this.run(
      `UPDATE devices 
       SET status = 'approved', 
           approved_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE device_id = ?`,
      [deviceId]
    );
    
    if (result.changes > 0) {
      await this.logUsage(deviceId, 'approve', 'Device approved');
      return true;
    }
    return false;
  }

  async revokeDevice(deviceId) {
    const result = await this.run(
      `UPDATE devices 
       SET status = 'revoked', 
           revoked_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE device_id = ?`,
      [deviceId]
    );
    
    if (result.changes > 0) {
      await this.logUsage(deviceId, 'revoke', 'Device revoked');
      return true;
    }
    return false;
  }

  async deleteDevice(deviceId) {
    const result = await this.run(`DELETE FROM devices WHERE device_id = ?`, [deviceId]);
    
    if (result.changes > 0) {
      await this.logUsage(deviceId, 'delete', 'Device deleted');
      return true;
    }
    return false;
  }

  async updatePing(deviceId) {
    await this.run(
      `UPDATE devices 
       SET last_ping = CURRENT_TIMESTAMP,
           ping_count = ping_count + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE device_id = ?`,
      [deviceId]
    );
  }

  async getDeviceStatus(deviceId) {
    const device = await this.getDevice(deviceId);
    if (!device) {
      return { exists: false, status: 'not_found' };
    }
    return { 
      exists: true, 
      status: device.status, 
      device: {
        id: device.device_id,
        approved_at: device.approved_at,
        revoked_at: device.revoked_at
      }
    };
  }

  async logUsage(deviceId, action, details = '') {
    try {
      await this.run(
        `INSERT INTO usage_logs (device_id, action, details)
         VALUES (?, ?, ?)`,
        [deviceId, action, details]
      );
    } catch (error) {
      console.error('Logging error:', error);
    }
  }

  async getUsageLogs(deviceId = null, limit = 100) {
    let query = 'SELECT * FROM usage_logs';
    const params = [];
    
    if (deviceId) {
      query += ' WHERE device_id = ?';
      params.push(deviceId);
    }
    
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    
    return await this.all(query, params);
  }

  async getStats() {
    const total = await this.get('SELECT COUNT(*) as count FROM devices');
    const pending = await this.get("SELECT COUNT(*) as count FROM devices WHERE status = 'pending'");
    const approved = await this.get("SELECT COUNT(*) as count FROM devices WHERE status = 'approved'");
    const revoked = await this.get("SELECT COUNT(*) as count FROM devices WHERE status = 'revoked'");
    const totalPings = await this.get('SELECT SUM(ping_count) as total FROM devices');

    return {
      total: total.count,
      pending: pending.count,
      approved: approved.count,
      revoked: revoked.count,
      totalPings: totalPings.total || 0
    };
  }

  async createAdmin(username, passwordHash) {
    try {
      const result = await this.run(
        `INSERT OR REPLACE INTO admins (username, password_hash)
         VALUES (?, ?)`,
        [username, passwordHash]
      );
      return result;
    } catch (error) {
      console.error('Create admin error:', error);
      return null;
    }
  }

  async getAdmin(username) {
    try {
      return await this.get(`SELECT * FROM admins WHERE username = ?`, [username]);
    } catch (error) {
      console.error('Get admin error:', error);
      return null;
    }
  }

  close() {
    this.db.close();
  }
}

module.exports = new DeviceDatabase();