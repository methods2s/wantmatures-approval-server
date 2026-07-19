require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET || 'default-secret-change-me',
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: false,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: '*',
  credentials: true
}));
app.use(express.static('public'));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

function isAuthenticated(req, res, next) {
  if (req.session && req.session.isAuthenticated) {
    return next();
  }
  res.redirect('/login');
}

function isApiAuthenticated(req, res, next) {
  if (req.session && req.session.isAuthenticated) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized', message: 'Please log in' });
}

// ============================================
// WEB ROUTES
// ============================================

app.get('/login', (req, res) => {
  if (req.session && req.session.isAuthenticated) {
    return res.redirect('/dashboard');
  }
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.render('login', { error: 'Username and password required' });
  }

  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'password123';
  
  if (username === adminUsername && password === adminPassword) {
    req.session.isAuthenticated = true;
    req.session.username = username;
    return res.redirect('/dashboard');
  }
  
  res.render('login', { error: 'Invalid username or password' });
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/dashboard', isAuthenticated, async (req, res) => {
  const devices = await db.getDevices();
  const stats = await db.getStats();
  const codes = await db.getAllCodes();
  const requests = await db.getPendingRequests();
  const codeRequests = await db.all(
    `SELECT * FROM requests WHERE code IS NULL AND status = 'pending' ORDER BY requested_at DESC`
  );
  
  res.render('dashboard', { 
    username: req.session.username,
    devices: devices,
    stats: stats,
    codes: codes,
    requests: requests,
    codeRequests: codeRequests
  });
});

app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

// ============================================
// API ROUTES
// ============================================

// ---------- REGISTRATION WITH AUTO-APPROVAL ----------

