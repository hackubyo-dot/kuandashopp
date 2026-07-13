# KuandaShop - Marketplace Multi-Vendor Angolano

## 🇦🇴 Sobre o Projeto

KuandaShop é um marketplace multi-vendor desenvolvido especificamente para Angola, permitindo que qualquer pessoa crie sua conta de vendedor, publique produtos e venda através da plataforma. As vendas são realizadas via WhatsApp, proporcionando uma experiência familiar aos usuários angolanos.

## ✨ Funcionalidades Principais

### 👥 Para Usuários
- **Registro e Login**: Sistema completo de autenticação
- **Navegação por Produtos**: Catálogo completo com filtros e busca
- **Carrinho de Compras**: Adicionar produtos e finalizar via WhatsApp
- **Explorar Lojas**: Descobrir vendedores e suas lojas
- **Perfil Pessoal**: Gerenciar dados pessoais

### 🏪 Para Vendedores
- **Painel do Vendedor**: Dashboard completo com estatísticas
- **Gestão de Produtos**: Adicionar, editar e remover produtos
- **Múltiplas Imagens**: Até 3 fotos por produto
- **Promoções**: Preços promocionais e ofertas especiais
- **Solicitações VIP**: Promover produtos para destaque
- **Perfil da Loja**: Personalizar informações da loja

### 👑 Para Administradores
- **Dashboard Administrativo**: Visão geral do sistema
- **Gestão de Vendedores**: Ativar/desativar lojas
- **Aprovação VIP**: Gerenciar solicitações de produtos VIP
- **Controle de Conteúdo**: Banners e filmes do cinema

## 🛠️ Tecnologias Utilizadas

### Backend
- **Node.js** + **Express.js**
- **PostgreSQL** (Neon Database)
- **EJS** (Template Engine)
- **Multer** (Upload de arquivos)
- **bcryptjs** (Criptografia de senhas)
- **Express Session** (Gerenciamento de sessões)

### Frontend
- **HTML5** semântico
- **CSS3** + **SASS**
- **Bootstrap 5**
- **Tailwind CSS**
- **Font Awesome** (Ícones)
- **JavaScript** vanilla

### Design
- **Paleta de cores da bandeira de Angola**
- **Design responsivo e moderno**
- **UX otimizada para mobile**
- **Animações e transições suaves**

## 🚀 Instalação e Configuração

### Pré-requisitos
- Node.js (v16 ou superior)
- npm ou yarn
- Conta no Neon Database (PostgreSQL)

### Passos para Instalação

1. **Clone o repositório**
```bash
git clone <repository-url>
cd kuandashop-marketplace
```

2. **Instale as dependências**
```bash
npm install
```

3. **Configure as variáveis de ambiente**
```bash
cp .env.example .env
# Edite o arquivo .env com suas configurações
```

4. **Inicie o servidor**
```bash
# Desenvolvimento
npm run dev

# Produção
npm start
```

5. **Acesse a aplicação**
```
http://localhost:3000
```

## 📊 Estrutura do Banco de Dados

### Tabelas Principais
- **usuarios**: Dados dos usuários (clientes, vendedores, admin)
- **produtos**: Catálogo de produtos
- **categorias**: Categorias dos produtos
- **avaliacoes**: Sistema de avaliações
- **seguidores**: Seguidores das lojas
- **solicitacoes_vip**: Solicitações de produtos VIP
- **banners**: Banners promocionais
- **filmes**: Filmes do cinema

## 🎨 Características do Design

### Paleta de Cores
- **Vermelho**: #ce1126 (Bandeira de Angola)
- **Amarelo**: #ffcd00 (Bandeira de Angola)
- **Preto**: #000000 (Bandeira de Angola)
- **Cinza Claro**: #f8f9fa
- **Cinza Escuro**: #343a40

### Componentes Visuais
- Cards com sombras e bordas arredondadas
- Gradientes inspirados na bandeira angolana
- Animações suaves de hover e transição
- Menu hamburger moderno
- Sistema de badges e status visuais

## 📱 Funcionalidades Mobile

- Design 100% responsivo
- Menu lateral deslizante
- Touch-friendly interfaces
- Otimização para conexões lentas
- Suporte a gestos nativos

## 🔐 Sistema de Autenticação

### Tipos de Usuário
1. **Cliente**: Comprar produtos, seguir lojas
2. **Vendedor**: Vender produtos, gerenciar loja
3. **Administrador**: Controle total do sistema

### Segurança
- Senhas criptografadas com bcrypt
- Sessões seguras
- Validação de dados no frontend e backend
- Proteção contra ataques comuns

## 💬 Integração WhatsApp

- Finalização de compras via WhatsApp
- Mensagens pré-formatadas com detalhes do produto
- Links diretos para conversas com vendedores
- Suporte a múltiplos vendedores por compra

## 🎯 Recursos Especiais

### Sistema VIP
- Produtos em destaque na homepage
- Badge dourado de identificação
- Prioridade nas buscas
- Processo de aprovação pelo admin

### Cinema Zap
- Seção dedicada a filmes
- Posters e informações dos filmes
- Integração com entretenimento local

### Ofertas e Promoções
- Preços promocionais
- Badges de oferta
- Cálculo automático de desconto
- Destaque visual para ofertas

## 📈 Métricas e Analytics

### Dashboard do Vendedor
- Total de produtos
- Produtos ativos
- Número de seguidores
- Avaliação média
- Produtos recentes

### Dashboard Administrativo
- Total de vendedores e clientes
- Produtos cadastrados
- Solicitações VIP pendentes
- Estatísticas do sistema

## 🌟 Diferenciais

1. **Foco no Mercado Angolano**: Design e funcionalidades pensadas para Angola
2. **Integração WhatsApp**: Vendas através da plataforma mais popular
3. **Sistema VIP**: Monetização através de produtos em destaque
4. **Design Profissional**: Nível Alibaba/AliExpress/Shopify
5. **Responsividade Total**: Funciona perfeitamente em todos os dispositivos
6. **Facilidade de Uso**: Interface intuitiva e amigável

## 🔧 Manutenção e Suporte

### Logs e Monitoramento
- Logs detalhados de erros
- Monitoramento de performance
- Backup automático do banco

### Atualizações
- Sistema modular para fácil manutenção
- Versionamento semântico
- Documentação completa

## 📞 Contato e Suporte

- **Email**: contato@kuandashop.ao
- **WhatsApp**: +244 900 000 000
- **Endereço**: Luanda, Angola

## 📄 Licença

Este projeto está sob a licença MIT. Veja o arquivo `LICENSE` para mais detalhes.

## 🤝 Contribuição

Contribuições são bem-vindas! Por favor, leia as diretrizes de contribuição antes de submeter pull requests.

---

**KuandaShop** - Conectando Angola através do comércio eletrônico 🇦🇴
