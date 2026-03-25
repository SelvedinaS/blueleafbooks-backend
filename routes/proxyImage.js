/**
 * Proxy images from Spaces to avoid CORS/referrer issues.
 * GET /api/media?url=https://bucket.region.digitaloceanspaces.com/...
 */
const express = require('express');

const router = express.Router();

function isAllowedUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname.includes('digitaloceanspaces.com');
  } catch {
    return false;
  }
}

router.get('/', async (req, res) => {
  try {
    let url = req.query.url;
    if (!url) {
      return res.status(400).json({ message: 'Missing url parameter' });
    }
    // Fix common typos in stored URLs (fral→fra1)
    url = url.replace(/\.fral\./g, '.fra1.');
    if (!isAllowedUrl(url)) {
      return res.status(400).json({ message: 'Invalid or disallowed URL' });
    }
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'BlueLeafBooks-Proxy/1.0' }
    });
    if (!resp.ok) {
      return res.status(resp.status).json({ message: 'Failed to fetch image' });
    }
    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await resp.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (err) {
    console.error('Proxy image error:', err);
    res.status(500).json({ message: 'Proxy error' });
  }
});

module.exports = router;
