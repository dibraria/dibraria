const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const cheerio = require('cheerio');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*', methods: ['GET'] }));
app.use(express.json());

const STORES = { 'royal-sports': true, 'minkang': true };

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection':      'keep-alive',
  'Cache-Control':   'no-cache',
};

// ── helpers ──────────────────────────────────────────────────────────────────
function parseAlbums($, store) {
  const albums = [];
  const seen   = new Set();

  $('a[href*="/albums/"]').each((_, el) => {
    const href       = $(el).attr('href') || '';
    const albumMatch = href.match(/\/albums\/(\d+)/);
    if (!albumMatch) return;

    const albumId = albumMatch[1];
    if (seen.has(albumId)) return;

    const img = $(el).find('img');
    let coverSrc =
      img.filter('[src*="medium"]').first().attr('src') ||
      img.filter('[src*="small"]').first().attr('src')  ||
      img.first().attr('src')                           ||
      img.first().attr('data-src')                      || '';

    if (!coverSrc.includes('photo.yupoo.com')) return;
    coverSrc = coverSrc
      .replace('/small.', '/medium.')
      .replace('/thumb.', '/medium.');

    const title = (
      $(el).attr('title') ||
      $(el).find('[class*="title"],[class*="name"]').first().text() ||
      $(el).text().split('\n')[0] ||
      `Álbum ${albumId}`
    ).trim().replace(/\s*\d+\s*$/, '');

    const nums       = $(el).text().match(/\b(\d+)\b/g);
    const photoCount = nums ? Math.max(...nums.map(Number)) : null;

    seen.add(albumId);
    albums.push({
      id: albumId,
      title,
      cover:      coverSrc,
      photoCount,
      albumUrl:   `https://${store}.x.yupoo.com/albums/${albumId}?uid=1`,
      store,
    });
  });

  return albums;
}

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', stores: Object.keys(STORES), ts: new Date().toISOString() });
});

// ── STORES ────────────────────────────────────────────────────────────────────
app.get('/api/stores', (_req, res) => {
  res.json({
    stores:  Object.keys(STORES).map(id => ({ id, url: `https://${id}.x.yupoo.com` })),
    default: 'minkang',
  });
});

// ── SEARCH ────────────────────────────────────────────────────────────────────
// GET /api/search?store=minkang&q=flamengo
app.get('/api/search', async (req, res) => {
  const { store, q } = req.query;

  if (!store || !STORES[store])
    return res.status(400).json({ error: `Loja inválida. Use: ${Object.keys(STORES).join(' ou ')}` });
  if (!q)
    return res.status(400).json({ error: 'Parâmetro "q" é obrigatório.' });

  try {
    const url = `https://${store}.x.yupoo.com/search/album?uid=1&sort=unix&q=${encodeURIComponent(q)}`;
    console.log('[SEARCH]', url);

    const { data } = await axios.get(url, {
      headers: { ...HEADERS, Referer: `https://${store}.x.yupoo.com/albums` },
      timeout: 15000,
    });

    const $      = cheerio.load(data);
    const albums = parseAlbums($, store);

    console.log(`[SEARCH] ${albums.length} álbuns`);
    res.json({ results: albums, total: albums.length, query: q, store });

  } catch (err) {
    console.error('[SEARCH ERROR]', err.message);
    res.status(500).json({ error: 'Erro ao buscar no Yupoo.', detail: err.message });
  }
});

// ── ALBUM ─────────────────────────────────────────────────────────────────────
// GET /api/album?store=minkang&id=123456
app.get('/api/album', async (req, res) => {
  const { store, id } = req.query;

  if (!store || !STORES[store]) return res.status(400).json({ error: 'Loja inválida.' });
  if (!id)                       return res.status(400).json({ error: 'Parâmetro "id" é obrigatório.' });

  try {
    const url = `https://${store}.x.yupoo.com/albums/${id}?uid=1`;
    console.log('[ALBUM]', url);

    const { data } = await axios.get(url, {
      headers: { ...HEADERS, Referer: `https://${store}.x.yupoo.com/albums` },
      timeout: 15000,
    });

    const $ = cheerio.load(data);

    const title = (
      $('h1').first().text() ||
      $('[class*="album__title"],[class*="albumTitle"]').first().text() ||
      `Álbum ${id}`
    ).trim().replace(/\s*\d+\s*$/, '');

    const hashSeen = new Set();
    const photos   = [];

    $('img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (!src.includes('photo.yupoo.com')) return;

      const hashMatch = src.match(/photo\.yupoo\.com\/[^/]+\/([a-f0-9]+)\//);
      if (!hashMatch) return;

      const hash = hashMatch[1];
      if (hashSeen.has(hash)) return;
      hashSeen.add(hash);

      photos.push(
        src
          .replace('/small.', '/medium.')
          .replace('/thumb.', '/medium.')
          .replace('/large.', '/medium.')
      );
    });

    console.log(`[ALBUM] ${photos.length} fotos`);
    res.json({ id, title, photos, total: photos.length, albumUrl: url });

  } catch (err) {
    console.error('[ALBUM ERROR]', err.message);
    res.status(500).json({ error: 'Erro ao carregar o álbum.', detail: err.message });
  }
});

