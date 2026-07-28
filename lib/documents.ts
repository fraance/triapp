/**
 * Athlete context documents.
 *
 * Lets the athlete upload spreadsheets or notes (past performances, previous
 * training plans, test results) that the AI coach can read. This is the
 * "drop files so my coach has the context it needs" requirement from the PRD.
 */
import * as XLSX from "xlsx";
import { prisma } from "./prisma";

/** Keeps prompt size sane — we truncate very large files. */
const MAX_CHARS_PER_DOC = 12000;
const MAX_ROWS = 400;

export type SupportedType = "xlsx" | "csv" | "txt";

export function detectFileType(filename: string): SupportedType | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".xlsm"))
    return "xlsx";
  if (lower.endsWith(".csv") || lower.endsWith(".tsv")) return "csv";
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return "txt";
  return null;
}

/**
 * Turns an uploaded file into plain text the language model can read.
 * Spreadsheets become CSV-like text, one section per sheet.
 */
export function extractText(
  buffer: Buffer,
  fileType: SupportedType
): { text: string; rowCount: number } {
  if (fileType === "txt") {
    const text = buffer.toString("utf8");
    return { text, rowCount: text.split(/\r?\n/).length };
  }

  if (fileType === "csv") {
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const limited = lines.slice(0, MAX_ROWS);
    return { text: limited.join("\n"), rowCount: lines.length };
  }

  // Excel workbook — may contain several sheets.
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const parts: string[] = [];
  let totalRows = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    const lines = csv.split(/\r?\n/).filter((l) => l.replace(/,/g, "").trim() !== "");
    if (lines.length === 0) continue;
    totalRows += lines.length;
    parts.push(`--- Sheet: ${sheetName} ---\n${lines.slice(0, MAX_ROWS).join("\n")}`);
  }

  return { text: parts.join("\n\n"), rowCount: totalRows };
}

export function truncate(text: string, max = MAX_CHARS_PER_DOC): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated, ${text.length - max} more characters]`;
}

export async function saveDocument(
  userId: string,
  filename: string,
  fileType: SupportedType,
  content: string,
  rowCount: number
) {
  return prisma.athleteDocument.create({
    data: {
      userId,
      filename,
      fileType,
      content: truncate(content),
      rowCount,
    },
  });
}

export async function listDocuments(userId: string) {
  return prisma.athleteDocument.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      filename: true,
      fileType: true,
      rowCount: true,
      includeInAi: true,
      createdAt: true,
      content: true,
    },
  });
}

export async function deleteDocument(userId: string, documentId: string) {
  const result = await prisma.athleteDocument.deleteMany({
    where: { id: documentId, userId },
  });
  return result.count > 0;
}

export async function setDocumentIncluded(
  userId: string,
  documentId: string,
  includeInAi: boolean
) {
  const result = await prisma.athleteDocument.updateMany({
    where: { id: documentId, userId },
    data: { includeInAi },
  });
  return result.count > 0;
}

/** Builds the prompt section containing the athlete's uploaded context. */
export async function buildDocumentContext(userId: string): Promise<string> {
  const docs = await prisma.athleteDocument.findMany({
    where: { userId, includeInAi: true },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  if (docs.length === 0) return "";

  const sections = docs.map(
    (d) =>
      `--- FILE: ${d.filename} ---\n${truncate(d.content, 6000)}`
  );

  return [
    "ATHLETE-PROVIDED CONTEXT (uploaded files — past performances, previous plans, test results):",
    ...sections,
    "Use this information to understand the athlete's history, strengths, weaknesses and preferences. If it contains past race times or test results, use them to set realistic paces and zones.",
  ].join("\n\n");
}
