const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const path = require('path');
const OpenAI = require('openai');
const fs = require('fs');
const cheerio = require('cheerio');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcrypt');
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

// Session and Passport middleware must come BEFORE routes
app.use(require('express-session')({
  secret: process.env.SESSION_SECRET || 'your_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));
app.use(passport.initialize());
app.use(passport.session());

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
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }
});

// Routes
// Serve landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// Serve main app
app.get('/app', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

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

    // Save to database
    db.run(
      'INSERT INTO financials (symbol, date, content) VALUES (?, ?, ?)',
      [symbol, new Date().toISOString(), filingContent],
      function (err) {
        if (err) {
          console.error('Error saving to database:', err);
          res.status(500).json({ error: 'Error saving financial data' });
        } else {
          console.log('Saved to database');
          const companyName = response.data.name;

          res.json({
            success: true,
            message: `Quarterly filing for ${companyName} (${symbol}) retrieved.`,
            company: companyName,
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
// Analyze financials
app.post('/analyze', async (req, res) => {
  if (!req.body || !req.body.symbol) {
    return res.status(400).json({ error: 'Stock symbol is required' });
  }

  const symbol = req.body.symbol.toUpperCase();

  db.get(
    'SELECT id, content FROM financials WHERE symbol = ? ORDER BY created_at DESC LIMIT 1',
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

        // Delete the entry from the database after analysis
        db.run('DELETE FROM financials WHERE id = ?', [row.id], (deleteErr) => {
          if (deleteErr) {
            console.error('Error deleting entry:', deleteErr);
          } else {
            console.log(`Deleted entry for ${symbol} with ID ${row.id}`);
          }
        });

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

passport.use(new LocalStrategy(
  function(username, password, done) {
    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
      if (err) return done(err);
      if (!user) return done(null, false, { message: 'Incorrect username.' });
      const match = await bcrypt.compare(password, user.password);
      if (!match) return done(null, false, { message: 'Incorrect password.' });
      return done(null, user);
    });
  }
));

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser((id, done) => {
  db.get('SELECT * FROM users WHERE id = ?', [id], (err, user) => {
    done(err, user);
  });
});

app.post('/signup', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword], function (err) {
      if (err) {
        console.error('Signup error:', err);
        if (err.message && err.message.includes('UNIQUE constraint failed')) {
          return res.status(400).json({ error: 'Username already taken' });
        }
        return res.status(500).json({ error: 'Database error: ' + err.message });
      }
      req.login({ id: this.lastID, username }, (err) => {
        if (err) return res.status(500).json({ error: 'Login after signup failed' });
        res.json({ success: true });
      });
    });
  } catch (err) {
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/login', passport.authenticate('local'), (req, res) => {
  res.json({ success: true });
});

app.post('/logout', (req, res) => {
  req.logout(() => {
    res.json({ success: true });
  });
});

function requireLogin(req, res, next) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'You must be logged in.' });
  }
  next();
}

app.get('/me', (req, res) => {
  if (req.isAuthenticated()) {
    res.json({ user: req.user });
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

// Serve login and signup pages
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
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
