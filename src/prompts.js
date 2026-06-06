// Builds the prompt strings that are sent to the Groq LLM for PR review.

/**
 * Constructs a prompt instructing the LLM to perform a code review on a single file's patch,
 * returning the review comments in a strict JSON array format.
 *
 * @param {string} filename - The name of the file being reviewed
 * @param {string} patch    - The raw unified diff patch string for the file
 * @returns {string} The fully constructed prompt string
 */
function buildReviewPrompt(filename, patch) {
  return `You are a senior code reviewer. Your job is to review a git diff patch for a single file and identify correctness, security, or critical logical bugs.

## Rules:
1. Focus ONLY on logic errors, correctness issues, null pointer risks, security vulnerabilities, and missing error handling.
2. Ignore all style preferences, naming conventions, syntax styling, formatting, or missing comments.
3. Every comment must target a specific snippet of code in the new changes (lines starting with "+").
4. Respond ONLY with a raw JSON array. Do not include markdown code block formatting (e.g. \`\`\`json ... \`\`\`), introduction, explanation, or notes.
5. If you find no correctness or security issues in the diff, respond with exactly: []

## Response Format:
[
  {
    "code": "<exact string snippet from the diff, without the leading +>",
    "comment": "<actionable review note pointing out the bug or risk>"
  }
]

## Code to Review:
File: ${filename}
Patch:
${patch}`;
}

module.exports = { buildReviewPrompt };
