let currentBoard = 'b';
let currentPage = 1;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function buildPaginationHTML() {
  if (currentPage === 1) {
    return `<a href="#" onclick="changePage(2); return false;">[ Próxima Página &rarr; ]</a>`;
  } else {
    return `
      <a href="#" onclick="changePage(${currentPage - 1}); return false;">[ &larr; Anterior ]</a>
      <span>Página ${currentPage}</span>
      <a href="#" onclick="changePage(${currentPage + 1}); return false;">[ Próxima &rarr; ]</a>
    `;
  }
}

function renderCatalog(posts) {
  const container = document.getElementById('catalog');
  if (!posts.length) {
    container.innerHTML = '<p class="empty" style="grid-column: 1 / -1;">Nenhum post ainda.</p>';
    document.getElementById('pagination-top').innerHTML = '';
    document.getElementById('pagination').innerHTML = '';
    return;
  }

  const postsWithMedia = posts.filter(p => p.mediaUrl);

  if (postsWithMedia.length === 0) {
    container.innerHTML = '<p class="empty" style="grid-column: 1 / -1;">Nenhuma thread com imagem neste board.</p>';
  } else {
    container.innerHTML = postsWithMedia.map(p => {
      let mediaHtml = '';
      if (p.mediaType === 'video') {
        mediaHtml = `<video src="${escapeHtml(p.mediaUrl)}" preload="none" muted></video>`;
      } else {
        mediaHtml = `<img src="${escapeHtml(p.mediaUrl)}" loading="lazy" alt="miniatura">`;
      }

      return `
        <div class="catalog-item" onclick="window.location.href='/thread.html?id=${p.id}';">
          ${mediaHtml}
          <div class="catalog-stats">R: ${p.replyCount}</div>
        </div>
      `;
    }).join('');
  }

  const html = buildPaginationHTML();
  document.getElementById('pagination-top').innerHTML = html;
  document.getElementById('pagination').innerHTML = html;
}

async function loadCatalog() {
  const container = document.getElementById('catalog');
  try {
    const res = await fetch(`/api/boards/${currentBoard}?page=${currentPage}`);
    if (!res.ok) throw new Error('Falha ao carregar');
    renderCatalog(await res.json());
  } catch (err) {
    container.innerHTML = `<p class="empty" style="grid-column: 1 / -1;">Erro: ${escapeHtml(err.message)}</p>`;
  }
}

function changePage(page) {
  currentPage = page;
  loadCatalog();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.getElementById('refreshBtn').addEventListener('click', (e) => {
  e.preventDefault(); loadCatalog();
});

document.querySelectorAll('.board-nav a').forEach(a => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelectorAll('.board-nav a').forEach(x => x.classList.remove('active'));
    a.classList.add('active');
    currentBoard = a.dataset.board; currentPage = 1; loadCatalog();
  });
});

document.querySelector('.board-nav a[data-board="b"]').classList.add('active');
loadCatalog();