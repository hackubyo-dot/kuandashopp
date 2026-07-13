const express = require('express');
const router = express.Router();
const db = require('../config/database'); // Certifique-se que o caminho está correto

// Middleware de Autenticação
const requireAuth = (req, res, next) => {
    if (!req.session.user) {
        req.flash('error', 'Faça login para continuar');
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

// Verifica se é Admin (O QUE ESTAVA FALTANDO)
const requireAdmin = (req, res, next) => {
    if (!req.session.user || req.session.user.tipo !== 'admin') {
        req.flash('error', 'Acesso restrito a administradores');
        return res.redirect('/');
    }
    next();
};

// ROTA DE DIAGNÓSTICO (DETALHES DO PEDIDO)
router.get('/meu-pedido/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const pedidoId = req.params.id;

        // VERIFICAÇÃO 1: O ID é um número?
        if (isNaN(pedidoId)) {
            throw new Error("O ID do pedido é inválido.");
        }

        // VERIFICAÇÃO 2: Tentar buscar o pedido simples
        console.log(`Buscando pedido ${pedidoId} para usuário ${userId}`);
        
        const pedidoQuery = `
            SELECT 
                p.*,
                u.nome_loja,
                u.email as vendedor_email,
                u.telefone as vendedor_telefone
            FROM pedidos p
            LEFT JOIN usuarios u ON p.vendedor_id = u.id
            WHERE p.id = $1 AND p.usuario_id = $2
        `;
        
        const pedidoResult = await db.query(pedidoQuery, [pedidoId, userId]);

        if (pedidoResult.rows.length === 0) {
            // Se não achou, pode ser que o pedido não exista OU não pertença ao usuário
            return res.status(404).send(`
                <h1>Pedido não encontrado</h1>
                <p>Verifique se o pedido # ${pedidoId} existe e pertence ao seu usuário.</p>
                <a href="/meus-pedidos">Voltar</a>
            `);
        }

        const pedido = pedidoResult.rows[0];

        // VERIFICAÇÃO 3: Buscar itens
        const itensQuery = `
            SELECT 
                ip.*,
                prod.nome as nome_produto,
                prod.imagem1 as produto_imagem
            FROM itens_pedido ip
            LEFT JOIN produtos prod ON ip.produto_id = prod.id
            WHERE ip.pedido_id = $1
        `;
        
        const itensResult = await db.query(itensQuery, [pedidoId]);

        // Renderizar com dados seguros
        res.render('cliente/detalhes-pedido', {
            layout: false, // Desativa layout para evitar conflitos de variáveis globais
            title: `Pedido #${pedido.codigo || pedido.id}`,
            pedido: pedido,
            itens: itensResult.rows,
            user: req.session.user
        });

    } catch (error) {
        console.error('ERRO DETALHADO:', error);
        
        // MOSTRAR O ERRO NA TELA PARA VOCÊ VER
        res.status(500).send(`
            <div style="font-family: monospace; padding: 20px; background: #ffe6e6; border: 2px solid red;">
                <h2 style="color: red;">ERRO 500 ENCONTRADO</h2>
                <p><strong>Mensagem:</strong> ${error.message}</p>
                <hr>
                <p><strong>Dica de Correção:</strong></p>
                <ul>
                    <li>Se o erro for <em>"relation 'pedidos' does not exist"</em>: Você esqueceu de rodar o SQL do Passo 1.</li>
                    <li>Se o erro for <em>"db is not defined"</em>: O caminho do require('../config/database') está errado.</li>
                    <li>Se o erro for <em>"column '...' does not exist"</em>: Sua tabela está desatualizada.</li>
                </ul>
                <pre>${error.stack}</pre>
            </div>
        `);
    }
});


