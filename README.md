# <a href="https://nullchat.com.br/"> Null.chat</a>

Rede social anônima inspirada no 4chan. Sem cadastro, sem rastreio de IP, sem frescura.

## Funcionalidades

- Anonimato completo (todo usuário é `Anon_0x00`).
- Upload de imagens e vídeos com otimização automática (Sharp).
- Threads com bump automático, sage e citação (`>>123`) com preview.
- Quick Reply na página inicial.
- Catálogo visual de threads.
- Modo escuro.
- Auto-exclusão via token (o autor pode apagar o próprio post).
- Moderação via senha master oculta.
- Sistema de denúncias com painel administrativo.
- Script de backup automático do banco e uploads.

## Stack

- Frontend: HTML, CSS e JavaScript (Vanilla).
- Backend: Node.js e Express.
- Banco de dados: PostgreSQL.
- Deploy: Cloudflare Tunnel e PM2.

## Como rodar localmente

1. Clone o repositório:
   ```bash
   git clone https://github.com/beaverbit/null-chat.git
   cd null-chat
   ```

2. Instale as dependências:
   ```bash
   npm install
   ```

3. Configure o banco de dados:
   ```bash
   psql -U postgres -d nullchat -f schema.sql
   ```

4. Crie o arquivo `.env` na raiz com as seguintes variáveis:
   ```env
   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/nullchat
   PORT=3000
   ADMIN_PASSWORD=sua_senha_aqui
   ```

5. Inicie o servidor:
   ```bash
   npm start
   ```

6. Acesse `http://localhost:3000`.

## Licença

GPLv3.
