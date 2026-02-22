require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function test() {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    const result = await model.generateContent("Say hello in one sentence.");
    console.log("SUCCESS:", result.response.text());
  } catch (err) {
    console.error("FAILED:", err);
  }
}

test();
