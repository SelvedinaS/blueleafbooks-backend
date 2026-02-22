const express = require('express');
const PDFDocument = require('pdfkit');
const Book = require('../models/Book');
const Order = require('../models/Order');
const User = require('../models/User');
const PlatformFeeStatus = require('../models/PlatformFeeStatus');
const { auth, authorize } = require('../middleware/auth');

const router = express.Router();

const PLATFORM_FEE_PERCENTAGE = parseFloat(process.env.PLATFORM_FEE_PERCENTAGE || 10);

function calcFeeFromNet(net, feePct) {
  const rate = feePct / 100;
  if (rate <= 0 || rate >= 1) return 0;
  return net * (rate / (1 - rate));
}

function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function isoMonth(d) {
  const dd = new Date(d);
  const y = dd.getFullYear();
  const m = String(dd.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function monthRangeFromPeriod(periodStr) {
  if (!periodStr || !/^\d{4}-\d{2}$/.test(periodStr)) return null;
  const [y, m] = periodStr.split('-').map(n => parseInt(n, 10));
  if (!y || !m || m < 1 || m > 12) return null;
  const start = new Date(y, m - 1, 1, 0, 0, 0, 0);
  const end = new Date(y, m, 1, 0, 0, 0, 0);
  return { start, end, year: y, month: m };
}

function previousMonthPeriod(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1; // 1-12
  const prevM = m === 1 ? 12 : m - 1;
  const prevY = m === 1 ? y - 1 : y;
  return `${prevY}-${String(prevM).padStart(2, '0')}`;
}

function currentMonthPeriod(now = new Date()) {
  return isoMonth(now);
}

function trialInfo(createdAt, now = new Date()) {
  const created = new Date(createdAt);
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const trialEndsAt = new Date(created.getTime() + THIRTY_DAYS_MS);
  const isInTrial = now < trialEndsAt;

  const trialDaysRemaining = isInTrial
    ? Math.ceil((trialEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
    : 0;

  return { trialEndsAt, isInTrial, trialDaysRemaining };
}

function effectivePeriodStart(monthStart, trialEndsAt) {
  if (!trialEndsAt) return monthStart;
  return trialEndsAt > monthStart ? trialEndsAt : monthStart;
}

// Get author dashboard stats
router.get('/dashboard', auth, authorize('author'), async (req, res) => {
  try {
    const authorId = req.user._id;

    // Fetch author user record (needed for PayPal gate + billing window)
    const user = await User.findById(authorId).select('payoutPaypalEmail createdAt');
// Get author's books (include deleted for history)
    const books = await Book.find({ author: authorId })
      .sort({ createdAt: -1 });
    
    const now = new Date();
    const adminPaymentEmail = (process.env.ADMIN_EMAIL || 'blueleafbooks@hotmail.com');

    // Trial (first 30 days from registration)
    const trial = user?.createdAt ? trialInfo(user.createdAt, now) : { trialEndsAt: null, isInTrial: false, trialDaysRemaining: 0 };

    const isInFirst30Days = !!trial.isInTrial;
    const daysUntilFee = trial.trialDaysRemaining || 0;

    // Calendar-month billing (after trial):
    // - Trial ends on trialEndsAt (e.g. 5 Mar)
    // - First payable period is from trialEndsAt to end of that calendar month (e.g. 5 Mar -> 1 Apr)
    // - Then full calendar months (1 -> 1)
    const currentPeriod = currentMonthPeriod(now);
    const prevPeriod = previousMonthPeriod(now);

    const currentRange = monthRangeFromPeriod(currentPeriod);
    const prevRange = monthRangeFromPeriod(prevPeriod);

    const effectiveCurrentStart = (!isInFirst30Days && currentRange && trial.trialEndsAt)
      ? effectivePeriodStart(currentRange.start, trial.trialEndsAt)
      : null;

    const effectivePrevStart = (!prevRange || !trial.trialEndsAt)
      ? null
      : effectivePeriodStart(prevRange.start, trial.trialEndsAt);

    // Orders (all-time) for totals
    const ordersAll = await Order.find({
      'items.book': { $in: books.map(b => b._id) },
      paymentStatus: 'completed'
    });

    // Orders for current month (accrued, not yet due)
    const ordersCurrent = (!isInFirst30Days && currentRange && effectiveCurrentStart && effectiveCurrentStart < currentRange.end)
      ? await Order.find({
          paymentStatus: 'completed',
          createdAt: { $gte: effectiveCurrentStart, $lt: currentRange.end },
          'authorEarningsBreakdown.author': authorId
        }).select('authorEarningsBreakdown createdAt')
      : [];

    // Orders for previous month (due by 10th of current month)
    const ordersPrev = (prevRange && effectivePrevStart && effectivePrevStart < prevRange.end)
      ? await Order.find({
          paymentStatus: 'completed',
          createdAt: { $gte: effectivePrevStart, $lt: prevRange.end },
          'authorEarningsBreakdown.author': authorId
        }).select('authorEarningsBreakdown createdAt')
      : [];

    let totalSales = 0;
    let totalEarnings = 0;
    let unpaidEarnings = 0;
    let platformFeeDueTotal = 0;
    let grossSalesTotal = 0;
    // ===== Calendar-month platform fee (after trial) =====
    let currentMonthFeeAccrued = 0;
    let currentMonthGrossSales = 0;

    for (const order of ordersCurrent) {
      if (!Array.isArray(order.authorEarningsBreakdown)) continue;
      const row = order.authorEarningsBreakdown.find(e => String(e.author) === String(authorId));
      if (!row) continue;
      const net = Number(row.amount || 0);
      const fee = calcFeeFromNet(net, PLATFORM_FEE_PERCENTAGE);
      currentMonthFeeAccrued += fee;
      currentMonthGrossSales += net + fee;
    }

    let lastMonthFeeDue = 0;
    let lastMonthGrossSales = 0;

    for (const order of ordersPrev) {
      if (!Array.isArray(order.authorEarningsBreakdown)) continue;
      const row = order.authorEarningsBreakdown.find(e => String(e.author) === String(authorId));
      if (!row) continue;
      const net = Number(row.amount || 0);
      const fee = calcFeeFromNet(net, PLATFORM_FEE_PERCENTAGE);
      lastMonthFeeDue += fee;
      lastMonthGrossSales += net + fee;
    }

    // Status for last month (manual payment tracking)
    let lastMonthStatus = { isPaid: false, paidAt: null, note: '' };
    if (prevPeriod) {
      const st = await PlatformFeeStatus.findOne({ author: authorId, period: prevPeriod }).select('isPaid paidAt note');
      if (st) lastMonthStatus = { isPaid: !!st.isPaid, paidAt: st.paidAt || null, note: st.note || '' };
    }

    // Due dates:
    // - last month is due on the 10th of the CURRENT month
    // - current month will be due on the 10th of NEXT month
    const lastMonthDueDate = prevRange ? new Date(prevRange.end.getFullYear(), prevRange.end.getMonth(), 10) : null;
    const currentMonthDueDate = currentRange ? new Date(currentRange.end.getFullYear(), currentRange.end.getMonth(), 10) : null;

    const lastMonthOverdue = !!(lastMonthDueDate && !lastMonthStatus.isPaid && now > lastMonthDueDate && lastMonthFeeDue > 0);

    // During trial: nothing due yet.
    const platformFeeToShow = isInFirst30Days ? 0 : lastMonthFeeDue;
    const grossSalesToShow = isInFirst30Days ? 0 : lastMonthGrossSales;

    // PayPal gate: books visible only when author has PayPal set
    const hasPaypal = !!(user.payoutPaypalEmail && user.payoutPaypalEmail.trim() !== '');
    if (hasPaypal) {
      await Book.updateMany(
        { author: req.user._id, isDeleted: false, status: 'pending' },
        { $set: { status: 'approved' } }
      );
    } else {
      await Book.updateMany(
        { author: req.user._id, isDeleted: false, status: 'approved' },
        { $set: { status: 'pending' } }
      );
    }

    res.json({
      books: books.length,
      totalSales,
      totalEarnings: totalEarnings.toFixed(2),
      unpaidEarnings: unpaidEarnings.toFixed(2),

      // Last month (previous calendar month) — DUE by the 10th of this month
      platformFee: Number(platformFeeToShow.toFixed(2)),
      grossSales: Number(grossSalesToShow.toFixed(2)),
      lastMonth: {
        period: prevPeriod,
        start: prevRange ? prevRange.start : null,
        end: prevRange ? prevRange.end : null,
        effectiveStart: (prevRange && effectivePrevStart) ? effectivePrevStart : null,
        grossSales: Number(lastMonthGrossSales.toFixed(2)),
        feeDue: Number(lastMonthFeeDue.toFixed(2)),
        dueDate: lastMonthDueDate,
        status: lastMonthStatus,
        overdue: lastMonthOverdue
      },

      // Current month (accrued, not due yet) — will be due by the 10th of next month
      currentMonth: {
        period: currentPeriod,
        start: currentRange ? currentRange.start : null,
        end: currentRange ? currentRange.end : null,
        effectiveStart: (currentRange && effectiveCurrentStart) ? effectiveCurrentStart : null,
        grossSalesAccrued: Number(currentMonthGrossSales.toFixed(2)),
        feeAccrued: Number(currentMonthFeeAccrued.toFixed(2)),
        dueDate: currentMonthDueDate
      },

      isInFirst30Days,
      daysUntilFee,
      trialEndsAt: trial.trialEndsAt || null,
      adminPaymentEmail,
      booksList: books
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get author's books
router.get('/my-books', auth, authorize('author'), async (req, res) => {
  try {
    // Include deleted books so author can still see history
    const books = await Book.find({ author: req.user._id })
      .sort({ createdAt: -1 });
    
    res.json(books);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get payout settings
router.get('/payout-settings', auth, authorize('author'), async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('payoutPaypalEmail');

    // PayPal gate: sync book status when fetching settings
    const hasPaypal = !!(user.payoutPaypalEmail && user.payoutPaypalEmail.trim() !== '');
    if (hasPaypal) {
      await Book.updateMany(
        { author: req.user._id, isDeleted: false, status: 'pending' },
        { $set: { status: 'approved' } }
      );
    } else {
      await Book.updateMany(
        { author: req.user._id, isDeleted: false, status: 'approved' },
        { $set: { status: 'pending' } }
      );
    }

    res.json({
      payoutPaypalEmail: user.payoutPaypalEmail || ''
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update payout settings
router.post('/payout-settings', auth, authorize('author'), async (req, res) => {
  try {
    const { payoutPaypalEmail } = req.body;
    
    // Validate email format
    if (payoutPaypalEmail && payoutPaypalEmail.trim() !== '') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(payoutPaypalEmail.trim())) {
        return res.status(400).json({ message: 'Invalid email format' });
      }
    }
    
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { payoutPaypalEmail: payoutPaypalEmail ? payoutPaypalEmail.trim().toLowerCase() : null },
      { new: true }
    ).select('name email payoutPaypalEmail');

    // PayPal gate: sync book visibility when PayPal changes
    const hasPaypal = !!(user.payoutPaypalEmail && user.payoutPaypalEmail.trim() !== '');
    if (hasPaypal) {
      await Book.updateMany(
        { author: req.user._id, isDeleted: false, status: 'pending' },
        { $set: { status: 'approved' } }
      );
    } else {
      await Book.updateMany(
        { author: req.user._id, isDeleted: false, status: 'approved' },
        { $set: { status: 'pending' } }
      );
    }

    res.json({
      message: 'Payout settings updated successfully',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        payoutPaypalEmail: user.payoutPaypalEmail || ''
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Download monthly earnings PDF for the logged-in author
router.get('/reports/monthly/:year/:month', auth, authorize('author'), async (req, res) => {
  try {
    const authorId = req.user._id.toString();
    const { year, month } = req.params;

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

    // Fetch completed orders in the given month that include this author's books
    const orders = await Order.find({
      paymentStatus: 'completed',
      createdAt: { $gte: periodStart, $lt: periodEnd }
    })
      .populate('items.book', 'title author')
      .populate('customer', 'name email');

    const sales = [];
    let totalNet = 0;

    for (const order of orders) {
      if (!order.items || order.items.length === 0) continue;

      const orderOriginalTotal = order.items.reduce((sum, item) => sum + (item.price || 0), 0);
      if (orderOriginalTotal <= 0) continue;

      for (const item of order.items) {
        if (!item.book || !item.book.author) continue;
        if (item.book.author.toString() !== authorId) continue;

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

    // Prepare PDF response
    const monthPadded = String(monthNum).padStart(2, '0');
    const fileName = `blueleafbooks-earnings-${yearNum}-${monthPadded}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const margin = 40;
    const doc = new PDFDocument({ margin });
    doc.pipe(res);

    const pageWidth = doc.page.width;
    const contentWidth = pageWidth - margin * 2;

    // Header
    doc
      .font('Helvetica-Bold')
      .fontSize(18)
      .text('BlueLeafBooks – Monthly Earnings Report', margin, doc.y, { align: 'center' });

    // Light horizontal rule under header
    doc
      .moveTo(margin, doc.y + 6)
      .lineTo(pageWidth - margin, doc.y + 6)
      .lineWidth(1)
      .strokeColor('#dddddd')
      .stroke();

    doc.moveDown(2);

    doc
      .font('Helvetica')
      .fontSize(12)
      .fillColor('#000000')
      .text(`Author: ${author.name} (${author.email})`, { align: 'left' });

    const periodLabel = new Date(yearNum, monthNum - 1, 1).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long'
    });

    doc.text(`Period: ${periodLabel}`);
    doc.text(`Platform Fee: ${PLATFORM_FEE_PERCENTAGE.toFixed(2)}%`);
    doc.moveDown(1.5);

    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .text('Sales breakdown:');
    doc.moveDown(0.75);

    if (sales.length === 0) {
      doc.font('Helvetica').fontSize(11).text('No sales for this period.');
    } else {
      // Table layout with dynamic widths to avoid wrapping
      const rowHeight = 18;
      const startY = doc.y;

      const baseDateWidth = 110;
      const baseNumericWidth = 70; // for each of Price, Fee, Net
      const baseUsedWidth = baseDateWidth + baseNumericWidth * 3;
      let bookColWidth = contentWidth - baseUsedWidth;

      let dateColWidth = baseDateWidth;
      let numericWidth = baseNumericWidth;

      if (bookColWidth < 120) {
        const deficit = 120 - bookColWidth;
        const reducePerCol = Math.min(15, Math.ceil(deficit / 4)); // date + 3 numeric
        dateColWidth = Math.max(80, baseDateWidth - reducePerCol);
        numericWidth = Math.max(60, baseNumericWidth - reducePerCol);
        bookColWidth = contentWidth - (dateColWidth + numericWidth * 3);
      }

      // Nudge the right side (Price / Fee / Net) slightly left so headers never wrap
      bookColWidth = Math.max(80, bookColWidth - 10);

      const dateColX = margin;
      const bookColX = dateColX + dateColWidth;
      const priceColX = bookColX + bookColWidth;
      const feeColX = priceColX + numericWidth;
      const netColX = feeColX + numericWidth;
      const rightEdge = margin + contentWidth;

      // Header row background
      doc
        .save()
        .rect(margin, startY - 2, contentWidth, rowHeight)
        .fill('#f5f5f5')
        .restore();

      doc.font('Helvetica-Bold').fontSize(11);

      doc.text('Date', dateColX + 4, startY, { width: dateColWidth - 8, align: 'left' });
      doc.text('Book', bookColX + 4, startY, { width: bookColWidth - 8, align: 'left' });
      doc.text('Price', priceColX, startY, {
        width: numericWidth - 8,
        align: 'right'
      });
      doc.text('Fee', feeColX, startY, {
        width: numericWidth - 8,
        align: 'right'
      });
      doc.text('Net', netColX, startY, {
        width: numericWidth - 8,
        align: 'right'
      });

      let currentY = startY + rowHeight;
      doc.moveTo(margin, currentY - 2)
        .lineTo(rightEdge, currentY - 2)
        .lineWidth(0.5)
        .strokeColor('#e0e0e0')
        .stroke();

      doc.font('Helvetica').fontSize(9);

      const addRow = (sale) => {
        // Add new page if needed
        if (currentY > doc.page.height - margin - 80) {
          doc.addPage();
          currentY = margin;

          // Repeat header row on new page
          doc
            .save()
            .rect(margin, currentY - 2, contentWidth, rowHeight)
            .fill('#f5f5f5')
            .restore();

          doc.font('Helvetica-Bold').fontSize(11);

          doc.text('Date', dateColX + 4, currentY, {
            width: dateColWidth - 8,
            align: 'left'
          });
          doc.text('Book', bookColX + 4, currentY, {
            width: bookColWidth - 8,
            align: 'left'
          });
          doc.text('Price', priceColX, currentY, {
            width: numericWidth - 8,
            align: 'right'
          });
          doc.text('Fee', feeColX, currentY, {
            width: numericWidth - 8,
            align: 'right'
          });
          doc.text('Net', netColX, currentY, {
            width: numericWidth - 8,
            align: 'right'
          });

          currentY += rowHeight;
          doc.moveTo(margin, currentY - 2)
            .lineTo(rightEdge, currentY - 2)
            .lineWidth(0.5)
            .strokeColor('#e0e0e0')
            .stroke();

          doc.font('Helvetica').fontSize(9);
        }

        const dateStr = new Date(sale.saleDate).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });

        doc.text(dateStr, dateColX + 4, currentY, {
          width: dateColWidth - 8,
          align: 'left'
        });
        doc.text(sale.bookTitle, bookColX + 4, currentY, {
          width: bookColWidth - 8,
          align: 'left'
        });
        doc.text(`$${sale.pricePaid.toFixed(2)}`, priceColX, currentY, {
          width: numericWidth - 8,
          align: 'right'
        });
        doc.text(`$${sale.platformFee.toFixed(2)}`, feeColX, currentY, {
          width: numericWidth - 8,
          align: 'right'
        });
        doc.text(`$${sale.authorNet.toFixed(2)}`, netColX, currentY, {
          width: numericWidth - 8,
          align: 'right'
        });

        currentY += rowHeight;
      };

      sales.forEach(addRow);

      doc.y = currentY + 10;
    }

    // Summary line with separator
    doc
      .moveDown(1)
      .moveTo(margin, doc.y)
      .lineTo(pageWidth - margin, doc.y)
      .lineWidth(1)
      .strokeColor('#dddddd')
      .stroke();

    doc.moveDown(0.75);
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .text(`Total Net Earnings: $${totalNet.toFixed(2)}`, margin, doc.y, { align: 'left' });

    // Footer and disclaimer at bottom
    const footerY = doc.page.height - margin - 40;

    doc
      .moveTo(margin, footerY)
      .lineTo(pageWidth - margin, footerY)
      .lineWidth(0.5)
      .strokeColor('#e0e0e0')
      .stroke();

    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#999999')
      .text('BlueLeafBooks', margin, footerY + 6, {
        width: contentWidth,
        align: 'center'
      });

    doc
      .fontSize(8)
      .fillColor('#777777')
      .text(
        'BlueLeafBooks is not responsible for your taxes.\n' +
        'Authors are fully responsible for reporting and paying their own taxes.',
        margin,
        footerY + 4,
        {
          width: contentWidth,
          align: 'right'
        }
      );

    doc.end();
  } catch (error) {
    console.error('Error generating monthly report PDF:', error);
    // If headers not sent, we can still send JSON error; otherwise just end the stream
    if (!res.headersSent) {
      res.status(500).json({ message: error.message });
    } else {
      res.end();
    }
  }
});

module.exports = router;