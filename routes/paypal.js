const express = require('express');
const paypal = require('@paypal/checkout-server-sdk');
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
 * Create PayPal order
 * Frontend sends:
 *  - items: [{ bookId }]
 *  - optional discountCode
 *
 * We calculate totals server-side to prevent price tampering.
 */
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

    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer('return=representation');
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: 'USD',
            value: pricing.total.toFixed(2)
          },
          description: `Purchase of ${pricing.books.length} book(s) from BlueLeafBooks`
        }
      ]
    });

    const order = await client().execute(request);

    // return both keys for compatibility with older frontend
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
