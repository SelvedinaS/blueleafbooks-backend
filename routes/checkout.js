const express = require('express');
const Coupon = require('../models/Coupon');
const Book = require('../models/Book');
const { auth } = require('../middleware/auth');

const router = express.Router();

// Apply coupon to cart
// Rule: For author-scoped coupons, at least one item in the cart must belong to that author
router.post('/apply-coupon', auth, async (req, res) => {
  try {
    const { code, bookIds } = req.body;
    
    if (!code || !bookIds || bookIds.length === 0) {
      return res.status(400).json({ 
        success: false,
        message: 'Code and book IDs are required' 
      });
    }
    
    // Find coupon by code
    const coupon = await Coupon.findOne({ 
      code: code.toUpperCase().trim() 
    }).populate('author', 'name email');
    
    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: 'Invalid coupon code'
      });
    }
    
    // Check if coupon is active
    if (!coupon.isActive) {
      return res.status(400).json({
        success: false,
        message: 'This coupon is not active'
      });
    }
    
    // Check validity dates
    const now = new Date();
    if (coupon.validFrom && now < coupon.validFrom) {
      return res.status(400).json({
        success: false,
        message: 'This coupon is not yet valid'
      });
    }
    
    if (coupon.validTo && now > coupon.validTo) {
      return res.status(400).json({
        success: false,
        message: 'This coupon has expired'
      });
    }
    
    // Fetch books to calculate total and validate author scope
    const books = await Book.find({ 
      _id: { $in: bookIds }
    });
    
    if (books.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid books found'
      });
    }
    
    // If scope is author, check that at least one book belongs to that author
    if (coupon.scope === 'author') {
      const hasAuthorBook = books.some(
        book => book.author.toString() === coupon.author._id.toString()
      );
      
      if (!hasAuthorBook) {
        return res.status(400).json({
          success: false,
          message: 'This coupon is only valid for books by ' + coupon.author.name
        });
      }
    }
    
    // Calculate per-book discounts and totals
    const totalAmount = books.reduce((sum, book) => sum + book.price, 0);

    const discountedItems = books.map(book => {
      const isEligible =
        coupon.scope === 'all' ||
        (coupon.scope === 'author' && coupon.author && book.author.toString() === coupon.author._id.toString());

      const originalPrice = book.price;
      const bookDiscountAmount = isEligible
        ? originalPrice * (coupon.discountPercentage / 100)
        : 0;
      const discountedPrice = originalPrice - bookDiscountAmount;

      return {
        bookId: book._id,
        originalPrice: parseFloat(originalPrice.toFixed(2)),
        discountedPrice: parseFloat(discountedPrice.toFixed(2)),
        discountAmount: parseFloat(bookDiscountAmount.toFixed(2)),
        isDiscounted: isEligible
      };
    });

    const newTotal = discountedItems.reduce((sum, item) => sum + item.discountedPrice, 0);
    const discountAmount = totalAmount - newTotal;
    
    res.json({
      success: true,
      message: 'Coupon applied successfully',
      discountCode: coupon.code,
      discountPercentage: coupon.discountPercentage,
      discountAmount: parseFloat(discountAmount.toFixed(2)),
      originalTotal: parseFloat(totalAmount.toFixed(2)),
      newTotal: parseFloat(newTotal.toFixed(2)),
      scope: coupon.scope,
      author: coupon.author ? { id: coupon.author._id, name: coupon.author.name || '' } : null,
      discountedItems
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

module.exports = router;
