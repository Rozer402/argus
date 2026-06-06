// Entry point for the GitHub Action — orchestrates fetching the diff, calling Groq, and posting the review.

const { Octokit } = require("@octokit/rest");
const Groq = require("groq-sdk").default || require("groq-sdk");
const { getPRDiff, postReviewComments } = require("./github");
const { reviewCode } = require("./groq");

/**
 * Deterministically maps a string snippet back to the actual line number
 * in the diff hunk by parsing standard unified diff line markers.
 *
 * @param {string} patch - The unified diff hunk for the file
 * @param {string} snippet - The code snippet to locate
 * @returns {{ line: number, score: number, confidence: string }|null} The match result or null if not found
 */
function findLineNumber(patch, snippet) {
  if (!snippet) return null;

  const snippetLines = snippet.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (snippetLines.length === 0) return null;
  
  const targetSnippet = snippetLines[0];
  if (snippetLines.length > 1) {
    console.log(`[MULTILINE_SNIPPET_DETECTED] Using first line for anchor: "${targetSnippet}"`);
  }

  const patchLines = patch.split("\n");
  let currentLine = null;
  const matches = [];

  for (let i = 0; i < patchLines.length; i++) {
    const lineStr = patchLines[i];

    const hunkMatch = lineStr.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (currentLine === null) continue;

    if (lineStr.startsWith("-")) {
      continue;
    }

    if (lineStr.startsWith("+")) {
      const cleanLine = lineStr.substring(1).trim();
      const targetTrimmed = targetSnippet.trim();
      
      let score = 0;
      let confidence = null;
      
      if (lineStr.substring(1) === targetSnippet) {
        score = 3;
        confidence = "HIGH";
      } else if (cleanLine === targetTrimmed) {
        score = 2;
        confidence = "MEDIUM";
      } else if (cleanLine.includes(targetTrimmed) || targetTrimmed.includes(cleanLine)) {
        score = 1;
        confidence = "LOW";
      }

      if (score > 0) {
        matches.push({ line: currentLine, score, confidence });
      }
      currentLine++;
    } else if (lineStr.startsWith(" ")) {
      currentLine++;
    } else if (lineStr === "\\ No newline at end of file") {
      continue;
    } else {
      currentLine++;
    }
  }

  if (matches.length === 0) {
     console.log(`[SNIPPET_NOT_FOUND] for snippet: "${targetSnippet}"`);
     return null;
  }

  if (matches.length > 1) {
    console.warn(`[MULTIPLE_MATCHES] found (${matches.length}) for snippet: "${targetSnippet}". Evaluating scores.`);
    matches.sort((a, b) => b.score - a.score);
  }

  return matches[0];
}

/**
 * Splits large unified diff patches into safe chunks to avoid LLM context overflow.
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
 * Computes severity deterministically based on keyword heuristics.
 */
function classifySeverity(comment) {
  const text = comment.toLowerCase();
  if (/security|injection|xss|csrf|vulnerability|leak/.test(text)) return "HIGH";
  if (/null|undefined|crash|exception|error|fail/.test(text)) return "MEDIUM";
  return "LOW";
}

