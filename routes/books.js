const express = require('express');
const multer = require('multer');
const path = require('path');
const Book = require('../models/Book');
const { auth, authorize } = require('../middleware/auth');
const { uploadToSpaces } = require('../config/spaces');

const router = express.Router();

// Multer memory storage - files stay in RAM, we upload to DigitalOcean Spaces
const storage = multer.memoryStorage();

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
 * Generate unique key for Spaces (folder/filename)
 */
function makeSpacesKey(folder, originalName, ext) {
  const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
  const safeExt = ext || path.extname(originalName || '') || '.bin';
  return `blueleafbooks/${folder}/${unique}${safeExt}`;
}

// Get all books (public, with filters)
router.get('/', async (req, res) => {
  try {
    const { genre, search, sortBy = 'createdAt', order = 'desc', minPrice, maxPrice } = req.query;

    // Public catalog: show all non-deleted books
    let query = { isDeleted: false, status: 'approved' };

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
      .populate('author', 'name email isBlocked')
      .sort(sortOptions);

    // Filter out books whose author is blocked (unpaid fees / admin restriction)
    const books = (booksRaw || []).filter(b => !b?.author?.isBlocked);

    res.json(books);
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
    const booksRaw = await Book.find({ isDeleted: false, status: 'approved' })
      .sort({ salesCount: -1 })
      .limit(10)
      .populate('author', 'name email isBlocked');

    // Hide blocked authors' books from public lists
    const books = (booksRaw || []).filter(b => !b?.author?.isBlocked);
    res.json(books);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get newly added
router.get('/featured/new', async (req, res) => {
  try {
    const booksRaw = await Book.find({ isDeleted: false, status: 'approved' })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('author', 'name email isBlocked');

    const books = (booksRaw || []).filter(b => !b?.author?.isBlocked);
    res.json(books);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});


// Curated featured books: manually selected by admin (isFeatured + featuredOrder)
router.get('/featured/curated', async (req, res) => {
  try {
    const booksRaw = await Book.find({ isDeleted: false, status: 'approved', isFeatured: true })
      .sort({ featuredOrder: 1, createdAt: -1 })
      .limit(12)
      .populate('author', 'name email isBlocked');

    const books = (booksRaw || []).filter(b => !b?.author?.isBlocked);
    res.json(books);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get book by ID
router.get('/:id', async (req, res) => {
  try {
    const book = await Book.findById(req.params.id)
      .populate('author', 'name email isBlocked');

    if (!book || book.isDeleted) {
      return res.status(404).json({ message: 'Book not found' });
    }

    // Hide blocked authors' books from the public catalog
    if (book?.author?.isBlocked) {
      return res.status(404).json({ message: 'Book not found' });
    }

    res.json(book);
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

    if (!req.files?.pdfFile?.[0] || !req.files?.coverImage?.[0]) {
      return res.status(400).json({ message: 'PDF file and cover image are required' });
    }

    const coverFile = req.files.coverImage[0];
    const pdfFile = req.files.pdfFile[0];

    // Upload to DigitalOcean Spaces
    const [coverUrl, pdfUrl] = await Promise.all([
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

    const book = new Book({
      title,
      description,
      genre,
      price: parseFloat(price),
      author: req.user._id,
      pdfFile: pdfUrl,
      coverImage: coverUrl,
      status: (req.user?.payoutPaypalEmail ? 'approved' : 'pending')
    });

    await book.save();
    await book.populate('author', 'name email');

    res.status(201).json(book);
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

    // Upload new files to Spaces if provided
    if (req.files?.coverImage?.[0]) {
      const f = req.files.coverImage[0];
      book.coverImage = await uploadToSpaces(
        f.buffer,
        makeSpacesKey('covers', f.originalname, path.extname(f.originalname)),
        f.mimetype
      );
    }
    if (req.files?.pdfFile?.[0]) {
      const f = req.files.pdfFile[0];
      book.pdfFile = await uploadToSpaces(
        f.buffer,
        makeSpacesKey('books', f.originalname, '.pdf'),
        'application/pdf'
      );
    }

    book.updatedAt = Date.now();

    await book.save();
    await book.populate('author', 'name email');

    res.json(book);
  } catch (error) {
    console.error('Book update error:', error);
    res.status(500).json({ message: error.message || 'Failed to update book' });
  }
});

module.exports = router;
