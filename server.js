const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const flash = require('express-flash');
const methodOverride = require('method-override');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const db = require('./config/database');
const expressLayouts = require('express-ejs-layouts');
const fs = require('fs');
const { Pool } = require('pg');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const https = require('https');
const vendasRoutes = require('./routes/gerenciar-vendas');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CRIAÇÃO DA TABELA DE BACKUP DE IMAGENS ====================
// (Execute esta query no seu banco de dados PostgreSQL)

/*
CREATE TABLE IF NOT EXISTS imagens_backup (
    id SERIAL PRIMARY KEY,
    nome_arquivo VARCHAR(500) UNIQUE NOT NULL,
    caminho_arquivo VARCHAR(1000) NOT NULL,
    dados_imagem BYTEA NOT NULL,
    tipo_mime VARCHAR(100) NOT NULL,
    tamanho INTEGER NOT NULL,
    tabela_origem VARCHAR(100),
    registro_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_imagens_backup_nome_arquivo ON imagens_backup(nome_arquivo);
CREATE INDEX IF NOT EXISTS idx_imagens_backup_tabela_registro ON imagens_backup(tabela_origem, registro_id);
*/

// ==================== FUNÇÕES DE BACKUP/RECUPERAÇÃO HÍBRIDA ====================

/**
 * Salva uma imagem no backup BYTEA
 * @param {string} filePath - Caminho completo do arquivo
 * @param {string} fileName - Nome do arquivo
 * @param {string} tabelaOrigem - Tabela de origem (ex: 'produtos', 'usuarios')
 * @param {number} registroId - ID do registro relacionado
 * @returns {Promise<boolean>} - Sucesso da operação
 */
const salvarBackupImagem = async (filePath, fileName, tabelaOrigem = null, registroId = null) => {
    try {
        if (!fs.existsSync(filePath)) {
            console.error(`❌ Arquivo não encontrado para backup: ${filePath}`);
            return false;
        }

        // Ler arquivo
        const imagemBuffer = fs.readFileSync(filePath);
        const stats = fs.statSync(filePath);
        a
        // Detectar tipo MIME
        const mimeType = getMimeType(filePath);
        
        // Gerar caminho relativo para fácil recuperação
        const caminhoRelativo = filePath.replace('public/', '');
        
        // Inserir no banco de dados
        await db.query(
            `INSERT INTO imagens_backup 
             (nome_arquivo, caminho_arquivo, dados_imagem, tipo_mime, tamanho, tabela_origem, registro_id) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (nome_arquivo) 
             DO UPDATE SET 
                dados_imagem = EXCLUDED.dados_imagem,
                caminho_arquivo = EXCLUDED.caminho_arquivo,
                tipo_mime = EXCLUDED.tipo_mime,
                tamanho = EXCLUDED.tamanho,
                tabela_origem = EXCLUDED.tabela_origem,
                registro_id = EXCLUDED.registro_id`,
            [
                fileName,
                caminhoRelativo,
                imagemBuffer,
                mimeType,
                stats.size,
                tabelaOrigem,
                registroId
            ]
        );
        
        console.log(`✅ Backup BYTEA salvo: ${fileName} (${(stats.size / 1024).toFixed(2)} KB)`);
        return true;
    } catch (error) {
        console.error(`❌ Erro ao salvar backup BYTEA (${fileName}):`, error);
        return false;
    }
};

/**
 * Recupera uma imagem do backup BYTEA
 * @param {string} fileName - Nome do arquivo a ser recuperado
 * @returns {Promise<object|null>} - Dados da imagem ou null se não encontrada
 */
const recuperarImagemBackup = async (fileName) => {
    try {
        const result = await db.query(
            `SELECT dados_imagem, tipo_mime, caminho_arquivo 
             FROM imagens_backup 
             WHERE nome_arquivo = $1`,
            [fileName]
        );
        
        if (result.rows.length > 0 && result.rows[0].dados_imagem) {
            const imagemData = result.rows[0];
            console.log(`✅ Imagem recuperada do backup BYTEA: ${fileName}`);
            return {
                buffer: imagemData.dados_imagem,
                mimeType: imagemData.tipo_mime || 'image/jpeg',
                caminho: imagemData.caminho_arquivo
            };
        }
        return null;
    } catch (error) {
        console.error(`❌ Erro ao recuperar imagem do backup (${fileName}):`, error);
        return null;
    }
};

/**
 * Recria arquivo no disco a partir do backup BYTEA
 * @param {string} fileName - Nome do arquivo
 * @param {string} outputPath - Caminho completo de saída (opcional)
 * @returns {Promise<string|null>} - Caminho do arquivo recriado ou null
 */
const recriarArquivoDoBackup = async (fileName, outputPath = null) => {
    try {
        const imagemData = await recuperarImagemBackup(fileName);
        
        if (!imagemData) {
            return null;
        }
        
        // Determinar caminho de saída
        let filePath;
        if (outputPath) {
            filePath = outputPath;
        } else {
            // Usar caminho original ou padrão
            if (imagemData.caminho) {
                filePath = path.join('public', imagemData.caminho);
            } else {
                // Tentar determinar baseado no nome do arquivo
                if (fileName.includes('banner')) {
                    filePath = path.join('public/uploads/banners/', fileName);
                } else if (fileName.includes('perfil')) {
                    filePath = path.join('public/uploads/perfil/', fileName);
                } else if (fileName.includes('filme') || fileName.includes('poster')) {
                    filePath = path.join('public/uploads/filmes/', fileName);
                } else if (fileName.includes('game') || fileName.includes('capa') || fileName.includes('screenshot')) {
                    filePath = path.join('public/uploads/games/', fileName);
                } else {
                    filePath = path.join('public/uploads/produtos/', fileName);
                }
            }
        }
        
        // Garantir que o diretório existe
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        // Escrever arquivo
        fs.writeFileSync(filePath, imagemData.buffer);
        console.log(`✅ Arquivo recriado do backup: ${filePath}`);
        
        return filePath;
    } catch (error) {
        console.error(`❌ Erro ao recriar arquivo do backup (${fileName}):`, error);
        return null;
    }
};

/**
 * Função auxiliar para detectar MIME type baseado na extensão
 * @param {string} filePath - Caminho do arquivo
 * @returns {string} - Tipo MIME
 */
const getMimeType = (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.svg': 'image/svg+xml'
    };
    return mimeTypes[ext] || 'application/octet-stream';
};

/**
 * Função para limpar backups antigos (opcional, para manutenção)
 * @param {number} daysOld - Dias para considerar como antigo
 * @returns {Promise<number>} - Número de registros removidos
 */
const limparBackupsAntigos = async (daysOld = 30) => {
    try {
        const result = await db.query(
            `DELETE FROM imagens_backup 
             WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '${daysOld} days'
             RETURNING id`
        );
        console.log(`🧹 ${result.rowCount} backups antigos removidos`);
        return result.rowCount;
    } catch (error) {
        console.error('❌ Erro ao limpar backups antigos:', error);
        return 0;
    }
};

// ==================== CONFIGURAÇÃO DE EMAIL (BLINDADA + CORREÇÃO FINAL) ====================

// Carrega as credenciais do ambiente
const emailUser = process.env.EMAIL_USER || '';
const emailPassRaw = process.env.EMAIL_PASS || '';
const emailPass = emailPassRaw.replace(/\s+/g, ''); // Remove espaços automaticamente

// Verificação das variáveis de ambiente
if (!emailUser) {
    console.warn('⚠️ EMAIL_USER não foi configurado nas variáveis de ambiente.');
}

if (!emailPassRaw) {
    console.warn('⚠️ EMAIL_PASS não foi configurado nas variáveis de ambiente.');
}

const transporter = nodemailer.createTransport({

    // Servidor SMTP do Gmail
    host: 'smtp.gmail.com',

    // Porta STARTTLS
    port: 587,

    // OBRIGATÓRIO para porta 587
    secure: false,

    auth: {
        user: emailUser,
        pass: emailPass
    },

    tls: {
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2'
    },

    // Timeouts
    connectionTimeout: 15000, // Tempo para conectar ao servidor
    greetingTimeout: 15000,   // Tempo para receber saudação do servidor
    socketTimeout: 30000,     // Tempo máximo da conexão

    // Logs
    logger: false,
    debug: false

});

// ==================== TESTE DA CONEXÃO SMTP ====================

if (emailUser && emailPass) {

    transporter.verify((error, success) => {

        if (error) {

            console.error('❌ Erro na conexão SMTP');
            console.error('Mensagem:', error.message);
            console.error('Código:', error.code || 'N/A');
            console.error('Comando:', error.command || 'N/A');

        } else {

            console.log('✅ Servidor de Email pronto para envios!');
            console.log(`📧 Conta utilizada: ${emailUser}`);

        }

    });

} else {

    console.warn('⚠️ SMTP desativado: EMAIL_USER ou EMAIL_PASS não configurados.');

}

// ==================== TESTE DA CONEXÃO SMTP ====================

if (emailUser && emailPass) {

    transporter.verify((error, success) => {

        if (error) {

            console.error("❌ Erro na conexão SMTP");
            console.error("Mensagem:", error.message);
            console.error("Código:", error.code || "N/A");
            console.error("Comando:", error.command || "N/A");

        } else {

            console.log("✅ Servidor SMTP conectado com sucesso!");
            console.log("📧 Email:", emailUser);

        }

    });

} else {

    console.warn("⚠️ SMTP desativado porque EMAIL_USER ou EMAIL_PASS não estão configurados.");

}

// ==================== CONFIGURAÇÃO DO PASSPORT (GOOGLE) - FULL CORRIGIDA ====================

const googleClientID = process.env.GOOGLE_CLIENT_ID || '';
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || '';

// Validação das credenciais
if (!googleClientID) {
    console.warn('⚠️ GOOGLE_CLIENT_ID não configurado no .env');
} else {
    console.log('✅ GOOGLE_CLIENT_ID carregado:', googleClientID.substring(0, 20) + '...');
}

if (!googleClientSecret) {
    console.warn('⚠️ GOOGLE_CLIENT_SECRET não configurado no .env');
} else {
    console.log('✅ GOOGLE_CLIENT_SECRET carregado');
}

// Verificação se o Passport já tem a estratégia registrada
// (evita erro de "Strategy already registered")
if (passport._strategies && passport._strategies.google) {
    console.log('🔄 Google Strategy já registrada. Substituindo...');
    passport.unuse('google');
}

// Configuração do Google Strategy
passport.use(new GoogleStrategy(
{
    // Credenciais do Google
    clientID: googleClientID,
    clientSecret: googleClientSecret,
    
    // URLs de callback - dinâmicas baseadas no ambiente
    callbackURL: process.env.NODE_ENV === 'production' 
        ? 'https://kuanda.onrender.com/auth/google/callback'
        : 'http://localhost:3000/auth/google/callback',
    
    // Proxy para funcionar em produção (Render/Heroku)
    proxy: true,
    
    // Permissões solicitadas
    scope: ['profile', 'email'],
    
    // Parâmetros adicionais para melhor compatibilidade
    accessType: 'offline',
    prompt: 'consent',
    
    // Timeout para evitar travamentos
    timeout: 10000
},
async (accessToken, refreshToken, profile, done) => {
    try {
        // ==================== 1. VALIDAÇÕES INICIAIS ====================
        
        if (!profile) {
            console.error('❌ Profile do Google é nulo');
            return done(new Error("Perfil do Google não recebido."), null);
        }

        if (!profile.id) {
            console.error('❌ Profile ID não encontrado');
            return done(new Error("Google ID não encontrado."), null);
        }

        if (!profile.emails || profile.emails.length === 0) {
            console.error('❌ Nenhum email encontrado no profile');
            return done(new Error("O Google não retornou um endereço de e-mail."), null);
        }

        const email = profile.emails[0].value;
        const nome = profile.displayName || "Usuário Google";
        const avatar = profile.photos && profile.photos.length > 0 ? profile.photos[0].value : null;

        console.log(`🔍 Processando login Google: ${email}`);

        // ==================== 2. VERIFICAÇÃO DE SEGURANÇA ====================
        
        // Verifica se o email é válido (não vazio)
        if (!email || email.trim() === '') {
            return done(new Error("Email inválido."), null);
        }

        // Verifica se o email é do domínio permitido (opcional)
        // const allowedDomains = ['gmail.com', 'kuandashop.com'];
        // const emailDomain = email.split('@')[1];
        // if (!allowedDomains.includes(emailDomain)) {
        //     return done(new Error("Domínio de email não permitido."), null);
        // }

        // ==================== 3. PROCURA POR GOOGLE_ID EXISTENTE ====================

        let userResult = await db.query(
            'SELECT * FROM usuarios WHERE google_id = $1',
            [profile.id]
        );

        if (userResult.rows.length > 0) {
            const user = userResult.rows[0];
            
            // Atualiza o avatar se mudou
            if (avatar && user.foto_perfil !== avatar) {
                await db.query(
                    'UPDATE usuarios SET foto_perfil = $1 WHERE id = $2',
                    [avatar, user.id]
                );
                console.log(`📸 Avatar atualizado para ${email}`);
            }
            
            console.log(`✅ Usuário encontrado por Google ID: ${email}`);
            return done(null, user);
        }

        // ==================== 4. PROCURA POR EMAIL EXISTENTE ====================

        userResult = await db.query(
            'SELECT * FROM usuarios WHERE email = $1',
            [email]
        );

        if (userResult.rows.length > 0) {
            const existingUser = userResult.rows[0];
            
            // Se o usuário já existe mas não tem google_id, vincula a conta
            if (!existingUser.google_id) {
                const updatedUser = await db.query(
                    `UPDATE usuarios 
                     SET google_id = $1, 
                         email_verificado = TRUE,
                         foto_perfil = COALESCE($2, foto_perfil)
                     WHERE email = $3
                     RETURNING *`,
                    [profile.id, avatar, email]
                );
                
                console.log(`✅ Conta vinculada ao Google: ${email}`);
                return done(null, updatedUser.rows[0]);
            } else {
                // Se já tem google_id, mas é diferente do atual (caso raro)
                console.warn(`⚠️ Email ${email} já está vinculado a outro Google ID`);
                return done(new Error("Esta conta já está vinculada a outra conta Google."), null);
            }
        }

        // ==================== 5. CRIAÇÃO DE NOVO USUÁRIO ====================

        console.log(`🆕 Criando novo usuário Google: ${email}`);

        const newUser = await db.query(
            `INSERT INTO usuarios (
                nome, 
                email, 
                google_id, 
                foto_perfil,
                tipo, 
                email_verificado, 
                loja_ativa,
                created_at,
                updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
            RETURNING *`,
            [
                nome,
                email,
                profile.id,
                avatar,
                'cliente',
                true,
                true
            ]
        );

        console.log(`✅ Novo usuário Google criado: ${email} (ID: ${newUser.rows[0].id})`);
        
        return done(null, newUser.rows[0]);

    } catch (err) {
        console.error('❌ Erro na autenticação Google:', err);
        console.error('Stack:', err.stack);
        return done(err, null);
    }
}));

// ==================== SERIALIZAÇÃO ====================

passport.serializeUser((user, done) => {
    try {
        if (!user || !user.id) {
            return done(new Error("Usuário inválido para serialização"), null);
        }
        console.log(`🔐 Serializando usuário ID: ${user.id}`);
        done(null, user.id);
    } catch (err) {
        console.error('❌ Erro na serialização:', err);
        done(err, null);
    }
});

// ==================== DESSERIALIZAÇÃO ====================

passport.deserializeUser(async (id, done) => {
    try {
        if (!id) {
            return done(new Error("ID inválido para desserialização"), null);
        }
        
        console.log(`🔓 Desserializando usuário ID: ${id}`);
        
        const userResult = await db.query(
            'SELECT * FROM usuarios WHERE id = $1',
            [id]
        );
        
        if (userResult.rows.length === 0) {
            console.warn(`⚠️ Usuário não encontrado para ID: ${id}`);
            return done(null, null);
        }
        
        const user = userResult.rows[0];
        
        // Remove dados sensíveis antes de enviar (opcional)
        // delete user.senha;
        // delete user.reset_token;
        
        return done(null, user);
        
    } catch (err) {
        console.error('❌ Erro na desserialização:', err);
        return done(err, null);
    }
});

// ==================== MIDDLEWARE DE AUTENTICAÇÃO ====================

// Middleware para verificar autenticação via Passport e Session
const requireAuth = (req, res, next) => {
    // Verifica se o usuário está na sessão (seu sistema)
    if (req.session.user) {
        return next();
    }
    
    // Verifica se o usuário está autenticado via Passport
    if (req.isAuthenticated && req.isAuthenticated()) {
        // Sincroniza com sua sessão personalizada
        req.session.user = req.user;
        return next();
    }
    
    // Se não estiver autenticado, redireciona
    req.flash('error', 'Você precisa fazer login para acessar esta página');
    return res.redirect('/login');
};

const requireVendor = (req, res, next) => {
    if (!req.session.user || req.session.user.tipo !== 'vendedor') {
        req.flash('error', 'Acesso restrito a vendedores');
        return res.redirect('/');
    }
    next();
};

const requireAdmin = (req, res, next) => {
    if (!req.session.user || req.session.user.tipo !== 'admin') {
        req.flash('error', 'Acesso restrito a administradores');
        return res.redirect('/');
    }
    next();
};

// ==================== ROTAS GOOGLE AUTH ====================

// Iniciar login com Google
app.get('/auth/google',
    (req, res, next) => {
        console.log('🚀 Iniciando autenticação Google...');
        // Salva a URL de destino para redirecionar depois
        if (req.query.returnTo) {
            req.session.returnTo = req.query.returnTo;
        }
        next();
    },
    passport.authenticate('google', { 
        scope: ['profile', 'email'],
        prompt: 'select_account' // Força a seleção de conta
    })
);

// Callback do Google
app.get('/auth/google/callback',
    (req, res, next) => {
        console.log('🔄 Google callback recebido');
        next();
    },
    passport.authenticate('google', { 
        failureRedirect: '/login?error=google_failed',
        failureFlash: true
    }),
    (req, res) => {
        // Sucesso na autenticação
        console.log('✅ Autenticação Google bem-sucedida!');
        
        // Salvar usuário na sessão personalizada
        req.session.user = req.user;
        
        // Redirecionar para página de destino ou perfil
        const returnTo = req.session.returnTo || '/perfil';
        delete req.session.returnTo;
        
        req.flash('success', `Bem-vindo, ${req.user.nome}!`);
        res.redirect(returnTo);
    }
);

// Logout via Google (apenas desconecta da aplicação)
app.get('/auth/logout', (req, res) => {
    console.log('🚪 Logout via Google');
    
    // Destroi a sessão do Passport
    req.logout((err) => {
        if (err) {
            console.error('❌ Erro no logout:', err);
        }
        
        // Destroi a sessão personalizada
        req.session.destroy((err) => {
            if (err) {
                console.error('❌ Erro ao destruir sessão:', err);
            }
            res.redirect('/login?success=logout');
        });
    });
});

// ==================== ROTA DE STATUS DO GOOGLE ====================

app.get('/auth/status', (req, res) => {
    const isAuthenticated = req.isAuthenticated && req.isAuthenticated();
    res.json({
        authenticated: isAuthenticated,
        user: req.user || null,
        sessionUser: req.session.user || null,
        googleConfigured: !!googleClientID && !!googleClientSecret
    });
});

console.log('✅ Google Passport configurado com sucesso!');

// ==================== MIDDLEWARES DE AUTENTICAÇÃO ====================
const requireAuth = (req, res, next) => {
  if (!req.session.user) {
    req.flash('error', 'Você precisa fazer login para acessar esta página');
    return res.redirect('/login');
  }
  next();
};

const requireVendor = (req, res, next) => {
  if (!req.session.user || req.session.user.tipo !== 'vendedor') {
    req.flash('error', 'Acesso restrito a vendedores');
    return res.redirect('/');
  }
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.session.user || req.session.user.tipo !== 'admin') {
    req.flash('error', 'Acesso restrito a administradores');
    return res.redirect('/');
  }
  next();
};


// ==================== CONFIGURAÇÃO DE DIRETÓRIOS ====================
const uploadDirs = [
  'public/uploads',
  'public/uploads/banners',
  'public/uploads/filmes',
  'public/uploads/produtos',
  'public/uploads/perfil',
  'public/uploads/games'
];

// Garante que todos os diretórios existam
uploadDirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`✅ Criado diretório: ${dir}`);
  } else {
    console.log(`✅ Diretório já existe: ${dir}`);
  }
});

// ==================== CONFIGURAÇÃO DO MULTER (SISTEMA VARCHAR - ARQUIVOS FÍSICOS) ====================

// Storage para banners
const bannerStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = 'public/uploads/banners/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const userId = req.session.user ? req.session.user.id : 'temp';
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname).toLowerCase();
    // Nome no formato: banner-{userId}-{timestamp}-{random}.ext
    const filename = `banner-${userId}-${uniqueSuffix}${ext}`;
    cb(null, filename);
  }
});

// Storage para fotos de perfil
const perfilStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Usa path.join(__dirname) para garantir que o caminho seja exato no Windows/Linux
    const uploadDir = path.join(__dirname, 'public/uploads/perfil/');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const userId = req.session.user ? req.session.user.id : 'temp';
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname).toLowerCase();
    const filename = `perfil-${userId}-${uniqueSuffix}${ext}`;
    cb(null, filename);
  }
});

// Storage geral para outros uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    let uploadPath = 'public/uploads/';
    
    // Determina a pasta baseada no campo ou URL
    if (file.fieldname === 'banner_loja' || (file.fieldname === 'imagem' && req.originalUrl.includes('banners'))) {
      uploadPath = 'public/uploads/banners/';
    } else if (file.fieldname === 'poster' || req.originalUrl.includes('filmes')) {
      uploadPath = 'public/uploads/filmes/';
    } else if (file.fieldname === 'foto_perfil' || req.originalUrl.includes('perfil')) {
      uploadPath = 'public/uploads/perfil/';
    } else if (file.fieldname === 'capa' || req.originalUrl.includes('jogos')) {
      uploadPath = 'public/uploads/games/';
    } else if (file.fieldname.includes('imagem')) {
      uploadPath = 'public/uploads/produtos/';
    }
    
    // Garante que a pasta existe
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
      console.log(`📁 Criada pasta: ${uploadPath}`);
    }
    
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const userId = req.session.user ? req.session.user.id : 'temp';
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname).toLowerCase();
    
    // Prefixo baseado no tipo de arquivo
    let prefix = 'imagem';
    if (file.fieldname === 'foto_perfil') prefix = 'perfil';
    if (file.fieldname === 'banner_loja') prefix = 'banner';
    if (file.fieldname === 'poster') prefix = 'poster';
    if (file.fieldname === 'capa') prefix = 'capa';
    
    // Nome no formato: {prefixo}-{userId}-{timestamp}-{random}.ext
    const filename = `${prefix}-${userId}-${uniqueSuffix}${ext}`;
    cb(null, filename);
  }
});

// Filtro de arquivos comum
const fileFilter = (req, file, cb) => {
  const filetypes = /jpeg|jpg|png|gif|webp/;
  const mimetype = filetypes.test(file.mimetype);
  const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
  
  if (mimetype && extname) {
    return cb(null, true);
  }
  cb(new Error('Apenas imagens são permitidas (JPEG, JPG, PNG, GIF, WebP)!'));
};

