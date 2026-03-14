const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Book = require('../models/Book');
const User = require('../models/User');
const Order = require('../models/Order');
const { auth, authorize } = require('../middleware/auth');
const { uploadToSpaces, isSpacesConfigured } = require('../config/spaces');

const router = express.Router();

// Local upload dirs (fallback when Spaces not configured)
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const BOOKS_DIR = path.join(UPLOADS_DIR, 'books');
const COVERS_DIR = path.join(UPLOADS_DIR, 'covers');

// Multer: memory for Spaces, disk for local fallback
const memoryStorage = multer.memoryStorage();
const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'pdfFile') cb(null, BOOKS_DIR);
    else if (file.fieldname === 'coverImage') cb(null, COVERS_DIR);
    else cb(new Error('Unknown upload field'));
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + path.extname(file.originalname || '.bin'));
  }
});

const storage = isSpacesConfigured() ? memoryStorage : diskStorage;

// Ensure local dirs exist when using fallback
if (!isSpacesConfigured()) {
  fs.mkdirSync(BOOKS_DIR, { recursive: true });
  fs.mkdirSync(COVERS_DIR, { recursive: true });
  console.warn('DigitalOcean Spaces not configured (SPACES_BUCKET/KEY/SECRET). Using local uploads. Set env vars for production.');
}

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'pdfFile') {
      if (file.mimetype === 'application/pdf') {
        cb(null, true);
      } else {
        cb(new Error('Only PDF files are allowed for books'));
      }
    } else if (file.fieldname === 'coverImage') {
      if (file.mimetype.startsWith('image/')) {
        cb(null, true);
      } else {
        cb(new Error('Only image files are allowed for covers'));
      }
    } else {
      cb(new Error('Unknown upload field'));
    }
  }
});

/**
 * Generate unique key for Spaces (folder/filename).
 * Key is folder/filename only - bucket is in hostname (virtual-hosted style).
 */
function makeSpacesKey(folder, originalName, ext) {
  const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
  const safeExt = ext || path.extname(originalName || '') || '.bin';
  return `${folder}/${unique}${safeExt}`;
}

const { ensureFullUrls, ensureFullUrlsMany } = require('../utils/fileUrls');

