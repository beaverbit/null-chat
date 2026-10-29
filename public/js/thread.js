const urlParams = new URLSearchParams(window.location.search);
const postId = urlParams.get('id');
const maxSize = 20 * 1024 * 1024;
let allPostsMap = {};

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
  return localStorage.getItem('adminPass') !== null;
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

function renderPost(p, isReply = false) {
  const myTokens = getMyTokens();
  const admin = isAdmin();
  const canDelete = !!myTokens[p.id] || admin;

  return `
    <article class="${isReply ? 'reply' : 'thread'}" id="post-${p.id}" onclick="quotePost(${p.id}, event);" style="cursor:pointer;">
      ${renderMedia(p)}
      <div class="content">
        <div class="post-header">
          <span class="name">Anon_0x00</span>
          <span class="anon-id">#${escapeHtml(p.anonId)}</span>
          <span class="date">${formatDate(p.createdAt)}</span>
          ${p.sage ? `<span style="color:#d00; font-size:10px; margin-left:6px;">[sage]</span>` : ''}
          ${canDelete ? `<a href="#" onclick="event.preventDefault(); event.stopPropagation(); deletePost(${p.id}, ${!isReply}); return false;" style="color:red; font-weight:bold; margin-left:10px; font-size:12px;">[Apagar]</a>` : ''}
          <a href="#" onclick="event.preventDefault(); event.stopPropagation(); reportPost(${p.id}); return false;" style="color: #d00; font-size:11px; margin-left: 8px; text-decoration:none;">[Reportar]</a>
        </div>
        <div class="post-body">${renderContent(p.content || '')}</div>
      </div>
    </article>
  `;
}

function quotePost(id, event) {
  if (event.target.closest('a') || event.target.closest('video') || event.target.closest('.post-ref')) return;
  const textarea = document.querySelector('textarea[name="content"]');
  const quote = `>>${id}\n`;
  textarea.value = textarea.value ? `${textarea.value}\n${quote}` : quote;
  textarea.focus();
}

document.addEventListener('mouseover', (e) => {
  if (e.target.classList.contains('post-ref')) {
    const id = e.target.dataset.id;
    const post = allPostsMap[id];
    if (!post) return;
    let existing = document.getElementById('citation-tooltip');
    if (existing) existing.remove();
    const tooltip = document.createElement('div');
    tooltip.id = 'citation-tooltip';
    tooltip.className = 'citation-preview';
    tooltip.innerHTML = `<div style="font-weight:bold; color:var(--name); margin-bottom:4px;">Anon #${post.anonId}</div><div>${renderContent(post.content || '')}</div>`;
    const rect = e.target.getBoundingClientRect();
    tooltip.style.left = rect.left + 'px';
    tooltip.style.top = (rect.top - 10) + 'px';
    document.body.appendChild(tooltip);
    tooltip.style.display = 'block';
  }
});
document.addEventListener('mouseout', (e) => {
  if (e.target.classList.contains('post-ref')) {
    const tooltip = document.getElementById('citation-tooltip');
    if (tooltip) tooltip.remove();
  }
});

async function loadThread() {
  if (!postId) { window.location.href = '/'; return; }
  try {
    const res = await fetch(`/api/posts/${postId}`);
    if (!res.ok) throw new Error('Thread não encontrada');
    const data = await res.json();
    
    allPostsMap = {};
    allPostsMap[data.post.id] = data.post;
    data.replies.forEach(r => { allPostsMap[r.id] = r; });
    
    document.getElementById('mainPostContainer').innerHTML = renderPost(data.post, false);
    
    if (data.replies.length === 0) {
      document.getElementById('repliesContainer').innerHTML = '<p style="text-align:center;color:var(--text-muted);margin:15px 0;">Nenhuma resposta ainda.</p>';
    } else {
      document.getElementById('repliesContainer').innerHTML = data.replies.map(r => renderPost(r, true)).join('');
    }

    document.title = `Thread #${data.post.anonId} — Null.chat`;
  } catch (err) {
    document.getElementById('mainPostContainer').innerHTML = `<p style="color:red;text-align:center;">${escapeHtml(err.message)}</p>`;
  }
}

async function deletePost(id, isMain = false) {
  if (!confirm('Tem certeza que deseja apagar este post?')) return;
  const token = getMyTokens()[id] || localStorage.getItem('adminPass');
  try {
    const res = await fetch(`/api/posts/${id}`, { method: 'DELETE', headers: { 'x-delete-token': token } });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Erro ao apagar'); }
    removeMyToken(id);
    if (isMain) window.location.href = '/';
    else loadThread();
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
  const fd = new FormData(form); fd.append('replyTo', postId);
  
  if (form.querySelector('input[name="sage"]').checked) fd.append('sage', 'true');
  else fd.append('sage', 'false');

  btn.disabled = true; btn.textContent = 'Enviando...';
  
  try {
    const res = await fetch(`/api/boards/b`, { method: 'POST', body: fd });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || 'Erro ao responder'); }
    const data = await res.json();
    saveMyToken(data.id, data.deleteToken);
    form.reset(); 
    window.history.replaceState(null, '', `/thread.html?id=${postId}`);
    await loadThread();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Responder';
  }
});

document.getElementById('loginBtn').addEventListener('click', (e) => {
  e.preventDefault();
  const pass = prompt('Digite a Senha Master (Admin):');
  if (pass) {
    localStorage.setItem('adminPass', pass);
    document.getElementById('loginBtn').style.display = 'none';
    document.getElementById('adminControls').style.display = 'inline';
    loadThread();
  }
});

document.getElementById('logoutBtn').addEventListener('click', (e) => {
  e.preventDefault();
  localStorage.removeItem('adminPass');
  document.getElementById('loginBtn').style.display = 'inline';
  document.getElementById('adminControls').style.display = 'none';
  loadThread();
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

if (isAdmin()) {
  document.getElementById('loginBtn').style.display = 'none';
  document.getElementById('adminControls').style.display = 'inline';
}
applyTheme();
loadThread();
setInterval(loadThread, 30000);