// ================= ROTA DE CHECKOUT (VISUALIZAR) =================
router.get('/checkout', requireAuth, async (req, res) => {
    try {
        const carrinho = req.session.carrinho || [];
        
        if (carrinho.length === 0) {
            req.flash('error', 'Seu carrinho está vazio');
            return res.redirect('/carrinho');
        }

        // Agrupar itens por vendedor para exibir separadamente
        const pedidosPorVendedor = [];
        const mapVendedores = {};

        // Recalcular totais e organizar
        for (const item of carrinho) {
            if (!mapVendedores[item.vendedor_id]) {
                mapVendedores[item.vendedor_id] = {
                    vendedor_id: item.vendedor_id,
                    vendedor_nome: item.vendedor,
                    vendedor_telefone: item.vendedor_telefone, // Importante para WhatsApp
                    itens: [],
                    subtotal: 0
                };
                pedidosPorVendedor.push(mapVendedores[item.vendedor_id]);
            }
            
            mapVendedores[item.vendedor_id].itens.push(item);
            mapVendedores[item.vendedor_id].subtotal += (parseFloat(item.preco) * parseInt(item.quantidade));
        }

        const totalGeral = carrinho.reduce((acc, item) => acc + (item.preco * item.quantidade), 0);
        const totalItens = carrinho.reduce((acc, item) => acc + item.quantidade, 0);

        res.render('checkout', {
            title: 'Finalizar Compra',
            carrinho: carrinho,
            pedidosPorVendedor: pedidosPorVendedor,
            totalGeral: totalGeral.toFixed(2),
            totalItens: totalItens,
            usuario: req.session.user
        });

    } catch (error) {
        console.error('Erro no checkout:', error);
        req.flash('error', 'Erro ao carregar checkout');
        res.redirect('/carrinho');
    }
});