// Get all books (public, with filters)
router.get('/', async (req, res) => {
  try {
    const { genre, search, sortBy = 'createdAt', order = 'desc', minPrice, maxPrice } = req.query;

    // Public catalog: all non-deleted books
    let query = { isDeleted: false };

    if (genre) query.genre = genre;
    if (search) query.$text = { $search: search };

    if (minPrice || maxPrice) {
      query.price = {};
      if (minPrice) query.price.$gte = parseFloat(minPrice);
      if (maxPrice) query.price.$lte = parseFloat(maxPrice);
    }

    let sortOptions = {};
    if (sortBy === 'popularity') sortOptions = { salesCount: order === 'asc' ? 1 : -1 };
    else if (sortBy === 'rating') sortOptions = { rating: order === 'asc' ? 1 : -1 };
    else if (sortBy === 'price') sortOptions = { price: order === 'asc' ? 1 : -1 };
    else sortOptions = { createdAt: order === 'asc' ? 1 : -1 };

    const booksRaw = await Book.find(query)
      .select('title description genre price coverImage pdfFile rating ratingCount salesCount author isDeleted isFeatured featuredOrder status createdAt updatedAt')
      .populate('author', 'name email isBlocked')
      .sort(sortOptions)
      .lean();

    // Filter out books whose author is blocked (unpaid fees / admin restriction)
    const books = (booksRaw || []).filter(b => !b?.author?.isBlocked);

    res.json(ensureFullUrlsMany(books));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// IMPORTANT: Keep specific routes ABOVE '/:id' to avoid route conflicts.

// Get genres
router.get('/genres/list', async (req, res) => {
  try {
    const genres = await Book.distinct('genre', { isDeleted: false });
    res.json(genres);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get best sellers
router.get('/featured/bestsellers', async (req, res) => {
  try {
    const booksRaw = await Book.find({ isDeleted: false })
      .select('title description genre price coverImage pdfFile rating ratingCount salesCount author isDeleted status createdAt')
      .sort({ salesCount: -1 })
      .limit(10)
      .populate('author', 'name email isBlocked')
      .lean();

    // Hide blocked authors' books from public lists
    const books = (booksRaw || []).filter(b => !b?.author?.isBlocked);
    res.json(ensureFullUrlsMany(books));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get newly added
router.get('/featured/new', async (req, res) => {
  try {
    const booksRaw = await Book.find({ isDeleted: false })
      .select('title description genre price coverImage pdfFile rating ratingCount salesCount author isDeleted status createdAt')
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('author', 'name email isBlocked')
      .lean();

    const books = (booksRaw || []).filter(b => !b?.author?.isBlocked);
    res.json(ensureFullUrlsMany(books));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});


// Curated featured books: manually selected by admin (isFeatured + featuredOrder)
router.get('/featured/curated', async (req, res) => {
  try {
    const booksRaw = await Book.find({ isDeleted: false, isFeatured: true })
      .select('title description genre price coverImage pdfFile rating ratingCount salesCount author isDeleted isFeatured featuredOrder status createdAt')
      .sort({ featuredOrder: 1, createdAt: -1 })
      .limit(12)
      .populate('author', 'name email isBlocked')
      .lean();

    const books = (booksRaw || []).filter(b => !b?.author?.isBlocked);
    res.json(ensureFullUrlsMany(books));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Protected PDF download: only for buyers or author of the book (must be before /:id)
router.get('/:bookId/download', auth, async (req, res) => {
  try {
    const bookId = req.params.bookId;
    const book = await Book.findById(bookId).select('pdfFile author isDeleted').lean();
    if (!book || book.isDeleted) {
      return res.status(404).json({ message: 'Book not found' });
    }

    const userId = req.user._id.toString();
    const isAuthor = book.author && book.author.toString() === userId;

    if (!isAuthor) {
      const hasPurchased = await Order.exists({
        customer: req.user._id,
        paymentStatus: 'completed',
        'items.book': bookId
      });
      if (!hasPurchased) {
        return res.status(403).json({ message: 'You have not purchased this book.' });
      }
    }

    let pdfSource = book.pdfFile;
    if (!pdfSource || typeof pdfSource !== 'string') {
      return res.status(404).json({ message: 'PDF not available.' });
    }
    pdfSource = pdfSource.replace(/\.fral\./g, '.fra1.').replace(/geun\./g, 'geum.');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="book.pdf"');
    res.setHeader('Cache-Control', 'no-store');

    if (/^https?:\/\//i.test(pdfSource)) {
      const resp = await fetch(pdfSource, { headers: { 'User-Agent': 'BlueLeafBooks/1.0' } });
      if (!resp.ok) {
        return res.status(502).json({ message: 'Failed to fetch PDF.' });
      }
      const buffer = Buffer.from(await resp.arrayBuffer());
      return res.send(buffer);
    }

    const localMatch = pdfSource.match(/uploads\/books\/(.+)$/);
    if (localMatch) {
      const filename = localMatch[1].replace(/[^a-zA-Z0-9.\-_]/g, '');
      const filePath = path.resolve(BOOKS_DIR, filename);
      if (!filePath.startsWith(path.resolve(BOOKS_DIR)) || !fs.existsSync(filePath)) {
        return res.status(404).json({ message: 'File not found.' });
      }
      return fs.createReadStream(filePath).pipe(res);
    }

    return res.status(404).json({ message: 'PDF not available.' });
  } catch (err) {
    console.error('[books download]', err);
    return res.status(500).json({ message: err.message || 'Download failed.' });
  }
});

// Get book by ID
router.get('/:id', async (req, res) => {
  try {
    const book = await Book.findById(req.params.id)
      .select('title description genre price coverImage pdfFile rating ratingCount salesCount author isDeleted isFeatured featuredOrder status createdAt updatedAt')
      .populate('author', 'name email isBlocked')
      .lean();

    if (!book || book.isDeleted) {
      return res.status(404).json({ message: 'Book not found' });
    }

    // Hide blocked authors' books from the public catalog
    if (book?.author?.isBlocked) {
      return res.status(404).json({ message: 'Book not found' });
    }

    res.json(ensureFullUrls(book));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create book (author only)
router.post('/', auth, authorize('author'), upload.fields([
  { name: 'pdfFile', maxCount: 1 },
  { name: 'coverImage', maxCount: 1 }
]), async (req, res) => {
  try {
    const { title, description, genre, price } = req.body;

    // Publishing is restricted if the author is blocked (e.g., unpaid platform fee)
    if (req.user?.isBlocked) {
      return res.status(403).json({ message: 'Your account is restricted. Please settle outstanding platform fees to publish books.' });
    }

    // PayPal required for publishing (earnings must go somewhere)
    const user = await User.findById(req.user._id).select('payoutPaypalEmail');
    if (!user?.payoutPaypalEmail || !String(user.payoutPaypalEmail).trim()) {
      return res.status(403).json({ message: 'You must set your PayPal email before publishing books. Go to Dashboard → Payout Settings.' });
    }

    if (!req.files?.pdfFile?.[0] || !req.files?.coverImage?.[0]) {
      return res.status(400).json({ message: 'PDF file and cover image are required' });
    }

    const coverFile = req.files.coverImage[0];
    const pdfFile = req.files.pdfFile[0];

    let coverUrl, pdfUrl;
    if (isSpacesConfigured()) {
      // Upload to DigitalOcean Spaces
      [coverUrl, pdfUrl] = await Promise.all([
        uploadToSpaces(
          coverFile.buffer,
          makeSpacesKey('covers', coverFile.originalname, path.extname(coverFile.originalname)),
          coverFile.mimetype
        ),
        uploadToSpaces(
          pdfFile.buffer,
          makeSpacesKey('books', pdfFile.originalname, '.pdf'),
          'application/pdf'
        )
      ]);
    } else {
      // Fallback: local paths (relative for frontend fileUrl)
      coverUrl = `uploads/covers/${coverFile.filename}`;
      pdfUrl = `uploads/books/${pdfFile.filename}`;
    }

    const book = new Book({
      title,
      description,
      genre,
      price: parseFloat(price),
      author: req.user._id,
      pdfFile: pdfUrl,
      coverImage: coverUrl,
      status: 'approved'
    });

    await book.save();
    await book.populate('author', 'name email');

    res.status(201).json(ensureFullUrls(book));
  } catch (error) {
    console.error('Book create error:', error);
    res.status(500).json({ message: error.message || 'Failed to create book' });
  }
});

// Update book (author only, their own books)
router.put('/:id', auth, authorize('author'), upload.fields([
  { name: 'pdfFile', maxCount: 1 },
  { name: 'coverImage', maxCount: 1 }
]), async (req, res) => {
  try {
    if (req.user?.isBlocked) {
      return res.status(403).json({ message: 'Your account is restricted. Please settle outstanding platform fees to edit books.' });
    }

    // PayPal required for editing
    const user = await User.findById(req.user._id).select('payoutPaypalEmail');
    if (!user?.payoutPaypalEmail || !String(user.payoutPaypalEmail).trim()) {
      return res.status(403).json({ message: 'You must set your PayPal email before editing books. Go to Dashboard → Payout Settings.' });
    }

    const book = await Book.findById(req.params.id);

    if (!book) {
      return res.status(404).json({ message: 'Book not found' });
    }

    if (book.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to edit this book' });
    }

    const { title, description, genre, price } = req.body;

    if (title) book.title = title;
    if (description) book.description = description;
    if (genre) book.genre = genre;
    if (price) book.price = parseFloat(price);

    // Upload new files if provided
    if (req.files?.coverImage?.[0]) {
      const f = req.files.coverImage[0];
      if (isSpacesConfigured()) {
        book.coverImage = await uploadToSpaces(
          f.buffer,
          makeSpacesKey('covers', f.originalname, path.extname(f.originalname)),
          f.mimetype
        );
      } else {
        book.coverImage = `uploads/covers/${f.filename}`;
      }
    }
    if (req.files?.pdfFile?.[0]) {
      const f = req.files.pdfFile[0];
      if (isSpacesConfigured()) {
        book.pdfFile = await uploadToSpaces(
          f.buffer,
          makeSpacesKey('books', f.originalname, '.pdf'),
          'application/pdf'
        );
      } else {
        book.pdfFile = `uploads/books/${f.filename}`;
      }
    }

    book.updatedAt = Date.now();

    await book.save();
    await book.populate('author', 'name email');

    res.json(ensureFullUrls(book));
  } catch (error) {
    console.error('Book update error:', error);
    res.status(500).json({ message: error.message || 'Failed to update book' });
  }
});

module.exports = router;
