/**
 * Serve uploaded files via API (more reliable than static on some hosts).
 * Handles both local paths (uploads/covers/xxx.jpg) and passes through full URLs.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const COVERS_DIR = path.join(UPLOADS_DIR, 'covers');
const BOOKS_DIR = path.join(UPLOADS_DIR, 'books');

// Sanitize filename - only allow alphanumeric, dash, dot
function safeFilename(name) {
  if (!name || typeof name !== 'string') return null;
  const safe = name.replace(/[^a-zA-Z0-9.\-_]/g, '');
  return safe.length > 0 ? safe : null;
}

// GET /api/files/cover/:filename - serve cover image
router.get('/cover/:filename', (req, res) => {
  const filename = safeFilename(req.params.filename);
  if (!filename) return res.status(400).json({ message: 'Invalid filename' });

  const filePath = path.resolve(COVERS_DIR, filename);
  if (!filePath.startsWith(path.resolve(COVERS_DIR))) return res.status(400).json({ message: 'Invalid path' });

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ message: 'File not found' });
  }

  const ext = path.extname(filename).toLowerCase();
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(filePath).pipe(res);
});

// GET /api/files/book/:filename - serve PDF (for download)
router.get('/book/:filename', (req, res) => {
  const filename = safeFilename(req.params.filename);
  if (!filename) return res.status(400).json({ message: 'Invalid filename' });

  const filePath = path.resolve(BOOKS_DIR, filename);
  if (!filePath.startsWith(path.resolve(BOOKS_DIR))) return res.status(400).json({ message: 'Invalid path' });

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ message: 'File not found' });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(filePath).pipe(res);
});

module.exports = router;
