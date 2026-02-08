const express = require('express');
const multer = require('multer');
const path = require('path');
const Book = require('../models/Book');
const { auth, authorize } = require('../middleware/auth');

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'pdfFile') {
      cb(null, 'uploads/books/');
    } else if (file.fieldname === 'coverImage') {
      cb(null, 'uploads/covers/');
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
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
    }
  }
});

// Get all books (public, with filters)
router.get('/', async (req, res) => {
  try {
    const { genre, search, sortBy = 'createdAt', order = 'desc', minPrice, maxPrice, status } = req.query;
    
    // For public catalog, show all non-deleted books regardless of status
    // (there is no manual approval step; only deleted books are hidden)
    let query = { isDeleted: false };
    
    if (genre) {
      query.genre = genre;
    }
    
    if (search) {
      query.$text = { $search: search };
    }
    
    if (minPrice || maxPrice) {
      query.price = {};
      if (minPrice) query.price.$gte = parseFloat(minPrice);
      if (maxPrice) query.price.$lte = parseFloat(maxPrice);
    }
    
    let sortOptions = {};
    if (sortBy === 'popularity') {
      sortOptions = { salesCount: order === 'asc' ? 1 : -1 };
    } else if (sortBy === 'rating') {
      sortOptions = { rating: order === 'asc' ? 1 : -1 };
    } else if (sortBy === 'price') {
      sortOptions = { price: order === 'asc' ? 1 : -1 };
    } else {
      sortOptions = { createdAt: order === 'asc' ? 1 : -1 };
    }
    
    const books = await Book.find(query)
      .populate('author', 'name email')
      .sort(sortOptions);
    
    res.json(books);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get book by ID
router.get('/:id', async (req, res) => {
  try {
    const book = await Book.findById(req.params.id)
      .populate('author', 'name email');
    
    if (!book || book.isDeleted) {
      return res.status(404).json({ message: 'Book not found' });
    }
    
    res.json(book);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

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
    const books = await Book.find({ isDeleted: false })
      .sort({ salesCount: -1 })
      .limit(10)
      .populate('author', 'name');
    res.json(books);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get newly added
router.get('/featured/new', async (req, res) => {
  try {
    const books = await Book.find({ isDeleted: false })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('author', 'name');
    res.json(books);
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
    
    if (!req.files.pdfFile || !req.files.coverImage) {
      return res.status(400).json({ message: 'PDF file and cover image are required' });
    }
    
    const book = new Book({
      title,
      description,
      genre,
      price: parseFloat(price),
      author: req.user._id,
      pdfFile: req.files.pdfFile[0].path,
      coverImage: req.files.coverImage[0].path,
      // Books go live immediately; no approval step required
      status: 'approved'
    });
    
    await book.save();
    await book.populate('author', 'name email');
    
    res.status(201).json(book);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update book (author only, their own books)
router.put('/:id', auth, authorize('author'), upload.fields([
  { name: 'pdfFile', maxCount: 1 },
  { name: 'coverImage', maxCount: 1 }
]), async (req, res) => {
  try {
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
    if (req.files.pdfFile) book.pdfFile = req.files.pdfFile[0].path;
    if (req.files.coverImage) book.coverImage = req.files.coverImage[0].path;
    
    book.updatedAt = Date.now();
    
    await book.save();
    await book.populate('author', 'name email');
    
    res.json(book);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
