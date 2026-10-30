let currentBoard = 'b';
let currentPage = 1;
let lastPostCount = 0;
const maxSize = 20 * 1024 * 1024;

function applyTheme() {
  if (localStorage.getItem('theme') === 'dark') {
    document.body.classList.add('dark-mode');
    document.getElementById('darkModeBtn').textContent = '☀️';
  } else {
    document.body.classList.remove('dark-mode');
    document.getElementById('darkModeBtn').textContent = '🌙';
  }
}

function getMyTokens() {
  try { return JSON.parse(localStorage.getItem('myPosts') || '{}'); } 
  catch { return {}; }
}
function saveMyToken(id, token) {
  const t = getMyTokens(); t[id] = token; localStorage.setItem('myPosts', JSON.stringify(t));
}
function removeMyToken(id) {
  const t = getMyTokens(); delete t[id]; localStorage.setItem('myPosts', JSON.stringify(t));
}
function isAdmin() {
  // Mudança: usa sessionStorage em vez de localStorage
  return sessionStorage.getItem('adminPass') !== null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function renderContent(text) {
  let html = escapeHtml(text);
  html = html.replace(/&gt;&gt;(\d+)/g, '<a href="#post-$1" class="post-ref" data-id="$1">&gt;&gt;$1</a>');
  return html.split('\n').map(line => line.startsWith('&gt;') && !line.startsWith('&gt;&gt;') ? `<span class="quote">${line}</span>` : line).join('\n');
}
function formatDate(iso) {
  const d = new Date(iso); const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function renderMedia(p) {
  if (!p.mediaUrl) return '';
  if (p.mediaType === 'video') {
    return `<div class="media"><video src="${escapeHtml(p.mediaUrl)}" controls preload="metadata" controlsList="nodownload noplaybackrate" disablePictureInPicture oncontextmenu="return false;"></video></div>`;
  }
  return `<div class="media"><img src="${escapeHtml(p.mediaUrl)}" alt="mídia" loading="lazy"></div>`;
}

function toggleQuickReply(id) {
  const container = document.getElementById(`quick-reply-${id}`);
  if (container.style.display === 'none') {
    container.style.display = 'block';
    container.querySelector('textarea').focus();
  } else {
    container.style.display = 'none';
  }
}

async function submitQuickReply(event, id) {
  event.preventDefault();
  const form = event.target;
  const btn = form.querySelector('button[type="submit"]');
  const fd = new FormData(form);
  fd.append('replyTo', id);
  if (form.querySelector('input[name="sage"]').checked) fd.append('sage', 'true');
  else fd.append('sage', 'false');

  btn.disabled = true; btn.textContent = 'Enviando...';

  try {
    const res = await fetch(`/api/boards/${currentBoard}`, { method: 'POST', body: fd });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || 'Erro ao responder'); }
    const data = await res.json();
    saveMyToken(data.id, data.deleteToken);
    form.reset();
    toggleQuickReply(id);
    await loadPosts();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Responder';
  }
}

