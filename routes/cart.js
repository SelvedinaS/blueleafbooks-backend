const express = require('express');
const { ensureFullUrlsMany } = require('../utils/fileUrls');

const router = express.Router();

// In a real app, you might want to store cart in database or Redis.
// For simplicity, cart is stored on frontend (localStorage).
// This route validates book IDs and returns the current book data.
router.post('/validate', async (req, res) => {
  try {
    const { bookIds } = req.body;
    const Book = require('../models/Book');

    if (!Array.isArray(bookIds) || bookIds.length === 0) {
      return res.json([]);
    }

    const books = await Book.find({
      _id: { $in: bookIds },
      isDeleted: false
    })
      .select('_id title price coverImage author')
      .populate('author', 'name');

    res.json(ensureFullUrlsMany(books));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