// Configurações de upload específicas
const upload = multer({ 
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

const uploadPerfil = multer({ 
  storage: perfilStorage,
  fileFilter: fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

const uploadBanner = multer({ 
  storage: bannerStorage,
  fileFilter: fileFilter,
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB para banners
});

// ==================== MIDDLEWARE DE UPLOAD ESPECÍFICO PARA PERFIL ====================
const uploadPerfilMiddleware = upload.fields([
  { name: 'foto_perfil', maxCount: 1 },
  { name: 'banner_loja', maxCount: 1 }
]);

// ==================== FUNÇÕES AUXILIARES PARA GERENCIAMENTO DE ARQUIVOS ====================

/**
 * Remove arquivo de forma segura
 * @param {string} filePath - Caminho completo do arquivo
 * @param {string} tipo - Tipo de arquivo (banner, perfil, etc)
 */
const removerArquivoSeguro = (filePath, tipo = 'arquivo') => {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`✅ ${tipo} removido: ${path.basename(filePath)}`);
      return true;
    } else {
      console.log(`ℹ️  ${tipo} não encontrado para remover: ${filePath}`);
      return false;
    }
  } catch (error) {
    console.error(`❌ Erro ao remover ${tipo}:`, error.message);
    return false;
  }
};

/**
 * Remove arquivo antigo quando há substituição
 * @param {string} nomeArquivo - Nome do arquivo antigo
 * @param {string} tipo - 'banner' ou 'perfil'
 * @param {string} userId - ID do usuário (opcional)
 */
const removerArquivoAntigo = (nomeArquivo, tipo = 'arquivo', userId = null) => {
  if (!nomeArquivo || typeof nomeArquivo !== 'string' || nomeArquivo.trim() === '') {
    console.log(`ℹ️  Nenhum ${tipo} antigo para remover`);
    return;
  }
  
  // Para banners, verifica em ambas as pastas (banners e perfil)
  const paths = [];
  
  if (tipo === 'banner') {
    paths.push(path.join(__dirname, 'public/uploads/banners/', nomeArquivo));
    paths.push(path.join(__dirname, 'public/uploads/perfil/', nomeArquivo)); // fallback
  } else if (tipo === 'perfil') {
    paths.push(path.join(__dirname, 'public/uploads/perfil/', nomeArquivo));
  } else {
    paths.push(path.join(__dirname, 'public/uploads/', tipo, '/', nomeArquivo));
  }
  
  // Remove o arquivo em todos os caminhos possíveis
  paths.forEach(p => removerArquivoSeguro(p, tipo));
  
  // Se tiver userId, remove arquivos antigos do mesmo usuário
  if (userId && tipo === 'perfil') {
    limparArquivosAntigosUsuario(userId, nomeArquivo, tipo);
  }
};

/**
 * Limpa arquivos antigos do usuário (mantém apenas o atual)
 * @param {string} userId - ID do usuário
 * @param {string} arquivoAtual - Nome do arquivo atual (não remover)
 * @param {string} tipo - 'perfil' ou 'banner'
 */
const limparArquivosAntigosUsuario = (userId, arquivoAtual, tipo = 'perfil') => {
  try {
    const pasta = tipo === 'perfil' ? 'perfil' : 'banners';
    const dirPath = path.join(__dirname, `public/uploads/${pasta}/`);
    
    if (!fs.existsSync(dirPath)) return;
    
    const files = fs.readdirSync(dirPath);
    const prefix = tipo === 'perfil' ? 'perfil-' : 'banner-';
    
    files.forEach(file => {
      // Verifica se o arquivo pertence ao usuário e não é o atual
      if (file.startsWith(`${prefix}${userId}-`) && file !== arquivoAtual) {
        const filePath = path.join(dirPath, file);
        removerArquivoSeguro(filePath, `${tipo} antigo`);
      }
    });
    
  } catch (error) {
    console.error(`❌ Erro ao limpar ${tipo}s antigos:`, error);
  }
};

/**
 * Verifica se um arquivo existe
 * @param {string} nomeArquivo - Nome do arquivo
 * @param {string} tipo - 'banner' ou 'perfil'
 * @returns {boolean} - True se o arquivo existe
 */
const arquivoExiste = (nomeArquivo, tipo = 'perfil') => {
  if (!nomeArquivo || typeof nomeArquivo !== 'string') return false;
  
  let caminhos = [];
  
  if (tipo === 'banner') {
    caminhos = [
      path.join(__dirname, 'public/uploads/banners/', nomeArquivo),
      path.join(__dirname, 'public/uploads/perfil/', nomeArquivo) // fallback
    ];
  } else {
    caminhos = [path.join(__dirname, 'public/uploads/perfil/', nomeArquivo)];
  }
  
  return caminhos.some(caminho => fs.existsSync(caminho));
};

// ==================== SISTEMA HÍBRIDO DE UPLOAD (VARCHAR + BYTEA) ====================

/**
 * FUNÇÃO HÍBRIDA: Processa upload salvando em disco E fazendo backup BYTEA
 * @param {Object} file - Objeto do arquivo do Multer
 * @param {string} tabelaOrigem - 'usuarios', 'produtos', etc
 * @param {number} registroId - ID do registro
 * @param {string} campoDestino - Campo no banco (ex: 'foto_perfil', 'banner_loja')
 * @returns {Promise<string>} - Nome do arquivo salvo
 */
const processarUploadHibrido = async (file, tabelaOrigem, registroId, campoDestino) => {
  try {
    console.log(`🔄 Processando upload híbrido para: ${file.filename}`);
    
    // 1. Verificar se arquivo foi salvo no disco (sistema VARCHAR atual)
    if (!fs.existsSync(file.path)) {
      throw new Error(`Arquivo não salvo no disco: ${file.path}`);
    }
    
    console.log(`✅ Arquivo salvo no disco: ${file.path} (${fs.statSync(file.path).size} bytes)`);
    
    // 2. Salvar backup BYTEA em paralelo (NÃO bloqueia o fluxo principal)
    salvarBackupImagemAsync(file.path, file.filename, tabelaOrigem, registroId);
    
    return file.filename;
    
  } catch (error) {
    console.error(`❌ Erro no processamento híbrido:`, error);
    throw error;
  }
};

/**
 * Salva backup BYTEA de forma assíncrona (não bloqueante)
 */
const salvarBackupImagemAsync = async (filePath, fileName, tabelaOrigem, registroId) => {
  try {
    if (typeof salvarBackupImagem === 'function') {
      // Faz o backup em segundo plano
      setTimeout(async () => {
        try {
          console.log(`💾 Iniciando backup BYTEA para: ${fileName}`);
          const sucesso = await salvarBackupImagem(filePath, fileName, tabelaOrigem, registroId);
          if (sucesso) {
            console.log(`✅ Backup BYTEA concluído: ${fileName}`);
          }
        } catch (backupError) {
          console.error(`⚠️  Backup BYTEA falhou (não crítico):`, backupError.message);
          // Não interrompe o fluxo principal se o backup falhar
        }
      }, 100); // Pequeno delay para não bloquear resposta
    }
  } catch (error) {
    console.error(`⚠️  Erro ao agendar backup BYTEA:`, error.message);
  }
};

// ==================== ROTA UNIFICADA HÍBRIDA PARA PERFIL ====================

app.post('/perfil/upload-hibrido', requireAuth, uploadPerfilMiddleware, async (req, res) => {
  try {
    const userId = req.session.user.id;
    let { nome, telefone, remover_foto } = req.body;

    console.log(`🔄 Upload híbrido iniciado para usuário: ${userId}`);
    console.log('📁 Arquivos recebidos:', Object.keys(req.files || {}));

    // 1. Buscar usuário atual
    const usuarioResult = await db.query('SELECT * FROM usuarios WHERE id = $1', [userId]);
    if (usuarioResult.rows.length === 0) {
      req.flash('error', 'Usuário não encontrado.');
      return res.redirect('/perfil');
    }
    
    const usuario = usuarioResult.rows[0];
    let fotoPerfil = usuario.foto_perfil;
    let bannerLoja = usuario.banner_loja;

    // 2. Processar remoção de foto
    if (remover_foto === '1' || remover_foto === 'true') {
      console.log('🗑️  Removendo foto de perfil...');
      if (fotoPerfil) {
        removerArquivoAntigo(fotoPerfil, 'perfil', userId);
      }
      fotoPerfil = null;
    }

    // 3. Processar NOVA FOTO DE PERFIL (com backup BYTEA)
    if (req.files && req.files['foto_perfil'] && req.files['foto_perfil'][0]) {
      const fotoFile = req.files['foto_perfil'][0];
      
      // Remover foto antiga se existir
      if (fotoPerfil && fotoPerfil !== fotoFile.filename) {
        removerArquivoAntigo(fotoPerfil, 'perfil', userId);
      }
      
      // Processar com sistema híbrido
      fotoPerfil = await processarUploadHibrido(fotoFile, 'usuarios', userId, 'foto_perfil');
      
      // Limpar arquivos antigos do usuário
      limparArquivosAntigosUsuario(userId, fotoPerfil, 'perfil');
    }

    // 4. Processar NOVO BANNER (com backup BYTEA)
    if (req.files && req.files['banner_loja'] && req.files['banner_loja'][0]) {
      const bannerFile = req.files['banner_loja'][0];
      
      // Remover banner antigo se existir
      if (bannerLoja && bannerLoja !== bannerFile.filename) {
        removerArquivoAntigo(bannerLoja, 'banner');
      }
      
      // Processar com sistema híbrido
      bannerLoja = await processarUploadHibrido(bannerFile, 'usuarios', userId, 'banner_loja');
      
      // Limpar arquivos antigos se for banner do usuário
      if (bannerFile.filename.startsWith(`banner-${userId}-`)) {
        limparArquivosAntigosUsuario(userId, bannerLoja, 'banner');
      }
    }

    // 5. Atualizar dados no banco (SISTEMA VARCHAR ATUAL - NÃO MUDAR)
    let query = 'UPDATE usuarios SET nome = COALESCE($1, nome), telefone = $2';
    const params = [nome || usuario.nome, telefone || usuario.telefone];
    
    // Adicionar foto se fornecida
    if (fotoPerfil !== undefined) {
      query += ', foto_perfil = $' + (params.length + 1);
      params.push(fotoPerfil);
    }
    
    // Adicionar banner se fornecido
    if (bannerLoja !== undefined) {
      query += ', banner_loja = $' + (params.length + 1);
      params.push(bannerLoja);
    }
    
    query += ', updated_at = CURRENT_TIMESTAMP WHERE id = $' + (params.length + 1);
    params.push(userId);
    
    console.log(`💾 Atualizando banco VARCHAR...`);
    await db.query(query, params);
    console.log(`✅ Banco VARCHAR atualizado!`);

    // 6. Atualizar sessão
    if (fotoPerfil !== undefined) req.session.user.foto_perfil = fotoPerfil;
    if (bannerLoja !== undefined) req.session.user.banner_loja = bannerLoja;
    if (nome) req.session.user.nome = nome;
    if (telefone !== undefined) req.session.user.telefone = telefone;

    req.session.save((err) => {
      if (err) {
        console.error('❌ Erro ao salvar sessão:', err);
        req.flash('error', 'Erro ao salvar sessão');
        return res.redirect('/perfil');
      }
      
      req.flash('success', 'Perfil atualizado com sucesso! (Sistema híbrido)');
      res.redirect('/perfil');
    });

  } catch (error) {
    console.error('❌ ERRO no upload híbrido:', error);
    
    // Limpeza de arquivos temporários em caso de erro
    if (req.files) {
      Object.values(req.files).forEach(fileArray => {
        fileArray.forEach(file => {
          if (file && file.path && fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
            console.log('🧹 Arquivo removido após erro:', file.path);
          }
        });
      });
    }
    
    req.flash('error', 'Erro ao atualizar perfil: ' + error.message);
    res.redirect('/perfil');
  }
});

// ==================== ROTA SIMPLES APENAS PARA FOTO ====================

app.post('/perfil/foto-rapida', requireAuth, uploadPerfil.single('foto_perfil'), async (req, res) => {
  try {
    if (!req.file) {
      return res.json({ success: false, message: 'Nenhuma imagem selecionada' });
    }

    const userId = req.session.user.id;
    console.log(`📸 Upload rápido para usuário ${userId}: ${req.file.filename}`);

    // 1. Buscar foto atual
    const usuario = await db.query('SELECT foto_perfil FROM usuarios WHERE id = $1', [userId]);
    if (usuario.rows.length === 0) {
      fs.unlinkSync(req.file.path);
      return res.json({ success: false, message: 'Usuário não encontrado' });
    }

    const fotoAtual = usuario.rows[0].foto_perfil;
    
    // 2. Remover foto antiga se existir
    if (fotoAtual && fotoAtual !== req.file.filename) {
      removerArquivoAntigo(fotoAtual, 'perfil', userId);
    }

    // 3. Processar com sistema híbrido
    const novaFoto = await processarUploadHibrido(req.file, 'usuarios', userId, 'foto_perfil');
    
    // 4. Atualizar banco VARCHAR
    await db.query(
      'UPDATE usuarios SET foto_perfil = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [novaFoto, userId]
    );

    // 5. Atualizar sessão
    req.session.user.foto_perfil = novaFoto;
    req.session.save();

    // 6. Limpar arquivos antigos do mesmo usuário
    limparArquivosAntigosUsuario(userId, novaFoto, 'perfil');

    res.json({ 
      success: true, 
      message: 'Foto atualizada com sucesso!',
      foto_perfil: novaFoto,
      url: `/uploads/perfil/${novaFoto}`
    });

  } catch (error) {
    console.error('❌ Erro no upload rápido:', error);
    
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.json({ 
      success: false, 
      message: 'Erro: ' + error.message 
    });
  }
});

// ==================== ROTA PARA VERIFICAR ESTADO HÍBRIDO ====================

app.get('/status-hibrido', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    
    // Buscar dados do usuário
    const usuario = await db.query('SELECT * FROM usuarios WHERE id = $1', [userId]);
    
    // Verificar arquivos no disco
    const arquivosDisco = {
      perfil: [],
      banners: []
    };
    
    // Verificar pasta perfil
    const perfilDir = 'public/uploads/perfil/';
    if (fs.existsSync(perfilDir)) {
      arquivosDisco.perfil = fs.readdirSync(perfilDir)
        .filter(file => file.startsWith(`perfil-${userId}-`))
        .map(file => ({
          nome: file,
          caminho: path.join(perfilDir, file),
          existe: fs.existsSync(path.join(perfilDir, file)),
          tamanho: fs.existsSync(path.join(perfilDir, file)) ? 
            fs.statSync(path.join(perfilDir, file)).size : 0
        }));
    }
    
    // Verificar pasta banners
    const bannersDir = 'public/uploads/banners/';
    if (fs.existsSync(bannersDir)) {
      arquivosDisco.banners = fs.readdirSync(bannersDir)
        .filter(file => file.startsWith(`banner-${userId}-`))
        .map(file => ({
          nome: file,
          caminho: path.join(bannersDir, file),
          existe: fs.existsSync(path.join(bannersDir, file)),
          tamanho: fs.existsSync(path.join(bannersDir, file)) ? 
            fs.statSync(path.join(bannersDir, file)).size : 0
        }));
    }
    
    // Verificar backups BYTEA (se a tabela existir)
    let backups = [];
    try {
      const backupsResult = await db.query(
        'SELECT nome_arquivo, tabela_origem, created_at FROM imagens_backup WHERE tabela_origem = $1 AND registro_id = $2 ORDER BY created_at DESC',
        ['usuarios', userId]
      );
      backups = backupsResult.rows;
    } catch (e) {
      console.log('ℹ️  Tabela de backups não disponível:', e.message);
    }
    
    res.json({
      success: true,
      usuario: {
        id: usuario.rows[0].id,
        nome: usuario.rows[0].nome,
        foto_perfil: usuario.rows[0].foto_perfil,
        banner_loja: usuario.rows[0].banner_loja,
        foto_existe_no_disco: arquivoExiste(usuario.rows[0].foto_perfil, 'perfil'),
        banner_existe_no_disco: arquivoExiste(usuario.rows[0].banner_loja, 'banner')
      },
      arquivos_no_disco: arquivosDisco,
      backups_bytea: backups,
      sistema: 'híbrido (VARCHAR + BYTEA)'
    });
    
  } catch (error) {
    console.error('❌ Erro no status híbrido:', error);
    res.json({ success: false, message: error.message });
  }
});

// ==================== MIDDLEWARE DE FALLBACK MELHORADO ====================

/**
 * Middleware para servir imagens do disco OU do backup BYTEA
 * (Colocar ANTES do express.static)
 */
app.use('/uploads/:pasta?/:arquivo?', async (req, res, next) => {
  try {
    const { pasta, arquivo } = req.params;
    
    if (!arquivo) {
      return next(); // Passa para o próximo middleware
    }
    
    // Determinar caminho do disco
    let diskPath;
    if (pasta === 'perfil' || arquivo.includes('perfil-')) {
      diskPath = path.join('public/uploads/perfil/', arquivo);
    } else if (pasta === 'banners' || arquivo.includes('banner-')) {
      diskPath = path.join('public/uploads/banners/', arquivo);
    } else if (pasta === 'produtos' || arquivo.includes('imagem-')) {
      diskPath = path.join('public/uploads/produtos/', arquivo);
    } else {
      // Tenta servir do disco normalmente
      return next();
    }
    
    // 1. Tentar servir do disco primeiro (performance máxima)
    if (fs.existsSync(diskPath)) {
      console.log(`✅ Servindo do disco: ${arquivo}`);
      return res.sendFile(path.resolve(diskPath), {
        headers: {
          'Content-Type': getMimeType(diskPath),
          'Cache-Control': 'public, max-age=86400'
        }
      });
    }
    
    // 2. Se não encontrar no disco, buscar no backup BYTEA
    console.log(`🔄 Arquivo não encontrado no disco: ${arquivo}. Buscando backup BYTEA...`);
    
    const imagemData = await recuperarImagemBackup(arquivo);
    if (imagemData) {
      console.log(`✅ Servindo do backup BYTEA: ${arquivo}`);
      
      // Opcional: Recriar no disco para futuras requisições
      setTimeout(async () => {
        try {
          await recriarArquivoDoBackup(arquivo, diskPath);
        } catch (e) {
          console.log(`⚠️  Não foi possível recriar arquivo: ${e.message}`);
        }
      }, 0);
      
      res.set({
        'Content-Type': imagemData.mimeType,
        'Content-Length': imagemData.buffer.length,
        'Cache-Control': 'public, max-age=86400',
        'X-Image-Source': 'database-backup'
      });
      
      return res.send(imagemData.buffer);
    }
    
    // 3. Se não encontrar em lugar nenhum, passar para o próximo middleware
    console.log(`❌ Imagem não encontrada: ${arquivo}`);
    next();
    
  } catch (error) {
    console.error('❌ Erro no middleware de fallback:', error);
    next(error);
  }
});

// IMPORTANTE: express.static deve vir DEPOIS deste middleware
app.use(express.static('public'));

// ==================== FUNÇÃO AUXILIAR PARA SALVAR BACKUP (OPCIONAL) ====================

/**
 * Processa uploads salvando automaticamente no backup BYTEA (opcional)
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @param {string} tabelaOrigem - Tabela de origem
 * @param {number} registroId - ID do registro
 */
const processarUploadComBackup = async (req, res, tabelaOrigem, registroId) => {
    try {
        // Processar arquivos enviados
        const files = req.files || {};
        
        // Se for upload de arquivo único
        if (req.file) {
            const filePath = req.file.path;
            const fileName = req.file.filename;
            
            console.log(`📁 Processando backup para: ${fileName}`);
            
            // Salvar no backup BYTEA (se a função existir)
            if (typeof salvarBackupImagem === 'function') {
              await salvarBackupImagem(filePath, fileName, tabelaOrigem, registroId);
            }
        }
        
        // Se for múltiplos arquivos
        if (Object.keys(files).length > 0) {
            for (const fieldname in files) {
                const fileArray = files[fieldname];
                if (fileArray && fileArray.length > 0) {
                    for (const file of fileArray) {
                        console.log(`📁 Processando backup para: ${file.filename}`);
                        if (typeof salvarBackupImagem === 'function') {
                          await salvarBackupImagem(file.path, file.filename, tabelaOrigem, registroId);
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error('❌ Erro no processamento de backup:', error);
        // Não interrompe o fluxo principal se o backup falhar
    }
};

// ==================== MIDDLEWARES ====================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// IMPORTANTE: express.static deve vir ANTES da nossa rota de fallback
app.use(express.static('public'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));

app.use(session({
  store: new pgSession({
    conString: process.env.DATABASE_URL,
    tableName: 'user_sessions',
    createTableIfMissing: true,
    ttl: 24 * 60 * 60 // 24 horas
  }),
  secret: process.env.SESSION_SECRET || 'kuandashop-secret-key-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax'
  }
}));

// ==================== CONFIGURAÇÃO DE MIDDLEWARES (ORDEM CORRIGIDA) ====================

app.use(flash());

app.use(expressLayouts);
app.set('layout', 'layout');

// 1. MIDDLEWARE GLOBAL DE VARIÁVEIS (Deve vir ANTES das rotas)
// Define usuário, mensagens e script de alerta para TODAS as views
app.use((req, res, next) => {
  // A. Disponibilizar Usuário
  res.locals.user = req.session.user || null;
  
  // B. Capturar Mensagens Flash (Uma única vez para evitar conflitos)
  const messages = req.flash();
  res.locals.messages = messages; 
  res.locals.currentUrl = req.originalUrl;

  // C. Gerar Script do SweetAlert2 Automaticamente (O Fallback Visual)
  let scriptNotificacao = '';
  
  // Configuração visual do Toast
  const toastConfig = `toast: true, position: 'top-end', showConfirmButton: false, timer: 4000, timerProgressBar: true, didOpen: (toast) => { toast.addEventListener('mouseenter', Swal.stopTimer); toast.addEventListener('mouseleave', Swal.resumeTimer); }`;

  // Monta o Javascript baseado na mensagem recebida
  if (messages.success && messages.success.length > 0) {
      scriptNotificacao = `Swal.fire({ icon: 'success', title: '${messages.success[0].replace(/'/g, "\\'")}', ${toastConfig} });`;
  } 
  else if (messages.error && messages.error.length > 0) {
      scriptNotificacao = `Swal.fire({ icon: 'error', title: '${messages.error[0].replace(/'/g, "\\'")}', ${toastConfig} });`;
  }
  else if (messages.info && messages.info.length > 0) {
      scriptNotificacao = `Swal.fire({ icon: 'info', title: '${messages.info[0].replace(/'/g, "\\'")}', ${toastConfig} });`;
  }
  else if (messages.warning && messages.warning.length > 0) {
      scriptNotificacao = `Swal.fire({ icon: 'warning', title: '${messages.warning[0].replace(/'/g, "\\'")}', ${toastConfig} });`;
  }

  // Injeta o script na variável local para o layout.ejs ler
  res.locals.notificacaoScript = scriptNotificacao;

  next();
});

// 2. MIDDLEWARE DO CARRINHO (Antes das rotas)
app.use((req, res, next) => {
  if (!req.session.carrinho) {
    req.session.carrinho = [];
  }
  res.locals.carrinho = req.session.carrinho || [];
  next();
});

// 3. SISTEMA DE CHAT (Antes das rotas)
require('./routes/sistema_chat')(app, db);

// 4. IMPORTAÇÃO DAS ROTAS (AGORA SIM, NO FINAL)
// Como os middlewares acima já rodaram, a página vai ter acesso ao 'user' e 'script'
app.use('/', vendasRoutes);

// ==================== FIM DA CORREÇÃO ====================


// ==================== FUNÇÕES AUXILIARES ====================
const removeProfilePicture = (filename) => {
  if (!filename) return;
  try {
    const filePath = path.join('public/uploads/perfil/', filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('Erro ao remover foto de perfil:', error);
  }
};

const removeOldProfilePicture = async (userId, currentFilename) => {
  try {
    if (!currentFilename) return;
    
    const perfilDir = 'public/uploads/perfil/';
    if (!fs.existsSync(perfilDir)) return;
    
    const files = fs.readdirSync(perfilDir);
    const userFiles = files.filter(file => 
      file.startsWith(`perfil-${userId}-`) && 
      file !== currentFilename
    );
    
    userFiles.forEach(file => {
      const filePath = path.join(perfilDir, file);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });
  } catch (error) {
    console.error('Erro ao remover fotos antigas:', error);
  }
};

const validateProductData = (data) => {
  const errors = [];
  
  if (!data.nome || data.nome.trim().length < 3) {
    errors.push('Nome do produto deve ter pelo menos 3 caracteres');
  }
  
  if (!data.descricao || data.descricao.trim().length < 10) {
    errors.push('Descrição deve ter pelo menos 10 caracteres');
  }
  
  if (!data.preco || isNaN(data.preco) || parseFloat(data.preco) <= 0) {
    errors.push('Preço deve ser um número positivo');
  }
  
  if (!data.categoria_id || isNaN(data.categoria_id)) {
    errors.push('Categoria é obrigatória');
  }
  
  if (!data.estoque || isNaN(data.estoque) || parseInt(data.estoque) < 0) {
    errors.push('Estoque deve ser um número não negativo');
  }
  
  return errors;
};


// ==================== ROTA MAGIC FALLBACK (DEVE VIR DEPOIS DO express.static) ====================

/**
 * ROTA DE FALLBACK INTELIGENTE PARA UPLOADS
 * Esta rota intercepta requisições para /uploads/* e implementa a lógica híbrida:
 * 1. Tenta servir do disco (performance máxima)
 * 2. Se não encontrar no disco, busca no banco BYTEA
 * 3. Se achar no banco, serve e opcionalmente recria no disco
 */
app.get('/uploads/:pasta?/:arquivo?', async (req, res) => {
    try {
        let filePath;
        const { pasta, arquivo } = req.params;
        
        // Construir caminho baseado nos parâmetros
        if (pasta && arquivo) {
            filePath = path.join('public/uploads', pasta, arquivo);
        } else if (!pasta && arquivo) {
            // Se chamar diretamente /uploads/arquivo (sem pasta)
            filePath = path.join('public/uploads', arquivo);
            
            // Verificar se é um dos padrões conhecidos
            if (arquivo.includes('banner')) {
                filePath = path.join('public/uploads/banners', arquivo);
            } else if (arquivo.includes('perfil')) {
                filePath = path.join('public/uploads/perfil', arquivo);
            } else if (arquivo.includes('filme') || arquivo.includes('poster')) {
                filePath = path.join('public/uploads/filmes', arquivo);
            } else if (arquivo.includes('game') || arquivo.includes('capa') || arquivo.includes('screenshot')) {
                filePath = path.join('public/uploads/games', arquivo);
            } else {
                filePath = path.join('public/uploads/produtos', arquivo);
            }
        } else {
            // URL mal formada
            return res.status(400).send('URL de imagem inválida');
        }
        
        // 1º: Verifica se o arquivo físico existe no disco
        if (fs.existsSync(filePath)) {
            // Servir diretamente do disco (performance nativa)
            return res.sendFile(path.resolve(filePath), {
                headers: {
                    'Content-Type': getMimeType(filePath),
                    'Cache-Control': 'public, max-age=86400' // Cache de 1 dia
                }
            });
        }
        
        console.log(`🔄 Arquivo não encontrado no disco: ${filePath}. Buscando no backup BYTEA...`);
        
        // 2º: Buscar no banco de dados BYTEA
        const fileName = arquivo;
        const imagemData = await recuperarImagemBackup(fileName);
        
        if (imagemData) {
            // 3º: Encontrou no banco! Enviar dados binários
            console.log(`✅ Imagem encontrada no backup: ${fileName}`);
            
            // Opcional: Recriar arquivo no disco para futuras requisições
            if (process.env.RECRIAR_ARQUIVOS === 'true') {
                setTimeout(async () => {
                    await recriarArquivoDoBackup(fileName, filePath);
                }, 0); // Faz de forma assíncrona para não bloquear a resposta
            }
            
            // Enviar imagem com headers apropriados
            res.set({
                'Content-Type': imagemData.mimeType,
                'Content-Length': imagemData.buffer.length,
                'Cache-Control': 'public, max-age=86400',
                'X-Image-Source': 'database-backup'
            });
            
            return res.send(imagemData.buffer);
        }
        
        // 4º: Não encontrou em lugar nenhum
        console.log(`❌ Imagem não encontrada: ${fileName}`);
        res.status(404).send('Imagem não encontrada');
        
    } catch (error) {
        console.error('❌ Erro na rota de fallback de imagens:', error);
        res.status(500).send('Erro interno do servidor');
    }
});

// ==================== ROTA UNIFICADA PARA UPLOAD DE PERFIL E BANNER (CORRIGIDA) ====================

// ==================== CORREÇÃO 2: ROTA DE PERFIL BLINDADA ====================

app.post('/perfil/atualizar', requireAuth, uploadPerfilMiddleware, async (req, res) => {
  try {
    const userId = req.session.user.id;
    let { nome, telefone, nome_loja, descricao_loja, remover_foto } = req.body;

    console.log('🔄 Processando atualização de perfil:', userId);

    // 1. Buscar dados atuais do usuário
    const usuarioResult = await db.query('SELECT * FROM usuarios WHERE id = $1', [userId]);
    const usuario = usuarioResult.rows[0];
    
    // Variáveis para atualização
    let fotoPerfil = usuario.foto_perfil;
    let bannerLoja = usuario.banner_loja;

    // 2. Lógica de Remoção de Foto (Se o usuário clicou em remover)
    if (remover_foto === 'true' || remover_foto === '1') {
        // Tenta remover o arquivo antigo se existir
        if (fotoPerfil) {
            const pathAntigo = path.join(__dirname, 'public/uploads/perfil/', fotoPerfil);
            if (fs.existsSync(pathAntigo)) {
                try { fs.unlinkSync(pathAntigo); } catch(e) { console.error('Erro ao deletar foto antiga:', e.message); }
            }
        }
        fotoPerfil = null; // Define como null para o banco
    }

    // 3. Processar Nova Foto (Se veio upload)
    if (req.files && req.files['foto_perfil']) {
        const file = req.files['foto_perfil'][0];
        console.log('📸 Nova foto recebida:', file.filename);
        
        // Remove a antiga para não acumular lixo
        if (usuario.foto_perfil && usuario.foto_perfil !== file.filename) {
             const pathAntigo = path.join(__dirname, 'public/uploads/perfil/', usuario.foto_perfil);
             if (fs.existsSync(pathAntigo)) {
                 try { fs.unlinkSync(pathAntigo); } catch(e) {}
             }
        }
        
        fotoPerfil = file.filename;
        
        // Backup Híbrido (Se a função existir no seu código)
        if (typeof salvarBackupImagem === 'function') {
            await salvarBackupImagem(file.path, file.filename, 'usuarios', userId);
        }
    }

    // 4. Processar Novo Banner (Se veio upload)
    if (req.files && req.files['banner_loja']) {
        const file = req.files['banner_loja'][0];
        console.log('🎨 Novo banner recebido:', file.filename);

        if (usuario.banner_loja && usuario.banner_loja !== file.filename) {
             const pathAntigo = path.join(__dirname, 'public/uploads/banners/', usuario.banner_loja);
             if (fs.existsSync(pathAntigo)) {
                 try { fs.unlinkSync(pathAntigo); } catch(e) {}
             }
        }

        bannerLoja = file.filename;

        // Backup Híbrido
        if (typeof salvarBackupImagem === 'function') {
            await salvarBackupImagem(file.path, file.filename, 'usuarios', userId);
        }
    }

    // 5. Atualizar Banco de Dados
    // Usamos COALESCE para manter o valor antigo se o campo vier vazio no form, 
    // mas permitimos NULL explicitamente para as fotos se foi feita remoção.
    let query = `
        UPDATE usuarios 
        SET nome = $1, 
            telefone = $2, 
            foto_perfil = $3, 
            banner_loja = $4 
    `;
    
    const params = [
        nome || usuario.nome, 
        telefone || usuario.telefone, 
        fotoPerfil, 
        bannerLoja
    ];
    
    let paramIndex = 5;

    // Campos extras para vendedor
    if (usuario.tipo === 'vendedor') {
        query += `, nome_loja = $${paramIndex++}, descricao_loja = $${paramIndex++}`;
        params.push(nome_loja || usuario.nome_loja, descricao_loja || usuario.descricao_loja);
    }

    query += `, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIndex}`;
    params.push(userId);

    await db.query(query, params);

    // 6. Atualizar Sessão (Para refletir na hora sem relogar)
    req.session.user.nome = nome || usuario.nome;
    req.session.user.telefone = telefone || usuario.telefone;
    req.session.user.foto_perfil = fotoPerfil;
    req.session.user.banner_loja = bannerLoja;
    
    if (usuario.tipo === 'vendedor') {
        req.session.user.nome_loja = nome_loja || usuario.nome_loja;
        req.session.user.descricao_loja = descricao_loja || usuario.descricao_loja;
    }

    req.session.save((err) => {
        if (err) console.error('Erro ao salvar sessão:', err);
        req.flash('success', 'Perfil atualizado com sucesso!');
        res.redirect('/perfil');
    });

  } catch (error) {
    console.error('❌ Erro crítico ao atualizar perfil:', error);
    req.flash('error', 'Erro ao salvar alterações: ' + error.message);
    res.redirect('/perfil');
  }
});

// ==================== ROTA DEBUG PARA VERIFICAR ESTADO DO PERFIL ====================

app.get('/debug/perfil/:id?', requireAuth, async (req, res) => {
  try {
    const userId = req.params.id || req.session.user.id;
    
    // Buscar dados do usuário
    const usuarioResult = await db.query('SELECT * FROM usuarios WHERE id = $1', [userId]);
    
    if (usuarioResult.rows.length === 0) {
      return res.json({ error: 'Usuário não encontrado' });
    }
    
    const usuario = usuarioResult.rows[0];
    
    // Verificar arquivos no disco
    const diretorios = {
      perfil: 'public/uploads/perfil/',
      banners: 'public/uploads/banners/'
    };
    
    const arquivos = {};
    
    for (const [tipo, caminho] of Object.entries(diretorios)) {
      if (fs.existsSync(caminho)) {
        arquivos[tipo] = fs.readdirSync(caminho)
          .filter(file => file.includes(userId.toString()))
          .map(file => {
            const filePath = path.join(caminho, file);
            return {
              nome: file,
              caminho: filePath,
              existe: fs.existsSync(filePath),
              tamanho: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
              criado: fs.existsSync(filePath) ? fs.statSync(filePath).ctime : null
            };
          });
      } else {
        arquivos[tipo] = [];
      }
    }
    
    // Verificar se os arquivos do banco existem no disco
    const arquivosBanco = {
      foto_perfil: usuario.foto_perfil,
      banner_loja: usuario.banner_loja
    };
    
    const arquivosExistem = {};
    
    for (const [campo, nomeArquivo] of Object.entries(arquivosBanco)) {
      if (nomeArquivo) {
        let caminho;
        if (campo === 'foto_perfil') {
          caminho = path.join('public/uploads/perfil/', nomeArquivo);
        } else {
          caminho = path.join('public/uploads/banners/', nomeArquivo);
        }
        arquivosExistem[campo] = {
          nome: nomeArquivo,
          caminho: caminho,
          existe: fs.existsSync(caminho)
        };
      }
    }
    
    res.json({
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        foto_perfil: usuario.foto_perfil,
        banner_loja: usuario.banner_loja,
        updated_at: usuario.updated_at
      },
      sessao: req.session.user,
      arquivos_no_disco: arquivos,
      arquivos_do_banco: arquivosExistem,
      status: 'OK'
    });
    
  } catch (error) {
    console.error('❌ Erro no debug:', error);
    res.json({ error: error.message });
  }
});

// ==================== ROTA PARA FORÇAR ATUALIZAÇÃO DA FOTO ====================

app.post('/debug/forcar-foto', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { nome_arquivo } = req.body;
    
    if (!nome_arquivo) {
      return res.json({ success: false, message: 'Nome do arquivo é obrigatório' });
    }
    
    // Verificar se o arquivo existe no disco
    const filePath = path.join('public/uploads/perfil/', nome_arquivo);
    
    if (!fs.existsSync(filePath)) {
      return res.json({ success: false, message: 'Arquivo não existe no disco' });
    }
    
    // Atualizar banco de dados diretamente
    await db.query(
      'UPDATE usuarios SET foto_perfil = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [nome_arquivo, userId]
    );
    
    // Atualizar sessão
    req.session.user.foto_perfil = nome_arquivo;
    
    req.session.save((err) => {
      if (err) {
        console.error('Erro ao salvar sessão:', err);
        return res.json({ success: false, message: 'Erro ao salvar sessão' });
      }
      
      res.json({ 
        success: true, 
        message: 'Foto forçada com sucesso!',
        foto_perfil: nome_arquivo 
      });
    });
    
  } catch (error) {
    console.error('❌ Erro ao forçar foto:', error);
    res.json({ success: false, message: error.message });
  }
});

// ==================== ROTA PARA VERIFICAR ARQUIVOS ====================

app.get('/debug-arquivos', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const resultados = {
    usuario: req.session.user,
    diretorios: {},
    arquivosUsuario: {}
  };
  
  // Listar arquivos nas pastas
  ['perfil', 'banners'].forEach(pasta => {
    const dirPath = path.join(__dirname, `public/uploads/${pasta}/`);
    if (fs.existsSync(dirPath)) {
      resultados.diretorios[pasta] = {
        caminho: dirPath,
        existe: true,
        arquivos: fs.readdirSync(dirPath).slice(0, 20) // Primeiros 20
      };
      
      // Filtrar arquivos do usuário atual
      const prefix = pasta === 'perfil' ? 'perfil-' : 'banner-';
      resultados.arquivosUsuario[pasta] = fs.readdirSync(dirPath)
        .filter(file => file.startsWith(`${prefix}${userId}-`));
    } else {
      resultados.diretorios[pasta] = {
        caminho: dirPath,
        existe: false,
        arquivos: []
      };
    }
  });
  
  res.json(resultados);
});

// ==================== ROTA SEPARADA APENAS PARA UPLOAD DE FOTO ====================

app.post('/perfil/upload-foto', requireAuth, uploadPerfil.single('foto_perfil'), async (req, res) => {
  try {
    if (!req.file) {
      req.flash('error', 'Nenhuma imagem selecionada');
      return res.redirect('/perfil');
    }

    const userId = req.session.user.id;
    const usuario = await db.query('SELECT foto_perfil FROM usuarios WHERE id = $1', [userId]);
    
    if (usuario.rows.length === 0) {
      if (req.file && req.file.path) {
        fs.unlinkSync(req.file.path);
      }
      req.flash('error', 'Usuário não encontrado');
      return res.redirect('/perfil');
    }

    // Remove foto antiga
    const fotoAntiga = usuario.rows[0].foto_perfil;
    if (fotoAntiga) {
      removerArquivoAntigo(fotoAntiga, 'perfil', userId);
    }

    const novaFoto = req.file.filename;
    
    // Salvar backup BYTEA
    await salvarBackupImagem(req.file.path, novaFoto, 'usuarios', userId);

    // Atualizar banco
    await db.query(
      'UPDATE usuarios SET foto_perfil = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [novaFoto, userId]
    );

    // Atualizar sessão
    req.session.user.foto_perfil = novaFoto;
    
    req.flash('success', 'Foto de perfil atualizada com sucesso!');
    res.redirect('/perfil');
  } catch (error) {
    console.error('❌ Erro ao atualizar foto:', error);
    
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    req.flash('error', 'Erro ao atualizar foto de perfil');
    res.redirect('/perfil');
  }
});

// ==================== ROTA SEPARADA APENAS PARA UPLOAD DE BANNER ====================

app.post('/perfil/upload-banner', requireAuth, uploadBanner.single('banner_loja'), async (req, res) => {
  try {
    if (!req.file) {
      req.flash('error', 'Nenhuma imagem selecionada');
      return res.redirect('/perfil');
    }

    const userId = req.session.user.id;
    const usuario = await db.query('SELECT banner_loja FROM usuarios WHERE id = $1', [userId]);
    
    if (usuario.rows.length === 0) {
      if (req.file && req.file.path) {
        fs.unlinkSync(req.file.path);
      }
      req.flash('error', 'Usuário não encontrado');
      return res.redirect('/perfil');
    }

    // Remove banner antigo
    const bannerAntigo = usuario.rows[0].banner_loja;
    if (bannerAntigo) {
      removerArquivoAntigo(bannerAntigo, 'banner');
    }

    const novoBanner = req.file.filename;
    
    // Salvar backup BYTEA
    await salvarBackupImagem(req.file.path, novoBanner, 'usuarios', userId);

    // Atualizar banco
    await db.query(
      'UPDATE usuarios SET banner_loja = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [novoBanner, userId]
    );

    // Atualizar sessão
    req.session.user.banner_loja = novoBanner;
    
    req.flash('success', 'Banner da loja atualizado com sucesso!');
    res.redirect('/perfil');
  } catch (error) {
    console.error('❌ Erro ao atualizar banner:', error);
    
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    req.flash('error', 'Erro ao atualizar banner da loja');
    res.redirect('/perfil');
  }
});

// ==================== ROTA PARA REMOVER FOTO DE PERFIL ====================

app.post('/perfil/remover-foto', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const usuario = await db.query('SELECT foto_perfil FROM usuarios WHERE id = $1', [userId]);
    
    if (usuario.rows.length === 0) {
      req.flash('error', 'Usuário não encontrado');
      return res.redirect('/perfil');
    }

    const fotoAtual = usuario.rows[0].foto_perfil;
    
    if (fotoAtual) {
      // Remove arquivo físico
      removerArquivoAntigo(fotoAtual, 'perfil', userId);
      
      // Remove do banco
      await db.query(
        'UPDATE usuarios SET foto_perfil = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [userId]
      );
      
      // Remove da sessão
      req.session.user.foto_perfil = null;
    }
    
    req.flash('success', 'Foto de perfil removida com sucesso!');
    res.redirect('/perfil');
  } catch (error) {
    console.error('❌ Erro ao remover foto:', error);
    req.flash('error', 'Erro ao remover foto de perfil');
    res.redirect('/perfil');
  }
});

