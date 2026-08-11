import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

const ROOT_SOURCE = "@root";
const PAST_EXAM_RE = /^真题\/(?:_文本\/)?(20\d{2})年.*法律硕士.*(专业基础|综合).*\.(pdf|txt)$/u;
const ANKI_EXTENSIONS = new Set([".anki2", ".apkg", ".colpkg"]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sum(items, select = (value) => value) {
  return items.reduce((total, item) => total + select(item), 0);
}

function roundPercent(numerator, denominator) {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function sourceForPath(relativePath) {
  const slash = relativePath.indexOf("/");
  return slash === -1 ? ROOT_SOURCE : relativePath.slice(0, slash);
}

function isHiddenPath(relativePath) {
  return relativePath.split("/").some((segment) => segment.startsWith("."));
}

function metadataFingerprint(files) {
  return sha256Text(
    JSON.stringify(
      files.map(({ path, bytes, mtimeUtc }) => ({ path, bytes, mtimeUtc })),
    ),
  );
}

function publicFileMetadata(file) {
  return {
    path: file.path,
    source: file.source,
    bytes: file.bytes,
    mtimeUtc: file.mtimeUtc,
    ...(file.sha256 ? { sha256: file.sha256 } : {}),
  };
}

export function normalizeArchivePath(value) {
  return String(value)
    .normalize("NFC")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\//, "")
    .replace(/\/$/, "");
}

/**
 * Convert the subset of glob syntax used by mirror-scope.json to a RegExp.
 * `*` and `?` stay inside one path segment; `**` may cross directories.
 */
export function globToRegExp(pattern, { caseSensitive = true } = {}) {
  const glob = normalizeArchivePath(pattern);
  let expression = "^";

  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];

    if (character === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
      continue;
    }

    if (character === "?") {
      expression += "[^/]";
      continue;
    }

    expression += /[\\^$+?.()|{}\[\]]/.test(character)
      ? `\\${character}`
      : character;
  }

  expression += "$";
  return new RegExp(expression, caseSensitive ? "u" : "iu");
}

export function matchesGlob(relativePath, pattern, options) {
  return globToRegExp(pattern, options).test(normalizeArchivePath(relativePath));
}

export function isExcludedArchivePath(relativePath, excludedPatterns = []) {
  return excludedPatterns.some((pattern) => matchesGlob(relativePath, pattern));
}

export function isSealedExamArchivePath(relativePath, sealedFromYear) {
  if (!Number.isInteger(sealedFromYear)) return false;
  const normalized = normalizeArchivePath(relativePath);
  if (!normalized.startsWith("真题/_文本/") || !normalized.endsWith(".txt")) {
    return false;
  }
  const yearMatch = normalized.slice("真题/_文本/".length).match(/(20\d{2})年/u);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  // 真题正文文件无法从文件名确认年份时 fail closed，避免未知净卷误入镜像。
  return year === null || year >= sealedFromYear;
}

export function isPastExamPath(relativePath) {
  return PAST_EXAM_RE.test(normalizeArchivePath(relativePath));
}

export function isAnkiPath(relativePath) {
  const normalized = normalizeArchivePath(relativePath);
  const extension = extname(normalized).toLowerCase();
  if (ANKI_EXTENSIONS.has(extension)) return true;
  return normalized.startsWith("考点库/") && /(?:^|[/_.-])anki(?:[/_.-]|$)/iu.test(normalized);
}

export function isLegalUpdatePath(relativePath) {
  return normalizeArchivePath(relativePath).startsWith("法律更新档案/");
}

export function shouldFingerprintPath(relativePath, rules) {
  const normalized = normalizeArchivePath(relativePath);
  return (
    isPastExamPath(normalized) ||
    isAnkiPath(normalized) ||
    isLegalUpdatePath(normalized) ||
    rules.some((rule) => matchesGlob(normalized, rule.pattern))
  );
}

