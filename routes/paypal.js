const express = require('express');
const paypal = require('@paypal/checkout-server-sdk');
const User = require('../models/User');
const { auth, authorize } = require('../middleware/auth');
const { calculateCartPricing } = require('../utils/pricing');

const router = express.Router();

// Configure PayPal environment
function environment() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const mode = process.env.PAYPAL_MODE || 'sandbox';

  if (!clientId || !clientSecret) {
    const err = new Error('PayPal is not configured (missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).');
    err.status = 500;
    throw err;
  }

  if (mode === 'live') {
    return new paypal.core.LiveEnvironment(clientId, clientSecret);
  }
  return new paypal.core.SandboxEnvironment(clientId, clientSecret);
}

function client() {
  return new paypal.core.PayPalHttpClient(environment());
}

/**
 * Create PayPal order.
 *
 * PAYPAL_SEND_TO_AUTHORS=true: Payment goes to author(s) via payee (requires PayPal Commerce Platform).
 * PAYPAL_SEND_TO_AUTHORS=false/unset: Payment goes to platform (default, works with standard API).
 *
 * Frontend sends: items: [{ bookId }], optional discountCode
 */
const SEND_TO_AUTHORS = process.env.PAYPAL_SEND_TO_AUTHORS === 'true';

router.post('/create-order', auth, authorize('customer'), async (req, res) => {
  try {
    const { items, discountCode } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Cart is empty' });
    }

    const bookIds = items.map(i => i.bookId).filter(Boolean);

    const pricing = await calculateCartPricing({ bookIds, couponCode: discountCode || null });

    if (!pricing.books || pricing.books.length === 0) {
      return res.status(400).json({ message: 'No valid books found' });
    }

    if (!pricing.total || pricing.total <= 0) {
      return res.status(400).json({ message: 'Invalid amount' });
    }

    let purchaseUnits;

    if (SEND_TO_AUTHORS) {
      // Payment goes directly to authors – requires PayPal Commerce Platform / partner onboarding
      const authorAmounts = {};
      for (const book of pricing.books) {
        const authorId = book.author.toString();
        const discItem = pricing.discountedItems.find(i => i.bookId.toString() === book._id.toString());
        const discPrice = discItem ? discItem.discountedPrice : Number(book.price || 0);
        authorAmounts[authorId] = (authorAmounts[authorId] || 0) + discPrice;
      }

      const authorIds = Object.keys(authorAmounts);
      const authors = await User.find({ _id: { $in: authorIds } })
        .select('_id name payoutPaypalEmail')
        .lean();

      const authorsWithoutPaypal = authors.filter(a => !a.payoutPaypalEmail || !a.payoutPaypalEmail.trim());
      if (authorsWithoutPaypal.length > 0) {
        const names = authorsWithoutPaypal.map(a => a.name || 'Author').join(', ');
        return res.status(400).json({
          message: `The following author(s) have not set their PayPal email: ${names}. Add PAYPAL_SEND_TO_AUTHORS=false in backend .env to use platform payment.`
        });
      }

      const authorMap = Object.fromEntries(authors.map(a => [a._id.toString(), a]));
      purchaseUnits = [];
      const amounts = Object.entries(authorAmounts);
      let runningTotal = 0;
      for (let i = 0; i < amounts.length; i++) {
        const [authorId, amt] = amounts[i];
        const author = authorMap[authorId];
        const isLast = i === amounts.length - 1;
        const value = isLast ? (pricing.total - runningTotal).toFixed(2) : amt.toFixed(2);
        runningTotal += parseFloat(value);
        purchaseUnits.push({
          amount: { currency_code: 'USD', value },
          payee: { email_address: author.payoutPaypalEmail.trim().toLowerCase() },
          description: `Book(s) from ${author.name || 'author'} via BlueLeafBooks`
        });
      }
    } else {
      // Default: payment goes to platform (works with standard PayPal API)
      purchaseUnits = [{
        amount: { currency_code: 'USD', value: pricing.total.toFixed(2) },
        description: `Purchase of ${pricing.books.length} book(s) from BlueLeafBooks`
      }];
    }

    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer('return=representation');
    request.requestBody({ intent: 'CAPTURE', purchase_units: purchaseUnits });

    const order = await client().execute(request);

    res.json({
      success: true,
      id: order.result.id,
      orderId: order.result.id,
      amount: pricing.total,
      pricing
    });
  } catch (error) {
    console.error('PayPal create-order error:', error);
    const status = error.status || 500;
    res.status(status).json({ message: error.message });
  }
});

// Capture PayPal payment
router.post('/capture-order', auth, authorize('customer'), async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ message: 'Order ID is required' });
    }

    const request = new paypal.orders.OrdersCaptureRequest(orderId);
    request.requestBody({});

    const capture = await client().execute(request);

    if (capture.result.status === 'COMPLETED') {
      res.json({
        success: true,
        orderId,
        paymentId: capture.result.id, // PayPal capture id
        payer: capture.result.payer
      });
    } else {
      res.status(400).json({ message: 'Payment not completed' });
    }
  } catch (error) {
    console.error('PayPal capture error:', error);
    const status = error.status || 500;
    res.status(status).json({ message: error.message });
  }
});

// Get PayPal Client ID (public endpoint for frontend)
router.get('/client-id', (req, res) => {
  res.json({ clientId: process.env.PAYPAL_CLIENT_ID || '' });
});

module.exports = router;
