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
    if (status && status !== 'all') {
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

    const monthPadded = String(monthNum).padStart(2, '0');
    const fileName = `blueleafbooks-earnings-${author.name.replace(/[^a-z0-9]/gi, '_')}-${yearNum}-${monthPadded}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const margin = 40;
    const doc = new PDFDocument({ margin });
    doc.pipe(res);

    const pageWidth = doc.page.width;
    const contentWidth = pageWidth - margin * 2;

    doc
      .font('Helvetica-Bold')
      .fontSize(18)
      .text('BlueLeafBooks – Monthly Earnings Report', margin, doc.y, { align: 'center' });

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
      const rowHeight = 18;
      const startY = doc.y;

      const baseDateWidth = 110;
      const baseNumericWidth = 70;
      const baseUsedWidth = baseDateWidth + baseNumericWidth * 3;
      let bookColWidth = contentWidth - baseUsedWidth;

      let dateColWidth = baseDateWidth;
      let numericWidth = baseNumericWidth;

      if (bookColWidth < 120) {
        const deficit = 120 - bookColWidth;
        const reducePerCol = Math.min(15, Math.ceil(deficit / 4));
        dateColWidth = Math.max(80, baseDateWidth - reducePerCol);
        numericWidth = Math.max(60, baseNumericWidth - reducePerCol);
        bookColWidth = contentWidth - (dateColWidth + numericWidth * 3);
      }

      const dateColX = margin;
      const bookColX = dateColX + dateColWidth;
      const priceColX = bookColX + bookColWidth;
      const feeColX = priceColX + numericWidth;
      const netColX = feeColX + numericWidth;
      const rightEdge = margin + contentWidth;

      doc
        .save()
        .rect(margin, startY - 2, contentWidth, rowHeight)
        .fill('#f5f5f5')
        .restore();

      doc.font('Helvetica-Bold').fontSize(11);

      doc.text('Date', dateColX + 4, startY, { width: dateColWidth - 8, align: 'left' });
      doc.text('Book', bookColX + 4, startY, { width: bookColWidth - 8, align: 'left' });
      doc.text('Price Paid', priceColX, startY, {
        width: numericWidth - 8,
        align: 'right'
      });
      doc.text('Platform Fee', feeColX, startY, {
        width: numericWidth - 8,
        align: 'right'
      });
      doc.text('Net Earnings', netColX, startY, {
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
        if (currentY > doc.page.height - margin - 80) {
          doc.addPage();
          currentY = margin;

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
          doc.text('Price Paid', priceColX, currentY, {
            width: numericWidth - 8,
            align: 'right'
          });
          doc.text('Platform Fee', feeColX, currentY, {
            width: numericWidth - 8,
            align: 'right'
          });
          doc.text('Net Earnings', netColX, currentY, {
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
    console.error('Error generating admin monthly report PDF:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: error.message });
    } else {
      res.end();
    }
  }
});

// Download platform-wide monthly earnings PDF (all authors, admin access)
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
    }).populate('items.book', 'title author');

    const authorIdsSet = new Set();
    const sales = [];
    let totalGross = 0;
    let totalPlatform = 0;
    let totalAuthors = 0;

    for (const order of orders) {
      if (!order.items || order.items.length === 0) continue;

      const orderOriginalTotal = order.items.reduce((sum, item) => sum + (item.price || 0), 0);
      if (orderOriginalTotal <= 0) continue;

      for (const item of order.items) {
        if (!item.book || !item.book.author) continue;

        const authorId = item.book.author.toString();
        authorIdsSet.add(authorId);

        const share = (item.price || 0) / orderOriginalTotal;
        const pricePaid = order.totalAmount * share;
        const platformFee = pricePaid * (PLATFORM_FEE_PERCENTAGE / 100);
        const authorNet = pricePaid - platformFee;

        totalGross += pricePaid;
        totalPlatform += platformFee;
        totalAuthors += authorNet;

        sales.push({
          authorId,
          bookTitle: item.book.title,
          saleDate: order.createdAt,
          pricePaid,
          platformFee,
          authorNet
        });
      }
    }

    // Load author names
    const authorIds = Array.from(authorIdsSet);
    const authors = await User.find({ _id: { $in: authorIds } }).select('name');
    const authorMap = {};
    authors.forEach(a => {
      authorMap[a._id.toString()] = a.name;
    });

    const monthPadded = String(monthNum).padStart(2, '0');
    const fileName = `blueleafbooks-platform-earnings-${yearNum}-${monthPadded}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const margin = 40;
    const doc = new PDFDocument({ margin });
    doc.pipe(res);

    const pageWidth = doc.page.width;
    const contentWidth = pageWidth - margin * 2;

    doc
      .font('Helvetica-Bold')
      .fontSize(18)
      .text('BlueLeafBooks – Monthly Platform Earnings', margin, doc.y, { align: 'center' });

    doc
      .moveTo(margin, doc.y + 6)
      .lineTo(pageWidth - margin, doc.y + 6)
      .lineWidth(1)
      .strokeColor('#dddddd')
      .stroke();

    doc.moveDown(2);

    const periodLabel = new Date(yearNum, monthNum - 1, 1).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long'
    });

    doc
      .font('Helvetica')
      .fontSize(12)
      .fillColor('#000000')
      .text(`Period: ${periodLabel}`, { align: 'left' });

    doc.text(`Platform Fee: ${PLATFORM_FEE_PERCENTAGE.toFixed(2)}%`);
    doc.moveDown(1.5);

    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .text('Sales breakdown (all authors):');
    doc.moveDown(0.75);

    if (sales.length === 0) {
      doc.font('Helvetica').fontSize(11).text('No sales for this period.');
    } else {
      const rowHeight = 18;
      const startY = doc.y;

      // Column widths: Date, Book, Author, Price, Fee, Net
      const baseDateWidth = 90;
      const baseAuthorWidth = 110;
      const baseNumericWidth = 70;
      const usedWidth = baseDateWidth + baseAuthorWidth + baseNumericWidth * 3;
      let bookColWidth = contentWidth - usedWidth;

      let dateColWidth = baseDateWidth;
      let authorColWidth = baseAuthorWidth;
      let numericWidth = baseNumericWidth;

      if (bookColWidth < 120) {
        const deficit = 120 - bookColWidth;
        const reducePerCol = Math.min(12, Math.ceil(deficit / 5)); // date + author + 3 numeric
        dateColWidth = Math.max(70, baseDateWidth - reducePerCol);
        authorColWidth = Math.max(90, baseAuthorWidth - reducePerCol);
        numericWidth = Math.max(60, baseNumericWidth - reducePerCol);
        bookColWidth = contentWidth - (dateColWidth + authorColWidth + numericWidth * 3);
      }

      const dateColX = margin;
      const bookColX = dateColX + dateColWidth;
      const authorColX = bookColX + bookColWidth;
      const priceColX = authorColX + authorColWidth;
      const feeColX = priceColX + numericWidth;
      const netColX = feeColX + numericWidth;
      const rightEdge = margin + contentWidth;

      doc
        .save()
        .rect(margin, startY - 2, contentWidth, rowHeight)
        .fill('#f5f5f5')
        .restore();

      doc.font('Helvetica-Bold').fontSize(11);

      doc.text('Date', dateColX + 4, startY, { width: dateColWidth - 8, align: 'left' });
      doc.text('Book', bookColX + 4, startY, { width: bookColWidth - 8, align: 'left' });
      doc.text('Author', authorColX + 4, startY, { width: authorColWidth - 8, align: 'left' });
      doc.text('Price', priceColX, startY, { width: numericWidth - 8, align: 'right' });
      doc.text('Fee', feeColX, startY, { width: numericWidth - 8, align: 'right' });
      doc.text('Net', netColX, startY, { width: numericWidth - 8, align: 'right' });

      let currentY = startY + rowHeight;
      doc.moveTo(margin, currentY - 2)
        .lineTo(rightEdge, currentY - 2)
        .lineWidth(0.5)
        .strokeColor('#e0e0e0')
        .stroke();

      doc.font('Helvetica').fontSize(9);

      const addRow = (sale) => {
        if (currentY > doc.page.height - margin - 80) {
          doc.addPage();
          currentY = margin;

          doc
            .save()
            .rect(margin, currentY - 2, contentWidth, rowHeight)
            .fill('#f5f5f5')
            .restore();

          doc.font('Helvetica-Bold').fontSize(11);

          doc.text('Date', dateColX + 4, currentY, { width: dateColWidth - 8, align: 'left' });
          doc.text('Book', bookColX + 4, currentY, { width: bookColWidth - 8, align: 'left' });
          doc.text('Author', authorColX + 4, currentY, {
            width: authorColWidth - 8,
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

        const authorName = authorMap[sale.authorId] || 'Unknown';

        doc.text(dateStr, dateColX + 4, currentY, {
          width: dateColWidth - 8,
          align: 'left'
        });
        doc.text(sale.bookTitle, bookColX + 4, currentY, {
          width: bookColWidth - 8,
          align: 'left'
        });
        doc.text(authorName, authorColX + 4, currentY, {
          width: authorColWidth - 8,
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

    // Summary section
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
      .text(`Total Gross Sales: $${totalGross.toFixed(2)}`, margin, doc.y, { align: 'left' });
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .text(`Total Platform Fees: $${totalPlatform.toFixed(2)}`, margin, doc.y, { align: 'left' });
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .text(`Total Net to Authors: $${totalAuthors.toFixed(2)}`, margin, doc.y, { align: 'left' });

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
    console.error('Error generating platform monthly report PDF:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: error.message });
    } else {
      res.end();
    }
  }
});

// Get all authors
router.get('/authors', auth, authorize('admin'), async (req, res) => {
  try {
    const authors = await User.find({ role: 'author' })
      .select('name email payoutPaypalEmail isBlocked blockedReason blockedAt createdAt')
      .sort({ createdAt: -1 });
    
    res.json(authors);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});



// ===== Platform fee tracking (manual payment) =====
// Admin: list fee status per author for a given month (period=YYYY-MM). Default: previous month.
router.get('/fees', auth, authorize('admin'), async (req, res) => {
  try {
    const period = (req.query.period || '').trim() || previousMonthPeriod();
    const range = periodRange(period);
    if (!range) return res.status(400).json({ message: 'Invalid period. Use YYYY-MM.' });

    const orders = await Order.find({
      paymentStatus: 'completed',
      createdAt: { $gte: range.start, $lt: range.end }
    }).select('authorEarningsBreakdown createdAt');

    const perAuthor = new Map();

    for (const order of orders) {
      if (!Array.isArray(order.authorEarningsBreakdown)) continue;
      for (const row of order.authorEarningsBreakdown) {
        const authorId = String(row.author);
        const net = Number(row.amount || 0);
        if (!authorId || net <= 0) continue;

        const feeDue = calcFeeFromNet(net, PLATFORM_FEE_PERCENTAGE);
        const gross = net + feeDue;

        const acc = perAuthor.get(authorId) || { gross: 0, net: 0, feeDue: 0, salesCount: 0 };
        acc.gross += gross;
        acc.net += net;
        acc.feeDue += feeDue;
        acc.salesCount += 1;
        perAuthor.set(authorId, acc);
      }
    }

    const authors = await User.find({ role: 'author' })
      .select('name email isBlocked blockedReason blockedAt payoutPaypalEmail')
      .sort({ createdAt: -1 });

    const statuses = await PlatformFeeStatus.find({ period }).select('author isPaid paidAt note');
    const statusMap = new Map(statuses.map(s => [String(s.author), s]));

    const dueDate = new Date(range.year, range.month, 10); // 10th of next month (range.month is 1-12 for the period month; JS months 0-11, but here we set next month by using month index = range.month)
    // Explanation: if period is Jan (month=1), dueDate = Feb 10 because new Date(year, 1, 10) -> Feb 10.

    const result = authors.map(a => {
      const stats = perAuthor.get(String(a._id)) || { gross: 0, net: 0, feeDue: 0, salesCount: 0 };
      const st = statusMap.get(String(a._id));
      const isPaid = st ? !!st.isPaid : false;
      const paidAt = st ? st.paidAt : null;

      const now = new Date();
      const isOverdue = !isPaid && now >= dueDate;

      return {
        authorId: a._id,
        name: a.name,
        email: a.email,
        isBlocked: a.isBlocked,
        blockedReason: a.blockedReason,
        blockedAt: a.blockedAt,
        period,
        dueDate,
        grossSales: Number(stats.gross.toFixed(2)),
        authorNet: Number(stats.net.toFixed(2)),
        platformFeeDue: Number(stats.feeDue.toFixed(2)),
        salesCount: stats.salesCount,
        isPaid,
        paidAt,
        isOverdue
      };
    });

    res.json({ period, dueDate, feePercentage: PLATFORM_FEE_PERCENTAGE, rows: result });
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

    // ✅ When the fee is marked as paid, automatically unblock the author
    // (publishing restriction + hidden books are removed)
    const updatedAuthor = await User.findOneAndUpdate(
      { _id: author._id, role: 'author' },
      { isBlocked: false, blockedReason: null, blockedAt: null },
      { new: true }
    ).select('name email payoutPaypalEmail isBlocked blockedReason blockedAt createdAt');

    res.json({ success: true, status, author: updatedAuthor });
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

module.exports = router;