async function hashFile(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function assertConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("mirror-scope 配置必须是 JSON 对象");
  }
  if (typeof config.root !== "string" || config.root.length === 0) {
    throw new Error("mirror-scope.root 必须是非空路径");
  }
  if (!Array.isArray(config.rules)) {
    throw new Error("mirror-scope.rules 必须是数组");
  }
  if (
    config.excludedPatterns !== undefined &&
    (!Array.isArray(config.excludedPatterns) ||
      config.excludedPatterns.some(
        (pattern) => typeof pattern !== "string" || pattern.length === 0,
      ))
  ) {
    throw new Error("mirror-scope.excludedPatterns 必须是非空字符串数组");
  }
  if (
    config.sealedExamFromYear !== undefined &&
    (!Number.isInteger(config.sealedExamFromYear) || config.sealedExamFromYear < 2000)
  ) {
    throw new Error("mirror-scope.sealedExamFromYear 必须是合理的整数年份");
  }
  config.rules.forEach((rule, index) => {
    if (!rule || typeof rule.pattern !== "string" || rule.pattern.length === 0) {
      throw new Error(`mirror-scope.rules[${index}].pattern 必须是非空字符串`);
    }
    if (typeof rule.kind !== "string" || rule.kind.length === 0) {
      throw new Error(`mirror-scope.rules[${index}].kind 必须是非空字符串`);
    }
  });
}

/**
 * Enumerate every regular file, including files inside dot-directories. Symlinks
 * are counted but deliberately not followed, preventing loops outside the root.
 */
export async function collectArchiveInventory(archiveRoot, rules = []) {
  const absoluteRoot = resolve(archiveRoot);
  const rootInfo = await stat(absoluteRoot);
  if (!rootInfo.isDirectory()) {
    throw new Error(`档案根不是目录：${absoluteRoot}`);
  }

  const files = [];
  const scan = {
    directoryCount: 0,
    hiddenDirectoryCount: 0,
    symbolicLinkCount: 0,
    otherEntryCount: 0,
  };

  async function walk(absoluteDirectory, relativeDirectory = "") {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));

    for (const entry of entries) {
      const relativePath = normalizeArchivePath(
        relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
      );
      const absolutePath = resolve(absoluteDirectory, entry.name);

      if (entry.isDirectory()) {
        scan.directoryCount += 1;
        if (entry.name.startsWith(".")) scan.hiddenDirectoryCount += 1;
        await walk(absolutePath, relativePath);
        continue;
      }

      if (entry.isSymbolicLink()) {
        scan.symbolicLinkCount += 1;
        await lstat(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        scan.otherEntryCount += 1;
        continue;
      }

      const before = await stat(absolutePath);
      const fingerprint = shouldFingerprintPath(relativePath, rules)
        ? await hashFile(absolutePath)
        : undefined;

      if (fingerprint) {
        const after = await stat(absolutePath);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          throw new Error(`扫描期间文件发生变化，请重试：${relativePath}`);
        }
      }

      files.push({
        path: relativePath,
        source: sourceForPath(relativePath),
        bytes: before.size,
        mtimeUtc: before.mtime.toISOString(),
        ...(fingerprint ? { sha256: fingerprint } : {}),
      });
    }
  }

  await walk(absoluteRoot);
  files.sort((left, right) => compareText(left.path, right.path));
  return { files, scan };
}

function normalizeFileRecords(files) {
  const seen = new Set();
  return files
    .map((file) => {
      const normalizedPath = normalizeArchivePath(file.path);
      if (!normalizedPath) throw new Error("文件清单包含空路径");
      if (seen.has(normalizedPath)) throw new Error(`文件清单包含重复路径：${normalizedPath}`);
      seen.add(normalizedPath);

      const bytes = Number(file.bytes);
      if (!Number.isFinite(bytes) || bytes < 0) {
        throw new Error(`文件字节数无效：${normalizedPath}`);
      }

      const mtimeUtc = new Date(file.mtimeUtc).toISOString();
      return {
        path: normalizedPath,
        source: sourceForPath(normalizedPath),
        bytes,
        mtimeUtc,
        ...(file.sha256 ? { sha256: file.sha256 } : {}),
      };
    })
    .sort((left, right) => compareText(left.path, right.path));
}

