import SMTP2GOApiModule from 'smtp2go-nodejs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const logger = require('./logger.cjs');
const {
  buildReportViewModel,
  buildDeterministicInsights,
  escapeHtml,
  formatUnitsSummary: formatUnitText
} = require('./report-data.cjs');
const createSMTP2GOApi = SMTP2GOApiModule?.default || SMTP2GOApiModule;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class EmailService {
  constructor() {
    this.apiKey = process.env.SMTP2GO_API_KEY;
    this.recipients = this.parseRecipients(process.env.EMAIL_RECIPIENT);
    this.smtp2go = null;
    
    if (this.apiKey) {
      this.smtp2go = createSMTP2GOApi(this.apiKey);
    }
  }

  buildAttachmentObject(attachment) {
    if (!attachment || !attachment.fileblob) {
      return null;
    }

    return {
      filename: attachment.filename,
      fileblob: attachment.fileblob,
      mimetype: attachment.mimetype,
      async readFileBlob() {
        return this;
      },
      forSend() {
        return {
          filename: this.filename,
          fileblob: this.fileblob,
          mimetype: this.mimetype
        };
      }
    };
  }

  buildMailService({ to, subject, html, text, attachments = [] }) {
    const mailService = this.smtp2go
      .mail()
      .to((to || []).map((email) => ({ email })))
      .from({ email: 'vacmon@evo.gl', name: 'Booking Price Monitor' })
      .subject(subject)
      .html(html)
      .text(text)
      .headers([{ header: 'Content-Type', value: 'application/json' }]);

    for (const attachment of attachments) {
      if (typeof attachment === 'string') {
        mailService.attach(attachment);
        continue;
      }

      if (attachment?.filepath) {
        mailService.attach(attachment.filepath);
        continue;
      }

      if (attachment?.fileblob) {
        const attachmentObject = this.buildAttachmentObject(attachment);
        if (attachmentObject) {
          mailService.attach(attachmentObject);
        }
      }
    }

    return mailService;
  }

  async sendEmailWithAttachment(csvFilePath, summary, insightsHtml) {
    if (!this.apiKey || this.recipients.length === 0) {
      logger.warn('SMTP2Go credentials not configured, skipping email');
      return false;
    }

    try {
      const fileContent = await fs.readFile(csvFilePath);
      const fileName = path.basename(csvFilePath);
      
      const attachments = [];
      if (fileContent) {
        attachments.push({
          filename: fileName,
          fileblob: fileContent.toString('base64'),
          mimetype: 'text/csv'
        });
      }

      const mailService = this.buildMailService({
        to: this.recipients,
        subject: `Booking.com Price Monitor Report - ${new Date().toLocaleDateString()}`,
        html: await this.generateEmailBody(summary, insightsHtml),
        text: 'Booking.com Price Monitor Report attached',
        attachments
      });

      const data = await this.smtp2go.client().consume(mailService);
      
      logger.info('Email API response:', data);
      logger.info(`Email sent successfully to ${this.recipients.join(', ')}`);
      return true;
    } catch (error) {
      logger.error('Failed to send email:', error);
      return false;
    }
  }

  /**
   * Send an email with HTML body and optional attachments.
   * Used by the Service Bus worker for DB-backed job results.
   * @param {Object} options - { to: string[], subject: string, html: string, attachments: Array }
   */
  async sendEmail({ to, subject, html, attachments = [] }) {
    if (!this.apiKey) {
      logger.warn('SMTP2Go API key not configured, skipping email');
      return false;
    }

    const recipients = to && to.length > 0 ? to : this.recipients;
    if (recipients.length === 0) {
      logger.warn('No email recipients configured, skipping email');
      return false;
    }

    try {
      const mailService = this.buildMailService({
        to: recipients,
        subject: subject || `Booking.com Price Monitor Report - ${new Date().toLocaleDateString()}`,
        html: html || '<p>No content available.</p>',
        text: 'Booking.com Price Monitor Report',
        attachments
      });

      await this.smtp2go.client().consume(mailService);

      logger.info('Email sent successfully', { recipients: recipients.length });
      return true;
    } catch (error) {
      logger.error('Failed to send email:', error);
      return false;
    }
  }

  parseRecipients(recipientEnv) {
    if (!recipientEnv) {
      return [];
    }

    return recipientEnv
      .split(/[;,]/)
      .map((recipient) => recipient.trim())
      .filter(Boolean);
  }

  getNightsFromCriteria(criteria) {
    const checkIn = criteria?.checkIn || '';
    const checkOut = criteria?.checkOut || '';
    if (!checkIn || !checkOut) {
      return 0;
    }

    const diff = new Date(checkOut) - new Date(checkIn);
    if (Number.isNaN(diff)) {
      return 0;
    }

    return Math.max(0, Math.round(diff / 86400000));
  }

  formatGuestsFromCriteria(criteria) {
    const adults = Number(criteria?.adults || 0);
    const children = Number(criteria?.children || 0);
    const rooms = Number(criteria?.rooms || 1);

    const parts = [`${adults} adult${adults === 1 ? '' : 's'}`];
    if (children > 0) {
      parts.push(`${children} child${children === 1 ? '' : 'ren'}`);
    }
    if (rooms > 1) {
      parts.push(`${rooms} rooms`);
    } else {
      parts.push('1 room');
    }

    return parts.join(', ');
  }

  formatPrice(value, currency) {
    if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
      return 'N/A';
    }
    const numeric = Math.round(value * 100) / 100;
    return `${currency} ${numeric.toFixed(2)}`;
  }

  formatPriceChange(value, currency) {
    if (typeof value !== 'number' || Number.isNaN(value) || value === 0) {
      return `${currency} 0.00`;
    }
    const numeric = Math.round(Math.abs(value) * 100) / 100;
    return `${value > 0 ? '+' : '-'}${currency} ${numeric.toFixed(2)}`;
  }

  renderPriceSummary(prices, defaultCurrency) {
    if (!Array.isArray(prices) || prices.length === 0) {
      return '<p>No data available.</p>';
    }

    const validPrices = prices
      .map((p) => (typeof p.numericPrice === 'number' ? p.numericPrice : Number(p.numericPrice)))
      .filter((v) => Number.isFinite(v) && v > 0);

    if (validPrices.length === 0) {
      return '<p>No valid prices found.</p>';
    }

    const currency = defaultCurrency || 'EUR';
    const min = Math.min(...validPrices);
    const max = Math.max(...validPrices);
    const avg = validPrices.reduce((s, v) => s + v, 0) / validPrices.length;

    return `
      <p><strong>Hotels found:</strong> ${prices.length}</p>
      <p><strong>Average price:</strong> ${this.formatPrice(avg, currency)}</p>
      <p><strong>Price range:</strong> ${this.formatPrice(min, currency)} &ndash; ${this.formatPrice(max, currency)}</p>
    `;
  }

  formatUnitsSummary(units) {
    if (!Array.isArray(units) || units.length === 0) {
      return '';
    }

    return units.map((unit) => {
      const parts = [];
      if (unit.name) parts.push(unit.quantity > 1 ? `${unit.quantity}x ${unit.name}` : unit.name);
      const details = [];
      if (unit.bedrooms) details.push(`${unit.bedrooms} bed`);
      if (unit.bathrooms) details.push(`${unit.bathrooms} bath`);
      if (unit.area) details.push(`${unit.area} m&sup2;`);
      if (unit.bedsCount) details.push(`${unit.bedsCount} beds`);
      if (details.length > 0) parts.push(details.join(', '));
      return parts.join(' &mdash; ');
    }).join('<br>');
  }

  formatRating(rating) {
    if (!rating) return '';
    const text = String(rating).trim();
    const match = text.match(/(\d+[.,]?\d*)/)
    if (!match) return '';
    return match[1].replace(',', '.');
  }

  getStructuredInsights(insightsResult, report) {
    if (insightsResult?.structured) {
      return insightsResult.structured;
    }
    if (insightsResult?.insights) {
      return insightsResult.insights;
    }
    if (insightsResult && typeof insightsResult === 'object' && insightsResult.headline) {
      return insightsResult;
    }
    return buildDeterministicInsights(report);
  }

  safeHotelUrl(url) {
    if (!url) return '';
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return '';
      const hostname = parsed.hostname.toLowerCase();
      if (hostname !== 'booking.com' && !hostname.endsWith('.booking.com')) return '';
      return parsed.toString();
    } catch {
      return '';
    }
  }

  renderTextList(items) {
    const values = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!values.length) {
      return '<p style="margin: 0; color: #64748b;">No significant updates.</p>';
    }

    return `
      <ul style="margin: 8px 0 0 18px; padding: 0; color: #334155; line-height: 1.45;">
        ${values.map((item) => `<li style="margin: 0 0 6px 0;">${escapeHtml(item)}</li>`).join('')}
      </ul>
    `;
  }

  renderMetric(label, value) {
    return `
      <td style="padding: 10px 12px; border: 1px solid #e2e8f0; background: #f8fafc;">
        <div style="font-size: 11px; color: #64748b; text-transform: uppercase;">${escapeHtml(label)}</div>
        <div style="font-size: 18px; font-weight: 700; color: #0f172a; margin-top: 3px;">${escapeHtml(value)}</div>
      </td>
    `;
  }

  renderMetricsTable(report) {
    const summary = report.summary || {};
    return `
      <table style="width: 100%; border-collapse: collapse; margin-top: 10px;">
        <tr>
          ${this.renderMetric('Hotels', summary.validPriceCount || summary.count || 0)}
          ${this.renderMetric('Average', this.formatPrice(summary.average || 0, summary.currency || report.searchContext.currency))}
          ${this.renderMetric('Lowest', this.formatPrice(summary.min || 0, summary.currency || report.searchContext.currency))}
          ${this.renderMetric('Runs', report.runs?.totalRuns || 0)}
        </tr>
      </table>
    `;
  }

  renderMovementTable(movements, title) {
    const rows = Array.isArray(movements) ? movements.slice(0, 8) : [];
    if (!rows.length) {
      return `<p style="margin: 8px 0 0 0; color: #64748b;">No price changes for ${escapeHtml(title.toLowerCase())}.</p>`;
    }

    return `
      <table style="width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px;">
        <thead>
          <tr style="background: #f1f5f9; color: #334155;">
            <th style="text-align: left; padding: 8px; border-bottom: 1px solid #e2e8f0;">Hotel</th>
            <th style="text-align: right; padding: 8px; border-bottom: 1px solid #e2e8f0;">Previous</th>
            <th style="text-align: right; padding: 8px; border-bottom: 1px solid #e2e8f0;">Current</th>
            <th style="text-align: right; padding: 8px; border-bottom: 1px solid #e2e8f0;">Change</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((item) => {
            const changeColor = item.change < 0 ? '#047857' : '#b45309';
            return `
              <tr>
                <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${escapeHtml(item.hotelName)}</td>
                <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; text-align: right; white-space: nowrap;">${escapeHtml(this.formatPrice(item.previousPrice, item.currency))}</td>
                <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; text-align: right; white-space: nowrap;">${escapeHtml(this.formatPrice(item.currentPrice, item.currency))}</td>
                <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; text-align: right; color: ${changeColor}; white-space: nowrap; font-weight: 700;">${escapeHtml(this.formatPriceChange(item.change, item.currency))}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  renderHotelList(hotels, emptyText) {
    const rows = Array.isArray(hotels) ? hotels.slice(0, 8) : [];
    if (!rows.length) {
      return `<p style="margin: 8px 0 0 0; color: #64748b;">${escapeHtml(emptyText)}</p>`;
    }

    return `
      <ul style="margin: 8px 0 0 18px; padding: 0; color: #334155; line-height: 1.45;">
        ${rows.map((hotel) => `<li style="margin: 0 0 6px 0;"><strong>${escapeHtml(hotel.hotelName)}</strong> - ${escapeHtml(this.formatPrice(hotel.numericPrice, hotel.currency))}${hotel.location ? `, ${escapeHtml(hotel.location)}` : ''}</li>`).join('')}
      </ul>
    `;
  }

  renderLatestHotels(report) {
    const hotels = Array.isArray(report.latestHotels) ? report.latestHotels.slice(0, 15) : [];
    if (!hotels.length) {
      return '<p style="margin: 0; color: #64748b;">No hotels available for this run.</p>';
    }

    return `
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="background: #f1f5f9; color: #334155;">
            <th style="text-align: left; padding: 8px; border-bottom: 1px solid #e2e8f0;">Hotel</th>
            <th style="text-align: center; padding: 8px; border-bottom: 1px solid #e2e8f0;">Rating</th>
            <th style="text-align: right; padding: 8px; border-bottom: 1px solid #e2e8f0;">Price</th>
          </tr>
        </thead>
        <tbody>
          ${hotels.map((hotel) => {
            const safeUrl = this.safeHotelUrl(hotel.hotelUrl);
            const name = safeUrl
              ? `<a href="${escapeHtml(safeUrl)}" style="color: #1d4ed8; text-decoration: none;">${escapeHtml(hotel.hotelName)}</a>`
              : escapeHtml(hotel.hotelName);
            const location = hotel.location ? `<div style="font-size: 12px; color: #64748b; margin-top: 2px;">${escapeHtml(hotel.location)}</div>` : '';
            const units = hotel.unitsSummary || formatUnitText(hotel.units);
            const unitDetails = units ? `<div style="font-size: 12px; color: #475569; margin-top: 3px;">${escapeHtml(units)}</div>` : '';
            const rating = hotel.ratingValue ? hotel.ratingValue.toFixed(1) : '-';
            return `
              <tr>
                <td style="padding: 9px 8px; border-bottom: 1px solid #e2e8f0; vertical-align: top; color: #0f172a;">${name}${location}${unitDetails}</td>
                <td style="padding: 9px 8px; border-bottom: 1px solid #e2e8f0; text-align: center; vertical-align: top; color: #0f172a;">${escapeHtml(rating)}</td>
                <td style="padding: 9px 8px; border-bottom: 1px solid #e2e8f0; text-align: right; vertical-align: top; white-space: nowrap; color: #0f172a; font-weight: 700;">${escapeHtml(this.formatPrice(hotel.numericPrice, hotel.currency))}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  renderSection(title, content) {
    return `
      <div style="padding: 16px 0; border-top: 1px solid #e2e8f0;">
        <h3 style="font-size: 16px; line-height: 1.3; color: #0f172a; margin: 0 0 8px 0;">${escapeHtml(title)}</h3>
        ${content}
      </div>
    `;
  }

  renderReportEmail({ report, insights, attachmentNote = '' }) {
    const search = report.searchContext || {};
    const generatedDate = new Date(report.generatedAt || Date.now()).toLocaleDateString();
    const dateRange = search.checkIn && search.checkOut ? `${search.checkIn} to ${search.checkOut}` : 'Dates not set';
    const guests = this.formatGuestsFromCriteria(search);
    const bestFit = insights.bestFitHotel
      ? `<p style="margin: 8px 0 0 0; color: #334155;"><strong>${escapeHtml(insights.bestFitHotel.name)}:</strong> ${escapeHtml(insights.bestFitHotel.reason)}</p>`
      : '';
    const attachment = attachmentNote
      ? this.renderSection('Attachment', `<p style="margin: 0; color: #334155;">${escapeHtml(attachmentNote)}</p>`)
      : '';

    return `
      <html>
        <body style="margin: 0; padding: 0; background: #f8fafc; font-family: Arial, sans-serif; color: #0f172a;">
          <div style="max-width: 760px; margin: 0 auto; padding: 24px 16px; background: #ffffff;">
            <div style="padding-bottom: 16px; border-bottom: 3px solid #1d4ed8;">
              <div style="font-size: 12px; color: #64748b; text-transform: uppercase;">Booking.com Price Monitor</div>
              <h2 style="font-size: 24px; line-height: 1.25; color: #0f172a; margin: 4px 0 6px 0;">${escapeHtml(search.destination || 'Price report')}</h2>
              <div style="font-size: 14px; color: #475569;">${escapeHtml(dateRange)} | ${escapeHtml(search.nights || 'N/A')} nights | ${escapeHtml(guests)} | ${escapeHtml(search.currency || 'EUR')}</div>
              <div style="font-size: 12px; color: #64748b; margin-top: 5px;">Generated ${escapeHtml(generatedDate)}</div>
            </div>

            ${this.renderMetricsTable(report)}

            ${this.renderSection('Decision Summary', `
              <p style="font-size: 16px; font-weight: 700; color: #0f172a; margin: 0 0 6px 0;">${escapeHtml(insights.headline || 'Report summary')}</p>
              <p style="margin: 0; color: #334155; line-height: 1.45;">${escapeHtml(insights.briefSummary || 'No insight summary available.')}</p>
            `)}

            ${this.renderSection('Latest Updates', this.renderTextList(insights.latestUpdates))}

            ${this.renderSection('Recommendations', `${this.renderTextList(insights.recommendations)}${bestFit}`)}

            ${this.renderSection('Price Movements', this.renderMovementTable(report.priceMovements?.vsPrevious || [], 'previous run'))}

            ${this.renderSection('New And Missing Hotels', `
              <div style="font-weight: 700; color: #334155;">New since previous run</div>
              ${this.renderHotelList(report.hotelPresence?.vsPrevious?.newHotels || [], 'No new hotels since the previous run.')}
              <div style="font-weight: 700; color: #334155; margin-top: 12px;">Missing since previous run</div>
              ${this.renderHotelList(report.hotelPresence?.vsPrevious?.missingHotels || [], 'No hotels disappeared since the previous run.')}
            `)}

            ${this.renderSection('Full History Highlights', this.renderTextList(insights.historyHighlights))}

            ${this.renderSection(`Latest Hotels (${report.latestHotels?.length || 0})`, this.renderLatestHotels(report))}

            ${attachment}

            ${this.renderSection('Data Notes', this.renderTextList(insights.dataNotes || report.dataNotes))}

            <div style="padding-top: 16px; border-top: 1px solid #e2e8f0; color: #64748b; font-size: 12px; text-align: center;">
              This report was generated automatically by the Booking.com Price Monitor.
            </div>
          </div>
        </body>
      </html>
    `;
  }

  renderLatestHotelsTable(prices, defaultCurrency) {
    if (!Array.isArray(prices) || prices.length === 0) {
      return '<p>No hotels available for this run.</p>';
    }

    const rows = prices
      .map((price) => ({
        name: price.hotelName || 'Unknown Hotel',
        numericPrice: typeof price.numericPrice === 'number' ? price.numericPrice : Number(price.numericPrice),
        currency: price.currency || defaultCurrency || 'EUR',
        url: price.hotelUrl || '',
        rating: price.rating || '',
        location: price.location || '',
        units: price.units || []
      }))
      .sort((a, b) => {
        const priceA = Number.isFinite(a.numericPrice) ? a.numericPrice : Number.POSITIVE_INFINITY;
        const priceB = Number.isFinite(b.numericPrice) ? b.numericPrice : Number.POSITIVE_INFINITY;
        if (priceA !== priceB) {
          return priceA - priceB;
        }
        return a.name.localeCompare(b.name);
      });

    const rowHtml = rows
      .map((row) => {
        const priceText = this.formatPrice(row.numericPrice, row.currency);
        const nameHtml = row.url
          ? `<a href="${row.url}" style="color: #1d4ed8; text-decoration: none;">${row.name}</a>`
          : row.name;
        const locationHtml = row.location
          ? `<div style="font-size: 12px; color: #6b7280; margin-top: 2px;">${row.location}</div>`
          : '';
        const unitsSummary = this.formatUnitsSummary(row.units);
        const unitsHtml = unitsSummary
          ? `<div style="font-size: 11px; color: #4b5563; margin-top: 3px;">${unitsSummary}</div>`
          : '';
        const ratingValue = this.formatRating(row.rating);
        const ratingHtml = ratingValue
          ? `<span style="background-color: #1d4ed8; color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 12px; font-weight: bold;">${ratingValue}</span>`
          : '<span style="color: #9ca3af;">-</span>';

        return `
          <tr>
            <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0;">${nameHtml}${locationHtml}${unitsHtml}</td>
            <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: center; vertical-align: top;">${ratingHtml}</td>
            <td style="padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: right; vertical-align: top; white-space: nowrap;">${priceText}</td>
          </tr>
        `;
      })
      .join('');

    return `
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <thead>
          <tr style="background-color: #f1f5f9;">
            <th style="text-align: left; padding: 8px 10px;">Hotel</th>
            <th style="text-align: center; padding: 8px 10px;">Rating</th>
            <th style="text-align: right; padding: 8px 10px;">Price</th>
          </tr>
        </thead>
        <tbody>
          ${rowHtml}
        </tbody>
      </table>
    `;
  }

  async generateWorkerEmailBody({ searchCriteria, latestPrices, insightsHtml, insights, report }) {
    const reportModel = report || insights?.report || buildReportViewModel({
      priceRecords: latestPrices || [],
      latestPrices: latestPrices || [],
      searchCriteria: searchCriteria || {}
    });
    const structuredInsights = this.getStructuredInsights(insights || insightsHtml, reportModel);

    return this.renderReportEmail({
      report: reportModel,
      insights: structuredInsights
    });
  }

  async generateEmailBody(summary, insightsHtml) {
    let config = {};
    try {
      const configPath = path.join(__dirname, '../config/search-config.json');
      const configContent = await fs.readFile(configPath, 'utf-8');
      config = JSON.parse(configContent);
    } catch (error) {
      logger.warn('Could not load search config:', error);
    }
    const reportModel = insightsHtml?.report || buildReportViewModel({ searchCriteria: config.search || {} });
    if (summary && !insightsHtml?.report) {
      reportModel.summary = {
        count: summary.totalHotels || 0,
        validPriceCount: summary.totalHotels || 0,
        average: summary.averagePrice || 0,
        min: summary.priceRange?.min || 0,
        max: summary.priceRange?.max || 0,
        currency: summary.currency || config.search?.currency || 'EUR'
      };
    }
    const structuredInsights = this.getStructuredInsights(insightsHtml, reportModel);

    return this.renderReportEmail({
      report: reportModel,
      insights: structuredInsights,
      attachmentNote: 'The detailed CSV file with hotel data is attached to this email.'
    });
  }

  async sendTestEmail() {
    try {
      const mailService = this.buildMailService({
        to: ['naprikovsky@gmail.com'],
        subject: '🧪 Booking Price Monitor - Test Email',
        html: `
          <html>
            <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #2c3e50;">✅ Test Email Successful</h2>
              <p>Your Booking.com Price Monitor email service is working correctly!</p>
              <p>You will receive price monitoring reports with CSV attachments when the scraper runs.</p>
              <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
                <h3>Next Steps:</h3>
                <ul>
                  <li>Run the price monitor: <code>npm start</code></li>
                  <li>Check your email for the report with CSV attachment</li>
                  <li>Configure search parameters in <code>config/search-config.json</code></li>
                </ul>
              </div>
              <p style="color: #7f8c8d; font-size: 12px;">
                Sent on: ${new Date().toLocaleString()}
              </p>
            </body>
          </html>
        `,
        text: 'Test'
      });

      const data = await this.smtp2go.client().consume(mailService);
      
      logger.info('Test email API response:', data);
      logger.info('Test email sent successfully');
      return true;
    } catch (error) {
      logger.error('Failed to send test email:', error);
      return false;
    }
  }
}

export default EmailService;