// ==================== ROTA PARA REMOVER BANNER ====================

app.post('/perfil/remover-banner', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const usuario = await db.query('SELECT banner_loja FROM usuarios WHERE id = $1', [userId]);
    
    if (usuario.rows.length === 0) {
      req.flash('error', 'Usuário não encontrado');
      return res.redirect('/perfil');
    }

    const bannerAtual = usuario.rows[0].banner_loja;
    
    if (bannerAtual) {
      // Remove arquivo físico
      removerArquivoAntigo(bannerAtual, 'banner');
      
      // Remove do banco
      await db.query(
        'UPDATE usuarios SET banner_loja = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [userId]
      );
      
      // Remove da sessão
      req.session.user.banner_loja = null;
    }
    
    req.flash('success', 'Banner da loja removido com sucesso!');
    res.redirect('/perfil');
  } catch (error) {
    console.error('❌ Erro ao remover banner:', error);
    req.flash('error', 'Erro ao remover banner da loja');
    res.redirect('/perfil');
  }
});

app.use(passport.initialize());
app.use(passport.session());

// ==================== ROTAS GOOGLE AUTH ====================

// Iniciar login com Google
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

// Retorno do Google
app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => {
    // Salvar usuário na sessão customizada do seu app
    req.session.user = req.user;
    req.flash('success', `Bem-vindo, ${req.user.nome}!`);
    res.redirect('/');
  }
);

// ==================== ROTA VERIFICAÇÃO DE EMAIL ====================

app.get('/verificar-email/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    // Busca e ativa o usuário
    const result = await db.query(
      `UPDATE usuarios 
       SET email_verificado = true, token_verificacao = NULL 
       WHERE token_verificacao = $1 
       RETURNING *`,
      [token]
    );

    if (result.rows.length > 0) {
      req.flash('success', 'E-mail verificado com sucesso! Pode fazer login.');
      res.redirect('/login');
    } else {
      req.flash('error', 'Link de verificação inválido ou expirado.');
      res.redirect('/login');
    }
  } catch (error) {
    console.error('Erro na verificação:', error);
    req.flash('error', 'Erro ao processar verificação.');
    res.redirect('/login');
  }
});

// ==================== ROTAS PÚBLICAS ====================
app.get('/', async (req, res) => {
  try {
    const [
      banners,
      produtosDestaque,
      produtosVip,
      produtosOferta,
      filmes,
      categorias
    ] = await Promise.all([
      db.query('SELECT * FROM banners WHERE ativo = true ORDER BY ordem'),
      db.query(`
        SELECT p.*, u.nome_loja, u.foto_perfil as loja_foto, 
               COALESCE(AVG(a.classificacao), 0) as media_classificacao,
               COUNT(a.id) as total_avaliacoes
        FROM produtos p 
        JOIN usuarios u ON p.vendedor_id = u.id 
        LEFT JOIN avaliacoes a ON p.id = a.produto_id
        WHERE p.ativo = true AND p.destaque = true AND u.loja_ativa = true
        GROUP BY p.id, u.nome_loja, u.foto_perfil
        ORDER BY p.created_at DESC 
        LIMIT 12
      `),
      db.query(`
        SELECT p.*, u.nome_loja, u.foto_perfil as loja_foto,
               COALESCE(AVG(a.classificacao), 0) as media_classificacao,
               COUNT(a.id) as total_avaliacoes
        FROM produtos p 
        JOIN usuarios u ON p.vendedor_id = u.id 
        LEFT JOIN avaliacoes a ON p.id = a.produto_id
        WHERE p.ativo = true AND p.vip = true AND u.loja_ativa = true
        GROUP BY p.id, u.nome_loja, u.foto_perfil
        ORDER BY p.created_at DESC 
        LIMIT 8
      `),
      db.query(`
        SELECT p.*, u.nome_loja, u.foto_perfil as loja_foto,
               COALESCE(AVG(a.classificacao), 0) as media_classificacao,
               COUNT(a.id) as total_avaliacoes
        FROM produtos p 
        JOIN usuarios u ON p.vendedor_id = u.id 
        LEFT JOIN avaliacoes a ON p.id = a.produto_id
        WHERE p.ativo = true AND p.preco_promocional IS NOT NULL AND u.loja_ativa = true
        GROUP BY p.id, u.nome_loja, u.foto_perfil
        ORDER BY p.created_at DESC 
        LIMIT 10
      `),
      db.query('SELECT * FROM filmes WHERE ativo = true ORDER BY data_lancamento DESC LIMIT 6'),
      db.query('SELECT * FROM categorias ORDER BY nome')
    ]);

    const bannersCorrigidos = banners.rows.map(banner => ({
      ...banner,
      imagem: `/uploads/banners/${banner.imagem}`
    }));

    res.render('index', {
      banners: bannersCorrigidos,
      produtosDestaque: produtosDestaque.rows,
      produtosVip: produtosVip.rows,
      produtosOferta: produtosOferta.rows,
      filmes: filmes.rows,
      categorias: categorias.rows,
      title: 'KuandaShop - Marketplace Multi-Vendor'
    });
  } catch (error) {
    console.error('Erro ao carregar página inicial:', error);
    res.render('index', {
      banners: [],
      produtosDestaque: [],
      produtosVip: [],
      produtosOferta: [],
      filmes: [],
      categorias: [],
      title: 'KuandaShop - Marketplace'
    });
  }
});

app.get('/produtos', async (req, res) => {
  const { categoria, busca, ordenar } = req.query;
  let query = `
    SELECT p.*, u.nome_loja, u.foto_perfil as loja_foto,
           COALESCE(AVG(a.classificacao), 0) as media_classificacao,
           COUNT(a.id) as total_avaliacoes,
           c.nome as categoria_nome
    FROM produtos p 
    JOIN usuarios u ON p.vendedor_id = u.id 
    LEFT JOIN avaliacoes a ON p.id = a.produto_id
    LEFT JOIN categorias c ON p.categoria_id = c.id
    WHERE p.ativo = true AND u.loja_ativa = true
  `;
  
  const params = [];
  let paramCount = 0;

  if (categoria) {
    paramCount++;
    query += ` AND p.categoria_id = $${paramCount}`;
    params.push(categoria);
  }

  if (busca) {
    paramCount++;
    query += ` AND (p.nome ILIKE $${paramCount} OR p.descricao ILIKE $${paramCount} OR u.nome_loja ILIKE $${paramCount})`;
    params.push(`%${busca}%`);
  }

  query += ' GROUP BY p.id, u.nome_loja, u.foto_perfil, c.nome';

  switch (ordenar) {
    case 'preco_asc':
      query += ' ORDER BY p.preco ASC';
      break;
    case 'preco_desc':
      query += ' ORDER BY p.preco DESC';
      break;
    case 'nome':
      query += ' ORDER BY p.nome ASC';
      break;
    case 'avaliacao':
      query += ' ORDER BY media_classificacao DESC';
      break;
    case 'novos':
      query += ' ORDER BY p.created_at DESC';
      break;
    default:
      query += ' ORDER BY p.created_at DESC';
  }

  try {
    const [produtos, categoriasList] = await Promise.all([
      db.query(query, params),
      db.query('SELECT * FROM categorias ORDER BY nome')
    ]);

    res.render('produtos/lista', {
      produtos: produtos.rows,
      categorias: categoriasList.rows,
      filtros: { categoria, busca, ordenar },
      title: 'Produtos - KuandaShop'
    });
  } catch (error) {
    console.error('Erro ao carregar produtos:', error);
    res.render('produtos/lista', {
      produtos: [],
      categorias: [],
      filtros: { categoria, busca, ordenar },
      title: 'Produtos'
    });
  }
});

app.get('/produto/:id', async (req, res) => {
  try {
    const produto = await db.query(`
      SELECT p.*, u.nome_loja, u.foto_perfil as loja_foto, u.telefone as loja_telefone,
             u.descricao_loja, u.created_at as loja_desde,
             COALESCE(AVG(a.classificacao), 0) as media_classificacao,
             COUNT(a.id) as total_avaliacoes,
             c.nome as categoria_nome
      FROM produtos p 
      JOIN usuarios u ON p.vendedor_id = u.id 
      LEFT JOIN avaliacoes a ON p.id = a.produto_id
      LEFT JOIN categorias c ON p.categoria_id = c.id
      WHERE p.id = $1 AND p.ativo = true
      GROUP BY p.id, u.nome_loja, u.foto_perfil, u.telefone, u.descricao_loja, u.created_at, c.nome
    `, [req.params.id]);

    if (produto.rows.length === 0) {
      req.flash('error', 'Produto não encontrado');
      return res.redirect('/produtos');
    }

    const produtoData = produto.rows[0];
    produtoData.media_classificacao = parseFloat(produtoData.media_classificacao) || 0;
    produtoData.total_avaliacoes = parseInt(produtoData.total_avaliacoes) || 0;
    produtoData.preco = parseFloat(produtoData.preco) || 0;
    produtoData.preco_promocional = produtoData.preco_promocional ? parseFloat(produtoData.preco_promocional) : null;
    produtoData.estoque = parseInt(produtoData.estoque) || 0;

    const [produtosSimilares, avaliacoes] = await Promise.all([
      db.query(`
        SELECT p.*, u.nome_loja, u.foto_perfil as loja_foto,
               COALESCE(AVG(a.classificacao), 0) as media_classificacao,
               COUNT(a.id) as total_avaliacoes
        FROM produtos p 
        JOIN usuarios u ON p.vendedor_id = u.id 
        LEFT JOIN avaliacoes a ON p.id = a.produto_id
        WHERE p.categoria_id = $1 AND p.id != $2 AND p.ativo = true AND u.loja_ativa = true
        GROUP BY p.id, u.nome_loja, u.foto_perfil
        ORDER BY RANDOM()
        LIMIT 6
      `, [produtoData.categoria_id, req.params.id]),
      db.query(`
        SELECT a.*, u.nome, u.foto_perfil
        FROM avaliacoes a
        JOIN usuarios u ON a.usuario_id = u.id
        WHERE a.produto_id = $1
        ORDER BY a.created_at DESC
        LIMIT 10
      `, [req.params.id])
    ]);

    res.render('produtos/detalhes', {
      produto: produtoData,
      produtosSimilares: produtosSimilares.rows,
      avaliacoes: avaliacoes.rows,
      title: `${produtoData.nome} - KuandaShop`
    });
  } catch (error) {
    console.error('Erro ao carregar produto:', error);
    req.flash('error', 'Erro ao carregar produto');
    res.redirect('/produtos');
  }
});

app.post('/produto/:id/avaliar', requireAuth, async (req, res) => {
  const { classificacao, comentario } = req.body;
  
  try {
    const classificacaoNum = parseInt(classificacao);
    if (classificacaoNum < 1 || classificacaoNum > 5) {
      req.flash('error', 'Classificação deve ser entre 1 e 5');
      return res.redirect(`/produto/${req.params.id}`);
    }
    
    const avaliacaoExistente = await db.query(
      'SELECT id FROM avaliacoes WHERE produto_id = $1 AND usuario_id = $2',
      [req.params.id, req.session.user.id]
    );

    if (avaliacaoExistente.rows.length > 0) {
      await db.query(`
        UPDATE avaliacoes 
        SET classificacao = $1, comentario = $2, updated_at = CURRENT_TIMESTAMP
        WHERE produto_id = $3 AND usuario_id = $4
      `, [classificacaoNum, comentario, req.params.id, req.session.user.id]);
      req.flash('success', 'Avaliação atualizada com sucesso!');
    } else {
      await db.query(`
        INSERT INTO avaliacoes (produto_id, usuario_id, classificacao, comentario)
        VALUES ($1, $2, $3, $4)
      `, [req.params.id, req.session.user.id, classificacaoNum, comentario]);
      req.flash('success', 'Avaliação enviada com sucesso!');
    }

    res.redirect(`/produto/${req.params.id}`);
  } catch (error) {
    console.error('Erro ao enviar avaliação:', error);
    req.flash('error', 'Erro ao enviar avaliação');
    res.redirect(`/produto/${req.params.id}`);
  }
});

app.post('/avaliacao/:id/remover', requireAuth, async (req, res) => {
  try {
    const avaliacao = await db.query('SELECT * FROM avaliacoes WHERE id = $1', [req.params.id]);
    
    if (avaliacao.rows.length === 0) {
      req.flash('error', 'Avaliação não encontrada');
      return res.redirect('back');
    }

    if (avaliacao.rows[0].usuario_id !== req.session.user.id && req.session.user.tipo !== 'admin') {
      req.flash('error', 'Você não tem permissão para remover esta avaliação');
      return res.redirect('back');
    }

    await db.query('DELETE FROM avaliacoes WHERE id = $1', [req.params.id]);
    
    req.flash('success', 'Avaliação removida com sucesso!');
    res.redirect('back');
  } catch (error) {
    console.error('Erro ao remover avaliação:', error);
    req.flash('error', 'Erro ao remover avaliação');
    res.redirect('back');
  }
});

app.get('/lojas', async (req, res) => {
  try {
    const lojas = await db.query(`
      SELECT u.*, 
             COUNT(p.id) as total_produtos,
             COALESCE(AVG(a.classificacao), 0) as media_classificacao,
             COUNT(DISTINCT a.id) as total_avaliacoes,
             COUNT(DISTINCT s.id) as total_seguidores
      FROM usuarios u
      LEFT JOIN produtos p ON u.id = p.vendedor_id AND p.ativo = true
      LEFT JOIN avaliacoes a ON p.id = a.produto_id
      LEFT JOIN seguidores s ON u.id = s.loja_id
      WHERE u.tipo = 'vendedor' AND u.loja_ativa = true
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);

    res.render('lojas/lista', {
      lojas: lojas.rows,
      title: 'Lojas - KuandaShop'
    });
  } catch (error) {
    console.error('Erro ao carregar lojas:', error);
    res.render('lojas/lista', { 
      lojas: [],
      title: 'Lojas'
    });
  }
});

app.get('/loja/:id', async (req, res) => {
  const { categoria, busca, ordenar } = req.query;
  
  try {
    // 1. Busca os dados da loja (incluindo banner_loja via u.*)
    const loja = await db.query(`
      SELECT u.*, 
             COUNT(DISTINCT p.id) as total_produtos,
             COALESCE(AVG(a.classificacao), 0) as media_classificacao,
             COUNT(DISTINCT a.id) as total_avaliacoes,
             COUNT(DISTINCT s.id) as total_seguidores
      FROM usuarios u
      LEFT JOIN produtos p ON u.id = p.vendedor_id AND p.ativo = true
      LEFT JOIN avaliacoes a ON p.id = a.produto_id
      LEFT JOIN seguidores s ON u.id = s.loja_id
      WHERE u.id = $1 AND u.tipo = 'vendedor' AND u.loja_ativa = true
      GROUP BY u.id
    `, [req.params.id]);

    if (loja.rows.length === 0) {
      req.flash('error', 'Loja não encontrada');
      return res.redirect('/lojas');
    }

    // --- DEBUG: OLHE NO SEU TERMINAL SE O BANNER APARECE AQUI ---
    console.log("DADOS DA LOJA:", {
        id: loja.rows[0].id,
        nome: loja.rows[0].nome,
        banner_loja: loja.rows[0].banner_loja // <--- Tem que aparecer o nome do arquivo aqui (ex: banner-123.jpg)
    });
    // -----------------------------------------------------------

    // 2. Monta a query de produtos
    let produtosQuery = `
      SELECT p.*, 
             COALESCE(AVG(a.classificacao), 0) as media_classificacao,
             COUNT(a.id) as total_avaliacoes,
             c.nome as categoria_nome
      FROM produtos p 
      LEFT JOIN avaliacoes a ON p.id = a.produto_id
      LEFT JOIN categorias c ON p.categoria_id = c.id
      WHERE p.vendedor_id = $1 AND p.ativo = true
    `;
    
    const params = [req.params.id];
    let paramCount = 1;

    if (categoria) {
      paramCount++;
      produtosQuery += ` AND p.categoria_id = $${paramCount}`;
      params.push(categoria);
    }

    if (busca) {
      paramCount++;
      produtosQuery += ` AND (p.nome ILIKE $${paramCount} OR p.descricao ILIKE $${paramCount})`;
      params.push(`%${busca}%`);
    }

    produtosQuery += ' GROUP BY p.id, c.nome';

    switch (ordenar) {
      case 'preco_asc': produtosQuery += ' ORDER BY p.preco ASC'; break;
      case 'preco_desc': produtosQuery += ' ORDER BY p.preco DESC'; break;
      case 'nome': produtosQuery += ' ORDER BY p.nome ASC'; break;
      default: produtosQuery += ' ORDER BY p.created_at DESC';
    }

    // 3. Executa as queries paralelas (Produtos e Categorias da loja)
    const [produtos, categoriasList] = await Promise.all([
      db.query(produtosQuery, params),
      db.query(`
        SELECT DISTINCT c.* 
        FROM categorias c
        JOIN produtos p ON c.id = p.categoria_id
        WHERE p.vendedor_id = $1 AND p.ativo = true
        ORDER BY c.nome
      `, [req.params.id])
    ]);

    // 4. Verifica se o usuário logado segue a loja
    let seguindo = false;
    if (req.session.user) {
      const segueResult = await db.query(
        'SELECT id FROM seguidores WHERE usuario_id = $1 AND loja_id = $2',
        [req.session.user.id, req.params.id]
      );
      seguindo = segueResult.rows.length > 0;
    }

    // 5. Renderiza a view
    res.render('lojas/detalhes', {
      loja: loja.rows[0],
      produtos: produtos.rows,
      categorias: categoriasList.rows,
      filtros: { categoria, busca, ordenar },
      seguindo,
      title: `${loja.rows[0].nome_loja || loja.rows[0].nome} - Loja`
    });

  } catch (error) {
    console.error('Erro ao carregar loja:', error);
    req.flash('error', 'Erro ao carregar loja');
    res.redirect('/lojas');
  }
});

app.post('/loja/:id/seguir', requireAuth, async (req, res) => {
  try {
    const loja = await db.query(
      'SELECT id FROM usuarios WHERE id = $1 AND tipo = $2 AND loja_ativa = true',
      [req.params.id, 'vendedor']
    );
    
    if (loja.rows.length === 0) {
      req.flash('error', 'Loja não encontrada ou inativa');
      return res.redirect('back');
    }
    
    if (req.session.user.id === parseInt(req.params.id)) {
      req.flash('error', 'Você não pode seguir sua própria loja');
      return res.redirect('back');
    }
    
    const jaSegue = await db.query(
      'SELECT id FROM seguidores WHERE usuario_id = $1 AND loja_id = $2',
      [req.session.user.id, req.params.id]
    );

    if (jaSegue.rows.length > 0) {
      await db.query(
        'DELETE FROM seguidores WHERE usuario_id = $1 AND loja_id = $2',
        [req.session.user.id, req.params.id]
      );
      req.flash('success', 'Você deixou de seguir esta loja');
    } else {
      await db.query(
        'INSERT INTO seguidores (usuario_id, loja_id) VALUES ($1, $2)',
        [req.session.user.id, req.params.id]
      );
      req.flash('success', 'Você agora segue esta loja');
    }

    res.redirect(`/loja/${req.params.id}`);
  } catch (error) {
    console.error('Erro ao seguir/deixar de seguir loja:', error);
    req.flash('error', 'Erro ao processar solicitação');
    res.redirect(`/loja/${req.params.id}`);
  }
});

// ==================== ROTA QUE FALTAVA ====================
app.get('/login', (req, res) => {
    // Se o usuário já estiver logado, manda para a home
    if (req.session.user) {
        return res.redirect('/');
    }
    // Renderiza o arquivo da pasta views/auth/login.ejs
    res.render('auth/login', { 
        title: 'Login - KuandaShop', 
        layout: false // Importante: usa o HTML blindado sem o layout padrão
    });
});
// ==========================================================

// ==================== ROTAS DE AUTENTICAÇÃO ====================
app.post('/login', async (req, res) => {
  try {
    const { email, senha, google_id } = req.body;

    // 1. Validação básica de entrada
    if (!email) {
      req.flash('error', 'O campo e-mail é obrigatório.');
      return req.session.save(() =>
        res.redirect('/login?error=email_vazio')
      );
    }

    // 2. Buscar Usuário
    const result = await db.query(
      'SELECT * FROM usuarios WHERE email = $1',
      [email.trim().toLowerCase()]
    );

    if (result.rows.length === 0) {
      req.flash('error', 'Usuário não encontrado.');
      return req.session.save(() =>
        res.redirect('/login?error=usuario_nao_encontrado')
      );
    }

    const user = result.rows[0];

    // 3. Lógica de Login (Google vs Senha)
    if (google_id) {
      // Tentativa de login Google
      if (!user.google_id) {
        req.flash('error', 'Esta conta foi criada com senha. Use sua senha.');
        return req.session.save(() =>
          res.redirect('/login?error=use_senha')
        );
      }

      if (user.google_id !== google_id) {
        req.flash('error', 'Conta Google inválida para este e-mail.');
        return req.session.save(() =>
          res.redirect('/login?error=google_invalido')
        );
      }
    } else {
      // Tentativa de login com senha
      if (!user.senha) {
        req.flash('info', 'Esta conta usa login social. Clique no botão Google.');
        return req.session.save(() =>
          res.redirect('/login?error=conta_google')
        );
      }

      if (!senha) {
        req.flash('error', 'Senha obrigatória.');
        return req.session.save(() =>
          res.redirect('/login?error=senha_vazia')
        );
      }

      const senhaValida = await bcrypt.compare(senha, user.senha);
      if (!senhaValida) {
        req.flash('error', 'Senha incorreta.');
        return req.session.save(() =>
          res.redirect('/login?error=senha_incorreta')
        );
      }
    }

    // 4. Verificações de Status
    if (!user.email_verificado && !user.google_id) {
      req.flash('warning', 'Verifique seu e-mail para ativar a conta.');
      return req.session.save(() =>
        res.redirect('/login?error=email_nao_verificado')
      );
    }

    if (user.tipo === 'vendedor' && !user.loja_ativa) {
      req.flash('error', 'Sua loja está inativa. Contate o suporte.');
      return req.session.save(() =>
        res.redirect('/login?error=loja_inativa')
      );
    }

    // 5. Montar Sessão (SEGURA)
    req.session.user = {
      id: user.id,
      nome: user.nome,
      email: user.email,
      tipo: user.tipo, // admin | vendedor | cliente
      nome_loja: user.nome_loja || null,
      loja_ativa: user.loja_ativa || false,
      foto_perfil: user.foto_perfil || null,
      plano_id: user.plano_id || null,
      limite_produtos: user.limite_produtos || 0,
      google: !!user.google_id
    };

    // 6. Definir destino seguro
    const destino =
      user.tipo === 'admin'
        ? '/admin'
        : user.tipo === 'vendedor'
        ? '/vendedor'
        : '/';

    // 7. Sucesso
    req.flash('success', `Bem-vindo, ${user.nome.split(' ')[0]}!`);

    // IMPORTANTE: salvar sessão explicitamente
    req.session.save((err) => {
      if (err) {
        console.error('Erro ao salvar sessão:', err);
        return res.redirect('/login?error=erro_sessao');
      }
      return res.redirect(destino);
    });

  } catch (error) {
    console.error('CRASH NO LOGIN:', error);
    req.flash('error', 'Erro interno ao processar login.');
    return req.session.save(() =>
      res.redirect('/login?error=erro_interno')
    );
  }
});



app.get('/registro', (req, res) => {
  if (req.session.user) {
    return res.redirect('/');
  }
  res.render('auth/registro', { title: 'Registro - KuandaShop' });
});

/* =========================================================================
   ROTA DE REGISTRO BLINDADA (PROTOCOLO VENOM - FULL INTEGRATION)
   ========================================================================= */
app.post('/registro', uploadPerfil.single('foto_perfil'), async (req, res) => {
    // Sanitização inicial para evitar erros de leitura
    const nome = req.body.nome || '';
    const email = (req.body.email || '').trim().toLowerCase();
    const senha = req.body.senha || '';
    const telefone = req.body.telefone || '';
    const tipo = req.body.tipo || 'cliente';
    const nome_loja = req.body.nome_loja || '';
    const descricao_loja = req.body.descricao_loja || '';
    const google_id = req.body.google_id || null;

    try {
        /* =======================
           1. VALIDAÇÕES DE ENTRADA
        ======================= */

        // Validar campos obrigatórios básicos
        if (!nome || !email) {
            if (req.file) removeProfilePicture(req.file.filename);
            req.flash('error', 'Nome e e-mail são obrigatórios.');
            return req.session.save(() => res.redirect('/registro?error=campos_vazios'));
        }

        // Validar Senha (apenas se não for login Google)
        if (!google_id && senha.length < 6) {
            if (req.file) removeProfilePicture(req.file.filename);
            req.flash('error', 'A senha deve ter no mínimo 6 caracteres.');
            return req.session.save(() => res.redirect('/registro?error=senha_curta'));
        }

        // Validar Vendedor
        if (tipo === 'vendedor' && !nome_loja) {
            if (req.file) removeProfilePicture(req.file.filename);
            req.flash('error', 'Vendedores precisam informar o Nome da Loja.');
            return req.session.save(() => res.redirect('/registro?error=loja_sem_nome'));
        }

        /* =======================
           2. VERIFICAR DUPLICIDADE
        ======================= */
        const emailExiste = await db.query('SELECT id FROM usuarios WHERE email = $1', [email]);

        if (emailExiste.rows.length > 0) {
            if (req.file) removeProfilePicture(req.file.filename);
            req.flash('error', 'Este endereço de e-mail já está cadastrado.');
            return req.session.save(() => res.redirect('/registro?error=email_existente'));
        }

        /* =======================
           3. PREPARAÇÃO DE DADOS
        ======================= */
        const senhaHash = google_id ? null : await bcrypt.hash(senha, 10);
        const email_verificado = !!google_id; // Se for Google, já nasce verificado
        const tokenVerificacao = google_id ? null : crypto.randomBytes(32).toString('hex');
        const foto_perfil = req.file ? req.file.filename : null;

        // Lógica de Plano para Vendedor
        let plano_id = null;
        let limite_produtos = 10;

        if (tipo === 'vendedor') {
            const planoBasico = await db.query(
                "SELECT id, limite_produtos FROM planos_vendedor WHERE nome = 'Básico' LIMIT 1"
            );
            if (planoBasico.rows.length > 0) {
                plano_id = planoBasico.rows[0].id;
                limite_produtos = planoBasico.rows[0].limite_produtos;
            }
        }

        /* =======================
           4. INSERÇÃO NO BANCO
        ======================= */
        const result = await db.query(`
            INSERT INTO usuarios (
                nome, email, senha, telefone, tipo, nome_loja, descricao_loja, 
                foto_perfil, loja_ativa, plano_id, limite_produtos, 
                email_verificado, token_verificacao, google_id, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
            RETURNING id, nome, email, tipo, nome_loja, foto_perfil, plano_id, limite_produtos
        `, [
            nome, email, senhaHash, telefone, tipo, nome_loja, descricao_loja, 
            foto_perfil, true, plano_id, limite_produtos, 
            email_verificado, tokenVerificacao, google_id
        ]);

        const newUser = result.rows[0];

        // Backup da Foto (Sistema Híbrido BYTEA)
        if (req.file && typeof salvarBackupImagem === 'function') {
            const filePath = path.join(__dirname, 'public/uploads/perfil/', req.file.filename);
            if (fs.existsSync(filePath)) {
                await salvarBackupImagem(filePath, req.file.filename, 'usuarios', newUser.id);
            }
        }

        /* =========================================================================
           5. PÓS-REGISTRO (GOOGLE vs EMAIL)
           ========================================================================= */

        // ========================================================================
        // CENÁRIO A: REGISTRO COM GOOGLE (Login Automático)
        // ========================================================================
        if (google_id) {
            req.session.user = {
                id: newUser.id,
                nome: newUser.nome,
                email: newUser.email,
                tipo: newUser.tipo,
                nome_loja: newUser.nome_loja,
                foto_perfil: newUser.foto_perfil,
                plano_id: newUser.plano_id,
                limite_produtos: newUser.limite_produtos,
                google: true
            };

            req.flash('success', 'Conta criada com Google com sucesso!');

            const destino =
                newUser.tipo === 'admin'
                    ? '/admin'
                    : newUser.tipo === 'vendedor'
                        ? '/vendedor'
                        : '/';

            return req.session.save(() => res.redirect(destino));
        }

        // ========================================================================
        // CENÁRIO B: REGISTRO COM E-MAIL E SENHA (Com Fallback de Ativação)
        // ========================================================================
        const linkConfirmacao = `${process.env.BASE_URL}/verificar-email/${tokenVerificacao}`;

        try {
            // Verifica se o SMTP está minimamente configurado
            if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
                throw new Error("SMTP não configurado no ambiente.");
            }

            await transporter.sendMail({
                from: `"KuandaShop" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: "Confirme sua conta no KuandaShop",
                html: `
                <!DOCTYPE html>
                <html lang="pt">
                <head>
                    <meta charset="UTF-8">
                    <title>Confirmação de Conta</title>
                </head>
                <body style="margin:0; padding:30px; background:#f5f5f5; font-family:Arial,sans-serif;">
                    <div style="max-width:650px; margin:auto; background:#ffffff; border-radius:10px; overflow:hidden; box-shadow:0 5px 20px rgba(0,0,0,.08);">
                        <div style="background:#E31C25; padding:30px; text-align:center; color:white;">
                            <h1 style="margin:0;">KuandaShop</h1>
                        </div>
                        <div style="padding:40px;">
                            <h2>Olá, ${nome.split(' ')[0]} 👋</h2>
                            <p>Sua conta foi criada com sucesso. Clique no botão abaixo para confirmar seu endereço de e-mail e ativar seu acesso.</p>
                            <div style="text-align:center; margin:40px 0;">
                                <a href="${linkConfirmacao}" style="background:#E31C25; color:white; text-decoration:none; padding:15px 35px; border-radius:8px; display:inline-block; font-size:16px; font-weight:bold;">Confirmar Conta</a>
                            </div>
                            <p>Caso o botão não funcione, copie este link:</p>
                            <p style="word-break:break-all; color:#0066cc;">${linkConfirmacao}</p>
                            <hr style="border:none; border-top:1px solid #eee; margin:30px 0;">
                            <p style="font-size:13px; color:#888;">Se você não criou esta conta, ignore este e-mail.</p>
                        </div>
                    </div>
                </body>
                </html>`
            });

            console.log("==========================================");
            console.log("✅ E-mail enviado com sucesso para:", email);
            console.log("==========================================");

            req.flash("success", "Conta criada com sucesso! Verifique seu e-mail para ativar sua conta.");

        } catch (mailError) {
            console.error("==========================================");
            console.error("❌ ERRO SMTP (Fallback Ativado)");
            console.error("Mensagem:", mailError.message);
            console.error("==========================================");

            // FALLBACK AUTOMÁTICO: Ativa a conta se o e-mail falhar para o usuário não ficar preso
            try {
                await db.query(
                    `UPDATE usuarios SET email_verificado = TRUE, token_verificacao = NULL WHERE id = $1`,
                    [newUser.id]
                );
                console.log("✅ Conta ativada via FALLBACK devido à falha do servidor de e-mail.");
            } catch (dbError) {
                console.error("Erro no fallback de banco de dados:", dbError);
            }

            req.flash("warning", "Sua conta foi criada e ATIVADA! Notamos uma instabilidade no nosso servidor de e-mail, então liberamos seu acesso automaticamente.");
        }

        // Finaliza o registro redirecionando para o login
        return req.session.save(() => {
            res.redirect("/login?success=conta_criada");
        });

    } catch (error) {
        // Limpeza de arquivo em caso de erro crítico no processo
        if (req.file) {
            const tempPath = path.join(__dirname, 'public/uploads/perfil/', req.file.filename);
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        }

        console.error("CRASH REGISTRO:", error);
        req.flash("error", "Ocorreu um erro interno ao criar sua conta. Tente novamente em instantes.");

        return req.session.save(() => {
            res.redirect("/registro?error=erro_interno");
        });
    }
});