function buildGap({
  id,
  label,
  severity,
  files,
  scopedPaths,
  excludedPaths,
  details = {},
}) {
  const publicFiles = files.map((file) => ({
    ...publicFileMetadata(file),
    inScope: scopedPaths.has(file.path),
    excluded: excludedPaths.has(file.path),
  }));
  const scopedFileCount = publicFiles.filter((file) => file.inScope).length;
  const excludedFiles = publicFiles.filter((file) => file.excluded);
  const eligibleFiles = publicFiles.filter((file) => !file.excluded);
  const unscopedFiles = eligibleFiles.filter((file) => !file.inScope);

  let status = "covered";
  if (publicFiles.length === 0) status = "source-missing";
  else if (eligibleFiles.length === 0) status = "intentionally-excluded";
  else if (unscopedFiles.length === eligibleFiles.length) status = "uncovered";
  else if (unscopedFiles.length > 0) status = "partial";

  return {
    id,
    label,
    severity: status === "covered" ? "none" : severity,
    status,
    foundFileCount: publicFiles.length,
    foundBytes: sum(publicFiles, (file) => file.bytes),
    eligibleFileCount: eligibleFiles.length,
    excludedFileCount: excludedFiles.length,
    excludedBytes: sum(excludedFiles, (file) => file.bytes),
    scopedFileCount,
    unscopedFileCount: unscopedFiles.length,
    unscopedBytes: sum(unscopedFiles, (file) => file.bytes),
    details,
    files: publicFiles,
  };
}

function summarizePastExams(files) {
  const papers = new Map();
  const years = new Set();
  let pdfCount = 0;
  let extractedTextCount = 0;

  for (const file of files) {
    const match = PAST_EXAM_RE.exec(file.path);
    if (!match) continue;
    const [, year, paper, extension] = match;
    years.add(Number(year));
    const key = `${year}-${paper}`;
    const formats = papers.get(key) ?? new Set();
    formats.add(extension.toLowerCase());
    papers.set(key, formats);
    if (extension.toLowerCase() === "pdf") pdfCount += 1;
    if (extension.toLowerCase() === "txt") extractedTextCount += 1;
  }

  const unpairedPaperKeys = [...papers]
    .filter(([, formats]) => !formats.has("pdf") || !formats.has("txt"))
    .map(([key]) => key)
    .sort(compareText);

  return {
    pdfCount,
    extractedTextCount,
    detectedYears: [...years].sort((left, right) => left - right),
    distinctPaperCount: papers.size,
    pairedPdfAndTextCount: papers.size - unpairedPaperKeys.length,
    unpairedPaperKeys,
  };
}

