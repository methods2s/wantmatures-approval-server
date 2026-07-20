const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://wantmatures_user:CWSWZCkVncc7RUu74TLwBFig5zeQWRRZ@dpg-d9f8ts1kh4rs7380h9sg-a.singapore-postgres.render.com/wantmatures',
  ssl: { rejectUnauthorized: false }
});

async function reset() {
  try {
    console.log('🔄 Dropping ALL tables...');
    await pool.query('DROP TABLE IF EXISTS usage_logs CASCADE');
    await pool.query('DROP TABLE IF EXISTS requests CASCADE');
    await pool.query('DROP TABLE IF EXISTS devices CASCADE');
    await pool.query('DROP TABLE IF EXISTS codes CASCADE');
    await pool.query('DROP TABLE IF EXISTS admins CASCADE');
    console.log('✅ All tables dropped');

    console.log('📊 Creating tables WITHOUT foreign keys...');

    await pool.query(`
      CREATE TABLE codes (
        code TEXT PRIMARY KEY,
        max_devices INTEGER DEFAULT 10,
        used_count INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        notes TEXT
      )
    `);

    await pool.query(`
      CREATE TABLE devices (
        id SERIAL PRIMARY KEY,
        device_id TEXT UNIQUE NOT NULL,
        user_agent TEXT,
        ip_address TEXT,
        browser_info TEXT,
        code TEXT,
        status TEXT DEFAULT 'approved',
        approved_at TIMESTAMP,
        revoked_at TIMESTAMP,
        last_ping TIMESTAMP,
        ping_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE requests (
        id SERIAL PRIMARY KEY,
        device_id TEXT,
        code TEXT,
        reason TEXT,
        status TEXT DEFAULT 'pending',
        requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        responded_at TIMESTAMP,
        admin_response TEXT
      )
    `);

    await pool.query(`
      CREATE TABLE usage_logs (
        id SERIAL PRIMARY KEY,
        device_id TEXT,
        code TEXT,
        action TEXT NOT NULL,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE admins (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ Tables recreated successfully!');
    console.log('🎉 Now restart your server: npm start');

    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    await pool.end();
  }
}

reset();