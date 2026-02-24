import SMTP2GOApiModule from 'smtp2go-nodejs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const logger = require('./logger.cjs');
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

  async generateWorkerEmailBody({ searchCriteria, latestPrices, insightsHtml }) {
    const currentDate = new Date().toLocaleDateString();
    const criteria = searchCriteria || {};
    const nights = this.getNightsFromCriteria(criteria);
    const guestSummary = this.formatGuestsFromCriteria(criteria);
    const destination = criteria.cityName || criteria.destination || 'Unknown Location';
    const currency = criteria.currency || 'EUR';

    return `
      <html>
        <body style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
          <h2 style="color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px;">
            Booking.com Price Monitor Report
          </h2>

          <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <h3 style="color: #34495e; margin-top: 0;">Search Details</h3>
            <p><strong>Date:</strong> ${currentDate}</p>
            <p><strong>Destination:</strong> ${destination}</p>
            <p><strong>Check-in:</strong> ${criteria.checkIn || 'N/A'}</p>
            <p><strong>Check-out:</strong> ${criteria.checkOut || 'N/A'}</p>
            <p><strong>Nights:</strong> ${nights || 'N/A'}</p>
            <p><strong>Guests:</strong> ${guestSummary}</p>
            <p><strong>Currency:</strong> ${currency}</p>
          </div>

          <div style="background-color: #e8f5e8; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <h3 style="color: #27ae60; margin-top: 0;">Summary</h3>
            ${this.renderPriceSummary(latestPrices, currency)}
          </div>

          <div style="background-color: #ffffff; padding: 15px; border-radius: 5px; margin: 20px 0; border: 1px solid #e2e8f0;">
            <h3 style="color: #1f2937; margin-top: 0;">Latest Hotels (${latestPrices?.length || 0})</h3>
            ${this.renderLatestHotelsTable(latestPrices, currency)}
          </div>

          <div style="background-color: #eef6ff; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <h3 style="color: #1d4ed8; margin-top: 0;">Latest Insights</h3>
            ${insightsHtml ? insightsHtml : '<p>No insights available for this run.</p>'}
          </div>

          <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #ecf0f1;">
            <p style="color: #7f8c8d; font-size: 12px;">
              This report was generated automatically by the Booking.com Price Monitor.
              <br>
              For questions or support, please check the application logs.
            </p>
          </div>
        </body>
      </html>
    `;
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
    const currentDate = new Date().toLocaleDateString();
    
    return `
      <html>
        <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px;">
            📊 Booking.com Price Monitor Report
          </h2>
          
          <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <h3 style="color: #34495e; margin-top: 0;">📅 Search Details</h3>
            <p><strong>Date:</strong> ${currentDate}</p>
            <p><strong>Destination:</strong> ${config.search.cityName || 'Unknown Location'}</p>
            <p><strong>Check-in:</strong> ${config.search.checkIn}</p>
            <p><strong>Check-out:</strong> ${config.search.checkOut}</p>
            <p><strong>Guests:</strong> ${config.search.adults} adults${config.search.children > 0 ? `, ${config.search.children} children` : ''}</p>
            <p><strong>Currency:</strong> ${config.search.currency}</p>
          </div>

          <div style="background-color: #e8f5e8; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <h3 style="color: #27ae60; margin-top: 0;">📈 Price Summary</h3>
            ${summary ? `
              <p><strong>Total Hotels Found:</strong> ${summary.totalHotels}</p>
              <p><strong>Average Price:</strong> ${summary.currency} ${summary.averagePrice.toFixed(2)}</p>
              <p><strong>Price Range:</strong> ${summary.currency} ${summary.priceRange.min.toFixed(2)} - ${summary.currency} ${summary.priceRange.max.toFixed(2)}</p>
            ` : '<p>No summary data available</p>'}
          </div>

          <div style="background-color: #eef6ff; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <h3 style="color: #1d4ed8; margin-top: 0;">🧠 Latest Insights</h3>
            ${insightsHtml ? insightsHtml : '<p>No insights available for this run.</p>'}
          </div>

          <div style="background-color: #fff3cd; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <h3 style="color: #856404; margin-top: 0;">📎 Attachment</h3>
            <p>The detailed CSV file with all hotel data is attached to this email.</p>
            <p>You can open it in Excel, Google Sheets, or any spreadsheet application for further analysis.</p>
          </div>

          <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #ecf0f1;">
            <p style="color: #7f8c8d; font-size: 12px;">
              This report was generated automatically by the Booking.com Price Monitor.
              <br>
              For questions or support, please check the application logs.
            </p>
          </div>
        </body>
      </html>
    `;
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