// ================= ROTA DE FINALIZAR COMPRA (PROCESSAR) =================
router.post('/finalizar-compra', requireAuth, async (req, res) => {
    try {
        const carrinho = req.session.carrinho || [];
        if (carrinho.length === 0) {
            return res.json({ success: false, message: 'Carrinho vazio' });
        }

        const userId = req.session.user.id;
        const { metodo_pagamento, endereco, observacoes } = req.body;

        // Agrupar por vendedor (Multi-vendor logic)
        const gruposVendedores = {};
        carrinho.forEach(item => {
            if (!gruposVendedores[item.vendedor_id]) {
                gruposVendedores[item.vendedor_id] = { itens: [], total: 0 };
            }
            gruposVendedores[item.vendedor_id].itens.push(item);
            gruposVendedores[item.vendedor_id].total += (item.preco * item.quantidade);
        });

        // Iniciar transação (conceitual)
        const pedidosCriadosIds = [];

        for (const vendedorId in gruposVendedores) {
            const grupo = gruposVendedores[vendedorId];
            const codigoPedido = `PED-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

            // 1. Criar Pedido
            const pedidoResult = await db.query(`
                INSERT INTO pedidos (codigo, usuario_id, vendedor_id, total, metodo_pagamento, endereco_entrega, observacoes)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING id
            `, [codigoPedido, userId, vendedorId, grupo.total, metodo_pagamento, endereco, observacoes]);

            const pedidoId = pedidoResult.rows[0].id;
            pedidosCriadosIds.push(pedidoId);

            // 2. Inserir Itens e Baixar Estoque
            for (const item of grupo.itens) {
                await db.query(`
                    INSERT INTO itens_pedido (pedido_id, produto_id, quantidade, preco_unitario, subtotal)
                    VALUES ($1, $2, $3, $4, $5)
                `, [pedidoId, item.id, item.quantidade, item.preco, (item.preco * item.quantidade)]);

                // Baixar estoque
                await db.query(`
                    UPDATE produtos SET estoque = estoque - $1 WHERE id = $2
                `, [item.quantidade, item.id]);
            }

            // 3. Registrar Histórico
            await db.query(`
                INSERT INTO historico_pedidos (pedido_id, usuario_id, acao, status_novo, observacao)
                VALUES ($1, $2, 'criacao', 'pendente', 'Pedido realizado pelo cliente')
            `, [pedidoId, userId]);
        }

        // Limpar carrinho
        req.session.carrinho = [];

        res.json({ 
            success: true, 
            message: 'Pedidos realizados com sucesso!', 
            pedidosIds: pedidosCriadosIds 
        });

    } catch (error) {
        console.error('Erro ao processar compra:', error);
        res.json({ success: false, message: 'Erro interno ao processar pedido.' });
    }
});

// ================= MEUS PEDIDOS (CLIENTE) =================
router.get('/meus-pedidos', requireAuth, async (req, res) => {
    try {
        const pedidos = await db.query(`
            SELECT p.*, u.nome_loja, u.telefone as loja_telefone 
            FROM pedidos p
            JOIN usuarios u ON p.vendedor_id = u.id
            WHERE p.usuario_id = $1
            ORDER BY p.created_at DESC
        `, [req.session.user.id]);

        res.render('cliente/meus-pedidos', { // Crie este arquivo ou use um genérico
            title: 'Meus Pedidos',
            pedidos: pedidos.rows
        });
    } catch (error) {
        console.error(error);
        res.redirect('/');
    }
});


// ================= ÁREA DO VENDEDOR (GERENCIAR VENDAS) =================

// 1. DASHBOARD DE VENDAS (LISTA GERAL)
router.get('/vendedor/vendas', requireVendor, async (req, res) => {
    try {
        const vendedorId = req.session.user.id;

        // 1. Estatísticas Rápidas
        const statsQuery = `
            SELECT 
                COUNT(*) as total_pedidos,
                COUNT(CASE WHEN status = 'pendente' THEN 1 END) as pendentes,
                COALESCE(SUM(CASE WHEN status = 'entregue' THEN total ELSE 0 END), 0) as receita_total
            FROM pedidos 
            WHERE vendedor_id = $1
        `;
        const statsResult = await db.query(statsQuery, [vendedorId]);
        const stats = statsResult.rows[0];

        // 2. Lista de Pedidos (Mais recentes primeiro)
        const pedidosQuery = `
            SELECT 
                p.*, 
                u.nome as cliente_nome, 
                u.foto_perfil as cliente_foto
            FROM pedidos p
            JOIN usuarios u ON p.usuario_id = u.id
            WHERE p.vendedor_id = $1
            ORDER BY p.created_at DESC
        `;
        const pedidosResult = await db.query(pedidosQuery, [vendedorId]);

        res.render('vendedor/vendas-dashboard', {
            layout: false,
            title: 'Gestão de Vendas',
            stats: stats,
            pedidos: pedidosResult.rows,
            user: req.session.user
        });

    } catch (error) {
        console.error('Erro no dashboard de vendas:', error);
        req.flash('error', 'Erro ao carregar o painel de vendas.');
        res.redirect('/vendedor');
    }
});

// 2. VER DETALHES DO PEDIDO (VENDEDOR)
router.get('/vendedor/pedido/:id', requireVendor, async (req, res) => {
    try {
        const vendedorId = req.session.user.id;
        const pedidoId = req.params.id;

        // Buscar Pedido (Garantindo que pertence a este vendedor)
        const pedidoResult = await db.query(`
            SELECT 
                p.*,
                u.nome as cliente_nome,
                u.email as cliente_email,
                u.telefone as cliente_telefone,
                u.foto_perfil as cliente_foto
            FROM pedidos p
            JOIN usuarios u ON p.usuario_id = u.id
            WHERE p.id = $1 AND p.vendedor_id = $2
        `, [pedidoId, vendedorId]);

        if (pedidoResult.rows.length === 0) {
            req.flash('error', 'Pedido não encontrado ou acesso negado.');
            return res.redirect('/vendedor/vendas');
        }

        const pedido = pedidoResult.rows[0];

        // Buscar Itens
        const itensResult = await db.query(`
            SELECT ip.*, prod.nome as produto_nome, prod.imagem1
            FROM itens_pedido ip
            LEFT JOIN produtos prod ON ip.produto_id = prod.id
            WHERE ip.pedido_id = $1
        `, [pedidoId]);

        res.render('vendedor/detalhes-pedido', {
            layout: false,
            title: `Gerenciar Pedido #${pedido.codigo}`,
            pedido: pedido,
            itens: itensResult.rows,
            user: req.session.user
        });

    } catch (error) {
        console.error('Erro detalhes vendedor:', error);
        res.redirect('/vendedor/vendas');
    }
});

