const express = require('express');
const paypal = require('@paypal/checkout-server-sdk');
const User = require('../models/User');
const { auth, authorize } = require('../middleware/auth');
const { calculateCartPricing } = require('../utils/pricing');

const router = express.Router();

const PAYPAL_MODE = (process.env.PAYPAL_MODE || 'sandbox').toLowerCase();
const IS_SANDBOX = PAYPAL_MODE !== 'live';

// Configure PayPal environment (sandbox uses api-m.sandbox.paypal.com)
function environment() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    const err = new Error('PayPal is not configured (missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).');
    err.status = 500;
    throw err;
  }

  if (PAYPAL_MODE === 'live') {
    return new paypal.core.LiveEnvironment(clientId, clientSecret);
  }
  return new paypal.core.SandboxEnvironment(clientId, clientSecret);
}

function client() {
  return new paypal.core.PayPalHttpClient(environment());
}

function parsePayPalError(err) {
  const out = {
    statusCode: err.statusCode,
    message: err.message,
    debug_id: null
  };
  if (err.headers && typeof err.headers === 'object') {
    const h = err.headers;
    out.debug_id = h['paypal-debug-id'] || h['PayPal-Debug-Id'] || null;
  }
  try {
    const body = typeof err.message === 'string' ? JSON.parse(err.message) : err.message;
    if (body && body.debug_id) out.debug_id = body.debug_id;
    if (body && body.name) out.name = body.name;
    if (body && body.details) out.details = body.details;
  } catch (_) {}
  return out;
}

/**
 * Create PayPal order.
 *
 * PAYPAL_SEND_TO_AUTHORS=true: Payment goes directly to author(s) via payee.
 * PAYPAL_SEND_TO_AUTHORS=false: Payment goes to platform.
 *
 * For direct-to-author: PayPal app must be type "Platform" (marketplace), not "Merchant".
 * Each author must set their PayPal email in Author Dashboard → Payout settings.
 *
 * Frontend sends: items: [{ bookId }], optional discountCode
 */
const SEND_TO_AUTHORS = process.env.PAYPAL_SEND_TO_AUTHORS !== 'false';

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
          message: `The following author(s) have not set their PayPal email: ${names}. They must add it in Author Dashboard → Payout settings.`
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

    console.log('[PayPal create-order] Request', {
      mode: PAYPAL_MODE,
      sendToAuthors: SEND_TO_AUTHORS,
      total: pricing.total,
      unitCount: purchaseUnits.length
    });

    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer('return=representation');
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: purchaseUnits,
      application_context: {
        shipping_preference: 'NO_SHIPPING'
      }
    });

    const order = await client().execute(request);

    console.log('[PayPal create-order] OK', {
      orderId: order.result?.id,
      status: order.result?.status,
      mode: PAYPAL_MODE
    });

    res.json({
      success: true,
      id: order.result.id,
      orderId: order.result.id,
      amount: pricing.total,
      pricing
    });
  } catch (error) {
    const parsed = parsePayPalError(error);
    console.error('[PayPal create-order] FAILED', {
      statusCode: parsed.statusCode,
      message: parsed.message,
      name: parsed.name,
      debug_id: parsed.debug_id,
      mode: PAYPAL_MODE
    });
    if (parsed.debug_id) {
      console.error('[PayPal create-order] debug_id for support:', parsed.debug_id);
    }
    const status = error.status || error.statusCode || 500;
    const payload = { message: error.message };
    if (parsed.debug_id) payload.debug_id = parsed.debug_id;
    res.status(status).json(payload);
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

    console.log('[PayPal capture-order] OK', {
      orderId,
      status: capture.result?.status,
      captureId: capture.result?.id,
      mode: PAYPAL_MODE
    });

    if (capture.result.status === 'COMPLETED') {
      res.json({
        success: true,
        orderId,
        paymentId: capture.result.id,
        payer: capture.result.payer
      });
    } else {
      res.status(400).json({ message: 'Payment not completed' });
    }
  } catch (error) {
    const parsed = parsePayPalError(error);
    console.error('[PayPal capture-order] FAILED', {
      orderId,
      statusCode: parsed.statusCode,
      message: parsed.message,
      name: parsed.name,
      debug_id: parsed.debug_id,
      mode: PAYPAL_MODE
    });
    if (parsed.debug_id) {
      console.error('[PayPal capture-order] debug_id for support:', parsed.debug_id);
    }
    const status = error.status || error.statusCode || 500;
    const payload = { message: error.message };
    if (parsed.debug_id) payload.debug_id = parsed.debug_id;
    res.status(status).json(payload);
  }
});

// Get PayPal Client ID and mode (frontend must use same mode - sandbox client-id for sandbox)
router.get('/client-id', (req, res) => {
  res.json({
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    mode: PAYPAL_MODE,
    isSandbox: IS_SANDBOX
  });
});

module.exports = router;
