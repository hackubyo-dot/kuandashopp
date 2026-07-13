const { Pool } = require('pg');
const fs = require('fs').promises;
const path = require('path');

async function initDatabase() {
  const pool = new Pool({
    connectionString: 'postgresql://neondb_owner:npg_M4JBtEeqFaG1@ep-old-mouse-abonaj64-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
    ssl: {
      rejectUnauthorized: false
    }
  });

  try {
    console.log('🔄 Inicializando banco de dados...');
    
    // Ler arquivo SQL
    const sql = await fs.readFile(path.join(__dirname, 'config', 'init-db.sql'), 'utf8');
    
    // Executar script SQL
    await pool.query(sql);
    
    console.log('✅ Banco de dados inicializado com sucesso!');
    console.log('👤 Admin criado: admin@kuandashop.ao / password');
    
  } catch (error) {
    console.error('❌ Erro ao inicializar banco de dados:', error);
  } finally {
    await pool.end();
  }
}

initDatabase();