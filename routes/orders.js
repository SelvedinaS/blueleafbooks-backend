const express = require('express');
const paypal = require('@paypal/checkout-server-sdk');

const Order = require('../models/Order');
const Book = require('../models/Book');
const { auth, authorize } = require('../middleware/auth');
const { calculateCartPricing } = require('../utils/pricing');
const { ensureFullUrls } = require('../utils/fileUrls');

const router = express.Router();

const PLATFORM_FEE_PERCENTAGE = parseFloat(process.env.PLATFORM_FEE_PERCENTAGE || 10);

/* =========================
   PAYPAL HELPERS (VERIFY)
========================= */
const PAYPAL_MODE = (process.env.PAYPAL_MODE || 'sandbox').toLowerCase();

function environment() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    const err = new Error('PayPal is not configured.');
    err.status = 500;
    throw err;
  }

  return PAYPAL_MODE === 'live'
    ? new paypal.core.LiveEnvironment(clientId, clientSecret)
    : new paypal.core.SandboxEnvironment(clientId, clientSecret);
}

function paypalClient() {
  return new paypal.core.PayPalHttpClient(environment());
}

function parsePayPalError(err) {
  const out = {
    statusCode: err.statusCode || err.status || 500,
    message: err.message,
    debug_id: null,
    name: null,
    details: null
  };

  if (err.headers) {
    out.debug_id =
      err.headers['paypal-debug-id'] ||
      err.headers['PayPal-Debug-Id'] ||
      null;
  }

  try {
    const body = typeof err.message === 'string' ? JSON.parse(err.message) : err.message;
    if (body?.debug_id) out.debug_id = body.debug_id;
    if (body?.name) out.name = body.name;
    if (body?.details) out.details = body.details;
  } catch (_) {}

  return out;
}

/* =========================
   CREATE ORDER (SECURE)
========================= */
router.post('/', auth, authorize('customer'), async (req, res) => {
  try {
    const { items, paymentId, discountCode } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ message: 'Cart is empty' });
    }

    if (!paymentId) {
      return res.status(400).json({ message: 'paymentId (PayPal orderId) is required' });
    }

    // Fetch books and calculate totals (including coupon) server-side
    const bookIds = items.map(item => item.bookId).filter(Boolean);
    const pricing = await calculateCartPricing({ bookIds, couponCode: discountCode || null });

    if (!pricing.books || pricing.books.length !== bookIds.length) {
      return res.status(400).json({ message: 'Some books are not available' });
    }

    // Ensure all books exist and are not deleted
    const books = await Book.find({ _id: { $in: bookIds }, isDeleted: false });

    if (!books || books.length !== bookIds.length) {
      return res.status(400).json({ message: 'Some books are not available' });
    }

    const originalTotal = Number(pricing.originalTotal || 0);
    const totalAmount = Number(pricing.total || 0);
    const appliedDiscountAmount = Number(pricing.discountAmount || 0);

    if (!totalAmount || totalAmount <= 0) {
      return res.status(400).json({ message: 'Invalid amount' });
    }

    /* =========================
       PAYPAL VERIFY (CRITICAL)
    ========================= */
    let paypalOrder;
    try {
      const request = new paypal.orders.OrdersGetRequest(paymentId);
      paypalOrder = await paypalClient().execute(request);
    } catch (e) {
      const parsed = parsePayPalError(e);
      return res.status(parsed.statusCode).json({
        message: 'PayPal verification failed.',
        name: parsed.name,
        details: parsed.details,
        debug_id: parsed.debug_id
      });
    }

    const pp = paypalOrder?.result;
    if (!pp) {
      return res.status(400).json({ message: 'Invalid PayPal order.' });
    }

    if (pp.status !== 'COMPLETED') {
      return res.status(400).json({
        message: `Payment not completed. Current status: ${pp.status || 'UNKNOWN'}`
      });
    }

    // Verify paid amount matches our computed total
    const paidAmountStr = pp.purchase_units?.[0]?.amount?.value;
    const paidCurrency = pp.purchase_units?.[0]?.amount?.currency_code;

    const paidAmount = parseFloat(paidAmountStr);
    const expectedAmount = parseFloat(totalAmount.toFixed(2));

    if (paidCurrency && paidCurrency !== 'USD') {
      return res.status(400).json({ message: 'Payment currency mismatch.' });
    }

    if (Number.isNaN(paidAmount) || paidAmount !== expectedAmount) {
      return res.status(400).json({
        message: 'Payment amount mismatch.',
        expected: expectedAmount,
        paid: paidAmount
      });
    }

    /* =========================
       BUILD ORDER
    ========================= */
    const orderItems = books.map(book => ({
      book: book._id,
      price: book.price
    }));

    const platformEarnings = totalAmount * (PLATFORM_FEE_PERCENTAGE / 100);
    const totalAuthorEarnings = totalAmount - platformEarnings;

    // Author earnings breakdown proportional to each book's original price
    const authorEarningsMap = {};
    for (const book of books) {
      const bookShare = originalTotal > 0 ? (book.price / originalTotal) : 0;
      const bookFinalPrice = totalAmount * bookShare;
      const authorEarning = bookFinalPrice * (1 - PLATFORM_FEE_PERCENTAGE / 100);

      const authorId = book.author.toString();
      if (!authorEarningsMap[authorId]) authorEarningsMap[authorId] = 0;
      authorEarningsMap[authorId] += authorEarning;
    }

    const authorsReceiveDirectly = process.env.PAYPAL_SEND_TO_AUTHORS !== 'false';
    const authorEarningsBreakdown = Object.entries(authorEarningsMap).map(([author, amount]) => ({
      author,
      amount,
      paidOut: authorsReceiveDirectly
    }));

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

    const orderObj = order.toObject();
    orderObj.items = (orderObj.items || []).map(it => ({
      ...it,
      book: it.book ? ensureFullUrls(it.book) : it.book
    }));

    console.log('[Orders] Created order', orderObj._id, 'total:', totalAmount);
    return res.status(201).json(orderObj);

  } catch (error) {
    console.error('[Orders] Create failed:', error.message, error.stack);
    const status = error.status || 500;
    return res.status(status).json({ message: error.message });
  }
});

/* =========================
   GET CUSTOMER ORDERS
========================= */
router.get('/my-orders', auth, authorize('customer'), async (req, res) => {
  try {
    const orders = await Order.find({ customer: req.user._id })
      .populate('items.book', 'title coverImage author pdfFile isDeleted')
      .sort({ createdAt: -1 });

    const cleanedOrders = orders.map(order => {
      const items = order.items
        .filter(item => item.book)
        .map(item => ({ ...item, book: ensureFullUrls(item.book) }));
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

/* =========================
   GET ALL ORDERS (ADMIN)
========================= */
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

/* =========================
   GET ORDER BY ID
========================= */
router.get('/:id', auth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('customer', 'name email')
      .populate('items.book', 'title coverImage author pdfFile');

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (req.user.role !== 'admin' && order.customer._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const orderObj = order.toObject();
    orderObj.items = (orderObj.items || []).map(it => ({
      ...it,
      book: it.book ? ensureFullUrls(it.book) : it.book
    }));
    res.json(orderObj);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;