// 3. ATUALIZAR STATUS DO PEDIDO
router.post('/vendedor/pedido/:id/status', requireVendor, async (req, res) => {
    try {
        const { status } = req.body;
        const pedidoId = req.params.id;
        const vendedorId = req.session.user.id;

        // Atualizar status no banco
        await db.query(`
            UPDATE pedidos 
            SET status = $1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $2 AND vendedor_id = $3
        `, [status, pedidoId, vendedorId]);

        // Registrar no histórico (Opcional, mas bom ter)
        await db.query(`
            INSERT INTO historico_pedidos (pedido_id, usuario_id, acao, status_novo, observacao)
            VALUES ($1, $2, 'alteracao_status', $3, 'Alterado pelo vendedor')
        `, [pedidoId, vendedorId, status]);

        req.flash('success', `Status atualizado para ${status.toUpperCase()}`);
        res.redirect(`/vendedor/pedido/${pedidoId}`);

    } catch (error) {
        console.error('Erro ao atualizar status:', error);
        req.flash('error', 'Erro ao atualizar status.');
        res.redirect(`/vendedor/pedido/${req.params.id}`);
    }
});

// ================= ÁREA DO CLIENTE (QUEM COMPROU) =================

// 1. LISTA DE MEUS PEDIDOS
router.get('/meus-pedidos', requireAuth, async (req, res) => {
    try {
        // Busca pedidos onde o usuario_id é o usuário logado
        // Faz JOIN com usuario (vendedor) para mostrar o nome da loja
        const pedidos = await db.query(`
            SELECT p.*, u.nome_loja, u.telefone as vendedor_telefone
            FROM pedidos p
            JOIN usuarios u ON p.vendedor_id = u.id
            WHERE p.usuario_id = $1
            ORDER BY p.created_at DESC
        `, [req.session.user.id]);

        res.render('cliente/meus-pedidos', {
            title: 'Histórico de Compras',
            pedidos: pedidos.rows,
            user: req.session.user
        });
    } catch (error) {
        console.error('Erro ao listar meus pedidos:', error);
        req.flash('error', 'Erro ao carregar seus pedidos.');
        res.redirect('/');
    }
});

// 2. DETALHES DE UM PEDIDO ESPECÍFICO
// ROTA: DETALHES DO PEDIDO (CLIENTE)
router.get('/meu-pedido/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const pedidoId = req.params.id;

        // 1. Buscar o pedido com dados da loja (vendedor)
        // Usamos LEFT JOIN para não quebrar se o vendedor tiver sido deletado
        const pedidoResult = await db.query(`
            SELECT 
                p.*,
                u.nome_loja,
                u.email as vendedor_email,
                u.telefone as vendedor_telefone,
                u.foto_perfil as vendedor_foto
            FROM pedidos p
            LEFT JOIN usuarios u ON p.vendedor_id = u.id
            WHERE p.id = $1 AND p.usuario_id = $2
        `, [pedidoId, userId]);

        if (pedidoResult.rows.length === 0) {
            req.flash('error', 'Pedido não encontrado.');
            return res.redirect('/meus-pedidos');
        }

        const pedido = pedidoResult.rows[0];

        // 2. Buscar os itens do pedido com imagem e nome do produto
        const itensResult = await db.query(`
            SELECT 
                ip.*,
                prod.nome as produto_nome,
                prod.imagem1 as produto_imagem
            FROM itens_pedido ip
            LEFT JOIN produtos prod ON ip.produto_id = prod.id
            WHERE ip.pedido_id = $1
        `, [pedidoId]);

        // 3. Renderizar a tela com layout: false para não dar conflito
        res.render('cliente/detalhes-pedido', {
            layout: false, // Importante: desativa o layout padrão para usar o HTML completo abaixo
            title: `Pedido #${pedido.codigo}`,
            pedido: pedido,
            itens: itensResult.rows,
            user: req.session.user
        });

    } catch (error) {
        console.error('Erro ao carregar detalhes do pedido:', error);
        // Em vez de tela de erro, volta para a lista com aviso
        req.flash('error', 'Erro técnico ao abrir o pedido. Tente novamente.');
        res.redirect('/meus-pedidos');
    }
});

