const express = require('express');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const Book = require('../models/Book');
const Order = require('../models/Order');
const User = require('../models/User');
const Coupon = require('../models/Coupon');
const PlatformFeeStatus = require('../models/PlatformFeeStatus');
const { auth, authorize } = require('../middleware/auth');

const router = express.Router();

const PLATFORM_FEE_PERCENTAGE = parseFloat(process.env.PLATFORM_FEE_PERCENTAGE || 10);


function parsePeriod(periodStr) {
  // periodStr: YYYY-MM
  if (!periodStr || !/^\d{4}-\d{2}$/.test(periodStr)) return null;
  const [y, m] = periodStr.split('-').map(n => parseInt(n, 10));
  if (!y || !m || m < 1 || m > 12) return null;
  return { year: y, month: m };
}

function periodRange(periodStr) {
  const p = parsePeriod(periodStr);
  if (!p) return null;
  const start = new Date(p.year, p.month - 1, 1);
  const end = new Date(p.year, p.month, 1);
  return { start, end, year: p.year, month: p.month };
}

function previousMonthPeriod() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1; // 1-12
  const prevM = m === 1 ? 12 : m - 1;
  const prevY = m === 1 ? y - 1 : y;
  return `${prevY}-${String(prevM).padStart(2, '0')}`;
}

function calcFeeFromNet(net, feePct) {
  const rate = feePct / 100;
  if (rate <= 0 || rate >= 1) return 0;
  return net * (rate / (1 - rate));
}

function getBillingWindow(createdAt, now) {
  const created = new Date(createdAt);
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const trialEndsAt = new Date(created.getTime() + THIRTY_DAYS_MS);
  const isInTrial = now < trialEndsAt;
  const billingDay = Math.min(28, Math.max(1, created.getDate()));
  const y = now.getFullYear();
  const m = now.getMonth();
  const periodStart = now.getDate() >= billingDay
    ? new Date(y, m, billingDay, 0, 0, 0, 0)
    : new Date(y, m - 1, billingDay, 0, 0, 0, 0);
  return { periodStart, billingDay, isInTrial, trialEndsAt };
}

function makeDateWithClampedDay(y, m, day, h, min, s, ms) {
  const lastDay = new Date(y, m + 1, 0).getDate();
  const clampedDay = Math.min(day, lastDay);
  return new Date(y, m, clampedDay, h, min, s, ms);
}

function makeCycleKey(start, end) {
  const fmt = d => d.toISOString().slice(0, 10);
  return `${fmt(start)}_${fmt(end)}`;
}

