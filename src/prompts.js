// ARGUS TONE CONTRACT
// Write like a calm senior engineer, not an AI assistant.
// DO: name exact variables, state what breaks, give real fixes
// DON'T: "consider adding", "could potentially", compliments, generic warnings

/**
 * Constructs a prompt instructing the LLM to perform a code review on a single file's patch,
 * returning the review comments in a strict JSON array format.
 *
 * @param {string} filename - The name of the file being reviewed
 * @param {string} patch    - The raw unified diff patch string for the file
 * @returns {string} The fully constructed prompt string
 */
function buildReviewPrompt(filename, patch) {
  return `Act as a calm, precise senior engineer. Review the git diff patch for the given filename.

Identify ONLY: null dereferences, crashes, security issues, unhandled errors, data loss risks.
Skip entirely: style, naming, formatting, comments, complexity.

Return ONLY a raw JSON array, no markdown, no explanation.

Each item in the array must have exactly these fields:
{
  "code": "<exact string snippet from the diff — to anchor the comment>",
  "severity": "HIGH" or "MEDIUM" only — never LOW,
  "title": "<4 words max — name the exact problem>",
  "body": "<one sentence — must reference the actual variable or function name from the diff>",
  "impact": "<one sentence — what breaks, when, and why>",
  "fix": "<concrete code suggestion — not vague advice>"
}

Rules:
- HIGH = crash, data loss, auth bypass, injection vulnerability
- MEDIUM = likely null risk, unhandled promise, missing validation
- LOW = never return LOW — skip it entirely
- title must name the problem specifically e.g. "Null Dereference on user.name" NOT generic like "Potential Bug"
- body must name the real variable or function from the diff
- fix must be a real code-level suggestion
- If no HIGH or MEDIUM issues: return exactly []
- Raw JSON only — no \`\`\`json fences, no preamble, no explanation

File: ${filename}
Patch:
${patch}`;
}

/**
 * Constructs a prompt instructing the LLM to generate a PR summary based on the review results.
 *
 * @param {Array} reviewResults - Array of review result objects
 * @returns {string} The fully constructed prompt string
 */
function buildSummaryPrompt(reviewResults) {
  return `Analyze all issues across all files from the code review.

Return ONLY a raw JSON object, no markdown, no explanation.

The JSON object must have exactly these fields:
{
  "risk": "HIGH" or "MEDIUM" or "LOW",
  "headline": "<one sentence — what this PR does and main concern>",
  "high_count": <number>,
  "medium_count": <number>,
  "files_reviewed": <number>
}

Raw JSON only — no \`\`\`json fences, no preamble, no explanation.

Review Results:
${JSON.stringify(reviewResults, null, 2)}`;
}

module.exports = { buildReviewPrompt, buildSummaryPrompt };
