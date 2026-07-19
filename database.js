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
    // Devices table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT UNIQUE NOT NULL,
        user_agent TEXT,
        ip_address TEXT,
        browser_info TEXT,
        code TEXT,
        status TEXT DEFAULT 'approved',
        approved_at DATETIME,
        revoked_at DATETIME,
        last_ping DATETIME,
        ping_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (code) REFERENCES codes(code)
      )
    `);

    // Codes table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS codes (
        code TEXT PRIMARY KEY,
        max_devices INTEGER DEFAULT 10,
        used_count INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT 1,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        notes TEXT
      )
    `);

    // Requests table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        code TEXT,
        reason TEXT,
        status TEXT DEFAULT 'pending',
        requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        responded_at DATETIME,
        admin_response TEXT,
        FOREIGN KEY (device_id) REFERENCES devices(device_id)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        code TEXT,
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

  // ============================================
  // CODE MANAGEMENT
  // ============================================

  async generateCode(maxDevices = 10, createdBy = 'admin', notes = '') {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    code = code.slice(0, 4) + '-' + code.slice(4);

    try {
      await this.run(
        `INSERT INTO codes (code, max_devices, created_by, notes)
         VALUES (?, ?, ?, ?)`,
        [code, maxDevices, createdBy, notes || '']
      );
      console.log(`✅ Code generated: ${code} (max: ${maxDevices} devices)`);
      return code;
    } catch (error) {
      console.error('Generate code error:', error);
      throw error;
    }
  }

  async getCodeInfo(code) {
    return await this.get(`SELECT * FROM codes WHERE code = ?`, [code]);
  }

  async getAllCodes() {
    return await this.all(`SELECT * FROM codes ORDER BY created_at DESC`);
  }

  async getActiveCodes() {
    return await this.all(
      `SELECT * FROM codes WHERE is_active = 1 AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`
    );
  }

  async getCodeUsage(code) {
    const devices = await this.all(
      `SELECT * FROM devices WHERE code = ? AND status != 'revoked'`,
      [code]
    );
    const codeInfo = await this.getCodeInfo(code);
    return {
      code: code,
      used: devices.length,
      max: codeInfo ? codeInfo.max_devices : 0,
      devices: devices
    };
  }

  async deactivateCode(code) {
    const result = await this.run(
      `UPDATE codes SET is_active = 0 WHERE code = ?`,
      [code]
    );
    if (result.changes > 0) {
      console.log(`✅ Code deactivated: ${code}`);
      return true;
    }
    return false;
  }

  async extendCode(code, maxDevices) {
    const result = await this.run(
      `UPDATE codes SET max_devices = ? WHERE code = ?`,
      [maxDevices, code]
    );
    if (result.changes > 0) {
      console.log(`✅ Code extended: ${code} -> max ${maxDevices} devices`);
      return true;
    }
    return false;
  }

  // ============================================
  // DEVICE REGISTRATION WITH AUTO-APPROVAL
  // ============================================

  async registerDeviceWithCode(deviceId, userAgent, ip, browserInfo, code) {
    // Check if code exists and is active
    const codeInfo = await this.getCodeInfo(code);
    if (!codeInfo) {
      return { success: false, error: 'Invalid code' };
    }

    if (!codeInfo.is_active) {
      return { success: false, error: 'Code is inactive' };
    }

    if (codeInfo.expires_at && new Date(codeInfo.expires_at) < new Date()) {
      return { success: false, error: 'Code has expired' };
    }

    // Check if device already exists
    const existingDevice = await this.getDevice(deviceId);
    if (existingDevice) {
      // If device exists with this code, just reactivate/update
      if (existingDevice.code === code) {
        await this.run(
          `UPDATE devices 
           SET status = 'approved', 
               user_agent = ?, 
               ip_address = ?, 
               browser_info = ?,
               updated_at = CURRENT_TIMESTAMP 
           WHERE device_id = ?`,
          [userAgent || '', ip || '', browserInfo || '', deviceId]
        );
        await this.logUsage(deviceId, code, 're-register', 'Device re-registered');
        return { success: true, status: 'approved', code: code };
      }
      // Device exists with different code - allow re-register if code has space
      // But we'll check limit first
    }

    // Check code usage limit
    const usage = await this.getCodeUsage(code);
    if (usage.used >= usage.max) {
      await this.logUsage(deviceId, code, 'registration_failed', 'Code limit reached');
      return { success: false, error: `Code limit reached (${usage.max} devices max)`, limitReached: true };
    }

    // Register device with AUTO-APPROVAL
    await this.run(
      `INSERT INTO devices (device_id, user_agent, ip_address, browser_info, code, status, approved_at)
       VALUES (?, ?, ?, ?, ?, 'approved', CURRENT_TIMESTAMP)`,
      [deviceId, userAgent || '', ip || '', browserInfo || '', code]
    );

    // Update code usage count
    await this.run(
      `UPDATE codes SET used_count = used_count + 1 WHERE code = ?`,
      [code]
    );

    await this.logUsage(deviceId, code, 'register', 'Device registered and auto-approved');
    return { success: true, status: 'approved', code: code };
  }

  // ============================================
  // REQUEST MANAGEMENT
  // ============================================

  async createRequest(deviceId, code, reason = '') {
    // Check if device exists
    const device = await this.getDevice(deviceId);
    if (!device) {
      return { success: false, error: 'Device not found' };
    }

    // Check if there's already a pending request
    const existing = await this.get(
      `SELECT * FROM requests WHERE device_id = ? AND status = 'pending'`,
      [deviceId]
    );
    if (existing) {
      return { success: false, error: 'You already have a pending request' };
    }

    try {
      const result = await this.run(
        `INSERT INTO requests (device_id, code, reason)
         VALUES (?, ?, ?)`,
        [deviceId, code || device.code, reason || 'Need more slots']
      );
      await this.logUsage(deviceId, code || device.code, 'request', 'Device requested more slots');
      return { success: true, id: result.lastID };
    } catch (error) {
      console.error('Create request error:', error);
      return { success: false, error: 'Failed to create request' };
    }
  }

  async getPendingRequests() {
    return await this.all(
      `SELECT r.*, d.status as device_status 
       FROM requests r
       LEFT JOIN devices d ON r.device_id = d.device_id
       WHERE r.status = 'pending'
       ORDER BY r.requested_at ASC`
    );
  }

  async getAllRequests() {
    return await this.all(
      `SELECT r.*, d.status as device_status 
       FROM requests r
       LEFT JOIN devices d ON r.device_id = d.device_id
       ORDER BY r.requested_at DESC`
    );
  }

  async respondToRequest(requestId, status, adminResponse = '') {
    const request = await this.get(`SELECT * FROM requests WHERE id = ?`, [requestId]);
    if (!request) return false;

    const result = await this.run(
      `UPDATE requests 
       SET status = ?, responded_at = CURRENT_TIMESTAMP, admin_response = ?
       WHERE id = ?`,
      [status, adminResponse, requestId]
    );
    
    if (result.changes > 0) {
      await this.logUsage(request.device_id, request.code, 'request_response', 
        `Request ${status}: ${adminResponse}`);
      
      // If approved, update the code limit
      if (status === 'approved') {
        const codeInfo = await this.getCodeInfo(request.code);
        if (codeInfo) {
          const newLimit = codeInfo.max_devices + 1;
          await this.extendCode(request.code, newLimit);
          await this.logUsage(request.device_id, request.code, 'code_extended', 
            `Extended to ${newLimit} devices due to request`);
        }
      }
      return true;
    }
    return false;
  }

  async getRequestByDevice(deviceId) {
    return await this.all(
      `SELECT * FROM requests WHERE device_id = ? ORDER BY requested_at DESC`,
      [deviceId]
    );
  }

  // ============================================
  // DEVICE MANAGEMENT (with slot freeing)
  // ============================================

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

  async getDevicesByCode(code) {
    return await this.all(`SELECT * FROM devices WHERE code = ? ORDER BY created_at DESC`, [code]);
  }

  // REMOVE USER - frees up a slot and device will need to re-enter code
  async removeUser(deviceId) {
    const device = await this.getDevice(deviceId);
    if (!device) return false;

    // Delete the device completely (frees up the slot)
    const result = await this.run(
      `DELETE FROM devices WHERE device_id = ?`,
      [deviceId]
    );
    
    if (result.changes > 0) {
      // Decrement code usage count
      if (device.code) {
        await this.run(
          `UPDATE codes SET used_count = used_count - 1 WHERE code = ?`,
          [device.code]
        );
        await this.logUsage(deviceId, device.code, 'remove_user', 'User removed, slot freed');
      }
      return true;
    }
    return false;
  }

  // Alternative: Revoke but keep record
  async revokeDevice(deviceId) {
    const device = await this.getDevice(deviceId);
    if (!device) return false;

    const result = await this.run(
      `UPDATE devices 
       SET status = 'revoked', 
           revoked_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE device_id = ?`,
      [deviceId]
    );
    
    if (result.changes > 0) {
      // Decrement code usage count
      if (device.code) {
        await this.run(
          `UPDATE codes SET used_count = used_count - 1 WHERE code = ?`,
          [device.code]
        );
        await this.logUsage(deviceId, device.code, 'revoke', 'Device revoked, slot freed');
      }
      return true;
    }
    return false;
  }

  // Reactivate a revoked device
  async reactivateDevice(deviceId) {
    const device = await this.getDevice(deviceId);
    if (!device) return false;

    // Check if code still has space
    if (device.code) {
      const usage = await this.getCodeUsage(device.code);
      const codeInfo = await this.getCodeInfo(device.code);
      if (usage.used >= codeInfo.max_devices) {
        return { success: false, error: 'Code is full' };
      }
    }

    const result = await this.run(
      `UPDATE devices 
       SET status = 'approved', 
           approved_at = CURRENT_TIMESTAMP,
           revoked_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE device_id = ?`,
      [deviceId]
    );
    
    if (result.changes > 0) {
      if (device.code) {
        await this.run(
          `UPDATE codes SET used_count = used_count + 1 WHERE code = ?`,
          [device.code]
        );
        await this.logUsage(deviceId, device.code, 'reactivate', 'Device reactivated');
      }
      return { success: true };
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
      code: device.code,
      device: {
        id: device.device_id,
        approved_at: device.approved_at,
        revoked_at: device.revoked_at
      }
    };
  }

  async logUsage(deviceId, code, action, details = '') {
    try {
      await this.run(
        `INSERT INTO usage_logs (device_id, code, action, details)
         VALUES (?, ?, ?, ?)`,
        [deviceId, code || null, action, details]
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
    const totalCodes = await this.get('SELECT COUNT(*) as count FROM codes');
    const pendingRequests = await this.get("SELECT COUNT(*) as count FROM requests WHERE status = 'pending'");

    return {
      total: total.count,
      pending: pending.count,
      approved: approved.count,
      revoked: revoked.count,
      totalPings: totalPings.total || 0,
      totalCodes: totalCodes.count,
      pendingRequests: pendingRequests.count
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