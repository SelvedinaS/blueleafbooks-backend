const express = require('express');
const { auth } = require('../middleware/auth');

const router = express.Router();

// In a real app, you might want to store cart in database or Redis
// For simplicity, we'll use session storage on frontend
// This route is just for validation

// Get cart items (validate book IDs)
router.post('/validate', async (req, res) => {
  try {
    const { bookIds } = req.body;
    const Book = require('../models/Book');
    
    const books = await Book.find({
      _id: { $in: bookIds },
      isDeleted: false
    }).select('_id title price coverImage author');
    
    res.json(books);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
