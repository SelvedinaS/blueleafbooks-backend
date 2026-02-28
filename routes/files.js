/**
 * Serve uploaded files via API
 * - Covers: public
 * - Books (PDF): protected (only buyers)
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

const { auth, authorize } = require('../middleware/auth');
const Order = require('../models/Order');
const Book = require('../models/Book');

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

// GET /api/files/cover/:filename - serve cover image (public)
router.get('/cover/:filename', (req, res) => {
  const filename = safeFilename(req.params.filename);
  if (!filename) return res.status(400).json({ message: 'Invalid filename' });

  const filePath = path.resolve(COVERS_DIR, filename);
  if (!filePath.startsWith(path.resolve(COVERS_DIR))) return res.status(400).json({ message: 'Invalid path' });

  if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'File not found' });

  res.setHeader('Cache-Control', 'public, max-age=86400');
  return fs.createReadStream(filePath).pipe(res);
});

// GET /api/files/book/:filename - serve PDF (protected)
router.get('/book/:filename', auth, authorize('customer'), async (req, res) => {
  try {
    const filename = safeFilename(req.params.filename);
    if (!filename) return res.status(400).json({ message: 'Invalid filename' });

    const filePath = path.resolve(BOOKS_DIR, filename);
    if (!filePath.startsWith(path.resolve(BOOKS_DIR))) return res.status(400).json({ message: 'Invalid path' });

    if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'File not found' });

    // Find which book owns this PDF filename (stored like uploads/books/<filename>)
    const book = await Book.findOne({
      pdfFile: { $regex: `uploads\\/books\\/${filename}$` }
    }).select('_id');

    if (!book) return res.status(404).json({ message: 'Book not found' });

    // Check if this user purchased this book (completed payment)
    const hasOrder = await Order.exists({
      customer: req.user._id,
      paymentStatus: 'completed',
      'items.book': book._id
    });

    if (!hasOrder) {
      return res.status(403).json({ message: 'You have not purchased this book.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    return fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

module.exports = router;