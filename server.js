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
const FileType = require('file-type'); // NOVA DEPENDÊNCIA

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_SIZE = (parseInt(process.env.MAX_FILE_SIZE_MB) || 20) * 1024 * 1024;

// --- SEGURANÇA: Helmet com CSP Restritivo ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // unsafe-inline necessário pros scripts do index.html
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      mediaSrc: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false, // Necessário para alguns vídeos funcionarem
}));

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const ALLOWED_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'application/pdf', 'application/octet-stream'
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 8);
    const safeExt = /^\.[a-z0-9]+$/.test(ext) ? ext : '';
    cb(null, crypto.randomUUID() + safeExt);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/') || file.mimetype === 'application/pdf' || file.mimetype === 'application/octet-stream') {
      return cb(null, true);
    }
    cb(new Error('Tipo de arquivo não permitido. Apenas imagens, vídeos e PDFs.'));
  }
});

app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self';");
  }
}));

// Rate limit geral para posts
const postLimiter = rateLimit({
  windowMs: 60 * 1000, max: 15,
  message: { error: 'Calma aí, muito post em pouco tempo.' }
});

// NOVO: Rate limit rígido para o Admin (anti força bruta)
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10, // Máximo de 10 tentativas
  message: { error: 'Muitas tentativas de admin. Tente novamente em 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function anonIdFromId(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 6);
}

function serializePost(row) {
  return {
    id: row.id,
    board: row.board,
    content: row.content,
    mediaUrl: row.media_path ? `/uploads/${row.media_path}` : null,
    mediaType: row.media_type,
    replyTo: row.reply_to,
    anonId: row.anon_id,
    sage: row.sage,
    createdAt: row.created_at
  };
}

function deleteFileSafe(filename) {
  if (!filename) return;
  const filePath = path.join(UPLOAD_DIR, filename);
  fs.unlink(filePath, (err) => { if (err) console.error(`Erro ao deletar: ${filename}`); });
}

// --- Rotas ---

app.get('/api/boards/:board', async (req, res) => {
  const board = req.params.board.slice(0, 16);
  const page = parseInt(req.query.page, 10) || 1;
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
  const board = req.params.board.slice(0, 16);
  const rawContent = (req.body.content || '').toString().slice(0, 5000);
  const replyTo = req.body.replyTo ? parseInt(req.body.replyTo, 10) : null;
  const isSage = req.body.sage === 'true';
  
  let content = sanitizeHtml(rawContent, { allowedTags: [], allowedAttributes: {} });
  content = content.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

  if (!content.trim() && !req.file) return res.status(400).json({ error: 'Post vazio' });

  let mediaType = null;
  
  if (req.file) {
    // NOVO: Validação de Magic Bytes (segurança contra arquivos renomeados)
    try {
      const filePath = path.join(UPLOAD_DIR, req.file.filename);
      const fileBuffer = fs.readFileSync(filePath);
      const type = await FileType.fromBuffer(fileBuffer);
      
      const isImage = type && type.mime.startsWith('image/');
      const isVideo = type && type.mime.startsWith('video/');
      const isPdf = type && type.mime === 'application/pdf';

      if (!isImage && !isVideo && !isPdf) {
        deleteFileSafe(req.file.filename);
        return res.status(400).json({ error: 'Arquivo inválido ou corrompido.' });
      }

      if (isImage) {
        // Otimização com Sharp
        const optimizedPath = path.join(UPLOAD_DIR, `opt_${req.file.filename}.webp`);
        await sharp(filePath)
          .resize({ width: 1200, withoutEnlargement: true })
          .webp({ quality: 80 })
          .toFile(optimizedPath);

        deleteFileSafe(req.file.filename);
        req.file.filename = `opt_${req.file.filename}.webp`;
        req.file.mimetype = 'image/webp';
        mediaType = 'image';
      } else if (isVideo) {
        mediaType = 'video';
      } else if (isPdf) {
        mediaType = 'pdf';
      }

    } catch (err) {
      console.error(err);
      deleteFileSafe(req.file.filename);
      return res.status(400).json({ error: 'Erro ao processar o arquivo.' });
    }
  }

  if (replyTo) {
    const { rowCount } = await pool.query('SELECT 1 FROM posts WHERE id = $1', [replyTo]);
    if (rowCount === 0) {
      if (req.file) deleteFileSafe(req.file.filename);
      return res.status(400).json({ error: 'O post original não existe.' });
    }
  }

  const mediaPath = req.file ? req.file.filename : null;
  const deleteToken = crypto.randomUUID();

  try {
    const { rows } = await pool.query(
      `INSERT INTO posts (board, content, media_path, media_type, reply_to, anon_id, bumped_at, delete_token, sage)
       VALUES ($1, $2, $3, $4, $5, 'pending', NOW(), $6, $7) RETURNING id`,
      [board, content, mediaPath, mediaType, replyTo, deleteToken, isSage]
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
    res.status(500).json({ error: 'Erro ao criar post' });
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

    const isOwner = rows[0].delete_token === token;
    const isAdmin = token === process.env.ADMIN_PASSWORD;

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Você não tem permissão para apagar este post.' });
    }

    const mediaPath = rows[0].media_path;
    await pool.query('DELETE FROM posts WHERE id = $1', [id]);
    if (mediaPath) deleteFileSafe(mediaPath);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao deletar post' });
  }
});

const reportLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });
app.post('/api/posts/:id/report', reportLimiter, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const reason = sanitizeHtml((req.body.reason || '').toString().slice(0, 500), { allowedTags: [] });

  if (!id || !reason.trim()) return res.status(400).json({ error: 'Motivo da denúncia obrigatório.' });

  try {
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
  if (adminPass !== process.env.ADMIN_PASSWORD) {
    // Log simples de tentativa falha (A09 do OWASP)
    console.warn(`[SECURITY] Tentativa de acesso admin falhou. IP não logado por privacidade.`);
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

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `Arquivo muito grande (max ${MAX_SIZE / (1024*1024)}MB)` });
  }
  if (err) return res.status(400).json({ error: err.message || 'Erro' });
});

app.listen(PORT, () => console.log(`Null.chat rodando em http://localhost:${PORT}`));
