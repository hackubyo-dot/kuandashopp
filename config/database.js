// config/database.js - VERSÃO APENAS COM CONEXÃO
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_M4JBtEeqFaG1@ep-old-mouse-abonaj64-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require',
  ssl: {
    rejectUnauthorized: false
  },
  max: 20, // Número máximo de clientes no pool
  idleTimeoutMillis: 30000, // Tempo que um cliente pode ficar ocioso
  connectionTimeoutMillis: 20000, // Tempo máximo para conectar
});

// Testar conexão imediatamente
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ ERRO AO CONECTAR AO BANCO DE DADOS:', err.message);
    console.error('❌ Stack trace:', err.stack);
    console.error('❌ URL do banco:', process.env.DATABASE_URL ? 'Configurada via .env' : 'Usando URL padrão');
  } else {
    console.log('✅ CONEXÃO COM BANCO DE DADOS ESTABELECIDA COM SUCESSO!');
    release();
  }
});

// Tratamento de erros do pool
pool.on('error', (err) => {
  console.error('❌ ERRO NO POOL DE CONEXÕES:', err.message);
  console.error('❌ Stack trace:', err.stack);
});

// Função para executar queries
const query = (text, params) => {
  return pool.query(text, params);
};

// Função para obter cliente do pool
const getClient = async () => {
  const client = await pool.connect();
  const query = client.query.bind(client);
  const release = client.release.bind(client);
  
  // Configurar timeout
  const timeout = setTimeout(() => {
    console.error('❌ QUERY EXCEDEU TEMPO LIMITE');
    release();
  }, 30000);
  
  client.query = (...args) => {
    clearTimeout(timeout);
    return query(...args).finally(() => {
      clearTimeout(timeout);
    });
  };
  
  return client;
};

module.exports = { 
  query, 
  pool,
  getClient
};