/** Build a deterministic report from an already collected inventory. */
export function buildKnowledgeBaseline({
  archiveRoot,
  configPath,
  configSha256,
  config,
  files,
  scan = {},
}) {
  assertConfig(config);
  const inventory = normalizeFileRecords(files);
  const excludedPatterns = (config.excludedPatterns ?? []).map(normalizeArchivePath);
  const excludedPaths = new Set(
    inventory
      .filter(
        (file) =>
          isExcludedArchivePath(file.path, excludedPatterns) ||
          isSealedExamArchivePath(file.path, config.sealedExamFromYear),
      )
      .map((file) => file.path),
  );
  const compiledRules = config.rules.map((rule, index) => ({
    index: index + 1,
    pattern: normalizeArchivePath(rule.pattern),
    kind: rule.kind,
    matcher: globToRegExp(rule.pattern),
  }));

  const matchesByPath = new Map();
  const pathsByRule = compiledRules.map(() => []);
  for (const file of inventory) {
    if (excludedPaths.has(file.path)) continue;
    const matches = compiledRules.filter((rule) => rule.matcher.test(file.path));
    if (matches.length === 0) continue;
    matchesByPath.set(file.path, matches);
    for (const match of matches) pathsByRule[match.index - 1].push(file.path);
  }

  const scopedPaths = new Set(matchesByPath.keys());
  const scopedFiles = inventory.filter((file) => scopedPaths.has(file.path));
  const inventoryByPath = new Map(inventory.map((file) => [file.path, file]));

  const scopeRules = compiledRules.map((rule) => {
    const matchedPaths = pathsByRule[rule.index - 1].sort(compareText);
    return {
      index: rule.index,
      pattern: rule.pattern,
      kind: rule.kind,
      matchCount: matchedPaths.length,
      matchedBytes: sum(matchedPaths, (path) => inventoryByPath.get(path).bytes),
      matchedPaths,
    };
  });

  const sourceNames = [...new Set(inventory.map((file) => file.source))].sort(compareText);
  const sources = sourceNames.map((source) => {
    const sourceFiles = inventory.filter((file) => file.source === source);
    const sourceScopedFiles = sourceFiles.filter((file) => scopedPaths.has(file.path));
    const bytes = sum(sourceFiles, (file) => file.bytes);
    const scopedBytes = sum(sourceScopedFiles, (file) => file.bytes);
    return {
      source,
      fileCount: sourceFiles.length,
      bytes,
      scopedFileCount: sourceScopedFiles.length,
      scopedBytes,
      scopeFileCoveragePct: roundPercent(sourceScopedFiles.length, sourceFiles.length),
      scopeByteCoveragePct: roundPercent(scopedBytes, bytes),
      latestMtimeUtc: sourceFiles.reduce(
        (latest, file) => (file.mtimeUtc > latest ? file.mtimeUtc : latest),
        "",
      ),
      metadataSha256: metadataFingerprint(sourceFiles),
    };
  });

  const kindNames = [...new Set(compiledRules.map((rule) => rule.kind))].sort(compareText);
  const kinds = kindNames.map((kind) => {
    const kindPaths = new Set();
    for (const [path, matches] of matchesByPath) {
      if (matches.some((match) => match.kind === kind)) kindPaths.add(path);
    }
    const kindFiles = inventory.filter((file) => kindPaths.has(file.path));
    return {
      kind,
      fileCount: kindFiles.length,
      bytes: sum(kindFiles, (file) => file.bytes),
    };
  });

  const scopedManifest = scopedFiles.map((file) => {
    const matches = matchesByPath.get(file.path);
    return {
      ...publicFileMetadata(file),
      kinds: [...new Set(matches.map((match) => match.kind))].sort(compareText),
      ruleIndexes: matches.map((match) => match.index),
    };
  });

  const pastExamFiles = inventory.filter((file) => isPastExamPath(file.path));
  const ankiFiles = inventory.filter((file) => isAnkiPath(file.path));
  const legalUpdateFiles = inventory.filter((file) => isLegalUpdatePath(file.path));
  const gaps = [
    buildGap({
      id: "past-exam-originals",
      label: "真题原卷与提取文本",
      severity: "critical",
      files: pastExamFiles,
      scopedPaths,
      details: summarizePastExams(pastExamFiles),
      excludedPaths,
    }),
    buildGap({
      id: "anki",
      label: "Anki 牌组与提取数据",
      severity: "high",
      files: ankiFiles,
      scopedPaths,
      excludedPaths,
    }),
    buildGap({
      id: "legal-updates",
      label: "法律更新档案",
      severity: "high",
      files: legalUpdateFiles,
      scopedPaths,
      excludedPaths,
    }),
  ];

  const treeBytes = sum(inventory, (file) => file.bytes);
  const scopedBytes = sum(scopedFiles, (file) => file.bytes);
  const report = {
    schemaVersion: 1,
    archiveRoot: resolve(archiveRoot),
    config: {
      path: resolve(configPath),
      sha256: configSha256,
      declaredRoot: config.root,
      ruleCount: config.rules.length,
    },
    tree: {
      fileCount: inventory.length,
      bytes: treeBytes,
      sourceCount: sources.length,
      hiddenFileCount: inventory.filter((file) => isHiddenPath(file.path)).length,
      fingerprintedFileCount: inventory.filter((file) => Boolean(file.sha256)).length,
      directoryCount: scan.directoryCount ?? null,
      hiddenDirectoryCount: scan.hiddenDirectoryCount ?? null,
      symbolicLinkCount: scan.symbolicLinkCount ?? null,
      otherEntryCount: scan.otherEntryCount ?? null,
      metadataSha256: metadataFingerprint(inventory),
    },
    sources,
    scope: {
      matchedRuleCount: scopeRules.filter((rule) => rule.matchCount > 0).length,
      missingRuleCount: scopeRules.filter((rule) => rule.matchCount === 0).length,
      uniqueFileCount: scopedFiles.length,
      bytes: scopedBytes,
      archiveFileCoveragePct: roundPercent(scopedFiles.length, inventory.length),
      archiveByteCoveragePct: roundPercent(scopedBytes, treeBytes),
      contentSha256: sha256Text(
        JSON.stringify(
          scopedManifest.map(({ path, sha256, kinds }) => ({ path, sha256, kinds })),
        ),
      ),
      rules: scopeRules,
      missingPatterns: scopeRules
        .filter((rule) => rule.matchCount === 0)
        .map(({ index, pattern, kind }) => ({ index, pattern, kind })),
      kinds,
      duplicateMatches: scopedManifest
        .filter((file) => file.ruleIndexes.length > 1)
        .map(({ path, ruleIndexes }) => ({ path, ruleIndexes })),
      exclusions: {
        patterns: excludedPatterns,
        sealedExamFromYear: config.sealedExamFromYear ?? null,
        fileCount: excludedPaths.size,
        bytes: sum(
          inventory.filter((file) => excludedPaths.has(file.path)),
          (file) => file.bytes,
        ),
        files: inventory
          .filter((file) => excludedPaths.has(file.path))
          .map(publicFileMetadata),
      },
      files: scopedManifest,
    },
    gaps,
    inventory: {
      files: inventory.map(publicFileMetadata),
    },
  };

  return {
    ...report,
    reportSha256: sha256Text(JSON.stringify(report)),
  };
}

