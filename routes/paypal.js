const express = require('express');
const paypal = require('@paypal/checkout-server-sdk');
const User = require('../models/User');
const { auth, authorize } = require('../middleware/auth');
const { calculateCartPricing } = require('../utils/pricing');

const router = express.Router();

const PAYPAL_MODE = (process.env.PAYPAL_MODE || 'sandbox').toLowerCase();
const IS_SANDBOX = PAYPAL_MODE !== 'live';

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

function client() {
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
    const body =
      typeof err.message === 'string'
        ? JSON.parse(err.message)
        : err.message;

    if (body?.debug_id) out.debug_id = body.debug_id;
    if (body?.name) out.name = body.name;
    if (body?.details) out.details = body.details;
  } catch (_) {}

  return out;
}

/* =========================
   CREATE ORDER
========================= */
router.post('/create-order', auth, authorize('customer'), async (req, res) => {
  try {
    const { items, discountCode } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Cart is empty' });
    }

    const bookIds = items.map(i => i.bookId).filter(Boolean);

    const pricing = await calculateCartPricing({
      bookIds,
      couponCode: discountCode || null
    });

    if (!pricing.total || pricing.total <= 0) {
      return res.status(400).json({ message: 'Invalid amount' });
    }

    const purchaseUnits = [{
      amount: {
        currency_code: 'USD',
        value: Number(pricing.total).toFixed(2)
      },
      description: `Purchase of ${pricing.books.length} book(s)`
    }];

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
      status: order.result?.status
    });

    return res.json({
      success: true,
      orderId: order.result.id
    });

  } catch (error) {
    const parsed = parsePayPalError(error);

    console.error('[PayPal create-order] FAILED', parsed);

    return res.status(parsed.statusCode).json({
      message: parsed.message,
      name: parsed.name,
      details: parsed.details,
      debug_id: parsed.debug_id
    });
  }
});

/* =========================
   CAPTURE ORDER
========================= */
router.post('/capture-order', auth, authorize('customer'), async (req, res) => {
  const { orderId } = req.body;

  try {
    if (!orderId) {
      return res.status(400).json({ message: 'Order ID is required' });
    }

    const request = new paypal.orders.OrdersCaptureRequest(orderId);
    request.requestBody({});

    const capture = await client().execute(request);

    console.log('[PayPal capture-order] OK', {
      orderId,
      status: capture.result?.status
    });

    if (capture.result?.status === 'COMPLETED') {
      return res.json({
        success: true,
        orderId,
        paymentId: capture.result.id,
        payer: capture.result.payer
      });
    }

    return res.status(400).json({ message: 'Payment not completed' });

  } catch (error) {
    const parsed = parsePayPalError(error);

    console.error('[PayPal capture-order] FAILED', parsed);

    return res.status(parsed.statusCode).json({
      message: parsed.message,
      name: parsed.name,
      details: parsed.details,
      debug_id: parsed.debug_id
    });
  }
});

/* =========================
   CLIENT ID
========================= */
router.get('/client-id', (req, res) => {
  res.json({
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    mode: PAYPAL_MODE,
    isSandbox: IS_SANDBOX
  });
});

module.exports = router;