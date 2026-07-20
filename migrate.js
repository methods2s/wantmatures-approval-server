cat > migrate.js << 'EOF'
const { Pool } = require('pg');
const sqlite3 = require('sqlite3');
const path = require('path');

async function migrate() {
  console.log('🔄 Starting migration from SQLite to PostgreSQL...');
  
  // Connect to SQLite
  const sqlite = new sqlite3.Database(path.join(__dirname, 'data', 'devices.db'));
  
  // Connect to PostgreSQL
  const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://wantmatures_user:CWSWZCkVncc7RUu74TLwBFig5zeQWRRZ@dpg-d9f8ts1kh4rs7380h9sg-a.singapore-postgres.render.com/wantmatures',
    ssl: { rejectUnauthorized: false }
  });

  try {
    // Test connection
    await pgPool.query('SELECT NOW()');
    console.log('✅ Connected to PostgreSQL');

    // Migrate admins
    console.log('📊 Migrating admins...');
    const admins = await new Promise((resolve, reject) => {
      sqlite.all('SELECT * FROM admins', (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    for (const admin of admins) {
      await pgPool.query(
        `INSERT INTO admins (username, password_hash, created_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (username) DO NOTHING`,
        [admin.username, admin.password_hash, admin.created_at]
      );
      console.log(`  ✅ Migrated admin: ${admin.username}`);
    }

    // Migrate codes
    console.log('📊 Migrating codes...');
    const codes = await new Promise((resolve, reject) => {
      sqlite.all('SELECT * FROM codes', (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    for (const code of codes) {
      await pgPool.query(
        `INSERT INTO codes (code, max_devices, used_count, is_active, created_by, created_at, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (code) DO NOTHING`,
        [code.code, code.max_devices, code.used_count, code.is_active, code.created_by, code.created_at, code.notes]
      );
      console.log(`  ✅ Migrated code: ${code.code}`);
    }

    // Migrate devices
    console.log('📊 Migrating devices...');
    const devices = await new Promise((resolve, reject) => {
      sqlite.all('SELECT * FROM devices', (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    for (const device of devices) {
      await pgPool.query(
        `INSERT INTO devices (device_id, user_agent, ip_address, browser_info, code, status, approved_at, revoked_at, last_ping, ping_count, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (device_id) DO NOTHING`,
        [device.device_id, device.user_agent, device.ip_address, device.browser_info, device.code, 
         device.status, device.approved_at, device.revoked_at, device.last_ping, device.ping_count, 
         device.created_at, device.updated_at]
      );
      console.log(`  ✅ Migrated device: ${device.device_id}`);
    }

    // Migrate requests
    console.log('📊 Migrating requests...');
    const requests = await new Promise((resolve, reject) => {
      sqlite.all('SELECT * FROM requests', (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    for (const request of requests) {
      await pgPool.query(
        `INSERT INTO requests (id, device_id, code, reason, status, requested_at, responded_at, admin_response)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [request.id, request.device_id, request.code, request.reason, request.status, 
         request.requested_at, request.responded_at, request.admin_response]
      );
      console.log(`  ✅ Migrated request #${request.id}`);
    }

    // Migrate usage logs
    console.log('📊 Migrating usage logs...');
    const logs = await new Promise((resolve, reject) => {
      sqlite.all('SELECT * FROM usage_logs', (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    for (const log of logs) {
      await pgPool.query(
        `INSERT INTO usage_logs (id, device_id, code, action, details, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [log.id, log.device_id, log.code, log.action, log.details, log.created_at]
      );
    }
    console.log(`  ✅ Migrated ${logs.length} usage logs`);

    console.log('🎉 Migration complete! All data transferred to PostgreSQL.');
    console.log('📊 Summary:');
    console.log(`  - ${admins.length} admins`);
    console.log(`  - ${codes.length} codes`);
    console.log(`  - ${devices.length} devices`);
    console.log(`  - ${requests.length} requests`);
    console.log(`  - ${logs.length} usage logs`);
    
  } catch (error) {
    console.error('❌ Migration error:', error);
  } finally {
    sqlite.close();
    await pgPool.end();
  }
}

migrate();
EOF