/* =========================================================================
   ROTA DE LOGOUT BLINDADA
   ========================================================================= */
app.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Erro ao fazer logout:', err);
      return res.redirect('/');
    }
    // Limpa cookie e redireciona com flag Venom
    res.clearCookie('connect.sid'); 
    res.redirect('/login?success=logout'); 
  });
});

/* =========================================================================
   SISTEMA DE RECUPERAÇÃO DE SENHA (INTEGRADO)
   ========================================================================= */

// 1. TELA: Pedir o Link
app.get('/recuperar-senha', (req, res) => {
    if (req.session.user) return res.redirect('/perfil');
    // Passa messages explicitamente se não estiver usando o middleware global
    const messages = res.locals.messages || req.flash();
    res.render('auth/recuperacao', { title: 'Recuperar Senha', messages });
});

// 2. AÇÃO: Enviar o E-mail
app.post('/recuperar-senha', async (req, res) => {
    const { email } = req.body;

    try {
        if (!email) {
            req.flash('error', 'Digite seu e-mail.');
            return req.session.save(() => res.redirect('/recuperar-senha'));
        }

        // Busca o usuário
        const userResult = await db.query('SELECT * FROM usuarios WHERE email = $1', [email.trim().toLowerCase()]);
        const user = userResult.rows[0];

        // Se não existir, avisa (ou simula sucesso por segurança, mas aqui vamos avisar)
        if (!user) {
            req.flash('error', 'E-mail não encontrado no sistema.');
            return req.session.save(() => res.redirect('/recuperar-senha?error=usuario_nao_encontrado'));
        }

        // Se for conta Google
        if (!user.senha && user.google_id) {
            req.flash('error', 'Esta conta usa Login Google. Clique no botão Google para entrar.');
            return req.session.save(() => res.redirect('/login?error=conta_google'));
        }

        // Gerar Token
        const token = crypto.randomBytes(32).toString('hex');
        const now = new Date();
        now.setHours(now.getHours() + 1); // 1 hora

        await db.query(
            'UPDATE usuarios SET reset_token = $1, reset_expires = $2 WHERE id = $3',
            [token, now, user.id]
        );

        const resetUrl = `${req.protocol}://${req.get('host')}/resetar-senha/${token}`;

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: user.email,
            subject: 'Redefinição de Senha - KuandaShop',
            html: `
                <div style="font-family: sans-serif; padding: 20px; color: #333;">
                    <h2>Redefinição de Senha</h2>
                    <p>Clique abaixo para criar uma nova senha:</p>
                    <a href="${resetUrl}" style="background-color: #E31C25; color: white; padding: 12px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Redefinir Senha</a>
                </div>
            `
        });

        req.flash('success', 'Link enviado! Verifique seu e-mail.');
        return req.session.save(() => res.redirect('/login?success=email_enviado'));

    } catch (error) {
        console.error('Erro Recuperação:', error);
        req.flash('error', 'Erro ao enviar e-mail.');
        return req.session.save(() => res.redirect('/recuperar-senha'));
    }
});

// 3. TELA: Definir Nova Senha
app.get('/resetar-senha/:token', async (req, res) => {
    const { token } = req.params;
    try {
        const user = await db.query(
            'SELECT * FROM usuarios WHERE reset_token = $1 AND reset_expires > $2',
            [token, new Date()]
        );

        if (user.rows.length === 0) {
            req.flash('error', 'Link inválido ou expirado.');
            return req.session.save(() => res.redirect('/recuperar-senha?error=link_invalido'));
        }

        const messages = res.locals.messages || req.flash();
        res.render('auth/resetar', { title: 'Nova Senha', token, messages });
    } catch (error) {
        console.error(error);
        res.redirect('/login');
    }
});

// 4. AÇÃO: Salvar Nova Senha
app.post('/resetar-senha/:token', async (req, res) => {
    const { token } = req.params;
    const { senha, confirmar_senha } = req.body;

    try {
        if (senha !== confirmar_senha) {
            req.flash('error', 'As senhas não coincidem.');
            return req.session.save(() => res.redirect('back'));
        }
        if (senha.length < 6) {
            req.flash('error', 'Senha muito curta (mínimo 6).');
            return req.session.save(() => res.redirect('back'));
        }

        const userResult = await db.query(
            'SELECT * FROM usuarios WHERE reset_token = $1 AND reset_expires > $2',
            [token, new Date()]
        );

        if (userResult.rows.length === 0) {
            req.flash('error', 'Link expirado.');
            return req.session.save(() => res.redirect('/recuperar-senha'));
        }

        const user = userResult.rows[0];
        const hashedPassword = await bcrypt.hash(senha, 10);

        await db.query(
            'UPDATE usuarios SET senha = $1, reset_token = NULL, reset_expires = NULL WHERE id = $2',
            [hashedPassword, user.id]
        );

        req.flash('success', 'Senha alterada com sucesso! Faça login.');
        return req.session.save(() => res.redirect('/login?success=senha_redefinida'));

    } catch (error) {
        console.error('Erro Reset:', error);
        req.flash('error', 'Erro ao salvar senha.');
        res.redirect('/login');
    }
});

// ======================================================================
// 0. AUTO-CORREÇÃO E VERIFICAÇÃO DO BANCO DE DADOS
// ======================================================================
async function initDatabaseSchema() {
    console.log("🔧 [SYSTEM] Verificando integridade do Banco de Dados...");
    try {
        // 1. Garante coluna plano_id em usuarios
        await db.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='usuarios' AND column_name='plano_id') THEN 
                    ALTER TABLE usuarios ADD COLUMN plano_id INTEGER DEFAULT NULL;
                    RAISE NOTICE 'Coluna plano_id adicionada.';
                END IF;
            END $$;
        `);

        // 2. Garante tabela assinaturas
        await db.query(`
            CREATE TABLE IF NOT EXISTS assinaturas (
                id SERIAL PRIMARY KEY,
                usuario_id INTEGER REFERENCES usuarios(id),
                tipo VARCHAR(50), valor DECIMAL(10,2), status VARCHAR(20) DEFAULT 'pendente',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                data_inicio TIMESTAMP, data_fim TIMESTAMP
            );
        `);
        
        // 3. Garante tabela pedidos_acesso
        await db.query(`
            CREATE TABLE IF NOT EXISTS pedidos_acesso (
                id SERIAL PRIMARY KEY,
                usuario_id INTEGER REFERENCES usuarios(id),
                jogo_id INTEGER REFERENCES jogos(id),
                filme_id INTEGER REFERENCES filmes(id),
                status VARCHAR(20) DEFAULT 'pendente',
                updated_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log("✅ [SYSTEM] Banco de dados verificado e pronto.");
    } catch (error) {
        console.error("❌ [SYSTEM] Erro no Schema:", error.message);
    }
}
// Executa a verificação ao iniciar
initDatabaseSchema();


// ======================================================================
// 1. ROTA DE PERFIL (QUERY UNIFICADA E CORRIGIDA)
// ======================================================================
app.get('/perfil', requireAuth, async (req, res) => {
    console.log("\n>>> [PERFIL] Carregando dados para User ID:", req.session.user.id);
    
    try {
        const userId = req.session.user.id;

        const [
            usuarioResult,      // 0. Usuário
            pedidosResult,      // 1. Compras Físicas
            assinaturasResult,  // 2. Planos
            jogosResult,        // 3. Biblioteca Jogos (Permanente + Aprovados)
            filmesResult,       // 4. Filmes Ativos (Permanente + Aprovados)
            solicitacoesResult  // 5. Apenas Pendentes
        ] = await Promise.all([
            
            // 0. USUÁRIO
            db.query(`
                SELECT u.*, pv.nome as plano_vendedor_nome 
                FROM usuarios u 
                LEFT JOIN planos_vendedor pv ON u.plano_id = pv.id 
                WHERE u.id = $1
            `, [userId]),
            
            // 1. PEDIDOS FÍSICOS
            db.query(`SELECT * FROM pedidos WHERE usuario_id = $1 ORDER BY created_at DESC`, [userId]),
            
            // 2. ASSINATURAS
            db.query(`SELECT * FROM assinaturas WHERE usuario_id = $1 ORDER BY created_at DESC`, [userId]),
            
            // 3. JOGOS (Usei UNION para pegar os da biblioteca E os pedidos aprovados)
            db.query(`
                SELECT j.id, j.titulo, j.capa, b.data_aquisicao, 'vitalicio' as origem
                FROM jogos j
                JOIN biblioteca_jogos b ON j.id = b.jogo_id
                WHERE b.usuario_id = $1
                UNION
                SELECT j.id, j.titulo, j.capa, pa.created_at as data_aquisicao, 'aprovado' as origem
                FROM pedidos_acesso pa
                JOIN jogos j ON pa.jogo_id = j.id
                WHERE pa.usuario_id = $1 AND pa.status = 'aprovado'
            `, [userId]),
            
            // 4. FILMES (Usei UNION para pegar assinaturas ativas E pedidos aprovados)
            db.query(`
                SELECT f.id, f.titulo, f.poster, af.data_expiracao, 'ativo' as origem
                FROM filmes f
                JOIN assinaturas_filmes af ON f.id = af.filme_id
                WHERE af.usuario_id = $1 AND af.status = 'ativo'
                UNION
                SELECT f.id, f.titulo, f.poster, NULL as data_expiracao, 'aprovado' as origem
                FROM pedidos_acesso pa
                JOIN filmes f ON pa.filme_id = f.id
                WHERE pa.usuario_id = $1 AND pa.status = 'aprovado'
            `, [userId]),
            
            // 5. SOLICITAÇÕES (ESTRITAMENTE PENDENTES)
            db.query(`
                SELECT pa.*, 
                       j.titulo as jogo_titulo, j.capa as jogo_capa,
                       f.titulo as filme_titulo, f.poster as filme_poster
                FROM pedidos_acesso pa
                LEFT JOIN jogos j ON pa.jogo_id = j.id
                LEFT JOIN filmes f ON pa.filme_id = f.id
                WHERE pa.usuario_id = $1 AND pa.status = 'pendente'
                ORDER BY pa.created_at DESC
            `, [userId])
        ]);

        if (usuarioResult.rows.length === 0) {
            req.session.destroy();
            return res.redirect('/');
        }

        const usuario = usuarioResult.rows[0];

        // Processamento para separar Jogos e Filmes Pendentes para o EJS
        const pedidosJogos = solicitacoesResult.rows
            .filter(r => r.jogo_id !== null)
            .map(r => ({
                id: r.id,
                titulo: r.jogo_titulo,
                capa: r.jogo_capa,
                status: 'pendente', // Garante que visualmente apareça pendente
                created_at: r.created_at
            }));

        const pedidosFilmes = solicitacoesResult.rows
            .filter(r => r.filme_id !== null)
            .map(r => ({
                id: r.id,
                titulo: r.filme_titulo,
                poster: r.filme_poster,
                status: 'pendente',
                created_at: r.created_at
            }));

        // Remoção de duplicados na biblioteca (caso exista nas duas tabelas por erro antigo)
        const meusJogosUnicos = [...new Map(jogosResult.rows.map(item => [item['id'], item])).values()];

        console.log(`> Dados carregados: ${meusJogosUnicos.length} Jogos na Lib | ${pedidosJogos.length} Jogos Pendentes`);

        res.render('perfil', {
            usuario: usuario,
            planoInfo: usuario.plano_vendedor_nome ? { nome: usuario.plano_vendedor_nome } : null,
            
            pedidos: pedidosResult.rows,
            assinaturas: assinaturasResult.rows,
            
            // Listas que combinam permanente + aprovado
            meus_jogos: meusJogosUnicos,
            assinaturas_filmes: filmesResult.rows,
            
            // Listas apenas de pendentes
            pedidosJogos: pedidosJogos,
            pedidosFilmes: pedidosFilmes,
            
            messages: req.flash()
        });

    } catch (error) {
        console.error("!!! ERRO CRÍTICO NO PERFIL !!!", error);
        req.flash('error', 'Erro ao carregar perfil.');
        res.redirect('/');
    }
});

// ======================================================================
// 2. ROTA DETALHES DO PEDIDO (CORRIGIDA)
// ======================================================================
app.get('/pedido/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    const userId = req.session.user.id;
    try {
        // 1. Busca o pedido E os dados da Loja (Vendedor)
        // Fazemos um JOIN com usuarios para pegar o nome da loja e telefone
        const pedidoQuery = `
            SELECT p.*, 
                   v.nome_loja, 
                   v.telefone as vendedor_telefone,
                   v.foto_perfil as loja_foto
            FROM pedidos p
            LEFT JOIN usuarios v ON p.vendedor_id = v.id
            WHERE p.id = $1 AND p.usuario_id = $2
        `;
        
        const pedido = await db.query(pedidoQuery, [id, userId]);
        
        if (pedido.rows.length === 0) {
            req.flash('error', 'Pedido não encontrado.');
            return res.redirect('/perfil');
        }

        // 2. Busca os itens E os dados do Produto (Imagem e Nome)
        // Corrigimos para pegar 'imagem1' e renomear 'nome' para 'produto_nome'
        const itensQuery = `
            SELECT ip.*, 
                   prod.nome as produto_nome, 
                   prod.imagem1,
                   prod.imagem2
            FROM itens_pedido ip
            JOIN produtos prod ON ip.produto_id = prod.id
            WHERE ip.pedido_id = $1
        `;

        const itens = await db.query(itensQuery, [id]);

        res.render('pedido-detalhes', {
            pedido: pedido.rows[0],
            itens: itens.rows,
            usuario: req.session.user
        });
    } catch (error) {
        console.error("Erro ao carregar detalhes do pedido:", error);
        req.flash('error', 'Erro ao carregar pedido.');
        res.redirect('/perfil');
    }
});

// ======================================================================
// 3. ROTA DE ASSINATURA (Solicitar)
// ======================================================================
app.post('/assinatura/solicitar', requireAuth, async (req, res) => {
    const { tipo_plano, nome_plano, valor } = req.body;
    const userId = req.session.user.id;

    try {
        const check = await db.query("SELECT id FROM assinaturas WHERE usuario_id = $1 AND status = 'pendente'", [userId]);
        if (check.rows.length > 0) {
            req.flash('error', 'Já existe um pedido em análise.');
            return res.redirect('/perfil');
        }

        await db.query(`
            INSERT INTO assinaturas (usuario_id, tipo, valor, status, created_at)
            VALUES ($1, $2, $3, 'pendente', NOW())
        `, [userId, tipo_plano, valor]);

        res.redirect(`https://wa.me/244900000000?text=Solicito plano ${nome_plano} ID:${userId}`);
    } catch (error) {
        console.error(error);
        res.redirect('/perfil');
    }
});

// ======================================================================
// 4. ADMIN: LISTAR ASSINATURAS
// ======================================================================
app.get('/admin/assinaturas', requireAdmin, async (req, res) => {
    try {
        const pendentes = await db.query(`SELECT a.*, u.nome, u.email FROM assinaturas a JOIN usuarios u ON a.usuario_id = u.id WHERE a.status = 'pendente' ORDER BY a.created_at ASC`);
        const historico = await db.query(`SELECT a.*, u.nome FROM assinaturas a JOIN usuarios u ON a.usuario_id = u.id WHERE a.status != 'pendente' ORDER BY a.created_at DESC LIMIT 20`);
        res.render('admin/assinaturas', { solicitacoes: pendentes.rows, historico: historico.rows });
    } catch (e) { res.redirect('/admin/dashboard'); }
});

// ======================================================================
// 5. ADMIN: APROVAR ASSINATURA (Atualiza Status e Usuário)
// ======================================================================
app.post('/admin/assinaturas/:id/aprovar', requireAdmin, async (req, res) => {
    const { id } = req.params;
    console.log(`> [ADMIN] Aprovando assinatura ID: ${id}`);
    
    try {
        const assResult = await db.query('SELECT * FROM assinaturas WHERE id = $1', [id]);
        if (assResult.rows.length === 0) return res.redirect('/admin/assinaturas');
        
        const assinatura = assResult.rows[0];
        const dataFim = new Date(); dataFim.setDate(dataFim.getDate() + 30);

        let updateQuery = "";
        if (assinatura.tipo === 'gamer_premium') updateQuery = "premium_games_ate = $1";
        else if (assinatura.tipo === 'cine_premium') updateQuery = "premium_cine_ate = $1";
        else updateQuery = "premium_games_ate = $1, premium_cine_ate = $1";

        if (updateQuery) await db.query(`UPDATE usuarios SET ${updateQuery} WHERE id = $2`, [dataFim, assinatura.usuario_id]);
        
        await db.query(`UPDATE assinaturas SET status = 'aprovado', data_inicio = NOW(), data_fim = $1 WHERE id = $2`, [dataFim, id]);
        
        req.flash('success', 'Assinatura Aprovada!');
        res.redirect('/admin/assinaturas');

    } catch (error) {
        console.error(error);
        req.flash('error', 'Erro ao aprovar.');
        res.redirect('/admin/assinaturas');
    }
});

// ======================================================================
// 6. ADMIN: APROVAR PEDIDOS DE JOGOS/FILMES (Nova Rota Essencial)
// ======================================================================
app.post('/admin/pedidos-acesso/:id/aprovar', requireAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        // Atualiza status para 'aprovado'
        await db.query("UPDATE pedidos_acesso SET status = 'aprovado', updated_at = NOW() WHERE id = $1", [id]);
        
        // (Opcional) Inserir na biblioteca definitiva para redundância
        // Mas a rota /perfil já lê os aprovados, então isso basta para mostrar.
        
        req.flash('success', 'Pedido aprovado!');
        res.redirect('/admin/solicitacoes'); // Ajuste para sua rota de lista
    } catch (error) {
        console.error(error);
        req.flash('error', 'Erro ao aprovar pedido.');
        res.redirect('/admin/dashboard');
    }
});

// ======================================================================
// ROTA 2: ALTERAR SENHA - FULL CORRIGIDA
// ======================================================================
app.post('/perfil/alterar-senha', requireAuth, async (req, res) => {
  const { senha_atual, nova_senha, confirmar_senha } = req.body;

  try {
    // 1. Validações de entrada
    if (!senha_atual || !nova_senha || !confirmar_senha) {
      req.flash('error', 'Todos os campos de senha são obrigatórios.');
      return res.redirect('/perfil');
    }

    if (nova_senha !== confirmar_senha) {
      req.flash('error', 'A nova senha e a confirmação não coincidem.');
      return res.redirect('/perfil');
    }

    if (nova_senha.length < 6) {
      req.flash('error', 'A nova senha deve ter pelo menos 6 caracteres.');
      return res.redirect('/perfil');
    }

    // 2. Buscar senha atual no banco (hash)
    const usuarioResult = await db.query('SELECT senha FROM usuarios WHERE id = $1', [req.session.user.id]);
    
    if (usuarioResult.rows.length === 0) {
      req.flash('error', 'Usuário não encontrado.');
      return res.redirect('/perfil');
    }

    const usuario = usuarioResult.rows[0];

    // Se o usuário logou com Google, ele pode não ter senha
    if (!usuario.senha) {
        req.flash('error', 'Usuários Google não possuem senha para alterar.');
        return res.redirect('/perfil');
    }

    // 3. Comparar senha atual com o hash
    const senhaValida = await bcrypt.compare(senha_atual, usuario.senha);
    if (!senhaValida) {
      req.flash('error', 'A senha atual informada está incorreta.');
      return res.redirect('/perfil');
    }

    // 4. Gerar hash da nova senha
    const novaSenhaHash = await bcrypt.hash(nova_senha, 10);

    // 5. Atualizar no banco
    await db.query(
      'UPDATE usuarios SET senha = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [novaSenhaHash, req.session.user.id]
    );

    req.flash('success', 'Sua senha foi alterada com sucesso!');
    res.redirect('/perfil');

  } catch (error) {
    console.error('Erro ao alterar senha:', error);
    req.flash('error', 'Ocorreu um erro ao alterar a senha.');
    res.redirect('/perfil');
  }
});

// ==================== ROTAS DO CARRINHO ====================
app.get('/carrinho/quantidade', (req, res) => {
  try {
    const carrinho = req.session.carrinho || [];
    const quantidade = carrinho.reduce((total, item) => total + (item.quantidade || 0), 0);
    res.json({ success: true, quantidade });
  } catch (error) {
    console.error('Erro ao obter quantidade do carrinho:', error);
    res.json({ success: false, quantidade: 0 });
  }
});

app.get('/carrinho', async (req, res) => {
  try {
    const carrinho = req.session.carrinho || [];
    
    // Buscar informações atualizadas dos produtos
    if (carrinho.length > 0) {
      const produtosIds = carrinho.map(item => item.id);
      const produtos = await db.query(`
        SELECT p.*, u.nome_loja, u.telefone as vendedor_telefone
        FROM produtos p
        JOIN usuarios u ON p.vendedor_id = u.id
        WHERE p.id = ANY($1) AND p.ativo = true AND u.loja_ativa = true
      `, [produtosIds]);

      const produtoMap = {};
      produtos.rows.forEach(prod => {
        produtoMap[prod.id] = prod;
      });

      // Atualizar carrinho com dados do banco
      carrinho.forEach(item => {
        const produto = produtoMap[item.id];
        if (produto) {
          item.nome = produto.nome;
          item.preco = produto.preco_promocional || produto.preco;
          item.imagem = produto.imagem1;
          item.vendedor = produto.nome_loja;
          item.vendedor_telefone = produto.vendedor_telefone;
          item.estoque = produto.estoque;
        }
      });

      // Remover produtos não encontrados ou sem estoque
      req.session.carrinho = carrinho.filter(item => {
        const produto = produtoMap[item.id];
        return produto && produto.estoque >= item.quantidade;
      });
    }

    const total = req.session.carrinho.reduce((total, item) => {
      return total + (item.preco || 0) * (item.quantidade || 0);
    }, 0);

    res.render('carrinho', {
      carrinho: req.session.carrinho || [],
      total: total.toFixed(2),
      title: 'Carrinho de Compras - KuandaShop'
    });
  } catch (error) {
    console.error('Erro ao carregar carrinho:', error);
    res.render('carrinho', {
      carrinho: req.session.carrinho || [],
      total: 0,
      title: 'Carrinho de Compras'
    });
  }
});

app.post('/carrinho/adicionar', async (req, res) => {
  try {
    const { produto_id, quantidade = 1 } = req.body;
    const quantidadeNum = parseInt(quantidade) || 1;

    // Buscar produto
    const produto = await db.query(`
      SELECT p.*, u.nome_loja, u.telefone as vendedor_telefone, u.id as vendedor_id
      FROM produtos p
      JOIN usuarios u ON p.vendedor_id = u.id
      WHERE p.id = $1 AND p.ativo = true AND p.estoque > 0 AND u.loja_ativa = true
    `, [produto_id]);

    if (produto.rows.length === 0) {
      return res.json({ 
        success: false, 
        message: 'Produto não encontrado ou indisponível' 
      });
    }

    const produtoData = produto.rows[0];
    
    // Verificar estoque
    if (quantidadeNum > produtoData.estoque) {
      return res.json({ 
        success: false, 
        message: `Quantidade indisponível. Estoque: ${produtoData.estoque}` 
      });
    }

    // Inicializar carrinho se não existir
    if (!req.session.carrinho) {
      req.session.carrinho = [];
    }

    // Verificar se produto já está no carrinho
    const itemIndex = req.session.carrinho.findIndex(item => item.id == produto_id);
    
    if (itemIndex > -1) {
      // Verificar se a nova quantidade ultrapassa o estoque
      const novaQuantidade = req.session.carrinho[itemIndex].quantidade + quantidadeNum;
      if (novaQuantidade > produtoData.estoque) {
        return res.json({ 
          success: false, 
          message: `Quantidade total excede o estoque. Estoque disponível: ${produtoData.estoque}` 
        });
      }
      req.session.carrinho[itemIndex].quantidade = novaQuantidade;
    } else {
      const preco = produtoData.preco_promocional || produtoData.preco;
      
      req.session.carrinho.push({
        id: Number(produtoData.id),
        nome: produtoData.nome,
        preco: Number(parseFloat(preco).toFixed(2)),
        imagem: produtoData.imagem1,
        quantidade: quantidadeNum,
        vendedor: produtoData.nome_loja,
        vendedor_id: Number(produtoData.vendedor_id),
        vendedor_telefone: produtoData.vendedor_telefone,
        estoque: Number(produtoData.estoque)
      });
    }

    // Calcular quantidade total
    const quantidadeTotal = req.session.carrinho.reduce((total, item) => total + item.quantidade, 0);

    res.json({ 
      success: true, 
      message: 'Produto adicionado ao carrinho!',
      quantidade: quantidadeTotal,
      carrinho: req.session.carrinho.length
    });
  } catch (error) {
    console.error('Erro ao adicionar ao carrinho:', error);
    res.json({ 
      success: false, 
      message: 'Erro interno do servidor' 
    });
  }
});

app.get('/carrinho/data', (req, res) => {
  try {
    const carrinho = req.session.carrinho || [];
    const carrinhoCorrigido = carrinho.map(item => ({
      ...item,
      preco: Number(item.preco) || 0,
      quantidade: Number(item.quantidade) || 0
    }));
    
    res.json({ 
      success: true, 
      carrinho: carrinhoCorrigido,
      quantidade: carrinhoCorrigido.reduce((total, item) => total + item.quantidade, 0)
    });
  } catch (error) {
    console.error('Erro ao obter dados do carrinho:', error);
    res.json({ success: false, carrinho: [], quantidade: 0 });
  }
});

app.post('/carrinho/atualizar', async (req, res) => {
  try {
    const { produto_id, quantidade } = req.body;
    const quantidadeNum = parseInt(quantidade) || 1;

    if (!req.session.carrinho) {
      return res.json({ success: false, message: 'Carrinho vazio' });
    }

    const itemIndex = req.session.carrinho.findIndex(item => item.id == produto_id);
    
    if (itemIndex === -1) {
      return res.json({ success: false, message: 'Produto não encontrado no carrinho' });
    }

    // Buscar estoque atual
    const produto = await db.query(
      'SELECT estoque FROM produtos WHERE id = $1 AND ativo = true',
      [produto_id]
    );

    if (produto.rows.length === 0) {
      return res.json({ success: false, message: 'Produto não encontrado' });
    }

    const estoqueDisponivel = produto.rows[0].estoque;

    // Validar quantidade
    if (quantidadeNum < 1) {
      return res.json({ success: false, message: 'Quantidade mínima é 1' });
    }

    if (quantidadeNum > estoqueDisponivel) {
      return res.json({ 
        success: false, 
        message: `Quantidade indisponível. Estoque: ${estoqueDisponivel}` 
      });
    }

    // Atualizar quantidade
    req.session.carrinho[itemIndex].quantidade = quantidadeNum;

    // Calcular totais
    const quantidadeTotal = req.session.carrinho.reduce((total, item) => total + item.quantidade, 0);
    const subtotal = req.session.carrinho[itemIndex].preco * quantidadeNum;
    const totalGeral = req.session.carrinho.reduce((total, item) => {
      return total + (item.preco * item.quantidade);
    }, 0);

    res.json({ 
      success: true, 
      message: 'Quantidade atualizada',
      quantidade: quantidadeTotal,
      subtotal: subtotal.toFixed(2),
      total: totalGeral.toFixed(2)
    });
  } catch (error) {
    console.error('Erro ao atualizar carrinho:', error);
    res.json({ success: false, message: 'Erro ao atualizar quantidade' });
  }
});

