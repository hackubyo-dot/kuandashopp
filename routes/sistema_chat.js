const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

/**
 * KUANDA OS - CHAT ENGINE (V-FULL-VERBOSE-CORRIGIDO)
 * Este arquivo contém TODA a lógica.
 */

// ======================================================================
// 1. CONFIGURAÇÃO DE UPLOAD (GARANTIA DE PASTAS)
// ======================================================================
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = path.join(__dirname, '../../public/uploads/chat/');
        // Cria a pasta recursivamente se não existir
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log('📁 [CHAT] Pasta criada:', dir);
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        let ext = path.extname(file.originalname);
        // Corrige extensão de áudio webm
        if (file.mimetype === 'audio/webm' || file.originalname === 'audio.webm') ext = '.webm';
        if (!ext) ext = '.bin';
        cb(null, `chat-${unique}${ext}`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});

module.exports = function(app, db) {
    console.log('🚀 [CHAT SYSTEM] Inicializando Módulo de Mensagens...');

    // ======================================================================
    // 2. FUNÇÃO DE INICIALIZAÇÃO DO BANCO (SQL SEGURO)
    // ======================================================================
    const initDB = async () => {
        try {
            // 2.1 Tabela de Conversas
            await db.query(`
                CREATE TABLE IF NOT EXISTS conversas (
                    id SERIAL PRIMARY KEY,
                    pedido_id INTEGER,
                    participante_1 INTEGER,
                    participante_2 INTEGER,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // 2.2 Tabela de Mensagens
            await db.query(`
                CREATE TABLE IF NOT EXISTS mensagens (
                    id SERIAL PRIMARY KEY,
                    conversa_id INTEGER REFERENCES conversas(id) ON DELETE CASCADE,
                    remetente_id INTEGER,
                    conteudo TEXT,
                    tipo_acao VARCHAR(50) DEFAULT 'texto',
                    anexo_url VARCHAR(255),
                    anexo_tipo VARCHAR(50),
                    anexo_nome VARCHAR(255),
                    lida BOOLEAN DEFAULT FALSE,
                    is_system BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // 2.3 Verifica e Cria Colunas Faltantes
            try {
                await db.query(`ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS is_system BOOLEAN DEFAULT FALSE`);
                await db.query(`ALTER TABLE conversas ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
                await db.query(`ALTER TABLE conversas ADD COLUMN IF NOT EXISTS pedido_id INTEGER`);
            } catch (errCol) {
                console.log('⚠️ [CHAT DB] Nota sobre colunas (pode ignorar se já existirem):', errCol.message);
            }

            console.log('✅ [CHAT SYSTEM] Banco de Dados Verificado e Pronto.');
        } catch (error) {
            console.error('❌ [CHAT SYSTEM] ERRO CRÍTICO NO BANCO:', error);
        }
    };
    // Executa a inicialização
    initDB();

    // ======================================================================
    // 3. GATILHO GLOBAL (INTEGRAÇÃO COM SERVER.JS)
    // ======================================================================
    // Esta função permite o server.js enviar notificações de compra/status
    app.sysNotification = async (remetenteId, destinatarioId, conteudo, tipoAcao = 'sistema', pedidoId = null) => {
        try {
            console.log(`🔔 [NOTIFICAÇÃO INTERNA] De: ${remetenteId} Para: ${destinatarioId} Tipo: ${tipoAcao}`);

            if (!remetenteId || !destinatarioId) {
                console.error('❌ [NOTIF] IDs inválidos.');
                return false;
            }

            // A. Busca ou Cria Conversa
            let conversaId = null;
            const check = await db.query(`
                SELECT id FROM conversas 
                WHERE (participante_1 = $1 AND participante_2 = $2) 
                   OR (participante_1 = $2 AND participante_2 = $1)
                LIMIT 1
            `, [remetenteId, destinatarioId]);

            if (check.rows.length > 0) {
                conversaId = check.rows[0].id;
                // Atualiza data e vincula pedido se existir
                if (pedidoId) {
                    await db.query('UPDATE conversas SET updated_at = NOW(), pedido_id = $1 WHERE id = $2', [pedidoId, conversaId]);
                } else {
                    await db.query('UPDATE conversas SET updated_at = NOW() WHERE id = $1', [conversaId]);
                }
            } else {
                const novo = await db.query(`
                    INSERT INTO conversas (participante_1, participante_2, pedido_id, updated_at)
                    VALUES ($1, $2, $3, NOW()) RETURNING id
                `, [remetenteId, destinatarioId, pedidoId]);
                conversaId = novo.rows[0].id;
            }

            // B. Insere Mensagem
            await db.query(`
                INSERT INTO mensagens (conversa_id, remetente_id, conteudo, tipo_acao, lida, is_system, created_at)
                VALUES ($1, $2, $3, $4, false, true, NOW())
            `, [conversaId, remetenteId, conteudo, tipoAcao]);

            return true;
        } catch (error) {
            console.error('❌ [NOTIF ERRO]:', error);
            return false;
        }
    };

    // ======================================================================
    // 4. MIDDLEWARES & ROTAS DE API
    // ======================================================================

    const isAuth = (req, res, next) => {
        if (req.session && req.session.user) return next();
        if (req.xhr || req.path.startsWith('/api/')) return res.status(401).json({ error: 'Auth required' });
        res.redirect('/login');
    };

    // ROTA DA TELA PRINCIPAL (VIEW)
    app.get('/central-mensagens', isAuth, (req, res) => {
        try {
            console.log('👀 [VIEW] Acessando Central de Mensagens...');
            res.render('chat', { 
                user: req.session.user,
                layout: false // Se você usa layout, mude para true ou remova essa propriedade
            });
        } catch (error) {
            console.error('❌ [VIEW ERROR]:', error);
            res.status(500).send(`Erro ao carregar chat: ${error.message}`);
        }
    });

    // ----------------------------------------------------------------------
    // API: LISTAR CONVERSAS
    // ----------------------------------------------------------------------
    app.get('/api/chat/conversas', isAuth, async (req, res) => {
        try {
            const myId = req.session.user.id;
            const busca = req.query.q || '';

            // Query complexa para pegar última mensagem e dados do usuário
            const query = `
                SELECT 
                    c.id, c.pedido_id, c.updated_at,
                    u1.nome as nome1, u1.nome_loja as loja1, u1.foto_perfil as foto1, u1.id as id1,
                    u2.nome as nome2, u2.nome_loja as loja2, u2.foto_perfil as foto2, u2.id as id2,
                    (SELECT conteudo FROM mensagens WHERE conversa_id = c.id ORDER BY created_at DESC LIMIT 1) as ultima_msg,
                    (SELECT tipo_acao FROM mensagens WHERE conversa_id = c.id ORDER BY created_at DESC LIMIT 1) as ultimo_tipo,
                    (SELECT created_at FROM mensagens WHERE conversa_id = c.id ORDER BY created_at DESC LIMIT 1) as data_msg,
                    (SELECT COUNT(*) FROM mensagens WHERE conversa_id = c.id AND lida = false AND remetente_id != $1) as nao_lidas
                FROM conversas c
                LEFT JOIN usuarios u1 ON c.participante_1 = u1.id
                LEFT JOIN usuarios u2 ON c.participante_2 = u2.id
                WHERE (c.participante_1 = $1 OR c.participante_2 = $1)
                AND (u1.nome ILIKE $2 OR u2.nome ILIKE $2 OR u1.nome_loja ILIKE $2)
                ORDER BY c.updated_at DESC
            `;

            const result = await db.query(query, [myId, `%${busca}%`]);

            const chats = result.rows.map(r => {
                // Define quem é o "outro" na conversa
                const souUm = r.id1 === myId;
                const alvo = souUm 
                    ? { nome: r.loja2 || r.nome2, foto: r.foto2, id: r.id2 } 
                    : { nome: r.loja1 || r.nome1, foto: r.foto1, id: r.id1 };

                // Formata preview
                let preview = r.ultima_msg || 'Nova conversa';
                if (r.ultimo_tipo === 'imagem') preview = '📷 Imagem';
                if (r.ultimo_tipo === 'audio') preview = '🎤 Áudio';
                if (r.ultimo_tipo === 'compra') preview = '🛍️ Novo Pedido';
                if (r.ultimo_tipo === 'sistema') preview = '🔔 Notificação';
                if (r.ultimo_tipo === 'status') preview = '🔄 Status Atualizado';

                return {
                    id: r.id,
                    titulo: alvo.nome,
                    foto: alvo.foto,
                    target_id: alvo.id,
                    pedido_id: r.pedido_id,
                    preview: preview,
                    data: r.updated_at,
                    nao_lidas: parseInt(r.nao_lidas)
                };
            });

            res.json(chats);
        } catch (e) {
            console.error('❌ [API ERROR] Conversas:', e);
            res.json([]);
        }
    });

    // ----------------------------------------------------------------------
    // API: OBTER MENSAGENS DE UMA CONVERSA
    // ----------------------------------------------------------------------
    app.get('/api/chat/mensagens/:id', isAuth, async (req, res) => {
        try {
            const chatId = req.params.id;
            
            // Marca mensagens como lidas (segurança contra ID nulo)
            if (chatId && !isNaN(chatId)) {
                await db.query(`
                    UPDATE mensagens SET lida = true 
                    WHERE conversa_id = $1 AND remetente_id != $2
                `, [chatId, req.session.user.id]);

                const msgs = await db.query(`
                    SELECT m.*, u.nome, u.foto_perfil 
                    FROM mensagens m
                    LEFT JOIN usuarios u ON m.remetente_id = u.id
                    WHERE m.conversa_id = $1 
                    ORDER BY m.created_at ASC
                `, [chatId]);

                res.json(msgs.rows);
            } else {
                res.json([]);
            }
        } catch (e) {
            console.error('❌ [API ERROR] Mensagens:', e);
            res.json([]);
        }
    });

    // ----------------------------------------------------------------------
    // API: ENVIAR MENSAGEM (USUÁRIO)
    // ----------------------------------------------------------------------
    app.post('/api/chat/enviar', isAuth, upload.single('anexo'), async (req, res) => {
        try {
            const userId = req.session.user.id;
            let { conversa_id, conteudo, tipo_especifico } = req.body;
            let url = null, nome = null, tipo = 'texto';

            if (req.file) {
                url = req.file.filename;
                nome = req.file.originalname;
                // Detecta tipo
                if (tipo_especifico === 'audio' || req.file.mimetype.includes('audio')) tipo = 'audio';
                else if (req.file.mimetype.includes('image')) tipo = 'imagem';
                else tipo = 'arquivo';
            } else if (!conteudo || conteudo.trim().length === 0) {
                return res.status(400).json({ error: 'Mensagem vazia' });
            }

            await db.query(`
                INSERT INTO mensagens (conversa_id, remetente_id, conteudo, tipo_acao, anexo_url, anexo_nome, is_system, lida, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, false, false, NOW())
            `, [conversa_id, userId, conteudo ? conteudo.trim() : '', tipo, url, nome]);

            // Atualiza conversa para subir
            await db.query(`UPDATE conversas SET updated_at = NOW() WHERE id = $1`, [conversa_id]);

            res.json({ success: true });
        } catch (e) {
            console.error('❌ [API ERROR] Enviar:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // ----------------------------------------------------------------------
    // API: INICIAR CONVERSA
    // ----------------------------------------------------------------------
    app.post('/api/chat/iniciar', isAuth, async (req, res) => {
        try {
            const { target_id, pedido_id } = req.body;
            const myId = req.session.user.id;

            // Verifica se conversa já existe
            const check = await db.query(`
                SELECT id FROM conversas 
                WHERE (participante_1 = $1 AND participante_2 = $2) 
                   OR (participante_1 = $2 AND participante_2 = $1)
            `, [myId, target_id]);

            if (check.rows.length > 0) {
                // Atualiza se tiver pedido novo
                if (pedido_id) {
                    await db.query('UPDATE conversas SET pedido_id = $1, updated_at = NOW() WHERE id = $2', [pedido_id, check.rows[0].id]);
                }
                return res.json({ id: check.rows[0].id });
            }

            // Cria Nova
            const novo = await db.query(`
                INSERT INTO conversas (participante_1, participante_2, pedido_id, updated_at) 
                VALUES ($1, $2, $3, NOW()) RETURNING id
            `, [myId, target_id, pedido_id || null]);

            res.json({ id: novo.rows[0].id });
        } catch (e) {
            console.error('❌ [API ERROR] Iniciar:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // ----------------------------------------------------------------------
    // API: CHECK (CORRIGIDA PARA SISTEMA DE NOTIFICAÇÕES)
    // ----------------------------------------------------------------------
    app.get('/api/chat/check', isAuth, async (req, res) => {
        try {
            const userId = req.session.user.id;

            // 1. Contagem total de não lidas (Apenas mensagens que NÃO fui eu que mandei)
            const countRes = await db.query(`
                SELECT COUNT(*) as total 
                FROM mensagens m 
                JOIN conversas c ON m.conversa_id = c.id 
                WHERE (c.participante_1 = $1 OR c.participante_2 = $1) 
                AND m.lida = false 
                AND m.remetente_id != $1
            `, [userId]);

            // 2. Pegar a ÚLTIMA mensagem recebida (para o texto do Popup)
            // Filtra m.remetente_id != userId para pegar mensagens de OUTROS ou do SISTEMA (se o sistema usou outro ID)
            // Se o sistema usou o próprio ID do usuário para criar a msg (auto-msg), removo o filtro, mas geralmente sistema tem remetente diferente.
            // Para garantir: pegamos a última mensagem da conversa onde eu sou participante, mas não o remetente.
            const lastMsgRes = await db.query(`
                SELECT m.conteudo, m.tipo_acao, m.created_at, u.nome, u.nome_loja
                FROM mensagens m
                JOIN conversas c ON m.conversa_id = c.id
                LEFT JOIN usuarios u ON m.remetente_id = u.id
                WHERE (c.participante_1 = $1 OR c.participante_2 = $1)
                AND m.remetente_id != $1 
                ORDER BY m.created_at DESC LIMIT 1
            `, [userId]);

            const unreadCount = parseInt(countRes.rows[0].total);
            let responseData = { 
                unread: unreadCount, 
                hasNew: false, 
                preview: '', 
                from: 'Sistema' 
            };

            if (lastMsgRes.rows.length > 0) {
                const msg = lastMsgRes.rows[0];
                responseData.from = msg.nome_loja || msg.nome || 'Notificação';
                
                // Formata o texto para o Push Visual
                switch(msg.tipo_acao) {
                    case 'compra': responseData.preview = '📦 Novo Pedido Recebido!'; break;
                    case 'status': responseData.preview = `🔄 ${msg.conteudo}`; break;
                    case 'imagem': responseData.preview = '📷 Enviou uma foto'; break;
                    case 'audio':  responseData.preview = '🎤 Enviou um áudio'; break;
                    case 'arquivo': responseData.preview = '📎 Enviou um arquivo'; break;
                    case 'sistema': responseData.preview = msg.conteudo; break;
                    default: responseData.preview = msg.conteudo; // Texto normal
                }
                
                // Adiciona timestamp para o frontend
                responseData.lastId = new Date(msg.created_at).getTime();
            }

            res.json(responseData);

        } catch (e) {
            console.error('Erro no check:', e);
            res.json({ unread: 0, hasNew: false });
        }
    });

    // ----------------------------------------------------------------------
    // API: DETALHES DO PEDIDO (PAINEL LATERAL)
    // ----------------------------------------------------------------------
    app.get('/api/chat/pedido-detalhes/:id', isAuth, async (req, res) => {
        try {
            const pRes = await db.query(`SELECT * FROM pedidos WHERE id = $1`, [req.params.id]);
            if (pRes.rows.length === 0) return res.json(null);

            const iRes = await db.query(`
                SELECT ip.*, p.nome, CAST(p.imagem1 AS TEXT) as imagem1 
                FROM itens_pedido ip 
                LEFT JOIN produtos p ON ip.produto_id = p.id 
                WHERE ip.pedido_id = $1
            `, [req.params.id]);

            res.json({ pedido: pRes.rows[0], itens: iRes.rows });
        } catch (e) {
            console.error('❌ [API ERROR] Detalhes Pedido:', e);
            res.json(null);
        }
    });

    // ----------------------------------------------------------------------
    // API: MUDAR STATUS DO PEDIDO
    // ----------------------------------------------------------------------
    app.post('/api/chat/status', isAuth, async (req, res) => {
        try {
            const { pedido_id, status, conversa_id } = req.body;
            
            await db.query(`UPDATE pedidos SET status = $1 WHERE id = $2`, [status, pedido_id]);
            
            const msg = `O status do pedido mudou para: ${status.toUpperCase()}`;
            await db.query(`
                INSERT INTO mensagens (conversa_id, remetente_id, conteudo, tipo_acao, is_system, created_at)
                VALUES ($1, $2, $3, 'status', true, NOW())
            `, [conversa_id, req.session.user.id, msg]);

            res.json({ success: true });
        } catch (e) {
            console.error('❌ [API ERROR] Status:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // ----------------------------------------------------------------------
    // API: USUÁRIOS DISPONÍVEIS (STORIES)
    // ----------------------------------------------------------------------
    app.get('/api/chat/usuarios-disponiveis', isAuth, async (req, res) => {
        try {
            // Retorna vendedores ou admins, exceto eu mesmo
            const users = await db.query(`
                SELECT id, nome, nome_loja, foto_perfil 
                FROM usuarios 
                WHERE id != $1 AND (tipo = 'vendedor' OR tipo = 'admin') 
                ORDER BY nome_loja DESC LIMIT 50
            `, [req.session.user.id]);
            res.json(users.rows);
        } catch (e) { res.json([]); }
    });
};