// SKRAĆENO OBJAŠNJENJE:
// ✔ Admin može uploadovati demo knjige
// ✔ Author mora imati PayPal
// ✔ Nema više Access denied za admina

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Book = require('../models/Book');
const { BOOK_GENRES, normalizeGenre } = require('../config/bookGenres');
const User = require('../models/User');
const Order = require('../models/Order');
const { auth } = require('../middleware/auth');
const { uploadToSpaces, isSpacesConfigured } = require('../config/spaces');

const router = express.Router();

/* =========================
   UPLOAD SETUP
========================= */

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const BOOKS_DIR = path.join(UPLOADS_DIR, 'books');
const COVERS_DIR = path.join(UPLOADS_DIR, 'covers');

const memoryStorage = multer.memoryStorage();

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'pdfFile') cb(null, BOOKS_DIR);
    else cb(null, COVERS_DIR);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});

const storage = isSpacesConfigured() ? memoryStorage : diskStorage;

if (!isSpacesConfigured()) {
  fs.mkdirSync(BOOKS_DIR, { recursive: true });
  fs.mkdirSync(COVERS_DIR, { recursive: true });
}

const upload = multer({ storage });

function makeSpacesKey(folder, name, ext) {
  const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
  return `${folder}/${unique}${ext || path.extname(name)}`;
}

const { ensureFullUrls, ensureFullUrlsMany } = require('../utils/fileUrls');

/* =========================
   PUBLIC BOOKS (LIST / DETAILS)
========================= */

// List books (public)
router.get('/', async (req, res) => {
  try {
    const { genre, q } = req.query || {};

    const query = {
      isDeleted: false,
      status: 'approved'
    };

    if (genre) {
      const normalized = normalizeGenre(String(genre));
      if (normalized) query.genre = normalized;
    }

    if (q) {
      const s = String(q).trim();
      if (s) query.$text = { $search: s };
    }

    const books = await Book.find(query)
      .populate('author', 'name isBlocked')
      .sort(q ? { score: { $meta: 'textScore' } } : { createdAt: -1 });

    const visible = (books || []).filter(b => !b?.author?.isBlocked);
    return res.json(ensureFullUrlsMany(visible));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Genres list
router.get('/genres/list', (req, res) => {
  return res.json(BOOK_GENRES || []);
});

// Featured: curated
router.get('/featured/curated', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || '8', 10) || 8));
    const books = await Book.find({
      isDeleted: false,
      status: 'approved',
      isFeatured: true
    })
      .populate('author', 'name isBlocked')
      .sort({ featuredOrder: 1, createdAt: -1 })
      .limit(limit);

    const visible = (books || []).filter(b => !b?.author?.isBlocked);
    return res.json(ensureFullUrlsMany(visible));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Featured: bestsellers
router.get('/featured/bestsellers', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || '8', 10) || 8));
    const books = await Book.find({
      isDeleted: false,
      status: 'approved'
    })
      .populate('author', 'name isBlocked')
      .sort({ salesCount: -1, createdAt: -1 })
      .limit(limit);

    const visible = (books || []).filter(b => !b?.author?.isBlocked);
    return res.json(ensureFullUrlsMany(visible));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Featured: new
router.get('/featured/new', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || '8', 10) || 8));
    const books = await Book.find({
      isDeleted: false,
      status: 'approved'
    })
      .populate('author', 'name isBlocked')
      .sort({ createdAt: -1 })
      .limit(limit);

    const visible = (books || []).filter(b => !b?.author?.isBlocked);
    return res.json(ensureFullUrlsMany(visible));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Rating status (must be purchased)