// ── IMAGE PROXY ───────────────────────────────────────────────────────────────
// GET /api/image?url=https://photo.yupoo.com/...
app.get('/api/image', async (req, res) => {
  const { url } = req.query;
  if (!url)                        return res.status(400).send('URL obrigatória');
  if (!url.includes('yupoo.com'))  return res.status(403).send('Domínio não permitido');

  try {
    const response = await axios.get(url, {
      headers: {
        ...HEADERS,
        Referer: 'https://www.yupoo.com/',
        Accept:  'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      responseType: 'arraybuffer',
      timeout:      12000,
    });

    const ct = response.headers['content-type'] || 'image/jpeg';
    res.set('Content-Type',  ct);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(response.data);

  } catch (err) {
    console.error('[IMAGE PROXY ERROR]', err.message);
    res.status(500).send('Erro ao carregar imagem');
  }
});

// ── CATEGORY ──────────────────────────────────────────────────────────────────
// GET /api/category?store=minkang&id=5062328
app.get('/api/category', async (req, res) => {
  const { store, id, page = 1 } = req.query;

  if (!store || !STORES[store]) return res.status(400).json({ error: 'Loja inválida.' });
  if (!id)                       return res.status(400).json({ error: 'Parâmetro "id" é obrigatório.' });

  try {
    const url = `https://${store}.x.yupoo.com/categories/${id}?uid=1&page=${page}`;
    console.log('[CATEGORY]', url);

    const { data } = await axios.get(url, {
      headers: { ...HEADERS, Referer: `https://${store}.x.yupoo.com/albums` },
      timeout: 15000,
    });

    const $      = cheerio.load(data);
    const albums = parseAlbums($, store);

    console.log(`[CATEGORY] ${albums.length} álbuns`);
    res.json({ results: albums, total: albums.length, categoryId: id, store });

  } catch (err) {
    console.error('[CATEGORY ERROR]', err.message);
    res.status(500).json({ error: 'Erro ao carregar categoria.', detail: err.message });
  }
});


// ── COLLECTION ────────────────────────────────────────────────────────────────
// GET /api/collection?store=minkang&id=712891
// Collections use a different URL pattern than categories
app.get('/api/collection', async (req, res) => {
  const { store, id, page = 1 } = req.query;

  if (!store || !STORES[store]) return res.status(400).json({ error: 'Loja inválida.' });
  if (!id)                       return res.status(400).json({ error: 'Parâmetro "id" é obrigatório.' });

  try {
    const url = `https://${store}.x.yupoo.com/collections/${id}?uid=1&page=${page}`;
    console.log('[COLLECTION]', url);

    const { data } = await axios.get(url, {
      headers: { ...HEADERS, Referer: `https://${store}.x.yupoo.com/albums` },
      timeout: 15000,
    });

    const $      = cheerio.load(data);
    const albums = parseAlbums($, store);

    console.log(`[COLLECTION] ${albums.length} álbuns`);
    res.json({ results: albums, total: albums.length, collectionId: id, store });

  } catch (err) {
    console.error('[COLLECTION ERROR]', err.message);
    res.status(500).json({ error: 'Erro ao carregar coleção.', detail: err.message });
  }
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Dibraria backend rodando na porta ${PORT}`);
  console.log(`📦 Lojas: ${Object.keys(STORES).join(', ')}`);
  console.log(`🔍 Health: http://localhost:${PORT}/api/health\n`);
});