async function main() {
  const startTime = Date.now();
  try {
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    const INPUT_GROQ_API_KEY = process.env.INPUT_GROQ_API_KEY;
    const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
    const PR_NUMBER_STR = process.env.PR_NUMBER;
    const GITHUB_SHA = process.env.GITHUB_SHA;

    const missingVars = [];
    if (!GITHUB_TOKEN) missingVars.push("GITHUB_TOKEN");
    if (!INPUT_GROQ_API_KEY) missingVars.push("INPUT_GROQ_API_KEY");
    if (!GITHUB_REPOSITORY) missingVars.push("GITHUB_REPOSITORY");
    if (!PR_NUMBER_STR) missingVars.push("PR_NUMBER");
    if (!GITHUB_SHA) missingVars.push("GITHUB_SHA");

    if (missingVars.length > 0) {
      throw new Error(`Missing required environment variables: ${missingVars.join(", ")}`);
    }

    const [owner, repo] = GITHUB_REPOSITORY.split("/");
    const PR_NUMBER = parseInt(PR_NUMBER_STR, 10);

    const octokitClient = new Octokit({ auth: GITHUB_TOKEN });
    
    let groqClient;
    try {
      groqClient = new Groq({ apiKey: INPUT_GROQ_API_KEY });
    } catch (err) {
      console.error("[main] Failed to initialize Groq client:", err.message);
      process.exit(1);
    }

    const filesToReview = await getPRDiff(octokitClient, owner, repo, PR_NUMBER);
    console.log(`[FILES_COUNT] ${filesToReview.length}`);
    
    if (filesToReview.length === 0) {
      console.log("Nothing to review");
      return;
    }

    const reviewResults = [];
    const MAX_CONCURRENCY = 3;
    let totalChunks = 0;
    
    // Process files with concurrency control
    for (let i = 0; i < filesToReview.length; i += MAX_CONCURRENCY) {
      const batch = filesToReview.slice(i, i + MAX_CONCURRENCY);
      const batchPromises = batch.map(async (file) => {
        const chunks = chunkPatch(file.patch, 300);
        if (chunks.length > 1) console.log(`[PATCH_CHUNKED] File ${file.filename} split into ${chunks.length} chunks`);
        totalChunks += chunks.length;

        const allIssues = [];
        for (const chunk of chunks) {
          const chunkIssues = await reviewCode(groqClient, file.filename, chunk);
          if (Array.isArray(chunkIssues)) {
            allIssues.push(...chunkIssues);
          }
        }
        return { filename: file.filename, patch: file.patch, issues: allIssues };
      });
      const batchResults = await Promise.all(batchPromises);
      reviewResults.push(...batchResults);
    }

    console.log(`[PATCH_CHUNK_COUNT] Total chunks processed: ${totalChunks}`);

    // Flatten, validate, and filter
    let rawCommentCount = 0;
    let validComments = [];
    const confidenceCounts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    const dedupeSet = new Set();

    for (const { filename, patch, issues } of reviewResults) {
      let fileValidCount = 0;
      let fileInvalidCount = 0;
      const fileComments = [];

      for (const issue of issues) {
        rawCommentCount++;
        
        if (!issue || typeof issue.code !== "string" || !issue.code.trim() || typeof issue.comment !== "string" || !issue.comment.trim()) {
          fileInvalidCount++;
          console.warn(`[INVALID_COMMENT_REMOVED] Malformed structure for ${filename}`);
          continue;
        }

        const matchResult = findLineNumber(patch, issue.code);
        if (!matchResult) {
          fileInvalidCount++;
          continue; // SNIPPET_NOT_FOUND logged internally
        }

        const { line, confidence } = matchResult;
        confidenceCounts[confidence]++;

        if (confidence === "LOW") {
          fileInvalidCount++;
          console.warn(`[LOW_CONFIDENCE_REJECTED] Rejected in ${filename}`);
          continue;
        }

        if (line <= 0) {
          fileInvalidCount++;
          console.warn(`[INVALID_COMMENT_REMOVED] Invalid line ${line} in ${filename}`);
          continue;
        }

        // INTELLIGENCE GATE: Severity
        const severity = classifySeverity(issue.comment);
        if (severity === "LOW") {
          console.warn(`[LOW_SEVERITY_DROPPED] Ignored low-value comment in ${filename}`);
          continue; // Drops from being counted as fileValidCount completely
        }

        // INTELLIGENCE GATE: Deduplication
        const dedupeKey = `${filename}:${line}:${issue.comment.trim()}`;
        if (dedupeSet.has(dedupeKey)) {
          console.warn(`[DUPLICATE_COMMENT_REMOVED] Duplicate at ${filename}:${line}`);
          continue;
        }
        dedupeSet.add(dedupeKey);

        fileValidCount++;
        fileComments.push({
          path: filename,
          line,
          body: `**[${severity} RISK]** ${issue.comment}`,
          severity
        });
      }

      // VALIDATION LAYER: Fail-fast rule > 70% invalid
      const totalFileIssues = fileValidCount + fileInvalidCount;
      if (totalFileIssues > 0 && (fileInvalidCount / totalFileIssues) > 0.7) {
        console.warn(`[FILE_SKIPPED_HIGH_INVALID_RATE] Skipping ${filename} (${fileInvalidCount}/${totalFileIssues} invalid)`);
        continue;
      }

      validComments.push(...fileComments);
    }

    console.log(`[RAW_LLM_OUTPUT] Total raw issues parsed: ${rawCommentCount}`);
    console.log(`[VALID_COMMENT_COUNT] ${validComments.length} passed structural validation`);
    console.log(`[CONFIDENCE_COUNTS] HIGH: ${confidenceCounts.HIGH}, MEDIUM: ${confidenceCounts.MEDIUM}, LOW: ${confidenceCounts.LOW}`);

    // INTELLIGENCE GATE: Max Comments Cap
    const MAX_COMMENTS = 10;
    if (validComments.length > MAX_COMMENTS) {
      console.warn(`[COMMENT_LIMIT_REACHED] Truncating ${validComments.length} down to ${MAX_COMMENTS}`);
      validComments.sort((a, b) => a.severity === "HIGH" ? -1 : 1); // prioritize HIGH
      validComments = validComments.slice(0, MAX_COMMENTS);
    }

    console.log(`[FINAL_COMMENT_COUNT] ${validComments.length}`);

    if (validComments.length > 0) {
      // SUMMARY GENERATION
      let highCount = 0;
      let mediumCount = 0;
      let mostCritical = null;

      for (const c of validComments) {
        if (c.severity === "HIGH") {
          highCount++;
          if (!mostCritical) mostCritical = c;
        } else {
          mediumCount++;
        }
      }

      let overallRisk = "LOW";
      if (highCount > 0) overallRisk = "HIGH";
      else if (mediumCount > 0) overallRisk = "MEDIUM";

      let summaryBody = `🤖 **Argus PR Review Summary**\n\n`;
      summaryBody += `- **Overall Risk:** ${overallRisk}\n`;
      summaryBody += `- **Files Reviewed:** ${filesToReview.length}\n`;
      summaryBody += `- **Issues Found:** ${highCount} HIGH, ${mediumCount} MEDIUM\n`;
      
      if (mostCritical) {
        summaryBody += `\n**Most Critical Issue:**\n> ${mostCritical.body} (in \`${mostCritical.path}\`)\n`;
      }

      console.log(`[SUMMARY_STATUS] Posting summary: ${overallRisk} Risk`);

      await postReviewComments(octokitClient, owner, repo, PR_NUMBER, validComments, GITHUB_SHA, summaryBody);
    } else {
      console.log("[SUMMARY_STATUS] No valid issues to post. Skipping.");
    }

  } catch (error) {
    console.error("Action failed with error:", error.message);
    process.exit(1);
  } finally {
    console.log(`[PIPELINE_TIME_MS] ${Date.now() - startTime}`);
  }
}

main();
// ping
