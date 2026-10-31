require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const sanitizeHtml = require('sanitize-html');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const sharp = require('sharp');
const FileType = require('file-type');

if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 20) {
  console.error('ERRO FATAL: ADMIN_PASSWORD não definida ou muito curta (mínimo 20 caracteres).');
  process.exit(1);
}

// NOVO: Whitelist de boards
const BOARDS = new Set(['b', 'g', 'a', 'v', 'pol']);

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_SIZE = (parseInt(process.env.MAX_FILE_SIZE_MB) || 20) * 1024 * 1024;

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      mediaSrc: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// NOVO: Tipos de arquivo exatos (sem PDF, sem MKV, etc)
const IMG = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const VID = new Set(['video/mp4', 'video/webm']);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    cb(null, crypto.randomUUID() + '.tmp');
  }
});

// NOVO: Limites do multer (files, fields, parts)
const upload = multer({
  storage,
  limits: { 
    fileSize: MAX_SIZE,
    files: 1,
    fields: 5,
    parts: 7,
    fieldSize: 10000
  }
});

app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self';");
  }
}));

const postLimiter = rateLimit({
  windowMs: 60 * 1000, max: 15,
  message: { error: 'Calma aí, muito post em pouco tempo.' },
  keyGenerator: (req) => req.ip
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { error: 'Muitas tentativas de admin. Tente novamente em 15 minutos.' },
  keyGenerator: (req) => req.ip
});

function anonIdFromId(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 6);
}

// NOVO: Funções de comparação segura (timing safe)
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function serializePost(row) {
  return {
    id: row.id, board: row.board, content: row.content,
    mediaUrl: row.media_path ? `/uploads/${row.media_path}` : null,
    mediaType: row.media_type, replyTo: row.reply_to,
    anonId: row.anon_id, sage: row.sage, createdAt: row.created_at
  };
}

function deleteFileSafe(filename) {
  if (!filename) return;
  const filePath = path.join(UPLOAD_DIR, filename);
  fs.unlink(filePath, (err) => { if (err) console.error(`Erro ao deletar: ${filename}`); });
}

// --- Rotas ---

app.get('/api/boards/:board', async (req, res) => {
  const board = req.params.board;
  if (!BOARDS.has(board)) return res.status(404).json({ error: 'Board inválido' });
  
  let page = parseInt(req.query.page, 10);
  if (!Number.isInteger(page) || page < 1) page = 1;
  if (page > 1000) page = 1000;

  const limit = 15;
  const offset = (page - 1) * limit;

  try {
    const { rows } = await pool.query(
      `SELECT p.*, (SELECT COUNT(*) FROM posts r WHERE r.reply_to = p.id) AS reply_count
       FROM posts p WHERE p.board = $1 AND p.reply_to IS NULL
       ORDER BY p.bumped_at DESC LIMIT $2 OFFSET $3`,
      [board, limit, offset]
    );
    res.json(rows.map(r => ({ ...serializePost(r), replyCount: Number(r.reply_count) })));
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Erro ao listar posts' });
  }
});

app.get('/api/posts/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  try {
    const { rows: postRows } = await pool.query(`SELECT * FROM posts WHERE id = $1`, [id]);
    if (!postRows.length) return res.status(404).json({ error: 'Post não encontrado' });
    const { rows: replyRows } = await pool.query(`SELECT * FROM posts WHERE reply_to = $1 ORDER BY created_at ASC`, [id]);
    res.json({ post: serializePost(postRows[0]), replies: replyRows.map(serializePost) });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Erro ao buscar thread' });
  }
});

