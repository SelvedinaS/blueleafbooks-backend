const Coupon = require('../models/Coupon');
const Book = require('../models/Book');

/**
 * Calculate cart totals with optional coupon.
 * This is the single source of truth for:
 * - coupon validation
 * - author-scoped coupon eligibility
 * - per-item discounted prices
 */
async function calculateCartPricing({ bookIds, couponCode }) {
  if (!Array.isArray(bookIds) || bookIds.length === 0) {
    return {
      books: [],
      originalTotal: 0,
      discountAmount: 0,
      total: 0,
      discountCode: null,
      discountPercentage: null,
      discountedItems: []
    };
  }

  const books = await Book.find({
    _id: { $in: bookIds },
    isDeleted: false
  }).select('_id title price author');

  const originalTotal = books.reduce((sum, b) => sum + Number(b.price || 0), 0);

  // No coupon
  if (!couponCode) {
    return {
      books,
      originalTotal: parseFloat(originalTotal.toFixed(2)),
      discountAmount: 0,
      total: parseFloat(originalTotal.toFixed(2)),
      discountCode: null,
      discountPercentage: null,
      discountedItems: books.map(b => ({
        bookId: b._id,
        originalPrice: parseFloat(Number(b.price || 0).toFixed(2)),
        discountedPrice: parseFloat(Number(b.price || 0).toFixed(2)),
        discountAmount: 0,
        isDiscounted: false
      }))
    };
  }

  const code = String(couponCode).toUpperCase().trim();

  const coupon = await Coupon.findOne({ code }).populate('author', 'name email');

  if (!coupon) {
    const err = new Error('Invalid coupon code');
    err.status = 404;
    throw err;
  }

  if (!coupon.isActive) {
    const err = new Error('This coupon is not active');
    err.status = 400;
    throw err;
  }

  const now = new Date();
  if (coupon.validFrom && now < coupon.validFrom) {
    const err = new Error('This coupon is not yet valid');
    err.status = 400;
    throw err;
  }
  if (coupon.validTo && now > coupon.validTo) {
    const err = new Error('This coupon has expired');
    err.status = 400;
    throw err;
  }

  // If scope is author, ensure at least one book in cart belongs to that author.
  if (coupon.scope === 'author') {
    const hasAuthorBook = books.some(
      b => b.author && coupon.author && b.author.toString() === coupon.author._id.toString()
    );
    if (!hasAuthorBook) {
      const err = new Error('This coupon is only valid for books by ' + (coupon.author?.name || 'the selected author'));
      err.status = 400;
      throw err;
    }
  }

  const discountPercentage = Number(coupon.discountPercentage || 0);

  const discountedItems = books.map(book => {
    const originalPrice = Number(book.price || 0);

    const isEligible =
      coupon.scope === 'all' ||
      (coupon.scope === 'author' && coupon.author && book.author && book.author.toString() === coupon.author._id.toString());

    const bookDiscountAmount = isEligible ? originalPrice * (discountPercentage / 100) : 0;
    const discountedPrice = Math.max(0, originalPrice - bookDiscountAmount);

    return {
      bookId: book._id,
      originalPrice: parseFloat(originalPrice.toFixed(2)),
      discountedPrice: parseFloat(discountedPrice.toFixed(2)),
      discountAmount: parseFloat(bookDiscountAmount.toFixed(2)),
      isDiscounted: isEligible
    };
  });

  const newTotal = discountedItems.reduce((sum, i) => sum + Number(i.discountedPrice || 0), 0);
  const discountAmount = Math.max(0, originalTotal - newTotal);

  return {
    books,
    originalTotal: parseFloat(originalTotal.toFixed(2)),
    discountAmount: parseFloat(discountAmount.toFixed(2)),
    total: parseFloat(newTotal.toFixed(2)),
    discountCode: coupon.code,
    discountPercentage,
    scope: coupon.scope,
    author: coupon.author ? { id: coupon.author._id, name: coupon.author.name || '' } : null,
    discountedItems
  };
}

module.exports = { calculateCartPricing };