async function reportPost(id) {
  const reason = prompt('Motivo da denúncia (opcional):', 'Conteúdo impróprio');
  if (reason === null) return;
  try {
    const res = await fetch(`/api/posts/${id}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    if (!res.ok) throw new Error('Erro ao denunciar');
    alert('Denúncia registrada. Obrigado!');
  } catch (err) { alert(err.message); }
}

async function loadReports() {
  // Mudança: usa sessionStorage em vez de localStorage
  const adminPass = sessionStorage.getItem('adminPass');
  if (!adminPass) return;

  try {
    const res = await fetch('/api/reports', { headers: { 'x-admin-password': adminPass } });
    if (!res.ok) return;
    const reports = await res.json();
    const container = document.getElementById('reportsContainer');
    if (!reports.length) {
      container.innerHTML = '<p style="text-align:center;color:var(--text-muted);">Nenhuma denúncia pendente.</p>';
      return;
    }
    container.innerHTML = reports.map(r => `
      <div style="border-bottom:1px solid var(--border); padding:6px 0;">
        <strong>Post #${r.anon_id}</strong> - Motivo: ${escapeHtml(r.reason)}<br>
        <small>${formatDate(r.created_at)}</small><br>
        <a href="/thread.html?id=${r.post_id}" target="_blank">Ver thread</a> | 
        <a href="#" onclick="deletePost(${r.post_id}); return false;">Apagar Post</a>
      </div>
    `).join('');
  } catch (err) { console.error(err); }
}

function buildPaginationHTML() {
  if (currentPage === 1) return `<a href="#" onclick="changePage(2); return false;">[ Próxima Página &rarr; ]</a>`;
  return `
    <a href="#" onclick="changePage(${currentPage - 1}); return false;">[ &larr; Anterior ]</a>
    <span>Página ${currentPage}</span>
    <a href="#" onclick="changePage(${currentPage + 1}); return false;">[ Próxima &rarr; ]</a>
  `;
}

function renderPosts(posts) {
  const container = document.getElementById('threads');
  if (!posts.length) {
    container.innerHTML = '<p class="empty">Nenhum post ainda. Seja o primeiro.</p>';
    document.getElementById('pagination-top').innerHTML = '';
    document.getElementById('pagination').innerHTML = '';
    document.getElementById('statsBar').textContent = 'Posts: 0 | Threads: 0';
    return;
  }
  
  const myTokens = getMyTokens();
  const admin = isAdmin();
  const threadCount = posts.length;
  const postCount = posts.reduce((acc, p) => acc + 1 + (p.replyCount || 0), 0);
  document.getElementById('statsBar').textContent = `Threads: ${threadCount} | Posts: ${postCount}`;

  container.innerHTML = posts.map(p => {
    const canDelete = !!myTokens[p.id] || admin;
    return `
    <article class="thread" id="post-${p.id}">
      <div onclick="if(!event.target.closest('a') && !event.target.closest('video') && !event.target.closest('.quick-reply-box')) window.location.href='/thread.html?id=${p.id}';" style="cursor:pointer; display: table; width: 100%;">
        ${renderMedia(p)}
        <div class="content">
          <div class="post-header">
            <span class="name">Anon_0x00</span>
            <span class="anon-id">#${escapeHtml(p.anonId)}</span>
            <span class="date">${formatDate(p.createdAt)}</span>
            ${p.sage ? `<span style="color:#d00; font-size:10px; margin-left:6px;">[sage]</span>` : ''}
            ${canDelete ? `<a href="#" onclick="event.preventDefault(); event.stopPropagation(); deletePost(${p.id}); return false;" style="color:red; font-weight:bold; margin-left:10px; font-size:12px;">[Apagar]</a>` : ''}
          </div>
          <div class="post-body">${renderContent(p.content || '')}</div>
          <div class="reply-count">
            <span onclick="event.stopPropagation(); window.location.href='/thread.html?id=${p.id}';" style="color: var(--link); font-weight: bold; text-decoration: underline; cursor: pointer;">${p.replyCount} resposta${p.replyCount === 1 ? '' : 's'}</span>
            &middot; <a href="#" onclick="event.preventDefault(); event.stopPropagation(); toggleQuickReply(${p.id});" style="color: var(--link); text-decoration: underline;">[Responder]</a>
            &middot; <a href="#" onclick="event.preventDefault(); event.stopPropagation(); reportPost(${p.id});" style="color: #d00; font-size:11px; text-decoration: none;">[Reportar]</a>
          </div>
        </div>
      </div>
      
      <div id="quick-reply-${p.id}" class="quick-reply-box" style="display:none; margin-top: 10px; background: var(--bg-reply); padding: 8px; border: 1px solid var(--border); border-radius: 4px;">
        <form onsubmit="submitQuickReply(event, ${p.id})">
          <table style="width:100%;">
            <tr>
              <td><textarea name="content" placeholder="Responder a esta thread..." style="width:100%; min-height:60px; padding:4px; border:1px solid var(--border); background: var(--bg); color: var(--text); font-family:inherit;"></textarea></td>
            </tr>
            <tr>
              <td style="padding-top:4px;">
                <input type="file" name="media" accept="image/*,video/*" style="font-size:12px; color: var(--text);">
                <label style="font-size:12px; margin-left:10px; cursor:pointer;"><input type="checkbox" name="sage"> Sage</label>
                <button type="submit" style="float:right; background:var(--bg); border:1px solid var(--border); color:var(--text); padding:4px 12px; cursor:pointer;">Responder</button>
              </td>
            </tr>
          </table>
        </form>
      </div>
    </article>
    `;
  }).join('');

  const html = buildPaginationHTML();
  document.getElementById('pagination-top').innerHTML = html;
  document.getElementById('pagination').innerHTML = html;
}

async function loadPosts() {
  const container = document.getElementById('threads');
  try {
    const res = await fetch(`/api/boards/${currentBoard}?page=${currentPage}`);
    if (!res.ok) throw new Error('Falha ao carregar');
    const posts = await res.json();
    renderPosts(posts);
    if (isAdmin()) loadReports();
  } catch (err) {
    container.innerHTML = `<p class="empty">Erro: ${escapeHtml(err.message)}</p>`;
  }
}

function changePage(page) {
  currentPage = page;
  loadPosts();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deletePost(id) {
  if (!confirm('Tem certeza que deseja apagar este post?')) return;
  // Mudança: usa sessionStorage em vez de localStorage
  const token = getMyTokens()[id] || sessionStorage.getItem('adminPass');
  try {
    const res = await fetch(`/api/posts/${id}`, { method: 'DELETE', headers: { 'x-delete-token': token } });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Erro ao apagar'); }
    removeMyToken(id);
    loadPosts();
  } catch (err) { alert(err.message); }
}

document.getElementById('mediaInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
    alert('Apenas imagens e vídeos são permitidos.'); e.target.value = ''; return;
  }
  if (file.size > maxSize) { alert('Arquivo muito grande. O limite é 20MB.'); e.target.value = ''; }
});

document.getElementById('postForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target; const btn = document.getElementById('submitBtn');
  const fd = new FormData(form);
  fd.append('sage', 'false');
  btn.disabled = true; btn.textContent = 'Postando...';
  try {
    const res = await fetch(`/api/boards/${currentBoard}`, { method: 'POST', body: fd });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || 'Erro ao postar'); }
    const data = await res.json();
    saveMyToken(data.id, data.deleteToken);
    form.reset(); currentPage = 1; await loadPosts();
  } catch (err) { alert(err.message); } finally { btn.disabled = false; btn.textContent = 'Postar'; }
});

document.querySelectorAll('.board-nav a').forEach(a => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelectorAll('.board-nav a').forEach(x => x.classList.remove('active'));
    a.classList.add('active');
    currentBoard = a.dataset.board; currentPage = 1; loadPosts();
  });
});

document.getElementById('refreshBtn').addEventListener('click', (e) => { e.preventDefault(); loadPosts(); });

document.getElementById('loginBtn').addEventListener('click', (e) => {
  e.preventDefault();
  const pass = prompt('Digite a Senha Master (Admin):');
  if (pass) {
    // Mudança: usa sessionStorage em vez de localStorage
    sessionStorage.setItem('adminPass', pass);
    document.getElementById('loginBtn').style.display = 'none';
    document.getElementById('adminControls').style.display = 'inline';
    document.getElementById('reportsPanel').style.display = 'block';
    loadPosts();
  }
});

document.getElementById('logoutBtn').addEventListener('click', (e) => {
  e.preventDefault();
  // Mudança: usa sessionStorage em vez de localStorage
  sessionStorage.removeItem('adminPass');
  document.getElementById('loginBtn').style.display = 'inline';
  document.getElementById('adminControls').style.display = 'none';
  document.getElementById('reportsPanel').style.display = 'none';
  loadPosts();
});

document.getElementById('darkModeBtn').addEventListener('click', () => {
  if (document.body.classList.contains('dark-mode')) {
    localStorage.setItem('theme', 'light');
  } else {
    localStorage.setItem('theme', 'dark');
  }
  applyTheme();
});

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
  if (e.key === 'r' || e.key === 'R') {
    const textarea = document.querySelector('textarea[name="content"]');
    if (textarea) {
      textarea.focus();
      if (!textarea.value.trim()) {
        textarea.value = '>>';
        textarea.selectionStart = textarea.selectionEnd = 2;
      }
    }
  }
});

const footer = document.querySelector('footer');
if (footer && !document.getElementById('catalogLink')) {
  const catalogLink = document.createElement('a');
  catalogLink.id = 'catalogLink';
  catalogLink.href = '/catalog.html';
  catalogLink.textContent = '[Catálogo]';
  catalogLink.style.marginLeft = '10px';
  catalogLink.style.fontWeight = 'bold';
  footer.insertBefore(catalogLink, document.getElementById('adminControls'));
}

document.querySelector('.board-nav a[data-board="b"]').classList.add('active');
if (isAdmin()) {
  document.getElementById('loginBtn').style.display = 'none';
  document.getElementById('adminControls').style.display = 'inline';
  document.getElementById('reportsPanel').style.display = 'block';
  loadReports();
}
applyTheme();
loadPosts();
setInterval(() => { if (currentPage === 1) loadPosts(); }, 30000);
