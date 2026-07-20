const { Pool } = require('pg');
const fs = require('fs');

// Supabase connection
const supabasePool = new Pool({
  connectionString: 'postgresql://postgres.gjkjjiipcpkfifvmcbjr:uZ$HAa.pk/5z3s!@aws-1-ap-south-1.pooler.supabase.com:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  try {
    console.log('🔄 Migrating data to Supabase...');
    
    // Read backup
    const backup = JSON.parse(fs.readFileSync('backup.json', 'utf8'));
    
    // Create tables
    console.log('📊 Creating tables...');
    
    await supabasePool.query(`
      CREATE TABLE IF NOT EXISTS codes (
        code TEXT PRIMARY KEY,
        max_devices INTEGER DEFAULT 10,
        used_count INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        notes TEXT
      )
    `);
    
    await supabasePool.query(`
      CREATE TABLE IF NOT EXISTS devices (
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
    
    await supabasePool.query(`
      CREATE TABLE IF NOT EXISTS requests (
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
    
    await supabasePool.query(`
      CREATE TABLE IF NOT EXISTS usage_logs (
        id SERIAL PRIMARY KEY,
        device_id TEXT,
        code TEXT,
        action TEXT NOT NULL,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await supabasePool.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('✅ Tables created');
    
    // Insert data
    for (const [table, rows] of Object.entries(backup)) {
      if (rows.length === 0) {
        console.log(`⏭️ Skipping ${table} - no data`);
        continue;
      }
      
      console.log(`📥 Inserting ${rows.length} rows into ${table}...`);
      
      for (const row of rows) {
        const columns = Object.keys(row);
        const values = columns.map((_, i) => `$${i + 1}`);
        const query = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values.join(', ')}) ON CONFLICT (${columns[0]}) DO NOTHING`;
        const params = columns.map(col => row[col]);
        
        try {
          await supabasePool.query(query, params);
        } catch (err) {
          console.log(`⚠️ Error inserting into ${table}:`, err.message);
        }
      }
      console.log(`  ✅ Inserted ${rows.length} rows into ${table}`);
    }
    
    console.log('✅ Migration complete!');
    console.log('🎉 Your data is now on Supabase!');
    
    await supabasePool.end();
  } catch (error) {
    console.error('❌ Migration error:', error.message);
    process.exit(1);
  }
}

migrate();