app.post('/api/boards/:board', postLimiter, upload.single('media'), async (req, res) => {
  let newPath = null;
  try {
    let board = req.params.board;
    if (!BOARDS.has(board)) {
      if (req.file) deleteFileSafe(req.file.filename);
      return res.status(404).json({ error: 'Board inválido.' });
    }

    const rawContent = (req.body.content || '').toString().slice(0, 5000);
    let replyTo = parseInt(req.body.replyTo, 10);
    if (!Number.isInteger(replyTo) || replyTo > 2147483647) replyTo = null;

    // NOVO: Só permite responder a um Post Principal (OP), herdando o board dele
    if (replyTo) {
      const { rows: parent } = await pool.query(
        'SELECT board FROM posts WHERE id = $1 AND reply_to IS NULL', [replyTo]);
      if (!parent.length) {
        if (req.file) deleteFileSafe(req.file.filename);
        return res.status(400).json({ error: 'O post original não existe ou não é um post principal.' });
      }
      board = parent[0].board;
    }

    const isSage = req.body.sage === 'true';
    let content = sanitizeHtml(rawContent, { allowedTags: [], allowedAttributes: {} });
    content = content.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

    if (!content.trim() && !req.file) return res.status(400).json({ error: 'Post vazio' });

    let mediaType = null;

    if (req.file) {
      const filePath = path.join(UPLOAD_DIR, req.file.filename);
      const type = await FileType.fromFile(filePath);
      
      const isImage = !!type && IMG.has(type.mime);
      const isVideo = !!type && VID.has(type.mime);

      if (!isImage && !isVideo) {
        deleteFileSafe(req.file.filename);
        return res.status(400).json({ error: 'Arquivo inválido. Envie imagens (JPG, PNG, GIF, WebP) ou vídeos (MP4, WebM).' });
      }

      const finalExt = isImage ? 'webp' : type.ext;
      const newFilename = crypto.randomUUID() + '.' + finalExt;
      newPath = path.join(UPLOAD_DIR, newFilename);

      if (isImage) {
        // NOVO: sharp.concurrency(1) para não travar o celular
        sharp.concurrency(1); 
        await sharp(filePath, { limitInputPixels: 40e6 })
          .rotate()
          .resize({ width: 1200, withoutEnlargement: true })
          .webp({ quality: 80, effort: 4 })
          .toFile(newPath);
        deleteFileSafe(req.file.filename);
        req.file.filename = newFilename;
        mediaType = 'image';
      } else {
        fs.renameSync(filePath, newPath);
        req.file.filename = newFilename;
        mediaType = 'video';
      }
    }

    const mediaPath = req.file ? req.file.filename : null;
    const deleteToken = crypto.randomUUID();
    // NOVO: Guarda o hash do token no banco, não o token puro
    const deleteTokenHash = sha(deleteToken).toString('hex');

    const { rows } = await pool.query(
      `INSERT INTO posts (board, content, media_path, media_type, reply_to, anon_id, bumped_at, delete_token, sage)
       VALUES ($1, $2, $3, $4, $5, 'pending', NOW(), $6, $7) RETURNING id`,
      [board, content, mediaPath, mediaType, replyTo, deleteTokenHash, isSage]
    );
    const id = rows[0].id;
    const anonId = anonIdFromId(id);
    await pool.query(`UPDATE posts SET anon_id = $1 WHERE id = $2`, [anonId, id]);

    if (replyTo && !isSage) {
      await pool.query(`UPDATE posts SET bumped_at = NOW() WHERE id = $1`, [replyTo]);
    }

    const { rows: full } = await pool.query(`SELECT * FROM posts WHERE id = $1`, [id]);
    res.status(201).json({ ...serializePost(full[0]), deleteToken });
  } catch (err) {
    console.error(err);
    if (req.file) deleteFileSafe(req.file.filename);
    if (newPath) deleteFileSafe(path.basename(newPath)); // NOVO: limpa arquivo parcial
    res.status(500).json({ error: 'Erro interno ao criar post' });
  }
});

app.delete('/api/posts/:id', adminLimiter, async (req, res) => {
  const token = req.headers['x-delete-token'];
  if (!token) return res.status(401).json({ error: 'Token de exclusão ausente.' });

  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  try {
    const { rows } = await pool.query('SELECT media_path, delete_token FROM posts WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Post não encontrado' });

    // NOVO: Comparação segura (timing safe) para o token e senha
    const isOwner = safeEq(rows[0].delete_token, sha(token).toString('hex'));
    const isAdmin = safeEq(token, process.env.ADMIN_PASSWORD);

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Você não tem permissão para apagar este post.' });
    }

    let filesToDelete = [];
    if (rows[0].media_path) filesToDelete.push(rows[0].media_path);

    const { rows: replies } = await pool.query('SELECT media_path FROM posts WHERE reply_to = $1', [id]);
    replies.forEach(r => { if (r.media_path) filesToDelete.push(r.media_path); });

    await pool.query('DELETE FROM posts WHERE id = $1', [id]);
    filesToDelete.forEach(deleteFileSafe);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao deletar post' });
  }
});

const reportLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, keyGenerator: (req) => req.ip });
app.post('/api/posts/:id/report', reportLimiter, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const reason = sanitizeHtml((req.body.reason || '').toString().slice(0, 500), { allowedTags: [] });

    if (!id || !reason.trim()) return res.status(400).json({ error: 'Motivo da denúncia obrigatório.' });
    const { rowCount } = await pool.query('SELECT 1 FROM posts WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Post não encontrado.' });

    await pool.query('INSERT INTO reports (post_id, reason) VALUES ($1, $2)', [id, reason]);
    res.status(201).json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao registrar denúncia.' });
  }
});

app.get('/api/reports', adminLimiter, async (req, res) => {
  const adminPass = req.headers['x-admin-password'];
  // NOVO: Comparação segura
  if (!adminPass || !safeEq(adminPass, process.env.ADMIN_PASSWORD)) {
    console.warn(`[SECURITY] Tentativa de acesso admin falhou.`);
    return res.status(401).json({ error: 'Não autorizado.' });
  }

  try {
    const { rows } = await pool.query(`
      SELECT r.*, p.content, p.media_path, p.anon_id 
      FROM reports r 
      JOIN posts p ON p.id = r.post_id 
      ORDER BY r.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar reports' });
  }
});

// NOVO: Error handler não vaza mais a mensagem interna do erro
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `Arquivo muito grande (max ${MAX_SIZE / (1024*1024)}MB)` });
  }
  if (err) {
    console.error(err); // Loga o erro real no console pra você ver
    return res.status(400).json({ error: 'Erro na requisição.' });
  }
});

app.listen(PORT, '127.0.0.1', () => console.log(`Null.chat rodando em http://localhost:${PORT}`));
