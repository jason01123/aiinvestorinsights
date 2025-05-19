const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const path = require('path');
const OpenAI = require('openai');
const fs = require('fs');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let SYMBOL_TO_CIK = {};
const CACHE_FILE = 'sec_tickers_cache.json';
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

async function updateTickerMapping() {
  try {
    console.log('Fetching latest SEC company tickers...');
    const response = await axios.get('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': 'aiinvestorinsights.com (your-email@example.com)' }
    });

    SYMBOL_TO_CIK = {};
    Object.values(response.data).forEach(company => {
      SYMBOL_TO_CIK[company.ticker.toUpperCase()] = company.cik_str.toString().padStart(10, '0');
    });

    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      timestamp: Date.now(),
      mapping: SYMBOL_TO_CIK
    }, null, 2));

    console.log('Updated ticker mapping from SEC');
  } catch (error) {
    console.error('Error updating ticker mapping:', error);
    throw error;
  }
}

async function loadCachedTickers() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (Date.now() - cacheData.timestamp < CACHE_DURATION) {
        SYMBOL_TO_CIK = cacheData.mapping;
        console.log('Loaded ticker mapping from cache');
        return;
      }
    }
    await updateTickerMapping();
  } catch (error) {
    console.error('Error loading cached tickers:', error);
    await updateTickerMapping();
  }
}

loadCachedTickers().catch(console.error);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// SQLite setup
const db = new sqlite3.Database('financials.db', (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to SQLite database');
    db.run(`CREATE TABLE IF NOT EXISTS financials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Fetch 10-Q + Stock Prices
app.post('/fetch', async (req, res) => {
  if (!req.body || !req.body.symbol) {
    return res.status(400).json({ error: 'Please enter a stock symbol' });
  }

  const symbol = req.body.symbol.toUpperCase();
  const cik = SYMBOL_TO_CIK[symbol];
  if (!cik) {
    return res.status(400).json({ 
      error: `"${symbol}" is not a valid stock symbol. Please check the symbol and try again. Common examples: AAPL, MSFT, GOOGL, AMZN`
    });
  }

  const headers = {
    'User-Agent': 'aiinvestorinsights.com (your-email@example.com)',
    'Accept-Encoding': 'gzip, deflate',
  };

  try {
    const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
    const response = await axios.get(url, { headers });

    const filings = response.data.filings.recent;
    const index = filings.form.findIndex(f => f === '10-Q');

    if (index === -1) {
      throw new Error('No recent 10-Q filing found.');
    }

    const accessionRaw = filings.accessionNumber[index];
    const accessionClean = accessionRaw.replace(/-/g, '');
    const primaryDoc = filings.primaryDocument[index];
    const filingDate = filings.filingDate[index];

    const filingUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${accessionClean}/${primaryDoc}`;
    console.log(`Fetching 10-Q for ${symbol}: ${filingUrl}`);

    const finalDoc = await axios.get(filingUrl, { headers });
    const filingContent = finalDoc.data;

    // Fetch stock prices using Yahoo Finance
    const priceUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5y`;
    const stockResp = await axios.get(priceUrl);
    const result = stockResp.data.chart.result[0];
    const timestamps = result.timestamp;
    const prices = result.indicators.adjclose[0].adjclose;

    const filingTimestamp = Math.floor(new Date(filingDate).getTime() / 1000);
    let filingPrice = null;
    let currentPrice = null;

    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const price = prices[i];
      if (!filingPrice && ts >= filingTimestamp) {
        filingPrice = price;
      }
      currentPrice = price;
    }

    db.run(
      'INSERT INTO financials (symbol, date, content) VALUES (?, ?, ?)',
      [symbol, new Date().toISOString(), filingContent],
      function (err) {
        if (err) {
          console.error('Error saving to database:', err);
          res.status(500).json({ error: 'Error saving financial data' });
        } else {
          console.log('Saved to database');
          res.json({
            success: true,
            message: `10-Q filing for ${symbol} downloaded and saved.`,
            url: filingUrl,
            filingDate,
            filingPrice,
            currentPrice
          });
        }
      }
    );
  } catch (error) {
    console.error('Error:', error.message || error);
    res.status(500).json({
      error: error.message || 'An error occurred while processing your request',
    });
  }
});

// Analyze financials
app.post('/analyze', async (req, res) => {
  if (!req.body || !req.body.symbol) {
    return res.status(400).json({ error: 'Stock symbol is required' });
  }

  const symbol = req.body.symbol.toUpperCase();

  db.get(
    'SELECT content FROM financials WHERE symbol = ? ORDER BY created_at DESC LIMIT 1',
    [symbol],
    async (err, row) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      if (!row) {
        return res.status(404).json({ error: 'No financial data found for this symbol' });
      }

      try {
        const $ = cheerio.load(row.content);

        let content = '';
        $('p').each((_, el) => content += $(el).text() + '\n');
        $('table').each((_, el) => content += $(el).text() + '\n');

        const input = content.slice(0, 12000); // limit to avoid token overflow

        const completion = await openai.chat.completions.create({
          model: "gpt-4-turbo-preview",
          messages: [
            {
              role: "system",
              content: "You are a financial analyst. Analyze this 10-Q or 10-K and summarize the company's financial health in one paragraph and give a buy, sell, or hold recommendation."
            },
            {
              role: "user",
              content: `Analyze the following filing for ${symbol}:\n\n${input}`
            }
          ],
          temperature: 0.7,
          max_tokens: 2000
        });

        const analysis = completion.choices[0].message.content;
        res.json({ success: true, symbol, analysis });

      } catch (openaiError) {
        console.error('OpenAI error:', openaiError.response?.data || openaiError.message || openaiError);
        res.status(500).json({
          error: 'OpenAI analysis failed',
          details: openaiError.response?.data || openaiError.message
        });
      }
    }
  );
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => {
  console.log('404 - Not found:', req.method, req.url);
  res.status(404).json({ error: 'Not found' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
