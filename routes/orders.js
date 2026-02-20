const express = require('express');
const Order = require('../models/Order');
const Book = require('../models/Book');
const { auth, authorize } = require('../middleware/auth');
const { calculateCartPricing } = require('../utils/pricing');

const router = express.Router();

const PLATFORM_FEE_PERCENTAGE = parseFloat(process.env.PLATFORM_FEE_PERCENTAGE || 10);

// Create order
router.post('/', auth, authorize('customer'), async (req, res) => {
  try {
    const { items, paymentId, discountCode } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ message: 'Cart is empty' });
    }

    // Fetch books and calculate totals (including coupon) server-side
    const bookIds = items.map(item => item.bookId).filter(Boolean);
    const pricing = await calculateCartPricing({ bookIds, couponCode: discountCode || null });

    if (!pricing.books || pricing.books.length !== bookIds.length) {
      return res.status(400).json({ message: 'Some books are not available' });
    }

    const books = await Book.find({ _id: { $in: bookIds }, isDeleted: false });

    let originalTotal = pricing.originalTotal;
    const totalAmount = pricing.total;
    const appliedDiscountAmount = pricing.discountAmount;

    // Build order items
    const orderItems = books.map(book => ({
      book: book._id,
      price: book.price
    }));

    // Calculate platform/author earnings based on final total (after discount)
    const platformEarnings = totalAmount * (PLATFORM_FEE_PERCENTAGE / 100);
    const totalAuthorEarnings = totalAmount - platformEarnings;

    // Calculate author earnings breakdown proportionally to each book's original price
    const authorEarningsMap = {};
    for (const book of books) {
      const bookShare = originalTotal > 0 ? (book.price / originalTotal) : 0;
      const bookFinalPrice = totalAmount * bookShare;
      const authorEarning = bookFinalPrice * (1 - PLATFORM_FEE_PERCENTAGE / 100);

      const authorId = book.author.toString();
      if (!authorEarningsMap[authorId]) authorEarningsMap[authorId] = 0;
      authorEarningsMap[authorId] += authorEarning;
    }

    // Authors receive payment directly via PayPal (payee). paidOut=true since no manual payout by platform.
    const authorEarningsBreakdown = Object.entries(authorEarningsMap).map(([author, amount]) => ({
      author,
      amount,
      paidOut: true // Money went directly to author's PayPal; platform fee is paid by author monthly
    }));

    // Create order
    const order = new Order({
      customer: req.user._id,
      items: orderItems,
      totalAmount,
      platformEarnings,
      authorEarnings: totalAuthorEarnings,
      authorEarningsBreakdown,
      paymentId,
      paymentStatus: 'completed',
      discountCode: pricing.discountCode || undefined,
      discountPercentage: pricing.discountPercentage != null ? parseFloat(pricing.discountPercentage) : undefined,
      discountAmount: appliedDiscountAmount > 0 ? appliedDiscountAmount : undefined
    });

    await order.save();

    // Update book sales counts
    for (const book of books) {
      book.salesCount += 1;
      await book.save();
    }

    await order.populate('items.book', 'title coverImage');
    await order.populate('customer', 'name email');

    res.status(201).json(order);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ message: error.message });
  }
});

// Get customer orders
router.get('/my-orders', auth, authorize('customer'), async (req, res) => {
  try {
    const orders = await Order.find({ customer: req.user._id })
      .populate('items.book', 'title coverImage author pdfFile isDeleted')
      .sort({ createdAt: -1 });

    // Keep items for deleted books so previous buyers retain access.
    // Only drop entries where the book document truly no longer exists.
    const cleanedOrders = orders.map(order => {
      const items = order.items.filter(item => item.book);
      return {
        ...order.toObject(),
        items
      };
    });

    res.json(cleanedOrders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get all orders (admin only)
router.get('/all', auth, authorize('admin'), async (req, res) => {
  try {
    const orders = await Order.find()
      .populate('customer', 'name email')
      .populate('items.book', 'title author')
      .sort({ createdAt: -1 });

    res.json(orders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get order by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('customer', 'name email')
      .populate('items.book', 'title coverImage author pdfFile');

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Check if user has access
    if (req.user.role !== 'admin' && order.customer._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json(order);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