app.post('/carrinho/remover', async (req, res) => {
  try {
    const { produto_id } = req.body;

    if (!req.session.carrinho) {
      return res.json({ success: false, message: 'Carrinho vazio' });
    }

    const initialLength = req.session.carrinho.length;
    req.session.carrinho = req.session.carrinho.filter(item => item.id != produto_id);
    
    if (req.session.carrinho.length < initialLength) {
      const quantidadeTotal = req.session.carrinho.reduce((total, item) => total + item.quantidade, 0);
      
      res.json({ 
        success: true, 
        message: 'Produto removido do carrinho',
        quantidade: quantidadeTotal
      });
    } else {
      res.json({ success: false, message: 'Produto não encontrado no carrinho' });
    }
  } catch (error) {
    console.error('Erro ao remover do carrinho:', error);
    res.json({ success: false, message: 'Erro ao remover produto' });
  }
});

app.post('/carrinho/limpar', (req, res) => {
  try {
    req.session.carrinho = [];
    res.json({ 
      success: true, 
      message: 'Carrinho limpo com sucesso',
      quantidade: 0
    });
  } catch (error) {
    console.error('Erro ao limpar carrinho:', error);
    res.json({ success: false, message: 'Erro ao limpar carrinho' });
  }
});

app.get('/api/current-user', (req, res) => {
  if (req.session.user) {
    res.json({ 
      success: true, 
      user: {
        nome: req.session.user.nome,
        telefone: req.session.user.telefone,
        email: req.session.user.email,
        foto_perfil: req.session.user.foto_perfil
      }
    });
  } else {
    res.json({ success: false, user: null });
  }
});

// ==================== PAINEL DO VENDEDOR ====================
app.get('/vendedor', requireVendor, async (req, res) => {
  try {
    const [stats, produtosRecentes, solicitacoesPendentes, limiteInfo] = await Promise.all([
      db.query(`
        SELECT 
          COUNT(p.id) as total_produtos,
          COUNT(CASE WHEN p.ativo = true THEN 1 END) as produtos_ativos,
          COUNT(DISTINCT s.id) as total_seguidores,
          COALESCE(AVG(a.classificacao), 0) as media_classificacao,
          COUNT(DISTINCT a.id) as total_avaliacoes,
          SUM(CASE WHEN p.vip = true THEN 1 ELSE 0 END) as produtos_vip,
          SUM(CASE WHEN p.destaque = true THEN 1 ELSE 0 END) as produtos_destaque
        FROM produtos p
        LEFT JOIN seguidores s ON p.vendedor_id = s.loja_id
        LEFT JOIN avaliacoes a ON p.id = a.produto_id
        WHERE p.vendedor_id = $1
      `, [req.session.user.id]),
      db.query(`
        SELECT p.*, 
               COALESCE(AVG(a.classificacao), 0) as media_classificacao,
               COUNT(a.id) as total_avaliacoes
        FROM produtos p
        LEFT JOIN avaliacoes a ON p.id = a.produto_id
        WHERE p.vendedor_id = $1
        GROUP BY p.id
        ORDER BY p.created_at DESC
        LIMIT 5
      `, [req.session.user.id]),
      db.query(`
        SELECT COUNT(*) as total 
        FROM solicitacoes_vip 
        WHERE vendedor_id = $1 AND status = 'pendente'
      `, [req.session.user.id]),
      // NOVA CONSULTA: Informações de limite
      db.query(`
        SELECT 
          u.limite_produtos,
          COUNT(p.id) as produtos_cadastrados,
          (u.limite_produtos - COUNT(p.id)) as produtos_disponiveis,
          pv.nome as plano_nome,
          pv.preco_mensal,
          pv.permite_vip,
          pv.permite_destaque
        FROM usuarios u
        LEFT JOIN produtos p ON u.id = p.vendedor_id
        LEFT JOIN planos_vendedor pv ON u.plano_id = pv.id
        WHERE u.id = $1
        GROUP BY u.id, u.limite_produtos, pv.nome, pv.preco_mensal, pv.permite_vip, pv.permite_destaque
      `, [req.session.user.id])
    ]);

    res.render('vendedor/dashboard', {
      stats: stats.rows[0],
      produtosRecentes: produtosRecentes.rows,
      solicitacoesPendentes: solicitacoesPendentes.rows[0].total,
      limiteInfo: limiteInfo.rows[0] || { 
        limite_produtos: 10, 
        produtos_cadastrados: 0, 
        produtos_disponiveis: 10,
        plano_nome: 'Básico',
        preco_mensal: 0,
        permite_vip: false,
        permite_destaque: false 
      },
      title: 'Painel do Vendedor - KuandaShop'
    });
  } catch (error) {
    console.error('Erro no dashboard do vendedor:', error);
    res.render('vendedor/dashboard', {
      stats: {},
      produtosRecentes: [],
      solicitacoesPendentes: 0,
      limiteInfo: { 
        limite_produtos: 10, 
        produtos_cadastrados: 0, 
        produtos_disponiveis: 10,
        plano_nome: 'Básico',
        preco_mensal: 0,
        permite_vip: false,
        permite_destaque: false 
      },
      title: 'Painel do Vendedor'
    });
  }
});

app.get('/vendedor/produtos', requireVendor, async (req, res) => {
  try {
    // Buscar informações do plano primeiro
    const planoInfo = await db.query(`
      SELECT 
        u.limite_produtos,
        COUNT(p.id) as produtos_cadastrados,
        (u.limite_produtos - COUNT(p.id)) as produtos_disponiveis,
        pv.permite_vip,
        pv.permite_destaque
      FROM usuarios u
      LEFT JOIN produtos p ON u.id = p.vendedor_id
      LEFT JOIN planos_vendedor pv ON u.plano_id = pv.id
      WHERE u.id = $1
      GROUP BY u.id, u.limite_produtos, pv.permite_vip, pv.permite_destaque
    `, [req.session.user.id]);

    const produtos = await db.query(`
      SELECT p.*, 
             COALESCE(AVG(a.classificacao), 0) as media_classificacao,
             COUNT(a.id) as total_avaliacoes,
             c.nome as categoria_nome
      FROM produtos p
      LEFT JOIN avaliacoes a ON p.id = a.produto_id
      LEFT JOIN categorias c ON p.categoria_id = c.id
      WHERE p.vendedor_id = $1
      GROUP BY p.id, c.nome
      ORDER BY p.created_at DESC
    `, [req.session.user.id]);

    res.render('vendedor/produtos', {
      produtos: produtos.rows,
      limiteInfo: planoInfo.rows[0] || { 
        limite_produtos: 10, 
        produtos_cadastrados: 0, 
        produtos_disponiveis: 10,
        permite_vip: false,
        permite_destaque: false 
      },
      title: 'Meus Produtos - KuandaShop'
    });
  } catch (error) {
    console.error('Erro ao carregar produtos do vendedor:', error);
    res.render('vendedor/produtos', { 
      produtos: [],
      limiteInfo: { 
        limite_produtos: 10, 
        produtos_cadastrados: 0, 
        produtos_disponiveis: 10,
        permite_vip: false,
        permite_destaque: false 
      },
      title: 'Meus Produtos'
    });
  }
});

app.get('/vendedor/produto/novo', requireVendor, async (req, res) => {
  try {
    // Verificar limite antes de mostrar o formulário
    const limiteInfo = await db.query(`
      SELECT 
        u.limite_produtos,
        COUNT(p.id) as produtos_cadastrados,
        (u.limite_produtos - COUNT(p.id)) as produtos_disponiveis,
        pv.permite_vip,
        pv.permite_destaque
      FROM usuarios u
      LEFT JOIN produtos p ON u.id = p.vendedor_id
      LEFT JOIN planos_vendedor pv ON u.plano_id = pv.id
      WHERE u.id = $1
      GROUP BY u.id, u.limite_produtos, pv.permite_vip, pv.permite_destaque
    `, [req.session.user.id]);
    
    const limiteData = limiteInfo.rows[0] || { 
      limite_produtos: 10, 
      produtos_cadastrados: 0, 
      produtos_disponiveis: 10,
      permite_vip: false,
      permite_destaque: false 
    };
    
    if (limiteData.produtos_disponiveis <= 0) {
      req.flash('error', `Limite de ${limiteData.limite_produtos} produtos atingido. Atualize seu plano para cadastrar mais produtos.`);
      return res.redirect('/vendedor/produtos');
    }
    
    const categorias = await db.query('SELECT * FROM categorias ORDER BY nome');
    
    res.render('vendedor/produto-form', {
      produto: null,
      categorias: categorias.rows,
      produtosDisponiveis: limiteData.produtos_disponiveis,
      limiteProdutos: limiteData.limite_produtos,
      permiteVip: limiteData.permite_vip,
      permiteDestaque: limiteData.permite_destaque,
      action: '/vendedor/produto',
      title: 'Novo Produto - KuandaShop'
    });
  } catch (error) {
    console.error('Erro ao carregar formulário:', error);
    res.render('vendedor/produto-form', {
      produto: null,
      categorias: [],
      produtosDisponiveis: 10,
      limiteProdutos: 10,
      permiteVip: false,
      permiteDestaque: false,
      action: '/vendedor/produto',
      title: 'Novo Produto'
    });
  }
});

app.post('/vendedor/produto', requireVendor, upload.fields([
  { name: 'imagem1', maxCount: 1 },
  { name: 'imagem2', maxCount: 1 },
  { name: 'imagem3', maxCount: 1 }
]), async (req, res) => {
  const { nome, descricao, preco, preco_promocional, categoria_id, estoque, destaque, vip } = req.body;
  
  try {
    // VERIFICAÇÃO DE LIMITE DE PRODUTOS
    const statsVendedor = await db.query(`
      SELECT 
        u.limite_produtos,
        COUNT(p.id) as total_produtos,
        pv.permite_vip,
        pv.permite_destaque
      FROM usuarios u
      LEFT JOIN produtos p ON u.id = p.vendedor_id
      LEFT JOIN planos_vendedor pv ON u.plano_id = pv.id
      WHERE u.id = $1
      GROUP BY u.id, u.limite_produtos, pv.permite_vip, pv.permite_destaque
    `, [req.session.user.id]);
    
    if (statsVendedor.rows.length > 0) {
      const stats = statsVendedor.rows[0];
      const totalProdutos = parseInt(stats.total_produtos);
      const limiteProdutos = parseInt(stats.limite_produtos) || 10;
      
      // Verificar limite de produtos
      if (totalProdutos >= limiteProdutos) {
        req.flash('error', `Limite de ${limiteProdutos} produtos atingido. Atualize seu plano para cadastrar mais produtos.`);
        return res.redirect('/vendedor/produto/novo');
      }
      
      // Verificar se plano permite VIP
      if (vip === 'on' && !stats.permite_vip) {
        req.flash('error', 'Seu plano atual não permite anúncios VIP. Atualize seu plano.');
        return res.redirect('/vendedor/produto/novo');
      }
      
      // Verificar se plano permite destaque
      if (destaque === 'on' && !stats.permite_destaque) {
        req.flash('error', 'Seu plano atual não permite produtos em destaque. Atualize seu plano.');
        return res.redirect('/vendedor/produto/novo');
      }
    }
    
    // Validar dados
    const validationErrors = validateProductData({ nome, descricao, preco, categoria_id, estoque });
    if (validationErrors.length > 0) {
      validationErrors.forEach(error => req.flash('error', error));
      return res.redirect('/vendedor/produto/novo');
    }

    const imagem1 = req.files.imagem1 ? req.files.imagem1[0].filename : null;
    const imagem2 = req.files.imagem2 ? req.files.imagem2[0].filename : null;
    const imagem3 = req.files.imagem3 ? req.files.imagem3[0].filename : null;

    // Se não enviou imagem principal
    if (!imagem1) {
      req.flash('error', 'A imagem principal é obrigatória');
      return res.redirect('/vendedor/produto/novo');
    }

    const result = await db.query(`
      INSERT INTO produtos (nome, descricao, preco, preco_promocional, categoria_id, estoque, imagem1, imagem2, imagem3, vendedor_id, destaque, vip)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id
    `, [
      nome.trim(),
      descricao.trim(),
      parseFloat(preco),
      preco_promocional ? parseFloat(preco_promocional) : null,
      parseInt(categoria_id),
      parseInt(estoque),
      imagem1,
      imagem2,
      imagem3,
      req.session.user.id,
      destaque === 'on',
      vip === 'on'
    ]);

    const produtoId = result.rows[0].id;

    // SALVAR BACKUP BYTEA DAS IMAGENS
    await processarUploadComBackup(req, res, 'produtos', produtoId);

    req.flash('success', 'Produto cadastrado com sucesso!');
    res.redirect('/vendedor/produtos');
  } catch (error) {
    console.error('Erro ao cadastrar produto:', error);
    
    // Remover arquivos enviados em caso de erro
    if (req.files) {
      Object.values(req.files).forEach(fileArray => {
        if (fileArray && fileArray[0]) {
          const filePath = path.join('public/uploads/produtos/', fileArray[0].filename);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        }
      });
    }
    
    req.flash('error', 'Erro ao cadastrar produto');
    res.redirect('/vendedor/produto/novo');
  }
});

app.get('/vendedor/produto/:id/editar', requireVendor, async (req, res) => {
  try {
    const produto = await db.query(
      'SELECT * FROM produtos WHERE id = $1 AND vendedor_id = $2',
      [req.params.id, req.session.user.id]
    );

    if (produto.rows.length === 0) {
      req.flash('error', 'Produto não encontrado');
      return res.redirect('/vendedor/produtos');
    }

    // Buscar informações do plano
    const planoInfo = await db.query(`
      SELECT pv.permite_vip, pv.permite_destaque
      FROM usuarios u
      LEFT JOIN planos_vendedor pv ON u.plano_id = pv.id
      WHERE u.id = $1
    `, [req.session.user.id]);

    const categorias = await db.query('SELECT * FROM categorias ORDER BY nome');
    
    res.render('vendedor/produto-form', {
      produto: produto.rows[0],
      categorias: categorias.rows,
      permiteVip: planoInfo.rows[0]?.permite_vip || false,
      permiteDestaque: planoInfo.rows[0]?.permite_destaque || false,
      action: `/vendedor/produto/${req.params.id}?_method=PUT`,
      title: 'Editar Produto - KuandaShop'
    });
  } catch (error) {
    console.error('Erro ao carregar produto para edição:', error);
    req.flash('error', 'Erro ao carregar produto');
    res.redirect('/vendedor/produtos');
  }
});

app.put('/vendedor/produto/:id', requireVendor, upload.fields([
  { name: 'imagem1', maxCount: 1 },
  { name: 'imagem2', maxCount: 1 },
  { name: 'imagem3', maxCount: 1 }
]), async (req, res) => {
  const { nome, descricao, preco, preco_promocional, categoria_id, estoque, destaque, vip } = req.body;
  
  try {
    const produtoAtual = await db.query(
      'SELECT * FROM produtos WHERE id = $1 AND vendedor_id = $2',
      [req.params.id, req.session.user.id]
    );

    if (produtoAtual.rows.length === 0) {
      req.flash('error', 'Produto não encontrado');
      return res.redirect('/vendedor/produtos');
    }

    // Buscar informações do plano
    const planoInfo = await db.query(`
      SELECT pv.permite_vip, pv.permite_destaque
      FROM usuarios u
      LEFT JOIN planos_vendedor pv ON u.plano_id = pv.id
      WHERE u.id = $1
    `, [req.session.user.id]);

    const permiteVip = planoInfo.rows[0]?.permite_vip || false;
    const permiteDestaque = planoInfo.rows[0]?.permite_destaque || false;

    // Verificar se plano permite VIP
    if (vip === 'on' && !permiteVip) {
      req.flash('error', 'Seu plano atual não permite anúncios VIP. Atualize seu plano.');
      return res.redirect(`/vendedor/produto/${req.params.id}/editar`);
    }
    
    // Verificar se plano permite destaque
    if (destaque === 'on' && !permiteDestaque) {
      req.flash('error', 'Seu plano atual não permite produtos em destaque. Atualize seu plano.');
      return res.redirect(`/vendedor/produto/${req.params.id}/editar`);
    }

    // Validar dados
    const validationErrors = validateProductData({ nome, descricao, preco, categoria_id, estoque });
    if (validationErrors.length > 0) {
      validationErrors.forEach(error => req.flash('error', error));
      return res.redirect(`/vendedor/produto/${req.params.id}/editar`);
    }

    const produto = produtoAtual.rows[0];
    
    // Manter imagens existentes se não enviar novas
    const imagem1 = req.files.imagem1 ? req.files.imagem1[0].filename : produto.imagem1;
    const imagem2 = req.files.imagem2 ? req.files.imagem2[0].filename : produto.imagem2;
    const imagem3 = req.files.imagem3 ? req.files.imagem3[0].filename : produto.imagem3;

    await db.query(`
      UPDATE produtos 
      SET nome = $1, descricao = $2, preco = $3, preco_promocional = $4, 
          categoria_id = $5, estoque = $6, imagem1 = $7, imagem2 = $8, imagem3 = $9,
          destaque = $10, vip = $11, updated_at = CURRENT_TIMESTAMP
      WHERE id = $12 AND vendedor_id = $13
    `, [
      nome.trim(),
      descricao.trim(),
      parseFloat(preco),
      preco_promocional ? parseFloat(preco_promocional) : null,
      parseInt(categoria_id),
      parseInt(estoque),
      imagem1,
      imagem2,
      imagem3,
      destaque === 'on',
      vip === 'on',
      req.params.id,
      req.session.user.id
    ]);

    // SALVAR BACKUP BYTEA DAS NOVAS IMAGENS
    await processarUploadComBackup(req, res, 'produtos', req.params.id);

    req.flash('success', 'Produto atualizado com sucesso!');
    res.redirect('/vendedor/produtos');
  } catch (error) {
    console.error('Erro ao atualizar produto:', error);
    req.flash('error', 'Erro ao atualizar produto');
    res.redirect(`/vendedor/produto/${req.params.id}/editar`);
  }
});

app.delete('/vendedor/produto/:id', requireVendor, async (req, res) => {
  try {
    // Verificar se o produto existe e pertence ao vendedor
    const produto = await db.query(
      'SELECT * FROM produtos WHERE id = $1 AND vendedor_id = $2',
      [req.params.id, req.session.user.id]
    );

    if (produto.rows.length === 0) {
      req.flash('error', 'Produto não encontrado');
      return res.redirect('/vendedor/produtos');
    }

    // Remover fisicamente as imagens do produto
    const prod = produto.rows[0];
    const imagens = [prod.imagem1, prod.imagem2, prod.imagem3].filter(img => img);
    
    imagens.forEach(imagem => {
      const filePath = path.join('public/uploads/produtos/', imagem);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });

    await db.query(
      'DELETE FROM produtos WHERE id = $1 AND vendedor_id = $2',
      [req.params.id, req.session.user.id]
    );

    req.flash('success', 'Produto removido com sucesso!');
    res.redirect('/vendedor/produtos');
  } catch (error) {
    console.error('Erro ao remover produto:', error);
    req.flash('error', 'Erro ao remover produto');
    res.redirect('/vendedor/produtos');
  }
});

app.post('/vendedor/produto/:id/alternar-status', requireVendor, async (req, res) => {
  try {
    const produto = await db.query(
      'SELECT ativo FROM produtos WHERE id = $1 AND vendedor_id = $2',
      [req.params.id, req.session.user.id]
    );

    if (produto.rows.length === 0) {
      return res.json({ success: false, message: 'Produto não encontrado' });
    }

    const novoStatus = !produto.rows[0].ativo;
    
    await db.query(
      'UPDATE produtos SET ativo = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND vendedor_id = $3',
      [novoStatus, req.params.id, req.session.user.id]
    );

    res.json({ 
      success: true, 
      message: `Produto ${novoStatus ? 'ativado' : 'desativado'} com sucesso!`,
      novoStatus 
    });
  } catch (error) {
    console.error('Erro ao alternar status:', error);
    res.json({ success: false, message: 'Erro ao alternar status' });
  }
});

app.post('/vendedor/produto/:id/solicitar-vip', requireVendor, async (req, res) => {
  try {
    // Verificar se plano permite VIP direto
    const planoInfo = await db.query(`
      SELECT pv.permite_vip
      FROM usuarios u
      LEFT JOIN planos_vendedor pv ON u.plano_id = pv.id
      WHERE u.id = $1
    `, [req.session.user.id]);

    if (planoInfo.rows[0]?.permite_vip) {
      req.flash('info', 'Seu plano já permite anúncios VIP. Você pode ativar VIP diretamente na edição do produto.');
      return res.redirect('/vendedor/produtos');
    }

    // Verificar se já existe solicitação pendente
    const solicitacaoExistente = await db.query(`
      SELECT id FROM solicitacoes_vip 
      WHERE produto_id = $1 AND vendedor_id = $2 AND status = 'pendente'
    `, [req.params.id, req.session.user.id]);

    if (solicitacaoExistente.rows.length > 0) {
      req.flash('info', 'Já existe uma solicitação VIP pendente para este produto');
      return res.redirect('/vendedor/produtos');
    }

    await db.query(`
      INSERT INTO solicitacoes_vip (produto_id, vendedor_id, tipo, status)
      VALUES ($1, $2, 'produto', 'pendente')
    `, [req.params.id, req.session.user.id]);

    req.flash('success', 'Solicitação de anúncio VIP enviada! Aguarde contato do administrador.');
    res.redirect('/vendedor/produtos');
  } catch (error) {
    console.error('Erro ao solicitar VIP:', error);
    req.flash('error', 'Erro ao enviar solicitação');
    res.redirect('/vendedor/produtos');
  }
});

// =======================================================
// 1. CONFIGURAÇÃO DE UPLOAD PARA JOGOS (Multer)
// =======================================================
const gameUpload = upload.fields([
    { name: 'capa', maxCount: 1 },         // Capa Vertical
    { name: 'banner', maxCount: 1 },       // Banner Horizontal
    { name: 'screenshots', maxCount: 10 }  // Galeria de Imagens
]);

// =======================================================
// 2. FUNÇÃO AUXILIAR: SALVAR LINKS DINÂMICOS
// =======================================================
async function salvarLinksJogo(jogoId, labels, urls) {
    try {
        // 1. Limpa links antigos para evitar duplicidade na edição
        await db.query('DELETE FROM jogo_links WHERE jogo_id = $1', [jogoId]);

        // 2. Se não houver URLs, encerra
        if (!urls) return;

        // 3. Normaliza para Array (caso venha apenas um campo string)
        const labelsArray = Array.isArray(labels) ? labels : [labels];
        const urlsArray = Array.isArray(urls) ? urls : [urls];

        // 4. Itera e insere no banco
        for (let i = 0; i < urlsArray.length; i++) {
            const url = urlsArray[i] ? urlsArray[i].trim() : '';
            // Usa o label fornecido ou cria um padrão "Download X"
            const label = (labelsArray[i] && labelsArray[i].trim() !== '') ? labelsArray[i].trim() : `Opção ${i + 1}`;

            if (url !== '') {
                await db.query(
                    'INSERT INTO jogo_links (jogo_id, label, url, ordem) VALUES ($1, $2, $3, $4)',
                    [jogoId, label, url, i] // 'i' define a ordem de exibição
                );
            }
        }
    } catch (err) {
        console.error("Erro crítico ao salvar links do jogo:", err);
        throw new Error("Falha ao salvar os links de download.");
    }
}

// =======================================================
// 3. ROTAS ADMIN: GERENCIAMENTO DE JOGOS
// =======================================================

// A. LISTAR JOGOS
app.get('/admin/jogos', requireAdmin, async (req, res) => {
    try {
        const result = await db.query(`SELECT * FROM jogos ORDER BY created_at DESC`);
        res.render('admin/jogos', { 
            title: 'Gerenciar Jogos - Admin', 
            jogos: result.rows 
        });
    } catch (error) {
        console.error('Erro ao listar jogos:', error);
        req.flash('error', 'Erro ao carregar a lista de jogos.');
        res.redirect('/admin');
    }
});

// B. FORMULÁRIO NOVO
app.get('/admin/jogos/novo', requireAdmin, (req, res) => {
    res.render('admin/jogo_form', { 
        jogo: null, 
        links: [], // Array vazio para não quebrar o loop no EJS
        action: '/admin/jogos',
        title: 'Novo Jogo' 
    });
});

// C. CRIAR JOGO (POST)
app.post('/admin/jogos', requireAdmin, gameUpload, async (req, res) => {
    // Extrai dados do formulário
    const { 
        titulo, preco, plataforma, genero, trailer_url, 
        descricao, requisitos, classificacao, ativo, 
        links_labels, links_urls 
    } = req.body;
  
    try {
        // Validação de Arquivos
        if (!req.files || !req.files['capa']) {
            throw new Error('A imagem de CAPA é obrigatória.');
        }

        const capa = req.files['capa'][0].filename;
        const banner = req.files['banner'] ? req.files['banner'][0].filename : null;
        // Mapeia array de screenshots se existirem
        const screenshots = req.files['screenshots'] ? req.files['screenshots'].map(f => f.filename) : [];

        // Inserção no Banco
        const result = await db.query(`
            INSERT INTO jogos (
                titulo, capa, banner, screenshots, preco, plataforma, genero, 
                trailer_url, descricao, requisitos, classificacao, ativo
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING id
        `, [
            titulo.trim(),
            capa,
            banner,
            screenshots, // O driver do PG converte array JS para array SQL automaticamente
            parseFloat(preco) || 0,
            plataforma,
            genero,
            trailer_url,
            descricao,
            requisitos,
            classificacao,
            ativo === 'on'
        ]);

        const novoJogoId = result.rows[0].id;

        // Salvar Links Dinâmicos
        await salvarLinksJogo(novoJogoId, links_labels, links_urls);

        // Processar Backup (Se a função global existir no seu sistema)
        if(typeof processarUploadComBackup === 'function') {
            await processarUploadComBackup(req, res, 'jogos', novoJogoId);
        }

        req.flash('success', 'Jogo publicado com sucesso!');
        res.redirect('/admin/jogos');

    } catch (err) {
        console.error(err);
        // Tenta limpar arquivos upados em caso de erro (opcional, mas recomendado)
        // if (req.files) { ... lógica de unlink ... }
        
        req.flash('error', 'Erro ao criar jogo: ' + err.message);
        res.redirect('/admin/jogos/novo');
    }
});

// D. FORMULÁRIO EDITAR
app.get('/admin/jogos/:id/editar', requireAdmin, async (req, res) => {
    try {
        const jogoResult = await db.query('SELECT * FROM jogos WHERE id = $1', [req.params.id]);
        if(jogoResult.rows.length === 0) {
            req.flash('error', 'Jogo não encontrado.');
            return res.redirect('/admin/jogos');
        }
        
        // Busca links existentes ordenados
        const linksResult = await db.query('SELECT * FROM jogo_links WHERE jogo_id = $1 ORDER BY ordem ASC', [req.params.id]);

        res.render('admin/jogo_form', {
            jogo: jogoResult.rows[0],
            links: linksResult.rows,
            action: `/admin/jogos/${req.params.id}?_method=PUT`,
            title: 'Editar Jogo'
        });
    } catch (err) {
        console.error(err);
        res.redirect('/admin/jogos');
    }
});

// E. ATUALIZAR JOGO (PUT)
app.put('/admin/jogos/:id', requireAdmin, gameUpload, async (req, res) => {
    const { 
        titulo, preco, plataforma, genero, trailer_url, 
        descricao, requisitos, classificacao, ativo, 
        links_labels, links_urls 
    } = req.body;

    try {
        // Recupera dados atuais para manter imagens antigas caso não enviem novas
        const atual = await db.query('SELECT capa, banner, screenshots FROM jogos WHERE id = $1', [req.params.id]);
        if (atual.rows.length === 0) throw new Error('Jogo não encontrado.');

        const rowAtual = atual.rows[0];

        // Lógica de Imagens: Se enviou nova, usa a nova. Se não, mantém a antiga.
        const capa = req.files['capa'] ? req.files['capa'][0].filename : rowAtual.capa;
        const banner = req.files['banner'] ? req.files['banner'][0].filename : rowAtual.banner;
        
        // Lógica Screenshots: Se enviou novas, substitui todas. Se não, mantém as antigas.
        // (Para um sistema mais complexo de adicionar/remover individualmente, precisaria de logica extra via AJAX)
        const screenshots = (req.files['screenshots'] && req.files['screenshots'].length > 0) 
            ? req.files['screenshots'].map(f => f.filename) 
            : rowAtual.screenshots;

        // Atualiza Jogo
        await db.query(`
            UPDATE jogos SET 
            titulo=$1, capa=$2, banner=$3, screenshots=$4, preco=$5, 
            plataforma=$6, genero=$7, trailer_url=$8, descricao=$9, 
            requisitos=$10, classificacao=$11, ativo=$12, updated_at=CURRENT_TIMESTAMP
            WHERE id=$13
        `, [
            titulo.trim(), capa, banner, screenshots, parseFloat(preco)||0, 
            plataforma, genero, trailer_url, descricao, requisitos, 
            classificacao, ativo === 'on', req.params.id
        ]);

        // Atualiza Links (Apaga antigos e cria novos)
        await salvarLinksJogo(req.params.id, links_labels, links_urls);

        // Backup
        if(typeof processarUploadComBackup === 'function') {
            await processarUploadComBackup(req, res, 'jogos', req.params.id);
        }

        req.flash('success', 'Dados do jogo atualizados com sucesso!');
        res.redirect('/admin/jogos');

    } catch (err) {
        console.error(err);
        req.flash('error', 'Erro ao atualizar: ' + err.message);
        res.redirect(`/admin/jogos/${req.params.id}/editar`);
    }
});

// F. EXCLUIR JOGO (DELETE)
app.delete('/admin/jogos/:id', requireAdmin, async (req, res) => {
    try {
        // O banco deve ter ON DELETE CASCADE configurado nas chaves estrangeiras (links/pedidos),
        // mas deletamos os links manualmente por garantia e clareza.
        await db.query('DELETE FROM jogo_links WHERE jogo_id = $1', [req.params.id]);
        
        // Deletar o jogo (Imagens permanecem na pasta ou cria-se uma função para limpar fs.unlink)
        await db.query('DELETE FROM jogos WHERE id = $1', [req.params.id]);
        
        req.flash('success', 'Jogo removido permanentemente.');
        res.redirect('/admin/jogos');
    } catch (error) {
        console.error(error);
        req.flash('error', 'Erro ao remover o jogo.');
        res.redirect('/admin/jogos');
    }
});

// =======================================================
// 4. ROTAS PÚBLICAS: VISUALIZAÇÃO E COMPRA
// =======================================================

