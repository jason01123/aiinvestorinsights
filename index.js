const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
require('dotenv').config();

const app = express();

// Middleware setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Debug logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  console.log('Request body:', req.body);
  next();
});

// Initialize SQLite database
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
  console.log('Serving main page');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/fetch', async (req, res) => {
  console.log('Received POST request to /fetch');
  console.log('Request body:', req.body);

  if (!req.body || !req.body.symbol) {
    console.error('No symbol provided in request');
    return res.status(400).json({ error: 'Stock symbol is required' });
  }

  const symbol = req.body.symbol.toUpperCase();
  console.log('Processing symbol:', symbol);

  const headers = {
    'User-Agent': 'aiinvestorinsights.com (your-email@example.com)',
  };

  try {
    // Step 1: Get the 10-Q filing detail page
    console.log('Fetching company filings page...');
    const companyPage = await axios.get(`https://www.sec.gov/cgi-bin/browse-edgar`, {
      headers,
      params: {
        CIK: symbol,
        owner: 'exclude',
        action: 'getcompany',
        type: '10-Q',
        count: 1,
      },
    });

    const $ = cheerio.load(companyPage.data);
    const filingDetailUrl = $('a[href*="/Archives/edgar/data/"]').first().attr('href');

    if (!filingDetailUrl) {
      throw new Error('No 10-Q filing detail page found for this symbol');
    }

    console.log('Filing detail page:', filingDetailUrl);

    // Step 2: Fetch the filing detail page
    const detailPage = await axios.get(`https://www.sec.gov${filingDetailUrl}`, { headers });
    const $$ = cheerio.load(detailPage.data);

    // Step 3: Find the 10-Q document itself (HTML format preferred)
    const docUrl = $$('a').filter(function () {
      const link = $$(this).text().trim().toLowerCase();
      return link.includes('10-q') && ($$(this).attr('href') || '').endsWith('.htm');
    }).first().attr('href');

    if (!docUrl) {
      throw new Error('No 10-Q HTML document found on filing detail page');
    }

    const fullDocUrl = `https://www.sec.gov${docUrl}`;
    console.log('Final 10-Q document URL:', fullDocUrl);

    // Step 4: Fetch and store the actual document
    const finalDoc = await axios.get(fullDocUrl, { headers });
    const filingContent = finalDoc.data;

    // Step 5: Save to database
    console.log('Saving to database...');
    db.run(
      'INSERT INTO financials (symbol, date, content) VALUES (?, ?, ?)',
      [symbol, new Date().toISOString(), filingContent],
      function (err) {
        if (err) {
          console.error('Error saving to database:', err);
          res.status(500).json({ error: 'Error saving financial data' });
        } else {
          console.log('Successfully saved to database');
          res.json({
            success: true,
            message: `10-Q filing for ${symbol} downloaded and saved.`,
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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  console.log('404 - Not found:', req.method, req.url);
  res.status(404).json({ error: 'Not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
