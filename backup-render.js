const { Pool } = require('pg');
const fs = require('fs');

// Your Render PostgreSQL connection
const renderPool = new Pool({
  connectionString: 'postgresql://wantmatures_user:CWSWZCkVncc7RUu74TLwBFig5zeQWRRZ@dpg-d9f8ts1kh4rs7380h9sg-a.singapore-postgres.render.com/wantmatures',
  ssl: { rejectUnauthorized: false }
});

async function backup() {
  try {
    console.log('📦 Backing up data from Render PostgreSQL...');
    
    // Backup all tables
    const tables = ['admins', 'codes', 'devices', 'requests', 'usage_logs'];
    const backup = {};
    
    for (const table of tables) {
      const result = await renderPool.query(`SELECT * FROM ${table}`);
      backup[table] = result.rows;
      console.log(`  ✅ Backed up ${result.rows.length} rows from ${table}`);
    }
    
    // Save to file
    fs.writeFileSync('backup.json', JSON.stringify(backup, null, 2));
    console.log('✅ Backup saved to backup.json');
    
    await renderPool.end();
  } catch (error) {
    console.error('❌ Backup error:', error.message);
    process.exit(1);
  }
}

backup();