app.post('/api/register', async (req, res) => {
  const { deviceId, userAgent, browserInfo, code } = req.body;
  
  if (!deviceId) {
    return res.status(400).json({ error: 'Device ID is required' });
  }

  if (!code) {
    return res.status(400).json({ error: 'Activation code is required' });
  }

  const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  
  try {
    const result = await db.registerDeviceWithCode(deviceId, userAgent || '', ip, browserInfo || '', code.toUpperCase());
    
    if (!result.success) {
      return res.status(400).json({ 
        error: result.error,
        status: 'registration_failed',
        limitReached: result.limitReached || false
      });
    }

    res.json({
      success: true,
      status: result.status,
      code: result.code,
      message: `Device registered and auto-approved!`
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ---------- STATUS CHECK ----------

app.get('/api/status/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  
  try {
    const result = await db.getDeviceStatus(deviceId);
    
    if (!result.exists) {
      return res.status(404).json({ 
        exists: false, 
        status: 'not_found',
        message: 'Device not found - Enter code again' 
      });
    }

    await db.updatePing(deviceId);

    res.json({
      exists: true,
      status: result.status,
      code: result.code,
      device: result.device
    });
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ error: 'Failed to check status' });
  }
});

// ---------- REQUEST CODE (No email needed) ----------

app.post('/api/request-code', async (req, res) => {
  const { deviceId } = req.body;
  
  try {
    console.log(`📨 Code request from device: ${deviceId || 'unknown'}`);
    
    // Check if device already has a pending request
    const existing = await db.get(
      `SELECT * FROM requests WHERE device_id = ? AND code IS NULL AND status = 'pending'`,
      [deviceId || 'unknown']
    );
    
    if (existing) {
      return res.status(400).json({ 
        error: 'You already have a pending request. Please wait for admin.' 
      });
    }
    
    await db.run(
      `INSERT INTO requests (device_id, code, reason, status)
       VALUES (?, ?, ?, 'pending')`,
      [deviceId || 'unknown', null, 'New user requesting activation code']
    );
    
    await db.logUsage(deviceId || 'unknown', null, 'code_request', 
      `Code requested by device`);
    
    res.json({
      success: true,
      message: 'Code request submitted. Admin will review.',
      requestId: existing ? existing.id : 'new'
    });
    
  } catch (error) {
    console.error('Code request error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// ---------- GENERATE CODE FOR USER ----------

app.post('/api/generate-code-for-user', isApiAuthenticated, async (req, res) => {
  const { requestId, maxDevices = 10, notes = '' } = req.body;
  
  if (!requestId) {
    return res.status(400).json({ error: 'Request ID is required' });
  }
  
  try {
    // Get the request
    const request = await db.get(`SELECT * FROM requests WHERE id = ?`, [requestId]);
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }
    
    // Generate code
    const code = await db.generateCode(maxDevices, req.session.username, notes || `For user: ${request.device_id}`);
    
    // Update the request
    await db.run(
      `UPDATE requests 
       SET status = 'approved', 
           code = ?,
           admin_response = ?,
           responded_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [code, `Code generated by ${req.session.username}`, requestId]
    );
    
    res.json({
      success: true,
      code: code,
      maxDevices: maxDevices,
      message: `Code generated successfully`
    });
    
  } catch (error) {
    console.error('Generate code for user error:', error);
    res.status(500).json({ error: 'Failed to generate code' });
  }
});

// ---------- GENERATE CODE (Admin) ----------

app.post('/api/generate-code', isApiAuthenticated, async (req, res) => {
  const { maxDevices = 10, notes = '' } = req.body;
  
  try {
    const code = await db.generateCode(maxDevices, req.session.username, notes);
    res.json({ 
      success: true, 
      code: code,
      maxDevices: maxDevices,
      message: `Code generated successfully`
    });
  } catch (error) {
    console.error('Generate code error:', error);
    res.status(500).json({ error: 'Failed to generate code' });
  }
});

// ---------- GET ALL CODES ----------

app.get('/api/codes', isApiAuthenticated, async (req, res) => {
  try {
    const codes = await db.getAllCodes();
    res.json(codes);
  } catch (error) {
    console.error('Get codes error:', error);
    res.status(500).json({ error: 'Failed to get codes' });
  }
});

// ---------- GET CODE USAGE ----------

app.get('/api/code/:code/usage', isApiAuthenticated, async (req, res) => {
  const { code } = req.params;
  
  try {
    const usage = await db.getCodeUsage(code);
    res.json(usage);
  } catch (error) {
    console.error('Code usage error:', error);
    res.status(500).json({ error: 'Failed to get code usage' });
  }
});

// ---------- DEACTIVATE CODE ----------

app.post('/api/code/:code/deactivate', isApiAuthenticated, async (req, res) => {
  const { code } = req.params;
  
  try {
    const success = await db.deactivateCode(code);
    if (success) {
      res.json({ success: true, message: `Code deactivated` });
    } else {
      res.status(404).json({ error: 'Code not found' });
    }
  } catch (error) {
    console.error('Deactivate code error:', error);
    res.status(500).json({ error: 'Failed to deactivate code' });
  }
});

// ---------- EXTEND CODE ----------

app.post('/api/code/:code/extend', isApiAuthenticated, async (req, res) => {
  const { code } = req.params;
  const { maxDevices } = req.body;
  
  if (!maxDevices || maxDevices < 1) {
    return res.status(400).json({ error: 'maxDevices is required and must be > 0' });
  }
  
  try {
    const success = await db.extendCode(code, maxDevices);
    if (success) {
      res.json({ success: true, message: `Code extended to ${maxDevices} devices` });
    } else {
      res.status(404).json({ error: 'Code not found' });
    }
  } catch (error) {
    console.error('Extend code error:', error);
    res.status(500).json({ error: 'Failed to extend code' });
  }
});

// ---------- REMOVE USER (Frees slot) ----------

app.delete('/api/device/:deviceId', isApiAuthenticated, async (req, res) => {
  const { deviceId } = req.params;
  
  try {
    const success = await db.removeUser(deviceId);
    if (success) {
      res.json({ 
        success: true, 
        message: `User removed, slot freed. Device will need to re-enter code.` 
      });
    } else {
      res.status(404).json({ error: 'Device not found' });
    }
  } catch (error) {
    console.error('Remove user error:', error);
    res.status(500).json({ error: 'Failed to remove user' });
  }
});

// ---------- REVOKE DEVICE ----------

app.post('/api/revoke/:deviceId', isApiAuthenticated, async (req, res) => {
  const { deviceId } = req.params;
  
  try {
    const success = await db.revokeDevice(deviceId);
    if (success) {
      res.json({ success: true, message: `Device revoked, slot freed` });
    } else {
      res.status(404).json({ error: 'Device not found' });
    }
  } catch (error) {
    console.error('Revoke error:', error);
    res.status(500).json({ error: 'Failed to revoke device' });
  }
});

// ---------- REACTIVATE DEVICE ----------

app.post('/api/reactivate/:deviceId', isApiAuthenticated, async (req, res) => {
  const { deviceId } = req.params;
  
  try {
    const result = await db.reactivateDevice(deviceId);
    if (result && result.success !== false) {
      res.json({ success: true, message: `Device reactivated` });
    } else if (result && result.error) {
      res.status(400).json({ error: result.error });
    } else {
      res.status(404).json({ error: 'Device not found' });
    }
  } catch (error) {
    console.error('Reactivate error:', error);
    res.status(500).json({ error: 'Failed to reactivate device' });
  }
});

// ---------- REQUEST MORE SLOTS ----------

app.post('/api/request', async (req, res) => {
  const { deviceId, code, reason } = req.body;
  
  if (!deviceId) {
    return res.status(400).json({ error: 'Device ID is required' });
  }
  
  try {
    const result = await db.createRequest(deviceId, code || null, reason || '');
    if (result.success) {
      res.json({ 
        success: true, 
        requestId: result.id,
        message: 'Request submitted successfully'
      });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    console.error('Request error:', error);
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

// ---------- GET ALL REQUESTS ----------

app.get('/api/requests', isApiAuthenticated, async (req, res) => {
  try {
    const requests = await db.getAllRequests();
    res.json(requests);
  } catch (error) {
    console.error('Get requests error:', error);
    res.status(500).json({ error: 'Failed to get requests' });
  }
});

// ---------- GET PENDING REQUESTS ----------

app.get('/api/requests/pending', isApiAuthenticated, async (req, res) => {
  try {
    const requests = await db.getPendingRequests();
    res.json(requests);
  } catch (error) {
    console.error('Get pending requests error:', error);
    res.status(500).json({ error: 'Failed to get pending requests' });
  }
});

// ---------- GET PENDING CODE REQUESTS ----------

app.get('/api/requests/code', isApiAuthenticated, async (req, res) => {
  try {
    const requests = await db.all(
      `SELECT * FROM requests 
       WHERE code IS NULL AND status = 'pending'
       ORDER BY requested_at DESC`
    );
    res.json(requests);
  } catch (error) {
    console.error('Get code requests error:', error);
    res.status(500).json({ error: 'Failed to get code requests' });
  }
});

// ---------- RESPOND TO REQUEST ----------

app.post('/api/request/:requestId/respond', isApiAuthenticated, async (req, res) => {
  const { requestId } = req.params;
  const { status, response } = req.body;
  
  if (!status || !['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status must be "approved" or "rejected"' });
  }
  
  try {
    const success = await db.respondToRequest(requestId, status, response || '');
    if (success) {
      res.json({ success: true, message: `Request ${status}` });
    } else {
      res.status(404).json({ error: 'Request not found' });
    }
  } catch (error) {
    console.error('Respond to request error:', error);
    res.status(500).json({ error: 'Failed to respond to request' });
  }
});

// ---------- GET STATS ----------

app.get('/api/stats', isApiAuthenticated, async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json(stats);
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// ---------- GET LOGS ----------

app.get('/api/logs', isApiAuthenticated, async (req, res) => {
  try {
    const { deviceId, limit = 100 } = req.query;
    const logs = await db.getUsageLogs(deviceId, parseInt(limit));
    res.json(logs);
  } catch (error) {
    console.error('Logs error:', error);
    res.status(500).json({ error: 'Failed to get logs' });
  }
});

// ---------- GET DASHBOARD DATA ----------

app.get('/api/dashboard-data', isApiAuthenticated, async (req, res) => {
  try {
    const devices = await db.getDevices();
    const stats = await db.getStats();
    const codes = await db.getAllCodes();
    const requests = await db.getPendingRequests();
    const codeRequests = await db.all(
      `SELECT * FROM requests WHERE code IS NULL AND status = 'pending' ORDER BY requested_at DESC`
    );
    
    res.json({
      stats,
      devices,
      codes,
      requests,
      codeRequests,
      username: req.session.username
    });
  } catch (error) {
    console.error('Dashboard data error:', error);
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

// ============================================
// CREATE DEFAULT ADMIN
// ============================================

async function createDefaultAdmin() {
  try {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'password123';
    
    const existing = await db.getAdmin(username);
    if (!existing) {
      const hash = await bcrypt.hash(password, 10);
      await db.createAdmin(username, hash);
      console.log(`✅ Default admin created: ${username}`);
      console.log(`🔑 Password: ${password}`);
    } else {
      console.log(`✅ Admin already exists: ${username}`);
    }
  } catch (error) {
    console.error('Failed to create default admin:', error);
  }
}

// ============================================
// START SERVER
// ============================================

createDefaultAdmin().then(() => {
  app.listen(PORT, () => {
    console.log('\n' + '='.repeat(50));
    console.log('🚀 Server is running!');
    console.log('='.repeat(50));
    console.log(`📡 URL: http://localhost:${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`🔑 Username: ${process.env.ADMIN_USERNAME || 'admin'}`);
    console.log(`🔒 Password: ${process.env.ADMIN_PASSWORD || 'password123'}`);
    console.log('='.repeat(50));
    console.log('⚠️  IMPORTANT: Change your password in Render env vars!');
    console.log('='.repeat(50) + '\n');
  });
});

module.exports = app;