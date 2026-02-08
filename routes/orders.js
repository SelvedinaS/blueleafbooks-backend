const express = require('express');
const Order = require('../models/Order');
const Book = require('../models/Book');
const { auth, authorize } = require('../middleware/auth');

const router = express.Router();

const PLATFORM_FEE_PERCENTAGE = parseFloat(process.env.PLATFORM_FEE_PERCENTAGE || 10);

// Create order
router.post('/', auth, authorize('customer'), async (req, res) => {
  try {
    const { items, paymentId, discountCode, discountPercentage, discountAmount } = req.body;
    
    if (!items || items.length === 0) {
      return res.status(400).json({ message: 'Cart is empty' });
    }
    
    // Fetch books and calculate totals
    const bookIds = items.map(item => item.bookId);
    const books = await Book.find({ _id: { $in: bookIds }, isDeleted: false });
    
    if (books.length !== items.length) {
      return res.status(400).json({ message: 'Some books are not available' });
    }
    
    let originalTotal = 0;
    const orderItems = [];
    const authorEarningsBreakdown = [];
    const authorEarningsMap = {};
    
    for (const item of items) {
      const book = books.find(b => b._id.toString() === item.bookId);
      if (!book) continue;
      
      const itemPrice = book.price;
      originalTotal += itemPrice;
      
      orderItems.push({
        book: book._id,
        price: itemPrice
      });
    }
    
    // Apply discount if provided
    const appliedDiscountAmount = discountAmount ? parseFloat(discountAmount) : 0;
    const totalAmount = originalTotal - appliedDiscountAmount;
    
    // Calculate earnings based on final price (after discount)
    // Earnings are calculated proportionally based on each book's share of the total
    const platformEarnings = totalAmount * (PLATFORM_FEE_PERCENTAGE / 100);
    const totalAuthorEarnings = totalAmount - platformEarnings;
    
    // Calculate author earnings breakdown proportionally
    for (const item of items) {
      const book = books.find(b => b._id.toString() === item.bookId);
      if (!book) continue;
      
      // Calculate this book's share of the total
      const bookShare = book.price / originalTotal;
      const bookFinalPrice = totalAmount * bookShare;
      const authorEarning = bookFinalPrice * (1 - PLATFORM_FEE_PERCENTAGE / 100);
      
      if (!authorEarningsMap[book.author.toString()]) {
        authorEarningsMap[book.author.toString()] = 0;
      }
      authorEarningsMap[book.author.toString()] += authorEarning;
    }
    
    // Create breakdown
    for (const [authorId, amount] of Object.entries(authorEarningsMap)) {
      authorEarningsBreakdown.push({
        author: authorId,
        amount: amount,
        paidOut: false
      });
    }
    
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
      discountCode: discountCode || undefined,
      discountPercentage: discountPercentage ? parseFloat(discountPercentage) : undefined,
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
    res.status(500).json({ message: error.message });
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