export async function auditKnowledgeBaseline({ configPath, archiveRoot } = {}) {
  if (!configPath) throw new Error("必须提供 mirror-scope 配置路径");
  const absoluteConfigPath = resolve(configPath);
  const rawConfig = await readFile(absoluteConfigPath);
  let config;
  try {
    config = JSON.parse(rawConfig.toString("utf8"));
  } catch (error) {
    throw new Error(`mirror-scope 不是合法 JSON：${error.message}`, { cause: error });
  }
  assertConfig(config);

  const absoluteArchiveRoot = resolve(archiveRoot ?? config.root);
  const { files, scan } = await collectArchiveInventory(absoluteArchiveRoot, config.rules);
  return buildKnowledgeBaseline({
    archiveRoot: absoluteArchiveRoot,
    configPath: absoluteConfigPath,
    configSha256: createHash("sha256").update(rawConfig).digest("hex"),
    config,
    files,
    scan,
  });
}

function formatInteger(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function escapeTable(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function gapStatusLabel(status) {
  return {
    covered: "已覆盖",
    partial: "部分覆盖",
    uncovered: "未覆盖",
    "source-missing": "源资料缺失",
    "intentionally-excluded": "按规则封存",
  }[status] ?? status;
}

/** Render a concise, deterministic Markdown report for people. */
export function formatKnowledgeBaselineMarkdown(report, { pathLimit = 12 } = {}) {
  const lines = [
    "# 知识基线审计",
    "",
    `- 档案根：\`${report.archiveRoot}\``,
    `- scope 配置：\`${report.config.path}\`（SHA-256 \`${report.config.sha256}\`）`,
    `- 全树：${formatInteger(report.tree.fileCount)} 个文件，${formatBytes(report.tree.bytes)}；${formatInteger(report.tree.hiddenFileCount)} 个文件位于点号路径（扫描本身不会跳过 Windows Hidden 条目）`,
    `- scope：${formatInteger(report.scope.uniqueFileCount)} 个唯一文件，${formatBytes(report.scope.bytes)}；规则 ${report.scope.matchedRuleCount}/${report.config.ruleCount} 命中`,
    `- scope 内容指纹：\`${report.scope.contentSha256}\``,
    `- 报告指纹：\`${report.reportSha256}\``,
    "",
    "## 来源覆盖",
    "",
    "| 来源 | 文件 | 字节 | scope 文件 | 文件覆盖率 | 元数据 SHA-256 |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
  ];

  for (const source of report.sources) {
    lines.push(
      `| ${escapeTable(source.source)} | ${formatInteger(source.fileCount)} | ${formatBytes(source.bytes)} | ${formatInteger(source.scopedFileCount)} | ${source.scopeFileCoveragePct.toFixed(2)}% | \`${source.metadataSha256}\` |`,
    );
  }

  lines.push(
    "",
    "## 关键缺口",
    "",
    "| 类别 | 状态 | 已发现 | scope 内 | 封存排除 | 缺口 | 缺口字节 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const gap of report.gaps) {
    lines.push(
      `| ${escapeTable(gap.label)} | ${gapStatusLabel(gap.status)} | ${gap.foundFileCount} | ${gap.scopedFileCount} | ${gap.excludedFileCount} | ${gap.unscopedFileCount} | ${formatBytes(gap.unscopedBytes)} |`,
    );
  }

  const pastExams = report.gaps.find((gap) => gap.id === "past-exam-originals");
  if (pastExams?.foundFileCount) {
    const detail = pastExams.details;
    const yearText = detail.detectedYears.length
      ? `${detail.detectedYears[0]}–${detail.detectedYears.at(-1)}`
      : "无";
    lines.push(
      "",
      `真题核对：PDF ${detail.pdfCount} 份、提取文本 ${detail.extractedTextCount} 份，年份 ${yearText}，PDF/文本成对 ${detail.pairedPdfAndTextCount}/${detail.distinctPaperCount}。`,
    );
  }

  const gapsWithPaths = report.gaps.filter((gap) => gap.unscopedFileCount > 0);
  if (gapsWithPaths.length > 0) {
    lines.push("", "### 未纳入 scope 的关键路径", "");
    for (const gap of gapsWithPaths) {
      const paths = gap.files.filter((file) => !file.inScope && !file.excluded);
      lines.push(`- ${gap.label}（${paths.length}）`);
      for (const file of paths.slice(0, pathLimit)) {
        const digest = file.sha256 ? `，SHA-256 \`${file.sha256}\`` : "";
        lines.push(`  - \`${file.path}\`（${formatBytes(file.bytes)}${digest}）`);
      }
      if (paths.length > pathLimit) {
        lines.push(`  - ……另有 ${paths.length - pathLimit} 个；用 \`--json\` 查看完整清单。`);
      }
    }
  }

  lines.push("", "## scope 规则", "");
  if (report.scope.missingPatterns.length === 0) {
    lines.push("全部配置规则均至少命中一个文件。");
  } else {
    lines.push(`有 ${report.scope.missingPatterns.length} 条规则未命中：`, "");
    for (const rule of report.scope.missingPatterns) {
      lines.push(`- #${rule.index} [${rule.kind}] \`${rule.pattern}\``);
    }
  }

  lines.push(
    "",
    "按 kind：",
    "",
    "| kind | 文件 | 字节 |",
    "| --- | ---: | ---: |",
  );
  for (const kind of report.scope.kinds) {
    lines.push(`| ${escapeTable(kind.kind)} | ${kind.fileCount} | ${formatBytes(kind.bytes)} |`);
  }

  lines.push("");
  return lines.join("\n");
}

export const KNOWLEDGE_BASELINE_ROOT_SOURCE = ROOT_SOURCE;