// ================= ÁREA DO ADMIN (SUPERVISÃO GERAL) =================

// ROTA: /admin/vendas
router.get('/admin/vendas', requireAdmin, async (req, res) => {
    try {
        console.log("=== CARREGANDO PAINEL ADMIN VENDAS ===");

        // Executar todas as consultas em paralelo para ser rápido
        const [geral, status, topLojas, topProdutos, ultimosPedidos] = await Promise.all([
            // 1. Totais Gerais
            db.query(`
                SELECT 
                    COUNT(*) as total_pedidos,
                    COALESCE(SUM(CASE WHEN status != 'cancelado' THEN total ELSE 0 END), 0) as receita_total,
                    AVG(CASE WHEN status != 'cancelado' THEN total ELSE 0 END) as ticket_medio,
                    (SELECT COUNT(*) FROM usuarios WHERE tipo = 'vendedor') as total_vendedores,
                    (SELECT COUNT(*) FROM usuarios WHERE tipo = 'cliente') as total_clientes
                FROM pedidos
            `),

            // 2. Contagem por Status
            db.query(`SELECT status, COUNT(*) as qtd FROM pedidos GROUP BY status`),

            // 3. Top 5 Lojas
            db.query(`
                SELECT u.nome_loja, u.foto_perfil, COUNT(p.id) as qtd_pedidos, SUM(p.total) as total_vendido
                FROM pedidos p
                JOIN usuarios u ON p.vendedor_id = u.id
                WHERE p.status != 'cancelado'
                GROUP BY u.id, u.nome_loja, u.foto_perfil
                ORDER BY total_vendido DESC LIMIT 5
            `),

            // 4. Top 5 Produtos
            db.query(`
                SELECT prod.nome, prod.imagem1, SUM(ip.quantidade) as total_vendido
                FROM itens_pedido ip
                JOIN produtos prod ON ip.produto_id = prod.id
                JOIN pedidos p ON ip.pedido_id = p.id
                WHERE p.status != 'cancelado'
                GROUP BY prod.id, prod.nome, prod.imagem1
                ORDER BY total_vendido DESC LIMIT 5
            `),

            // 5. Últimos 20 Pedidos
            db.query(`
                SELECT p.*, u.nome_loja, cli.nome as cliente_nome
                FROM pedidos p
                LEFT JOIN usuarios u ON p.vendedor_id = u.id
                LEFT JOIN usuarios cli ON p.usuario_id = cli.id
                ORDER BY p.created_at DESC LIMIT 20
            `)
        ]);

        // Processar mapa de status para não dar erro se vier vazio
        const statusMap = { pendente: 0, confirmado: 0, enviado: 0, entregue: 0, cancelado: 0 };
        status.rows.forEach(s => {
            if (s.status) statusMap[s.status] = parseInt(s.qtd);
        });

        // Renderizar a nova view 'vendas.ejs'
        res.render('admin/vendas', {
            layout: false, // Desativa layout para evitar conflitos
            title: 'Gestão Global de Vendas',
            stats: geral.rows[0],
            statusCount: statusMap,
            topLojas: topLojas.rows,
            topProdutos: topProdutos.rows,
            pedidos: ultimosPedidos.rows,
            user: req.session.user
        });

    } catch (error) {
        console.error('ERRO NO ADMIN VENDAS:', error);
        // Mostra o erro na tela para facilitar
        res.status(500).send(`
            <div style="padding:20px; font-family:monospace; background:#fff0f0; border:2px solid red; color:red;">
                <h1>Erro 500 - Admin Vendas</h1>
                <p>${error.message}</p>
                <hr>
                <p>Verifique se o arquivo <b>views/admin/vendas.ejs</b> existe.</p>
                <pre>${error.stack}</pre>
            </div>
        `);
    }
});

module.exports = router;