// A. TELA DE DETALHES DO JOGO
app.get('/game/:id', async (req, res) => {
    try {
        // Buscar jogo e verificar se está ativo (ou se é admin vendo preview)
        const jogoResult = await db.query('SELECT * FROM jogos WHERE id = $1', [req.params.id]);
        
        if (jogoResult.rows.length === 0) return res.redirect('/games');
        const jogo = jogoResult.rows[0];

        // Se não for ativo e não for admin, esconde
        // if (!jogo.ativo && (!req.session.user || !req.session.user.isAdmin)) return res.redirect('/games');

        // Buscar Links
        const linksResult = await db.query('SELECT * FROM jogo_links WHERE jogo_id = $1 ORDER BY ordem', [jogo.id]);

        // VARIÁVEIS DE CONTROLE DE ACESSO
        let temAcesso = false;
        let pedidoPendente = false;

        // 1. Jogo Grátis
        if (parseFloat(jogo.preco) <= 0) {
            temAcesso = true;
        } 
        // 2. Usuário Logado verifica compra
        else if (req.session.user) {
            const pedido = await db.query(
                'SELECT status FROM pedidos_acesso WHERE usuario_id = $1 AND jogo_id = $2',
                [req.session.user.id, jogo.id]
            );
            
            if (pedido.rows.length > 0) {
                if (pedido.rows[0].status === 'aprovado') temAcesso = true;
                if (pedido.rows[0].status === 'pendente') pedidoPendente = true;
            }
        }

        res.render('game_detalhes', {
            title: `${jogo.titulo} - Kuanda Games`,
            jogo: jogo,
            links: linksResult.rows,
            temAcesso: temAcesso,
            pedidoPendente: pedidoPendente,
            user: req.session.user || null
        });

    } catch (error) {
        console.error('Erro na rota pública do jogo:', error);
        res.redirect('/games');
    }
});

// B. SOLICITAR COMPRA (POST)
// ======================================================================
// ROTA DE COMPRA DE JOGO (COM VALIDAÇÕES + NOTIFICAÇÃO AO ADMIN)
// ======================================================================
app.post('/game/:id/comprar', requireAuth, async (req, res) => {
    try {
        const jogoId = req.params.id;
        const userId = req.session.user.id;

        // 1️⃣ Verifica se o jogo existe e obtém o preço
        const jogoCheck = await db.query(
            'SELECT preco FROM jogos WHERE id = $1',
            [jogoId]
        );

        if (jogoCheck.rows.length === 0) {
            req.flash('error', 'Jogo não encontrado.');
            return res.redirect('/games');
        }

        const preco = parseFloat(jogoCheck.rows[0].preco);

        // 2️⃣ Se for grátis, não cria pedido
        if (preco <= 0) {
            req.flash('info', 'Este jogo é gratuito.');
            return res.redirect(`/game/${jogoId}`);
        }

        // 3️⃣ Verifica duplicidade de pedido
        const existe = await db.query(
            'SELECT id FROM pedidos_acesso WHERE usuario_id = $1 AND jogo_id = $2',
            [userId, jogoId]
        );

        if (existe.rows.length > 0) {
            req.flash('info', 'Você já possui um pedido em andamento para este jogo.');
            return res.redirect(`/game/${jogoId}`);
        }

        // 4️⃣ Cria o pedido
        await db.query(
            'INSERT INTO pedidos_acesso (usuario_id, jogo_id, status) VALUES ($1, $2, $3)',
            [userId, jogoId, 'pendente']
        );

        // 5️⃣ Busca um admin para notificação
        const adminRes = await db.query(
            "SELECT id FROM usuarios WHERE tipo = 'admin' ORDER BY id ASC LIMIT 1"
        );

        const adminId = adminRes.rows.length > 0 ? adminRes.rows[0].id : null;

        // 6️⃣ Dispara notificação (se o sistema existir)
        if (adminId && req.app.sysNotification) {
            await req.app.sysNotification(
                userId,
                adminId,
                `🎮 Nova solicitação de compra do jogo ID: ${jogoId}.`,
                'sistema'
            );
        }

        req.flash('success', 'Pedido de compra realizado! O admin foi notificado.');
        res.redirect(`/game/${jogoId}`);

    } catch (err) {
        console.error(err);
        req.flash('error', 'Erro ao processar o pedido.');
        res.redirect(`/game/${req.params.id}`);
    }
});


// =======================================================
// ROTAS ADMIN: GESTÃO DE PEDIDOS DE JOGOS
// =======================================================

// 1. TELA DE LISTAGEM DE PEDIDOS
app.get('/admin/pedidos-jogos', requireAdmin, async (req, res) => {
    try {
        // Busca pedidos pendentes especificamente de JOGOS (onde jogo_id não é nulo)
        const pedidos = await db.query(`
            SELECT 
                p.id, 
                p.created_at, 
                p.status,
                u.nome as usuario_nome, 
                u.email, 
                u.telefone, 
                j.titulo as jogo_titulo, 
                j.preco,
                j.capa
            FROM pedidos_acesso p
            JOIN usuarios u ON p.usuario_id = u.id
            JOIN jogos j ON p.jogo_id = j.id
            WHERE p.status = 'pendente' AND p.jogo_id IS NOT NULL
            ORDER BY p.created_at DESC
        `);

        res.render('admin/pedidos_jogos', { 
            pedidos: pedidos.rows,
            title: 'Pedidos de Jogos - Admin' 
        });
    } catch (error) {
        console.error('Erro ao listar pedidos de jogos:', error);
        req.flash('error', 'Erro ao carregar pedidos.');
        res.redirect('/admin');
    }
});

// 2. APROVAR PEDIDO (Libera o download)
app.post('/admin/pedidos-jogos/:id/aprovar', requireAdmin, async (req, res) => {
    try {
        await db.query(
            "UPDATE pedidos_acesso SET status = 'aprovado', updated_at = CURRENT_TIMESTAMP WHERE id = $1", 
            [req.params.id]
        );
        req.flash('success', 'Acesso ao jogo liberado com sucesso!');
        res.redirect('/admin/pedidos-jogos');
    } catch (error) {
        console.error('Erro ao aprovar:', error);
        req.flash('error', 'Erro ao aprovar pedido.');
        res.redirect('/admin/pedidos-jogos');
    }
});

// 3. REJEITAR PEDIDO (Remove a solicitação)
app.post('/admin/pedidos-jogos/:id/rejeitar', requireAdmin, async (req, res) => {
    try {
        await db.query("DELETE FROM pedidos_acesso WHERE id = $1", [req.params.id]);
        req.flash('success', 'Pedido rejeitado e removido.');
        res.redirect('/admin/pedidos-jogos');
    } catch (error) {
        console.error('Erro ao rejeitar:', error);
        req.flash('error', 'Erro ao rejeitar pedido.');
        res.redirect('/admin/pedidos-jogos');
    }
});

// =======================================================
// ROTAS PÚBLICAS: LOJA E DETALHES
// =======================================================

// 7. DETALHES DO JOGO (Com suporte a múltiplos links)
app.get('/game/:id', async (req, res) => {
  try {
    if(!req.params.id || isNaN(req.params.id)) return res.redirect('/games');

    const jogoResult = await db.query('SELECT * FROM jogos WHERE id = $1 AND ativo = true', [req.params.id]);
    if (jogoResult.rows.length === 0) return res.status(404).render('404', { layout: false });
    
    const jogo = jogoResult.rows[0];

    // BUSCAR LINKS DE DOWNLOAD
    let links = [];
    try {
       const linksResult = await db.query('SELECT * FROM jogo_links WHERE jogo_id = $1 ORDER BY id ASC', [req.params.id]);
       links = linksResult.rows;
    } catch (e) { console.error('Tabela de links não encontrada', e); }

    // Similares
    const similares = await db.query(
      'SELECT * FROM jogos WHERE genero = $1 AND id != $2 AND ativo = true LIMIT 4',
      [jogo.genero, req.params.id]
    );

    res.render('game_detalhes', {
      title: `${jogo.titulo} - Kuanda Games`,
      jogo: jogo,
      links: links, // Passa array de links para o front
      similares: similares.rows,
      user: req.session.user || null
    });
  } catch (error) {
    console.error('Erro ao carregar jogo:', error);
    res.redirect('/games');
  }
});

// 8. LOJA DE JOGOS
// ==================== ROTA PÚBLICA: LOJA DE JOGOS (CORRIGIDA) ====================
app.get('/games', async (req, res) => {
  try {
    const { genero, busca, ordenar } = req.query;
    
    // Cálculo seguro de popularidade (trata nulos como zero)
    const calculoPopularidade = `(COALESCE(vendas_count, 0) + COALESCE(downloads_count, 0))`;

    let query = `
      SELECT *, 
      ${calculoPopularidade} as popularidade 
      FROM jogos WHERE ativo = true
    `;
    const params = [];
    let paramCount = 0;

    if (genero) {
      paramCount++;
      query += ` AND genero = $${paramCount}`;
      params.push(genero);
    }

    if (busca) {
      paramCount++;
      query += ` AND titulo ILIKE $${paramCount}`;
      params.push(`%${busca}%`);
    }

    // Ordenação (Usando o cálculo direto para evitar erro de coluna não encontrada)
    if (ordenar === 'novos') {
      query += ' ORDER BY created_at DESC';
    } else if (ordenar === 'popular') {
      query += ` ORDER BY ${calculoPopularidade} DESC`;
    } else if (ordenar === 'preco_asc') {
      query += ' ORDER BY preco ASC';
    } else {
      query += ' ORDER BY created_at DESC'; // Padrão
    }

    const jogos = await db.query(query, params);

    // Sidebar: Top 5 (Também corrigido com COALESCE)
    const topJogos = await db.query(`
      SELECT * FROM jogos 
      WHERE ativo = true 
      ORDER BY (COALESCE(vendas_count, 0) + COALESCE(downloads_count, 0)) DESC 
      LIMIT 5
    `);

    // Gêneros
    const generos = await db.query('SELECT DISTINCT genero FROM jogos WHERE genero IS NOT NULL');

    res.render('games', {
      title: 'Kuanda Games - Loja Oficial',
      jogos: jogos.rows,
      topJogos: topJogos.rows,
      generos: generos.rows,
      filtros: { genero, busca, ordenar },
      user: req.session.user || null
    });
  } catch (error) {
    console.error('Erro ao carregar games:', error);
    // Redireciona para home em caso de erro para não travar o site
    res.redirect('/');
  }
});

// =======================================================
// ROTAS DE PLANOS (CORRIGIDAS E ROBUSTAS)
// =======================================================

// 1. TELA DE PLANOS (COM CARREGAMENTO DE VITRINE)
app.get('/planos', async (req, res) => {
    try {
        // A. Buscar Planos de Vendedor (Se não tiver no banco, cria array manual para não quebrar)
        let planosVendedor = [];
        try {
            const result = await db.query('SELECT * FROM planos_vendedor ORDER BY preco_mensal ASC');
            planosVendedor = result.rows;
        } catch (e) { console.log('Tabela planos_vendedor vazia ou inexistente'); }

        // B. Buscar Vitrine (Jogos e Filmes Recentes) para o Banner
        let showcase = [];
        try {
            // Tenta buscar jogos
            const jogos = await db.query('SELECT titulo, capa FROM jogos WHERE ativo = true ORDER BY created_at DESC LIMIT 6');
            jogos.rows.forEach(j => showcase.push({ 
                tipo: 'JOGO', 
                titulo: j.titulo, 
                img: `/uploads/games/${j.capa}` 
            }));

            // Tenta buscar filmes
            const filmes = await db.query('SELECT titulo, poster FROM filmes WHERE ativo = true ORDER BY created_at DESC LIMIT 6');
            filmes.rows.forEach(f => showcase.push({ 
                tipo: 'FILME', 
                titulo: f.titulo, 
                img: `/uploads/filmes/${f.poster}` 
            }));
        } catch (e) { console.log('Erro ao buscar vitrine', e); }

        // C. Fallback (Se não tiver nada, preenche com placeholders para o design não quebrar)
        if (showcase.length === 0) {
            showcase = [
                { tipo: 'PREMIUM', titulo: 'GTA VI', img: 'https://via.placeholder.com/300x450/4f46e5/ffffff?text=GTA+VI' },
                { tipo: 'CINE', titulo: 'Dune 2', img: 'https://via.placeholder.com/300x450/E31C25/ffffff?text=Cinema' },
                { tipo: 'JOGO', titulo: 'FIFA 25', img: 'https://via.placeholder.com/300x450/10b981/ffffff?text=FIFA' },
                { tipo: 'CINE', titulo: 'Marvel', img: 'https://via.placeholder.com/300x450/000000/ffffff?text=Marvel' }
            ];
        }

        res.render('planos', {
            title: 'Escolha seu Plano - KuandaShop',
            planosVendedor: planosVendedor,
            showcase: showcase,
            user: req.session.user || null,
            carrinho: req.session.carrinho || []
        });

    } catch (error) {
        console.error('Erro crítico na rota de planos:', error);
        res.redirect('/');
    }
});

// ======================================================================
// ROTA: PROCESSAR ASSINATURA (PLANOS)
// ======================================================================
app.post('/planos/aderir', requireAuth, async (req, res) => {
    const { tipo_plano, nome_plano, valor } = req.body;
    const userId = req.session.user.id;

    try {
        // 1. Cria Assinatura
        const result = await db.query(`
            INSERT INTO assinaturas (usuario_id, tipo, valor, status, created_at)
            VALUES ($1, $2, $3, 'pendente', NOW()) RETURNING id
        `, [userId, tipo_plano, valor]);
        
        const assId = result.rows[0].id;

        // 2. NOTIFICA O ADMIN
        const adminRes = await db.query("SELECT id FROM usuarios WHERE tipo='admin' LIMIT 1");
        if (adminRes.rows.length > 0 && req.app.sysNotification) {
            const adminId = adminRes.rows[0].id;
            await req.app.sysNotification(
                userId, // De: Cliente
                adminId, // Para: Admin
                `📄 Nova solicitação de assinatura: ${nome_plano} (Ref: #${assId})`, 
                'sistema' // Tipo
            );
        }

        res.redirect('https://wa.me/244974120856?text=Solicitei+Plano');
    } catch (e) {
        console.error("Erro Plano:", e);
        res.redirect('/planos');
    }
});

// 3. ADMIN: GERENCIAR ASSINATURAS (NOVA ROTA)
app.get('/admin/assinaturas', requireAdmin, async (req, res) => {
    try {
        const assinaturas = await db.query(`
            SELECT a.*, u.nome, u.email, u.telefone 
            FROM assinaturas a
            JOIN usuarios u ON a.usuario_id = u.id
            ORDER BY a.created_at DESC
        `);
        
        res.render('admin/assinaturas', { assinaturas: assinaturas.rows });
    } catch (error) {
        console.error(error);
        res.redirect('/admin');
    }
});

// 4. ADMIN: APROVAR ASSINATURA
app.post('/admin/assinaturas/:id/aprovar', requireAdmin, async (req, res) => {
    try {
        const ass = await db.query('SELECT * FROM assinaturas WHERE id = $1', [req.params.id]);
        if(ass.rows.length === 0) return res.redirect('/admin/assinaturas');
        
        const assinatura = ass.rows[0];
        const dias = 30; // Duração padrão
        const dataFim = new Date();
        dataFim.setDate(dataFim.getDate() + dias);

        // Atualizar tabela de assinaturas
        await db.query(`
            UPDATE assinaturas 
            SET status = 'aprovado', data_inicio = CURRENT_TIMESTAMP, data_fim = $1
            WHERE id = $2
        `, [dataFim, req.params.id]);

        // Atualizar permissões do usuário
        if (assinatura.tipo.includes('vendedor')) {
            // Lógica para mudar plano do vendedor (já existente)
            // Ex: buscar ID do plano baseado no nome e atualizar usuarios.plano_id
        } else if (assinatura.tipo === 'gamer_premium') {
            await db.query('UPDATE usuarios SET premium_games_ate = $1 WHERE id = $2', [dataFim, assinatura.usuario_id]);
        } else if (assinatura.tipo === 'cine_premium') {
            await db.query('UPDATE usuarios SET premium_cine_ate = $1 WHERE id = $2', [dataFim, assinatura.usuario_id]);
        } else if (assinatura.tipo === 'kuanda_pass') {
            // Libera tudo
            await db.query('UPDATE usuarios SET premium_games_ate = $1, premium_cine_ate = $1 WHERE id = $2', [dataFim, assinatura.usuario_id]);
        }

        req.flash('success', 'Assinatura ativada com sucesso!');
        res.redirect('/admin/assinaturas');

    } catch (error) {
        console.error(error);
        res.redirect('/admin/assinaturas');
    }
});

// ==================== PAINEL ADMINISTRATIVO ====================
app.get('/admin', requireAdmin, async (req, res) => {
  try {
    const [stats, vendedoresRecentes, produtosRecentes, solicitacoesPendentes, planosStats] = await Promise.all([
      db.query(`
        SELECT 
          (SELECT COUNT(*) FROM usuarios WHERE tipo = 'vendedor') as total_vendedores,
          (SELECT COUNT(*) FROM usuarios WHERE tipo = 'cliente') as total_clientes,
          (SELECT COUNT(*) FROM produtos WHERE ativo = true) as total_produtos,
          (SELECT COUNT(*) FROM solicitacoes_vip WHERE status = 'pendente') as solicitacoes_pendentes,
          (SELECT COUNT(*) FROM banners WHERE ativo = true) as banners_ativos,
          (SELECT COUNT(*) FROM filmes WHERE ativo = true) as filmes_ativos,
          (SELECT COUNT(*) FROM seguidores) as total_seguidores,
          (SELECT COUNT(*) FROM avaliacoes WHERE created_at >= CURRENT_DATE - INTERVAL '7 days') as avaliacoes_recentes,
          (SELECT COUNT(*) FROM produtos WHERE vip = true) as produtos_vip,
          (SELECT COUNT(*) FROM produtos WHERE destaque = true) as produtos_destaque,
          (SELECT COUNT(*) FROM planos_vendedor) as total_planos,
          (SELECT COUNT(*) FROM usuarios WHERE tipo = 'vendedor' AND plano_id IS NOT NULL) as vendedores_com_plano,
          (SELECT COUNT(*) FROM jogos WHERE ativo = true) as total_jogos
      `),
      db.query(`
        SELECT u.*, COUNT(p.id) as total_produtos, pv.nome as plano_nome
        FROM usuarios u
        LEFT JOIN produtos p ON u.id = p.vendedor_id
        LEFT JOIN planos_vendedor pv ON u.plano_id = pv.id
        WHERE u.tipo = 'vendedor'
        GROUP BY u.id, pv.nome
        ORDER BY u.created_at DESC
        LIMIT 5
      `),
      db.query(`
        SELECT p.*, u.nome_loja
        FROM produtos p
        JOIN usuarios u ON p.vendedor_id = u.id
        ORDER BY p.created_at DESC
        LIMIT 5
      `),
      db.query(`
        SELECT COUNT(*) as total 
        FROM solicitacoes_vip 
        WHERE status = 'pendente'
      `),
      db.query(`
        SELECT pv.nome, COUNT(u.id) as total_vendedores
        FROM planos_vendedor pv
        LEFT JOIN usuarios u ON pv.id = u.plano_id AND u.tipo = 'vendedor'
        GROUP BY pv.id, pv.nome
        ORDER BY pv.limite_produtos
      `)
    ]);

    res.render('admin/dashboard', {
      stats: stats.rows[0],
      vendedoresRecentes: vendedoresRecentes.rows,
      produtosRecentes: produtosRecentes.rows,
      solicitacoesPendentes: solicitacoesPendentes.rows[0].total,
      planosStats: planosStats.rows,
      title: 'Painel Administrativo - KuandaShop'
    });
  } catch (error) {
    console.error('Erro no dashboard admin:', error);
    res.render('admin/dashboard', { 
      stats: {},
      vendedoresRecentes: [],
      produtosRecentes: [],
      solicitacoesPendentes: 0,
      planosStats: [],
      title: 'Painel Administrativo'
    });
  }
});

// CORREÇÃO DA ROTA ADMIN/VENDEDORES
app.get('/admin/vendedores', requireAdmin, async (req, res) => {
  try {
    const vendedores = await db.query(`
      SELECT u.*, 
             COUNT(p.id) as total_produtos,
             COALESCE(AVG(a.classificacao), 0) as media_classificacao,
             COUNT(DISTINCT s.id) as total_seguidores,
             pv.nome as plano_nome,
             pv.limite_produtos as plano_limite,
             pv.preco_mensal,
             pv.permite_vip,
             pv.permite_destaque
      FROM usuarios u
      LEFT JOIN produtos p ON u.id = p.vendedor_id
      LEFT JOIN avaliacoes a ON p.id = a.produto_id
      LEFT JOIN seguidores s ON u.id = s.loja_id
      LEFT JOIN planos_vendedor pv ON u.plano_id = pv.id
      WHERE u.tipo = 'vendedor'
      GROUP BY u.id, pv.nome, pv.limite_produtos, pv.preco_mensal, pv.permite_vip, pv.permite_destaque
      ORDER BY u.created_at DESC
    `);

    const planos = await db.query(`
      SELECT * FROM planos_vendedor ORDER BY limite_produtos
    `);

    // CORREÇÃO: Passar vendedores como 'vendedores' e não 'vendedor'
    res.render('admin/vendedores', {
      vendedores: vendedores.rows,  // CORRIGIDO: de 'vendedor' para 'vendedores'
      planos: planos.rows,
      title: 'Gerenciar Vendedores - KuandaShop'
    });
  } catch (error) {
    console.error('Erro ao carregar vendedores:', error);
    res.render('admin/vendedores', { 
      vendedores: [],
      planos: [],
      title: 'Gerenciar Vendedores'
    });
  }
});

// ROTA CORRIGIDA: Atualizar limite de produtos
app.post('/admin/vendedor/:id/atualizar-limite', requireAdmin, async (req, res) => {
  try {
    const { limite_produtos } = req.body;
    
    if (!limite_produtos || isNaN(limite_produtos) || parseInt(limite_produtos) < 1) {
      req.flash('error', 'Limite deve ser um número positivo');
      return res.redirect('/admin/vendedores');
    }
    
    await db.query(
      'UPDATE usuarios SET limite_produtos = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [parseInt(limite_produtos), req.params.id]
    );
    
    req.flash('success', 'Limite de produtos atualizado com sucesso!');
    res.redirect('/admin/vendedores');
  } catch (error) {
    console.error('Erro ao atualizar limite:', error);
    req.flash('error', 'Erro ao atualizar limite');
    res.redirect('/admin/vendedores');
  }
});

app.post('/admin/vendedor/:id/toggle-loja', requireAdmin, async (req, res) => {
  try {
    const vendedor = await db.query(
      'SELECT loja_ativa FROM usuarios WHERE id = $1 AND tipo = $2',
      [req.params.id, 'vendedor']
    );
    
    if (vendedor.rows.length === 0) {
      req.flash('error', 'Vendedor não encontrado');
      return res.redirect('/admin/vendedores');
    }
    
    const novoStatus = !vendedor.rows[0].loja_ativa;

    await db.query(
      'UPDATE usuarios SET loja_ativa = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [novoStatus, req.params.id]
    );

    req.flash('success', `Loja ${novoStatus ? 'ativada' : 'desativada'} com sucesso!`);
    res.redirect('/admin/vendedores');
  } catch (error) {
    console.error('Erro ao alterar status da loja:', error);
    req.flash('error', 'Erro ao alterar status da loja');
    res.redirect('/admin/vendedores');
  }
});