router.get('/:id/rating-status', auth, async (req, res) => {
  try {
    if (req.user?.role !== 'customer') {
      return res.json({ hasPurchased: false, canRate: false, message: 'Only customers can rate books.' });
    }

    const bookId = req.params.id;
    const hasPurchased = await Order.exists({
      customer: req.user._id,
      paymentStatus: 'completed',
      'items.book': bookId
    });

    if (!hasPurchased) {
      return res.json({ hasPurchased: false, canRate: false, message: 'Only customers who purchased this book can rate it.' });
    }

    const book = await Book.findById(bookId).select('ratings rating ratingCount');
    const existing = (book?.ratings || []).find(r => String(r.user) === String(req.user._id));

    return res.json({
      hasPurchased: true,
      canRate: true,
      existingRating: existing ? existing.value : 0,
      rating: Number(book?.rating || 0),
      ratingCount: Number(book?.ratingCount || 0)
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Rate book
router.post('/:id/rate', auth, async (req, res) => {
  try {
    if (req.user?.role !== 'customer') {
      return res.status(403).json({ message: 'Only customers can rate books.' });
    }

    const bookId = req.params.id;
    const rating = Number(req.body?.rating || 0);
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'Rating must be between 1 and 5.' });
    }

    const hasPurchased = await Order.exists({
      customer: req.user._id,
      paymentStatus: 'completed',
      'items.book': bookId
    });
    if (!hasPurchased) {
      return res.status(403).json({ message: 'Only customers who purchased this book can rate it.' });
    }

    const book = await Book.findById(bookId);
    if (!book || book.isDeleted || book.status !== 'approved') {
      return res.status(404).json({ message: 'Book not found' });
    }

    const existingIdx = (book.ratings || []).findIndex(r => String(r.user) === String(req.user._id));
    if (existingIdx >= 0) {
      book.ratings[existingIdx].value = rating;
      book.ratings[existingIdx].updatedAt = new Date();
    } else {
      book.ratings.push({ user: req.user._id, value: rating });
    }

    // Recalculate average
    const values = (book.ratings || []).map(r => Number(r.value || 0)).filter(v => v >= 1 && v <= 5);
    const count = values.length;
    const avg = count ? (values.reduce((s, v) => s + v, 0) / count) : 0;
    book.ratingCount = count;
    book.rating = Number(avg.toFixed(2));

    await book.save();
    return res.json({
      success: true,
      message: 'Rating saved successfully.',
      rating: book.rating,
      ratingCount: book.ratingCount
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Download purchased book PDF
router.get('/:id/download', auth, async (req, res) => {
  try {
    if (req.user?.role !== 'customer') {
      return res.status(403).json({ message: 'Only customers can download purchased books.' });
    }

    const bookId = req.params.id;
    const hasPurchased = await Order.exists({
      customer: req.user._id,
      paymentStatus: 'completed',
      'items.book': bookId
    });
    if (!hasPurchased) {
      return res.status(403).json({ message: 'You have not purchased this book.' });
    }

    const book = await Book.findById(bookId).select('pdfFile title isDeleted status');
    if (!book || book.isDeleted) return res.status(404).json({ message: 'Book not found' });
    if (book.status !== 'approved') return res.status(400).json({ message: 'Book not available' });

    const pdfPath = String(book.pdfFile || '');
    if (!pdfPath) return res.status(404).json({ message: 'File not found' });

    if (/^https?:\/\//i.test(pdfPath)) {
      return res.redirect(pdfPath);
    }

    const abs = path.join(__dirname, '..', pdfPath.replace(/^\/+/, ''));
    return res.sendFile(abs);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Get single book (public)
router.get('/:id', async (req, res) => {
  try {
    const book = await Book.findOne({
      _id: req.params.id,
      isDeleted: false,
      status: 'approved'
    }).populate('author', 'name isBlocked');

    if (!book) return res.status(404).json({ message: 'Book not found' });
    if (book?.author?.isBlocked) return res.status(404).json({ message: 'Book not found' });

    return res.json(ensureFullUrls(book));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

/* =========================
   CREATE BOOK (FIXED)
========================= */

router.post('/', auth, upload.fields([
  { name: 'pdfFile', maxCount: 1 },
  { name: 'coverImage', maxCount: 1 }
]), async (req, res) => {
  try {
    const { title, description, genre, price } = req.body;

    const isAdmin =
      req.user?.role === 'admin' ||
      req.user?.email === 'blueleafbooks@hotmail.com';
    const isAuthor = req.user?.role === 'author';

    // Demo knjiga je demo samo ako je eksplicitno označena u formi
    const isDemo = String(req.body?.isDemo || '').toLowerCase() === 'true';

    if (!isAdmin && !isAuthor) {
      return res.status(403).json({ message: 'Access denied' });
    }

    if (req.user?.isBlocked) {
      return res.status(403).json({ message: 'Account blocked' });
    }

    if (!isAdmin) {
      const user = await User.findById(req.user._id);
      if (!user?.payoutPaypalEmail) {
        return res.status(403).json({ message: 'Add PayPal first' });
      }
    }

    const normalizedGenre = normalizeGenre(genre);
    if (!normalizedGenre) {
      return res.status(400).json({ message: 'Invalid genre' });
    }

    if (!req.files?.pdfFile || !req.files?.coverImage) {
      return res.status(400).json({ message: 'Files required' });
    }

    const pdf = req.files.pdfFile[0];
    const cover = req.files.coverImage[0];

    let pdfUrl, coverUrl;

    if (isSpacesConfigured()) {
      pdfUrl = await uploadToSpaces(pdf.buffer, makeSpacesKey('books', pdf.originalname, '.pdf'), 'application/pdf');
      coverUrl = await uploadToSpaces(cover.buffer, makeSpacesKey('covers', cover.originalname), cover.mimetype);
    } else {
      pdfUrl = `uploads/books/${pdf.filename}`;
      coverUrl = `uploads/covers/${cover.filename}`;
    }

    const book = new Book({
      title,
      description,
      genre: normalizedGenre,
      price: parseFloat(price),
      author: req.user._id,
      pdfFile: pdfUrl,
      coverImage: coverUrl,
      isDemo,
      status: 'approved'
    });

    await book.save();
    res.status(201).json(ensureFullUrls(book));

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

/* =========================
   UPDATE BOOK (FIXED)
========================= */

router.put('/:id', auth, upload.fields([
  { name: 'pdfFile', maxCount: 1 },
  { name: 'coverImage', maxCount: 1 }
]), async (req, res) => {
  try {
    const isAdmin =
      req.user?.role === 'admin' ||
      req.user?.email === 'blueleafbooks@hotmail.com';
    const isAuthor = req.user?.role === 'author';

    const wantsDemo = String(req.body?.isDemo || '').toLowerCase() === 'true';

    if (!isAdmin && !isAuthor) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const book = await Book.findById(req.params.id);

    if (!book) {
      return res.status(404).json({ message: 'Not found' });
    }

    if (!isAdmin && book.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not your book' });
    }

    if (req.body.title) book.title = req.body.title;
    if (req.body.description) book.description = req.body.description;

    if (req.body.genre) {
      const g = normalizeGenre(req.body.genre);
      if (!g) return res.status(400).json({ message: 'Invalid genre' });
      book.genre = g;
    }

    if (req.body.price) book.price = parseFloat(req.body.price);

    // Dozvoli adminu da uključi/isključi demo zastavicu preko forme
    if (isAdmin) {
      book.isDemo = wantsDemo;
    }

    await book.save();
    res.json(book);

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;