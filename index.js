const express = require("express");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

app.post("/analyze", async (req, res) => {
  const statementText = req.body.statement;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "You are a financial analyst." },
        { role: "user", content: `Analyze this financial statement for key investment insights:\n${statementText}` },
      ],
    });

    const output = response.choices[0].message.content;
    res.send(`
      <!DOCTYPE html>
      <html class="min-h-full bg-gray-100">
      <head>
        <title>Analysis Results - AI Investor Insights</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="min-h-screen p-8">
        <div class="max-w-4xl mx-auto bg-white rounded-lg shadow-lg p-8">
          <h1 class="text-3xl font-bold text-gray-800 mb-8 text-center">Analysis Results</h1>
          <div class="prose max-w-none mb-8 whitespace-pre-wrap p-6 bg-gray-50 rounded-lg">
            ${output}
          </div>
          <div class="text-center">
            <a href="/" class="inline-block bg-blue-600 text-white px-8 py-3 rounded-lg hover:bg-blue-700 transition-colors duration-200 font-semibold">
              Analyze Another Statement
            </a>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("OpenAI error:", err);
    res.status(500).send(`
      <!DOCTYPE html>
      <html class="min-h-full bg-gray-100">
      <head>
        <title>Error - AI Investor Insights</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="min-h-screen p-8">
        <div class="max-w-4xl mx-auto bg-white rounded-lg shadow-lg p-8">
          <h1 class="text-3xl font-bold text-red-600 mb-8 text-center">Error</h1>
          <p class="text-center text-gray-700 mb-8">Sorry, there was an error processing your request.</p>
          <div class="text-center">
            <a href="/" class="inline-block bg-blue-600 text-white px-8 py-3 rounded-lg hover:bg-blue-700 transition-colors duration-200 font-semibold">
              Try Again
            </a>
          </div>
        </div>
      </body>
      </html>
    `);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
