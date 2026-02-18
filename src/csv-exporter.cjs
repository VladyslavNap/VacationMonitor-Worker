const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const path = require('path');
const fs = require('fs');
const logger = require('./logger.cjs');
const moment = require('moment');

class CSVExporter {
  constructor() {
    this.outputDir = path.join(__dirname, '../data');
    this.ensureOutputDir();
  }

  ensureOutputDir() {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  async exportToCSV(hotels, filename = null) {
    try {
      const timestamp = moment().format('YYYY-MM-DD_HH-mm-ss');
      const defaultFilename = `booking_prices_${timestamp}.csv`;
      const csvFilename = filename || defaultFilename;
      const csvPath = path.join(this.outputDir, csvFilename);

      const csvWriter = createCsvWriter({
        path: csvPath,
        header: [
          { id: 'name', title: 'Hotel Name' },
          { id: 'rating', title: 'Rating' },
          { id: 'location', title: 'Location' },
          { id: 'cityName', title: 'City Name' },
          { id: 'price', title: 'Original Price Text' },
          { id: 'priceParsed', title: 'Parsed Price' },
          { id: 'numericPrice', title: 'Numeric Price' },
          { id: 'currency', title: 'Currency' },
          { id: 'url', title: 'Hotel URL' },
          { id: 'extractedAt', title: 'Extracted At' },
          { id: 'searchDestination', title: 'Search Destination' },
          { id: 'searchDate', title: 'Search Date' }
        ]
      });

      const processedHotels = this.prepareDataForCSV(hotels);
      await csvWriter.writeRecords(processedHotels);

      logger.info(`Exported ${processedHotels.length} hotels to ${csvPath}`);
      return csvPath;
    } catch (error) {
      logger.error('Failed to export to CSV:', error);
      throw error;
    }
  }

  prepareDataForCSV(hotels) {
    const config = require('../config/search-config.json');
    
    return hotels.map(hotel => ({
      name: hotel.name || '',
      rating: hotel.rating || '',
      location: hotel.location || '',
      cityName: config.search.cityName || 'Unknown Location',
      price: hotel.price || '',
      priceParsed: hotel.priceParsed?.originalText || '',
      numericPrice: hotel.priceParsed?.numericPrice || '',
      currency: hotel.priceParsed?.currency || '',
      url: hotel.url || '',
      extractedAt: hotel.extractedAt || new Date().toISOString(),
      searchDestination: config.search.destination,
      searchDate: new Date().toISOString()
    }));
  }

  async appendToCSV(hotels, filename) {
    try {
      const csvPath = path.join(this.outputDir, filename);
      
      if (!fs.existsSync(csvPath)) {
        return await this.exportToCSV(hotels, filename);
      }

      const csvWriter = createCsvWriter({
        path: csvPath,
        header: [
          { id: 'name', title: 'Hotel Name' },
          { id: 'rating', title: 'Rating' },
          { id: 'location', title: 'Location' },
          { id: 'cityName', title: 'City Name' },
          { id: 'price', title: 'Original Price Text' },
          { id: 'priceParsed', title: 'Parsed Price' },
          { id: 'numericPrice', title: 'Numeric Price' },
          { id: 'currency', title: 'Currency' },
          { id: 'url', title: 'Hotel URL' },
          { id: 'extractedAt', title: 'Extracted At' },
          { id: 'searchDestination', title: 'Search Destination' },
          { id: 'searchDate', title: 'Search Date' }
        ],
        append: true
      });

      const processedHotels = this.prepareDataForCSV(hotels);
      await csvWriter.writeRecords(processedHotels);

      logger.info(`Appended ${processedHotels.length} hotels to ${csvPath}`);
      return csvPath;
    } catch (error) {
      logger.error('Failed to append to CSV:', error);
      throw error;
    }
  }

  getLatestCSV() {
    try {
      const files = fs.readdirSync(this.outputDir)
        .filter(file => file.endsWith('.csv'))
        .map(file => ({
          name: file,
          path: path.join(this.outputDir, file),
          mtime: fs.statSync(path.join(this.outputDir, file)).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime);

      return files.length > 0 ? files[0] : null;
    } catch (error) {
      logger.error('Failed to get latest CSV:', error);
      return null;
    }
  }

  parseCsvLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];

      if (char === '"') {
        const nextChar = line[i + 1];
        if (inQuotes && nextChar === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (char === ',' && !inQuotes) {
        result.push(current);
        current = '';
        continue;
      }

      current += char;
    }

    result.push(current);
    return result.map(field => field.trim());
  }

  async generateSummaryReport(csvPath) {
    try {
      const fs = require('fs').promises;
      const data = await fs.readFile(csvPath, 'utf-8');
      const lines = data.split('\n').filter(line => line.trim());
      
      if (lines.length <= 1) {
        return { totalHotels: 0, averagePrice: 0, priceRange: { min: 0, max: 0 } };
      }

      const hotels = lines.slice(1).map(line => {
        const fields = this.parseCsvLine(line);
        // CSV columns: Hotel Name(0), Rating(1), Location(2), City Name(3),
        //   Original Price Text(4), Parsed Price(5), Numeric Price(6), Currency(7)
        return {
          name: (fields[0] || '').replace(/"/g, ''),
          numericPrice: parseFloat((fields[6] || '').replace(/"/g, '')) || 0,
          currency: (fields[7] || '').replace(/"/g, '') || 'USD'
        };
      }).filter(h => h.numericPrice > 0);

      const prices = hotels.map(h => h.numericPrice);
      const summary = {
        totalHotels: hotels.length,
        averagePrice: prices.reduce((a, b) => a + b, 0) / prices.length,
        priceRange: {
          min: Math.min(...prices),
          max: Math.max(...prices)
        },
        currency: hotels[0]?.currency || 'USD'
      };

      logger.info('Summary report generated:', summary);
      return summary;
    } catch (error) {
      logger.error('Failed to generate summary report:', error);
      return null;
    }
  }
}

module.exports = CSVExporter;
