// Wraps the Groq SDK to send prompts and return the model's text response.

const { buildReviewPrompt } = require("./prompts");

/**
 * Executes an async function with exponential backoff retry logic.
 */
async function withRetry(fn, retries = 3, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) {
        console.error(`[API_FAILURE] Exhausted ${retries} retries: ${error.message}`);
        throw error;
      }
      console.warn(`[API_RETRY] Attempt ${i + 1} failed, retrying in ${delayMs}ms: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }
}

/**
 * Sends a diff patch to Groq for code review and returns parsed issues.
 *
 * @param {object} groqClient - Authenticated Groq client instance
 * @param {string} filename   - Name of the file being reviewed
 * @param {string} patch      - Raw git diff patch content
 * @returns {Promise<Array<{ code: string, comment: string }>>}
 *   Array of review comments, or an empty array if no issues or on failure.
 */
async function reviewCode(groqClient, filename, patch) {
  console.log(`[reviewCode] Calling Groq LLM for file: ${filename}`);
  try {
    const response = await withRetry(() => groqClient.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 1024,
      temperature: 0.1,
      messages: [
        {
          role: "user",
          content: buildReviewPrompt(filename, patch),
        },
      ],
    }));

    const rawContent = response.choices?.[0]?.message?.content;
    if (typeof rawContent !== "string") {
      console.warn(`[INVALID_LLM_STRUCTURE] Unexpected empty or non-string response for ${filename}`);
      return [];
    }

    const cleanContent = rawContent.replace(/```json|```/g, "").trim();

    try {
      const parsed = JSON.parse(cleanContent);
      if (!Array.isArray(parsed)) {
        console.warn(`[INVALID_LLM_STRUCTURE] Response for ${filename} is not a JSON array.`);
        console.log(`[RAW_LLM_OUTPUT] ${rawContent}`);
        return [];
      }
      return parsed;
    } catch (parseErr) {
      console.error(`[LLM_PARSE_FAILED] Failed to parse Groq response JSON for ${filename}.`);
      console.log(`[RAW_LLM_OUTPUT] ${rawContent}`);
      return [];
    }
  } catch (error) {
    // API_FAILURE logged inside withRetry
    return [];
  }
}

module.exports = { reviewCode };
