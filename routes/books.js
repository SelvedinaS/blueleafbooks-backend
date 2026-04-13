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

    // 🔥 FIX
    const isDemo = isAdmin ? true : String(req.body?.isDemo || '').toLowerCase() === 'true';

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

    const wantsDemo = isAdmin ? true : String(req.body?.isDemo || '').toLowerCase() === 'true';

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

    if (isAdmin) book.isDemo = wantsDemo;

    await book.save();
    res.json(book);

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;