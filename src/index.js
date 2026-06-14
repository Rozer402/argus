// Entry point — orchestrates diff fetching, LLM review, and PR comment posting.

const { Octokit } = require("@octokit/rest");
const Groq = require("groq-sdk").default || require("groq-sdk");
const { getPRDiff, postReviewComments } = require("./github");
const { reviewCode } = require("./groq");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Splits a large unified diff patch into chunks to avoid LLM token overflow.
 * @param {string} patch
 * @param {number} maxLines
 * @returns {string[]}
 */
function chunkPatch(patch, maxLines = 300) {
  const lines = patch.split("\n");
  const chunks = [];
  for (let i = 0; i < lines.length; i += maxLines) {
    chunks.push(lines.slice(i, i + maxLines).join("\n"));
  }
  return chunks;
}

/**
 * Maps a code snippet to its exact line number in the unified diff.
 * Returns the best match or null if not found.
 * @param {string} patch
 * @param {string} snippet
 * @returns {{ line: number, confidence: string }|null}
 */
function findLineNumber(patch, snippet) {
  if (!snippet) return null;

  const target = snippet.split("\n")[0].trim();
  if (!target) return null;

  const patchLines = patch.split("\n");
  let currentLine = null;
  const matches = [];

  for (const lineStr of patchLines) {
    const hunkMatch = lineStr.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) { currentLine = parseInt(hunkMatch[1], 10); continue; }
    if (currentLine === null || lineStr.startsWith("-")) continue;

    if (lineStr.startsWith("+")) {
      const clean = lineStr.substring(1).trim();
      if (lineStr.substring(1) === target)        matches.push({ line: currentLine, score: 3, confidence: "HIGH" });
      else if (clean === target)                  matches.push({ line: currentLine, score: 2, confidence: "MEDIUM" });
      else if (clean.includes(target) || target.includes(clean))
                                                  matches.push({ line: currentLine, score: 1, confidence: "LOW" });
      currentLine++;
    } else if (lineStr.startsWith(" ")) {
      currentLine++;
    }
  }

  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.score - a.score)[0];
}

/**
 * Classifies severity from a comment string using keyword heuristics.
 * @param {string} comment
 * @returns {"HIGH"|"MEDIUM"|"LOW"}
 */
