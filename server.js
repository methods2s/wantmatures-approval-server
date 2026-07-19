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

// ============================================
// FIX: Trust proxy for Render
// ============================================
app.set('trust proxy', 1);

// ============================================
// SESSION CONFIGURATION
// ============================================

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

// ============================================
// MIDDLEWARE
// ============================================

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

// ============================================
// AUTHENTICATION MIDDLEWARE
// ============================================

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
  
  res.render('dashboard', { 
    username: req.session.username,
    devices: devices,
    stats: stats,
    codes: codes,
    requests: requests
  });
});

app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

// ============================================
// API ROUTES
// ============================================

// ---------- REGISTRATION WITH CODE ----------

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
        status: 'registration_failed'
      });
    }

    res.json({
      success: true,
      status: result.status,
      code: result.code,
      message: `Device registered with code`
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
        message: 'Device not found' 
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

// ---------- CODE MANAGEMENT (Admin) ----------

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

app.get('/api/codes', isApiAuthenticated, async (req, res) => {
  try {
    const codes = await db.getAllCodes();
    res.json(codes);
  } catch (error) {
    console.error('Get codes error:', error);
    res.status(500).json({ error: 'Failed to get codes' });
  }
});

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

// ---------- DEVICE MANAGEMENT (Admin) ----------

app.post('/api/approve/:deviceId', isApiAuthenticated, async (req, res) => {
  const { deviceId } = req.params;
  
  try {
    const success = await db.approveDevice(deviceId);
    if (success) {
      res.json({ success: true, message: `Device approved` });
    } else {
      res.status(404).json({ error: 'Device not found' });
    }
  } catch (error) {
    console.error('Approval error:', error);
    res.status(500).json({ error: 'Failed to approve device' });
  }
});

app.post('/api/revoke/:deviceId', isApiAuthenticated, async (req, res) => {
  const { deviceId } = req.params;
  
  try {
    const success = await db.revokeDevice(deviceId);
    if (success) {
      res.json({ success: true, message: `Device revoked` });
    } else {
      res.status(404).json({ error: 'Device not found' });
    }
  } catch (error) {
    console.error('Revoke error:', error);
    res.status(500).json({ error: 'Failed to revoke device' });
  }
});

app.delete('/api/device/:deviceId', isApiAuthenticated, async (req, res) => {
  const { deviceId } = req.params;
  
  try {
    const success = await db.deleteDevice(deviceId);
    if (success) {
      res.json({ success: true, message: `Device deleted` });
    } else {
      res.status(404).json({ error: 'Device not found' });
    }
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete device' });
  }
});

// ---------- REQUEST MANAGEMENT ----------

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

app.get('/api/requests', isApiAuthenticated, async (req, res) => {
  try {
    const requests = await db.getAllRequests();
    res.json(requests);
  } catch (error) {
    console.error('Get requests error:', error);
    res.status(500).json({ error: 'Failed to get requests' });
  }
});

app.get('/api/requests/pending', isApiAuthenticated, async (req, res) => {
  try {
    const requests = await db.getPendingRequests();
    res.json(requests);
  } catch (error) {
    console.error('Get pending requests error:', error);
    res.status(500).json({ error: 'Failed to get pending requests' });
  }
});

app.post('/api/request/:requestId/respond', isApiAuthenticated, async (req, res) => {
  const { requestId } = req.params;
  const { status, response } = req.body;
  
  if (!status || !['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status must be "approved" or "rejected"' });
  }
  
  try {
    const success = await db.respondToRequest(requestId, status, response || '');
    if (success) {
      // If approved, also approve the device
      if (status === 'approved') {
        const request = await db.get(`SELECT device_id FROM requests WHERE id = ?`, [requestId]);
        if (request) {
          await db.approveDevice(request.device_id);
        }
      }
      res.json({ success: true, message: `Request ${status}` });
    } else {
      res.status(404).json({ error: 'Request not found' });
    }
  } catch (error) {
    console.error('Respond to request error:', error);
    res.status(500).json({ error: 'Failed to respond to request' });
  }
});

// ---------- STATS & LOGS ----------

app.get('/api/stats', isApiAuthenticated, async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json(stats);
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

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

app.get('/api/dashboard-data', isApiAuthenticated, async (req, res) => {
  try {
    const devices = await db.getDevices();
    const stats = await db.getStats();
    const codes = await db.getAllCodes();
    const requests = await db.getPendingRequests();
    
    res.json({
      stats,
      devices,
      codes,
      requests,
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
    console.log(`📡 URL: https://wantmatures-approval-server.onrender.com`);
    console.log(`📊 Dashboard: https://wantmatures-approval-server.onrender.com/dashboard`);
    console.log(`🔑 Username: ${process.env.ADMIN_USERNAME || 'admin'}`);
    console.log(`🔒 Password: ${process.env.ADMIN_PASSWORD || 'password123'}`);
    console.log('='.repeat(50));
    console.log('⚠️  IMPORTANT: Change your password in Render env vars!');
    console.log('='.repeat(50) + '\n');
  });
});

module.exports = app;