// Approve/Reject book
router.patch('/books/:id/status', auth, authorize('admin'), async (req, res) => {
  try {
    const { status } = req.body;
    
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    
    const book = await Book.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    ).populate('author', 'name email');
    
    if (!book) {
      return res.status(404).json({ message: 'Book not found' });
    }
    
    res.json(book);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get all books (admin view)
router.get('/books', auth, authorize('admin'), async (req, res) => {
  try {
    const { status } = req.query;
    let query = {};
    if (status === 'deleted') {
      query.isDeleted = true;
    } else if (status && status !== 'all') {
      query.status = status;
    }
    
    const books = await Book.find(query)
      .populate('author', 'name email')
      .sort({ createdAt: -1 });
    
    res.json(books);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Delete book (admin only - soft delete for history, keep files so past buyers can download)
router.delete('/books/:id', auth, authorize('admin'), async (req, res) => {
  try {
    const book = await Book.findById(req.params.id);

    if (!book) {
      return res.status(404).json({ message: 'Book not found' });
    }

    // Mark as deleted but keep in DB and keep files
    // so previous buyers still have access in their library
    book.isDeleted = true;
    await book.save();

    res.json({ message: 'Book deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Download monthly earnings PDF for a specific author (admin access)
router.get('/reports/authors/:authorId/:year/:month', auth, authorize('admin'), async (req, res) => {
  try {
    const { authorId, year, month } = req.params;

    const yearNum = parseInt(year, 10);
    const monthNum = parseInt(month, 10);

    if (isNaN(yearNum) || isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
      return res.status(400).json({ message: 'Invalid year or month' });
    }

    const periodStart = new Date(yearNum, monthNum - 1, 1);
    const periodEnd = new Date(yearNum, monthNum, 1);

    const author = await User.findById(authorId).select('name email');
    if (!author) {
      return res.status(404).json({ message: 'Author not found' });
    }

    const orders = await Order.find({
      paymentStatus: 'completed',
      createdAt: { $gte: periodStart, $lt: periodEnd }
    })
      .populate('items.book', 'title author')
      .populate('customer', 'name email');

    const sales = [];
    let totalNet = 0;
    const authorIdStr = authorId.toString();

    for (const order of orders) {
      if (!order.items || order.items.length === 0) continue;

      const orderOriginalTotal = order.items.reduce((sum, item) => sum + (item.price || 0), 0);
      if (orderOriginalTotal <= 0) continue;

      for (const item of order.items) {
        if (!item.book || !item.book.author) continue;
        if (item.book.author.toString() !== authorIdStr) continue;

        const share = (item.price || 0) / orderOriginalTotal;
        const pricePaid = order.totalAmount * share;
        const platformFee = pricePaid * (PLATFORM_FEE_PERCENTAGE / 100);
        const authorNet = pricePaid - platformFee;

        totalNet += authorNet;

        sales.push({
          bookTitle: item.book.title,
          saleDate: order.createdAt,
          pricePaid,
          platformFee,
          authorNet
        });
      }
    }

    const totalFee = sales.reduce((s, x) => s + x.platformFee, 0);
    const totalGross = totalNet + totalFee;

    const monthPadded = String(monthNum).padStart(2, '0');
    const fileName = `blueleafbooks-earnings-${authorId}-${yearNum}-${monthPadded}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const margin = 40;
    const doc = new PDFDocument({ margin });
    doc.pipe(res);

    const pageWidth = doc.page.width;
    const contentWidth = pageWidth - margin * 2;

    doc.font('Helvetica-Bold').fontSize(18)
      .text('BlueLeafBooks – Monthly Earnings Report', margin, doc.y, { align: 'center' });
    doc.moveTo(margin, doc.y + 6).lineTo(pageWidth - margin, doc.y + 6).lineWidth(1).strokeColor('#ddd').stroke();
    doc.moveDown(2);

    doc.font('Helvetica').fontSize(12)
      .text(`Author: ${author.name} (${author.email})`)
      .text(`Period: ${yearNum}-${monthPadded}`)
      .text(`Platform Fee: ${PLATFORM_FEE_PERCENTAGE}%`);
    doc.moveDown(1.5);

    doc.font('Helvetica-Bold').fontSize(12).text('Summary:');
    doc.font('Helvetica').fontSize(11)
      .text(`Gross Sales: $${totalGross.toFixed(2)}`)
      .text(`Platform Fee (${PLATFORM_FEE_PERCENTAGE}%): $${totalFee.toFixed(2)}`)
      .text(`Net to Author: $${totalNet.toFixed(2)}`);
    doc.moveDown(1.5);

    doc.font('Helvetica-Bold').fontSize(12).text('Sales breakdown:');
    doc.moveDown(0.75);

    if (sales.length === 0) {
      doc.font('Helvetica').fontSize(11).text('No sales for this period.');
    } else {
      doc.font('Helvetica').fontSize(10);
      for (const s of sales) {
        const d = new Date(s.saleDate).toLocaleDateString();
        doc.text(`${d} | ${s.bookTitle} | Paid: $${s.pricePaid.toFixed(2)} | Fee: $${s.platformFee.toFixed(2)} | Net: $${s.authorNet.toFixed(2)}`);
      }
    }

    doc.font('Helvetica').fontSize(9).text('Authors are responsible for their own taxes.', margin, doc.page.height - 50);
    doc.end();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Download platform-wide monthly PDF report (all authors, all sales)
router.get('/reports/monthly/:year/:month', auth, authorize('admin'), async (req, res) => {
  try {
    const { year, month } = req.params;
    const yearNum = parseInt(year, 10);
    const monthNum = parseInt(month, 10);

    if (isNaN(yearNum) || isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
      return res.status(400).json({ message: 'Invalid year or month' });
    }

    const periodStart = new Date(yearNum, monthNum - 1, 1);
    const periodEnd = new Date(yearNum, monthNum, 1);

    const orders = await Order.find({
      paymentStatus: 'completed',
      createdAt: { $gte: periodStart, $lt: periodEnd }
    }).select('authorEarningsBreakdown totalAmount platformEarnings createdAt');

    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const authors = await User.find({ role: 'author' })
      .select('name email createdAt')
      .sort({ name: 1 });

    const trialEndsMap = new Map();
    for (const a of authors) {
      const created = a.createdAt ? new Date(a.createdAt) : null;
      const trialEndsAt = created ? new Date(created.getTime() + THIRTY_DAYS_MS) : null;
      trialEndsMap.set(String(a._id), trialEndsAt);
    }

    const perAuthor = new Map();
    let totalPlatformFee = 0;
    let totalGross = 0;

    for (const order of orders) {
      if (!Array.isArray(order.authorEarningsBreakdown)) continue;
      for (const row of order.authorEarningsBreakdown) {
        const aid = String(row.author);
        const trialEndsAt = trialEndsMap.get(aid);
        if (trialEndsAt && order.createdAt && new Date(order.createdAt) < trialEndsAt) continue;

        const net = Number(row.amount || 0);
        if (net <= 0) continue;

        const fee = calcFeeFromNet(net, PLATFORM_FEE_PERCENTAGE);
        const gross = net + fee;

        totalPlatformFee += fee;
        totalGross += gross;

        const acc = perAuthor.get(aid) || { gross: 0, net: 0, fee: 0 };
        acc.gross += gross;
        acc.net += net;
        acc.fee += fee;
        perAuthor.set(aid, acc);
      }
    }

    const monthPadded = String(monthNum).padStart(2, '0');
    const fileName = `blueleafbooks-platform-earnings-${yearNum}-${monthPadded}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const margin = 40;
    const doc = new PDFDocument({ margin });
    doc.pipe(res);

    const pageWidth = doc.page.width;
    const contentWidth = pageWidth - margin * 2;

    doc.font('Helvetica-Bold').fontSize(18)
      .text('BlueLeafBooks – Platform Monthly Report', margin, doc.y, { align: 'center' });
    doc.moveTo(margin, doc.y + 6).lineTo(pageWidth - margin, doc.y + 6).lineWidth(1).strokeColor('#ddd').stroke();
    doc.moveDown(2);

    doc.font('Helvetica').fontSize(12)
      .text(`Period: ${yearNum}-${monthPadded}`)
      .text(`Platform Fee: ${PLATFORM_FEE_PERCENTAGE}%`);
    doc.moveDown(1.5);

    doc.font('Helvetica-Bold').fontSize(12).text('Summary:');
    doc.font('Helvetica').fontSize(11)
      .text(`Total Gross: $${totalGross.toFixed(2)}`)
      .text(`Total Platform Fee: $${totalPlatformFee.toFixed(2)}`);
    doc.moveDown(1.5);

    doc.font('Helvetica-Bold').fontSize(12).text('Per Author:');
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(10);

    for (const a of authors) {
      const stats = perAuthor.get(String(a._id)) || { gross: 0, net: 0, fee: 0 };
      if (stats.gross <= 0) continue;
      doc.text(`${a.name} | Gross: $${stats.gross.toFixed(2)} | Fee: $${stats.fee.toFixed(2)} | Net: $${stats.net.toFixed(2)}`);
    }

    doc.end();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Admin: mark paid/unpaid for a given author+period
router.post('/fees/:authorId/mark-paid', auth, authorize('admin'), async (req, res) => {
  try {
    const { period, note } = req.body || {};
    const p = (period || '').trim() || previousMonthPeriod();
    if (!parsePeriod(p)) return res.status(400).json({ message: 'Invalid period. Use YYYY-MM.' });

    const author = await User.findOne({ _id: req.params.authorId, role: 'author' });
    if (!author) return res.status(404).json({ message: 'Author not found' });

    const status = await PlatformFeeStatus.findOneAndUpdate(
      { author: author._id, period: p },
      { isPaid: true, paidAt: new Date(), note: note || '', updatedAt: new Date() },
      { upsert: true, new: true }
    );

    // Manual control requested: marking as paid does NOT automatically unblock.
    // Admin can still unblock explicitly via PATCH /admin/authors/:authorId/unblock.
    const currentAuthor = await User.findById(author._id)
      .select('name email payoutPaypalEmail isBlocked blockedReason blockedAt createdAt');

    res.json({ success: true, status, author: currentAuthor });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/fees/:authorId/mark-unpaid', auth, authorize('admin'), async (req, res) => {
  try {
    const { period, note } = req.body || {};
    const p = (period || '').trim() || previousMonthPeriod();
    if (!parsePeriod(p)) return res.status(400).json({ message: 'Invalid period. Use YYYY-MM.' });

    const author = await User.findOne({ _id: req.params.authorId, role: 'author' });
    if (!author) return res.status(404).json({ message: 'Author not found' });

    const status = await PlatformFeeStatus.findOneAndUpdate(
      { author: author._id, period: p },
      { isPaid: false, paidAt: null, note: note || '', updatedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});



// ===== Cycle-based platform fee tracking (join-date billing cycles) =====
// Returns each author's last completed billing cycle fee, due date (10th of following month),
// and trial status (first 30 days).
router.get('/cycle-fees', auth, authorize('admin'), async (req, res) => {
  try {
    const now = new Date();

    const authors = await User.find({ role: 'author' })
      .select('name email createdAt isBlocked blockedReason blockedAt payoutPaypalEmail')
      .sort({ createdAt: -1 });

    const rows = [];

    for (const author of authors) {
      const billing = getBillingWindow(author.createdAt, now);

      // last completed cycle: [prevStart, prevEnd) where prevEnd is current periodStart
      const prevEnd = billing.periodStart;
      const prevMonth = new Date(prevEnd.getFullYear(), prevEnd.getMonth() - 1, 1);
      const prevStart = makeDateWithClampedDay(prevMonth.getFullYear(), prevMonth.getMonth(), billing.billingDay, 0, 0, 0, 0);

      const cycleKey = makeCycleKey(prevStart, prevEnd);

      const effectiveStart = billing.trialEndsAt && billing.trialEndsAt > prevStart ? billing.trialEndsAt : prevStart;

      // Fee calculation (only if any billable time exists)
      let feeDue = 0;
      let grossSales = 0;
      let salesCount = 0;

      if (effectiveStart < prevEnd) {
        const orders = await Order.find({
          paymentStatus: 'completed',
          createdAt: { $gte: effectiveStart, $lt: prevEnd },
          'authorEarningsBreakdown.author': author._id
        }).select('authorEarningsBreakdown createdAt');

        for (const order of orders) {
          if (!Array.isArray(order.authorEarningsBreakdown)) continue;
          const row = order.authorEarningsBreakdown.find(r => String(r.author) === String(author._id));
          if (!row) continue;
          const net = Number(row.amount || 0);
          if (net <= 0) continue;
          const fee = calcFeeFromNet(net, PLATFORM_FEE_PERCENTAGE);
          feeDue += fee;
          grossSales += net + fee;
          salesCount += 1;
        }
      }

      const dueDate = new Date(prevEnd.getFullYear(), prevEnd.getMonth() + 1, 10);

      const statusDoc = await PlatformFeeStatus.findOne({ author: author._id, period: cycleKey })
        .select('isPaid paidAt note');

      const isPaid = statusDoc ? !!statusDoc.isPaid : false;

      const overdue = !billing.isInTrial && !isPaid && (now > dueDate);

      const trialDaysRemaining = billing.isInTrial
        ? Math.ceil((billing.trialEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
        : 0;

      rows.push({
        author: {
          _id: author._id,
          name: author.name,
          email: author.email,
          createdAt: author.createdAt,
          isBlocked: !!author.isBlocked,
          blockedReason: author.blockedReason || '',
          blockedAt: author.blockedAt || null
        },
        billingDay: billing.billingDay,
        isInTrial: billing.isInTrial,
        trialEndsAt: billing.trialEndsAt,
        trialDaysRemaining,
        cycle: {
          start: prevStart,
          end: prevEnd,
          key: cycleKey,
          grossSales: Number(grossSales.toFixed(2)),
          feeDue: Number(feeDue.toFixed(2)),
          salesCount
        },
        dueDate,
        status: {
          isPaid,
          paidAt: statusDoc ? statusDoc.paidAt : null,
          note: statusDoc ? (statusDoc.note || '') : ''
        },
        overdue
      });
    }

    res.json({
      success: true,
      feePercentage: PLATFORM_FEE_PERCENTAGE,
      rows
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Mark cycle fee as paid (defaults to last completed cycle if periodKey not provided)
router.post('/cycle-fees/:authorId/mark-paid', auth, authorize('admin'), async (req, res) => {
  try {
    const { periodKey, note } = req.body || {};
    const author = await User.findOne({ _id: req.params.authorId, role: 'author' });
    if (!author) return res.status(404).json({ message: 'Author not found' });

    let key = (periodKey || '').trim();
    if (!key) {
      const billing = getBillingWindow(author.createdAt, new Date());
      const prevEnd = billing.periodStart;
      const prevMonth = new Date(prevEnd.getFullYear(), prevEnd.getMonth() - 1, 1);
      const prevStart = makeDateWithClampedDay(prevMonth.getFullYear(), prevMonth.getMonth(), billing.billingDay, 0, 0, 0, 0);
      key = makeCycleKey(prevStart, prevEnd);
    }

    const status = await PlatformFeeStatus.findOneAndUpdate(
      { author: author._id, period: key },
      { isPaid: true, paidAt: new Date(), note: note || '', updatedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/cycle-fees/:authorId/mark-unpaid', auth, authorize('admin'), async (req, res) => {
  try {
    const { periodKey, note } = req.body || {};
    const author = await User.findOne({ _id: req.params.authorId, role: 'author' });
    if (!author) return res.status(404).json({ message: 'Author not found' });

    let key = (periodKey || '').trim();
    if (!key) {
      const billing = getBillingWindow(author.createdAt, new Date());
      const prevEnd = billing.periodStart;
      const prevMonth = new Date(prevEnd.getFullYear(), prevEnd.getMonth() - 1, 1);
      const prevStart = makeDateWithClampedDay(prevMonth.getFullYear(), prevMonth.getMonth(), billing.billingDay, 0, 0, 0, 0);
      key = makeCycleKey(prevStart, prevEnd);
    }

    const status = await PlatformFeeStatus.findOneAndUpdate(
      { author: author._id, period: key },
      { isPaid: false, paidAt: null, note: note || '', updatedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get all authors (admin)
router.get('/authors', auth, authorize('admin'), async (req, res) => {
  try {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const now = new Date();

    const authors = await User.find({ role: 'author' })
      .select('name email payoutPaypalEmail createdAt isBlocked blockedReason blockedAt')
      .sort({ createdAt: -1 });

    const result = authors.map(a => {
      const createdAt = a.createdAt ? new Date(a.createdAt) : null;
      const trialEndsAt = createdAt ? new Date(createdAt.getTime() + THIRTY_DAYS_MS) : null;
      const isInFirst30Days = trialEndsAt ? now < trialEndsAt : false;
      const daysUntilFee = isInFirst30Days && trialEndsAt
        ? Math.ceil((trialEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
        : 0;

      return {
        _id: a._id,
        name: a.name,
        email: a.email,
        payoutPaypalEmail: a.payoutPaypalEmail || '',
        createdAt: a.createdAt,
        isBlocked: !!a.isBlocked,
        blockedReason: a.blockedReason || '',
        blockedAt: a.blockedAt || null,
        isInFirst30Days,
        trialEndsAt,
        daysUntilFee
      };
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get fee status by calendar period (YYYY-MM) - for Platform Fees section
router.get('/fees', auth, authorize('admin'), async (req, res) => {
  try {
    const period = (req.query.period || '').trim() || previousMonthPeriod();
    const range = periodRange(period);
    if (!range) {
      return res.status(400).json({ message: 'Invalid period. Use YYYY-MM.' });
    }

    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const authors = await User.find({ role: 'author' })
      .select('name email payoutPaypalEmail createdAt isBlocked blockedReason blockedAt')
      .sort({ createdAt: -1 });

    const statuses = await PlatformFeeStatus.find({ period }).select('author isPaid paidAt note');
    const statusMap = new Map(statuses.map(s => [String(s.author), s]));

    const dueDate = new Date(range.year, range.month, 10);

    const rows = [];
    for (const author of authors) {
      const createdAt = author.createdAt ? new Date(author.createdAt) : null;
      const trialEndsAt = createdAt ? new Date(createdAt.getTime() + THIRTY_DAYS_MS) : null;
      const effectiveStart = trialEndsAt && trialEndsAt > range.start ? trialEndsAt : range.start;

      let grossSales = 0;
      let feeDue = 0;

      if (effectiveStart < range.end) {
        const orders = await Order.find({
          paymentStatus: 'completed',
          createdAt: { $gte: effectiveStart, $lt: range.end },
          'authorEarningsBreakdown.author': author._id
        }).select('authorEarningsBreakdown createdAt');

        for (const order of orders) {
          if (!Array.isArray(order.authorEarningsBreakdown)) continue;
          const row = order.authorEarningsBreakdown.find(r => String(r.author) === String(author._id));
          if (!row) continue;
          const net = Number(row.amount || 0);
          if (net <= 0) continue;
          const fee = calcFeeFromNet(net, PLATFORM_FEE_PERCENTAGE);
          feeDue += fee;
          grossSales += net + fee;
        }
      }

      const statusDoc = statusMap.get(String(author._id));
      const isPaid = statusDoc ? !!statusDoc.isPaid : false;
      const now = new Date();
      const isOverdue = !isPaid && now >= dueDate;

      rows.push({
        authorId: author._id,
        name: author.name,
        email: author.email,
        payoutPaypalEmail: author.payoutPaypalEmail || '',
        grossSales: Number(grossSales.toFixed(2)),
        platformFeeDue: Number(feeDue.toFixed(2)),
        isPaid,
        isOverdue,
        isBlocked: !!author.isBlocked
      });
    }

    res.json({
      period,
      dueDate,
      feePercentage: PLATFORM_FEE_PERCENTAGE,
      rows
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Block / Unblock author (manual control for unpaid platform fee)
router.patch('/authors/:authorId/block', auth, authorize('admin'), async (req, res) => {
  try {
    const { reason } = req.body || {};
    const author = await User.findOneAndUpdate(
      { _id: req.params.authorId, role: 'author' },
      { isBlocked: true, blockedReason: reason || 'Unpaid platform fee', blockedAt: new Date() },
      { new: true }
    ).select('name email payoutPaypalEmail isBlocked blockedReason blockedAt createdAt');

    if (!author) {
      return res.status(404).json({ message: 'Author not found' });
    }

    res.json(author);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.patch('/authors/:authorId/unblock', auth, authorize('admin'), async (req, res) => {
  try {
    const author = await User.findOneAndUpdate(
      { _id: req.params.authorId, role: 'author' },
      { isBlocked: false, blockedReason: null, blockedAt: null },
      { new: true }
    ).select('name email payoutPaypalEmail isBlocked blockedReason blockedAt createdAt');

    if (!author) {
      return res.status(404).json({ message: 'Author not found' });
    }

    res.json(author);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get all orders
router.get('/orders', auth, authorize('admin'), async (req, res) => {
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

// Get platform earnings
router.get('/earnings', auth, authorize('admin'), async (req, res) => {
  try {
    const orders = await Order.find({ paymentStatus: 'completed' });
    
    let totalEarnings = 0;
    for (const order of orders) {
      totalEarnings += order.platformEarnings;
    }
    
    res.json({
      totalEarnings: totalEarnings.toFixed(2),
      totalOrders: orders.length
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get unpaid earnings per author
router.get('/payouts', auth, authorize('admin'), async (req, res) => {
  try {
    const orders = await Order.find({ paymentStatus: 'completed' });
    
    const authorEarningsMap = {};
    
    for (const order of orders) {
      for (const breakdown of order.authorEarningsBreakdown) {
        if (!breakdown.paidOut) {
          const authorId = breakdown.author.toString();
          if (!authorEarningsMap[authorId]) {
            authorEarningsMap[authorId] = {
              authorId: breakdown.author,
              totalUnpaid: 0
            };
          }
          authorEarningsMap[authorId].totalUnpaid += breakdown.amount;
        }
      }
    }
    
    // Populate author names
    const payouts = [];
    for (const [authorId, data] of Object.entries(authorEarningsMap)) {
      const author = await User.findById(authorId).select('name email payoutPaypalEmail');
      payouts.push({
        author: {
          id: author._id,
          name: author.name,
          email: author.email,
          payoutPaypalEmail: author.payoutPaypalEmail || ''
        },
        unpaidEarnings: data.totalUnpaid.toFixed(2)
      });
    }
    
    res.json(payouts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Mark earnings as paid out
router.post('/payouts/mark-paid', auth, authorize('admin'), async (req, res) => {
  try {
    const { authorId, amount, period } = req.body;
    
    // Find all unpaid earnings for this author
    const orders = await Order.find({
      paymentStatus: 'completed',
      'authorEarningsBreakdown.author': authorId,
      'authorEarningsBreakdown.paidOut': false
    });
    
    let markedCount = 0;
    let totalMarked = 0;
    
    for (const order of orders) {
      for (const breakdown of order.authorEarningsBreakdown) {
        if (breakdown.author.toString() === authorId && !breakdown.paidOut) {
          if (totalMarked + breakdown.amount <= amount) {
            breakdown.paidOut = true;
            breakdown.paidOutDate = new Date();
            totalMarked += breakdown.amount;
            markedCount++;
          }
        }
      }
      await order.save();
    }
    
    res.json({
      message: 'Earnings marked as paid',
      markedCount,
      totalMarked: totalMarked.toFixed(2)
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Coupon Management Routes

// Get all coupons
router.get('/coupons', auth, authorize('admin'), async (req, res) => {
  try {
    const coupons = await Coupon.find()
      .populate('author', 'name email')
      .sort({ createdAt: -1 });
    
    res.json(coupons);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create coupon
router.post('/coupons', auth, authorize('admin'), async (req, res) => {
  try {
    const { code, discountPercentage, scope, author, validFrom, validTo } = req.body;
    
    // Validate required fields
    if (!code || !discountPercentage) {
      return res.status(400).json({ message: 'Code and discount percentage are required' });
    }
    
    if (discountPercentage < 1 || discountPercentage > 100) {
      return res.status(400).json({ message: 'Discount percentage must be between 1 and 100' });
    }
    
    if (scope === 'author' && !author) {
      return res.status(400).json({ message: 'Author is required when scope is "author"' });
    }
    
    // Check if code already exists
    const existingCoupon = await Coupon.findOne({ code: code.toUpperCase().trim() });
    if (existingCoupon) {
      return res.status(400).json({ message: 'Coupon code already exists' });
    }
    
    // Validate author exists if scope is author
    if (scope === 'author') {
      const authorUser = await User.findById(author);
      if (!authorUser || authorUser.role !== 'author') {
        return res.status(400).json({ message: 'Invalid author' });
      }
    }
    
    const coupon = new Coupon({
      code: code.toUpperCase().trim(),
      discountPercentage: parseFloat(discountPercentage),
      scope: scope || 'all',
      author: scope === 'author' ? author : undefined,
      validFrom: validFrom ? new Date(validFrom) : undefined,
      validTo: validTo ? new Date(validTo) : undefined
    });
    
    await coupon.save();
    await coupon.populate('author', 'name email');
    
    res.status(201).json(coupon);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Toggle coupon active status
router.patch('/coupons/:id/toggle', auth, authorize('admin'), async (req, res) => {
  try {
    const coupon = await Coupon.findById(req.params.id);
    
    if (!coupon) {
      return res.status(404).json({ message: 'Coupon not found' });
    }
    
    coupon.isActive = !coupon.isActive;
    await coupon.save();
    await coupon.populate('author', 'name email');
    
    res.json(coupon);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Delete coupon
router.delete('/coupons/:id', auth, authorize('admin'), async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndDelete(req.params.id);
    
    if (!coupon) {
      return res.status(404).json({ message: 'Coupon not found' });
    }
    
    res.json({ message: 'Coupon deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});



// Update featured flag/order for curated sections
router.patch('/books/:id/featured', auth, authorize('admin'), async (req, res) => {
  try {
    const { isFeatured, featuredOrder } = req.body;

    const update = {};
    if (typeof isFeatured === 'boolean') update.isFeatured = isFeatured;
    if (featuredOrder !== undefined) update.featuredOrder = Math.max(0, parseInt(featuredOrder, 10) || 0);

    const book = await Book.findByIdAndUpdate(req.params.id, update, { new: true })
      .populate('author', 'name email');

    if (!book) return res.status(404).json({ message: 'Book not found' });

    res.json({ message: 'Featured updated', book });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;