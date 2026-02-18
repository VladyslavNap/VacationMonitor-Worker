const logger = require('./logger.cjs');
const config = require('../config/search-config.json');

class PriceParser {
  constructor() {
    this.priceRegex = /[\$,\s]*([\d,]+\.?\d*)/;
    this.currencySymbols = ['$', '€', '£', '¥', '₹', 'R$', 'C$', 'A$'];
  }

  parsePrice(priceText) {
    if (!priceText) return null;

    try {
      const cleanText = priceText.replace(/[^\d.,$€£¥₹R$C$A$]/g, ' ').trim();
      const match = cleanText.match(this.priceRegex);
      
      if (match) {
        const numericPrice = parseFloat(match[1].replace(/,/g, ''));
        const currency = this.detectCurrency(priceText);
        
        return {
          originalText: priceText,
          numericPrice,
          currency,
          isValid: !isNaN(numericPrice) && numericPrice > 0
        };
      }
      
      return null;
    } catch (error) {
      logger.error(`Failed to parse price: ${priceText}`, error);
      return null;
    }
  }

  detectCurrency(text) {
    for (const symbol of this.currencySymbols) {
      if (text.includes(symbol)) {
        return this.getCurrencyCode(symbol);
      }
    }
    return config.search.currency || 'USD';
  }

  getCurrencyCode(symbol) {
    const currencyMap = {
      '$': 'USD',
      '€': 'EUR',
      '£': 'GBP',
      '¥': 'JPY',
      '₹': 'INR',
      'R$': 'BRL',
      'C$': 'CAD',
      'A$': 'AUD'
    };
    return currencyMap[symbol] || 'USD';
  }

  async enhanceWithAI(hotelData) {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;

    if (!config.ai.enabled || !endpoint || !apiKey) {
      logger.info('AI enhancement disabled or Azure OpenAI not configured, using basic parsing');
      return hotelData;
    }

    try {
      const enhanced = await Promise.all(
        hotelData.map(hotel => this.enhanceHotelWithAI(hotel))
      );
      return enhanced;
    } catch (error) {
      logger.error('AI enhancement failed, using basic parsing:', error);
      return hotelData;
    }
  }

  async enhanceHotelWithAI(hotel) {
    try {
      const prompt = `
        Analyze this hotel pricing information and extract structured data:
        
        Hotel: ${hotel.name}
        Price Text: "${hotel.price}"
        Rating: ${hotel.rating}
        Location: ${hotel.location}
        
        Return JSON with:
        - pricePerNight (number)
        - currency (string)
        - totalPrice (number if available)
        - priceType (string: "per night", "total", "unknown")
        - hasDiscount (boolean)
        - originalPrice (number if discount found)
        - confidence (number 0-1)
        
        Return JSON only. Do not include markdown or code fences.
      `;

      const response = await this.callAI(prompt);
      const aiData = this.parseJsonResponse(response);
      
      return {
        ...hotel,
        aiParsed: aiData,
        priceParsed: this.parsePrice(hotel.price)
      };
    } catch (error) {
      logger.warn(`AI enhancement failed for ${hotel.name}:`, error);
      return {
        ...hotel,
        priceParsed: this.parsePrice(hotel.price)
      };
    }
  }

  async callAI(prompt) {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        temperature: config.ai.temperature,
        max_completion_tokens: config.ai.maxTokens
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure OpenAI request failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    return data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '';
  }

  parseJsonResponse(content) {
    if (!content) {
      throw new Error('AI response was empty');
    }

    const trimmed = content.trim();
    const withoutFences = trimmed.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    return JSON.parse(withoutFences);
  }

  processHotels(hotels) {
    return hotels.map(hotel => ({
      ...hotel,
      priceParsed: this.parsePrice(hotel.price)
    })).filter(hotel => hotel.priceParsed && hotel.priceParsed.isValid);
  }
}

module.exports = PriceParser;
