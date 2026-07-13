-- Remover tabelas existentes
DROP TABLE IF EXISTS avaliacoes CASCADE;
DROP TABLE IF EXISTS seguidores CASCADE;
DROP TABLE IF EXISTS solicitacoes_vip CASCADE;
DROP TABLE IF EXISTS produtos CASCADE;
DROP TABLE IF EXISTS banners CASCADE;
DROP TABLE IF EXISTS filmes CASCADE;
DROP TABLE IF EXISTS categorias CASCADE;
DROP TABLE IF EXISTS usuarios CASCADE;

-- Criar tabela de usuários
CREATE TABLE usuarios (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  senha VARCHAR(255) NOT NULL,
  telefone VARCHAR(20),
  tipo VARCHAR(20) DEFAULT 'cliente' CHECK (tipo IN ('cliente', 'vendedor', 'admin')),
  nome_loja VARCHAR(255),
  descricao_loja TEXT,
  foto_perfil VARCHAR(255),
  banner_loja VARCHAR(255),
  loja_ativa BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Criar tabela de categorias
CREATE TABLE categorias (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(255) NOT NULL,
  icone VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Criar tabela de produtos
CREATE TABLE produtos (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(255) NOT NULL,
  descricao TEXT,
  preco DECIMAL(10,2) NOT NULL,
  preco_promocional DECIMAL(10,2),
  categoria_id INTEGER REFERENCES categorias(id),
  vendedor_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
  imagem1 VARCHAR(255),
  imagem2 VARCHAR(255),
  imagem3 VARCHAR(255),
  estoque INTEGER DEFAULT 0,
  ativo BOOLEAN DEFAULT true,
  destaque BOOLEAN DEFAULT false,
  vip BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Criar tabela de banners
CREATE TABLE banners (
  id SERIAL PRIMARY KEY,
  titulo VARCHAR(255),
  imagem VARCHAR(255) NOT NULL,
  link VARCHAR(255),
  ordem INTEGER DEFAULT 0,
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Criar tabela de filmes
CREATE TABLE filmes (
  id SERIAL PRIMARY KEY,
  titulo VARCHAR(255) NOT NULL,
  poster VARCHAR(255),
  trailer_url VARCHAR(255),
  sinopse TEXT,
  data_lancamento DATE,
  classificacao VARCHAR(10),
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Criar tabela de seguidores
CREATE TABLE seguidores (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
  loja_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(usuario_id, loja_id)
);

-- Criar tabela de avaliações
CREATE TABLE avaliacoes (
  id SERIAL PRIMARY KEY,
  produto_id INTEGER REFERENCES produtos(id) ON DELETE CASCADE,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
  classificacao INTEGER CHECK (classificacao >= 1 AND classificacao <= 5),
  comentario TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Criar tabela de solicitações VIP
CREATE TABLE solicitacoes_vip (
  id SERIAL PRIMARY KEY,
  produto_id INTEGER REFERENCES produtos(id) ON DELETE CASCADE,
  vendedor_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo VARCHAR(20) DEFAULT 'produto' CHECK (tipo IN ('produto', 'banner')),
  status VARCHAR(20) DEFAULT 'pendente' CHECK (status IN ('pendente', 'aprovada', 'rejeitada')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Inserir usuário administrador padrão
INSERT INTO usuarios (nome, email, senha, tipo) 
VALUES ('Administrador', 'admin@kuandashop.ao', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'admin');

-- Inserir categorias padrão
INSERT INTO categorias (nome) VALUES 
('Eletrônicos'),
('Moda e Vestuário'),
('Casa e Jardim'),
('Esportes e Lazer'),
('Beleza e Cuidados'),
('Livros e Educação'),
('Automóveis'),
('Alimentação'),
('Saúde e Bem-estar'),
('Brinquedos e Jogos'),
('Música e Instrumentos'),
('Arte e Artesanato');