// ==================== GERENCIAMENTO DE PLANOS ====================
app.get('/admin/planos', requireAdmin, async (req, res) => {
  try {
    // Buscar planos com contagem de vendedores
    const planos = await db.query(`
      SELECT pv.*, 
             COUNT(u.id) as total_vendedores
      FROM planos_vendedor pv
      LEFT JOIN usuarios u ON pv.id = u.plano_id AND u.tipo = 'vendedor'
      GROUP BY pv.id
      ORDER BY pv.limite_produtos
    `);

    // Buscar vendedores agrupados por plano
    const vendedoresPorPlano = await db.query(`
      SELECT 
        pv.nome as plano_nome,
        pv.id as plano_id,
        json_agg(
          json_build_object(
            'id', u.id,
            'nome', u.nome,
            'nome_loja', u.nome_loja,
            'email', u.email,
            'telefone', u.telefone,
            'foto_perfil', u.foto_perfil,
            'loja_ativa', u.loja_ativa,
            'created_at', u.created_at,
            'plano_id', u.plano_id,
            'limite_produtos', u.limite_produtos,
            'total_produtos', (SELECT COUNT(*) FROM produtos p WHERE p.vendedor_id = u.id)
          )
        ) as vendedores
      FROM planos_vendedor pv
      LEFT JOIN usuarios u ON pv.id = u.plano_id AND u.tipo = 'vendedor'
      WHERE u.id IS NOT NULL
      GROUP BY pv.id, pv.nome
      ORDER BY pv.limite_produtos
    `);

    // Buscar vendedores sem plano
    const vendedoresSemPlano = await db.query(`
      SELECT 
        u.*,
        (SELECT COUNT(*) FROM produtos p WHERE p.vendedor_id = u.id) as total_produtos
      FROM usuarios u
      WHERE u.tipo = 'vendedor' 
        AND (u.plano_id IS NULL OR u.plano_id = 0)
      ORDER BY u.created_at DESC
    `);

    // Estatísticas
    const statsResult = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM usuarios WHERE tipo = 'vendedor' AND loja_ativa = true) as vendedores_ativos,
        (SELECT COUNT(*) FROM usuarios WHERE tipo = 'vendedor' AND plano_id IS NOT NULL AND plano_id != 0) as vendedores_com_plano,
        (SELECT COUNT(*) FROM usuarios WHERE tipo = 'vendedor' AND (plano_id IS NULL OR plano_id = 0)) as vendedores_sem_plano,
        (SELECT COUNT(*) FROM planos_vendedor) as total_planos
    `);

    // Garantir que stats sempre tenha valores
    const stats = statsResult.rows[0] || {
      vendedores_ativos: 0,
      vendedores_com_plano: 0,
      vendedores_sem_plano: vendedoresSemPlano.rows.length,
      total_planos: planos.rows.length
    };

    res.render('admin/planos', {
      planos: planos.rows,
      vendedoresPorPlano: vendedoresPorPlano.rows,
      vendedoresSemPlano: vendedoresSemPlano.rows,
      stats: stats,
      title: 'Gerenciar Planos - KuandaShop'
    });
  } catch (error) {
    console.error('Erro ao carregar planos:', error);
    
    // Dados padrão em caso de erro
    res.render('admin/planos', { 
      planos: [],
      vendedoresPorPlano: [],
      vendedoresSemPlano: [],
      stats: {
        vendedores_ativos: 0,
        vendedores_com_plano: 0,
        vendedores_sem_plano: 0,
        total_planos: 0
      },
      title: 'Gerenciar Planos de Vendedores'
    });
  }
});

app.get('/admin/planos/novo', requireAdmin, (req, res) => {
  res.render('admin/plano-form', {
    plano: null,
    action: '/admin/planos',
    title: 'Novo Plano - KuandaShop'
  });
});

app.post('/admin/planos', requireAdmin, async (req, res) => {
  const { nome, limite_produtos, preco_mensal, permite_vip, permite_destaque } = req.body;
  
  try {
    if (!nome || nome.trim().length < 2) {
      req.flash('error', 'Nome do plano deve ter pelo menos 2 caracteres');
      return res.redirect('/admin/planos/novo');
    }

    if (!limite_produtos || isNaN(limite_produtos) || parseInt(limite_produtos) < 1) {
      req.flash('error', 'Limite de produtos deve ser um número positivo');
      return res.redirect('/admin/planos/novo');
    }

    await db.query(`
      INSERT INTO planos_vendedor (nome, limite_produtos, preco_mensal, permite_vip, permite_destaque, created_at)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
    `, [
      nome.trim(),
      parseInt(limite_produtos),
      preco_mensal ? parseFloat(preco_mensal) : null,
      permite_vip === 'on',
      permite_destaque === 'on'
    ]);
    
    req.flash('success', 'Plano criado com sucesso!');
    res.redirect('/admin/planos');
  } catch (error) {
    console.error('Erro ao criar plano:', error);
    req.flash('error', 'Erro ao criar plano');
    res.redirect('/admin/planos/novo');
  }
});

app.get('/admin/planos/:id/editar', requireAdmin, async (req, res) => {
  try {
    const plano = await db.query('SELECT * FROM planos_vendedor WHERE id = $1', [req.params.id]);
    
    if (plano.rows.length === 0) {
      req.flash('error', 'Plano não encontrado');
      return res.redirect('/admin/planos');
    }
    
    res.render('admin/plano-form', {
      plano: plano.rows[0],
      action: `/admin/planos/${req.params.id}?_method=PUT`,
      title: 'Editar Plano - KuandaShop'
    });
  } catch (error) {
    console.error('Erro ao carregar plano:', error);
    req.flash('error', 'Erro ao carregar plano');
    res.redirect('/admin/planos');
  }
});

app.put('/admin/planos/:id', requireAdmin, async (req, res) => {
  const { nome, limite_produtos, preco_mensal, permite_vip, permite_destaque } = req.body;
  
  try {
    if (!nome || nome.trim().length < 2) {
      req.flash('error', 'Nome do plano deve ter pelo menos 2 caracteres');
      return res.redirect(`/admin/planos/${req.params.id}/editar`);
    }

    if (!limite_produtos || isNaN(limite_produtos) || parseInt(limite_produtos) < 1) {
      req.flash('error', 'Limite de produtos deve ser um número positivo');
      return res.redirect(`/admin/planos/${req.params.id}/editar`);
    }

    await db.query(`
      UPDATE planos_vendedor 
      SET nome = $1, limite_produtos = $2, preco_mensal = $3, 
          permite_vip = $4, permite_destaque = $5
      WHERE id = $6
    `, [
      nome.trim(),
      parseInt(limite_produtos),
      preco_mensal ? parseFloat(preco_mensal) : null,
      permite_vip === 'on',
      permite_destaque === 'on',
      req.params.id
    ]);
    
    req.flash('success', 'Plano atualizado com sucesso!');
    res.redirect('/admin/planos');
  } catch (error) {
    console.error('Erro ao atualizar plano:', error);
    req.flash('error', 'Erro ao atualizar plano');
    res.redirect(`/admin/planos/${req.params.id}/editar`);
  }
});

app.delete('/admin/planos/:id', requireAdmin, async (req, res) => {
  try {
    // Verificar se há vendedores usando este plano
    const vendedores = await db.query(
      'SELECT COUNT(*) as total FROM usuarios WHERE plano_id = $1 AND tipo = $2',
      [req.params.id, 'vendedor']
    );
    
    if (parseInt(vendedores.rows[0].total) > 0) {
      req.flash('error', 'Não é possível remover um plano que está sendo usado por vendedores. Transfira os vendedores para outro plano primeiro.');
      return res.redirect('/admin/planos');
    }
    
    await db.query('DELETE FROM planos_vendedor WHERE id = $1', [req.params.id]);
    
    req.flash('success', 'Plano removido com sucesso!');
    res.redirect('/admin/planos');
  } catch (error) {
    console.error('Erro ao remover plano:', error);
    req.flash('error', 'Erro ao remover plano');
    res.redirect('/admin/planos');
  }
});

// ==================== ROTAS PARA ATRIBUIR/MUDAR PLANOS DE VENDEDORES ====================

// Rota para atribuir plano a um vendedor específico
app.post('/admin/vendedor/atribuir-plano', requireAdmin, async (req, res) => {
  const { vendedor_id, plano_id, limite_produtos } = req.body;
  
  try {
    // Validar dados
    if (!vendedor_id || !plano_id) {
      req.flash('error', 'Vendedor e plano são obrigatórios');
      return res.redirect('/admin/planos#sem-plano');
    }

    // Verificar se vendedor existe
    const vendedor = await db.query(
      'SELECT id FROM usuarios WHERE id = $1 AND tipo = $2',
      [vendedor_id, 'vendedor']
    );
    
    if (vendedor.rows.length === 0) {
      req.flash('error', 'Vendedor não encontrado');
      return res.redirect('/admin/planos#sem-plano');
    }

    // Verificar se plano existe
    const plano = await db.query(
      'SELECT * FROM planos_vendedor WHERE id = $1',
      [plano_id]
    );
    
    if (plano.rows.length === 0) {
      req.flash('error', 'Plano não encontrado');
      return res.redirect('/admin/planos#sem-plano');
    }

    // Se não especificou limite, usar o padrão do plano
    let limiteFinal = parseInt(limite_produtos) || plano.rows[0].limite_produtos;
    
    // Atualizar plano do vendedor
    await db.query(`
      UPDATE usuarios 
      SET plano_id = $1, limite_produtos = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
    `, [parseInt(plano_id), limiteFinal, vendedor_id]);

    req.flash('success', 'Plano atribuído com sucesso!');
    res.redirect('/admin/planos#sem-plano');
  } catch (error) {
    console.error('Erro ao atribuir plano:', error);
    req.flash('error', 'Erro ao atribuir plano: ' + error.message);
    res.redirect('/admin/planos#sem-plano');
  }
});

// Rota para mudar plano de um vendedor
app.post('/admin/vendedor/mudar-plano', requireAdmin, async (req, res) => {
  const { vendedor_id, novo_plano_id } = req.body;
  
  try {
    // Validar dados
    if (!vendedor_id || !novo_plano_id) {
      req.flash('error', 'Vendedor e novo plano são obrigatórios');
      return res.redirect('/admin/planos#vendedores');
    }

    // Verificar se vendedor existe
    const vendedor = await db.query(
      'SELECT * FROM usuarios WHERE id = $1 AND tipo = $2',
      [vendedor_id, 'vendedor']
    );
    
    if (vendedor.rows.length === 0) {
      req.flash('error', 'Vendedor não encontrado');
      return res.redirect('/admin/planos#vendedores');
    }

    // Verificar se novo plano existe
    const novoPlano = await db.query(
      'SELECT * FROM planos_vendedor WHERE id = $1',
      [novo_plano_id]
    );
    
    if (novoPlano.rows.length === 0) {
      req.flash('error', 'Novo plano não encontrado');
      return res.redirect('/admin/planos#vendedores');
    }

    // Verificar se vendedor já está no limite
    const produtosVendedor = await db.query(
      'SELECT COUNT(*) as total FROM produtos WHERE vendedor_id = $1',
      [vendedor_id]
    );
    
    const totalProdutos = parseInt(produtosVendedor.rows[0].total);
    const limiteNovo = novoPlano.rows[0].limite_produtos;
    
    if (totalProdutos > limiteNovo) {
      req.flash('warning', `Atenção: Vendedor tem ${totalProdutos} produtos, mas novo plano permite apenas ${limiteNovo}. Produtos acima do limite ficarão ocultos.`);
    }

    // Atualizar plano do vendedor
    await db.query(`
      UPDATE usuarios 
      SET plano_id = $1, limite_produtos = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
    `, [parseInt(novo_plano_id), limiteNovo, vendedor_id]);

    req.flash('success', 'Plano alterado com sucesso!');
    res.redirect('/admin/planos#vendedores');
  } catch (error) {
    console.error('Erro ao mudar plano:', error);
    req.flash('error', 'Erro ao mudar plano: ' + error.message);
    res.redirect('/admin/planos#vendedores');
  }
});

// Rota para atribuir plano massivo a todos vendedores sem plano
app.post('/admin/vendedor/atribuir-plano-massivo', requireAdmin, async (req, res) => {
  const { plano_id } = req.body;
  
  try {
    if (!plano_id) {
      req.flash('error', 'Plano é obrigatório');
      return res.redirect('/admin/planos#sem-plano');
    }

    // Verificar se plano existe
    const plano = await db.query(
      'SELECT * FROM planos_vendedor WHERE id = $1',
      [plano_id]
    );
    
    if (plano.rows.length === 0) {
      req.flash('error', 'Plano não encontrado');
      return res.redirect('/admin/planos#sem-plano');
    }

    const limite = plano.rows[0].limite_produtos;
    
    // Atribuir plano a todos vendedores sem plano
    const result = await db.query(`
      UPDATE usuarios 
      SET plano_id = $1, limite_produtos = $2, updated_at = CURRENT_TIMESTAMP
      WHERE tipo = 'vendedor' AND (plano_id IS NULL OR plano_id = 0)
      RETURNING id
    `, [parseInt(plano_id), limite]);
    
    const qtdAtualizados = result.rowCount || 0;

    req.flash('success', `Plano atribuído a ${qtdAtualizados} vendedores sem plano!`);
    res.redirect('/admin/planos#sem-plano');
  } catch (error) {
    console.error('Erro ao atribuir plano massivo:', error);
    req.flash('error', 'Erro ao atribuir plano massivo: ' + error.message);
    res.redirect('/admin/planos#sem-plano');
  }
});

// Rota para atualizar plano específico de um vendedor
app.post('/admin/vendedor/:id/atualizar-plano', requireAdmin, async (req, res) => {
  const { plano_id, limite_produtos } = req.body;
  
  try {
    // Buscar informações do plano selecionado
    let novoLimite = parseInt(limite_produtos) || 10;
    
    if (plano_id) {
      const plano = await db.query(
        'SELECT limite_produtos FROM planos_vendedor WHERE id = $1',
        [plano_id]
      );
      
      if (plano.rows.length > 0) {
        novoLimite = plano.rows[0].limite_produtos;
      }
    }
    
    await db.query(`
      UPDATE usuarios 
      SET plano_id = $1, limite_produtos = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $3 AND tipo = 'vendedor'
    `, [
      plano_id ? parseInt(plano_id) : null,
      novoLimite,
      req.params.id
    ]);
    
    req.flash('success', 'Plano e limite atualizados com sucesso!');
    res.redirect('/admin/vendedores');
  } catch (error) {
    console.error('Erro ao atualizar plano:', error);
    req.flash('error', 'Erro ao atualizar plano');
    res.redirect('/admin/vendedores');
  }
});

// Rota auxiliar para AJAX - obter informações do plano
app.get('/admin/plano-info/:id', requireAdmin, async (req, res) => {
  try {
    const plano = await db.query(
      'SELECT id, nome, limite_produtos FROM planos_vendedor WHERE id = $1',
      [req.params.id]
    );
    
    if (plano.rows.length > 0) {
      res.json({ 
        success: true, 
        nome: plano.rows[0].nome,
        limite: plano.rows[0].limite_produtos 
      });
    } else {
      res.json({ 
        success: false, 
        nome: 'Sem plano',
        limite: 10 
      });
    }
  } catch (error) {
    console.error('Erro ao buscar plano:', error);
    res.json({ 
      success: false, 
      nome: 'Erro', 
      limite: 10 
    });
  }
});

// ==================== ROTA DE CATEGORIAS ====================
app.get('/categorias', async (req, res) => {
  try {
    // Buscar tudo em paralelo para ser rápido
    const [categorias, banners, produtosDestaque, lojas] = await Promise.all([
      // 1. Todas as categorias
      db.query('SELECT * FROM categorias ORDER BY nome'),
      
      // 2. Banners ativos para o carrossel
      db.query('SELECT * FROM banners WHERE ativo = true ORDER BY ordem'),
      
      // 3. Produtos em Destaque (Aleatórios)
      db.query(`
        SELECT p.*, u.nome_loja, u.foto_perfil as loja_foto,
               COALESCE(AVG(a.classificacao), 0) as media_classificacao
        FROM produtos p 
        JOIN usuarios u ON p.vendedor_id = u.id 
        LEFT JOIN avaliacoes a ON p.id = a.produto_id
        WHERE p.ativo = true AND p.destaque = true AND u.loja_ativa = true
        GROUP BY p.id, u.nome_loja, u.foto_perfil
        ORDER BY RANDOM() 
        LIMIT 8
      `),
      
      // 4. Lojas Parceiras (Aleatórias)
      db.query(`
        SELECT u.*, COUNT(p.id) as total_produtos
        FROM usuarios u
        LEFT JOIN produtos p ON u.id = p.vendedor_id
        WHERE u.tipo = 'vendedor' AND u.loja_ativa = true
        GROUP BY u.id
        ORDER BY RANDOM()
        LIMIT 6
      `)
    ]);

    // Corrigir caminho das imagens dos banners
    const bannersCorrigidos = banners.rows.map(b => ({
      ...b,
      imagem: `/uploads/banners/${b.imagem}`
    }));

    // Renderizar a página com todos os dados
    res.render('categorias', {
      title: 'Categorias - KuandaShop',
      categorias: categorias.rows,
      banners: bannersCorrigidos,
      produtosDestaque: produtosDestaque.rows,
      lojas: lojas.rows
    });

  } catch (error) {
    console.error('Erro ao carregar página de categorias:', error);
    // Em caso de erro, renderiza a página vazia para não travar (Erro 500)
    res.render('categorias', {
      title: 'Categorias',
      categorias: [],
      banners: [],
      produtosDestaque: [],
      lojas: []
    });
  }
});

// ==================== ROTA DE OFERTAS ====================
app.get('/ofertas', async (req, res) => {
  console.log('🔄 Iniciando rota /ofertas...'); // Log para confirmar que a rota foi chamada

  try {
    // 1. Verificar conexão com banco
    if (!db) throw new Error('Conexão com banco de dados não estabelecida.');

    // 2. Query de Produtos em Oferta
    // Simplifiquei o GROUP BY para evitar erros estritos do PostgreSQL
    const queryOfertas = `
      SELECT p.id, p.nome, p.preco, p.preco_promocional, p.imagem1, p.estoque, p.vip,
             u.nome_loja, u.foto_perfil as loja_foto,
             c.nome as categoria_nome,
             c.id as categoria_id,
             COALESCE(AVG(a.classificacao), 0) as media_classificacao,
             COUNT(a.id) as total_avaliacoes
      FROM produtos p 
      JOIN usuarios u ON p.vendedor_id = u.id 
      LEFT JOIN categorias c ON p.categoria_id = c.id
      LEFT JOIN avaliacoes a ON p.id = a.produto_id
      WHERE p.ativo = true 
        AND u.loja_ativa = true 
        AND p.preco_promocional IS NOT NULL 
        AND p.preco_promocional > 0
        AND p.preco_promocional < p.preco
      GROUP BY p.id, u.nome_loja, u.foto_perfil, c.nome, c.id
      ORDER BY p.created_at DESC
    `;

    // 3. Query de Categorias (Apenas as que tem ofertas)
    const queryCategorias = `
      SELECT DISTINCT c.id, c.nome 
      FROM categorias c
      JOIN produtos p ON c.id = p.categoria_id
      WHERE p.preco_promocional > 0 AND p.ativo = true
      ORDER BY c.nome
    `;

    console.log('📊 Buscando dados no banco...');
    
    const [ofertasResult, categoriasResult] = await Promise.all([
      db.query(queryOfertas),
      db.query(queryCategorias)
    ]);

    console.log(`✅ Sucesso! ${ofertasResult.rows.length} ofertas encontradas.`);

    // 4. Renderização Segura
    // Passamos explicitamente user, carrinho e messages para evitar erros no layout
    res.render('ofertas', {
      title: 'Ofertas Relâmpago | KuandaShop',
      produtos: ofertasResult.rows,
      categorias: categoriasResult.rows,
      user: req.session.user || null,
      carrinho: req.session.carrinho || [],
      messages: req.flash() // Garante que o toast não quebre
    });

  } catch (error) {
    console.error('❌ ERRO CRÍTICO NA ROTA /OFERTAS:', error);
    console.error(error.stack); // Mostra a linha exata do erro

    // Em vez de tela branca, renderiza a página de erro 500 bonita
    res.status(500).render('500', {
      layout: false, // Não usa o layout padrão para evitar loops de erro
      error: error,
      title: 'Erro ao carregar ofertas'
    });
  }
});

// ==================== GERENCIAMENTO DE SOLICITAÇÕES VIP ====================
app.get('/admin/solicitacoes-vip', requireAdmin, async (req, res) => {
  try {
    const solicitacoes = await db.query(`
      SELECT sv.*, p.nome as produto_nome, p.imagem1, u.nome as vendedor_nome, u.telefone, u.email, u.nome_loja
      FROM solicitacoes_vip sv
      JOIN produtos p ON sv.produto_id = p.id
      JOIN usuarios u ON sv.vendedor_id = u.id
      WHERE sv.status = 'pendente'
      ORDER BY sv.created_at DESC
    `);

    res.render('admin/solicitacoes-vip', {
      solicitacoes: solicitacoes.rows,
      title: 'Solicitações VIP - KuandaShop'
    });
  } catch (error) {
    console.error('Erro ao carregar solicitações VIP:', error);
    res.render('admin/solicitacoes-vip', { 
      solicitacoes: [],
      title: 'Solicitações VIP'
    });
  }
});

app.post('/admin/solicitacao-vip/:id/aprovar', requireAdmin, async (req, res) => {
  try {
    const solicitacao = await db.query(`
      SELECT sv.*, p.nome as produto_nome, u.nome as vendedor_nome
      FROM solicitacoes_vip sv
      JOIN produtos p ON sv.produto_id = p.id
      JOIN usuarios u ON sv.vendedor_id = u.id
      WHERE sv.id = $1
    `, [req.params.id]);
    
    if (solicitacao.rows.length === 0) {
      req.flash('error', 'Solicitação não encontrada');
      return res.redirect('/admin/solicitacoes-vip');
    }

    const sol = solicitacao.rows[0];

    // Atualizar produto para VIP
    await db.query(
      'UPDATE produtos SET vip = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [sol.produto_id]
    );
    
    // Atualizar status da solicitação
    await db.query(
      'UPDATE solicitacoes_vip SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['aprovada', req.params.id]
    );

    req.flash('success', `Solicitação aprovada! Produto "${sol.produto_nome}" agora é VIP.`);
    res.redirect('/admin/solicitacoes-vip');
  } catch (error) {
    console.error('Erro ao aprovar solicitação:', error);
    req.flash('error', 'Erro ao aprovar solicitação');
    res.redirect('/admin/solicitacoes-vip');
  }
});

app.post('/admin/solicitacao-vip/:id/rejeitar', requireAdmin, async (req, res) => {
  try {
    const { motivo } = req.body;
    
    if (!motivo || motivo.trim().length < 5) {
      req.flash('error', 'É necessário fornecer um motivo para rejeição (mínimo 5 caracteres)');
      return res.redirect('/admin/solicitacoes-vip');
    }
    
    await db.query(`
      UPDATE solicitacoes_vip 
      SET status = $1, motivo_rejeicao = $2, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $3
    `, ['rejeitada', motivo.trim(), req.params.id]);

    req.flash('success', 'Solicitação rejeitada.');
    res.redirect('/admin/solicitacoes-vip');
  } catch (error) {
    console.error('Erro ao rejeitar solicitação:', error);
    req.flash('error', 'Erro ao rejeitar solicitação');
    res.redirect('/admin/solicitacoes-vip');
  }
});

// ==================== GERENCIAMENTO DE BANNERS ====================
app.get('/admin/banners', requireAdmin, async (req, res) => {
  try {
    const banners = await db.query(`
      SELECT * FROM banners 
      ORDER BY ordem, created_at DESC
    `);
    
    res.render('admin/banners', {
      banners: banners.rows,
      title: 'Gerenciar Banners - KuandaShop'
    });
  } catch (error) {
    console.error('Erro ao carregar banners:', error);
    req.flash('error', 'Erro ao carregar banners');
    res.render('admin/banners', {
      banners: [],
      title: 'Gerenciar Banners'
    });
  }
});

app.get('/admin/banners/novo', requireAdmin, (req, res) => {
  res.render('admin/banner-form', {
    banner: null,
    action: '/admin/banners',
    title: 'Novo Banner - KuandaShop'
  });
});

// ====================== CRIAR BANNER ======================
app.post('/admin/banners', requireAdmin, upload.single('imagem'), async (req, res) => {
  const { titulo, link, ordem, ativo } = req.body;

  try {
    if (!req.file) {
      req.flash('error', 'É necessário enviar uma imagem para o banner');
      return res.redirect('/admin/banners/novo');
    }

    const result = await db.query(`
      INSERT INTO banners (titulo, imagem, link, ordem, ativo, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING id
    `, [
      titulo ? titulo.trim() : null,
      req.file.filename,
      link ? link.trim() : null,
      ordem ? parseInt(ordem) : 0,
      ativo === 'on'
    ]);

    const bannerId = result.rows[0].id;

    // SALVAR BACKUP BYTEA DA IMAGEM DO BANNER
    const filePath = path.join('public/uploads/banners/', req.file.filename);
    await salvarBackupImagem(filePath, req.file.filename, 'banners', bannerId);

    req.flash('success', 'Banner criado com sucesso!');
    res.redirect('/admin/banners');
  } catch (error) {
    console.error('Erro ao criar banner:', error);

    if (req.file) {
      const filePath = path.join('public/uploads/banners/', req.file.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    req.flash('error', 'Erro ao criar banner');
    res.redirect('/admin/banners/novo');
  }
});

// ====================== EDITAR BANNER ======================
app.get('/admin/banners/:id/editar', requireAdmin, async (req, res) => {
  try {
    const banner = await db.query('SELECT * FROM banners WHERE id = $1', [req.params.id]);

    if (banner.rows.length === 0) {
      req.flash('error', 'Banner não encontrado');
      return res.redirect('/admin/banners');
    }

    res.render('admin/banner-form', {
      banner: banner.rows[0],
      action: `/admin/banners/${req.params.id}?_method=PUT`,
      title: 'Editar Banner - KuandaShop'
    });
  } catch (error) {
    console.error('Erro ao carregar banner:', error);
    req.flash('error', 'Erro ao carregar banner');
    res.redirect('/admin/banners');
  }
});

// ====================== ATUALIZAR BANNER ======================
app.put('/admin/banners/:id', requireAdmin, upload.single('imagem'), async (req, res) => {
  const { titulo, link, ordem, ativo } = req.body;

  try {
    // Busca o banner existente
    const result = await db.query('SELECT * FROM banners WHERE id = $1', [req.params.id]);
    const banner = result.rows[0];

    if (!banner) {
      req.flash('error', 'Banner não encontrado');
      return res.redirect('/admin/banners');
    }

    let imagemBuffer = banner.imagem; // Mantém o buffer antigo se não houver novo upload

    // Se houver novo upload, substitui o buffer
    if (req.file) {
      imagemBuffer = req.file.buffer;
    }

    // Atualiza o registro no banco
    await db.query(`
      UPDATE banners
      SET titulo=$1,
          imagem=$2,
          link=$3,
          ordem=$4,
          ativo=$5,
          updated_at=CURRENT_TIMESTAMP
      WHERE id=$6
    `, [
      titulo ? titulo.trim() : null,
      imagemBuffer,
      link ? link.trim() : null,
      ordem ? parseInt(ordem) : 0,
      ativo === 'on',
      req.params.id
    ]);

    req.flash('success', 'Banner atualizado com sucesso!');
    res.redirect('/admin/banners');

  } catch (error) {
    console.error('Erro ao atualizar banner:', error);
    req.flash('error', 'Erro ao atualizar banner');
    res.redirect(`/admin/banners/${req.params.id}/editar`);
  }
});

// ====================== EXCLUIR BANNER ======================
app.delete('/admin/banners/:id', requireAdmin, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM banners WHERE id = $1', [req.params.id]);
    const banner = result.rows[0];

    if (!banner) {
      req.flash('error', 'Banner não encontrado');
      return res.redirect('/admin/banners');
    }

    // Apenas remove do banco, não precisa tocar em disco
    await db.query('DELETE FROM banners WHERE id = $1', [req.params.id]);

    req.flash('success', 'Banner excluído com sucesso!');
    res.redirect('/admin/banners');

  } catch (error) {
    console.error('Erro ao excluir banner:', error);
    req.flash('error', 'Erro ao excluir banner');
    res.redirect('/admin/banners');
  }
});

// ====================== SERVIR IMAGEM DO BANCO ======================
app.get('/banners/:id/image', async (req, res) => {
  try {
    const result = await db.query('SELECT imagem FROM banners WHERE id = $1', [req.params.id]);
    if (!result.rows[0] || !result.rows[0].imagem) {
      return res.status(404).send('Imagem não encontrada');
    }

    const img = result.rows[0].imagem;
    res.setHeader('Content-Type', 'image/jpeg'); // ou 'image/png' dependendo do formato
    res.send(img);
  } catch (err) {
    console.error('Erro ao carregar imagem:', err);
    res.status(500).send('Erro ao carregar imagem');
  }
});

// ====================== ALTERAR STATUS ======================
app.post('/admin/banners/:id/toggle-status', requireAdmin, async (req, res) => {
  try {
    const banner = await db.query('SELECT ativo FROM banners WHERE id = $1', [req.params.id]);

    if (banner.rows.length === 0) {
      return res.json({ success: false, message: 'Banner não encontrado' });
    }

    const novoStatus = !banner.rows[0].ativo;

    await db.query(
      'UPDATE banners SET ativo=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2',
      [novoStatus, req.params.id]
    );

    res.json({ success: true, message: `Banner ${novoStatus ? 'ativado' : 'desativado'} com sucesso!`, novoStatus });
  } catch (error) {
    console.error('Erro ao alterar status:', error);
    res.json({ success: false, message: 'Erro ao alterar status' });
  }
});

// =======================================================
// CONFIGURAÇÃO DO UPLOAD (Multer)
// =======================================================
const uploadFilmes = upload.fields([
    { name: 'poster', maxCount: 1 },
    { name: 'banner', maxCount: 1 }
]);

// =======================================================
// ROTAS ADMIN: GERENCIAMENTO DE FILMES
// =======================================================

// 1. LISTAR FILMES
app.get('/admin/filmes', requireAdmin, async (req, res) => {
    try {
        const filmes = await db.query(`
            SELECT * FROM filmes 
            ORDER BY data_lancamento DESC, created_at DESC
        `);
        
        res.render('admin/filmes', {
            filmes: filmes.rows,
            title: 'Gerenciar Filmes - KuandaShop'
        });
    } catch (error) {
        console.error('Erro ao carregar filmes:', error);
        req.flash('error', 'Erro ao carregar filmes');
        res.render('admin/filmes', { filmes: [], title: 'Gerenciar Filmes' });
    }
});

// 2. FORMULÁRIO NOVO
app.get('/admin/filmes/novo', requireAdmin, (req, res) => {
    res.render('admin/filme-form', {
        filme: null,
        links: [], // Passa array vazio para não quebrar o loop no EJS
        action: '/admin/filmes',
        title: 'Novo Filme - KuandaShop'
    });
});

// 3. SALVAR (POST)
app.post('/admin/filmes', requireAdmin, uploadFilmes, async (req, res) => {
    // Extrai campos do corpo
    const { titulo, sinopse, trailer_url, data_lancamento, classificacao, ativo, preco, tipo, labels, urls } = req.body;

    try {
        // Validação do Pôster (Obrigatório)
        if (!req.files || !req.files['poster']) {
            req.flash('error', 'É necessário enviar um pôster para o filme.');
            return res.redirect('/admin/filmes/novo');
        }

        const posterFilename = req.files['poster'][0].filename;
        const bannerFilename = req.files['banner'] ? req.files['banner'][0].filename : null;

        // Inserir Filme
        const result = await db.query(`
            INSERT INTO filmes (titulo, poster, banner, sinopse, trailer_url, data_lancamento, classificacao, ativo, preco, tipo)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id
        `, [
            titulo.trim(),
            posterFilename,
            bannerFilename,
            sinopse ? sinopse.trim() : null,
            trailer_url ? trailer_url.trim() : null,
            data_lancamento,
            classificacao ? classificacao.trim() : null,
            ativo === 'on',
            parseFloat(preco) || 0,
            tipo
        ]);

        const filmeId = result.rows[0].id;

        // Inserir Links (Se houver)
        if (labels && urls) {
            const labelsArray = Array.isArray(labels) ? labels : [labels];
            const urlsArray = Array.isArray(urls) ? urls : [urls];

            for (let i = 0; i < urlsArray.length; i++) {
                if (urlsArray[i].trim() !== '') {
                    await db.query(
                        'INSERT INTO filme_links (filme_id, label, url, ordem) VALUES ($1, $2, $3, $4)',
                        [filmeId, labelsArray[i], urlsArray[i], i]
                    );
                }
            }
        }

        // BACKUP DE IMAGENS (Poster e Banner)
        const posterPath = path.join('public/uploads/filmes/', posterFilename);
        await salvarBackupImagem(posterPath, posterFilename, 'filmes', filmeId);

        if (bannerFilename) {
            const bannerPath = path.join('public/uploads/filmes/', bannerFilename);
            await salvarBackupImagem(bannerPath, bannerFilename, 'filmes', filmeId);
        }

        req.flash('success', 'Filme adicionado com sucesso!');
        res.redirect('/admin/filmes');

    } catch (error) {
        console.error('Erro ao criar filme:', error);
        
        // Limpeza de arquivos enviados em caso de erro no banco
        if (req.files) {
            if (req.files['poster']) fs.unlinkSync(path.join('public/uploads/filmes/', req.files['poster'][0].filename));
            if (req.files['banner']) fs.unlinkSync(path.join('public/uploads/filmes/', req.files['banner'][0].filename));
        }

        req.flash('error', 'Erro ao criar filme: ' + error.message);
        res.redirect('/admin/filmes/novo');
    }
});

// 4. FORMULÁRIO EDITAR
app.get('/admin/filmes/:id/editar', requireAdmin, async (req, res) => {
    try {
        const filme = await db.query('SELECT * FROM filmes WHERE id = $1', [req.params.id]);
        
        if (filme.rows.length === 0) {
            req.flash('error', 'Filme não encontrado');
            return res.redirect('/admin/filmes');
        }

        // Buscar links existentes
        const links = await db.query('SELECT * FROM filme_links WHERE filme_id = $1 ORDER BY ordem', [req.params.id]);
        
        res.render('admin/filme-form', {
            filme: filme.rows[0],
            links: links.rows,
            action: `/admin/filmes/${req.params.id}?_method=PUT`,
            title: 'Editar Filme - KuandaShop'
        });
    } catch (error) {
        console.error('Erro ao carregar filme:', error);
        req.flash('error', 'Erro ao carregar dados do filme');
        res.redirect('/admin/filmes');
    }
});

// 5. ATUALIZAR (PUT)
app.put('/admin/filmes/:id', requireAdmin, uploadFilmes, async (req, res) => {
    const { titulo, sinopse, trailer_url, data_lancamento, classificacao, ativo, preco, tipo, labels, urls } = req.body;

    try {
        // Buscar dados atuais para manter imagens antigas se não houver novas
        const filmeAtual = await db.query('SELECT poster, banner FROM filmes WHERE id = $1', [req.params.id]);
        if (filmeAtual.rows.length === 0) {
            req.flash('error', 'Filme não encontrado');
            return res.redirect('/admin/filmes');
        }

        let poster = filmeAtual.rows[0].poster;
        let banner = filmeAtual.rows[0].banner;

        // Processar POSTER (se enviado novo)
        if (req.files['poster']) {
            if (poster) {
                const oldPath = path.join('public/uploads/filmes/', poster);
                if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
            }
            poster = req.files['poster'][0].filename;
            // Backup do novo
            await salvarBackupImagem(req.files['poster'][0].path, poster, 'filmes', req.params.id);
        }

        // Processar BANNER (se enviado novo)
        if (req.files['banner']) {
            if (banner) {
                const oldPath = path.join('public/uploads/filmes/', banner);
                if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
            }
            banner = req.files['banner'][0].filename;
            // Backup do novo
            await salvarBackupImagem(req.files['banner'][0].path, banner, 'filmes', req.params.id);
        }

        // Atualizar Tabela Filmes
        await db.query(`
            UPDATE filmes SET 
            titulo=$1, poster=$2, banner=$3, sinopse=$4, trailer_url=$5, 
            data_lancamento=$6, classificacao=$7, ativo=$8, preco=$9, tipo=$10, updated_at=CURRENT_TIMESTAMP
            WHERE id=$11
        `, [
            titulo.trim(), poster, banner, sinopse ? sinopse.trim() : null, trailer_url ? trailer_url.trim() : null, 
            data_lancamento, classificacao ? classificacao.trim() : null, ativo === 'on', 
            parseFloat(preco) || 0, tipo, req.params.id
        ]);

        // Atualizar Links (Remove todos antigos e recria)
        await db.query('DELETE FROM filme_links WHERE filme_id = $1', [req.params.id]);
        
        if (labels && urls) {
            const labelsArray = Array.isArray(labels) ? labels : [labels];
            const urlsArray = Array.isArray(urls) ? urls : [urls];

            for (let i = 0; i < urlsArray.length; i++) {
                if (urlsArray[i].trim() !== '') {
                    await db.query(
                        'INSERT INTO filme_links (filme_id, label, url, ordem) VALUES ($1, $2, $3, $4)',
                        [req.params.id, labelsArray[i], urlsArray[i], i]
                    );
                }
            }
        }

        req.flash('success', 'Filme atualizado com sucesso!');
        res.redirect('/admin/filmes');

    } catch (error) {
        console.error('Erro ao atualizar filme:', error);
        req.flash('error', 'Erro ao atualizar filme');
        res.redirect(`/admin/filmes/${req.params.id}/editar`);
    }
});

// 6. EXCLUIR (DELETE)
app.delete('/admin/filmes/:id', requireAdmin, async (req, res) => {
    try {
        const filme = await db.query('SELECT * FROM filmes WHERE id = $1', [req.params.id]);
        
        if (filme.rows.length === 0) {
            req.flash('error', 'Filme não encontrado');
            return res.redirect('/admin/filmes');
        }
        
        // Deletar arquivos físicos
        if (filme.rows[0].poster) {
            const posterPath = path.join('public/uploads/filmes/', filme.rows[0].poster);
            if (fs.existsSync(posterPath)) fs.unlinkSync(posterPath);
        }
        if (filme.rows[0].banner) {
            const bannerPath = path.join('public/uploads/filmes/', filme.rows[0].banner);
            if (fs.existsSync(bannerPath)) fs.unlinkSync(bannerPath);
        }
        
        // Deletar do banco (Links são deletados em cascata se configurado, ou deletamos manual)
        await db.query('DELETE FROM filme_links WHERE filme_id = $1', [req.params.id]);
        await db.query('DELETE FROM filmes WHERE id = $1', [req.params.id]);
        
        req.flash('success', 'Filme excluído com sucesso!');
        res.redirect('/admin/filmes');
    } catch (error) {
        console.error('Erro ao excluir filme:', error);
        req.flash('error', 'Erro ao excluir filme');
        res.redirect('/admin/filmes');
    }
});

// 7. TOGGLE STATUS (AJAX)
app.post('/admin/filmes/:id/toggle-status', requireAdmin, async (req, res) => {
    try {
        const filme = await db.query('SELECT ativo FROM filmes WHERE id = $1', [req.params.id]);
        
        if (filme.rows.length === 0) {
            return res.json({ success: false, message: 'Filme não encontrado' });
        }
        
        const novoStatus = !filme.rows[0].ativo;
        
        await db.query(
            'UPDATE filmes SET ativo = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [novoStatus, req.params.id]
        );
        
        res.json({ 
            success: true, 
            message: `Filme ${novoStatus ? 'ativado' : 'desativado'} com sucesso!`,
            novoStatus 
        });
    } catch (error) {
        console.error('Erro ao alterar status:', error);
        res.json({ success: false, message: 'Erro ao alterar status' });
    }
});

// =======================================================
// ROTA DETALHES DO FILME (CORRIGIDA PARA STREAM/WATCH)
// =======================================================
app.get('/filme/:id', async (req, res) => {
    try {
        const filmeId = req.params.id;
        
        // 1. Buscar filme
        const filmeResult = await db.query('SELECT * FROM filmes WHERE id = $1 AND ativo = true', [filmeId]);
        if (filmeResult.rows.length === 0) return res.redirect('/');
        const filme = filmeResult.rows[0];

        // 2. Buscar Links
        const linksResult = await db.query('SELECT * FROM filme_links WHERE filme_id = $1 ORDER BY ordem', [filmeId]);
        let linksRaw = linksResult.rows;

        // 3. Verificar Acesso (Lógica de Pagamento)
        let temAcesso = false;
        let pedidoPendente = false;

        // Lógica de verificação (Gratis / Admin / Comprado / Assinatura)
        if (!filme.preco || parseFloat(filme.preco) <= 0) {
            temAcesso = true; 
        } else if (req.session.user) {
            if (req.session.user.tipo === 'admin') {
                temAcesso = true;
            } else {
                const pedido = await db.query(
                    'SELECT status FROM pedidos_acesso WHERE usuario_id = $1 AND filme_id = $2',
                    [req.session.user.id, filme.id]
                );
                
                if (pedido.rows.length > 0) {
                    if (pedido.rows[0].status === 'aprovado') temAcesso = true;
                    if (pedido.rows[0].status === 'pendente') pedidoPendente = true;
                }
                
                // Verifica Assinatura (se aplicável no seu sistema)
                if (!temAcesso) {
                     const assinatura = await db.query(
                        `SELECT id FROM usuarios WHERE id = $1 AND (premium_cine_ate >= NOW() OR premium_games_ate >= NOW())`,
                        [req.session.user.id]
                    );
                    if (assinatura.rows.length > 0) temAcesso = true;
                }
            }
        }

        // 4. FUNÇÃO DE CONVERSÃO DE LINKS (O SEGREDO ESTÁ AQUI)
        const processarLinkParaPlayer = (linkOriginal) => {
            let url = linkOriginal.trim();
            let tipo = 'download'; // Padrão
            let icone = 'fas fa-download';

            // --- REGRA 1: EMBEDPLAY (Conversão de /d/ para /e/) ---
            if (url.includes('embedplay') || url.includes('upns.ink')) {
                tipo = 'stream';
                icone = 'fas fa-play-circle';
                
                // Se tiver /d/ (download), troca para /e/ (embed)
                // Se o seu EmbedPlay usa /w/ para watch, troque '/e/' por '/w/' abaixo
                if (url.includes('/d/')) {
                    url = url.replace('/d/', '/e/'); 
                } 
                // Se não tiver nem /d/ nem /e/, tenta forçar a estrutura se for apenas o ID
                // (Opcional, depende de como você salva o link)
            }

            // --- REGRA 2: GOOGLE DRIVE (View -> Preview) ---
            else if (url.includes('drive.google.com')) {
                // Google Drive geralmente bloqueia players se não for convertido para /preview
                if (url.includes('/view')) {
                    url = url.replace('/view', '/preview');
                    tipo = 'stream';
                    icone = 'fab fa-google-drive';
                } else if (url.includes('/file/d/')) {
                    // Tenta garantir que termine com preview
                    tipo = 'stream';
                    icone = 'fab fa-google-drive';
                    if (!url.includes('/preview')) url += '/preview';
                }
            }

            // --- REGRA 3: YOUTUBE (Watch -> Embed) ---
            else if (url.includes('youtube.com') || url.includes('youtu.be')) {
                tipo = 'stream';
                icone = 'fab fa-youtube';
                if (url.includes('watch?v=')) {
                    url = url.replace('watch?v=', 'embed/');
                }
            }

            // --- REGRA 4: TERABOX / MEGA / MEDIAFIRE (Geralmente Download) ---
            // Terabox e Mega são difíceis de embedar sem API paga ou métodos complexos,
            // então mantemos como download para garantir que funcione.
            else if (url.includes('mega.nz')) { icone = 'fas fa-cloud'; }
            else if (url.includes('mediafire.com')) { icone = 'fas fa-fire'; }
            else if (url.includes('terabox.com')) { icone = 'fas fa-box'; }

            return { url, tipo, icone };
        };

        // 5. PROCESSAR A LISTA
        let playerLinks = [];
        if (temAcesso) {
            playerLinks = linksRaw.map(link => {
                const processado = processarLinkParaPlayer(link.url);
                return {
                    id: link.id,
                    label: link.label || `Opção ${link.ordem + 1}`,
                    url: processado.url,         // URL Pronta para o Player
                    original_url: link.url,      // URL Original (Backup)
                    tipo: processado.tipo,       // 'stream' ou 'download'
                    icone: processado.icone
                };
            });
        }

        res.render('cinema/detalhe', {
            title: `${filme.titulo} - Kuanda Cinema`,
            filme: filme,
            links: playerLinks,
            temAcesso: temAcesso,
            pedidoPendente: pedidoPendente,
            user: req.session.user || null,
            carrinho: req.session.carrinho || []
        });

    } catch (error) {
        console.error('Erro na rota filme/detalhe:', error);
        res.redirect('/');
    }
});

// 2. SOLICITAR COMPRA
app.post('/filme/:id/comprar', requireAuth, async (req, res) => {
    try {
        const existe = await db.query(
            'SELECT id FROM pedidos_acesso WHERE usuario_id = $1 AND filme_id = $2',
            [req.session.user.id, req.params.id]
        );

        if (existe.rows.length > 0) {
            req.flash('info', 'Você já tem um pedido para este título.');
        } else {
            await db.query(
                'INSERT INTO pedidos_acesso (usuario_id, filme_id, status) VALUES ($1, $2, $3)',
                [req.session.user.id, req.params.id, 'pendente']
            );
            req.flash('success', 'Pedido enviado! Aguarde aprovação após o pagamento.');
        }
        res.redirect(`/filme/${req.params.id}`);
    } catch (error) {
        console.error(error);
        req.flash('error', 'Erro ao processar pedido.');
        res.redirect(`/filme/${req.params.id}`);
    }
});

// =======================================================
// ROTAS ADMIN: FINANCEIRO (PEDIDOS CINEMA)
// =======================================================

app.get('/admin/pedidos-cinema', requireAdmin, async (req, res) => {
    try {
        const pedidos = await db.query(`
            SELECT p.*, u.nome as usuario_nome, u.email, f.titulo as filme_titulo, f.preco 
            FROM pedidos_acesso p
            JOIN usuarios u ON p.usuario_id = u.id
            JOIN filmes f ON p.filme_id = f.id
            WHERE p.status = 'pendente'
            ORDER BY p.created_at DESC
        `);
        res.render('admin/pedidos_cinema', { 
            pedidos: pedidos.rows,
            title: 'Pedidos de Acesso - Cinema' 
        });
    } catch (error) {
        console.error(error);
        res.redirect('/admin');
    }
});

app.post('/admin/pedidos-cinema/:id/aprovar', requireAdmin, async (req, res) => {
    try {
        await db.query("UPDATE pedidos_acesso SET status = 'aprovado' WHERE id = $1", [req.params.id]);
        req.flash('success', 'Acesso liberado com sucesso!');
        res.redirect('/admin/pedidos-cinema');
    } catch (error) {
        console.error(error);
        req.flash('error', 'Erro ao aprovar acesso.');
        res.redirect('/admin/pedidos-cinema');
    }
});

app.post('/admin/pedidos-cinema/:id/rejeitar', requireAdmin, async (req, res) => {
    try {
        // Opção A: Apenas deletar o pedido para limpar a lista
        await db.query("DELETE FROM pedidos_acesso WHERE id = $1", [req.params.id]);
        
        // Opção B (Alternativa): Se quiser manter histórico, mude o status para 'rejeitado'
        // await db.query("UPDATE pedidos_acesso SET status = 'rejeitado' WHERE id = $1", [req.params.id]);

        req.flash('success', 'Pedido removido/cancelado com sucesso.');
        res.redirect('/admin/pedidos-cinema');
    } catch (error) {
        console.error('Erro ao rejeitar pedido:', error);
        req.flash('error', 'Erro ao cancelar o pedido.');
        res.redirect('/admin/pedidos-cinema');
    }
});

// =======================================================
// ROTA DO CATÁLOGO DE CINEMA (LISTAGEM COMPLETA)
// =======================================================
app.get('/filmes', async (req, res) => {
    try {
        // Busca filmes ativos, ordenados pelos mais recentes primeiro
        const result = await db.query(`
            SELECT * FROM filmes 
            WHERE ativo = true 
            ORDER BY data_lancamento DESC, created_at DESC
        `);

        // Busca o filme mais recente que tenha banner para ser o destaque (Hero)
        const destaqueResult = await db.query(`
            SELECT * FROM filmes 
            WHERE ativo = true AND banner IS NOT NULL 
            ORDER BY created_at DESC LIMIT 1
        `);

        res.render('cinema', {
            title: 'Catálogo de Filmes & Séries - Kuanda Cinema',
            filmes: result.rows,
            destaque: destaqueResult.rows[0] || null, // Passa o destaque ou null
            user: req.session.user || null,
            carrinho: req.session.carrinho || []
        });

    } catch (error) {
        console.error('Erro ao carregar catálogo de filmes:', error);
        res.redirect('/');
    }
});

// ==================== CONFIGURAÇÕES DO SITE ====================
app.get('/admin/configuracoes', requireAdmin, async (req, res) => {
  try {
    const configuracoes = await db.query('SELECT * FROM configuracoes LIMIT 1');
    
    res.render('admin/configuracoes', {
      config: configuracoes.rows[0] || {},
      title: 'Configurações do Site - KuandaShop'
    });
  } catch (error) {
    console.error('Erro ao carregar configurações:', error);
    res.render('admin/configuracoes', {
      config: {},
      title: 'Configurações do Site'
    });
  }
});

app.post('/admin/configuracoes', requireAdmin, async (req, res) => {
  const { nome_site, email_contato, telefone_contato, endereco, sobre_nos } = req.body;
  
  try {
    const configExistente = await db.query('SELECT id FROM configuracoes LIMIT 1');
    
    if (configExistente.rows.length > 0) {
      await db.query(`
        UPDATE configuracoes 
        SET nome_site = $1, email_contato = $2, telefone_contato = $3, 
            endereco = $4, sobre_nos = $5, updated_at = CURRENT_TIMESTAMP
        WHERE id = $6
      `, [
        nome_site ? nome_site.trim() : 'KuandaShop',
        email_contato ? email_contato.trim() : null,
        telefone_contato ? telefone_contato.trim() : null,
        endereco ? endereco.trim() : null,
        sobre_nos ? sobre_nos.trim() : null,
        configExistente.rows[0].id
      ]);
    } else {
      await db.query(`
        INSERT INTO configuracoes (nome_site, email_contato, telefone_contato, endereco, sobre_nos)
        VALUES ($1, $2, $3, $4, $5)
      `, [
        nome_site ? nome_site.trim() : 'KuandaShop',
        email_contato ? email_contato.trim() : null,
        telefone_contato ? telefone_contato.trim() : null,
        endereco ? endereco.trim() : null,
        sobre_nos ? sobre_nos.trim() : null
      ]);
    }
    
    req.flash('success', 'Configurações atualizadas com sucesso!');
    res.redirect('/admin/configuracoes');
  } catch (error) {
    console.error('Erro ao salvar configurações:', error);
    req.flash('error', 'Erro ao salvar configurações');
    res.redirect('/admin/configuracoes');
  }
});

// ==================== GERENCIAMENTO DE CATEGORIAS ====================
app.get('/admin/categorias', requireAdmin, async (req, res) => {
  try {
    const categorias = await db.query('SELECT * FROM categorias ORDER BY nome');
    
    res.render('admin/categorias', {
      categorias: categorias.rows,
      title: 'Gerenciar Categorias - KuandaShop'
    });
  } catch (error) {
    console.error('Erro ao carregar categorias:', error);
    res.render('admin/categorias', {
      categorias: [],
      title: 'Gerenciar Categorias'
    });
  }
});

app.post('/admin/categorias', requireAdmin, async (req, res) => {
  const { nome, descricao } = req.body;
  
  try {
    if (!nome || nome.trim().length < 2) {
      req.flash('error', 'Nome da categoria deve ter pelo menos 2 caracteres');
      return res.redirect('/admin/categorias');
    }

    await db.query(`
      INSERT INTO categorias (nome, descricao)
      VALUES ($1, $2)
    `, [nome.trim(), descricao ? descricao.trim() : null]);
    
    req.flash('success', 'Categoria criada com sucesso!');
    res.redirect('/admin/categorias');
  } catch (error) {
    console.error('Erro ao criar categoria:', error);
    req.flash('error', 'Erro ao criar categoria');
    res.redirect('/admin/categorias');
  }
});

app.put('/admin/categorias/:id', requireAdmin, async (req, res) => {
  const { nome, descricao } = req.body;
  
  try {
    if (!nome || nome.trim().length < 2) {
      req.flash('error', 'Nome da categoria deve ter pelo menos 2 caracteres');
      return res.redirect('/admin/categorias');
    }

    await db.query(`
      UPDATE categorias 
      SET nome = $1, descricao = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
    `, [nome.trim(), descricao ? descricao.trim() : null, req.params.id]);
    
    req.flash('success', 'Categoria atualizada com sucesso!');
    res.redirect('/admin/categorias');
  } catch (error) {
    console.error('Erro ao atualizar categoria:', error);
    req.flash('error', 'Erro ao atualizar categoria');
    res.redirect('/admin/categorias');
  }
});

app.delete('/admin/categorias/:id', requireAdmin, async (req, res) => {
  try {
    const produtos = await db.query(
      'SELECT COUNT(*) as total FROM produtos WHERE categoria_id = $1',
      [req.params.id]
    );
    
    if (parseInt(produtos.rows[0].total) > 0) {
      req.flash('error', 'Esta categoria está sendo usada por produtos e não pode ser removida');
      return res.redirect('/admin/categorias');
    }
    
    await db.query('DELETE FROM categorias WHERE id = $1', [req.params.id]);
    
    req.flash('success', 'Categoria removida com sucesso!');
    res.redirect('/admin/categorias');
  } catch (error) {
    console.error('Erro ao remover categoria:', error);
    req.flash('error', 'Erro ao remover categoria');
    res.redirect('/admin/categorias');
  }
});

// ==================== ROTA PARA MIGRAÇÃO DOS PLANOS ====================
app.get('/admin/migrar-planos', requireAdmin, async (req, res) => {
  try {
    // Verificar se a tabela planos_vendedor existe
    const tableExists = await db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'planos_vendedor'
      )
    `);

    if (!tableExists.rows[0].exists) {
      req.flash('error', 'Tabela de planos não existe. Execute o script SQL primeiro.');
      return res.redirect('/admin');
    }

    // Verificar se já existem planos
    const planosExistentes = await db.query('SELECT COUNT(*) as total FROM planos_vendedor');
    
    if (parseInt(planosExistentes.rows[0].total) === 0) {
      // Criar planos padrão
      await db.query(`
        INSERT INTO planos_vendedor (nome, limite_produtos, preco_mensal, permite_vip, permite_destaque) VALUES
        ('Básico', 10, 0.00, false, false),
        ('Pro', 50, 99.90, true, true),
        ('Premium', 200, 299.90, true, true),
        ('Enterprise', 1000, 999.90, true, true)
      `);
      
      req.flash('success', 'Planos padrão criados com sucesso!');
    } else {
      req.flash('info', 'Planos já existem no sistema.');
    }

    // Atualizar vendedores existentes
    const vendedoresSemPlano = await db.query(`
      SELECT COUNT(*) as total 
      FROM usuarios 
      WHERE tipo = 'vendedor' AND plano_id IS NULL
    `);

    if (parseInt(vendedoresSemPlano.rows[0].total) > 0) {
      const planoBasico = await db.query(
        "SELECT id FROM planos_vendedor WHERE nome = 'Básico' LIMIT 1"
      );
      
      if (planoBasico.rows.length > 0) {
        await db.query(`
          UPDATE usuarios 
          SET plano_id = $1, limite_produtos = 10
          WHERE tipo = 'vendedor' AND plano_id IS NULL
        `, [planoBasico.rows[0].id]);
        
        req.flash('success', `${vendedoresSemPlano.rows[0].total} vendedores atualizados para o plano Básico.`);
      }
    }

    res.redirect('/admin/planos');
  } catch (error) {
    console.error('Erro na migração de planos:', error);
    req.flash('error', 'Erro na migração de planos: ' + error.message);
    res.redirect('/admin');
  }
});

