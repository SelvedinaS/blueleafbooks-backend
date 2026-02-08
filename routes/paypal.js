const express = require('express');
const paypal = require('@paypal/checkout-server-sdk');
const { auth } = require('../middleware/auth');

const router = express.Router();

// Configure PayPal environment
function environment() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const mode = process.env.PAYPAL_MODE || 'sandbox';

  if (mode === 'live') {
    return new paypal.core.LiveEnvironment(clientId, clientSecret);
  } else {
    return new paypal.core.SandboxEnvironment(clientId, clientSecret);
  }
}

function client() {
  return new paypal.core.PayPalHttpClient(environment());
}

// Create PayPal order
router.post('/create-order', auth, async (req, res) => {
  try {
    const { amount, items } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Invalid amount' });
    }
    
    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer("return=representation");
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: 'USD',
          value: amount.toFixed(2)
        },
        description: `Purchase of ${items.length} book(s) from BlueLeafBooks`
      }]
    });
    
    const order = await client().execute(request);
    res.json({ orderId: order.result.id });
  } catch (error) {
    console.error('PayPal error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Capture PayPal payment
router.post('/capture-order', auth, async (req, res) => {
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
        paymentId: capture.result.id,
        payer: capture.result.payer
      });
    } else {
      res.status(400).json({ message: 'Payment not completed' });
    }
  } catch (error) {
    console.error('PayPal capture error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get PayPal Client ID (public endpoint for frontend)
router.get('/client-id', (req, res) => {
  res.json({ clientId: process.env.PAYPAL_CLIENT_ID || '' });
});

module.exports = router;