function classifySeverity(comment) {
  const t = comment.toLowerCase();
  if (/security|injection|xss|csrf|vulnerability|leak|auth/.test(t)) return "HIGH";
  if (/null|undefined|crash|exception|unhandled|missing/.test(t))    return "MEDIUM";
  return "LOW";
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  // Load optional per-repo config from .argus/config.yml in GITHUB_WORKSPACE
  const { loadConfig } = require('./config');
  const config = loadConfig();
  console.log('Argus config:', config);

  try {
    // 1. Read and validate environment variables
    const GITHUB_TOKEN      = process.env.GITHUB_TOKEN;
    const INPUT_GROQ_API_KEY = process.env.INPUT_GROQ_API_KEY;
    const GITHUB_REPOSITORY  = process.env.GITHUB_REPOSITORY;
    const PR_NUMBER_STR      = process.env.PR_NUMBER;
    const GITHUB_SHA         = process.env.GITHUB_SHA;

    const missing = [
      !GITHUB_TOKEN       && "GITHUB_TOKEN",
      !INPUT_GROQ_API_KEY && "INPUT_GROQ_API_KEY",
      !GITHUB_REPOSITORY  && "GITHUB_REPOSITORY",
      !PR_NUMBER_STR      && "PR_NUMBER",
      !GITHUB_SHA         && "GITHUB_SHA",
    ].filter(Boolean);

    if (missing.length > 0) throw new Error(`Missing env vars: ${missing.join(", ")}`);

    const [owner, repo] = GITHUB_REPOSITORY.split("/");
    const PR_NUMBER = parseInt(PR_NUMBER_STR, 10);
    if (isNaN(PR_NUMBER)) throw new Error(`Invalid PR_NUMBER: "${PR_NUMBER_STR}"`);

    // 2. Initialize clients
    const octokit = new Octokit({ auth: GITHUB_TOKEN });
    const groq    = new Groq({ apiKey: INPUT_GROQ_API_KEY });

    // 3. Fetch PR diff
    const files = await getPRDiff(octokit, owner, repo, PR_NUMBER);
    console.log(`[FILES_COUNT] ${files.length}`);
    if (files.length === 0) { console.log("Nothing to review."); return; }

    // 4. Review each file (max 3 concurrent Groq calls)
    const CONCURRENCY = 3;
    const reviewResults = [];

    for (let i = 0; i < files.length; i += CONCURRENCY) {
      const batch = files.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(async (file) => {
        const chunks = chunkPatch(file.patch, 300);
        const allIssues = [];
        for (const chunk of chunks) {
          const issues = await reviewCode(groq, file.filename, chunk);
          if (Array.isArray(issues)) allIssues.push(...issues);
        }
        return { filename: file.filename, patch: file.patch, issues: allIssues };
      }));
      reviewResults.push(...results);
    }

    // 5. Validate, map line numbers, filter low quality
    // Severity scale for the threshold gate (matches .argus/config.yml values)
    const SEVERITY_ORDER = ['INFO', 'SUGGESTION', 'WARNING', 'CRITICAL'];
    const thresholdIdx   = SEVERITY_ORDER.indexOf(config.severity_threshold);

    const MAX_COMMENTS  = config.max_comments;
    const dedupeSet     = new Set();
    const validComments = [];

    for (const { filename, patch, issues } of reviewResults) {
      for (const issue of issues) {
        // Structural check
        if (!issue?.code?.trim() || !issue?.comment?.trim()) continue;

        // Map snippet to diff line
        const match = findLineNumber(patch, issue.code);
        if (!match || match.confidence === "LOW" || match.line <= 0) continue;

        // Internal severity (HIGH/MEDIUM/LOW) → config scale (CRITICAL/WARNING/INFO)
        const severity = classifySeverity(issue.comment);
        if (severity === "LOW") continue;

        // Map internal severity to the config's four-level scale
        const configSeverity =
          severity === "HIGH"   ? 'CRITICAL'   :
          severity === "MEDIUM" ? 'WARNING'    : 'INFO';

        // Threshold gate — skip comments below the configured level
        const commentIdx = SEVERITY_ORDER.indexOf(configSeverity);
        if (commentIdx < thresholdIdx) continue;

        // Deduplication
        const key = `${filename}:${match.line}:${issue.comment.trim()}`;
        if (dedupeSet.has(key)) continue;
        dedupeSet.add(key);

        validComments.push({
          path: filename,
          line: match.line,
          severity,
          configSeverity,
          body: `**[${severity} RISK]** ${issue.comment}`,
        });
      }
    }

    console.log(`[FINAL_COMMENT_COUNT] ${validComments.length}`);

    if (validComments.length === 0) {
      console.log("[SUMMARY_STATUS] No issues found. Skipping.");
      return;
    }

    // 6. Sort by severity, cap at config.max_comments
    validComments.sort((a) => (a.severity === "HIGH" ? -1 : 1));

    // Cap the number of comments posted — stop once the counter hits max_comments
    let commentCount = 0;
    const toPost = [];
    for (const comment of validComments) {
      if (commentCount >= MAX_COMMENTS) break;
      toPost.push(comment);
      commentCount++;
    }

    // 7. Build summary
    const highCount   = toPost.filter(c => c.severity === "HIGH").length;
    const mediumCount = toPost.filter(c => c.severity === "MEDIUM").length;
    const risk        = highCount > 0 ? "🔴 HIGH" : mediumCount > 0 ? "🟡 MEDIUM" : "🟢 LOW";
    const topIssue    = toPost[0];

    const summary = [
      `## 👁️ Argus Review`,
      ``,
      `| Severity | Count |`,
      `|---|---|`,
      `| 🚨 Critical | ${highCount} |`,
      `| ⚠️ Warning | ${mediumCount} |`,
      `| 📁 Files reviewed | ${files.length} |`,
      ``,
      `**Overall risk: ${risk}**`,
      ``,
      topIssue ? `> ${topIssue.body} — \`${topIssue.path}\`` : "",
      ``,
      `---`,
      `*[Argus](https://github.com/Rozer402/argus) · Groq Llama 3.3 70B · ${Date.now() - startTime}ms*`,
    ].join("\n");

    // 8. Post comments
    await postReviewComments(octokit, owner, repo, PR_NUMBER, toPost, GITHUB_SHA, summary);
    console.log(`Review complete. ${highCount} critical, ${mediumCount} warnings. ${Date.now() - startTime}ms.`);

  } catch (error) {
    console.error("Action failed:", error.message);
    process.exit(1);
  }
}

main();