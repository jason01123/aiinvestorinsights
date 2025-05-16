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
  res.sendFile(__dirname + "/views/index.html");
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
    res.send(`<pre>${output}</pre><br><a href="/">Back</a>`);
  } catch (err) {
    console.error("OpenAI error:", err);
    res.status(500).send("Error processing your request.");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