// =============================================================
//  ROTAS DE GERENCIAMENTO DE LOJA (COLE ISTO NO SERVER.JS)
// =============================================================

// ROTA 1: Tela de Gerenciamento (GET)
app.get('/admin/vendedor/:id/gerenciar', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Buscar Vendedor
    const vendedorResult = await db.query(
      'SELECT * FROM usuarios WHERE id = $1 AND tipo = $2', 
      [id, 'vendedor']
    );

    if (vendedorResult.rows.length === 0) {
      req.flash('error', 'Vendedor não encontrado.');
      return res.redirect('/admin/planos');
    }
    const vendedor = vendedorResult.rows[0];

    // 2. Buscar Planos
    const planosResult = await db.query('SELECT * FROM planos_vendedor ORDER BY preco_mensal ASC');

    // 3. Buscar Plano Atual
    let planoAtual = null;
    if (vendedor.plano_id) {
      const p = await db.query('SELECT * FROM planos_vendedor WHERE id = $1', [vendedor.plano_id]);
      if (p.rows.length > 0) planoAtual = p.rows[0];
    }

    // 4. Renderizar
    res.render('admin/gerenciar-loja', {
      vendedor: vendedor,
      planos: planosResult.rows,
      planoAtual: planoAtual,
      title: 'Gerenciar Loja',
      user: req.session.user || null // Garante que o layout não quebre
    });

  } catch (error) {
    console.error('Erro na rota GET /gerenciar:', error);
    req.flash('error', 'Erro ao carregar tela de gerência: ' + error.message);
    res.redirect('/admin/planos');
  }
});

// ROTA 2: Salvar Mudança de Plano (POST)
app.post('/admin/vendedor/:id/mudar-plano', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { novo_plano_id } = req.body;

    if (!novo_plano_id) {
        req.flash('error', 'Selecione um plano válido.');
        return res.redirect(`/admin/vendedor/${id}/gerenciar`);
    }

    // Pegar limites do novo plano
    const planoResult = await db.query('SELECT * FROM planos_vendedor WHERE id = $1', [novo_plano_id]);
    if (planoResult.rows.length === 0) throw new Error('Plano não existe');
    const novoPlano = planoResult.rows[0];

    // Atualizar
    await db.query(
      'UPDATE usuarios SET plano_id = $1, limite_produtos = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [novoPlano.id, novoPlano.limite_produtos, id]
    );

    req.flash('success', 'Plano atualizado com sucesso!');
    res.redirect(`/admin/vendedor/${id}/gerenciar`);

  } catch (error) {
    console.error('Erro na rota POST /mudar-plano:', error);
    req.flash('error', 'Erro ao salvar: ' + error.message);
    res.redirect(`/admin/vendedor/${req.params.id}/gerenciar`);
  }
});

// ==================== ROTA DE RESTAURAÇÃO DE IMAGENS ====================
app.get('/admin/restaurar-imagens', requireAdmin, async (req, res) => {
  try {
    // Restaurar imagens de produtos
    const produtos = await db.query('SELECT id, imagem1, imagem2, imagem3 FROM produtos');
    let produtosRestaurados = 0;
    
    for (const produto of produtos.rows) {
      if (produto.imagem1) {
        const sucesso = await recriarArquivoDoBackup(produto.imagem1, path.join('public/uploads/produtos/', produto.imagem1));
        if (sucesso) produtosRestaurados++;
      }
      if (produto.imagem2) {
        const sucesso = await recriarArquivoDoBackup(produto.imagem2, path.join('public/uploads/produtos/', produto.imagem2));
        if (sucesso) produtosRestaurados++;
      }
      if (produto.imagem3) {
        const sucesso = await recriarArquivoDoBackup(produto.imagem3, path.join('public/uploads/produtos/', produto.imagem3));
        if (sucesso) produtosRestaurados++;
      }
    }
    
    // Restaurar fotos de perfil
    const usuarios = await db.query('SELECT id, foto_perfil FROM usuarios WHERE foto_perfil IS NOT NULL');
    let perfisRestaurados = 0;
    
    for (const usuario of usuarios.rows) {
      const sucesso = await recriarArquivoDoBackup(usuario.foto_perfil, path.join('public/uploads/perfil/', usuario.foto_perfil));
      if (sucesso) perfisRestaurados++;
    }
    
    // Restaurar banners
    const banners = await db.query('SELECT id, imagem FROM banners WHERE imagem IS NOT NULL');
    let bannersRestaurados = 0;
    
    for (const banner of banners.rows) {
      const sucesso = await recriarArquivoDoBackup(banner.imagem, path.join('public/uploads/banners/', banner.imagem));
      if (sucesso) bannersRestaurados++;
    }
    
    // Restaurar filmes
    const filmes = await db.query('SELECT id, poster FROM filmes WHERE poster IS NOT NULL');
    let filmesRestaurados = 0;
    
    for (const filme of filmes.rows) {
      const sucesso = await recriarArquivoDoBackup(filme.poster, path.join('public/uploads/filmes/', filme.poster));
      if (sucesso) filmesRestaurados++;
    }
    
    // Restaurar jogos
    const jogos = await db.query('SELECT id, capa, banner, screenshots FROM jogos');
    let jogosRestaurados = 0;
    
    for (const jogo of jogos.rows) {
      if (jogo.capa) {
        const sucesso = await recriarArquivoDoBackup(jogo.capa, path.join('public/uploads/games/', jogo.capa));
        if (sucesso) jogosRestaurados++;
      }
      if (jogo.banner) {
        const sucesso = await recriarArquivoDoBackup(jogo.banner, path.join('public/uploads/games/', jogo.banner));
        if (sucesso) jogosRestaurados++;
      }
      if (jogo.screenshots && Array.isArray(jogo.screenshots)) {
        for (const screenshot of jogo.screenshots) {
          const sucesso = await recriarArquivoDoBackup(screenshot, path.join('public/uploads/games/', screenshot));
          if (sucesso) jogosRestaurados++;
        }
      }
    }
    
    req.flash('success', `Restauradas ${produtosRestaurados} imagens de produtos, ${perfisRestaurados} fotos de perfil, ${bannersRestaurados} banners, ${filmesRestaurados} posters de filmes e ${jogosRestaurados} imagens de jogos do backup BYTEA.`);
    res.redirect('/admin');
  } catch (error) {
    console.error('Erro ao restaurar imagens:', error);
    req.flash('error', 'Erro ao restaurar imagens: ' + error.message);
    res.redirect('/admin');
  }
});

// ==================== TRATAMENTO DE ERROS ====================

// 1. Erro 404 - Página não encontrada
app.use((req, res) => {
  res.status(404).render('404', {
    layout: false,
    title: '404 - Página não encontrada',
    user: req.session.user || null
  });
});

// 2. Erros do Multer (Upload)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      req.flash('error', 'Arquivo muito grande. Tamanho máximo: 5MB');
    } else {
      req.flash('error', `Erro no upload: ${err.message}`);
    }
    return res.redirect('back');
  }
  
  // Se não for erro do Multer, passa para o próximo
  next(err);
});

// 3. Erro 500 - Erro Interno
app.use((err, req, res, next) => {
  console.error('❌ ERRO CRÍTICO NO SERVIDOR:', err);
  
  // Se a resposta já foi enviada, não faz nada
  if (res.headersSent) {
    return next(err);
  }

  res.status(500).render('500', {
    layout: false,
    title: '500 - Erro interno do servidor',
    // Mostra o erro detalhado apenas em desenvolvimento
    error: process.env.NODE_ENV === 'development' ? err : { message: 'Ocorreu um erro inesperado. Tente novamente.' },
    user: req.session.user || null
  });
});

// ==================== ROTA CHECKOUT CORRIGIDA ====================
app.get('/checkout', requireAuth, (req, res) => {
  try {
    console.log('🔍 DEBUG: Executando rota /checkout');
    
    const carrinho = req.session.carrinho || [];
    
    if (carrinho.length === 0) {
      req.flash('error', 'Seu carrinho está vazio');
      return res.redirect('/carrinho');
    }
    
    // Calcular totais de forma segura
    const totalItens = carrinho.reduce((sum, item) => {
      return sum + (parseInt(item.quantidade) || 0);
    }, 0);
    
    const totalGeral = carrinho.reduce((sum, item) => {
      const preco = parseFloat(item.preco) || 0;
      const quantidade = parseInt(item.quantidade) || 0;
      return sum + (preco * quantidade);
    }, 0);
    
    console.log(`🔍 DEBUG: Total itens: ${totalItens}, Total geral: ${totalGeral}`);
    
    res.render('checkout', {
      title: 'Finalizar Compra - KuandaShop',
      totalItens: totalItens,
      totalGeral: totalGeral.toFixed(2),
      usuario: req.session.user || {},
      carrinho: carrinho,
      pedidosPorVendedor: [], // Array vazio por enquanto
      messages: req.flash()
    });
    
  } catch (error) {
    console.error('❌ ERRO NA ROTA /CHECKOUT:', error);
    console.error(error.stack);
    req.flash('error', 'Erro ao processar checkout');
    res.redirect('/carrinho');
  }
});

// ROTA CHECKOUT (COM NOTIFICAÇÃO CORRIGIDA)
app.post('/checkout/processar', requireAuth, async (req, res) => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const carrinho = req.session.carrinho || [];
      if (carrinho.length === 0) throw new Error('Carrinho vazio');
  
      // Agrupa itens por vendedor
      const porVendedor = {};
      carrinho.forEach(i => {
        if(!porVendedor[i.vendedor_id]) porVendedor[i.vendedor_id] = [];
        porVendedor[i.vendedor_id].push(i);
      });
  
      const userId = req.session.user.id;
  
      for (const vid in porVendedor) {
        const itens = porVendedor[vid];
        const total = itens.reduce((s, i) => s + (i.preco * i.quantidade), 0);
  
        // 1. Cria Pedido
        const pRes = await client.query(`
          INSERT INTO pedidos (usuario_id, vendedor_id, valor_total, status, created_at)
          VALUES ($1, $2, $3, 'pendente', NOW()) RETURNING id
        `, [userId, vid, total]);
        const pedId = pRes.rows[0].id;
  
        // 2. Insere Itens
        for (const item of itens) {
          await client.query(`
            INSERT INTO itens_pedido (pedido_id, produto_id, quantidade, preco_unitario)
            VALUES ($1, $2, $3, $4)
          `, [pedId, item.id, item.quantidade, item.preco]);
        }
  
        // 3. DISPARA NOTIFICAÇÕES (USANDO A NOVA FUNÇÃO CORRIGIDA)
        if (app.sysNotification) {
          // Para o Vendedor (Aviso de nova venda)
          await app.sysNotification(
              userId, vid, 
              `📦 Novo pedido #${pedId} recebido (Kz ${total}).`, 
              'compra', pedId
          );
          // Para o Cliente (Confirmação)
          await app.sysNotification(
              vid, userId, 
              `✅ Pedido #${pedId} realizado com sucesso. Aguarde o envio.`, 
              'status', pedId
          );
        }
      }
  
      await client.query('COMMIT');
      req.session.carrinho = [];
      req.flash('success', 'Pedido realizado! Verifique suas notificações.');
      res.redirect('/perfil');
  
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(error);
      req.flash('error', 'Erro ao processar pedido.');
      res.redirect('/carrinho');
    } finally {
      client.release();
    }
});


// ==================== INICIALIZAR SERVIDOR ====================
const server = app.listen(PORT, () => {
  console.log(`
  ====================================================
  🚀 KUANDASHOP MARKETPLACE MULTI-VENDOR
  ====================================================
  ✅ Sistema inicializado com sucesso!
  ✅ Banco de dados conectado
  ✅ Sessões configuradas no PostgreSQL
  ✅ Uploads configurados (arquivos + bytea)
  ✅ Painéis administrativos prontos
  ✅ Sistema de planos implementado
  ✅ IMAGENS HÍBRIDAS PERSISTENTES IMPLEMENTADAS!
  ✅ UPLOAD DE PERFIL E BANNER CORRIGIDO E FUNCIONAL!
  
  📍 Porta: ${PORT}
  🌐 Ambiente: ${process.env.NODE_ENV || 'development'}
  🔗 URL: http://localhost:${PORT}
  
  🖼️  SISTEMA DE IMAGENS HÍBRIDO ATIVO:
    • Upload normal no disco (public/uploads/)
    • Backup automático BYTEA no PostgreSQL
    • Rota de fallback inteligente: /uploads/*
    • Performance máxima: serve do disco quando existe
    • Recuperação automática: busca no banco quando não existe
    • Views EJS NÃO PRECISAM SER ALTERADAS!
    
  📁 Rotas de Upload Corrigidas:
    • POST /perfil/atualizar (upload combinado)
    • POST /perfil/upload-foto (apenas foto)
    • POST /perfil/upload-banner (apenas banner)
    • POST /perfil/remover-foto (remover foto)
    • POST /perfil/remover-banner (remover banner)
    
  👤 Credenciais Admin:
    Email: admin@kuandashop.ao
    Senha: password
  
  📊 Funcionalidades disponíveis:
    • Página inicial com banners
    • Catálogo de produtos
    • Sistema de avaliações
    • Carrinho de compras
    • Painel do vendedor
    • Painel administrativo
    • Gerenciamento de banners
    • Gerenciamento de filmes
    • Sistema de VIP/destaque
    • Seguidores de lojas
    • Sistema de planos com limites
    • Loja de jogos completa
    • ✅ IMAGENS PERSISTENTES HÍBRIDAS (arquivo + bytea)
    • ✅ UPLOAD DE PERFIL E BANNER FUNCIONAL
  
  💡 Recuperação de imagens: /admin/restaurar-imagens
  📁 SQL para criar tabela de backup no início deste arquivo
  
  ====================================================
  `);
});

// Tratamento de encerramento gracioso
process.on('SIGTERM', () => {
  console.log('🛑 Recebido sinal SIGTERM, encerrando servidor...');
  server.close(() => {
    console.log('✅ Servidor encerrado com sucesso');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 Recebido sinal SIGINT, encerrando servidor...');
  server.close(() => {
    console.log('✅ Servidor encerrado com sucesso');
    process.exit(0);
  });
});

// Tratamento de erros não capturados
process.on('uncaughtException', (err) => {
  console.error('❌ Erro não capturado:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promessa rejeitada não tratada:', reason);
});

module.exports = app;
